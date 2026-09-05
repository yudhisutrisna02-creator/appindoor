'use strict';
/**
 * Retur pembelian — barang yang dikembalikan ke supplier.
 *
 * Sebelum ada ini, barang rusak atau salah kirim dari supplier hanya bisa
 * dicatat lewat koreksi stok. Stoknya memang berkurang, tetapi utang ke
 * suppliernya TIDAK — sehingga aplikasi tetap menagih pembayaran untuk barang
 * yang sudah dikembalikan, dan selisihnya baru ketahuan saat supplier menagih
 * dengan angka yang berbeda.
 *
 * Arah uangnya berlawanan dengan retur penjualan, jadi tidak bisa memakai
 * jalur yang sama: retur penjualan mengurangi pendapatan, retur pembelian
 * mengurangi utang atau mengembalikan kas.
 *
 * Dua kemungkinan, dan pemiliknya yang memilih — bukan ditebak sistem:
 *
 *   UTANG  : barangnya belum dibayar. Utang ke supplier berkurang.
 *   REFUND : barangnya sudah dibayar. Supplier mengembalikan uangnya.
 *
 * Menebaknya dari status pembayaran PO terdengar pintar, tetapi salah: satu
 * PO bisa dibayar sebagian, dan supplier sering memilih memotong tagihan
 * berikutnya alih-alih mengirim uang kembali. Yang tahu kesepakatannya hanya
 * orang yang menghubungi suppliernya.
 */
const express = require('express');
const { z } = require('zod');
const { db, nextNumber } = require('../db');
const { requireAuth, butuhIzin } = require('../middleware/auth');
const { ah, parse, httpError, dateRange } = require('../utils/http');
const { r2, ACC, postJournal, deleteJournalsBySource, accountByCode } = require('../utils/accounting');
const { daftarkanEkspor } = require('../utils/ekspor');
const { todayLocal } = require('../utils/time');
const BATCH = require('../utils/batch');

const router = express.Router();
router.use(requireAuth);

const returSchema = z.object({
  return_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).default(() => todayLocal()),
  po_id: z.number().int().positive().optional().nullable(),
  partner_id: z.number().int().positive('supplier wajib dipilih'),
  product_id: z.number().int().positive(),
  qty: z.number().positive('jumlah harus lebih dari nol'),
  // Kosongkan untuk memakai HPP produk saat ini. Diisi bila harga belinya
  // memang berbeda dari HPP rata-rata — mis. barang lama yang harganya lain.
  unit_cost: z.number().nonnegative().optional().nullable(),
  mode: z.enum(['UTANG', 'REFUND']).default('UTANG'),
  cash_code: z.string().trim().optional().nullable(),
  reason: z.string().trim().max(300).optional().nullable(),
});

