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
const { db, nextNumber } = require('../db');
const { requireAuth, butuhIzin } = require('../middleware/auth');
const { ah, parse, httpError, dateRange } = require('../utils/http');
const { r2 } = require('../utils/accounting');
const { daftarkanEkspor } = require('../utils/ekspor');
const { todayLocal } = require('../utils/time');
const { applyMove } = require('./inventory');

const router = express.Router();
router.use(requireAuth);

const tanggal = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

const poSchema = z.object({
  order_date: tanggal.default(() => todayLocal()),
  expected_date: tanggal.optional().nullable(),
  partner_id: z.number().int().positive({ message: 'supplier wajib dipilih' }),
  payment: z.enum(['CASH', 'BANK', 'CREDIT']).default('CREDIT'),
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
      `INSERT INTO purchase_orders (po_no, order_date, expected_date, partner_id, status, payment, note, user_id)
       VALUES (?,?,?,?, 'DIPESAN', ?,?,?)`
    )
    .run(poNo, body.order_date, body.expected_date || null, body.partner_id, body.payment, body.note || null, userId);

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
    total_diterima: r2(items.reduce((s, i) => s + i.qty_received * i.unit_cost, 0)),
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
              (SELECT COALESCE(SUM(i.qty_received * i.unit_cost), 0) FROM purchase_items i WHERE i.po_id = o.id) AS total_diterima,
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
      sisa: r2(o.total - o.total_diterima),
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
        partner_id: po.partner_id,
        ref: po.po_no,
        note: `Penerimaan pesanan pembelian ${po.po_no}`,
      },
      userId
    );

    db.prepare('UPDATE purchase_items SET qty_received = ? WHERE id = ?')
      .run(r2(item.qty_received + l.qty), item.id);
    diterima += 1;
  }

  const items = db.prepare('SELECT qty, qty_received FROM purchase_items WHERE po_id = ?').all(poId);
  const status = hitungStatus(items);
  db.prepare('UPDATE purchase_orders SET status = ? WHERE id = ?').run(status, poId);

  return { diterima, status };
});

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
