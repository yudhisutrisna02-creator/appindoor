'use strict';
/**
 * Pesanan pembelian ke supplier.
 *
 * Mutasi stok sudah bisa mencatat barang masuk, tetapi mutasi hanya tahu apa
 * yang SUDAH datang. Yang tidak terjawab olehnya: barang apa yang sudah dipesan
 * dan belum tiba, sudah berapa lama menunggu, dan berapa nilainya. Pertanyaan
 * itu yang dijawab modul ini.
 *
 * Penerimaan barang tidak menulis stok sendiri — ia memanggil applyMove milik
 * modul gudang, jalur yang sama dengan pencatatan manual. Dengan begitu HPP
 * rata-rata, kartu stok, dan jurnalnya tidak punya versi kedua yang bisa
 * berbeda perilakunya.
 */
const express = require('express');
const { z } = require('zod');
const { db, nextNumber, getSetting } = require('../db');
const { requireAuth, butuhIzin } = require('../middleware/auth');
const { ah, parse, httpError, dateRange } = require('../utils/http');
const { r2 } = require('../utils/accounting');
const { daftarkanEkspor } = require('../utils/ekspor');
const { dokumenPdf, tableCsv } = require('../utils/exporters');
const { blokTtd, KIND } = require('../utils/ttd');
const { isiDokumen } = require('../utils/dokumen');
const { todayLocal } = require('../utils/time');
const { applyMove, koreksiHargaMasuk } = require('./inventory');

const router = express.Router();
router.use(requireAuth);

const tanggal = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

const poSchema = z.object({
  order_date: tanggal.default(() => todayLocal()),
  expected_date: tanggal.optional().nullable(),
  partner_id: z.number().int().positive({ message: 'supplier wajib dipilih' }),
  payment: z.enum(['CASH', 'BANK', 'CREDIT']).default('CREDIT'),
  // Rekening yang dipakai membayar; hanya berlaku bila bukan pembelian tempo.
  cash_code: z.string().trim().min(3).optional().nullable(),
  // Nomor faktur dari supplier. Boleh dikosongkan saat memesan dan diisi
  // belakangan ketika notanya datang — yang dikenali supplier saat ditanya
  // adalah nomor mereka, bukan nomor pesanan yang kita buat sendiri.
  invoice_no: z.string().trim().max(60).optional().nullable(),
  due_date: tanggal.optional().nullable(),
  note: z.string().trim().max(300).optional().nullable(),
  items: z
    .array(
      z.object({
        product_id: z.number().int().positive(),
        qty: z.number().positive('jumlah harus lebih dari 0'),
        unit_cost: z.number().nonnegative().default(0),
      })
    )
    .min(1, 'minimal satu barang'),
});

const STATUS = { DIPESAN: 'Dipesan', SEBAGIAN: 'Diterima sebagian', SELESAI: 'Selesai', BATAL: 'Batal' };

/** Status ditentukan dari jumlah yang sudah diterima, bukan disetel manual. */
function hitungStatus(items) {
  const total = items.reduce((s, i) => s + i.qty, 0);
  const diterima = items.reduce((s, i) => s + i.qty_received, 0);
  if (diterima <= 0) return 'DIPESAN';
  if (diterima >= total - 0.001) return 'SELESAI';
  return 'SEBAGIAN';
}

const buatPO = db.transaction((body, userId) => {
  const supplier = db.prepare('SELECT id FROM partners WHERE id = ?').get(body.partner_id);
  if (!supplier) throw httpError(404, 'Supplier tidak ditemukan');

  const poNo = nextNumber('PO', body.order_date.slice(0, 7));
  const info = db
    .prepare(
      `INSERT INTO purchase_orders
         (po_no, order_date, expected_date, partner_id, status, payment, cash_code,
          invoice_no, due_date, note, user_id)
       VALUES (?,?,?,?, 'DIPESAN', ?,?,?,?,?,?)`
    )
    .run(
      poNo, body.order_date, body.expected_date || null, body.partner_id,
      body.payment, body.cash_code || null, body.invoice_no || null,
      body.due_date || null, body.note || null, userId
    );

  const poId = info.lastInsertRowid;
  const tambah = db.prepare(
    'INSERT INTO purchase_items (po_id, product_id, qty, unit_cost, qty_received) VALUES (?,?,?,?,0)'
  );
  for (const it of body.items) {
    const p = db.prepare('SELECT id FROM products WHERE id = ?').get(it.product_id);
    if (!p) throw httpError(404, `Produk id ${it.product_id} tidak ditemukan`);
    tambah.run(poId, it.product_id, r2(it.qty), r2(it.unit_cost));
  }

  return { id: poId, po_no: poNo };
});

