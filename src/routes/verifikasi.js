'use strict';
/**
 * Pemeriksaan keaslian dokumen — TANPA LOGIN.
 *
 * Sengaja terbuka. Yang memegang slip gaji dan nota supplier justru pihak yang
 * tidak punya akun di sini: pegawai dan supplier. Halaman pemeriksaan yang
 * menuntut masuk lebih dulu tidak menolong satu pun dari mereka.
 *
 * Yang menjaganya bukan login melainkan tokennya: 24 byte acak, tidak berurutan,
 * dan tidak bisa ditebak dari token dokumen lain. Konsekuensinya jujur dan perlu
 * disebut apa adanya — siapa pun yang memegang tautannya bisa melihat isi
 * dokumen itu, persis seperti siapa pun yang memegang kertasnya. Karena itu
 * tautannya bisa dicabut kapan saja dari dalam aplikasi.
 *
 * Yang ditampilkan hanya satu dokumen, tidak pernah daftar. Tidak ada endpoint
 * di sini yang bisa dipakai menyisir dokumen lain.
 */
const express = require('express');
const { db, getSetting } = require('../db');
const { ah, httpError } = require('../utils/http');
const { kodeSingkat, sidik } = require('../utils/ttd');
const { isiDokumen } = require('../utils/dokumen');

const router = express.Router();

const TOKEN = /^[0-9a-f]{48}$/;

const cariToken = db.prepare('SELECT * FROM document_signatures WHERE token = ?');

router.get('/:token', ah((req, res) => {
  const token = String(req.params.token || '').toLowerCase();
  // Bentuk token diperiksa lebih dulu supaya tebakan asal tidak pernah sampai
  // menyentuh basis data.
  if (!TOKEN.test(token)) throw httpError(404, 'Dokumen tidak ditemukan');

  const ttd = cariToken.get(token);
  if (!ttd) throw httpError(404, 'Dokumen tidak ditemukan');

  const perusahaan = getSetting('company_name', 'Perusahaan');

  if (ttd.revoked_at) {
    return res.status(410).json({
      status: 'dicabut',
      perusahaan,
      nomor: ttd.doc_no,
      dicabut_pada: ttd.revoked_at,
      pesan: 'Tautan dokumen ini sudah dicabut oleh penerbitnya.',
    });
  }

  const isi = isiDokumen(ttd);
  if (!isi) {
    // Dokumennya sudah tidak ada lagi — daftar gajinya dihapus, misalnya.
    return res.status(410).json({
      status: 'hilang',
      perusahaan,
      nomor: ttd.doc_no,
      pesan: 'Dokumen sumbernya sudah tidak ada pada sistem.',
    });
  }

  const sidikSekarang = sidik(isi.kanonik);
  const sama = sidikSekarang === ttd.hash;

  res.json({
    status: sama ? 'sah' : 'berubah',
    perusahaan,
    penerbit: `Sistem ERP ${perusahaan}`,
    nomor: ttd.doc_no,
    jenis: isi.tampil.jenis,
    versi: ttd.version,
    diterbitkan: ttd.issued_at,
    dicetak: ttd.cetak,
    kode: kodeSingkat(ttd.hash),
    kodeSekarang: kodeSingkat(sidikSekarang),
    dokumen: isi.tampil,
    pesan: sama
      ? 'Dokumen ini benar dikeluarkan oleh sistem dan isinya masih sama seperti saat diterbitkan.'
      : 'Dokumen ini dikeluarkan oleh sistem, tetapi datanya sudah berubah sejak lembar itu dicetak. Cocokkan kode pada lembar Anda dengan kode terbaru di bawah.',
  });
}));

module.exports = router;
