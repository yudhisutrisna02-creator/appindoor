'use strict';
/**
 * Riwayat perubahan & tutup buku.
 *
 * Dua hal yang saling melengkapi. Riwayat menjawab "siapa mengubah apa dan
 * kapan" — pertanyaan yang sebelumnya tidak bisa dijawab sama sekali, padahal
 * ada sepuluh akun dengan peran berbeda dan order penjualan bisa diubah
 * nominalnya. Tutup buku menjawab "apakah laporan bulan lalu masih sama seperti
 * saat saya membacanya".
 *
 * Riwayat hanya bisa dibaca, tidak pernah diubah atau dihapus dari sini.
 * Catatan pengaman yang bisa dirapikan pelakunya sendiri tidak mengamankan
 * apa pun.
 */
const express = require('express');
const { z } = require('zod');
const { db } = require('../db');
const { requireAuth, butuhIzin } = require('../middleware/auth');
const { ah, parse, httpError, dateRange } = require('../utils/http');
const { daftarkanEkspor } = require('../utils/ekspor');
const { todayLocal } = require('../utils/time');

const router = express.Router();
router.use(requireAuth);

const PERIODE = /^\d{4}-\d{2}$/;

const AKSI = {
  POST: 'Tambah',
  PUT: 'Ubah',
  PATCH: 'Ubah',
  DELETE: 'Hapus',
};

// ==================================================================
// RIWAYAT PERUBAHAN
// ==================================================================
function ambilRiwayat(req) {
  const { from, to } = dateRange(req.query);
  const batas = Math.min(1000, Math.max(20, Number(req.query.limit) || 200));

  const where = ['a.at BETWEEN ? AND ?'];
  // Rentang tanggal dibandingkan terhadap kolom waktu lengkap, jadi batas
  // atasnya perlu mencakup seluruh hari itu.
  const params = [`${from} 00:00:00`, `${to} 23:59:59`];

  if (req.query.modul) {
    where.push('a.modul = ?');
    params.push(String(req.query.modul).toLowerCase());
  }
  if (req.query.user_id) {
    where.push('a.user_id = ?');
    params.push(Number(req.query.user_id));
  }
  if (req.query.hanyaGagal === '1') where.push('a.berhasil = 0');

  const rows = db
    .prepare(
      `SELECT a.* FROM audit_log a
        WHERE ${where.join(' AND ')}
        ORDER BY a.id DESC LIMIT ?`
    )
    .all(...params, batas)
    .map((r) => ({
      ...r,
      aksi: AKSI[r.method] || r.method,
      berhasil: !!r.berhasil,
      // Isi permintaan disimpan sebagai teks; diuraikan di sini supaya layar
      // tidak perlu tahu bentuk penyimpanannya.
      isi: r.isi ? amanJson(r.isi) : null,
    }));

  const total = db
    .prepare(`SELECT COUNT(*) c FROM audit_log a WHERE ${where.join(' AND ')}`)
    .get(...params).c;

  const perModul = db
    .prepare(
      `SELECT a.modul, COUNT(*) c FROM audit_log a
        WHERE ${where.join(' AND ')} GROUP BY a.modul ORDER BY c DESC`
    )
    .all(...params);

  const perOrang = db
    .prepare(
      `SELECT a.user_id, a.user_name, COUNT(*) c FROM audit_log a
        WHERE ${where.join(' AND ')} GROUP BY a.user_id ORDER BY c DESC`
    )
    .all(...params);

  return {
    from,
    to,
    rows,
    total,
    terpotong: total > rows.length,
    perModul,
    perOrang,
    ringkas: {
      total,
      gagal: db
        .prepare(`SELECT COUNT(*) c FROM audit_log a WHERE ${where.join(' AND ')} AND a.berhasil = 0`)
        .get(...params).c,
      orang: perOrang.length,
      modul: perModul.length,
    },
  };
}

/** Isi yang gagal diuraikan dikembalikan apa adanya, bukan menggagalkan halaman. */
function amanJson(teks) {
  try {
    return JSON.parse(teks);
  } catch {
    return { _mentah: teks };
  }
}

router.get('/', butuhIzin('sistem.riwayat'), ah((req, res) => res.json(ambilRiwayat(req))));