/** Susun satu PO lengkap dengan barisnya. */
function ambilPO(id) {
  const po = db
    .prepare(
      `SELECT o.*, p.name AS supplier_name, u.name AS user_name
         FROM purchase_orders o
         LEFT JOIN partners p ON p.id = o.partner_id
         LEFT JOIN users u ON u.id = o.user_id
        WHERE o.id = ?`
    )
    .get(id);
  if (!po) throw httpError(404, 'Pesanan pembelian tidak ditemukan');

  const items = db
    .prepare(
      `SELECT i.*, pr.sku, pr.name AS product_name, pr.unit, pr.stock,
              (i.qty - i.qty_received) AS qty_sisa,
              (i.qty * i.unit_cost) AS subtotal
         FROM purchase_items i JOIN products pr ON pr.id = i.product_id
        WHERE i.po_id = ? ORDER BY i.id`
    )
    .all(id);

  return {
    ...po,
    status_label: STATUS[po.status] || po.status,
    items,
    total: r2(items.reduce((s, i) => s + i.qty * i.unit_cost, 0)),
    total_diterima: r2(items.reduce((s, i) => s + (i.received_amount || 0), 0)),
    sisa: r2(items.reduce((s, i) => s + (i.qty - i.qty_received) * i.unit_cost, 0)),
  };
}

router.post('/', butuhIzin('pembelian.kelola'), ah((req, res) => {
  const body = parse(poSchema, req.body);
  const hasil = buatPO(body, req.user.id);
  res.status(201).json({
    ok: true,
    message: `Pesanan pembelian ${hasil.po_no} dibuat`,
    po: ambilPO(hasil.id),
  });
}));

/** Daftar PO + ringkasan barang yang masih ditunggu. */
function daftar(req) {
  const { from, to } = dateRange(req.query);
  const params = [from, to];
  let where = 'WHERE o.order_date BETWEEN ? AND ?';
  if (req.query.status) {
    where += ' AND o.status = ?';
    params.push(req.query.status);
  }
  if (req.query.partner_id) {
    where += ' AND o.partner_id = ?';
    params.push(Number(req.query.partner_id));
  }

  const rows = db
    .prepare(
      `SELECT o.*, p.name AS supplier_name, u.name AS user_name,
              (SELECT COUNT(*) FROM purchase_items i WHERE i.po_id = o.id) AS jumlah_barang,
              (SELECT COALESCE(SUM(i.qty * i.unit_cost), 0) FROM purchase_items i WHERE i.po_id = o.id) AS total,
              (SELECT COALESCE(SUM(i.received_amount), 0) FROM purchase_items i WHERE i.po_id = o.id) AS total_diterima,
              -- Nilai yang masih ditunggu dihitung dari barang yang memang belum
              -- datang, bukan sebagai selisih total dikurangi yang sudah diterima.
              -- Sejak harga sisa boleh diperbarui, kedua cara itu tidak lagi sama:
              -- yang sudah diterima memakai harga saat barangnya datang.
              (SELECT COALESCE(SUM((i.qty - i.qty_received) * i.unit_cost), 0)
                 FROM purchase_items i WHERE i.po_id = o.id) AS sisa_nilai,
              CAST(julianday('now') - julianday(o.order_date) AS INTEGER) AS umur_hari
         FROM purchase_orders o
         LEFT JOIN partners p ON p.id = o.partner_id
         LEFT JOIN users u ON u.id = o.user_id
         ${where}
        ORDER BY o.order_date DESC, o.id DESC`
    )
    .all(...params)
    .map((o) => ({
      ...o,
      status_label: STATUS[o.status] || o.status,
      total: r2(o.total),
      total_diterima: r2(o.total_diterima),
      sisa: r2(o.sisa_nilai),
    }));

  const menunggu = rows.filter((o) => o.status === 'DIPESAN' || o.status === 'SEBAGIAN');

  return {
    from, to, rows,
    ringkas: {
      total: rows.length,
      menunggu: menunggu.length,
      nilaiMenunggu: r2(menunggu.reduce((s, o) => s + o.sisa, 0)),
      // Pesanan yang paling lama menggantung: itu yang perlu ditanyakan lebih
      // dulu ke supplier, bukan yang nilainya paling besar.
      terlamaHari: menunggu.length ? Math.max(...menunggu.map((o) => o.umur_hari)) : 0,
    },
  };
}

router.get('/', butuhIzin('pembelian.lihat'), ah((req, res) => res.json(daftar(req))));

