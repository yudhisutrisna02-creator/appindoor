'use strict';
/**
 * Penerimaan barang (GRN — Goods Receipt Note).
 *
 * Halaman tempat tim gudang memverifikasi barang yang datang dari pabrik:
 * berapa yang diterima baik, berapa yang ditolak, dan surat jalan supplier
 * mana yang menyertainya. Menyimpannya menjalankan penerimaan pesanan yang
 * sama dengan tombol Terima di Pesanan Pembelian — sisa pesanan terpotong,
 * stok bertambah, HPP dan jurnalnya terbentuk — lalu meninggalkan dokumen GRN
 * bernomor yang bisa dicetak dan ditandatangani.
 */
const express = require('express');
const { db, getSetting } = require('../db');
const { requireAuth, butuhIzin } = require('../middleware/auth');
const { ah, parse, httpError, dateRange } = require('../utils/http');
const { r2 } = require('../utils/accounting');
const { dokumenPdf } = require('../utils/exporters');
const { todayLocal } = require('../utils/time');
const pembelian = require('./pembelian');

const router = express.Router();
router.use(requireAuth);

/**
 * GET /api/grn/menunggu — pesanan yang barangnya masih ditunggu.
 *
 * Yang ditampilkan per baris adalah sisanya, karena itulah yang dicocokkan
 * dengan barang di depan mata saat truk datang.
 */
router.get('/menunggu', butuhIzin('pembelian.lihat'), ah((req, res) => {
  const pos = db
    .prepare(
      `SELECT po.id, po.po_no, po.order_date, po.expected_date, po.status, po.payment,
              p.name AS supplier_name,
              CAST(julianday('now') - julianday(COALESCE(po.expected_date, po.order_date)) AS INTEGER) AS telat_hari
         FROM purchase_orders po JOIN partners p ON p.id = po.partner_id
        WHERE po.status IN ('DIPESAN', 'SEBAGIAN')
        ORDER BY COALESCE(po.expected_date, po.order_date), po.id`
    )
    .all();

  const baris = db.prepare(
    `SELECT pi.id AS item_id, pi.product_id, pi.qty, pi.qty_received, pi.unit_cost,
            pr.sku, pr.name AS product_name, pr.unit
       FROM purchase_items pi JOIN products pr ON pr.id = pi.product_id
      WHERE pi.po_id = ? ORDER BY pi.id`
  );

  res.json({
    rows: pos.map((po) => {
      const items = baris.all(po.id).map((i) => ({ ...i, sisa: r2(i.qty - i.qty_received) }));
      return {
        ...po,
        status_label: pembelian.STATUS[po.status] || po.status,
        items,
        sisa: r2(items.reduce((s, i) => s + i.sisa, 0)),
      };
    }),
  });
}));

function ambilGrn(id) {
  const g = db
    .prepare(
      `SELECT g.*, po.po_no, po.order_date, p.name AS supplier_name, p.phone AS supplier_phone,
              p.address AS supplier_address, u.name AS user_name
         FROM goods_receipts g
         JOIN purchase_orders po ON po.id = g.po_id
         JOIN partners p ON p.id = po.partner_id
         LEFT JOIN users u ON u.id = g.user_id
        WHERE g.id = ?`
    )
    .get(id);
  if (!g) throw httpError(404, 'Dokumen penerimaan tidak ditemukan');
  const items = db
    .prepare(
      `SELECT gi.*, pr.sku, pr.name AS product_name, pr.unit, pi.qty AS qty_ordered
         FROM goods_receipt_items gi
         JOIN products pr ON pr.id = gi.product_id
         JOIN purchase_items pi ON pi.id = gi.po_item_id
        WHERE gi.grn_id = ? ORDER BY gi.id`
    )
    .all(id);
  return {
    ...g,
    items,
    total_diterima: r2(items.reduce((s, i) => s + i.qty_received, 0)),
    total_ditolak: r2(items.reduce((s, i) => s + i.qty_rejected, 0)),
  };
}

