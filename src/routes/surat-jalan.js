'use strict';
/**
 * Surat Jalan (Delivery Order).
 *
 * Lembar yang dibawa kurir/sopir bersama barangnya: siapa penerimanya, ke mana,
 * dan barang apa saja berapa banyak — sengaja TANPA harga, karena kertas ini
 * berpindah tangan ke orang yang tidak perlu tahu nilainya.
 *
 * Surat jalan ditarik dari order penjualan. Stok, HPP, dan jurnal sudah
 * dibukukan ordernya, jadi di sini tidak ada yang dibukukan lagi; yang dijaga
 * hanya supaya barang yang dikirim tidak melebihi yang dipesan. Satu order
 * boleh dikirim bertahap dengan beberapa surat jalan.
 *
 * Nomor: GI/DO/YYYY/MM/XXXX, berurutan per bulan tanggal surat jalannya.
 */
const express = require('express');
const { z } = require('zod');
const { db, nextNumber, getSetting } = require('../db');
const { requireAuth, butuhIzin } = require('../middleware/auth');
const { ah, parse, httpError, dateRange } = require('../utils/http');
const { r2 } = require('../utils/accounting');
const { dokumenPdf } = require('../utils/exporters');
const { todayLocal } = require('../utils/time');
const { CHANNEL_LABEL } = require('../utils/kanal');

const router = express.Router();
router.use(requireAuth);

const STATUS = { DIKIRIM: 'Dikirim', DITERIMA: 'Diterima', BATAL: 'Batal' };
const tanggal = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const teks = (max) => z.string().trim().max(max).optional().nullable();

const tglIndo = (iso) => {
  if (!iso) return '-';
  const [y, m, d] = String(iso).slice(0, 10).split('-');
  const bulan = ['Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni', 'Juli', 'Agustus',
    'September', 'Oktober', 'November', 'Desember'][Number(m) - 1];
  return `${Number(d)} ${bulan} ${y}`;
};

/**
 * Barang sebuah order beserta yang sudah dan belum dikirim, per produk.
 *
 * Dihitung per produk, bukan per baris order: baris order bisa ditulis ulang
 * saat ordernya diubah, sedangkan produknya tetap. Surat jalan yang dibatalkan
 * tidak dihitung. `kecuali` mengecualikan satu surat jalan (dipakai saat
 * mengubahnya, supaya jumlah lamanya tidak memakan jatah sendiri).
 */
function barangOrder(orderId, kecuali = 0) {
  const dipesan = db
    .prepare(
      `SELECT si.product_id, p.sku, p.name AS product_name, p.unit, SUM(si.qty) AS qty
         FROM sales_items si JOIN products p ON p.id = si.product_id
        WHERE si.order_id = ?
        GROUP BY si.product_id ORDER BY MIN(si.id)`
    )
    .all(orderId);

  const terkirim = new Map(
    db
      .prepare(
        `SELECT i.product_id, SUM(i.qty) AS qty
           FROM delivery_order_items i JOIN delivery_orders d ON d.id = i.do_id
          WHERE d.order_id = ? AND d.status <> 'BATAL' AND d.id <> ?
          GROUP BY i.product_id`
      )
      .all(orderId, kecuali)
      .map((r) => [r.product_id, r.qty])
  );

  return dipesan.map((b) => {
    const kirim = r2(terkirim.get(b.product_id) || 0);
    return { ...b, qty: r2(b.qty), terkirim: kirim, sisa: r2(Math.max(0, b.qty - kirim)) };
  });
}

function ambilOrder(orderId) {
  const o = db
    .prepare(
      `SELECT o.id, o.order_no, o.order_date, o.channel, o.customer, o.status, o.courier, o.tracking_no,
              o.buyer_name, o.buyer_phone, o.buyer_address, o.buyer_city, o.order_ref,
              pa.name AS partner_name, pa.phone AS partner_phone, pa.address AS partner_address
         FROM sales_orders o LEFT JOIN partners pa ON pa.id = o.partner_id
        WHERE o.id = ?`
    )
    .get(orderId);
  if (!o) throw httpError(404, 'Order penjualan tidak ditemukan');
  return o;
}