// ==================================================================
// MENGUBAH PESANAN
// ==================================================================
/**
 * Barang yang SUDAH diterima tidak bisa diubah dari sini.
 *
 * Penerimaan bukan sekadar catatan: ia sudah menambah stok, sudah menggeser
 * HPP rata-rata produknya, dan sudah membentuk jurnal. Mengubah barang atau
 * harganya di sini tidak akan membatalkan tiga hal itu — yang terjadi hanyalah
 * pesanan menyebut satu angka sementara buku besar menyebut angka lain, dan
 * selisihnya baru ketahuan berbulan-bulan kemudian saat stok dihitung fisik.
 *
 * Yang bisa diubah karena itu:
 *   - seluruh isi pesanan yang barangnya BELUM datang sama sekali;
 *   - harga sisa yang belum datang pada baris yang baru diterima sebagian —
 *     penerimaan berikutnya memang membaca harga terbaru;
 *   - keterangan (tanggal, faktur, catatan) kapan saja.
 *
 * Untuk barang yang sudah telanjur masuk dengan harga keliru, jalurnya sudah
 * ada dan memang membetulkan pembukuannya: Retur Pembelian atau koreksi stok.
 */
const ubahPoSchema = z.object({
  order_date: tanggal,
  expected_date: tanggal.optional().nullable(),
  partner_id: z.number().int().positive({ message: 'supplier wajib dipilih' }),
  payment: z.enum(['CASH', 'BANK', 'CREDIT']),
  cash_code: z.string().trim().min(3).optional().nullable(),
  invoice_no: z.string().trim().max(60).optional().nullable(),
  due_date: tanggal.optional().nullable(),
  note: z.string().trim().max(300).optional().nullable(),
  items: z
    .array(
      z.object({
        // Baris yang sudah ada membawa id-nya; baris baru tidak.
        id: z.number().int().positive().optional().nullable(),
        product_id: z.number().int().positive(),
        qty: z.number().positive('jumlah harus lebih dari 0'),
        unit_cost: z.number().nonnegative().default(0),
      })
    )
    .min(1, 'minimal satu barang'),
});

const ubahPO = db.transaction((poId, body) => {
  const po = db.prepare('SELECT * FROM purchase_orders WHERE id = ?').get(poId);
  if (!po) throw httpError(404, 'Pesanan pembelian tidak ditemukan');
  if (po.status === 'BATAL') throw httpError(409, 'Pesanan sudah dibatalkan');

  const supplier = db.prepare('SELECT id FROM partners WHERE id = ?').get(body.partner_id);
  if (!supplier) throw httpError(404, 'Supplier tidak ditemukan');

  const lama = db.prepare('SELECT * FROM purchase_items WHERE po_id = ?').all(poId);
  const petaLama = new Map(lama.map((i) => [i.id, i]));
  const adaPenerimaan = lama.some((i) => i.qty_received > 0);

  // Cara bayar menentukan akun lawan jurnal saat barang diterima. Mengubahnya
  // setelah ada penerimaan membuat penerimaan berikutnya memakai akun yang
  // berbeda dari yang sebelumnya, di dalam satu pesanan yang sama.
  if (adaPenerimaan && body.payment !== po.payment) {
    throw httpError(
      422,
      'Sebagian barang sudah diterima dan dibukukan — cara bayar tidak bisa diubah lagi.'
    );
  }

  const dipakai = new Set();

  for (const it of body.items) {
    const produk = db.prepare('SELECT id, name FROM products WHERE id = ?').get(it.product_id);
    if (!produk) throw httpError(404, `Produk id ${it.product_id} tidak ditemukan`);

    if (!it.id) continue; // baris baru — tidak ada yang perlu dijaga
    const asal = petaLama.get(it.id);
    if (!asal) throw httpError(404, `Baris ${it.id} bukan bagian dari pesanan ini`);
    dipakai.add(it.id);
    if (asal.qty_received <= 0) continue;

    const namaAsal = db.prepare('SELECT name, unit FROM products WHERE id = ?').get(asal.product_id);

    if (it.product_id !== asal.product_id) {
      throw httpError(
        422,
        `${namaAsal.name}: ${asal.qty_received} ${namaAsal.unit} sudah diterima dan masuk stok, ` +
          'jadi barangnya tidak bisa diganti. Kembalikan lewat Retur Pembelian bila memang keliru.'
      );
    }

    if (r2(it.qty) < r2(asal.qty_received)) {
      throw httpError(
        422,
        `${namaAsal.name}: sudah diterima ${asal.qty_received} ${namaAsal.unit}, ` +
          `jumlah pesanan tidak bisa diturunkan menjadi ${it.qty}.`
      );
    }

    const sisa = r2(asal.qty - asal.qty_received);
    if (r2(it.unit_cost) !== r2(asal.unit_cost) && sisa <= 0) {
      throw httpError(
        422,
        `${namaAsal.name}: seluruhnya sudah diterima dengan harga ` +
          `Rp ${asal.unit_cost.toLocaleString('id-ID')} dan sudah masuk HPP. ` +
          'Harganya tidak bisa diubah dari sini — pakai Retur Pembelian atau koreksi stok.'
      );
    }
  }

  // Baris yang dihapus dari formulir: hanya boleh bila belum ada yang datang.
  for (const asal of lama) {
    if (dipakai.has(asal.id)) continue;
    if (asal.qty_received > 0) {
      const p = db.prepare('SELECT name, unit FROM products WHERE id = ?').get(asal.product_id);
      throw httpError(
        422,
        `${p.name}: ${asal.qty_received} ${p.unit} sudah diterima, barisnya tidak bisa dihapus.`
      );
    }
    db.prepare('DELETE FROM purchase_items WHERE id = ?').run(asal.id);
  }

  db.prepare(
    `UPDATE purchase_orders
        SET order_date = ?, expected_date = ?, partner_id = ?, payment = ?, cash_code = ?,
            invoice_no = ?, due_date = ?, note = ?
      WHERE id = ?`
  ).run(
    body.order_date, body.expected_date || null, body.partner_id,
    body.payment, body.cash_code || null, body.invoice_no || null,
    body.due_date || null, body.note || null, poId
  );

  const perbarui = db.prepare(
    'UPDATE purchase_items SET product_id = ?, qty = ?, unit_cost = ? WHERE id = ?'
  );
  const tambah = db.prepare(
    'INSERT INTO purchase_items (po_id, product_id, qty, unit_cost, qty_received) VALUES (?,?,?,?,0)'
  );

  for (const it of body.items) {
    if (it.id) perbarui.run(it.product_id, r2(it.qty), r2(it.unit_cost), it.id);
    else tambah.run(poId, it.product_id, r2(it.qty), r2(it.unit_cost));
  }

  // Status selalu dihitung ulang, tidak disetel manual: menambah baris baru
  // pada pesanan yang sudah "Selesai" mengembalikannya menjadi "Sebagian".
  const items = db.prepare('SELECT qty, qty_received FROM purchase_items WHERE po_id = ?').all(poId);
  db.prepare('UPDATE purchase_orders SET status = ? WHERE id = ?').run(hitungStatus(items), poId);

  return { adaPenerimaan };
});

