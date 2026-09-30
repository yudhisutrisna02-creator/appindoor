'use strict';
/**
 * Pre-order / booking stok ke pabrik.
 *
 * Booking mengunci jumlah barang di pabrik supplier — misalnya 1.500 kg
 * Tricoderma — tanpa barangnya berpindah dan tanpa utang. Barang lalu
 * "dipanggil" sebagian demi sebagian (500 kg dulu); setiap panggilan menjadi
 * pesanan pembelian biasa, dan barulah penerimaannya yang menambah stok serta
 * membentuk utang/pembayaran.
 *
 * Tiga angka yang dipantau per barang:
 *   - sisa di pabrik     = dibooking − sudah dipanggil
 *   - dalam perjalanan   = sudah dipanggil − sudah diterima
 *   - sudah diterima     = masuk gudang lewat penerimaan pesanan
 *
 * Tidak ada jurnal di modul ini — booking bukan transaksi keuangan. Yang
 * dibukukan tetap hanya pesanan pembelian dan penerimaannya.
 */
const express = require('express');
const { z } = require('zod');
const { db, nextNumber } = require('../db');
const { requireAuth, butuhIzin } = require('../middleware/auth');
const { ah, parse, httpError } = require('../utils/http');
const { r2 } = require('../utils/accounting');
const { todayLocal } = require('../utils/time');
const pembelian = require('./pembelian');

const router = express.Router();
router.use(requireAuth);

const tanggal = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const STATUS = { AKTIF: 'Aktif', SELESAI: 'Habis dipanggil', BATAL: 'Batal' };

/** Jumlah yang sudah diterima gudang dari baris booking, lewat pesanan yang tidak batal. */
const SQL_DITERIMA = `
  SELECT COALESCE(SUM(pi.qty_received), 0)
    FROM purchase_items pi JOIN purchase_orders po ON po.id = pi.po_id
   WHERE pi.booking_item_id = bi.id AND po.status <> 'BATAL'`;

function ambilBooking(id) {
  const b = db
    .prepare(
      `SELECT b.*, p.name AS supplier_name, p.phone AS supplier_phone
         FROM purchase_bookings b JOIN partners p ON p.id = b.partner_id
        WHERE b.id = ?`
    )
    .get(id);
  if (!b) throw httpError(404, 'Booking tidak ditemukan');

  const items = db
    .prepare(
      `SELECT bi.*, pr.sku, pr.name AS product_name, pr.unit, (${SQL_DITERIMA}) AS qty_received
         FROM purchase_booking_items bi JOIN products pr ON pr.id = bi.product_id
        WHERE bi.booking_id = ? ORDER BY bi.id`
    )
    .all(id)
    .map((i) => ({
      ...i,
      sisa_pabrik: r2(i.qty - i.qty_called),
      dalam_perjalanan: r2(i.qty_called - i.qty_received),
      nilai: r2(i.qty * i.unit_cost),
    }));

  const pesanan = db
    .prepare(
      `SELECT DISTINCT po.id, po.po_no, po.order_date, po.status,
              (SELECT COALESCE(SUM(x.qty), 0) FROM purchase_items x
                WHERE x.po_id = po.id AND x.booking_item_id IN
                  (SELECT id FROM purchase_booking_items WHERE booking_id = ?)) AS qty
         FROM purchase_orders po JOIN purchase_items pi ON pi.po_id = po.id
         JOIN purchase_booking_items bi ON bi.id = pi.booking_item_id
        WHERE bi.booking_id = ?
        ORDER BY po.order_date DESC, po.id DESC`
    )
    .all(id, id)
    .map((x) => ({ ...x, status_label: pembelian.STATUS[x.status] || x.status }));

  return {
    ...b,
    status_label: STATUS[b.status] || b.status,
    items,
    pesanan,
    total: r2(items.reduce((s, i) => s + i.nilai, 0)),
    kadaluarsa: !!(b.valid_until && b.valid_until < todayLocal() && b.status === 'AKTIF'),
  };
}

