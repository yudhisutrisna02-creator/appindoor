'use strict';
const express = require('express');
const { z } = require('zod');
const { db, nextNumber } = require('../db');
const { requireAuth, butuhIzin } = require('../middleware/auth');
const { ah, parse, httpError, dateRange } = require('../utils/http');
const { r2, ACC, postJournal, deleteJournalsBySource, buildSalesJournalLines } = require('../utils/accounting');
const { daftarkanEkspor } = require('../utils/ekspor');
const { todayLocal } = require('../utils/time');
const STATUS = require('../utils/status-pesanan');
const BATCH = require('../utils/batch');

const router = express.Router();
router.use(requireAuth);

const { CHANNELS, CHANNEL_LABEL } = require('../utils/kanal');

/** Ringkas akibat tiap kondisi — dipakai pesan setelah simpan dan setelah ubah. */
const KABAR_KONDISI = {
  BAGUS: 'barang kembali ke stok jual',
  PERBAIKI: 'barang masuk daftar perlu perbaikan',
  RUSAK: 'barang dicatat sebagai kerugian',
};

/** Kondisi barang retur — dipakai layar dan berkas unduhan. */
const LABEL_KONDISI = {
  BAGUS: 'Bagus, kembali ke stok',
  PERBAIKI: 'Perlu dikemas ulang',
  RUSAK: 'Rusak, jadi kerugian',
};
const { ubahSchema, buatPengubah } = require('./sales-ubah');

const orderSchema = z.object({
  order_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).default(() => todayLocal()),
  channel: z.enum(CHANNELS),
  customer: z.string().max(120).optional().nullable(),
  partner_id: z.number().int().positive().optional().nullable(),
  due_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().nullable(),
  marketplace_ref: z.string().max(80).optional().nullable(),
  items: z
    .array(
      z.object({
        product_id: z.number().int().positive(),
        qty: z.number().positive(),
        price: z.number().nonnegative(),
        // Label varian untuk produk yang dijual tanpa label.
        variants: z
          .array(z.object({
            // Varian dipilih dari katalog produk induknya; labelnya boleh
            // dikosongkan bila pembeli tidak minta label sendiri.
            variant_id: z.number().int().positive().optional().nullable(),
            label: z.string().trim().max(120).optional().nullable(),
            qty: z.number().positive(),
          }))
          .optional(),
      })
    )
    .min(1, 'minimal satu item produk'),

  discount: z.number().nonnegative().default(0),
  admin_fee_pct: z.number().min(0).max(100).default(0),
  admin_fee: z.number().nonnegative().optional(),
  handling_fee: z.number().nonnegative().default(0),
  shipping_extra: z.number().nonnegative().default(0),
  voucher_platform: z.number().nonnegative().default(0),
  tax_pct: z.number().min(0).max(100).default(0),
  tax_amount: z.number().nonnegative().optional(),
  packing_cost: z.number().nonnegative().default(0),
  other_cost: z.number().nonnegative().default(0),

  // --- Kolom pendukung marketplace ---
  shop_id: z.number().int().positive().optional().nullable(),
  order_ref: z.string().trim().max(80).optional().nullable(),
  courier: z.string().trim().max(50).optional().nullable(),
  tracking_no: z.string().trim().max(80).optional().nullable(),
  fulfillment_status: z.enum(STATUS.SEMUA).default('DIPROSES'),
  payout_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().nullable(),
  shipping_charged: z.number().nonnegative().default(0),
  // Ongkir yang ditagih ke pembeli di luar marketplace. Ikut ditransfer ke
  // rekening bersama nilai ordernya, jadi ia menambah penerimaan.
  shipping_non_mp: z.number().nonnegative().default(0),
  buyer_name: z.string().trim().max(120).optional().nullable(),
  buyer_account: z.string().trim().max(120).optional().nullable(),
  buyer_phone: z.string().trim().max(30).optional().nullable(),
  buyer_address: z.string().trim().max(300).optional().nullable(),
  buyer_city: z.string().trim().max(80).optional().nullable(),
  lead_source: z.string().trim().max(50).optional().nullable(),
  // Rekening penerima uangnya. Kosong berarti ikut rekening bawaan tokonya.
  cash_code: z.string().trim().optional().nullable(),

  payment_status: z.enum(['PAID', 'UNPAID']).default('PAID'),
  note: z.string().max(300).optional().nullable(),
});

/**
 * Rekening penerima uang sebuah order.
 *
 * Uang order hampir tidak pernah masuk ke kas tunai: pembeli mentransfer, dan
 * marketplace mencairkan ke rekening tertentu milik toko itu. Karena itu
 * rekeningnya diambil menurut urutan berikut:
 *
 *   1. yang dipilih pada ordernya — orang yang mengetik selalu menang;
 *   2. rekening bawaan tokonya — supaya tidak perlu dipilih ulang tiap order;
 *   3. dikosongkan — jurnalnya lalu memakai perkiraan lama, sehingga order
 *      yang dicatat sebelum ada kolom ini tidak berubah artinya.
 */
function rekeningOrder(body) {
  if (body.cash_code) {
    const akun = db.prepare('SELECT * FROM accounts WHERE code = ?').get(body.cash_code);
    if (!akun) throw httpError(404, `Rekening ${body.cash_code} tidak ditemukan`);
    if (!akun.is_cash) throw httpError(422, `${akun.code} · ${akun.name} bukan rekening kas/bank`);
    return akun.code;
  }
  if (body.shop_id) {
    const toko = db.prepare('SELECT cash_code FROM shops WHERE id = ?').get(body.shop_id);
    if (toko && toko.cash_code) return toko.cash_code;
  }
  return null;
}

/**
 * Menghitung seluruh struktur biaya & margin satu order.
 * Dipakai baik saat menyimpan maupun saat pratinjau di frontend.
 */
function computeOrder(input, items) {
  const gross_sales = r2(items.reduce((s, i) => s + i.subtotal, 0));
  const cogs = r2(items.reduce((s, i) => s + i.subcost, 0));
  const discount = r2(input.discount);
  const net_revenue = r2(gross_sales - discount);

  // Persentase dihitung dari pendapatan bersih; nilai eksplisit menang bila dikirim.
  const admin_fee = input.admin_fee != null
    ? r2(input.admin_fee)
    : r2((net_revenue * input.admin_fee_pct) / 100);
  const tax_amount = input.tax_amount != null
    ? r2(input.tax_amount)
    : r2((net_revenue * input.tax_pct) / 100);

  const total_fees = r2(
    admin_fee +
      r2(input.handling_fee) +
      r2(input.shipping_extra) +
      r2(input.voucher_platform) +
      tax_amount +
      r2(input.packing_cost) +
      r2(input.other_cost)
  );

  const gross_profit = r2(net_revenue - cogs);
  const net_profit = r2(gross_profit - total_fees);
  const margin_pct = net_revenue ? r2((net_profit / net_revenue) * 100) : 0;

  // Ongkir non-marketplace sengaja TIDAK masuk omzet maupun laba.
  //
  // Uangnya memang ikut ditransfer ke rekening, jadi ia menambah penerimaan.
  // Tetapi ia diteruskan ke ekspedisi, bukan hasil menjual barang: memasukkannya
  // ke omzet membuat penjualan tampak lebih besar daripada barang yang benar-
  // benar keluar, dan memasukkannya ke laba membuat untung tampak lebih besar
  // daripada yang benar-benar tinggal. Ongkirnya berdiri sendiri supaya ketiga
  // angka itu bisa dibaca terpisah.
  const shipping_non_mp = r2(input.shipping_non_mp);

  // Uang yang benar-benar diterima setelah seluruh potongan marketplace.
  // Tidak disimpan sebagai kolom karena selalu bisa diturunkan dari kolom yang
  // sudah ada — menyimpannya hanya menciptakan angka kedua yang bisa berbeda
  // bila salah satunya diperbarui sendirian.
  const net_received = r2(net_revenue - total_fees + shipping_non_mp);

  return {
    gross_sales, cogs, discount, net_revenue, admin_fee, tax_amount, total_fees,
    shipping_non_mp, net_received, gross_profit, net_profit, margin_pct,
  };
}

/**
 * Menyiapkan baris item dengan snapshot HPP saat transaksi.
 *
 * Kecukupan stok diperiksa terhadap TOTAL permintaan per produk, bukan per
 * baris. Satu order boleh memuat produk yang sama lebih dari sekali — misalnya
 * dua harga berbeda dalam satu pesanan — dan memeriksa tiap baris sendiri-
 * sendiri akan meloloskan pesanan yang jumlah keseluruhannya melebihi stok.
 */
function resolveItems(rawItems, { checkStock = true } = {}) {
  const totalPerProduk = new Map();
  for (const it of rawItems) {
    totalPerProduk.set(it.product_id, (totalPerProduk.get(it.product_id) || 0) + it.qty);
  }

  return rawItems.map((it) => {
    const product = db.prepare('SELECT * FROM products WHERE id = ?').get(it.product_id);
    if (!product) throw httpError(404, `Produk id ${it.product_id} tidak ditemukan`);
    const diminta = totalPerProduk.get(it.product_id);
    if (checkStock && diminta > product.stock) {
      throw httpError(422, `Stok ${product.name} tidak cukup (tersedia ${product.stock} ${product.unit}, diminta ${diminta})`);
    }
    const qty = r2(it.qty);
    const price = r2(it.price);
    return {
      product,
      product_id: product.id,
      qty,
      price,
      cost: product.cost,
      subtotal: r2(qty * price),
      subcost: r2(qty * product.cost),
      varian: periksaVarian(product, qty, it.variants),
    };
  });
}

/**
 * Label varian pada satu baris pesanan.
 *
 * Hanya berlaku untuk produk yang ditandai butuh label — produk yang dijual
 * tanpa label dan baru diberi label pesanan pembeli. Labelnya tidak menjadi
 * produk tersendiri: stok tetap berkurang dari produk induknya.
 *
 * Jumlah tiap label wajib dijumlahkan sama dengan jumlah barisnya. Kalau tidak
 * diperiksa, label yang tertinggal atau tertulis dua kali akan lolos diam-diam,
 * dan lembar pengiriman menyebut jumlah yang berbeda dari yang dipotong dari
 * stok — persis jenis selisih yang baru ketahuan setelah barangnya dikirim.
 */