router.put('/:id(\\d+)', butuhIzin('pembelian.kelola'), ah((req, res) => {
  const id = Number(req.params.id);
  const body = parse(ubahPoSchema, req.body);
  const hasil = ubahPO(id, body);
  const po = ambilPO(id);

  res.json({
    ok: true,
    po,
    message: hasil.adaPenerimaan
      ? `Pesanan ${po.po_no} diperbarui — perubahan harga hanya berlaku untuk barang yang belum datang`
      : `Pesanan ${po.po_no} diperbarui`,
  });
}));

router.get('/:id(\\d+)', butuhIzin('pembelian.lihat'), ah((req, res) => {
  res.json({ po: ambilPO(Number(req.params.id)) });
}));

const terimaSchema = z.object({
  receive_date: tanggal.default(() => todayLocal()),
  lines: z
    .array(z.object({ item_id: z.number().int().positive(), qty: z.number().positive() }))
    .min(1, 'tidak ada barang yang diterima'),
});

/**
 * Terima barang, sebagian atau seluruhnya.
 *
 * Jumlah yang diterima tidak boleh melebihi sisa pesanan: kelebihan kiriman
 * lebih baik dicatat sebagai mutasi tersendiri agar ketahuan, bukan diam-diam
 * menambah pesanan yang sudah disepakati.
 */
const terimaBarang = db.transaction((poId, body, userId) => {
  const po = db.prepare('SELECT * FROM purchase_orders WHERE id = ?').get(poId);
  if (!po) throw httpError(404, 'Pesanan pembelian tidak ditemukan');
  if (po.status === 'BATAL') throw httpError(409, 'Pesanan sudah dibatalkan');
  if (po.status === 'SELESAI') throw httpError(409, 'Pesanan sudah diterima seluruhnya');

  let diterima = 0;
  for (const l of body.lines) {
    const item = db.prepare('SELECT * FROM purchase_items WHERE id = ? AND po_id = ?').get(l.item_id, poId);
    if (!item) throw httpError(404, `Baris ${l.item_id} bukan bagian dari pesanan ini`);

    const sisa = r2(item.qty - item.qty_received);
    if (l.qty > sisa + 0.001) {
      const p = db.prepare('SELECT name, unit FROM products WHERE id = ?').get(item.product_id);
      throw httpError(422, `${p.name}: sisa pesanan hanya ${sisa} ${p.unit}, tidak bisa menerima ${l.qty}`);
    }

    // Jalur yang sama dengan pencatatan stok manual — stok, HPP rata-rata, dan
    // jurnalnya ditangani di satu tempat saja.
    applyMove(
      {
        product_id: item.product_id,
        move_date: body.receive_date,
        move_type: 'IN',
        qty: r2(l.qty),
        unit_cost: r2(item.unit_cost),
        payment: po.payment,
        cash_code: po.cash_code || null,
        partner_id: po.partner_id,
        ref: po.po_no,
        note: `Penerimaan pesanan pembelian ${po.po_no}`,
      },
      userId
    );

    // Nilai yang benar-benar dibukukan dicatat terpisah dari qty × harga
    // pesanan: harga sisa yang belum datang masih boleh berubah setelah ini.
    db.prepare('UPDATE purchase_items SET qty_received = ?, received_amount = ? WHERE id = ?')
      .run(
        r2(item.qty_received + l.qty),
        r2((item.received_amount || 0) + l.qty * item.unit_cost),
        item.id
      );
    diterima += 1;
  }

  const items = db.prepare('SELECT qty, qty_received FROM purchase_items WHERE po_id = ?').all(poId);
  const status = hitungStatus(items);
  db.prepare('UPDATE purchase_orders SET status = ? WHERE id = ?').run(status, poId);

  return { diterima, status };
});

