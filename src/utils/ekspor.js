'use strict';
/**
 * Pendaftar endpoint unduhan.
 *
 * Setiap menu perlu Excel dan PDF dengan isi yang sama. Menuliskannya dua kali
 * per menu berarti dua puluh tempat yang bisa berbeda diam-diam — satu kolom
 * ditambahkan ke Excel, lupa ditambahkan ke PDF, dan tidak ada yang tahu sampai
 * ada yang membandingkan. Di sini satu definisi kolom menghasilkan keduanya.
 */
const { tableExcel, tablePdf } = require('./exporters');
const { ah } = require('./http');
const { getSetting } = require('../db');

/** Nama berkas yang aman untuk semua sistem operasi. */
function namaBerkas(dasar, ekstensi) {
  const bersih = String(dasar)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
  const stempel = new Date().toISOString().slice(0, 10);
  return `${bersih}-${stempel}.${ekstensi}`;
}

/**
 * Daftarkan sepasang endpoint unduhan pada sebuah router.
 *
 * @param {import('express').Router} router
 * @param {object} opsi
 * @param {string} opsi.path awalan endpoint, mis. '/products' — hasilnya
 *        '/products/export/excel' dan '/products/export/pdf'
 * @param {string} opsi.judul judul yang tampil di kepala berkas
 * @param {Array} opsi.kolom definisi kolom, dipakai kedua format
 * @param {(req) => {rows: Array, meta?: Array, subtitle?: string}} opsi.ambil
 *        pengambil data; menerima request agar penyaring yang sedang aktif di
 *        layar ikut terbawa ke berkas yang diunduh
 */
function daftarkanEkspor(router, { path, judul, kolom, ambil }) {
  const kirim = (bentuk) =>
    ah(async (req, res) => {
      const { rows, meta = [], subtitle = '' } = await ambil(req);
      const perusahaan = getSetting('company_name', 'Perusahaan');

      if (bentuk === 'excel') {
        const buffer = await tableExcel(judul, kolom, rows, meta);
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', `attachment; filename="${namaBerkas(judul, 'xlsx')}"`);
        return res.send(Buffer.from(buffer));
      }

      const buffer = await tablePdf(judul, subtitle, kolom, rows, meta, perusahaan);
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="${namaBerkas(judul, 'pdf')}"`);
      return res.send(buffer);
    });

  router.get(`${path}/export/excel`, kirim('excel'));
  router.get(`${path}/export/pdf`, kirim('pdf'));
}

module.exports = { daftarkanEkspor, namaBerkas };
