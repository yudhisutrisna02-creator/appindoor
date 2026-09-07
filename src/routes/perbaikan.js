'use strict';
/**
 * Barang retur yang masih bisa diselamatkan.
 *
 * Retur dari pembeli tidak selalu dua kemungkinan. Botol kemasan cair yang
 * pecah memang langsung jadi kerugian, tetapi kemasan aluminium foil yang
 * hanya rusak label atau foilnya cukup dikemas ulang dan bisa dijual lagi.
 *
 * Tanpa tempat ketiga, barang seperti itu terpaksa dicatat sebagai kerugian
 * lalu dimasukkan kembali sebagai barang baru. Dua akibatnya:
 *
 *   - Selama diperbaiki, barangnya TIDAK ADA di catatan mana pun. Yang lupa
 *     mengerjakannya tidak akan pernah diingatkan, dan barangnya hilang dari
 *     pembukuan selamanya.
 *   - Laba turun di bulan barang masuk dan naik di bulan barang keluar, tanpa
 *     sebab yang bisa dijelaskan kepada siapa pun yang membaca laporannya.
 *
 * Di sini barangnya menunggu dengan nilainya tetap tercatat sebagai aset,
 * lalu keluar lewat salah satu dari dua pintu: selesai dikemas ulang dan
 * kembali ke stok jual, atau ternyata tidak bisa diselamatkan dan menjadi
 * kerugian.
 *
 * NILAI BARANGNYA DIBEKUKAN saat masuk. Kalau HPP produknya bergerak setelah
 * itu, nilai yang menunggu tidak boleh ikut bergerak — yang dipindahkan dari
 * HPP adalah angka yang berlaku pada hari barangnya kembali, dan itulah yang
 * harus dikembalikan saat keluar.
 */
const express = require('express');
const { z } = require('zod');
const { db } = require('../db');
const { requireAuth, butuhIzin } = require('../middleware/auth');
const { ah, parse, httpError, dateRange } = require('../utils/http');
const { r2, ACC, postJournal, accountByCode } = require('../utils/accounting');
const { daftarkanEkspor } = require('../utils/ekspor');
const { todayLocal } = require('../utils/time');
const BATCH = require('../utils/batch');

const router = express.Router();
router.use(requireAuth);

const tanggal = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

const selesaiSchema = z.object({
  tanggal_selesai: tanggal.default(() => todayLocal()),
  // Biaya label dan kemasan baru. Menempel ke nilai barangnya, bukan menjadi
  // beban terpisah: barang itu memang jadi lebih mahal modalnya, dan HPP yang
  // tidak memuat biaya mengemasnya ulang membuat marginnya tampak lebih besar
  // daripada kenyataan.
  biaya_perbaikan: z.number().nonnegative().default(0),
  cash_code: z.string().trim().optional().nullable(),
  catatan: z.string().trim().max(300).optional().nullable(),
});

const hapusSchema = z.object({
  tanggal_hapus: tanggal.default(() => todayLocal()),
  catatan: z.string().trim().max(300).optional().nullable(),
});

function ambilBaris(id) {
  const row = db
    .prepare(
      `SELECT b.*, p.sku, p.name AS product_name, p.unit, p.stock, p.cost AS hpp_kini,
              r.return_no, r.return_date, u.name AS user_name
         FROM barang_perbaikan b
         JOIN products p ON p.id = b.product_id
         LEFT JOIN sales_returns r ON r.id = b.return_id
         LEFT JOIN users u ON u.id = b.user_id
        WHERE b.id = ?`
    )
    .get(id);
  if (!row) throw httpError(404, 'Barang perbaikan tidak ditemukan');
  return row;
}