// ==================================================================
// BARANG MASUK LAMA → PESANAN PEMBELIAN
// ==================================================================
const dariMasukSchema = z.object({
  move_id: z.number().int().positive(),
  order_date: tanggal.optional().nullable(),
  // Harga per unit dari pabrik dan ongkos kirim total. Kosong = harga tetap.
  unit_cost: z.number().nonnegative().optional().nullable(),
  biaya_tambahan: z.number().nonnegative().default(0),
  invoice_no: z.string().trim().max(60).optional().nullable(),
  note: z.string().trim().max(300).optional().nullable(),
});

/**
 * POST /api/pembelian/dari-barang-masuk — menjadikan barang masuk yang dulu
 * dicatat lewat Mutasi Stok (misalnya hasil impor) sebagai pesanan pembelian.
 *
 * Stoknya TIDAK bertambah lagi: mutasi dan jurnalnya yang sudah ada dipakai
 * sebagai penerimaan pesanan itu. Yang terjadi hanyalah pesanan berstatus
 * Selesai dibuat untuk supplier-nya, mutasinya diberi nomor pesanan, dan —
 * bila harganya ikut dibetulkan — nilai, utang, dan HPP-nya disesuaikan lewat
 * jalur yang sama dengan tombol Harga di Mutasi Stok.
 */
router.post('/dari-barang-masuk', butuhIzin('pembelian.kelola'), ah((req, res) => {
  const body = parse(dariMasukSchema, req.body);
  const m = db.prepare('SELECT * FROM stock_moves WHERE id = ?').get(body.move_id);
  if (!m) throw httpError(404, 'Mutasi tidak ditemukan');
  if (m.move_type !== 'IN' || m.source !== 'MANUAL') {
    throw httpError(422, 'Yang bisa dijadikan pesanan hanya barang masuk yang dicatat lewat Mutasi Stok');
  }
  if (String(m.ref || '').startsWith('PO/')) {
    throw httpError(409, `Barang masuk ini sudah tercatat sebagai ${m.ref}`);
  }
  if (!m.partner_id) {
    throw httpError(422, 'Barang masuk ini tidak mencatat supplier-nya — tidak bisa dijadikan pesanan');
  }
  const produk = db.prepare('SELECT * FROM products WHERE id = ?').get(m.product_id);
  const j = db.prepare("SELECT * FROM journals WHERE source = 'STOCK' AND source_id = ?").get(m.id);
  const barisLawan = j
    ? db.prepare(
        `SELECT l.*, a.subtype, a.is_cash, a.code FROM journal_lines l JOIN accounts a ON a.id = l.account_id
          WHERE l.journal_id = ? AND l.credit > 0`
      ).get(j.id)
    : null;
  const payment = barisLawan && barisLawan.subtype === 'PAYABLE' ? 'CREDIT' : barisLawan && barisLawan.is_cash ? 'BANK' : 'CREDIT';

  const hasil = db.transaction(() => {
    let harga = null;
    const ubahHarga = body.unit_cost !== null && body.unit_cost !== undefined
      && Math.abs(r2(m.qty * body.unit_cost + body.biaya_tambahan) - r2(m.qty * m.unit_cost)) >= 0.01;
    if (ubahHarga) {
      harga = koreksiHargaMasuk(m.id, {
        unit_cost: body.unit_cost,
        biaya_tambahan: body.biaya_tambahan,
        alasan: body.note || 'Harga dibetulkan saat dijadikan pesanan pembelian',
      }, req.user.id);
    }
    const kini = db.prepare('SELECT * FROM stock_moves WHERE id = ?').get(m.id);
    const tglPesan = body.order_date || m.move_date;
    const poNo = nextNumber('PO', tglPesan.slice(0, 7));
    const catatanHarga = body.biaya_tambahan
      ? `Harga pabrik Rp ${Number(body.unit_cost).toLocaleString('id-ID')} + ongkir Rp ${body.biaya_tambahan.toLocaleString('id-ID')}`
      : null;
    const info = db
      .prepare(
        `INSERT INTO purchase_orders
           (po_no, order_date, partner_id, status, payment, cash_code, invoice_no, note, user_id)
         VALUES (?,?,?, 'SELESAI', ?,?,?,?,?)`
      )
      .run(
        poNo, tglPesan, m.partner_id, payment,
        payment === 'CREDIT' ? null : barisLawan.code,
        body.invoice_no || null,
        [body.note, catatanHarga, `Dari barang masuk ${m.move_date}${m.ref ? ` (${m.ref})` : ''}`]
          .filter(Boolean).join(' · ').slice(0, 300),
        req.user.id
      );
    db.prepare(
      `INSERT INTO purchase_items (po_id, product_id, qty, unit_cost, qty_received, received_amount)
       VALUES (?,?,?,?,?,?)`
    ).run(info.lastInsertRowid, m.product_id, m.qty, kini.unit_cost, m.qty, r2(m.qty * kini.unit_cost));
    db.prepare(
      `UPDATE stock_moves
          SET ref = ?, note = TRIM(COALESCE(note, '') || ' · Penerimaan pesanan pembelian ' || ?)
        WHERE id = ?`
    ).run(poNo, poNo, m.id);
    return { id: info.lastInsertRowid, po_no: poNo, harga };
  })();

  const po = ambilPO(hasil.id);
  res.status(201).json({
    ok: true,
    po,
    harga: hasil.harga,
    message:
      `${po.po_no} dibuat untuk ${po.supplier_name}: ${m.qty} ${produk.unit} ${produk.name}, ` +
      `Rp ${po.total.toLocaleString('id-ID')}` +
      (hasil.harga ? ` (harga dibetulkan dari Rp ${hasil.harga.nilaiLama.toLocaleString('id-ID')})` : '') +
      '. Stok tidak bertambah lagi.',
  });
}));

