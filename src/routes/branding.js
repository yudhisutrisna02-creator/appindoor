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
const { requireAuth, requireRole } = require('../middleware/auth');
const { ah, httpError } = require('../utils/http');
const { UPLOAD_DIR, saveDataUrlImage, hapusBerkas } = require('../utils/upload');

const router = express.Router();

/** GET /api/branding — dipakai halaman masuk dan sidebar. Tanpa perlu login. */
router.get('/', ah((req, res) => {
  const logo = getSetting('company_logo', '');
  res.json({
    company: getSetting('company_name', 'Perusahaan'),
    tagline: getSetting('company_tagline', ''),
    // Ditambahi penanda waktu agar peramban mengambil ulang gambarnya setelah
    // logo diganti, bukan menampilkan yang tersimpan di cache.
    logo: logo ? `/api/branding/logo?v=${getSetting('company_logo_at', '1')}` : null,
  });
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
router.put('/logo', requireAuth, requireRole('admin'), ah((req, res) => {
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