const buatRetur = db.transaction((body, userId) => {
  const produk = db.prepare('SELECT * FROM products WHERE id = ?').get(body.product_id);
  if (!produk) throw httpError(404, 'Produk tidak ditemukan');

  const mitra = db.prepare('SELECT * FROM partners WHERE id = ?').get(body.partner_id);
  if (!mitra) throw httpError(404, 'Supplier tidak ditemukan');

  const qty = r2(body.qty);

  // Tidak bisa mengembalikan barang yang tidak ada di gudang. Membiarkannya
  // membuat stok minus, dan stok minus adalah angka yang tidak pernah bisa
  // dijelaskan kepada siapa pun yang menghitung fisik.
  if (qty > r2(produk.stock)) {
    throw httpError(
      422,
      `Stok ${produk.name} hanya ${produk.stock} ${produk.unit}, tidak cukup untuk mengembalikan ${qty}.`
    );
  }

  const unitCost = body.unit_cost != null ? r2(body.unit_cost) : r2(produk.cost);
  const nilai = r2(qty * unitCost);
  if (nilai <= 0) throw httpError(422, 'Nilai retur tidak boleh nol — periksa harga belinya');

  let kas = null;
  if (body.mode === 'REFUND') {
    if (!body.cash_code) throw httpError(422, 'Pilih rekening penerima pengembalian dana');
    kas = accountByCode(body.cash_code);
    if (!kas.is_cash) throw httpError(422, `${kas.code} · ${kas.name} bukan rekening kas/bank`);
  }

  const returNo = nextNumber('RTB', body.return_date.slice(0, 7));

  const info = db
    .prepare(
      `INSERT INTO purchase_returns
         (return_no, return_date, po_id, partner_id, product_id, qty, unit_cost, amount, mode, cash_code, reason, user_id)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
    )
    .run(
      returNo, body.return_date, body.po_id || null, mitra.id, produk.id,
      qty, unitCost, nilai, body.mode, kas ? kas.code : null,
      body.reason || null, userId
    );

  const returId = info.lastInsertRowid;

  // ---------- stok keluar ----------
  const stokBaru = r2(produk.stock - qty);
  db.prepare('UPDATE products SET stock = ? WHERE id = ?').run(stokBaru, produk.id);

  db.prepare(
    `INSERT INTO stock_moves
       (product_id, move_date, move_type, qty, unit_cost, balance_after, ref, source, source_id, note, user_id, partner_id)
     VALUES (?,?,'OUT',?,?,?,?, 'PURCHASE_RETURN', ?, ?, ?, ?)`
  ).run(
    produk.id, body.return_date, qty, unitCost, stokBaru, returNo, returId,
    `Retur ke ${mitra.name}${body.reason ? ` — ${body.reason}` : ''}`, userId, mitra.id
  );

  // Batch dipotong FEFO seperti pengeluaran lainnya. Barang cacat biasanya
  // memang dari batch tertentu, tetapi memilih batch itu butuh orang yang
  // melihat fisiknya — dan menebaknya di sini akan salah lebih sering
  // daripada benar.
  BATCH.keluar({
    product_id: produk.id, qty, tanggal: body.return_date,
    source: 'PURCHASE_RETURN', sourceId: returId,
    note: `Retur ke ${mitra.name}`, userId,
  });

  // ---------- jurnal ----------
  // Persediaan berkurang; lawannya utang yang berkurang, atau kas yang masuk.
  const lines = body.mode === 'REFUND'
    ? [
        { code: kas.code, debit: nilai, credit: 0, memo: `Pengembalian dana dari ${mitra.name}` },
        { code: ACC.INVENTORY, debit: 0, credit: nilai, memo: `Retur ${produk.name}` },
      ]
    : [
        { code: ACC.AP, debit: nilai, credit: 0, memo: `Retur ke ${mitra.name}`, partner_id: mitra.id },
        { code: ACC.INVENTORY, debit: 0, credit: nilai, memo: `Retur ${produk.name}` },
      ];

  const jurnal = postJournal({
    date: body.return_date,
    description: `Retur Pembelian ${returNo} — ${produk.name} ke ${mitra.name}`,
    lines,
    source: 'PURCHASE_RETURN',
    sourceId: returId,
    userId,
  });

  return { id: returId, return_no: returNo, nilai, stokBaru, jurnal };
});

router.post('/', butuhIzin('pembelian.kelola'), ah((req, res) => {
  const body = parse(returSchema, req.body);
  const hasil = buatRetur(body, req.user.id);

  res.status(201).json({
    ok: true,
    ...hasil,
    message:
      `Retur ${hasil.return_no} tercatat — Rp ${hasil.nilai.toLocaleString('id-ID')} ` +
      `${body.mode === 'REFUND' ? 'dikembalikan ke rekening' : 'mengurangi utang supplier'}.`,
  });
}));

/** Pengambil daftar retur — dipakai layar dan berkas unduhan. */
function ambilRetur(req) {
  const { from, to } = dateRange(req.query);

  const rows = db
    .prepare(
      `SELECT r.*, p.sku, p.name AS product_name, p.unit,
              m.name AS partner_name, po.po_no, u.name AS user_name
         FROM purchase_returns r
         JOIN products p ON p.id = r.product_id
         LEFT JOIN partners m ON m.id = r.partner_id
         LEFT JOIN purchase_orders po ON po.id = r.po_id
         LEFT JOIN users u ON u.id = r.user_id
        WHERE r.return_date BETWEEN ? AND ?
        ORDER BY r.return_date DESC, r.id DESC`
    )
    .all(from, to);

  const jum = (f) => r2(rows.reduce((s, x) => s + f(x), 0));

  return {
    from, to, rows,
    ringkas: {
      jumlah: rows.length,
      nilai: jum((r) => r.amount),
      kurangUtang: jum((r) => (r.mode === 'UTANG' ? r.amount : 0)),
      danaKembali: jum((r) => (r.mode === 'REFUND' ? r.amount : 0)),
    },
  };
}

router.get('/', butuhIzin('pembelian.lihat'), ah((req, res) => res.json(ambilRetur(req))));

/**
 * DELETE /api/retur-beli/:id — membatalkan retur.
 *
 * Barang kembali ke gudang dan jurnalnya dihapus, sehingga utang atau kas
 * kembali seperti sebelum retur dicatat. Lewat deleteJournalsBySource supaya
 * kunci periode tetap berlaku: retur di bulan yang sudah ditutup tidak bisa
 * dibatalkan diam-diam.
 */
router.delete('/:id(\\d+)', butuhIzin('pembelian.kelola'), ah((req, res) => {
  const hasil = db.transaction(() => {
    const r = db.prepare('SELECT * FROM purchase_returns WHERE id = ?').get(req.params.id);
    if (!r) throw httpError(404, 'Retur pembelian tidak ditemukan');

    const produk = db.prepare('SELECT * FROM products WHERE id = ?').get(r.product_id);
    const stokBaru = r2(produk.stock + r.qty);
    db.prepare('UPDATE products SET stock = ? WHERE id = ?').run(stokBaru, produk.id);

    BATCH.kembalikan({ source: 'PURCHASE_RETURN', sourceId: r.id, tanggal: r.return_date });

    db.prepare("DELETE FROM stock_moves WHERE source = 'PURCHASE_RETURN' AND source_id = ?").run(r.id);
    deleteJournalsBySource('PURCHASE_RETURN', r.id);
    db.prepare('DELETE FROM purchase_returns WHERE id = ?').run(r.id);

    return r.return_no;
  })();

  res.json({ ok: true, message: `Retur ${hasil} dibatalkan, barang kembali ke gudang` });
}));

daftarkanEkspor(router, {
  path: '/',
  judul: 'Retur Pembelian',
  kolom: [
    { header: 'No. Retur', key: 'return_no', width: 18 },
    { header: 'Tanggal', key: 'return_date', width: 13 },
    { header: 'Supplier', key: 'partner_name', width: 26 },
    { header: 'SKU', key: 'sku', width: 16 },
    { header: 'Produk', key: 'product_name', width: 32 },
    { header: 'Jumlah', key: 'qty', width: 10 },
    { header: 'Satuan', key: 'unit', width: 9 },
    { header: 'Harga Beli', key: 'unit_cost', width: 15, money: true },
    { header: 'Nilai', key: 'amount', width: 16, money: true },
    { header: 'Perlakuan', key: 'mode', width: 12 },
    { header: 'Alasan', key: 'reason', width: 30 },
  ],
  ambil: (req) => {
    const d = ambilRetur(req);
    return {
      rows: d.rows,
      subtitle: `Barang yang dikembalikan ke supplier, ${d.from} s/d ${d.to}`,
      meta: [
        ['Jumlah retur', d.ringkas.jumlah],
        ['Nilai retur', d.ringkas.nilai],
        ['Mengurangi utang', d.ringkas.kurangUtang],
        ['Dana dikembalikan', d.ringkas.danaKembali],
      ],
    };
  },
});

module.exports = router;
module.exports.ambilRetur = ambilRetur;