router.post('/:id(\\d+)/terima', butuhIzin('pembelian.kelola'), ah((req, res) => {
  const body = parse(terimaSchema, req.body);
  const hasil = terimaBarang(Number(req.params.id), body, req.user.id);
  res.json({
    ok: true,
    message: `${hasil.diterima} barang diterima — pesanan kini ${STATUS[hasil.status] || hasil.status}`,
    po: ambilPO(Number(req.params.id)),
  });
}));

/**
 * Membatalkan pesanan.
 *
 * Hanya boleh selama belum ada barang yang diterima. Setelah barang masuk,
 * stok dan jurnalnya sudah terbentuk; membatalkan pesanannya akan menyisakan
 * mutasi stok tanpa dokumen yang menjelaskannya.
 */
// ==================================================================
// NOTA PEMBAYARAN KE SUPPLIER
// ==================================================================
const notaSchema = z.object({
  invoice_no: z.string().trim().max(60).optional().nullable(),
  due_date: tanggal.optional().nullable(),
  paid_date: tanggal.optional().nullable(),
});

/**
 * Mencatat nomor faktur supplier dan tanggal pembayarannya.
 *
 * Sengaja tidak menyentuh jurnal. Pembukuan pembelian sudah terbentuk saat
 * barang diterima; yang dicatat di sini hanya keterangan administratif supaya
 * notanya bisa dicetak dan ditelusuri. Membuat jurnal kedua dari sini akan
 * membukukan pembelian yang sama dua kali.
 */
router.patch('/:id(\\d+)/nota', butuhIzin('pembelian.kelola'), ah((req, res) => {
  const id = Number(req.params.id);
  const po = db.prepare('SELECT * FROM purchase_orders WHERE id = ?').get(id);
  if (!po) throw httpError(404, 'Pesanan pembelian tidak ditemukan');

  const body = parse(notaSchema, req.body);

  if (body.invoice_no) {
    const kembar = db
      .prepare('SELECT po_no FROM purchase_orders WHERE invoice_no = ? AND id <> ?')
      .get(body.invoice_no, id);
    // Satu nomor faktur dipakai dua kali biasanya berarti pembayaran ganda —
    // persis kesalahan yang paling mahal dan paling sulit ditemukan kembali.
    if (kembar) {
      throw httpError(409, `Nomor faktur ${body.invoice_no} sudah dipakai pesanan ${kembar.po_no}`);
    }
  }

  db.prepare(
    'UPDATE purchase_orders SET invoice_no = ?, due_date = ?, paid_date = ? WHERE id = ?'
  ).run(
    body.invoice_no === undefined ? po.invoice_no : body.invoice_no || null,
    body.due_date === undefined ? po.due_date : body.due_date || null,
    body.paid_date === undefined ? po.paid_date : body.paid_date || null,
    id
  );

  res.json({ ok: true, po: ambilPO(id), message: 'Keterangan nota disimpan' });
}));