/** GET /api/grn — riwayat dokumen penerimaan. */
router.get('/', butuhIzin('pembelian.lihat'), ah((req, res) => {
  const { from, to } = dateRange(req.query);
  const params = [from, to];
  let where = 'WHERE g.receive_date BETWEEN ? AND ?';
  if (req.query.q) {
    where += ' AND (g.grn_no LIKE ? OR po.po_no LIKE ? OR p.name LIKE ? OR g.delivery_note_no LIKE ?)';
    const q = `%${req.query.q}%`;
    params.push(q, q, q, q);
  }
  const rows = db
    .prepare(
      `SELECT g.*, po.po_no, p.name AS supplier_name, u.name AS user_name,
              (SELECT COALESCE(SUM(qty_received), 0) FROM goods_receipt_items WHERE grn_id = g.id) AS total_diterima,
              (SELECT COALESCE(SUM(qty_rejected), 0) FROM goods_receipt_items WHERE grn_id = g.id) AS total_ditolak,
              (SELECT COUNT(*) FROM goods_receipt_items WHERE grn_id = g.id) AS jumlah_barang
         FROM goods_receipts g
         JOIN purchase_orders po ON po.id = g.po_id
         JOIN partners p ON p.id = po.partner_id
         LEFT JOIN users u ON u.id = g.user_id
         ${where}
        ORDER BY g.receive_date DESC, g.id DESC
        LIMIT 500`
    )
    .all(...params);
  res.json({ from, to, rows });
}));

router.get('/:id(\\d+)', butuhIzin('pembelian.lihat'), ah((req, res) => {
  res.json({ grn: ambilGrn(Number(req.params.id)) });
}));

/** POST /api/grn — menyimpan penerimaan barang dari satu pesanan. */
router.post('/', butuhIzin('pembelian.kelola'), ah((req, res) => {
  const poId = Number(req.body && req.body.po_id);
  if (!poId) throw httpError(422, 'Pilih pesanan pembelian yang barangnya datang');
  const body = parse(pembelian.terimaSchema, req.body);
  const hasil = pembelian.terimaBarang(poId, body, req.user.id);
  res.status(201).json({
    ok: true,
    grn: ambilGrn(hasil.grn_id),
    message:
      `${hasil.grn_no} tersimpan — ${hasil.diterima} barang masuk stok, pesanan kini ` +
      `${pembelian.STATUS[hasil.status] || hasil.status}`,
  });
}));

/** GET /api/grn/:id/pdf — bukti penerimaan barang, siap dicetak. */
router.get('/:id(\\d+)/pdf', butuhIzin('pembelian.lihat'), ah(async (req, res) => {
  const g = ambilGrn(Number(req.params.id));
  const buffer = await dokumenPdf(
    {
      judul: 'BUKTI PENERIMAAN BARANG (GRN)',
      subjudul: `Dicetak ${todayLocal()}`,
      nomor: g.grn_no,
      meta: [
        ['Tanggal terima', g.receive_date],
        ['No. pesanan', g.po_no],
        ['Surat jalan supplier', g.delivery_note_no || '-'],
        ['Diterima oleh', g.received_by || g.user_name || '-'],
      ],
      pihak: [
        {
          judul: 'DARI (SUPPLIER)',
          nama: g.supplier_name,
          baris: [g.supplier_phone, g.supplier_address].filter(Boolean),
        },
        {
          judul: 'RINGKASAN',
          nama: `${g.items.length} jenis barang`,
          baris: [`Diterima baik ${g.total_diterima}`, `Ditolak ${g.total_ditolak}`],
        },
      ],
      kolom: [
        { header: 'SKU', key: 'sku', width: 14 },
        { header: 'Barang', key: 'product_name', width: 36 },
        { header: 'Dipesan', key: 'qty_ordered', width: 10 },
        { header: 'Diterima', key: 'qty_received', width: 10 },
        { header: 'Ditolak', key: 'qty_rejected', width: 10 },
        { header: 'Satuan', key: 'unit', width: 9 },
        { header: 'Keterangan', key: 'note', width: 22 },
      ],
      rows: g.items,
      catatan: [
        g.note || null,
        g.total_ditolak > 0
          ? 'Barang yang ditolak tidak masuk stok dan tidak mengurangi sisa pesanan.'
          : null,
      ].filter(Boolean).join('\n') || null,
      tandaTangan: [
        { label: 'Pengirim / Sopir', nama: '' },
        { label: 'Diterima Gudang', nama: g.received_by || '' },
        { label: 'Diperiksa', nama: '' },
      ],
    },
    { perusahaan: getSetting('company_name', 'Perusahaan') }
  );
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="${g.grn_no.replace(/[^A-Za-z0-9]+/g, '-')}.pdf"`);
  res.send(buffer);
}));

module.exports = router;
