'use strict';
const express = require('express');
const { z } = require('zod');
const { db, nextNumber } = require('../db');
const { requireAuth, butuhIzin } = require('../middleware/auth');
const { ah, parse, httpError, dateRange } = require('../utils/http');
const { r2, ACC, postJournal, deleteJournalsBySource, buildSalesJournalLines } = require('../utils/accounting');
const { daftarkanEkspor } = require('../utils/ekspor');
const { todayLocal } = require('../utils/time');

const router = express.Router();
router.use(requireAuth);

const { CHANNELS, CHANNEL_LABEL } = require('../utils/kanal');
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
  fulfillment_status: z.enum(['DIPROSES', 'DIKIRIM', 'SELESAI', 'CAIR', 'RETUR', 'BATAL']).default('DIPROSES'),
  payout_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().nullable(),
  shipping_charged: z.number().nonnegative().default(0),
  buyer_name: z.string().trim().max(120).optional().nullable(),
  buyer_account: z.string().trim().max(120).optional().nullable(),
  buyer_phone: z.string().trim().max(30).optional().nullable(),
  buyer_address: z.string().trim().max(300).optional().nullable(),
  buyer_city: z.string().trim().max(80).optional().nullable(),
  lead_source: z.string().trim().max(50).optional().nullable(),

  payment_status: z.enum(['PAID', 'UNPAID']).default('PAID'),
  note: z.string().max(300).optional().nullable(),
});

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

  // Uang yang benar-benar diterima setelah seluruh potongan marketplace.
  // Tidak disimpan sebagai kolom karena selalu bisa diturunkan dari dua kolom
  // yang sudah ada — menyimpannya hanya menciptakan angka kedua yang bisa
  // berbeda bila salah satunya diperbarui sendirian.
  const net_received = r2(net_revenue - total_fees);

  return {
    gross_sales, cogs, discount, net_revenue, admin_fee, tax_amount, total_fees,
    net_received, gross_profit, net_profit, margin_pct,
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
         buyer_city, lead_source
       ) VALUES (?,?,?,?,?, ?,?,?, ?,?,?,?,?, ?,?,?,?, ?,?,?,?,?, ?, 'POSTED', ?, ?, ?, ?,
                 ?,?,?,?,?,?, ?,?,?,?,?, ?,?)`
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
      body.buyer_city || null, body.lead_source || null
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

  for (const it of items) {
    insertItem.run(orderId, it.product_id, it.qty, it.price, it.cost, it.subtotal, it.subcost);

    // Saldo dihitung dari sisa berjalan, bukan dari snapshot produk. Bila satu
    // order memuat produk yang sama dua kali, snapshot membuat pengurangan
    // kedua menimpa yang pertama — stok tampak masih utuh padahal barangnya
    // sudah keluar dua kali, dan buku besar ikut salah karenanya.
    const sebelum = sisaStok.has(it.product_id) ? sisaStok.get(it.product_id) : it.product.stock;
    const newStock = r2(sebelum - it.qty);
    sisaStok.set(it.product_id, newStock);
    db.prepare('UPDATE products SET stock = ? WHERE id = ?').run(newStock, it.product_id);
    insertMove.run(
      it.product_id, body.order_date, it.qty, it.cost, newStock, orderNo, orderId,
      `Penjualan ${CHANNEL_LABEL[body.channel]}`, userId
    );
  }

  const journal = postJournal({
    date: body.order_date,
    description: `Penjualan ${orderNo} — ${CHANNEL_LABEL[body.channel]}`,
    lines: buildSalesJournalLines({ ...body, ...calc }),
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
              COALESCE(SUM(o.net_profit), 0)   AS net_profit
         FROM sales_orders o
         LEFT JOIN shops sh ON sh.id = o.shop_id
         ${where}`
    )
    .get(...params);

  const diminta = batas(req.query.limit);
  res.json({
    from, to, rows,
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
      // Yang benar-benar diterima setelah seluruh potongan.
      netReceived: r2(total.net_revenue - total.total_fees),
      cogs: r2(total.cogs),
      totalFees: r2(total.total_fees),
      grossProfit: r2(total.gross_profit),
      netProfit: r2(total.net_profit),
      marginPct: total.net_revenue ? r2((total.net_profit / total.net_revenue) * 100) : 0,
      avgOrderValue: total.orders ? r2(total.net_revenue / total.orders) : 0,
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

  const journal = db
    .prepare("SELECT * FROM journals WHERE source = 'SALES' AND source_id = ?")
    .get(order.id);

  res.json({ order, items, journal });
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
  fulfillment_status: z.enum(['DIPROSES', 'DIKIRIM', 'SELESAI', 'CAIR', 'RETUR']),
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

  const TAHAP = ['DIPROSES', 'DIKIRIM', 'SELESAI', 'CAIR', 'RETUR'];
  const kolom = TAHAP.map((tahap) => {
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
      belumSelesai: rows.filter((r) => !['CAIR', 'RETUR'].includes(r.fulfillment_status)).length,
      nilaiBelumCair: r2(
        rows
          .filter((r) => r.fulfillment_status !== 'CAIR' && r.fulfillment_status !== 'RETUR')
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
  { header: 'Pendapatan Bersih', key: 'net_revenue', width: 16, money: true },
  { header: 'HPP', key: 'cogs', width: 13, money: true },
  { header: 'Laba Kotor', key: 'gross_profit', width: 14, money: true },
  { header: 'Adm. Marketplace', key: 'admin_fee', width: 15, money: true },
  { header: 'Ongkir Ditanggung', key: 'shipping_extra', width: 15, money: true },
  { header: 'Ongkir Ditagih', key: 'shipping_charged', width: 14, money: true },
  { header: 'Voucher Platform', key: 'voucher_platform', width: 15, money: true },
  { header: 'Packing', key: 'packing_cost', width: 11, money: true },
  { header: 'Total Biaya', key: 'total_fees', width: 14, money: true },
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
      rows: rows.map((r) => ({ ...r, channel_label: CHANNEL_LABEL[r.channel] || r.channel })),
      subtitle: `Periode ${from} s/d ${to}`,
      meta: [
        ['Jumlah order', rows.length],
        ['Total pendapatan bersih', r2(rows.reduce((s, r) => s + r.net_revenue, 0))],
        ['Total biaya', r2(rows.reduce((s, r) => s + r.total_fees, 0))],
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
    { header: 'SKU', key: 'sku', width: 16 },
    { header: 'Produk', key: 'product_name', width: 34 },
    { header: 'Jumlah', key: 'qty', width: 10 },
    { header: 'Nilai', key: 'amount', width: 16, money: true },
    { header: 'Alasan', key: 'reason', width: 34 },
  ],
  ambil: (req) => {
    const d = ambilRetur(req);
    return {
      rows: d.rows,
      subtitle: `Periode ${d.from} s/d ${d.to}`,
      meta: [['Jumlah retur', d.rows.length], ['Total nilai retur', d.total]],
    };
  },
});


// ==================================================================
// RETUR PENJUALAN
// ==================================================================
const returnSchema = z.object({
  return_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).default(() => todayLocal()),
  order_id: z.number().int().positive().optional().nullable(),
  product_id: z.number().int().positive(),
  qty: z.number().positive(),
  price: z.number().nonnegative(),
  restock: z.boolean().default(true),
  reason: z.string().max(300).optional().nullable(),
});

const createReturn = db.transaction((body, userId) => {
  const product = db.prepare('SELECT * FROM products WHERE id = ?').get(body.product_id);
  if (!product) throw httpError(404, 'Produk tidak ditemukan');

  const qty = r2(body.qty);
  const amount = r2(qty * body.price);
  const costValue = r2(qty * product.cost);
  const returnNo = nextNumber('RTN', body.return_date.slice(0, 7));

  const info = db
    .prepare(
      `INSERT INTO sales_returns (return_no, return_date, order_id, product_id, qty, price, cost, amount, restock, reason, user_id)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`
    )
    .run(returnNo, body.return_date, body.order_id || null, product.id, qty, r2(body.price), product.cost, amount, body.restock ? 1 : 0, body.reason || null, userId);

  const lines = [
    { code: ACC.SALES_RETURN, debit: amount, credit: 0, memo: `Retur ${product.name}` },
    { code: ACC.CASH, debit: 0, credit: amount, memo: 'Pengembalian dana pelanggan' },
  ];

  if (body.restock) {
    const newStock = r2(product.stock + qty);
    db.prepare('UPDATE products SET stock = ? WHERE id = ?').run(newStock, product.id);
    db.prepare(
      `INSERT INTO stock_moves (product_id, move_date, move_type, qty, unit_cost, balance_after, ref, source, source_id, note, user_id)
       VALUES (?,?,'IN',?,?,?,?, 'RETURN', ?, 'Retur masuk gudang', ?)`
    ).run(product.id, body.return_date, qty, product.cost, newStock, returnNo, info.lastInsertRowid, userId);

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

  return { id: info.lastInsertRowid, return_no: returnNo, amount };
});

router.post('/returns', butuhIzin('penjualan.buat'), ah((req, res) => {
  const body = parse(returnSchema, req.body);
  res.status(201).json({ ok: true, ...createReturn(body, req.user.id) });
}));

/** Pengambil daftar retur — dipakai layar dan berkas unduhan. */
function ambilRetur(req) {
  const { from, to } = dateRange(req.query);

  const kata = String(req.query.q || '').trim();
  const cari = kata.length >= 2
    ? {
        where: '(p.name LIKE ? OR p.sku LIKE ? OR r.reason LIKE ? OR r.return_no LIKE ?)',
        params: Array(4).fill(`%${kata}%`),
      }
    : null;

  const rows = db
    .prepare(
      `SELECT r.*, p.sku, p.name AS product_name
         FROM sales_returns r JOIN products p ON p.id = r.product_id
        WHERE r.return_date BETWEEN ? AND ? ${cari ? `AND ${cari.where}` : ''}
        ORDER BY r.return_date DESC, r.id DESC`
    )
    .all(from, to, ...(cari ? cari.params : []));
  return { from, to, rows, total: r2(rows.reduce((s, r) => s + r.amount, 0)) };
}

router.get('/returns/list', ah((req, res) => res.json(ambilRetur(req))));

module.exports = router;
