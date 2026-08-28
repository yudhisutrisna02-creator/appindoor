'use strict';
/**
 * Pencadangan basis data.
 *
 * Seluruh isi aplikasi — penjualan, stok, jurnal, gaji — ada di satu berkas
 * SQLite. Menyalinnya dengan copy biasa tidak aman: berkasnya sedang dipakai,
 * dan pada mode WAL sebagian transaksi terakhir masih berada di berkas -wal
 * yang terpisah. Salinan seperti itu bisa terbuka tanpa keluhan apa pun tetapi
 * kehilangan transaksi terakhir — kerusakan yang baru ketahuan justru pada saat
 * cadangannya dibutuhkan.
 *
 * Karena itu dipakai db.backup() bawaan SQLite, yang menyalin lewat mesinnya
 * sendiri sehingga hasilnya utuh dan konsisten walau aplikasi sedang melayani
 * permintaan.
 *
 * Berkas cadangan berisi SELURUH data termasuk hash kata sandi. Ia tidak pernah
 * diletakkan di dalam folder yang dilayani sebagai berkas statis, dan
 * mengunduhnya menuntut izin tersendiri.
 */
const fs = require('fs');
const path = require('path');
const { db, dbFile } = require('../db');
const { todayLocal } = require('./time');

/**
 * Folder cadangan.
 *
 * Bersebelahan dengan basis datanya, bukan di dalam folder rilis: di Hostinger
 * folder rilis diganti setiap kali aplikasi diperbarui, dan cadangan yang ikut
 * terhapus setiap deploy bukan cadangan.
 */
function folderCadangan() {
  const dari = process.env.BACKUP_DIR;
  const folder = dari
    ? (path.isAbsolute(dari) ? dari : path.resolve(process.cwd(), dari))
    : path.join(path.dirname(dbFile), 'backups');
  fs.mkdirSync(folder, { recursive: true });
  return folder;
}

/** Berapa banyak cadangan otomatis yang disimpan sebelum yang terlama dibuang. */
const SIMPAN = Number(process.env.BACKUP_KEEP || 14);

// Akhiran angka di belakang jenis menampung cadangan yang dibuat pada detik
// yang sama. Tanpa itu, dua cadangan berturut-turut mendapat nama yang sama dan
// yang kedua menimpa yang pertama tanpa keluhan apa pun.
const POLA = /^erp-(\d{4}-\d{2}-\d{2})(?:-(\d{6}))?(?:-(otomatis|manual))?(?:-(\d+))?\.db$/;

const ukuranTerbaca = (b) => {
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  return `${(b / 1024 / 1024).toFixed(1)} MB`;
};

/** Daftar cadangan yang ada, terbaru lebih dulu. */
function daftarCadangan() {
  const folder = folderCadangan();
  return fs
    .readdirSync(folder)
    .filter((n) => POLA.test(n))
    .map((nama) => {
      const st = fs.statSync(path.join(folder, nama));
      const m = POLA.exec(nama);
      return {
        nama,
        tanggal: m[1],
        jenis: m[3] || 'manual',
        ukuran: st.size,
        ukuranTeks: ukuranTerbaca(st.size),
        dibuat: st.mtime.toISOString(),
      };
    })
    .sort((a, b) => (a.dibuat < b.dibuat ? 1 : -1));
}

/** Membuang cadangan otomatis terlama bila jumlahnya melewati batas. */
function pangkas() {
  const folder = folderCadangan();
  // Hanya cadangan otomatis yang dipangkas. Yang dibuat sendiri oleh pemilik
  // biasanya dibuat menjelang sesuatu yang berisiko, dan menghapusnya diam-diam
  // justru membuang salinan yang paling ingin ia simpan.
  const otomatis = daftarCadangan().filter((c) => c.jenis === 'otomatis');
  const buang = otomatis.slice(SIMPAN);
  for (const c of buang) {
    try {
      fs.unlinkSync(path.join(folder, c.nama));
    } catch {
      /* sudah hilang duluan — tidak perlu digagalkan */
    }
  }
  return buang.map((c) => c.nama);
}