/** GET /api/booking — daftar booking beserta kemajuannya. */
router.get('/', butuhIzin('pembelian.lihat'), ah((req, res) => {
  const params = [];
  let where = 'WHERE 1=1';
  if (req.query.status) { where += ' AND b.status = ?'; params.push(req.query.status); }
  if (req.query.q) {
    where += ' AND (b.booking_no LIKE ? OR p.name LIKE ?)';
    params.push(`%${req.query.q}%`, `%${req.query.q}%`);
  }

  const rows = db
    .prepare(
      `SELECT b.*, p.name AS supplier_name,
              (SELECT COALESCE(SUM(qty), 0) FROM purchase_booking_items WHERE booking_id = b.id) AS qty,
              (SELECT COALESCE(SUM(qty_called), 0) FROM purchase_booking_items WHERE booking_id = b.id) AS qty_called,
              (SELECT COALESCE(SUM(qty * unit_cost), 0) FROM purchase_booking_items WHERE booking_id = b.id) AS total,
              (SELECT COUNT(*) FROM purchase_booking_items WHERE booking_id = b.id) AS jumlah_barang
         FROM purchase_bookings b JOIN partners p ON p.id = b.partner_id
         ${where}
        ORDER BY CASE b.status WHEN 'AKTIF' THEN 0 WHEN 'SELESAI' THEN 1 ELSE 2 END,
                 b.booking_date DESC, b.id DESC
        LIMIT 500`
    )
    .all(...params)
    .map((b) => ({
      ...b,
      status_label: STATUS[b.status] || b.status,
      sisa_pabrik: r2(b.qty - b.qty_called),
      persen: b.qty > 0 ? Math.round((b.qty_called / b.qty) * 100) : 0,
      kadaluarsa: !!(b.valid_until && b.valid_until < todayLocal() && b.status === 'AKTIF'),
    }));

  res.json({ rows });
}));

/**
 * GET /api/booking/stok-pabrik — stok kita yang masih tersimpan di pabrik.
 *
 * Satu baris per barang per supplier, dari seluruh booking yang masih aktif.
 * Dalam perjalanan dihitung dari semua booking (termasuk yang sudah habis
 * dipanggil), karena barang yang sudah dipanggil tetap sedang ditunggu.
 */
router.get('/stok-pabrik', butuhIzin('pembelian.lihat'), ah((req, res) => {
  const rows = db
    .prepare(
      `SELECT pr.id AS product_id, pr.sku, pr.name AS product_name, pr.unit, pr.stock,
              p.id AS partner_id, p.name AS supplier_name,
              SUM(CASE WHEN b.status = 'AKTIF' THEN bi.qty ELSE 0 END) AS dibooking,
              SUM(CASE WHEN b.status = 'AKTIF' THEN bi.qty_called ELSE 0 END) AS dipanggil,
              SUM(CASE WHEN b.status = 'AKTIF' THEN bi.qty - bi.qty_called ELSE 0 END) AS sisa_pabrik,
              SUM(CASE WHEN b.status <> 'BATAL' THEN bi.qty_called - (${SQL_DITERIMA}) ELSE 0 END) AS dalam_perjalanan,
              MIN(CASE WHEN b.status = 'AKTIF' THEN b.valid_until END) AS berlaku_sampai,
              COUNT(DISTINCT CASE WHEN b.status = 'AKTIF' THEN b.id END) AS jumlah_booking
         FROM purchase_booking_items bi
         JOIN purchase_bookings b ON b.id = bi.booking_id
         JOIN products pr ON pr.id = bi.product_id
         JOIN partners p ON p.id = b.partner_id
        GROUP BY pr.id, p.id
       HAVING sisa_pabrik > 0.0001 OR dalam_perjalanan > 0.0001
        ORDER BY sisa_pabrik DESC`
    )
    .all()
    .map((r) => ({
      ...r,
      dibooking: r2(r.dibooking),
      dipanggil: r2(r.dipanggil),
      sisa_pabrik: r2(r.sisa_pabrik),
      dalam_perjalanan: r2(r.dalam_perjalanan),
      stok_gudang: r2(r.stock),
      // Total yang bisa diandalkan: di gudang + di jalan + masih di pabrik.
      total_tersedia: r2(r.stock + r.dalam_perjalanan + r.sisa_pabrik),
      kadaluarsa: !!(r.berlaku_sampai && r.berlaku_sampai < todayLocal()),
    }));

  res.json({
    rows,
    ringkas: {
      barang: rows.length,
      sisa_pabrik: r2(rows.reduce((s, r) => s + r.sisa_pabrik, 0)),
      dalam_perjalanan: r2(rows.reduce((s, r) => s + r.dalam_perjalanan, 0)),
    },
  });
}));