const selesaikan = db.transaction((id, body, userId) => {
  const b = ambilBaris(id);
  if (b.status !== 'MENUNGGU') {
    throw httpError(409, `Barang ini sudah ${b.status === 'SELESAI' ? 'dikembalikan ke stok' : 'dihapus'}`);
  }

  const biaya = r2(body.biaya_perbaikan || 0);
  let kas = null;
  if (biaya > 0) {
    if (!body.cash_code) throw httpError(422, 'Pilih rekening pembayar biaya perbaikan');
    kas = accountByCode(body.cash_code);
    if (!kas.is_cash) throw httpError(422, `${kas.code} · ${kas.name} bukan rekening kas/bank`);
  }

  const produk = db.prepare('SELECT * FROM products WHERE id = ?').get(b.product_id);
  const qty = r2(b.qty);
  const nilaiBaru = r2(b.nilai + biaya);
  const hppSatuan = r2(nilaiBaru / qty);

  // ---------- barang kembali ke stok jual ----------
  //
  // HPP rata-rata WAJIB ikut dihitung ulang, memakai rumus yang sama dengan
  // barang masuk biasa. Barang ini kembali dengan modal yang berbeda dari
  // sebelumnya — biaya kemasan barunya menempel — dan kalau HPP produknya
  // dibiarkan, nilai persediaan di neraca tidak lagi sama dengan stok dikali
  // HPP di gudang. Selisih seperti itu tidak pernah bisa dijelaskan kemudian.
  const stokBaru = r2(produk.stock + qty);
  const hppBaru = stokBaru > 0
    ? r2((produk.stock * produk.cost + nilaiBaru) / stokBaru)
    : hppSatuan;
  db.prepare('UPDATE products SET stock = ?, cost = ? WHERE id = ?').run(stokBaru, hppBaru, produk.id);

  db.prepare(
    `INSERT INTO stock_moves
       (product_id, move_date, move_type, qty, unit_cost, balance_after, ref, source, source_id, note, user_id)
     VALUES (?,?,'IN',?,?,?,?, 'REPAIR', ?, ?, ?)`
  ).run(
    produk.id, body.tanggal_selesai, qty, hppSatuan, stokBaru,
    b.return_no || `PBK-${b.id}`, b.id,
    `Selesai dikemas ulang${body.catatan ? ` — ${body.catatan}` : ''}`, userId
  );

  // Batch tersendiri seperti barang retur: ia sudah pernah keluar gudang dan
  // sudah pernah dikerjakan ulang, dan itu justru yang perlu bisa ditelusuri.
  BATCH.masuk({
    product_id: produk.id, qty, unit_cost: hppSatuan, tanggal: body.tanggal_selesai,
    kode: `PERBAIKAN-${b.id}`, catatan: 'Barang retur yang sudah dikemas ulang',
    source: 'REPAIR', sourceId: b.id, userId,
  });

  // ---------- jurnal ----------
  // Nilai pindah dari pos "menunggu perbaikan" ke persediaan siap jual,
  // ditambah biaya mengemas ulangnya.
  const lines = [
    { code: ACC.INVENTORY, debit: nilaiBaru, credit: 0, memo: `Selesai diperbaiki: ${produk.name}` },
    { code: ACC.REPAIR_INVENTORY, debit: 0, credit: r2(b.nilai), memo: 'Keluar dari daftar perbaikan' },
  ];
  if (biaya > 0) {
    lines.push({ code: kas.code, debit: 0, credit: biaya, memo: 'Biaya label & kemasan baru' });
  }

  postJournal({
    date: body.tanggal_selesai,
    description: `Perbaikan selesai — ${produk.name}`,
    lines,
    source: 'REPAIR',
    sourceId: b.id,
    userId,
  });

  db.prepare(
    `UPDATE barang_perbaikan
        SET status = 'SELESAI', tanggal_selesai = ?, biaya_perbaikan = ?, biaya_kas_code = ?, catatan = ?
      WHERE id = ?`
  ).run(body.tanggal_selesai, biaya, kas ? kas.code : null, body.catatan || b.catatan || null, b.id);

  return { produk, qty, nilaiBaru, hppSatuan, stokBaru };
});

const hapuskan = db.transaction((id, body, userId) => {
  const b = ambilBaris(id);
  if (b.status !== 'MENUNGGU') {
    throw httpError(409, `Barang ini sudah ${b.status === 'SELESAI' ? 'dikembalikan ke stok' : 'dihapus'}`);
  }

  const nilai = r2(b.nilai);

  // Stok tidak disentuh sama sekali: barangnya memang tidak pernah masuk stok
  // jual sejak diretur. Yang terjadi hanya asetnya berubah menjadi kerugian.
  postJournal({
    date: body.tanggal_hapus,
    description: `Barang perbaikan dihapus — ${b.product_name}`,
    lines: [
      { code: ACC.DAMAGED_LOSS, debit: nilai, credit: 0, memo: `Tidak bisa diperbaiki: ${b.product_name}` },
      { code: ACC.REPAIR_INVENTORY, debit: 0, credit: nilai, memo: 'Keluar dari daftar perbaikan' },
    ],
    source: 'REPAIR_LOSS',
    sourceId: b.id,
    userId,
  });

  db.prepare(
    `UPDATE barang_perbaikan
        SET status = 'HAPUS', tanggal_selesai = ?, catatan = ?
      WHERE id = ?`
  ).run(body.tanggal_hapus, body.catatan || b.catatan || null, b.id);

  return { nama: b.product_name, qty: b.qty, unit: b.unit, nilai };
});

/**
 * Daftar barang perbaikan.
 *
 * Yang MENUNGGU selalu ditampilkan seluruhnya, tanpa memandang rentang
 * tanggal. Barang yang sudah lama menunggu justru tidak akan muncul di rentang
 * mana pun yang baru — dan merekalah yang paling perlu dilihat.
 */