function periksaVarian(product, qty, variants) {
  if (!product.needs_variant) {
    // Keterangan varian yang terkirim untuk produk biasa diabaikan, bukan
    // ditolak: yang salah cuma kelebihan keterangan, dan menggagalkan seluruh
    // pesanan karenanya lebih merugikan daripada membuangnya.
    return [];
  }

  const daftar = (Array.isArray(variants) ? variants : []).filter(
    (v) => v.variant_id || String(v.label || '').trim()
  );

  if (daftar.length === 0) {
    throw httpError(
      422,
      `${product.name} dijual tanpa label — pilih dulu varian produknya beserta jumlahnya`
    );
  }

  const total = r2(daftar.reduce((s, v) => s + (Number(v.qty) || 0), 0));
  if (Math.abs(total - qty) > 0.004) {
    throw httpError(
      422,
      `Jumlah varian ${product.name} (${total}) tidak sama dengan jumlah pesanannya (${qty})`
    );
  }

  return daftar.map((v) => {
    let variantId = null;
    let variantNama = null;

    if (v.variant_id) {
      const katalog = db
        .prepare('SELECT * FROM product_variants WHERE id = ?')
        .get(Number(v.variant_id));
      if (!katalog) throw httpError(404, `Varian id ${v.variant_id} tidak ditemukan`);
      // Varian milik produk lain tidak boleh menempel di sini; kalau lolos,
      // pesanan akan menyebut varian yang tidak ada hubungannya dengan
      // barang yang benar-benar dikirim.
      if (katalog.product_id !== product.id) {
        throw httpError(422, `Varian ${katalog.nama} bukan varian dari ${product.name}`);
      }
      variantId = katalog.id;
      // Namanya ikut disalin. Katalog boleh diperbaiki atau dinonaktifkan
      // kemudian, dan pesanan lama harus tetap menyebut varian yang memang
      // dikirim saat itu.
      variantNama = katalog.nama;
    }

    return {
      variant_id: variantId,
      variant_nama: variantNama,
      label: String(v.label || '').trim().slice(0, 120),
      qty: r2(v.qty),
    };
  });
}

/** POST /api/sales/preview — hitung margin tanpa menyimpan. */
router.post('/preview', ah((req, res) => {
  const body = parse(orderSchema, req.body);
  const items = resolveItems(body.items, { checkStock: false });
  res.json({
    ...computeOrder(body, items),
    items: items.map((i) => ({
      product_id: i.product_id, name: i.product.name, sku: i.product.sku,
      qty: i.qty, price: i.price, cost: i.cost, subtotal: i.subtotal, subcost: i.subcost,
      margin: r2(i.subtotal - i.subcost),
    })),
  });
}));

/**
 * Menyimpan order: header + item + mutasi stok keluar + jurnal otomatis,
 * seluruhnya dalam satu transaksi database.
 */
const createOrder = db.transaction((body, userId) => {
  const items = resolveItems(body.items);
  const calc = computeOrder(body, items);
  const orderNo = nextNumber('SO', body.order_date.slice(0, 7));

  // Dihitung SEKALI lalu dipakai dua tempat: baris ordernya dan jurnalnya.
  // Menghitungnya dua kali membuka peluang keduanya berbeda — dan jurnal yang
  // menunjuk rekening berbeda dari yang tertulis di ordernya adalah selisih
  // yang tidak akan pernah bisa dijelaskan.
  const kodeRekening = rekeningOrder(body);

  const info = db
    .prepare(
      `INSERT INTO sales_orders (
         order_no, order_date, channel, customer, marketplace_ref,
         gross_sales, discount, cogs,
         admin_fee_pct, admin_fee, handling_fee, shipping_extra, voucher_platform,
         tax_pct, tax_amount, packing_cost, other_cost,
         net_revenue, total_fees, gross_profit, net_profit, margin_pct,
         payment_status, status, note, user_id, partner_id, due_date,
         shop_id, order_ref, courier, tracking_no, fulfillment_status, payout_date,
         shipping_charged, buyer_name, buyer_account, buyer_phone, buyer_address,
         buyer_city, lead_source, shipping_non_mp, cash_code
       ) VALUES (?,?,?,?,?, ?,?,?, ?,?,?,?,?, ?,?,?,?, ?,?,?,?,?, ?, 'POSTED', ?, ?, ?, ?,
                 ?,?,?,?,?,?, ?,?,?,?,?, ?,?, ?, ?)`
    )
    .run(
      orderNo, body.order_date, body.channel, body.customer || null, body.marketplace_ref || null,
      calc.gross_sales, calc.discount, calc.cogs,
      body.admin_fee_pct, calc.admin_fee, r2(body.handling_fee), r2(body.shipping_extra), r2(body.voucher_platform),
      body.tax_pct, calc.tax_amount, r2(body.packing_cost), r2(body.other_cost),
      calc.net_revenue, calc.total_fees, calc.gross_profit, calc.net_profit, calc.margin_pct,
      body.payment_status, body.note || null, userId,
      body.partner_id || null, body.due_date || null,
      body.shop_id || null, body.order_ref || null, body.courier || null,
      body.tracking_no || null, body.fulfillment_status, body.payout_date || null,
      r2(body.shipping_charged), body.buyer_name || null, body.buyer_account || null,
      body.buyer_phone || null, body.buyer_address || null,
      body.buyer_city || null, body.lead_source || null, calc.shipping_non_mp,
      kodeRekening
    );

  const orderId = info.lastInsertRowid;

  const insertItem = db.prepare(
    `INSERT INTO sales_items (order_id, product_id, qty, price, cost, subtotal, subcost)
     VALUES (?,?,?,?,?,?,?)`
  );
  const insertMove = db.prepare(
    `INSERT INTO stock_moves
       (product_id, move_date, move_type, qty, unit_cost, balance_after, ref, source, source_id, note, user_id)
     VALUES (?,?,'OUT',?,?,?,?, 'SALES', ?, ?, ?)`
  );

  /** Sisa stok berjalan selama satu order diproses, per produk. */
  const sisaStok = new Map();

  const insertVarian = db.prepare(
    'INSERT INTO sales_item_variants (item_id, variant_id, variant_nama, label, qty) VALUES (?,?,?,?,?)'
  );

  for (const it of items) {
    const hasilItem = insertItem.run(orderId, it.product_id, it.qty, it.price, it.cost, it.subtotal, it.subcost);
    for (const v of it.varian || []) insertVarian.run(hasilItem.lastInsertRowid, v.variant_id, v.variant_nama, v.label, v.qty);

    // Saldo dihitung dari sisa berjalan, bukan dari snapshot produk. Bila satu
    // order memuat produk yang sama dua kali, snapshot membuat pengurangan
    // kedua menimpa yang pertama — stok tampak masih utuh padahal barangnya
    // sudah keluar dua kali, dan buku besar ikut salah karenanya.
    const sebelum = sisaStok.has(it.product_id) ? sisaStok.get(it.product_id) : it.product.stock;
    const newStock = r2(sebelum - it.qty);
    sisaStok.set(it.product_id, newStock);
    db.prepare('UPDATE products SET stock = ? WHERE id = ?').run(newStock, it.product_id);

    // Batch dipotong FEFO — yang lebih dulu kedaluwarsa keluar lebih dulu.
    BATCH.keluar({
      product_id: it.product_id, qty: it.qty, tanggal: body.order_date,
      source: 'SALES', sourceId: orderId, note: `Order ${orderNo}`, userId,
    });
    insertMove.run(
      it.product_id, body.order_date, it.qty, it.cost, newStock, orderNo, orderId,
      `Penjualan ${CHANNEL_LABEL[body.channel]}`, userId
    );
  }

  const journal = postJournal({
    date: body.order_date,
    description: `Penjualan ${orderNo} — ${CHANNEL_LABEL[body.channel]}`,
    lines: buildSalesJournalLines({ ...body, ...calc, cash_code: kodeRekening }),
    source: 'SALES',
    sourceId: orderId,
    userId,
  });

  return { orderId, orderNo, calc, journal };
});

router.post('/', butuhIzin('penjualan.buat'), ah((req, res) => {
  const body = parse(orderSchema, req.body);
  const result = createOrder(body, req.user.id);
  res.status(201).json({
    ok: true,
    message: `Order ${result.orderNo} tersimpan — laba bersih Rp ${result.calc.net_profit.toLocaleString('id-ID')} (${result.calc.margin_pct}%)`,
    order: db.prepare('SELECT * FROM sales_orders WHERE id = ?').get(result.orderId),
    journal: result.journal,
  });
}));

/** Filter bersama untuk daftar & analisis. */
/**
 * Pencarian bebas pada daftar order.
 *
 * Dikerjakan di basis data, bukan di layar. Menyaring di layar berarti hanya
 * baris yang sudah terlanjur terkirim yang bisa ditemukan — dan karena daftarnya
 * dibatasi, order yang dicari justru sering berada di luar batas itu. Yang paling
 * membingungkan: hasilnya kosong padahal ordernya ada.
 *
 * Kolom yang dicari adalah yang benar-benar dipakai orang saat mencari satu
 * pesanan: nomor order kita, nomor pesanan marketplace, nomor resi, nama
 * pembeli, dan nama toko.
 */
function cariOrder(q) {
  const kata = String(q || '').trim();
  if (kata.length < 2) return null;

  // LIKE dengan awalan % memang tidak memakai indeks, tetapi jumlah ordernya
  // masih ribuan — bukan jutaan — dan pencarian yang hanya cocok di awal kata
  // akan gagal menemukan resi yang diketik separuh, yaitu cara orang mencari.
  const pola = `%${kata.replace(/[%_]/g, (c) => `\\${c}`)}%`;
  const kolom = ['o.order_no', 'o.order_ref', 'o.tracking_no', 'o.buyer_name', 'sh.name'];

  return {
    kata,
    where: `(${kolom.map((k) => `${k} LIKE ? ESCAPE '\\'`).join(' OR ')})`,
    params: kolom.map(() => pola),
  };
}