router.get('/:id(\\d+)', butuhIzin('pembelian.lihat'), ah((req, res) => {
  res.json({ booking: ambilBooking(Number(req.params.id)) });
}));

const barisSchema = z.object({
  id: z.number().int().positive().optional().nullable(),
  product_id: z.number().int().positive(),
  qty: z.number().positive('jumlah booking harus lebih dari 0'),
  unit_cost: z.number().nonnegative().default(0),
});

const bookingSchema = z.object({
  partner_id: z.number().int().positive({ message: 'supplier wajib dipilih' }),
  booking_date: tanggal.default(() => todayLocal()),
  valid_until: tanggal.optional().nullable(),
  note: z.string().trim().max(300).optional().nullable(),
  items: z.array(barisSchema).min(1, 'minimal satu barang'),
});

function periksaMitraProduk(body) {
  if (!db.prepare('SELECT id FROM partners WHERE id = ?').get(body.partner_id)) {
    throw httpError(404, 'Supplier tidak ditemukan');
  }
  for (const it of body.items) {
    if (!db.prepare('SELECT id FROM products WHERE id = ?').get(it.product_id)) {
      throw httpError(404, `Produk id ${it.product_id} tidak ditemukan`);
    }
  }
  if (body.valid_until && body.valid_until < body.booking_date) {
    throw httpError(422, 'Tanggal berlaku tidak boleh sebelum tanggal booking');
  }
}

/** POST /api/booking — booking baru ke pabrik. */
router.post('/', butuhIzin('pembelian.kelola'), ah((req, res) => {
  const body = parse(bookingSchema, req.body);
  periksaMitraProduk(body);

  const id = db.transaction(() => {
    const no = nextNumber('PB', body.booking_date.slice(0, 7));
    const info = db
      .prepare(
        `INSERT INTO purchase_bookings (booking_no, booking_date, valid_until, partner_id, note, user_id)
         VALUES (?,?,?,?,?,?)`
      )
      .run(no, body.booking_date, body.valid_until || null, body.partner_id, body.note || null, req.user.id);
    const tambah = db.prepare(
      'INSERT INTO purchase_booking_items (booking_id, product_id, qty, unit_cost) VALUES (?,?,?,?)'
    );
    for (const it of body.items) tambah.run(info.lastInsertRowid, it.product_id, r2(it.qty), r2(it.unit_cost));
    return info.lastInsertRowid;
  })();

  const b = ambilBooking(id);
  res.status(201).json({ ok: true, booking: b, message: `Booking ${b.booking_no} tersimpan — stok terkunci di pabrik` });
}));

/**
 * PUT /api/booking/:id — mengubah booking.
 *
 * Jumlah tidak boleh diturunkan di bawah yang sudah dipanggil, dan barang yang
 * sudah pernah dipanggil tidak bisa diganti atau dihapus — pesanan yang
 * memanggilnya menunjuk ke baris itu.
 */