/** Penerima bawaan dari ordernya: data pembeli, lalu data mitranya. */
const penerimaBawaan = (o) => ({
  recipient_name: o.buyer_name || o.customer || o.partner_name || '',
  recipient_phone: o.buyer_phone || o.partner_phone || '',
  address: o.buyer_address || o.partner_address || '',
  city: o.buyer_city || '',
  courier: o.courier || '',
  tracking_no: o.tracking_no || '',
});

function ambilSJ(id) {
  const d = db
    .prepare(
      `SELECT d.*, o.order_no, o.order_date, o.channel, o.customer, o.order_ref,
              u.name AS user_name, inv.invoice_no, inv.status AS invoice_status
         FROM delivery_orders d
         JOIN sales_orders o ON o.id = d.order_id
         LEFT JOIN users u ON u.id = d.user_id
         LEFT JOIN sales_invoices inv ON inv.id = d.invoice_id
        WHERE d.id = ?`
    )
    .get(id);
  if (!d) throw httpError(404, 'Surat jalan tidak ditemukan');
  const items = db.prepare('SELECT * FROM delivery_order_items WHERE do_id = ? ORDER BY id').all(id);
  return {
    ...d,
    status_label: STATUS[d.status] || d.status,
    channel_label: CHANNEL_LABEL[d.channel] || d.channel,
    items,
    total_qty: r2(items.reduce((s, i) => s + i.qty, 0)),
  };
}

/* ------------------------------------------------------------------ */

/**
 * GET /api/surat-jalan/calon?q= — order yang masih punya barang belum dikirim.
 * Tanpa harga, supaya tim gudang bisa memakainya.
 */
router.get('/calon', ah((req, res) => {
  const q = String(req.query.q || '').trim();
  const cari = q ? `%${q}%` : null;
  const orders = db
    .prepare(
      `SELECT o.id, o.order_no, o.order_date, o.channel, o.customer, o.buyer_name, o.buyer_city, o.order_ref
         FROM sales_orders o
        WHERE o.status = 'POSTED'
          AND o.order_date >= date('now', '-120 days')
          ${cari ? 'AND (o.order_no LIKE @c OR o.customer LIKE @c OR o.buyer_name LIKE @c OR o.order_ref LIKE @c)' : ''}
        ORDER BY o.order_date DESC, o.id DESC
        LIMIT 300`
    )
    .all(cari ? { c: cari } : {});

  const rows = [];
  for (const o of orders) {
    const barang = barangOrder(o.id);
    const sisa = r2(barang.reduce((s, b) => s + b.sisa, 0));
    if (sisa <= 0) continue;
    rows.push({
      ...o,
      channel_label: CHANNEL_LABEL[o.channel] || o.channel,
      sisa,
      dipesan: r2(barang.reduce((s, b) => s + b.qty, 0)),
      sebagian: barang.some((b) => b.terkirim > 0),
    });
    if (rows.length >= 60) break;
  }
  res.json({ rows });
}));

/** GET /api/surat-jalan/order/:id — isian bawaan untuk membuat surat jalan dari order ini. */
router.get('/order/:id(\\d+)', ah((req, res) => {
  const o = ambilOrder(Number(req.params.id));
  if (o.status !== 'POSTED') throw httpError(422, 'Order ini sudah dibatalkan');
  res.json({
    order: { id: o.id, order_no: o.order_no, order_date: o.order_date, customer: o.customer, channel: o.channel, order_ref: o.order_ref },
    bawaan: penerimaBawaan(o),
    barang: barangOrder(o.id),
  });
}));

