'use strict';
/**
 * Identitas perusahaan yang boleh dilihat sebelum masuk.
 *
 * Halaman masuk perlu menampilkan nama dan logo, padahal saat itu belum ada
 * siapa pun yang login. Karena itu bagian ini sengaja dipisah dari /api/admin
 * yang seluruhnya butuh sesi: yang terbuka hanya nama, tagline, dan gambar
 * logo — tidak ada alamat, nomor telepon, NPWP, apalagi data orang.
 */
const express = require('express');
const fs = require('fs');
const path = require('path');
const { getSetting, setSetting } = require('../db');
const { requireAuth, butuhIzin } = require('../middleware/auth');
const { ah, httpError } = require('../utils/http');
const { UPLOAD_DIR, saveDataUrlImage, hapusBerkas } = require('../utils/upload');

const router = express.Router();

/** Batas jumlah gambar latar. Cukup untuk berganti-ganti, tidak sampai berat. */
const MAX_LATAR = 8;

/** Daftar nama berkas latar halaman masuk. Selalu berupa array. */
function daftarLatar() {
  try {
    const isi = JSON.parse(getSetting('login_backgrounds', '[]'));
    return Array.isArray(isi) ? isi.filter((n) => typeof n === 'string' && n) : [];
  } catch {
    // Isi yang rusak tidak boleh membuat halaman masuk gagal tampil.
    return [];
  }
}

function simpanDaftarLatar(daftar) {
  setSetting('login_backgrounds', JSON.stringify(daftar));
  setSetting('login_backgrounds_at', String(Date.now()));
}

/** GET /api/branding — dipakai halaman masuk dan sidebar. Tanpa perlu login. */
router.get('/', ah((req, res) => {
  const logo = getSetting('company_logo', '');
  const v = getSetting('login_backgrounds_at', '1');
  res.json({
    company: getSetting('company_name', 'Perusahaan'),
    tagline: getSetting('company_tagline', ''),
    // Ditambahi penanda waktu agar peramban mengambil ulang gambarnya setelah
    // logo diganti, bukan menampilkan yang tersimpan di cache.
    logo: logo ? `/api/branding/logo?v=${getSetting('company_logo_at', '1')}` : null,
    // Hanya alamat gambarnya yang dibagikan, bukan nama berkas di server.
    latar: daftarLatar().map((_, i) => `/api/branding/latar/${i}?v=${v}`),
  });
}));

/** GET /api/branding/latar/:i — satu gambar latar halaman masuk. Terbuka. */
router.get('/latar/:i(\\d+)', ah((req, res) => {
  const daftar = daftarLatar();
  const nama = daftar[Number(req.params.i)];
  if (!nama) throw httpError(404, 'Gambar latar tidak ada');

  const berkas = path.join(UPLOAD_DIR, path.basename(nama));
  if (!fs.existsSync(berkas)) throw httpError(404, 'Berkas latar tidak ditemukan');

  res.setHeader('Cache-Control', 'public, max-age=86400');
  res.sendFile(berkas);
}));

/** POST /api/branding/latar — tambah satu gambar latar. */
router.post('/latar', requireAuth, butuhIzin('sistem.pengaturan'), ah((req, res) => {
  const { gambar } = req.body || {};
  if (!gambar) throw httpError(400, 'Gambar belum dipilih');

  const daftar = daftarLatar();
  if (daftar.length >= MAX_LATAR) {
    throw httpError(422, `Maksimal ${MAX_LATAR} gambar latar — hapus salah satu dulu`);
  }

  daftar.push(saveDataUrlImage(gambar, 'latar'));
  simpanDaftarLatar(daftar);

  res.json({ ok: true, jumlah: daftar.length, message: 'Gambar latar ditambahkan' });
}));

/** DELETE /api/branding/latar/:i — hapus satu gambar latar. */
router.delete('/latar/:i(\\d+)', requireAuth, butuhIzin('sistem.pengaturan'), ah((req, res) => {
  const daftar = daftarLatar();
  const i = Number(req.params.i);
  if (!daftar[i]) throw httpError(404, 'Gambar latar tidak ada');

  hapusBerkas(daftar[i]);
  daftar.splice(i, 1);
  simpanDaftarLatar(daftar);

  res.json({ ok: true, jumlah: daftar.length, message: 'Gambar latar dihapus' });
}));

/** GET /api/branding/logo — gambar logo. Terbuka, sama seperti logo di kop surat. */
router.get('/logo', ah((req, res) => {
  const nama = getSetting('company_logo', '');
  if (!nama) throw httpError(404, 'Logo belum diunggah');

  const berkas = path.join(UPLOAD_DIR, path.basename(nama));
  if (!fs.existsSync(berkas)) throw httpError(404, 'Berkas logo tidak ditemukan');

  res.setHeader('Cache-Control', 'public, max-age=86400');
  res.sendFile(berkas);
}));

/** PUT /api/branding/logo — ganti logo. Dikirim sebagai data URL dari peramban. */
router.put('/logo', requireAuth, butuhIzin('sistem.pengaturan'), ah((req, res) => {
  const { logo } = req.body || {};
  const lama = getSetting('company_logo', '');

  if (!logo) {
    hapusBerkas(lama);
    setSetting('company_logo', '');
    setSetting('company_logo_at', String(Date.now()));
    return res.json({ ok: true, message: 'Logo dihapus', logo: null });
  }

  const baru = saveDataUrlImage(logo, 'logo');
  hapusBerkas(lama);
  setSetting('company_logo', baru);
  setSetting('company_logo_at', String(Date.now()));

  res.json({ ok: true, message: 'Logo perusahaan diperbarui', logo: `/api/branding/logo?v=${Date.now()}` });
}));

module.exports = router;