/**
 * Belanja iklan pada periode yang sama dengan daftar order.
 *
 * Penyaring toko dan channel ikut diterapkan karena ad_spends memang punya
 * kedua kolom itu. Pencarian bebas TIDAK bisa: kata kunci seperti nomor resi
 * tidak punya padanan apa pun pada catatan iklan.
 *
 * Yang terjadi kalau itu diabaikan: mencari satu pesanan akan menyisakan satu
 * order senilai seratus ribu, sementara kartu Biaya Iklan tetap menampilkan
 * belanja sebulan penuh — dan "laba setelah iklan" berubah menjadi angka minus
 * raksasa yang sepenuhnya karangan. Karena itu saat pencarian aktif, angkanya
 * dinyatakan tidak berlaku, bukan ditampilkan apa adanya.
 */
function belanjaIklan(query, from, to) {
  const kata = String(query.q || '').trim();
  if (kata.length >= 2) {
    return { nilai: 0, berlaku: false, alasan: 'pencarian aktif' };
  }

  const params = [from, to];
  let where = 'WHERE spend_date BETWEEN ? AND ?';
  if (query.channel && CHANNELS.includes(query.channel)) {
    where += ' AND channel = ?';
    params.push(query.channel);
  }
  if (query.shop_id) {
    where += ' AND shop_id = ?';
    params.push(Number(query.shop_id));
  }
  if (query.fulfillment_status) {
    // Status pesanan tidak punya padanan pada belanja iklan.
    return { nilai: 0, berlaku: false, alasan: 'disaring status pesanan' };
  }

  const row = db
    .prepare(`SELECT COALESCE(SUM(amount), 0) AS total, COUNT(*) AS n FROM ad_spends ${where}`)
    .get(...params);

  return { nilai: r2(row.total), catatan: row.n, berlaku: true };
}

function orderFilter(query) {
  const { from, to } = dateRange(query);
  const params = [from, to];
  let where = "WHERE o.order_date BETWEEN ? AND ? AND o.status = 'POSTED'";
  if (query.channel && CHANNELS.includes(query.channel)) {
    where += ' AND o.channel = ?';
    params.push(query.channel);
  }
  if (query.shop_id) {
    where += ' AND o.shop_id = ?';
    params.push(Number(query.shop_id));
  }
  if (query.fulfillment_status) {
    where += ' AND o.fulfillment_status = ?';
    params.push(query.fulfillment_status);
  }

  const cari = cariOrder(query.q);
  if (cari) {
    where += ` AND ${cari.where}`;
    params.push(...cari.params);
  }

  return { from, to, where, params, q: cari ? cari.kata : '' };
}

/** GET /api/sales — daftar order + ringkasan. */
/**
 * Batas jumlah baris yang dikembalikan.
 *
 * Sebelumnya angkanya dipatok 500 di dalam kueri, sehingga satu bulan dengan
 * lebih dari 500 order diam-diam terpotong — daftar tampak lengkap padahal
 * tidak. Sekarang batasnya bisa diminta pemanggil, tetap dengan atap agar satu
 * permintaan tidak menarik seluruh riwayat sekaligus.
 */
function batas(nilai, bawaan = 500, atap = 5000) {
  const n = Number(nilai);
  if (!Number.isFinite(n) || n <= 0) return bawaan;
  return Math.min(Math.floor(n), atap);
}

router.get('/', ah((req, res) => {
  const { from, to, where, params } = orderFilter(req.query);
  const rows = db
    .prepare(
      `SELECT o.*, u.name AS user_name, sh.name AS shop_name,
              (SELECT COUNT(*) FROM sales_items i WHERE i.order_id = o.id) AS item_count
         FROM sales_orders o
         LEFT JOIN users u  ON u.id = o.user_id
         LEFT JOIN shops sh ON sh.id = o.shop_id
         ${where}
        ORDER BY o.order_date DESC, o.id DESC LIMIT ?`
    )
    .all(...params, batas(req.query.limit));

  // Ringkasan dihitung langsung di basis data atas SELURUH baris yang cocok,
  // bukan atas baris yang kebetulan muat di halaman. Menghitungnya dari daftar
  // yang terpotong membuat total di layar lebih kecil dari kenyataan tanpa ada
  // tanda apa pun — persis jenis angka salah yang paling sulit disadari.
  const total = db
    .prepare(
      `SELECT COUNT(*) AS orders,
              COALESCE(SUM(o.gross_sales), 0)  AS gross_sales,
              COALESCE(SUM(o.net_revenue), 0)  AS net_revenue,
              COALESCE(SUM(o.cogs), 0)         AS cogs,
              COALESCE(SUM(o.total_fees), 0)   AS total_fees,
              COALESCE(SUM(o.gross_profit), 0) AS gross_profit,
              COALESCE(SUM(o.net_profit), 0)   AS net_profit,
              COALESCE(SUM(o.shipping_non_mp), 0) AS shipping_non_mp
         FROM sales_orders o
         LEFT JOIN shops sh ON sh.id = o.shop_id
         ${where}`
    )
    .get(...params);

  const iklan = belanjaIklan(req.query, from, to);

  const diminta = batas(req.query.limit);
  res.json({
    from, to, rows,
    iklan,
    // Daftar boleh terpotong; ringkasannya tidak. Keduanya dibedakan supaya
    // layar bisa mengatakan "menampilkan 500 dari 1.043" dengan jujur.
    terpotong: total.orders > rows.length,
    limit: diminta,
    totalRows: total.orders,
    summary: {
      orders: total.orders,
      grossSales: r2(total.gross_sales),
      // netRevenue = penjualan dikurangi diskon, sebelum potongan marketplace.
      // Di layar disebut Pendapatan Kotor: uang sebesar itu tidak pernah
      // benar-benar masuk rekening, karena marketplace memotong lebih dulu.
      netRevenue: r2(total.net_revenue),
      // Ongkir non-marketplace: uang masuk yang bukan hasil menjual barang.
      // Berdiri sendiri supaya omzet, ongkir, dan potongan bisa dibaca terpisah.
      ongkirNonMp: r2(total.shipping_non_mp),
      // Yang benar-benar masuk rekening: omzet dikurangi potongan, ditambah
      // ongkir yang ikut ditransfer pembeli.
      netReceived: r2(total.net_revenue - total.total_fees + total.shipping_non_mp),
      cogs: r2(total.cogs),
      totalFees: r2(total.total_fees),
      grossProfit: r2(total.gross_profit),
      netProfit: r2(total.net_profit),
      marginPct: total.net_revenue ? r2((total.net_profit / total.net_revenue) * 100) : 0,
      avgOrderValue: total.orders ? r2(total.net_revenue / total.orders) : 0,
      // Iklan tidak dibebankan ke pesanan — satu kampanye menarik banyak order
      // dan sebagian tidak menghasilkan apa pun. Karena itu ia berdiri sebagai
      // angka periode, lalu dipotongkan dari laba di tingkat ringkasan.
      iklan: iklan.nilai,
      labaSetelahIklan: iklan.berlaku ? r2(total.net_profit - iklan.nilai) : null,
      roas: iklan.berlaku && iklan.nilai > 0 ? r2(total.net_revenue / iklan.nilai) : null,
    },
  });
}));

/** GET /api/sales/:id — detail order beserta item. */
router.get('/:id(\\d+)', ah((req, res) => {
  const order = db.prepare('SELECT * FROM sales_orders WHERE id = ?').get(req.params.id);
  if (!order) throw httpError(404, 'Order tidak ditemukan');

  const items = db
    .prepare(
      `SELECT i.*, p.sku, p.name AS product_name, p.unit
         FROM sales_items i JOIN products p ON p.id = i.product_id
        WHERE i.order_id = ?`
    )
    .all(order.id);

  // Label varian dilampirkan ke barisnya masing-masing supaya layar tidak perlu
  // menggabungkannya sendiri dan salah memasangkan.
  const varian = db
    .prepare(
      `SELECT v.* FROM sales_item_variants v
         JOIN sales_items i ON i.id = v.item_id
        WHERE i.order_id = ? ORDER BY v.id`
    )
    .all(order.id);
  for (const it of items) it.variants = varian.filter((v) => v.item_id === it.id);

  // Katalog varian tiap produk ikut dikirim supaya formulir ubah bisa langsung
  // menampilkan pilihannya tanpa memanggil sekali lagi per produk.
  const katalog = {};
  for (const it of items) {
    if (katalog[it.product_id]) continue;
    katalog[it.product_id] = db
      .prepare("SELECT id, nama, active FROM product_variants WHERE product_id = ? ORDER BY nama")
      .all(it.product_id);
  }

  const journal = db
    .prepare("SELECT * FROM journals WHERE source = 'SALES' AND source_id = ?")
    .get(order.id);

  // Berapa yang sudah pernah diretur dari order ini, per produk. Dikirim
  // bersama detailnya supaya formulir retur bisa menawarkan sisa yang benar
  // tanpa menghitung sendiri dari daftar yang mungkin terpotong rentang tanggal.
  const retur = {};
  for (const row of db
    .prepare(
      `SELECT product_id, COALESCE(SUM(qty), 0) AS qty
         FROM sales_returns WHERE order_id = ? GROUP BY product_id`
    )
    .all(order.id)) {
    retur[row.product_id] = r2(row.qty);
  }

  res.json({ order, items, journal, katalogVarian: katalog, retur });
}));

/**
 * DELETE /api/sales/:id — membatalkan order:
 * stok dikembalikan, mutasi & jurnal terkait dihapus, status jadi CANCELLED.
 */