const BAYAR = {
  CASH: 'Tunai',
  BANK: 'Transfer bank',
  CREDIT: 'Tempo (belum dibayar saat pemesanan)',
};

/** Kolom nota — dipakai bersama oleh PDF dan CSV supaya isinya tidak berbeda. */
const KOLOM_NOTA = [
  { header: 'SKU', key: 'sku', width: 16 },
  { header: 'Barang', key: 'product_name', width: 40 },
  { header: 'Jumlah', key: 'qty', width: 10 },
  { header: 'Satuan', key: 'unit', width: 10 },
  { header: 'Harga Satuan', key: 'unit_cost', width: 16, money: true },
  { header: 'Subtotal', key: 'subtotal', width: 16, money: true },
];

/** Nota satu pesanan pembelian, siap dicetak. */
function notaDari(po, ttd) {
  const sudahDibayar = !!po.paid_date;
  const supplier = po.partner_id
    ? db.prepare('SELECT * FROM partners WHERE id = ?').get(po.partner_id)
    : null;

  return {
    judul: 'NOTA PEMBAYARAN SUPPLIER',
    // Status pesanannya sudah muncul di blok penerimaan barang; yang berguna di
    // kepala lembar justru kapan lembar itu dicetak.
    subjudul: `Dicetak ${todayLocal()}`,
    nomor: po.invoice_no ? `Faktur No. ${po.invoice_no}` : 'Faktur supplier belum dicatat',
    meta: [
      ['No. pesanan', po.po_no],
      ['Tanggal pesan', po.order_date],
      ['Jatuh tempo', po.due_date || '-'],
      ['Cara bayar', BAYAR[po.payment] || po.payment],
      ['Dibayar', po.paid_date || 'belum'],
    ],
    pihak: [
      {
        judul: 'KEPADA (SUPPLIER)',
        nama: po.supplier_name || 'Supplier belum dipilih',
        baris: supplier
          ? [supplier.phone, supplier.email, supplier.address].filter(Boolean)
          : [],
      },
      {
        judul: 'PENERIMAAN BARANG',
        nama: po.status_label,
        baris: [
          `Dipesan ${po.items.reduce((s, i) => s + i.qty, 0)} unit`,
          `Diterima ${po.items.reduce((s, i) => s + i.qty_received, 0)} unit`,
          po.expected_date ? `Perkiraan datang ${po.expected_date}` : null,
        ].filter(Boolean),
      },
    ],
    kolom: KOLOM_NOTA,
    rows: po.items.map((i) => ({
      sku: i.sku,
      product_name: i.product_name,
      qty: i.qty,
      unit: i.unit,
      unit_cost: r2(i.unit_cost),
      subtotal: r2(i.qty * i.unit_cost),
    })),
    ringkas: [
      ['Nilai pesanan', po.total],
      ['Sudah diterima', po.total_diterima],
      ...(po.total_diterima < po.total ? [['Belum diterima', r2(po.total - po.total_diterima)]] : []),
      [sudahDibayar ? 'TOTAL DIBAYAR' : 'TOTAL TAGIHAN', po.total, true],
    ],
    catatan: [
      po.note || null,
      sudahDibayar
        ? `Dibayar pada ${po.paid_date} secara ${(BAYAR[po.payment] || po.payment).toLowerCase()}.`
        : 'Nota ini belum ditandai lunas. Simpan bukti transfer sebagai lampiran.',
      'Nilai pada nota mengikuti harga pesanan; pembukuan persediaan mengikuti barang yang benar-benar diterima.',
    ].filter(Boolean).join('\n'),
    // Yang menyetujui adalah sistemnya: nota ini disusun dari pesanan yang sudah
    // tercatat, bukan diketik ulang. Sisi supplier tetap garis kosong.
    tandaTangan: [
      ttd || { label: 'Disetujui oleh', nama: '' },
      { label: 'Diterima supplier', nama: po.supplier_name || '' },
    ],
  };
}