/** GET /api/surat-jalan?from&to&q&status — daftar surat jalan. */
router.get('/', ah((req, res) => {
  const { from, to } = dateRange(req.query);
  const q = String(req.query.q || '').trim();
  const where = ['d.do_date BETWEEN @from AND @to'];
  const p = { from, to };
  if (q) {
    where.push('(d.do_no LIKE @q OR o.order_no LIKE @q OR d.recipient_name LIKE @q OR d.city LIKE @q)');
    p.q = `%${q}%`;
  }
  if (STATUS[req.query.status]) {
    where.push('d.status = @status');
    p.status = req.query.status;
  }
  const rows = db
    .prepare(
      `SELECT d.id, d.do_no, d.do_date, d.status, d.recipient_name, d.city, d.courier, d.driver_name,
              d.received_date, d.invoice_id, inv.invoice_no, o.order_no, o.channel,
              (SELECT COUNT(*) FROM delivery_order_items i WHERE i.do_id = d.id) AS jumlah_barang,
              (SELECT COALESCE(SUM(qty), 0) FROM delivery_order_items i WHERE i.do_id = d.id) AS total_qty
         FROM delivery_orders d
         JOIN sales_orders o ON o.id = d.order_id
         LEFT JOIN sales_invoices inv ON inv.id = d.invoice_id AND inv.status <> 'BATAL'
        WHERE ${where.join(' AND ')}
        ORDER BY d.do_date DESC, d.id DESC`
    )
    .all(p)
    .map((r) => ({ ...r, status_label: STATUS[r.status] || r.status, channel_label: CHANNEL_LABEL[r.channel] || r.channel }));

  res.json({
    rows,
    ringkas: {
      total: rows.length,
      dikirim: rows.filter((r) => r.status === 'DIKIRIM').length,
      diterima: rows.filter((r) => r.status === 'DITERIMA').length,
      belumFaktur: rows.filter((r) => r.status !== 'BATAL' && !r.invoice_no).length,
    },
  });
}));

router.get('/:id(\\d+)', ah((req, res) => res.json(ambilSJ(Number(req.params.id)))));

const sjSchema = z.object({
  order_id: z.number().int().positive(),
  do_date: tanggal.default(() => todayLocal()),
  recipient_name: z.string().trim().min(1, 'nama penerima wajib diisi').max(120),
  recipient_phone: teks(40),
  address: z.string().trim().min(1, 'alamat kirim wajib diisi').max(400),
  city: teks(80),
  courier: teks(60),
  vehicle_no: teks(30),
  driver_name: teks(80),
  tracking_no: teks(80),
  note: teks(300),
  lines: z
    .array(z.object({
      product_id: z.number().int().positive(),
      qty: z.number().nonnegative(),
      note: teks(120),
    }))
    .min(1, 'minimal satu barang'),
});

/** Memeriksa baris kiriman terhadap sisa order; mengembalikan baris yang qty-nya > 0. */
function periksaBaris(orderId, lines, kecuali = 0) {
  const barang = new Map(barangOrder(orderId, kecuali).map((b) => [b.product_id, b]));
  const minta = new Map();
  for (const l of lines) {
    if (!(l.qty > 0)) continue;
    const b = barang.get(l.product_id);
    if (!b) throw httpError(422, 'Ada barang yang tidak termasuk dalam order ini');
    const total = r2((minta.get(l.product_id)?.qty || 0) + l.qty);
    if (total > b.sisa + 1e-9) {
      throw httpError(422, `${b.product_name}: dikirim ${total} ${b.unit || ''} melebihi sisa order ${b.sisa}`);
    }
    minta.set(l.product_id, { ...b, qty: total, note: l.note || minta.get(l.product_id)?.note || null });
  }
  if (!minta.size) throw httpError(422, 'Isi jumlah kirim minimal satu barang');
  return [...minta.values()];
}

const simpanBaris = db.prepare(
  'INSERT INTO delivery_order_items (do_id, product_id, product_name, sku, unit, qty, note) VALUES (?,?,?,?,?,?,?)'
);