const cancelOrder = db.transaction((orderId) => {
  const order = db.prepare('SELECT * FROM sales_orders WHERE id = ?').get(orderId);
  if (!order) throw httpError(404, 'Order tidak ditemukan');
  if (order.status === 'CANCELLED') throw httpError(409, 'Order sudah dibatalkan');

  const items = db.prepare('SELECT * FROM sales_items WHERE order_id = ?').all(orderId);

  for (const it of items) {
    const product = db.prepare('SELECT * FROM products WHERE id = ?').get(it.product_id);
    db.prepare('UPDATE products SET stock = ? WHERE id = ?').run(r2(product.stock + it.qty), it.product_id);
  }

  // Retur dari order ini ikut dibatalkan.
  //
  // Order yang dibatalkan berarti penjualannya tidak pernah terjadi, jadi
  // returnya pun tidak. Membiarkannya berakibat dua kesalahan sekaligus: barang
  // yang sudah kembali lewat retur ikut dikembalikan lagi oleh pembatalan —
  // stoknya terhitung dua kali — dan jurnal returnya tetap mengurangi
  // pendapatan dari penjualan yang sudah tidak ada.
  //
  // Dikerjakan SETELAH stok ordernya dikembalikan: pembalikan retur memeriksa
  // bahwa barang yang dulu kembali masih ada di gudang, dan jumlah yang diretur
  // tidak pernah melebihi yang terjual — jadi pada titik ini pemeriksaan itu
  // tidak mungkin menolak tanpa alasan.
  const returTerkait = db.prepare('SELECT * FROM sales_returns WHERE order_id = ?').all(orderId);
  for (const r of returTerkait) {
    batalkanEfekRetur(r);
    db.prepare('DELETE FROM sales_returns WHERE id = ?').run(r.id);
  }

  // Dikembalikan ke batch asalnya lewat catatan batch_moves, bukan ke batch
  // yang kebetulan paling dekat kedaluwarsanya — menebak akan membuat barang
  // "pindah" batch hanya karena ordernya dibatalkan.
  BATCH.kembalikan({ source: 'SALES', sourceId: orderId, tanggal: order.order_date });

  db.prepare("DELETE FROM stock_moves WHERE source = 'SALES' AND source_id = ?").run(orderId);
  deleteJournalsBySource('SALES', orderId);
  db.prepare("UPDATE sales_orders SET status = 'CANCELLED' WHERE id = ?").run(orderId);

  return order.order_no;
});

/**
 * PUT /api/sales/:id — ubah order yang sudah tersimpan.
 *
 * Semua kolom boleh diubah dan semuanya bersifat pilihan, jadi mengubah status
 * pengiriman cukup mengirim satu kolom saja. Setiap perubahan yang menyentuh
 * uang menulis ulang jurnalnya di transaksi yang sama.
 */
const ubahOrder = buatPengubah({ resolveItems, computeOrder, cancelOrder });

/**
 * Ubah status banyak order sekaligus.
 *
 * Papan pengiriman menggerakkan puluhan pesanan setiap hari; membuka satu per
 * satu untuk mengubah satu kolom bukan pekerjaan yang masuk akal.
 *
 * Perubahannya tetap melewati jalur pengubahan satu order, bukan UPDATE massal
 * langsung ke tabel — supaya aturan jurnal, piutang, dan pembatalan tidak punya
 * dua versi yang bisa berbeda.
 */
const statusMassalSchema = z.object({
  ids: z.array(z.number().int().positive()).min(1, 'pilih minimal satu order').max(500),
  // BATAL sengaja tidak diterima di sini. Membatalkan mengembalikan stok dan
  // menghapus jurnal — terlalu berat untuk dijalankan lewat centang massal yang
  // mudah tersenggol.
  fulfillment_status: z.enum(STATUS.TAHAP_PAPAN),
  payment_status: z.enum(['PAID', 'UNPAID']).optional(),
  payout_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().nullable(),
});

const ubahStatusMassal = db.transaction((badan, userId) => {
  const hasil = { berhasil: 0, gagal: [] };

  for (const id of badan.ids) {
    try {
      ubahOrder(id, {
        fulfillment_status: badan.fulfillment_status,
        ...(badan.payment_status ? { payment_status: badan.payment_status } : {}),
        ...(badan.payout_date !== undefined ? { payout_date: badan.payout_date } : {}),
      }, userId);
      hasil.berhasil += 1;
    } catch (e) {
      const o = db.prepare('SELECT order_no FROM sales_orders WHERE id = ?').get(id);
      hasil.gagal.push({ id, order_no: o ? o.order_no : String(id), pesan: e.message });
    }
  }

  return hasil;
});

/**
 * GET /api/sales/papan — order dikelompokkan per tahap pengiriman.
 *
 * Yang dibutuhkan di layar ini bukan seluruh kolom keuangan, melainkan apa yang
 * perlu dikerjakan hari ini: nomor pesanan, toko, pembeli, ekspedisi, resi, dan
 * sudah berapa lama tertahan di tahap itu.
 */
router.get('/papan', ah((req, res) => {
  const { from, to } = dateRange(req.query);
  const params = [from, to];
  let where = "WHERE o.status = 'POSTED' AND o.order_date BETWEEN ? AND ?";
  if (req.query.shop_id) {
    where += ' AND o.shop_id = ?';
    params.push(Number(req.query.shop_id));
  }

  const cari = cariOrder(req.query.q);
  if (cari) {
    where += ` AND ${cari.where}`;
    params.push(...cari.params);
  }

  const rows = db
    .prepare(
      `SELECT o.id, o.order_no, o.order_date, o.channel, o.fulfillment_status, o.payment_status,
              o.customer, o.buyer_city, o.courier, o.tracking_no, o.order_ref, o.payout_date,
              o.net_revenue, o.total_fees, o.net_profit,
              sh.name AS shop_name,
              CAST(julianday('now') - julianday(o.order_date) AS INTEGER) AS umur_hari
         FROM sales_orders o
         LEFT JOIN shops sh ON sh.id = o.shop_id
         ${where}
        ORDER BY o.order_date ASC, o.id ASC`
    )
    .all(...params);

  const kolom = STATUS.TAHAP_PAPAN.map((tahap) => {
    const isi = rows.filter((r) => r.fulfillment_status === tahap);
    return {
      status: tahap,
      orders: isi.length,
      nilai: r2(isi.reduce((s, r) => s + r.net_revenue - r.total_fees, 0)),
      // Pesanan tertua di tahap ini — yang paling perlu ditengok lebih dulu.
      tertua: isi.length ? Math.max(...isi.map((r) => r.umur_hari)) : 0,
      rows: isi,
    };
  });

  res.json({
    from, to, kolom,
    ringkas: {
      total: rows.length,
      belumSelesai: rows.filter((r) => !STATUS.SELESAI_URUSAN.includes(r.fulfillment_status)).length,
      nilaiBelumCair: r2(
        rows
          .filter((r) => !STATUS.SELESAI_URUSAN.includes(r.fulfillment_status))
          .reduce((s, r) => s + r.net_revenue - r.total_fees, 0)
      ),
    },
  });
}));

router.patch('/status-massal', butuhIzin('penjualan.ubah'), ah((req, res) => {
  const badan = parse(statusMassalSchema, req.body);
  const hasil = ubahStatusMassal(badan, req.user.id);

  res.json({
    ok: true,
    message: hasil.gagal.length
      ? `${hasil.berhasil} order diperbarui, ${hasil.gagal.length} gagal`
      : `${hasil.berhasil} order diperbarui`,
    ...hasil,
  });
}));

router.put('/:id(\\d+)', butuhIzin('penjualan.ubah'), ah((req, res) => {
  const badan = parse(ubahSchema, req.body);
  const hasil = ubahOrder(Number(req.params.id), badan, req.user.id);

  res.json({
    ok: true,
    message: hasil.dibatalkan
      ? `Order ${hasil.orderNo} dibatalkan — stok dikembalikan dan jurnalnya dihapus`
      : `Order ${hasil.orderNo} diperbarui`,
    order: db.prepare('SELECT * FROM sales_orders WHERE id = ?').get(hasil.orderId),
  });
}));

router.delete('/:id', butuhIzin('penjualan.batal'), ah((req, res) => {
  const orderNo = cancelOrder(Number(req.params.id));
  res.json({ ok: true, message: `Order ${orderNo} dibatalkan, stok dikembalikan` });
}));

// ==================================================================
// ALAT PEMBERSIHAN: kaitkan rekening order lama & hapus order satu periode
// ==================================================================
const TGL = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

/** Bulan-bulan yang sudah ditutup — perubahan di dalamnya selalu ditolak. */
function bulanTerkunci() {
  return new Set(db.prepare('SELECT period FROM period_locks').all().map((r) => r.period));
}

/**
 * Order lama yang belum punya rekening penerima.
 *
 * Order yang dicatat sebelum ada kolom rekening jurnalnya jatuh ke akun bawaan
 * lama — Bank Operasional untuk marketplace, Kas Tunai untuk luring. Kalau
 * tokonya sekarang sudah punya rekening, order itu bisa ikut dikaitkan.
 * Yang tidak bisa dikaitkan dilaporkan beserta alasannya, bukan dilewati diam-
 * diam: justru daftar itulah yang perlu dibetulkan satu per satu.
 */
function calonKaitkan(from, to) {
  const kunci = bulanTerkunci();
  const rows = db
    .prepare(
      `SELECT o.id, o.order_no, o.order_ref, o.order_date, o.channel, o.payment_status,
              o.net_revenue, o.total_fees, o.shipping_non_mp, o.shop_id,
              s.name AS shop_name, s.cash_code AS toko_cash_code, a.name AS rekening_nama
         FROM sales_orders o
         LEFT JOIN shops s    ON s.id = o.shop_id
         LEFT JOIN accounts a ON a.code = s.cash_code AND a.is_cash = 1
        WHERE o.status = 'POSTED'
          AND o.order_date BETWEEN ? AND ?
          AND (o.cash_code IS NULL OR o.cash_code = '')
        ORDER BY o.order_date, o.id`
    )
    .all(from, to)
    .map((o) => ({
      ...o,
      channel_label: CHANNEL_LABEL[o.channel] || o.channel,
      nilai: r2(o.net_revenue - o.total_fees + (o.shipping_non_mp || 0)),
    }));

  const bisa = [];
  const tanpaToko = [];
  const tokoTanpaRekening = [];
  const terkunci = [];
  for (const o of rows) {
    if (kunci.has(o.order_date.slice(0, 7))) terkunci.push(o);
    else if (!o.shop_id) tanpaToko.push(o);
    else if (!o.toko_cash_code || !o.rekening_nama) tokoTanpaRekening.push(o);
    else bisa.push(o);
  }
  return { bisa, tanpaToko, tokoTanpaRekening, terkunci };
}

const kaitkanSchema = z.object({
  from: TGL,
  to: TGL,
  terapkan: z.boolean().default(false),
});