function ambilPerbaikan(req) {
  const { from, to } = dateRange(req.query);
  const status = String((req.query && req.query.status) || '').toUpperCase();
  const hariIni = todayLocal();

  const rows = db
    .prepare(
      `SELECT b.*, p.sku, p.name AS product_name, p.unit,
              r.return_no, r.reason, u.name AS user_name
         FROM barang_perbaikan b
         JOIN products p ON p.id = b.product_id
         LEFT JOIN sales_returns r ON r.id = b.return_id
         LEFT JOIN users u ON u.id = b.user_id
        WHERE b.status = 'MENUNGGU'
           OR (b.tanggal_selesai BETWEEN ? AND ?)
        ORDER BY CASE b.status WHEN 'MENUNGGU' THEN 0 ELSE 1 END,
                 b.tanggal_masuk ASC, b.id ASC`
    )
    .all(from, to)
    .map((b) => ({
      ...b,
      umur_hari: Math.max(0, Math.round(
        (Date.parse(`${hariIni}T00:00:00Z`) - Date.parse(`${b.tanggal_masuk}T00:00:00Z`)) / 86400000
      )),
    }))
    .filter((b) => !status || b.status === status);

  const per = (st) => rows.filter((b) => b.status === st);
  const jum = (arr, f) => r2(arr.reduce((s, x) => s + f(x), 0));
  const menunggu = per('MENUNGGU');

  return {
    from, to, rows,
    ringkas: {
      menunggu: menunggu.length,
      nilaiMenunggu: jum(menunggu, (b) => b.nilai),
      qtyMenunggu: r2(menunggu.reduce((s, b) => s + b.qty, 0)),
      // Yang paling lama menunggu: itu yang perlu dikerjakan lebih dulu,
      // bukan yang nilainya paling besar.
      terlamaHari: menunggu.length ? Math.max(...menunggu.map((b) => b.umur_hari)) : 0,
      selesai: per('SELESAI').length,
      nilaiSelesai: jum(per('SELESAI'), (b) => r2(b.nilai + b.biaya_perbaikan)),
      biayaPerbaikan: jum(per('SELESAI'), (b) => b.biaya_perbaikan),
      dihapus: per('HAPUS').length,
      nilaiDihapus: jum(per('HAPUS'), (b) => b.nilai),
    },
  };
}

router.get('/', butuhIzin('gudang.lihat'), ah((req, res) => res.json(ambilPerbaikan(req))));

router.post('/:id(\\d+)/selesai', butuhIzin('gudang.mutasi'), ah((req, res) => {
  const body = parse(selesaiSchema, req.body);
  const h = selesaikan(Number(req.params.id), body, req.user.id);
  res.json({
    ok: true,
    message:
      `${h.qty} ${h.produk.unit} ${h.produk.name} kembali ke stok jual ` +
      `(HPP Rp ${h.hppSatuan.toLocaleString('id-ID')} per ${h.produk.unit})`,
  });
}));

router.post('/:id(\\d+)/hapus', butuhIzin('gudang.mutasi'), ah((req, res) => {
  const body = parse(hapusSchema, req.body);
  const h = hapuskan(Number(req.params.id), body, req.user.id);
  res.json({
    ok: true,
    message:
      `${h.qty} ${h.unit} ${h.nama} dihapus — Rp ${h.nilai.toLocaleString('id-ID')} ` +
      'dicatat sebagai kerugian barang rusak',
  });
}));

const LABEL_STATUS = { MENUNGGU: 'Menunggu dikerjakan', SELESAI: 'Selesai, kembali ke stok', HAPUS: 'Tidak bisa diperbaiki' };

daftarkanEkspor(router, {
  path: '/',
  judul: 'Barang Perlu Perbaikan',
  kolom: [
    { header: 'Tanggal Masuk', key: 'tanggal_masuk', width: 14 },
    { header: 'No. Retur', key: 'return_no', width: 18 },
    { header: 'SKU', key: 'sku', width: 16 },
    { header: 'Produk', key: 'product_name', width: 32 },
    { header: 'Jumlah', key: 'qty', width: 10 },
    { header: 'Satuan', key: 'unit', width: 9 },
    { header: 'Nilai', key: 'nilai', width: 16, money: true },
    { header: 'Umur (hari)', key: 'umur_hari', width: 12 },
    { header: 'Status', key: 'status_label', width: 24 },
    { header: 'Tanggal Selesai', key: 'tanggal_selesai', width: 15 },
    { header: 'Biaya Perbaikan', key: 'biaya_perbaikan', width: 16, money: true },
    { header: 'Catatan', key: 'catatan', width: 30 },
  ],
  ambil: (req) => {
    const d = ambilPerbaikan(req);
    return {
      rows: d.rows.map((b) => ({ ...b, status_label: LABEL_STATUS[b.status] || b.status })),
      subtitle:
        `Seluruh barang yang masih menunggu, ditambah yang selesai ${d.from} s/d ${d.to}`,
      meta: [
        ['Menunggu dikerjakan', d.ringkas.menunggu],
        ['Nilai yang menunggu', d.ringkas.nilaiMenunggu],
        ['Menunggu terlama (hari)', d.ringkas.terlamaHari],
        ['Selesai & kembali ke stok', d.ringkas.selesai],
        ['Biaya perbaikan', d.ringkas.biayaPerbaikan],
        ['Tidak bisa diperbaiki', d.ringkas.dihapus],
      ],
    };
  },
});

module.exports = router;
module.exports.ambilPerbaikan = ambilPerbaikan;