/** POST /api/surat-jalan — membuat surat jalan dari order. */
router.post('/', butuhIzin('penjualan.suratjalan'), ah((req, res) => {
  const body = parse(sjSchema, req.body);
  const o = ambilOrder(body.order_id);
  if (o.status !== 'POSTED') throw httpError(422, 'Order ini sudah dibatalkan');

  const id = db.transaction(() => {
    const baris = periksaBaris(o.id, body.lines);
    const nomor = nextNumber('GI/DO', body.do_date.slice(0, 7).replace('-', '/'));
    const info = db
      .prepare(
        `INSERT INTO delivery_orders (do_no, do_date, order_id, recipient_name, recipient_phone, address, city,
           courier, vehicle_no, driver_name, tracking_no, note, user_id)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`
      )
      .run(nomor, body.do_date, o.id, body.recipient_name, body.recipient_phone || null, body.address,
        body.city || null, body.courier || null, body.vehicle_no || null, body.driver_name || null,
        body.tracking_no || null, body.note || null, req.user.id);
    for (const b of baris) simpanBaris.run(info.lastInsertRowid, b.product_id, b.product_name, b.sku, b.unit, b.qty, b.note);
    return info.lastInsertRowid;
  })();

  const sj = ambilSJ(id);
  res.status(201).json({ ok: true, message: `Surat jalan ${sj.do_no} dibuat`, suratJalan: sj });
}));

/** PUT /api/surat-jalan/:id — mengubah surat jalan yang belum difakturkan. */
router.put('/:id(\\d+)', butuhIzin('penjualan.suratjalan'), ah((req, res) => {
  const lama = ambilSJ(Number(req.params.id));
  if (lama.status === 'BATAL') throw httpError(422, 'Surat jalan yang dibatalkan tidak bisa diubah');
  if (lama.invoice_no && lama.invoice_status !== 'BATAL') {
    throw httpError(422, `Surat jalan ini sudah ditagih di faktur ${lama.invoice_no} — batalkan fakturnya dulu`);
  }
  const body = parse(sjSchema.omit({ order_id: true }), req.body);

  db.transaction(() => {
    const baris = periksaBaris(lama.order_id, body.lines, lama.id);
    db.prepare(
      `UPDATE delivery_orders SET do_date = ?, recipient_name = ?, recipient_phone = ?, address = ?, city = ?,
         courier = ?, vehicle_no = ?, driver_name = ?, tracking_no = ?, note = ? WHERE id = ?`
    ).run(body.do_date, body.recipient_name, body.recipient_phone || null, body.address, body.city || null,
      body.courier || null, body.vehicle_no || null, body.driver_name || null, body.tracking_no || null,
      body.note || null, lama.id);
    db.prepare('DELETE FROM delivery_order_items WHERE do_id = ?').run(lama.id);
    for (const b of baris) simpanBaris.run(lama.id, b.product_id, b.product_name, b.sku, b.unit, b.qty, b.note);
  })();

  res.json({ ok: true, message: `Surat jalan ${lama.do_no} diperbarui`, suratJalan: ambilSJ(lama.id) });
}));

/** PATCH /api/surat-jalan/:id/terima — barang sudah sampai di penerima. */
router.patch('/:id(\\d+)/terima', butuhIzin('penjualan.suratjalan'), ah((req, res) => {
  const sj = ambilSJ(Number(req.params.id));
  if (sj.status === 'BATAL') throw httpError(422, 'Surat jalan ini sudah dibatalkan');
  const body = parse(z.object({
    received_date: tanggal.default(() => todayLocal()),
    received_by: teks(120),
  }), req.body || {});
  db.prepare("UPDATE delivery_orders SET status = 'DITERIMA', received_date = ?, received_by = ? WHERE id = ?")
    .run(body.received_date, body.received_by || null, sj.id);
  res.json({ ok: true, message: `${sj.do_no} ditandai sudah diterima` });
}));

