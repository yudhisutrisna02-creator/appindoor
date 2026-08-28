'use strict';
/**
 * Pencadangan basis data.
 *
 * Berkas cadangan berisi SELURUH isi aplikasi, termasuk hash kata sandi setiap
 * akun. Karena itu ia tidak pernah diletakkan di folder yang dilayani sebagai
 * berkas statis, dan seluruh endpoint di sini menuntut izin tersendiri —
 * bukan sekadar "sudah login".
 *
 * Tidak ada endpoint pemulihan di sini, dan itu disengaja. Memulihkan berarti
 * menimpa basis data yang sedang melayani; satu permintaan HTTP yang salah
 * kirim akan menghapus pekerjaan berhari-hari tanpa bisa dibatalkan. Pemulihan
 * dikerjakan dengan mengganti berkasnya saat aplikasi berhenti, dan langkahnya
 * ikut dikirim bersama daftar cadangan supaya tidak perlu dicari-cari saat
 * sedang panik.
 */
const express = require('express');
const fs = require('fs');
const { requireAuth, butuhIzin } = require('../middleware/auth');
const { ah, httpError } = require('../utils/http');
const {
  daftarCadangan, buatCadangan, jalurCadangan, infoBasisData, pangkas,
} = require('../utils/cadangan');

const router = express.Router();
router.use(requireAuth);
router.use(butuhIzin('sistem.cadangan'));

const LANGKAH_PULIH = [
  'Unduh berkas cadangan yang ingin dipakai.',
  'Hentikan aplikasi lebih dulu — menimpa berkas yang sedang dipakai akan merusaknya.',
  'Simpan dulu basis data yang sekarang dengan nama lain, jangan langsung ditimpa.',
  'Hapus juga berkas -wal dan -shm yang bersebelahan bila ada; keduanya milik basis data lama.',
  'Salin berkas cadangan menjadi nama berkas basis data, lalu jalankan aplikasi kembali.',
];

router.get('/', ah((req, res) => {
  const rows = daftarCadangan();
  res.json({
    rows,
    info: infoBasisData(),
    ringkas: {
      jumlah: rows.length,
      otomatis: rows.filter((r) => r.jenis === 'otomatis').length,
      manual: rows.filter((r) => r.jenis === 'manual').length,
      terbaru: rows.length ? rows[0].dibuat : null,
      totalUkuran: rows.reduce((s, r) => s + r.ukuran, 0),
    },
    langkahPulih: LANGKAH_PULIH,
  });
}));

router.post('/', ah(async (req, res) => {
  const hasil = await buatCadangan('manual');
  pangkas();
  res.status(201).json({
    ok: true,
    cadangan: hasil,
    message: `Cadangan ${hasil.nama} dibuat (${hasil.ukuranTeks})`,
  });
}));

/**
 * Mengunduh satu cadangan.
 *
 * Berkasnya dialirkan, bukan dibaca seluruhnya ke memori: basis data yang sudah
 * besar akan menghabiskan memori proses hanya untuk satu unduhan.
 */
router.get('/:nama/unduh', ah((req, res) => {
  const jalur = jalurCadangan(req.params.nama);
  if (!jalur) throw httpError(404, 'Berkas cadangan tidak ditemukan');

  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Content-Disposition', `attachment; filename="${req.params.nama}"`);
  res.setHeader('Content-Length', fs.statSync(jalur).size);
  fs.createReadStream(jalur).pipe(res);
}));

/**
 * Membuat cadangan baru lalu langsung mengunduhnya.
 *
 * Dipakai menjelang sesuatu yang berisiko: yang dibutuhkan saat itu adalah
 * salinan keadaan tepat sebelum tindakan, bukan cadangan otomatis semalam.
 */
router.get('/unduh-sekarang', ah(async (req, res) => {
  const hasil = await buatCadangan('manual');
  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Content-Disposition', `attachment; filename="${hasil.nama}"`);
  res.setHeader('Content-Length', hasil.ukuran);
  fs.createReadStream(hasil.jalur).pipe(res);
}));

router.delete('/:nama', ah((req, res) => {
  const jalur = jalurCadangan(req.params.nama);
  if (!jalur) throw httpError(404, 'Berkas cadangan tidak ditemukan');

  const tersisa = daftarCadangan().length;
  // Cadangan terakhir tidak boleh dihapus lewat layar. Yang menghapusnya
  // biasanya sedang membereskan daftar, bukan sedang bermaksud kehilangan
  // satu-satunya salinan yang tersisa.
  if (tersisa <= 1) throw httpError(422, 'Ini cadangan terakhir — buat cadangan baru dulu sebelum menghapusnya');

  fs.unlinkSync(jalur);
  res.json({ ok: true, message: `Cadangan ${req.params.nama} dihapus` });
}));

module.exports = router;