router.put('/:id(\\d+)', butuhIzin('pembelian.kelola'), ah((req, res) => {
  const body = parse(bookingSchema, req.body);
  const id = Number(req.params.id);
  periksaMitraProduk(body);

  db.transaction(() => {
    const b = db.prepare('SELECT * FROM purchase_bookings WHERE id = ?').get(id);
    if (!b) throw httpError(404, 'Booking tidak ditemukan');
    if (b.status === 'BATAL') throw httpError(409, 'Booking sudah dibatalkan');

    const lama = new Map(
      db.prepare('SELECT * FROM purchase_booking_items WHERE booking_id = ?').all(id).map((i) => [i.id, i])
    );
    const adaPanggilan = [...lama.values()].some((i) => i.qty_called > 0);
    if (adaPanggilan && body.partner_id !== b.partner_id) {
      throw httpError(422, 'Sebagian barang sudah dipanggil — supplier booking tidak bisa diganti');
    }

    const dipakai = new Set();
    for (const it of body.items) {
      if (!it.id) continue;
      const asal = lama.get(it.id);
      if (!asal) throw httpError(404, `Baris ${it.id} bukan bagian dari booking ini`);
      dipakai.add(it.id);
      const pr = db.prepare('SELECT name, unit FROM products WHERE id = ?').get(asal.product_id);
      if (asal.qty_called > 0 && it.product_id !== asal.product_id) {
        throw httpError(422, `${pr.name} sudah dipanggil ${asal.qty_called} ${pr.unit} — barangnya tidak bisa diganti`);
      }
      if (r2(it.qty) < r2(asal.qty_called)) {
        throw httpError(
          422,
          `${pr.name}: sudah dipanggil ${asal.qty_called} ${pr.unit}, booking tidak bisa diturunkan menjadi ${it.qty}`
        );
      }
    }
    for (const asal of lama.values()) {
      if (dipakai.has(asal.id)) continue;
      if (asal.qty_called > 0) {
        const pr = db.prepare('SELECT name FROM products WHERE id = ?').get(asal.product_id);
        throw httpError(422, `${pr.name} sudah pernah dipanggil — barisnya tidak bisa dihapus`);
      }
      db.prepare('DELETE FROM purchase_booking_items WHERE id = ?').run(asal.id);
    }

    db.prepare(
      'UPDATE purchase_bookings SET booking_date = ?, valid_until = ?, partner_id = ?, note = ? WHERE id = ?'
    ).run(body.booking_date, body.valid_until || null, body.partner_id, body.note || null, id);

    const ubah = db.prepare('UPDATE purchase_booking_items SET product_id = ?, qty = ?, unit_cost = ? WHERE id = ?');
    const tambah = db.prepare(
      'INSERT INTO purchase_booking_items (booking_id, product_id, qty, unit_cost) VALUES (?,?,?,?)'
    );
    for (const it of body.items) {
      if (it.id) ubah.run(it.product_id, r2(it.qty), r2(it.unit_cost), it.id);
      else tambah.run(id, it.product_id, r2(it.qty), r2(it.unit_cost));
    }
    pembelian.hitungStatusBooking(id);
  })();

  const b = ambilBooking(id);
  res.json({ ok: true, booking: b, message: `Booking ${b.booking_no} diperbarui` });
}));

const panggilSchema = z.object({
  order_date: tanggal.default(() => todayLocal()),
  expected_date: tanggal.optional().nullable(),
  payment: z.enum(['CASH', 'BANK', 'CREDIT']).default('CREDIT'),
  cash_code: z.string().trim().min(3).optional().nullable(),
  invoice_no: z.string().trim().max(60).optional().nullable(),
  due_date: tanggal.optional().nullable(),
  note: z.string().trim().max(300).optional().nullable(),
  lines: z
    .array(z.object({
      booking_item_id: z.number().int().positive(),
      qty: z.number().nonnegative(),
      // Harga pesanan ini; kosong = harga booking. Harga nota bisa berbeda
      // dari harga saat booking, dan yang dibayar adalah harga nota.
      unit_cost: z.number().nonnegative().optional().nullable(),
    }))
    .refine((l) => l.some((x) => x.qty > 0), 'isi jumlah yang dipanggil minimal satu barang'),
});