/** PATCH /api/surat-jalan/:id/batal — jatah kirimnya kembali ke order. */
router.patch('/:id(\\d+)/batal', butuhIzin('penjualan.suratjalan'), ah((req, res) => {
  const sj = ambilSJ(Number(req.params.id));
  if (sj.status === 'BATAL') throw httpError(422, 'Surat jalan ini sudah dibatalkan');
  if (sj.invoice_no && sj.invoice_status !== 'BATAL') {
    throw httpError(422, `Surat jalan ini sudah ditagih di faktur ${sj.invoice_no} — batalkan fakturnya dulu`);
  }
  db.prepare("UPDATE delivery_orders SET status = 'BATAL', invoice_id = NULL WHERE id = ?").run(sj.id);
  res.json({ ok: true, message: `Surat jalan ${sj.do_no} dibatalkan` });
}));

/* ------------------------------------------------------------------ */

function dokumenSJ(sj) {
  return {
    resmi: true,
    judul: 'SURAT JALAN',
    subjudul: 'Delivery Order',
    nomor: `No. ${sj.do_no}`,
    meta: [
      ['Tanggal', tglIndo(sj.do_date)],
      ['No. Order', sj.order_no],
      ...(sj.order_ref ? [['No. Pesanan', sj.order_ref]] : []),
      ...(sj.courier ? [['Ekspedisi', sj.courier]] : []),
      ...(sj.tracking_no ? [['No. Resi', sj.tracking_no]] : []),
      ...(sj.vehicle_no ? [['No. Kendaraan', sj.vehicle_no]] : []),
      ...(sj.driver_name ? [['Sopir/Kurir', sj.driver_name]] : []),
    ],
    pihak: [
      {
        judul: 'DIKIRIM KEPADA',
        nama: sj.recipient_name,
        baris: [sj.address, sj.city, sj.recipient_phone ? `Telp/WA: ${sj.recipient_phone}` : null],
      },
      {
        judul: 'DIKIRIM OLEH',
        nama: getSetting('company_name', 'Perusahaan'),
        baris: [getSetting('company_address', ''), getSetting('company_phone', '') ? `Telp/WA: ${getSetting('company_phone', '')}` : null],
      },
    ],
    kolom: [
      { header: 'No', key: 'no', width: 5 },
      { header: 'Kode', key: 'sku', width: 14 },
      { header: 'Nama Barang', key: 'product_name', width: 42 },
      { header: 'Jumlah', key: 'qty', width: 10 },
      { header: 'Satuan', key: 'unit', width: 10 },
      { header: 'Keterangan', key: 'note', width: 20 },
    ],
    rows: sj.items.map((i, k) => ({ ...i, no: k + 1, qty: r2(i.qty) })),
    ringkas: [['Total barang', `${sj.total_qty} (${sj.items.length} jenis)`, true]],
    catatan: [
      sj.note ? `Catatan: ${sj.note}` : null,
      'Mohon barang diperiksa saat diterima. Keluhan atas jumlah atau kondisi barang disampaikan paling lambat 1x24 jam sejak barang diterima.',
      sj.status === 'BATAL' ? 'SURAT JALAN INI TELAH DIBATALKAN.' : null,
    ].filter(Boolean).join('\n'),
    tandaTangan: [
      { label: 'Hormat kami / Pengirim', nama: '' },
      { label: 'Sopir / Kurir', nama: sj.driver_name || '' },
      { label: 'Penerima', nama: sj.received_by || '' },
    ],
  };
}

router.get('/:id(\\d+)/pdf', ah(async (req, res) => {
  const sj = ambilSJ(Number(req.params.id));
  const buffer = await dokumenPdf(dokumenSJ(sj), { perusahaan: getSetting('company_name', 'Perusahaan') });
  const nama = `surat-jalan-${sj.do_no.toLowerCase().replace(/[^a-z0-9]+/g, '-')}.pdf`;
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="${nama}"`);
  res.send(buffer);
}));

module.exports = router;
module.exports.ambilSJ = ambilSJ;
module.exports.tglIndo = tglIndo;