daftarkanEkspor(router, {
  path: '/',
  judul: 'Riwayat Perubahan',
  kolom: [
    { header: 'Waktu', key: 'at', width: 20 },
    { header: 'Oleh', key: 'user_name', width: 22 },
    { header: 'Aksi', key: 'aksi', width: 10 },
    { header: 'Modul', key: 'modul', width: 14 },
    { header: 'Alamat', key: 'path', width: 38 },
    { header: 'Status', key: 'status', width: 9 },
    { header: 'Keterangan', key: 'ringkas', width: 40 },
  ],
  ambil: (req) => {
    const d = ambilRiwayat(req);
    return {
      rows: d.rows,
      subtitle: `Periode ${d.from} s/d ${d.to} — ${d.total} perubahan`,
      meta: [
        ['Jumlah perubahan', d.ringkas.total],
        ['Yang gagal', d.ringkas.gagal],
        ['Orang yang mengubah', d.ringkas.orang],
      ],
    };
  },
});

// ==================================================================
// TUTUP BUKU
// ==================================================================
const kunciSchema = z.object({
  period: z.string().regex(PERIODE, 'periode harus berbentuk YYYY-MM'),
  note: z.string().trim().max(300).optional().nullable(),
});

/**
 * Daftar bulan beserta keadaan terkuncinya.
 *
 * Yang didaftar adalah gabungan bulan yang punya jurnal DAN bulan yang sedang
 * terkunci. Bulan bisa ditutup sebelum ada jurnalnya — untuk menghalangi
 * transaksi bertanggal mundur, misalnya — dan bila daftarnya hanya diambil dari
 * jurnal, bulan seperti itu terkunci tanpa pernah muncul di layar, sehingga
 * tidak ada cara membukanya kembali.
 */
function ambilPeriode() {
  const bulan = db
    .prepare(
      `SELECT period,
              SUM(jurnal) AS jurnal,
              MIN(awal)   AS awal,
              MAX(akhir)  AS akhir
         FROM (
           SELECT substr(j.entry_date, 1, 7) AS period,
                  COUNT(*) AS jurnal,
                  MIN(j.entry_date) AS awal,
                  MAX(j.entry_date) AS akhir
             FROM journals j
            GROUP BY period
           UNION ALL
           SELECT p.period, 0, NULL, NULL FROM period_locks p
         )
        GROUP BY period ORDER BY period DESC`
    )
    .all();

  const kunci = new Map(
    db
      .prepare(
        `SELECT p.*, u.name AS oleh FROM period_locks p
           LEFT JOIN users u ON u.id = p.locked_by`
      )
      .all()
      .map((k) => [k.period, k])
  );

  const sekarang = todayLocal().slice(0, 7);

  return bulan.map((b) => {
    const k = kunci.get(b.period);
    return {
      ...b,
      terkunci: !!k,
      locked_at: k ? k.locked_at : null,
      oleh: k ? k.oleh : null,
      note: k ? k.note : null,
      // Bulan berjalan masih menerima transaksi baru setiap hari; menutupnya
      // hanya akan menghalangi pekerjaan hari ini.
      berjalan: b.period === sekarang,
    };
  });
}

router.get('/periode', butuhIzin('keuangan.lihat'), ah((req, res) => {
  const rows = ambilPeriode();
  res.json({
    rows,
    ringkas: {
      total: rows.length,
      terkunci: rows.filter((r) => r.terkunci).length,
      terbuka: rows.filter((r) => !r.terkunci).length,
    },
  });
}));

router.post('/periode/kunci', butuhIzin('keuangan.tutupbuku'), ah((req, res) => {
  const body = parse(kunciSchema, req.body);

  if (body.period === todayLocal().slice(0, 7)) {
    throw httpError(422, 'Bulan yang sedang berjalan tidak bisa ditutup — masih ada transaksi tiap hari');
  }
  const ada = db.prepare('SELECT period FROM period_locks WHERE period = ?').get(body.period);
  if (ada) throw httpError(409, `Bulan ${body.period} sudah ditutup`);

  db.prepare('INSERT INTO period_locks (period, locked_by, note) VALUES (?,?,?)')
    .run(body.period, req.user.id, body.note || null);

  res.status(201).json({
    ok: true,
    message: `Bulan ${body.period} ditutup — jurnalnya tidak bisa diubah lagi`,
  });
}));

router.delete('/periode/:period', butuhIzin('keuangan.tutupbuku'), ah((req, res) => {
  const period = String(req.params.period);
  if (!PERIODE.test(period)) throw httpError(400, 'Periode harus berbentuk YYYY-MM');

  const ada = db.prepare('SELECT period FROM period_locks WHERE period = ?').get(period);
  if (!ada) throw httpError(404, `Bulan ${period} tidak sedang ditutup`);

  db.prepare('DELETE FROM period_locks WHERE period = ?').run(period);
  // Pembukaan kembali tercatat sendiri lewat middleware riwayat, jadi tidak ada
  // yang bisa membuka buku lalu mengubah angkanya tanpa meninggalkan jejak.
  res.json({ ok: true, message: `Tutup buku ${period} dibuka kembali` });
}));

module.exports = router;