const terapkanKaitan = db.transaction((daftar, userId) => {
  let diubah = 0;
  const dilewati = [];
  for (const calon of daftar) {
    const o = db.prepare('SELECT * FROM sales_orders WHERE id = ?').get(calon.id);
    const baru = { ...o, cash_code: calon.toko_cash_code };

    // Yang boleh berubah HANYA akun penerimanya. Jumlah jurnalnya dibandingkan
    // sebelum dan sesudah; kalau berbeda, berarti ada yang lain ikut bergeser,
    // dan order itu dilewati tanpa disentuh — dilaporkan, bukan dipaksakan.
    const lama = db
      .prepare(
        `SELECT COALESCE(SUM(l.debit), 0) AS d FROM journal_lines l
           JOIN journals j ON j.id = l.journal_id
          WHERE j.source = 'SALES' AND j.source_id = ?`
      )
      .get(o.id).d;
    const lines = buildSalesJournalLines(baru);
    const totalBaru = r2(lines.reduce((s, l) => s + (l.debit || 0), 0));
    if (Math.abs(r2(lama) - totalBaru) > 0.01) {
      dilewati.push({
        order_no: o.order_no,
        alasan: `jurnal tersimpan ${r2(lama)} tidak sama dengan hitungan ulangnya ${totalBaru} — periksa lewat Ubah Pesanan`,
      });
      continue;
    }

    db.prepare('UPDATE sales_orders SET cash_code = ? WHERE id = ?').run(calon.toko_cash_code, o.id);
    deleteJournalsBySource('SALES', o.id);
    postJournal({
      date: o.order_date,
      description: `Penjualan ${o.order_no} — ${CHANNEL_LABEL[o.channel] || o.channel}`,
      lines,
      source: 'SALES',
      sourceId: o.id,
      userId,
    });
    diubah += 1;
  }
  return { diubah, dilewati };
});

/**
 * POST /api/sales/kaitkan-rekening
 *
 * Tanpa `terapkan`, hanya memeriksa: berapa order bisa dikaitkan, ke rekening
 * mana, dan mana yang tidak bisa beserta sebabnya. Dengan `terapkan`, rekening
 * tokonya dipasang ke ordernya dan jurnalnya ditulis ulang — uangnya pindah
 * dari akun bawaan lama ke rekening yang sebenarnya.
 */
router.post('/kaitkan-rekening', butuhIzin('penjualan.ubah'), ah((req, res) => {
  const body = parse(kaitkanSchema, req.body);
  const c = calonKaitkan(body.from, body.to);

  const perRekening = {};
  for (const o of c.bisa) {
    const k = `${o.toko_cash_code} · ${o.rekening_nama}`;
    perRekening[k] = perRekening[k] || { rekening: k, orders: 0, nilaiLunas: 0 };
    perRekening[k].orders += 1;
    if (o.payment_status === 'PAID') perRekening[k].nilaiLunas = r2(perRekening[k].nilaiLunas + o.nilai);
  }

  const ringkas = {
    bisa: c.bisa.length,
    tanpaToko: c.tanpaToko.length,
    tokoTanpaRekening: c.tokoTanpaRekening.length,
    terkunci: c.terkunci.length,
    perRekening: Object.values(perRekening).sort((a, b) => b.orders - a.orders),
    tokoBelumBerekening: [...new Set(c.tokoTanpaRekening.map((o) => o.shop_name))],
  };

  if (!body.terapkan) {
    return res.json({
      ok: true, dicoba: true, ringkas,
      contoh: {
        tanpaToko: c.tanpaToko.slice(0, 50),
        tokoTanpaRekening: c.tokoTanpaRekening.slice(0, 50),
      },
    });
  }

  const { diubah, dilewati } = terapkanKaitan(c.bisa, req.user.id);
  res.json({
    ok: true, diubah, dilewati, ringkas,
    message: `${diubah} order dikaitkan ke rekening tokonya` +
      (dilewati.length ? `, ${dilewati.length} dilewati karena jurnalnya perlu diperiksa` : ''),
  });
}));

/**
 * Order satu periode yang akan dibersihkan, beserta seluruh akibatnya.
 *
 * "Menghapus" order di sini berarti MEMBATALKANNYA lewat jalur pembatalan yang
 * sama dengan tombol batal: stok dikembalikan, returnya ikut dibalik, jurnalnya
 * dihapus, dan order hilang dari seluruh daftar dan laporan. Barisnya sendiri
 * tidak dibuang, sehingga jejaknya tetap bisa ditelusuri di Riwayat — tidak ada
 * yang lenyap tanpa bekas.
 *
 * Akibatnya ditunjukkan SEBELUM dikerjakan, karena tiga di antaranya mudah
 * terlewat: stok bertambah kembali, saldo rekening turun sebesar uang order
 * yang dulu masuk, dan laba rugi bulan itu kehilangan pendapatannya.
 */
function calonBersihkan(from, to) {
  const kunci = bulanTerkunci();
  const orders = db
    .prepare(
      `SELECT o.id, o.order_no, o.order_ref, o.order_date, o.channel, o.gross_sales,
              o.net_revenue, o.fulfillment_status, sh.name AS shop_name
         FROM sales_orders o
         LEFT JOIN shops sh ON sh.id = o.shop_id
        WHERE o.status = 'POSTED' AND o.order_date BETWEEN ? AND ?
        ORDER BY o.order_date, o.id`
    )
    .all(from, to);

  // Order yang punya jurnal atau retur pada bulan tertutup tidak bisa dibatalkan.
  const terkunci = orders.filter((o) => kunci.has(o.order_date.slice(0, 7)));

  const retur = db
    .prepare(
      `SELECT r.id, r.return_no, r.return_date, r.kondisi, r.order_id, o.order_no,
              b.status AS status_perbaikan
         FROM sales_returns r
         JOIN sales_orders o ON o.id = r.order_id
         LEFT JOIN barang_perbaikan b ON b.return_id = r.id
        WHERE o.status = 'POSTED' AND o.order_date BETWEEN ? AND ?`
    )
    .all(from, to);

  // Retur yang barangnya sudah selesai dikemas ulang tidak bisa dibalik dari
  // sini — akibatnya sudah menyebar ke stok dan jurnal perbaikan.
  const returMacet = retur.filter(
    (r) => (r.status_perbaikan && r.status_perbaikan !== 'MENUNGGU')
      || kunci.has(String(r.return_date).slice(0, 7))
  );

  const stok = db
    .prepare(
      `SELECT p.id, p.sku, p.name, p.unit, SUM(i.qty) AS qty
         FROM sales_items i
         JOIN sales_orders o ON o.id = i.order_id
         JOIN products p ON p.id = i.product_id
        WHERE o.status = 'POSTED' AND o.order_date BETWEEN ? AND ?
        GROUP BY p.id ORDER BY qty DESC`
    )
    .all(from, to)
    .map((x) => ({ ...x, qty: r2(x.qty) }));

  // Pengaruhnya pada saldo tiap akun: kebalikan dari yang dulu dibukukan.
  //
  // Saldo AKHIR periode sesudah dihapus ikut dihitung, bukan hanya
  // perubahannya. Menghapus order sebulan berarti menghapus seluruh
  // pemasukannya, sementara pengeluaran bulan itu — bayar supplier, iklan
  // yang dipotong saldo marketplace — tetap tercatat. Rekening yang tadinya
  // positif bisa menjadi minus puluhan juta, dan itu hanya terlihat bila
  // saldo akhirnya ditunjukkan; angka perubahan saja tidak memberi tahu.
  const akun = db
    .prepare(
      `SELECT a.code, a.name, a.type, a.is_cash, a.subtype,
              COALESCE(SUM(l.debit - l.credit), 0) AS saldo,
              (SELECT COALESCE(SUM(l2.debit - l2.credit), 0)
                 FROM journal_lines l2 JOIN journals j2 ON j2.id = l2.journal_id
                WHERE l2.account_id = a.id AND j2.entry_date <= ?) AS saldo_akhir
         FROM journal_lines l
         JOIN journals j ON j.id = l.journal_id
         JOIN sales_orders o ON o.id = j.source_id AND j.source = 'SALES'
         JOIN accounts a ON a.id = l.account_id
        WHERE o.status = 'POSTED' AND o.order_date BETWEEN ? AND ?
        GROUP BY a.code ORDER BY a.code`
    )
    .all(to, from, to)
    .map((a) => ({
      ...a,
      perubahan: r2(-a.saldo),
      saldoSebelum: r2(a.saldo_akhir),
      saldoSesudah: r2(a.saldo_akhir - a.saldo),
    }))
    .filter((a) => Math.abs(a.perubahan) >= 0.01);

  return { orders, terkunci, retur, returMacet, stok, akun };
}

const bersihkanSchema = z.object({
  from: TGL,
  to: TGL,
  terapkan: z.boolean().default(false),
  // Diketik ulang oleh orangnya, berisi jumlah ordernya. Tombol yang bisa
  // membatalkan ratusan order sekaligus tidak boleh bisa tertekan tidak sengaja.
  konfirmasi: z.string().trim().optional(),
});

const jalankanBersihkan = db.transaction((ids) => {
  for (const id of ids) cancelOrder(id);
  return ids.length;
});