const namaNota = (po) =>
  `nota-${String(po.invoice_no || po.po_no).toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;

router.get('/:id(\\d+)/nota/pdf', butuhIzin('pembelian.lihat'), ah(async (req, res) => {
  const po = ambilPO(Number(req.params.id));
  const ttd = await blokTtd({
    req,
    kind: KIND.NOTA_SUPPLIER,
    refId: po.id,
    docNo: po.invoice_no || po.po_no,
    isi: isiDokumen({ kind: KIND.NOTA_SUPPLIER, ref_id: po.id }).kanonik,
    userId: req.user && req.user.id,
    label: 'Disetujui oleh',
  });
  const buffer = await dokumenPdf(notaDari(po, ttd), {
    perusahaan: getSetting('company_name', 'Perusahaan'),
  });
  res.setHeader('Content-Type', 'application/pdf');
  // inline supaya bisa langsung dibuka dan dicetak dari peramban.
  res.setHeader('Content-Disposition', `inline; filename="${namaNota(po)}.pdf"`);
  res.send(buffer);
}));

router.get('/:id(\\d+)/nota/csv', butuhIzin('pembelian.lihat'), ah((req, res) => {
  const po = ambilPO(Number(req.params.id));
  const nota = notaDari(po);

  // Keterangan nota ikut sebagai kolom pada tiap baris. Berkas CSV sering
  // digabung dengan berkas lain di pembukuan, dan baris yang kehilangan nomor
  // fakturnya tidak bisa ditelusuri kembali ke mana pun.
  const kolom = [
    { header: 'No. Faktur', key: 'invoice_no', width: 20 },
    { header: 'No. Pesanan', key: 'po_no', width: 20 },
    { header: 'Tanggal', key: 'order_date', width: 12 },
    { header: 'Jatuh Tempo', key: 'due_date', width: 12 },
    { header: 'Supplier', key: 'supplier', width: 24 },
    { header: 'Status', key: 'status', width: 14 },
    { header: 'Dibayar', key: 'paid_date', width: 12 },
    ...KOLOM_NOTA,
    { header: 'Diterima', key: 'qty_received', width: 10 },
  ];

  const rows = po.items.map((i) => ({
    invoice_no: po.invoice_no || '',
    po_no: po.po_no,
    order_date: po.order_date,
    due_date: po.due_date || '',
    supplier: po.supplier_name || '',
    status: po.status_label,
    paid_date: po.paid_date || '',
    sku: i.sku,
    product_name: i.product_name,
    qty: i.qty,
    unit: i.unit,
    unit_cost: r2(i.unit_cost),
    subtotal: r2(i.qty * i.unit_cost),
    qty_received: i.qty_received,
  }));

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${namaNota(po)}.csv"`);
  res.send(tableCsv(kolom, rows));
}));

router.patch('/:id(\\d+)/batal', butuhIzin('pembelian.kelola'), ah((req, res) => {
  const po = db.prepare('SELECT * FROM purchase_orders WHERE id = ?').get(req.params.id);
  if (!po) throw httpError(404, 'Pesanan pembelian tidak ditemukan');
  if (po.status === 'BATAL') throw httpError(409, 'Pesanan sudah dibatalkan');

  const sudah = db
    .prepare('SELECT COALESCE(SUM(qty_received), 0) AS n FROM purchase_items WHERE po_id = ?')
    .get(po.id).n;
  if (sudah > 0) {
    throw httpError(
      422,
      'Sebagian barang sudah diterima — pesanan tidak bisa dibatalkan. ' +
        'Kembalikan barangnya lewat Mutasi Stok bila memang perlu.'
    );
  }

  db.prepare("UPDATE purchase_orders SET status = 'BATAL' WHERE id = ?").run(po.id);
  res.json({ ok: true, message: `Pesanan ${po.po_no} dibatalkan` });
}));

daftarkanEkspor(router, {
  path: '/',
  judul: 'Pesanan Pembelian',
  kolom: [
    { header: 'No. PO', key: 'po_no', width: 20 },
    { header: 'Tanggal', key: 'order_date', width: 12 },
    { header: 'Perkiraan Tiba', key: 'expected_date', width: 14 },
    { header: 'Supplier', key: 'supplier_name', width: 26 },
    { header: 'Status', key: 'status_label', width: 18 },
    { header: 'Jenis Barang', key: 'jumlah_barang', width: 13 },
    { header: 'Nilai Pesanan', key: 'total', width: 18, money: true },
    { header: 'Sudah Diterima', key: 'total_diterima', width: 18, money: true },
    { header: 'Sisa', key: 'sisa', width: 18, money: true },
    { header: 'Umur (hari)', key: 'umur_hari', width: 12 },
    { header: 'Catatan', key: 'note', width: 30 },
  ],
  ambil: (req) => {
    const d = daftar(req);
    return {
      rows: d.rows,
      subtitle: `Periode ${d.from} s/d ${d.to}`,
      meta: [
        ['Jumlah pesanan', d.ringkas.total],
        ['Masih ditunggu', d.ringkas.menunggu],
        ['Nilai yang ditunggu', d.ringkas.nilaiMenunggu],
      ],
    };
  },
});

module.exports = router;
// Dipakai ulang oleh Pusat Perhatian supaya angka peringatannya tidak pernah
// berbeda dari angka yang tampil di menu ini sendiri.
module.exports.daftar = daftar;