/**
 * Membuat satu cadangan.
 *
 * @param {'otomatis'|'manual'} jenis
 * @returns {Promise<{nama: string, ukuran: number, jalur: string}>}
 */
async function buatCadangan(jenis = 'manual') {
  const folder = folderCadangan();
  const jam = new Date().toTimeString().slice(0, 8).replace(/:/g, '');
  const dasar = `erp-${todayLocal()}-${jam}-${jenis}`;

  // Nama yang sudah terpakai diberi urutan, bukan ditimpa. Dua cadangan yang
  // dibuat pada detik yang sama adalah hal biasa — menekan tombolnya dua kali
  // sudah cukup — dan kehilangan salah satunya diam-diam justru terjadi pada
  // fitur yang gunanya menjaga agar tidak ada yang hilang.
  let nama = `${dasar}.db`;
  let urut = 2;
  while (fs.existsSync(path.join(folder, nama))) {
    nama = `${dasar}-${urut}.db`;
    urut += 1;
  }
  const jalur = path.join(folder, nama);

  await db.backup(jalur);

  const st = fs.statSync(jalur);
  return { nama, ukuran: st.size, ukuranTeks: ukuranTerbaca(st.size), jalur, jenis };
}

/** Jalur sebuah cadangan, setelah dipastikan namanya memang milik folder itu. */
function jalurCadangan(nama) {
  // Nama diperiksa dengan pola, bukan sekadar dibersihkan: satu-satunya bentuk
  // yang diterima adalah nama yang dihasilkan fungsi di atas. Dengan begitu
  // tidak ada jalan memakai endpoint ini untuk mengambil berkas lain.
  if (!POLA.test(nama)) return null;
  const jalur = path.join(folderCadangan(), nama);
  return fs.existsSync(jalur) ? jalur : null;
}

/** Keterangan basis data yang sedang dipakai. */
function infoBasisData() {
  const st = fs.existsSync(dbFile) ? fs.statSync(dbFile) : null;
  const tabel = (nama) => {
    try {
      return db.prepare(`SELECT COUNT(*) c FROM ${nama}`).get().c;
    } catch {
      return null;
    }
  };

  return {
    berkas: dbFile,
    folder: folderCadangan(),
    ukuran: st ? st.size : 0,
    ukuranTeks: st ? ukuranTerbaca(st.size) : '-',
    simpanMaks: SIMPAN,
    isi: {
      produk: tabel('products'),
      order: tabel('sales_orders'),
      mutasi: tabel('stock_moves'),
      jurnal: tabel('journals'),
      pengguna: tabel('users'),
    },
  };
}

/**
 * Pencadangan harian.
 *
 * Sengaja memakai selang waktu sederhana, bukan penjadwal: aplikasinya satu
 * proses dan tidak perlu penjadwal yang harus ikut dipelihara. Cadangan pertama
 * dibuat sesaat setelah menyala supaya server yang jarang hidup lama tetap
 * meninggalkan salinan.
 */
function mulaiJadwal() {
  if (process.env.BACKUP_AUTO === 'off') return null;

  const jalankan = async (alasan) => {
    try {
      const hasil = await buatCadangan('otomatis');
      const dibuang = pangkas();
      console.log(
        `Cadangan ${alasan}: ${hasil.nama} (${hasil.ukuranTeks})` +
          (dibuang.length ? `, ${dibuang.length} cadangan lama dibuang` : '')
      );
    } catch (err) {
      // Gagal mencadangkan tidak boleh menjatuhkan aplikasi yang sedang melayani.
      console.error('Cadangan gagal:', err.message);
    }
  };

  const awal = setTimeout(() => jalankan('saat menyala'), 30_000);
  const harian = setInterval(() => jalankan('harian'), 24 * 60 * 60 * 1000);
  awal.unref?.();
  harian.unref?.();
  return { awal, harian };
}

module.exports = {
  folderCadangan,
  daftarCadangan,
  buatCadangan,
  jalurCadangan,
  infoBasisData,
  pangkas,
  mulaiJadwal,
  SIMPAN,
};