router.post('/bersihkan-periode', butuhIzin('penjualan.batal'), ah((req, res) => {
  const body = parse(bersihkanSchema, req.body);
  if (body.to < body.from) throw httpError(422, 'Tanggal akhir tidak boleh sebelum tanggal awal');

  const c = calonBersihkan(body.from, body.to);
  const kataKunci = `HAPUS ${c.orders.length}`;
  const jumlah = (f) => r2(c.orders.reduce((s, o) => s + (o[f] || 0), 0));

  const ringkas = {
    from: body.from,
    to: body.to,
    orders: c.orders.length,
    penjualanKotor: jumlah('gross_sales'),
    pendapatan: jumlah('net_revenue'),
    retur: c.retur.length,
    terkunci: c.terkunci.length,
    returMacet: c.returMacet.length,
    unitKembali: r2(c.stok.reduce((s, x) => s + x.qty, 0)),
    kataKunci,
  };

  const penghalang = [];
  if (c.terkunci.length) {
    penghalang.push(
      `${c.terkunci.length} order berada di bulan yang sudah ditutup buku — buka dulu tutup bukunya`
    );
  }
  if (c.returMacet.length) {
    penghalang.push(
      `${c.returMacet.length} retur tidak bisa dibalik (${c.returMacet.map((r) => r.return_no).slice(0, 5).join(', ')}` +
        `${c.returMacet.length > 5 ? ', …' : ''}) — barangnya sudah selesai dikemas ulang atau returnya di bulan tertutup`
    );
  }

  // Bukan penghalang — pemiliknya mungkin memang berniat memasukkan saldo awal
  // sesudahnya — tetapi harus diketahui SEBELUM tombolnya ditekan.
  const jadiMinus = c.akun.filter(
    (a) => (a.is_cash || a.subtype === 'RECEIVABLE') && a.saldoSesudah < -0.01
  );
  const peringatan = jadiMinus.map(
    (a) => `${a.code} ${a.name} akan menjadi minus Rp ${Math.abs(a.saldoSesudah).toLocaleString('id-ID')} ` +
      `per ${body.to} (sekarang Rp ${a.saldoSebelum.toLocaleString('id-ID')})`
  );

  if (!body.terapkan) {
    return res.json({
      ok: true, dicoba: true, ringkas, penghalang, peringatan,
      stok: c.stok.slice(0, 30),
      akun: c.akun,
      contoh: c.orders.slice(0, 20),
    });
  }

  if (!c.orders.length) throw httpError(422, 'Tidak ada order pada rentang tanggal itu');
  if (penghalang.length) throw httpError(409, penghalang.join('. '));
  if (body.konfirmasi !== kataKunci) {
    throw httpError(422, `Ketik "${kataKunci}" persis untuk melanjutkan`);
  }

  const dibatalkan = jalankanBersihkan(c.orders.map((o) => o.id));
  res.json({
    ok: true, dibatalkan, ringkas,
    message: `${dibatalkan} order ${body.from} s/d ${body.to} dihapus dari pembukuan` +
      (c.retur.length ? `, termasuk ${c.retur.length} returnya` : ''),
  });
}));

// ==================================================================
// ANALISIS MARGIN PER CHANNEL
// ==================================================================
/** GET /api/sales/analytics — agregasi profitabilitas per channel & produk. */
/** Pengambil analisis margin — dipakai layar dan berkas unduhan. */
function ambilAnalitik(req) {
  const { from, to } = dateRange(req.query);

  const byChannel = db
    .prepare(
      `SELECT channel,
              COUNT(*)              AS orders,
              SUM(gross_sales)      AS gross_sales,
              SUM(discount)         AS discount,
              SUM(net_revenue)      AS net_revenue,
              SUM(cogs)             AS cogs,
              SUM(admin_fee)        AS admin_fee,
              SUM(handling_fee)     AS handling_fee,
              SUM(shipping_extra)   AS shipping_extra,
              SUM(voucher_platform) AS voucher_platform,
              SUM(tax_amount)       AS tax_amount,
              SUM(packing_cost)     AS packing_cost,
              SUM(other_cost)       AS other_cost,
              SUM(total_fees)       AS total_fees,
              SUM(gross_profit)     AS gross_profit,
              SUM(net_profit)       AS net_profit
         FROM sales_orders
        WHERE order_date BETWEEN ? AND ? AND status = 'POSTED'
        GROUP BY channel
        ORDER BY net_profit DESC`
    )
    .all(from, to)
    .map((r) => ({
      ...r,
      label: CHANNEL_LABEL[r.channel],
      margin_pct: r.net_revenue ? r2((r.net_profit / r.net_revenue) * 100) : 0,
      fee_ratio_pct: r.net_revenue ? r2((r.total_fees / r.net_revenue) * 100) : 0,
      avg_order_value: r.orders ? r2(r.net_revenue / r.orders) : 0,
    }));

  const byProduct = db
    .prepare(
      `SELECT p.id, p.sku, p.name, p.unit,
              SUM(i.qty)      AS qty,
              SUM(i.subtotal) AS revenue,
              SUM(i.subcost)  AS cost,
              SUM(i.subtotal - i.subcost) AS gross_profit
         FROM sales_items i
         JOIN sales_orders o ON o.id = i.order_id
         JOIN products p     ON p.id = i.product_id
        WHERE o.order_date BETWEEN ? AND ? AND o.status = 'POSTED'
        GROUP BY p.id
        ORDER BY gross_profit DESC
        LIMIT 50`
    )
    .all(from, to)
    .map((r) => ({ ...r, margin_pct: r.revenue ? r2((r.gross_profit / r.revenue) * 100) : 0 }));

  const daily = db
    .prepare(
      `SELECT order_date,
              SUM(net_revenue) AS net_revenue,
              SUM(net_profit)  AS net_profit,
              COUNT(*)         AS orders
         FROM sales_orders
        WHERE order_date BETWEEN ? AND ? AND status = 'POSTED'
        GROUP BY order_date ORDER BY order_date`
    )
    .all(from, to);

  const totals = byChannel.reduce(
    (acc, c) => {
      for (const k of ['orders', 'gross_sales', 'net_revenue', 'cogs', 'total_fees', 'gross_profit', 'net_profit']) {
        acc[k] = r2((acc[k] || 0) + (c[k] || 0));
      }
      return acc;
    },
    {}
  );
  totals.margin_pct = totals.net_revenue ? r2((totals.net_profit / totals.net_revenue) * 100) : 0;

  return { from, to, byChannel, byProduct, daily, totals, channelLabels: CHANNEL_LABEL };
}

router.get('/analytics', ah((req, res) => res.json(ambilAnalitik(req))));

// ------------------------------------------------------------------
// Unduhan
// ------------------------------------------------------------------

const KOLOM_ORDER = [
  { header: 'No. Order', key: 'order_no', width: 18 },
  { header: 'Tanggal', key: 'order_date', width: 11 },
  { header: 'Toko', key: 'shop_name', width: 20 },
  { header: 'Channel', key: 'channel_label', width: 16 },
  { header: 'No. Pesanan', key: 'order_ref', width: 20 },
  { header: 'Status', key: 'fulfillment_status', width: 11 },
  { header: 'Tgl Cair', key: 'payout_date', width: 11 },
  { header: 'Pembeli', key: 'buyer_name', width: 22 },
  { header: 'Kota', key: 'buyer_city', width: 16 },
  { header: 'Ekspedisi', key: 'courier', width: 14 },
  { header: 'Resi', key: 'tracking_no', width: 20 },
  { header: 'Penjualan Kotor', key: 'gross_sales', width: 15, money: true },
  { header: 'Diskon', key: 'discount', width: 11, money: true },
  // Sama persis dengan layar: "Pendapatan Kotor" adalah penjualan setelah
  // diskon, dan "Pendapatan Bersih" adalah setelah seluruh biaya channel.
  // Kolom ini pernah salah diberi nama "Pendapatan Bersih" padahal isinya
  // net_revenue — pada order tanpa diskon angkanya sama dengan penjualan
  // kotor, dan pembacanya menyimpulkan biaya channelnya tidak terhitung.
  { header: 'Pendapatan Kotor', key: 'net_revenue', width: 16, money: true },
  { header: 'HPP', key: 'cogs', width: 13, money: true },
  { header: 'Laba Kotor', key: 'gross_profit', width: 14, money: true },
  // Nama kolom mengikuti rincian pencairan marketplace, sama dengan yang
  // tampil di formulir order — berkas unduhan tidak boleh memakai istilah yang
  // berbeda dari layar tempat angkanya diketik.
  { header: 'Voucher & Subsidi', key: 'voucher_platform', width: 16, money: true },
  { header: 'Biaya Platform', key: 'admin_fee', width: 15, money: true },
  { header: 'Biaya Gratis Ongkir XTRA', key: 'shipping_extra', width: 20, money: true },
  { header: 'Biaya Layanan', key: 'handling_fee', width: 15, money: true },
  { header: 'Ongkir Ditagih', key: 'shipping_charged', width: 14, money: true },
  { header: 'Biaya Kirim Non MP', key: 'shipping_non_mp', width: 18, money: true },
  { header: 'Packing', key: 'packing_cost', width: 11, money: true },
  { header: 'Total Biaya', key: 'total_fees', width: 14, money: true },
  // Yang benar-benar mendarat di rekening: pendapatan kotor − biaya channel,
  // ditambah ongkir yang ditagih di luar marketplace.
  { header: 'Pendapatan Bersih', key: 'net_received', width: 16, money: true },
  { header: 'Laba Bersih', key: 'net_profit', width: 14, money: true },
  { header: 'Margin', key: 'margin_pct', width: 10, pct: true },
];

daftarkanEkspor(router, {
  path: '',
  judul: 'Order Penjualan',
  kolom: KOLOM_ORDER,
  ambil: (req) => {
    const { from, to, where, params } = orderFilter(req.query);
    const rows = db
      .prepare(
        `SELECT o.*, sh.name AS shop_name
           FROM sales_orders o
           LEFT JOIN shops sh ON sh.id = o.shop_id
           ${where} ORDER BY o.order_date, o.id`
      )
      .all(...params);
    return {
      rows: rows.map((r) => ({
        ...r,
        channel_label: CHANNEL_LABEL[r.channel] || r.channel,
        net_received: r2(r.net_revenue - r.total_fees + (r.shipping_non_mp || 0)),
      })),
      subtitle: `Periode ${from} s/d ${to}`,
      meta: [
        ['Jumlah order', rows.length],
        ['Total pendapatan kotor', r2(rows.reduce((s, r) => s + r.net_revenue, 0))],
        ['Total biaya channel', r2(rows.reduce((s, r) => s + r.total_fees, 0))],
        ['Total pendapatan bersih',
          r2(rows.reduce((s, r) => s + r.net_revenue - r.total_fees + (r.shipping_non_mp || 0), 0))],
        ['Total laba bersih', r2(rows.reduce((s, r) => s + r.net_profit, 0))],
      ],
    };
  },
});

