'use strict';
/**
 * Pencatat riwayat perubahan.
 *
 * Dipasang sekali sebagai middleware untuk seluruh API, bukan satu per satu di
 * tiap endpoint. Alasannya sama dengan penjaga izin di server.js: yang dipasang
 * satu per satu akan terlupakan pada endpoint berikutnya, dan kelalaian itu
 * tidak menimbulkan galat apa pun sampai ada yang mencari riwayat sebuah
 * perubahan dan tidak menemukannya.
 *
 * Yang dicatat hanya permintaan yang mengubah data. Membaca laporan bukan
 * peristiwa yang perlu diingat, dan mencatatnya justru menenggelamkan yang
 * benar-benar penting di antara ribuan baris tak berguna.
 */
const { db } = require('../db');

/** Kunci yang isinya tidak boleh ikut tercatat, apa pun keadaannya. */
const RAHASIA = [
  'password', 'password_baru', 'password_lama', 'passwordLama', 'passwordBaru',
  'token', 'secret', 'jwt', 'authorization',
];

/** Kunci yang isinya besar dan tidak menolong siapa pun bila disimpan. */
const BESAR = ['photo', 'foto', 'in_photo', 'out_photo', 'logo', 'gambar', 'image'];

const MAKS = 4000;

/**
 * Menyalin badan permintaan tanpa kata sandi dan tanpa gambar.
 *
 * Riwayat yang menyimpan kata sandi berubah dari catatan pengaman menjadi
 * kebocoran; dan foto selfie base64 satu megabyte per baris akan membuat tabel
 * riwayat lebih besar daripada seluruh data yang dijaganya.
 */
function saring(nilai, dalam = 0) {
  if (nilai === null || nilai === undefined) return nilai;
  if (dalam > 4) return '[terlalu dalam]';

  if (Array.isArray(nilai)) {
    if (nilai.length > 50) return `[${nilai.length} baris]`;
    return nilai.map((v) => saring(v, dalam + 1));
  }

  if (typeof nilai === 'object') {
    const keluar = {};
    for (const [k, v] of Object.entries(nilai)) {
      const kunci = k.toLowerCase();
      if (RAHASIA.some((r) => kunci.includes(r))) {
        keluar[k] = '[disembunyikan]';
      } else if (BESAR.some((b) => kunci.includes(b)) && typeof v === 'string' && v.length > 200) {
        keluar[k] = `[gambar ${v.length} karakter]`;
      } else {
        keluar[k] = saring(v, dalam + 1);
      }
    }
    return keluar;
  }

  if (typeof nilai === 'string' && nilai.length > 500) return `${nilai.slice(0, 500)}…`;
  return nilai;
}

const MENGUBAH = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * Nama modul dari alamatnya.
 *
 * Awalan "api" dibuang: seluruh alamat dimulai dengannya, sehingga memakainya
 * apa adanya membuat setiap baris riwayat bermodul "api" dan penyaring per
 * modul tidak menyaring apa pun.
 */
function modulDari(path) {
  const bagian = String(path).split('/').filter(Boolean);
  if (bagian[0] === 'api') bagian.shift();
  return (bagian[0] || '-').toLowerCase();
}

const simpan = db.prepare(
  `INSERT INTO audit_log (user_id, user_name, method, path, modul, status, berhasil, ringkas, isi, ip)
   VALUES (?,?,?,?,?,?,?,?,?,?)`
);

function jejak(req, res, next) {
  if (!MENGUBAH.has(req.method)) return next();

  // Badan permintaan disalin SEBELUM endpoint berjalan. Sebagian endpoint
  // mengubah req.body di tempat, dan yang tercatat nanti bukan lagi apa yang
  // sebenarnya dikirim.
  let isi = null;
  try {
    isi = req.body && Object.keys(req.body).length
      ? JSON.stringify(saring(req.body)).slice(0, MAKS)
      : null;
  } catch {
    isi = null;
  }

  const asli = res.json.bind(res);
  res.json = (badan) => {
    try {
      const status = res.statusCode;
      const pesan = badan && (badan.message || badan.error);
      simpan.run(
        req.user ? req.user.id : null,
        req.user ? req.user.name || req.user.email : null,
        req.method,
        req.originalUrl.split('?')[0].slice(0, 300),
        modulDari(req.baseUrl || req.originalUrl),
        status,
        status < 400 ? 1 : 0,
        pesan ? String(pesan).slice(0, 300) : null,
        isi,
        req.ip || null
      );
    } catch {
      // Riwayat yang gagal dicatat tidak boleh menggagalkan pekerjaan yang
      // sudah terlanjur dikerjakan endpoint-nya.
    }
    return asli(badan);
  };

  return next();
}

module.exports = { jejak, saring };