/**
 * POST /api/booking/:id/panggil — memanggil sebagian stok dari pabrik.
 *
 * Menjadi pesanan pembelian biasa (bernomor PO), dengan tiap barisnya menunjuk
 * ke baris booking asalnya. Sisa di pabrik langsung berkurang; stok gudang
 * baru bertambah saat barangnya diterima.
 */
router.post('/:id(\\d+)/panggil', butuhIzin('pembelian.kelola'), ah((req, res) => {
  const body = parse(panggilSchema, req.body);
  const id = Number(req.params.id);

  const hasil = db.transaction(() => {
    const b = db.prepare('SELECT * FROM purchase_bookings WHERE id = ?').get(id);
    if (!b) throw httpError(404, 'Booking tidak ditemukan');
    if (b.status !== 'AKTIF') {
      throw httpError(409, `Booking ${b.booking_no} berstatus ${STATUS[b.status] || b.status} — tidak bisa dipanggil lagi`);
    }

    const baris = body.lines.filter((l) => l.qty > 0).map((l) => {
      const bi = db
        .prepare('SELECT * FROM purchase_booking_items WHERE id = ? AND booking_id = ?')
        .get(l.booking_item_id, id);
      if (!bi) throw httpError(404, `Baris ${l.booking_item_id} bukan bagian dari booking ini`);
      return { bi, qty: r2(l.qty), unit_cost: l.unit_cost == null ? bi.unit_cost : r2(l.unit_cost) };
    });

    const po = pembelian.buatPO(
      {
        order_date: body.order_date,
        expected_date: body.expected_date || null,
        partner_id: b.partner_id,
        payment: body.payment,
        cash_code: body.cash_code || null,
        invoice_no: body.invoice_no || null,
        due_date: body.due_date || null,
        note: body.note || `Dipanggil dari booking ${b.booking_no}`,
        items: baris.map((x) => ({ product_id: x.bi.product_id, qty: x.qty, unit_cost: x.unit_cost })),
      },
      req.user.id
    );

    // buatPO menyimpan baris sesuai urutan masukannya.
    const items = db.prepare('SELECT id FROM purchase_items WHERE po_id = ? ORDER BY id').all(po.id);
    const kaitkan = db.prepare('UPDATE purchase_items SET booking_item_id = ? WHERE id = ?');
    baris.forEach((x, k) => {
      kaitkan.run(x.bi.id, items[k].id);
      pembelian.geserJatahBooking(x.bi.id, x.qty);
    });
    return { po, booking_no: b.booking_no };
  })();

  res.status(201).json({
    ok: true,
    po: pembelian.ambilPO(hasil.po.id),
    booking: ambilBooking(id),
    message: `${hasil.po.po_no} dibuat dari booking ${hasil.booking_no} — sisa di pabrik berkurang`,
  });
}));

/** PATCH /api/booking/:id/batal — sisa di pabrik tidak lagi ditunggu. */
router.patch('/:id(\\d+)/batal', butuhIzin('pembelian.kelola'), ah((req, res) => {
  const b = db.prepare('SELECT * FROM purchase_bookings WHERE id = ?').get(req.params.id);
  if (!b) throw httpError(404, 'Booking tidak ditemukan');
  if (b.status === 'BATAL') throw httpError(409, 'Booking sudah dibatalkan');
  db.prepare("UPDATE purchase_bookings SET status = 'BATAL' WHERE id = ?").run(b.id);
  res.json({
    ok: true,
    message: `Booking ${b.booking_no} dibatalkan — pesanan yang sudah dipanggil darinya tetap berjalan`,
  });
}));

module.exports = router;