daftarkanEkspor(router, {
  path: '/analytics',
  judul: 'Analisis Margin per Channel',
  kolom: [
    { header: 'Channel', key: 'label', width: 20 },
    { header: 'Order', key: 'orders', width: 10 },
    { header: 'Penjualan Kotor', key: 'gross_sales', width: 16, money: true },
    { header: 'Pendapatan Bersih', key: 'net_revenue', width: 17, money: true },
    { header: 'HPP', key: 'cogs', width: 14, money: true },
    { header: 'Total Biaya', key: 'total_fees', width: 15, money: true },
    { header: 'Laba Bersih', key: 'net_profit', width: 15, money: true },
    { header: 'Margin', key: 'margin_pct', width: 10, pct: true },
  ],
  ambil: (req) => {
    const d = ambilAnalitik(req);
    return {
      rows: d.byChannel.map((c) => ({ ...c, label: CHANNEL_LABEL[c.channel] || c.channel })),
      subtitle: `Periode ${d.from} s/d ${d.to}`,
      meta: [
        ['Total pendapatan bersih', d.totals.net_revenue || 0],
        ['Total laba bersih', d.totals.net_profit || 0],
      ],
    };
  },
});

daftarkanEkspor(router, {
  path: '/returns/list',
  judul: 'Retur Penjualan',
  kolom: [
    { header: 'Tanggal', key: 'return_date', width: 12 },
    { header: 'No. Pesanan', key: 'order_ref', width: 20 },
    { header: 'No. Resi', key: 'tracking_no', width: 22 },
    { header: 'Pembeli', key: 'buyer_name', width: 24 },
    { header: 'SKU', key: 'sku', width: 16 },
    { header: 'Produk', key: 'product_name', width: 34 },
    { header: 'Jumlah', key: 'qty', width: 10 },
    { header: 'Nilai', key: 'amount', width: 16, money: true },
    { header: 'Kondisi Barang', key: 'kondisi_label', width: 24 },
    { header: 'Alasan', key: 'reason', width: 34 },
  ],
  ambil: (req) => {
    const d = ambilRetur(req);
    const hitung = (k) => d.rows.filter((r) => (r.kondisi || (r.restock ? 'BAGUS' : 'RUSAK')) === k).length;
    return {
      rows: d.rows.map((r) => ({
        ...r,
        kondisi_label: LABEL_KONDISI[r.kondisi] || (r.restock ? LABEL_KONDISI.BAGUS : LABEL_KONDISI.RUSAK),
      })),
      subtitle: `Periode ${d.from} s/d ${d.to}`,
      meta: [
        ['Jumlah retur', d.rows.length],
        ['Total nilai retur', d.total],
        ['Kembali ke stok jual', hitung('BAGUS')],
        ['Perlu dikemas ulang', hitung('PERBAIKI')],
        ['Rusak total', hitung('RUSAK')],
      ],
    };
  },
});


// ==================================================================
// RETUR PENJUALAN
// ==================================================================
/**
 * Kondisi barang yang diretur — tiga, bukan dua.
 *
 *   BAGUS    : botol utuh, kemasan mulus. Langsung kembali ke stok jual.
 *   PERBAIKI : aluminium foil atau labelnya rusak, isinya masih baik. Perlu
 *              dikemas ulang dulu, setelah itu bisa dijual lagi.
 *   RUSAK    : botol pecah, isinya tumpah. Tidak ada yang bisa diselamatkan.
 *
 * Dulu hanya ada dua lewat centang `restock`, sehingga barang yang cukup
 * dikemas ulang terpaksa dicatat sebagai kerugian lalu dimasukkan lagi sebagai
 * barang baru — dan selama diperbaiki ia tidak tercatat di mana pun.
 *
 * `restock` tetap ditulis supaya layar dan berkas lama tidak berubah artinya.
 */
const KONDISI = ['BAGUS', 'PERBAIKI', 'RUSAK'];

const returnSchema = z.object({
  return_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).default(() => todayLocal()),
  order_id: z.number().int().positive().optional().nullable(),
  product_id: z.number().int().positive(),
  qty: z.number().positive(),
  price: z.number().nonnegative(),
  // Dipertahankan demi pemanggil lama; kondisi yang menang bila keduanya ada.
  restock: z.boolean().default(true),
  kondisi: z.enum(KONDISI).optional(),
  // Rekening yang dipotong. Kosong berarti ikut rekening ordernya.
  cash_code: z.string().trim().optional().nullable(),
  reason: z.string().max(300).optional().nullable(),
});

/**
 * Memeriksa retur terhadap order asalnya.
 *
 * Selama ini nomor order hanya dicatat sebagai angka tanpa diperiksa apa pun,
 * sehingga barang yang tidak pernah ada di pesanan itu tetap bisa diretur, dan
 * satu pesanan bisa diretur berkali-kali melebihi jumlah yang benar-benar
 * dikirim. Keduanya baru ketahuan saat stok dihitung fisik — kalau ketahuan.
 */
function periksaOrderAsal(orderId, productId, qty, abaikanId = null) {
  const order = db.prepare('SELECT * FROM sales_orders WHERE id = ?').get(orderId);
  if (!order) throw httpError(404, 'Order penjualan tidak ditemukan');
  if (order.fulfillment_status === 'BATAL') {
    throw httpError(422, `Order ${order.order_ref || order.order_no} sudah dibatalkan`);
  }

  const terjual = db
    .prepare(
      `SELECT COALESCE(SUM(qty), 0) AS n FROM sales_items
        WHERE order_id = ? AND product_id = ?`
    )
    .get(orderId, productId).n;

  if (terjual <= 0) {
    const p = db.prepare('SELECT name FROM products WHERE id = ?').get(productId);
    throw httpError(
      422,
      `${p ? p.name : 'Produk ini'} tidak ada di order ${order.order_ref || order.order_no}.`
    );
  }

  // Retur yang sedang diubah tidak boleh menghitung dirinya sendiri sebagai
  // "sudah diretur" — kalau ikut, mengubah retur 4 menjadi 2 akan ditolak
  // dengan alasan barangnya sudah habis diretur.
  const sudahDiretur = db
    .prepare(
      `SELECT COALESCE(SUM(qty), 0) AS n FROM sales_returns
        WHERE order_id = ? AND product_id = ? AND (? IS NULL OR id <> ?)`
    )
    .get(orderId, productId, abaikanId, abaikanId).n;

  const sisa = r2(terjual - sudahDiretur);
  if (qty > sisa + 0.001) {
    const p = db.prepare('SELECT name, unit FROM products WHERE id = ?').get(productId);
    throw httpError(
      422,
      `${p.name} pada order ${order.order_ref || order.order_no} hanya ${terjual} ${p.unit}` +
        (sudahDiretur > 0 ? `, ${sudahDiretur} sudah diretur` : '') +
        `. Sisa yang bisa diretur ${sisa} ${p.unit}.`
    );
  }

  return order;
}

/**
 * Menulis satu retur beserta seluruh akibatnya.
 *
 * Dipakai dua kali: saat retur baru dicatat, dan saat retur yang sudah ada
 * diubah. Yang membedakan hanya `id` — bila diisi, barisnya diperbarui di
 * tempat, bukan dibuat baru. Nomor DAN id barisnya sengaja dipertahankan:
 * nomornya sudah beredar di percakapan dengan pembeli, dan id yang berganti
 * tiap kali diubah membuat riwayat perubahan tidak bisa ditelusuri.
 */
/**
 * Rekening yang dipotong saat dana dikembalikan ke pembeli.
 *
 * Urutannya mengikuti dari mana uangnya dulu datang:
 *   1. rekening yang dipilih pada formulir retur — orangnya selalu menang;
 *   2. rekening ordernya;
 *   3. rekening bawaan toko tempat order itu dibuat;
 *   4. kas tunai, sebagai jalan terakhir untuk penjualan luring.
 */
function rekeningPengembalian(body) {
  const pakai = (code) => {
    if (!code) return null;
    const akun = db.prepare('SELECT * FROM accounts WHERE code = ? AND is_cash = 1').get(code);
    return akun ? akun.code : null;
  };

  if (body.cash_code) {
    const akun = db.prepare('SELECT * FROM accounts WHERE code = ?').get(body.cash_code);
    if (!akun) throw httpError(404, `Rekening ${body.cash_code} tidak ditemukan`);
    if (!akun.is_cash) throw httpError(422, `${akun.code} · ${akun.name} bukan rekening kas/bank`);
    return akun.code;
  }

  if (body.order_id) {
    const o = db
      .prepare(
        `SELECT o.cash_code, s.cash_code AS toko_cash_code
           FROM sales_orders o
           LEFT JOIN shops s ON s.id = o.shop_id
          WHERE o.id = ?`
      )
      .get(body.order_id);
    if (o) return pakai(o.cash_code) || pakai(o.toko_cash_code) || ACC.CASH;
  }

  return ACC.CASH;
}

const tulisRetur = db.transaction((body, userId) => {
  const product = db.prepare('SELECT * FROM products WHERE id = ?').get(body.product_id);
  if (!product) throw httpError(404, 'Produk tidak ditemukan');

  if (body.order_id) periksaOrderAsal(body.order_id, product.id, r2(body.qty), body.id || null);

  const kondisi = body.kondisi || (body.restock ? 'BAGUS' : 'RUSAK');
  const masukStok = kondisi === 'BAGUS';

  const qty = r2(body.qty);
  const amount = r2(qty * body.price);
  const costValue = r2(qty * product.cost);
  // Nomor dipertahankan saat retur diubah: nomor itu sudah beredar di
  // percakapan dengan pembeli, jadi menggantinya hanya membingungkan.
  // Uangnya dikembalikan lewat jalan yang sama dengan masuknya.
  //
  // Pembeli marketplace tidak pernah menerima uang tunai dari kita: dananya
  // dipotong dari saldo toko tempat ia membeli. Mengkreditkan kas tunai
  // membuat saldo tunai berkurang untuk uang yang tidak pernah ada di laci,
  // sementara rekening toko yang benar-benar terpotong tetap tampak utuh.
  const rekeningRetur = rekeningPengembalian(body);

  const returnNo = body.return_no || nextNumber('RTN', body.return_date.slice(0, 7));

  let returnId = body.id || null;
  if (returnId) {
    db.prepare(
      `UPDATE sales_returns
          SET return_date = ?, order_id = ?, product_id = ?, qty = ?, price = ?, cost = ?,
              amount = ?, restock = ?, kondisi = ?, reason = ?, cash_code = ?
        WHERE id = ?`
    ).run(
      body.return_date, body.order_id || null, product.id, qty, r2(body.price),
      product.cost, amount, masukStok ? 1 : 0, kondisi, body.reason || null, rekeningRetur, returnId
    );
  } else {
    returnId = db
      .prepare(
        `INSERT INTO sales_returns (return_no, return_date, order_id, product_id, qty, price, cost, amount, restock, kondisi, reason, user_id, cash_code)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`
      )
      .run(returnNo, body.return_date, body.order_id || null, product.id, qty, r2(body.price), product.cost, amount, masukStok ? 1 : 0, kondisi, body.reason || null, userId, rekeningRetur)
      .lastInsertRowid;
  }
  const info = { lastInsertRowid: returnId };

  const lines = [
    { code: ACC.SALES_RETURN, debit: amount, credit: 0, memo: `Retur ${product.name}` },
    { code: rekeningRetur, debit: 0, credit: amount, memo: 'Pengembalian dana pembeli' },
  ];

  if (kondisi === 'PERBAIKI') {
    // Barangnya tidak masuk stok jual, tetapi nilainya tidak boleh hilang dari
    // neraca — ia dipindahkan dari HPP ke pos tersendiri sampai selesai
    // dikerjakan. Tanpa ini, barang yang sedang di rak perbaikan tidak ada di
    // catatan mana pun, dan yang lupa mengerjakannya tidak akan pernah tahu.
    db.prepare(
      `INSERT INTO barang_perbaikan
         (return_id, product_id, tanggal_masuk, qty, unit_cost, nilai, status, catatan, user_id)
       VALUES (?,?,?,?,?,?, 'MENUNGGU', ?, ?)`
    ).run(
      info.lastInsertRowid, product.id, body.return_date, qty,
      r2(product.cost), costValue, body.reason || null, userId
    );

    lines.push({ code: ACC.REPAIR_INVENTORY, debit: costValue, credit: 0, memo: `Menunggu perbaikan: ${product.name}` });
    lines.push({ code: ACC.COGS, debit: 0, credit: costValue, memo: 'Pembalikan HPP' });
  }

  if (kondisi === 'RUSAK') {
    // Nilainya dipindahkan dari HPP ke akun kerugian. Laba tidak berubah
    // sedikit pun — yang berubah hanya namanya, sehingga berapa yang hilang
    // karena barang rusak akhirnya bisa dibaca di laporan.
    if (costValue > 0) {
      lines.push({ code: ACC.DAMAGED_LOSS, debit: costValue, credit: 0, memo: `Barang rusak: ${product.name}` });
      lines.push({ code: ACC.COGS, debit: 0, credit: costValue, memo: 'Pemindahan dari HPP' });
    }
  }

  if (masukStok) {
    const newStock = r2(product.stock + qty);
    db.prepare('UPDATE products SET stock = ? WHERE id = ?').run(newStock, product.id);
    db.prepare(
      `INSERT INTO stock_moves (product_id, move_date, move_type, qty, unit_cost, balance_after, ref, source, source_id, note, user_id)
       VALUES (?,?,'IN',?,?,?,?, 'RETURN', ?, 'Retur masuk gudang', ?)`
    ).run(product.id, body.return_date, qty, product.cost, newStock, returnNo, info.lastInsertRowid, userId);

    // Barang retur masuk ke batch tersendiri: ia sudah pernah keluar gudang,
    // dan mencampurnya ke batch asal membuat riwayat "pernah dikirim ke
    // pembeli" hilang tepat pada barang yang paling perlu diperiksa.
    BATCH.masuk({
      product_id: product.id, qty, unit_cost: product.cost, tanggal: body.return_date,
      kode: `RETUR-${returnNo}`, catatan: 'Barang retur dari pembeli',
      source: 'RETURN', sourceId: info.lastInsertRowid, userId,
    });

    // Barang kembali ke gudang → HPP dibalik
    lines.push({ code: ACC.INVENTORY, debit: costValue, credit: 0, memo: 'Persediaan kembali' });
    lines.push({ code: ACC.COGS, debit: 0, credit: costValue, memo: 'Pembalikan HPP' });
  }

  postJournal({
    date: body.return_date,
    description: `Retur Penjualan ${returnNo} — ${product.name}`,
    lines,
    source: 'RETURN',
    sourceId: info.lastInsertRowid,
    userId,
  });

  return { id: info.lastInsertRowid, return_no: returnNo, amount, kondisi };
});

/**
 * Membatalkan seluruh akibat satu retur, supaya bisa dicatat ulang.
 *
 * Retur bukan sekadar satu baris catatan: ia bisa sudah menambah stok,
 * membuka batch tersendiri, membentuk jurnal, dan menaruh barang di daftar
 * perbaikan. Mengubah barisnya saja akan meninggalkan keempatnya seperti
 * semula — angka lama tetap hidup di stok dan buku besar, sementara layar
 * menyebut angka baru.
 *
 * Karena itu mengubah retur dikerjakan sebagai batalkan-lalu-catat-lagi, di
 * dalam satu transaksi, dengan nomor retur yang tetap sama.
 */
function batalkanEfekRetur(r) {
  const produk = db.prepare('SELECT * FROM products WHERE id = ?').get(r.product_id);
  const kondisi = r.kondisi || (r.restock ? 'BAGUS' : 'RUSAK');

  if (kondisi === 'PERBAIKI') {
    const pbk = db.prepare('SELECT * FROM barang_perbaikan WHERE return_id = ?').get(r.id);
    if (pbk && pbk.status !== 'MENUNGGU') {
      throw httpError(
        409,
        `Barang retur ini sudah ${pbk.status === 'SELESAI' ? 'selesai dikemas ulang dan kembali ke stok' : 'dihapus sebagai kerugian'}. ` +
          'Returnya tidak bisa diubah lagi — perubahannya harus lewat menu Barang Perlu Perbaikan.'
      );
    }
    if (pbk) db.prepare('DELETE FROM barang_perbaikan WHERE id = ?').run(pbk.id);
  }

  if (kondisi === 'BAGUS') {
    const qty = r2(r.qty);
    if (qty > r2(produk.stock)) {
      throw httpError(
        422,
        `Stok ${produk.name} tinggal ${produk.stock} ${produk.unit}, tidak cukup untuk ` +
          `membatalkan retur ${qty} ${produk.unit} yang dulu masuk. Barangnya kemungkinan sudah terjual lagi.`
      );
    }
    db.prepare('UPDATE products SET stock = ? WHERE id = ?').run(r2(produk.stock - qty), produk.id);
    BATCH.kembalikan({ source: 'RETURN', sourceId: r.id, tanggal: r.return_date });
    db.prepare("DELETE FROM stock_moves WHERE source = 'RETURN' AND source_id = ?").run(r.id);
  }

  deleteJournalsBySource('RETURN', r.id);
}

const ubahReturSchema = returnSchema.extend({
  return_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

const ubahRetur = db.transaction((id, body, userId) => {
  const lama = db.prepare('SELECT * FROM sales_returns WHERE id = ?').get(id);
  if (!lama) throw httpError(404, 'Retur tidak ditemukan');

  batalkanEfekRetur(lama);

  // Dicatat ulang lewat jalur yang sama dengan retur baru, supaya tidak ada
  // versi kedua dari logika stok, batch, dan jurnalnya. Nomornya dipertahankan
  // karena nomor itu sudah beredar di percakapan dengan pembeli.
  // Baris yang sama diperbarui di tempat: nomor dan id-nya tidak berganti.
  return tulisRetur({ ...body, id: lama.id, return_no: lama.return_no }, userId);
});

router.put('/returns/:id(\\d+)', butuhIzin('penjualan.retur'), ah((req, res) => {
  const body = parse(ubahReturSchema, req.body);
  const hasil = ubahRetur(Number(req.params.id), body, req.user.id);
  res.json({
    ok: true,
    ...hasil,
    message: `Retur ${hasil.return_no} diperbarui — ${KABAR_KONDISI[hasil.kondisi]}`,
  });
}));

router.post('/returns', butuhIzin('penjualan.buat'), ah((req, res) => {
  const body = parse(returnSchema, req.body);
  const hasil = tulisRetur(body, req.user.id);
  res.status(201).json({
    ok: true, ...hasil,
    message: `Retur ${hasil.return_no} tercatat — ${KABAR_KONDISI[hasil.kondisi]}`,
  });
}));

/** Pengambil daftar retur — dipakai layar dan berkas unduhan. */
function ambilRetur(req) {
  const { from, to } = dateRange(req.query);

  const kata = String(req.query.q || '').trim();
  const cari = kata.length >= 2
    ? {
        // Nomor pesanan dan resi ikut dicari: itu yang dipegang orang saat
        // pembeli menghubungi, bukan nomor retur yang kita buat sendiri.
        where:
          '(p.name LIKE ? OR p.sku LIKE ? OR r.reason LIKE ? OR r.return_no LIKE ?'
          + ' OR o.order_ref LIKE ? OR o.order_no LIKE ? OR o.tracking_no LIKE ?)',
        params: Array(7).fill(`%${kata}%`),
      }
    : null;

  const rows = db
    .prepare(
      `SELECT r.*, p.sku, p.name AS product_name, p.unit,
              o.order_no, o.order_ref, o.tracking_no, o.courier,
              o.buyer_name, o.order_date, sh.name AS shop_name
         FROM sales_returns r
         JOIN products p ON p.id = r.product_id
         LEFT JOIN sales_orders o ON o.id = r.order_id
         LEFT JOIN shops sh ON sh.id = o.shop_id
        WHERE r.return_date BETWEEN ? AND ? ${cari ? `AND ${cari.where}` : ''}
        ORDER BY r.return_date DESC, r.id DESC`
    )
    .all(from, to, ...(cari ? cari.params : []));
  return { from, to, rows, total: r2(rows.reduce((s, r) => s + r.amount, 0)) };
}

router.get('/returns/list', ah((req, res) => res.json(ambilRetur(req))));

module.exports = router;
// Dipakai Laporan Penjualan supaya angka returnya berasal dari fungsi yang
// SAMA dengan menu Retur Penjualan — bukan dihitung ulang dengan query sendiri.
module.exports.ambilRetur = ambilRetur;
module.exports.calonBersihkan = calonBersihkan;
module.exports.cancelOrder = cancelOrder;
