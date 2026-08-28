'use strict';
/**
 * Katalog hak akses.
 *
 * Daftarnya ditulis di kode, bukan disimpan sebagai baris di basis data. Yang
 * berubah saat menu bertambah adalah kodenya juga — menyimpan katalognya di
 * basis data hanya menambah satu tempat lagi yang harus ikut diperbarui, dan
 * membuka peluang izin yang tercatat tetapi tidak ada penjaganya di mana pun.
 * Yang disimpan di basis data hanyalah peran dan izin apa saja yang dipegangnya.
 *
 * Penamaan: <modul>.<aksi>. Aksi "lihat" berarti boleh membuka halamannya;
 * aksi lain berarti boleh melakukan sesuatu yang mengubah data.
 */

/**
 * Kelompok izin, urut seperti menu di layar supaya yang mengatur peran
 * melihat susunan yang sama dengan yang dilihat penggunanya.
 */
const KATALOG = [
  {
    modul: 'dashboard',
    label: 'Dashboard',
    izin: [{ kunci: 'dashboard.lihat', label: 'Membuka dashboard' }],
  },
  {
    modul: 'presensi',
    label: 'Presensi',
    izin: [
      { kunci: 'presensi.absen', label: 'Melakukan absen sendiri' },
      { kunci: 'presensi.lihat', label: 'Melihat rekap absensi semua orang' },
      { kunci: 'presensi.kelola', label: 'Mengubah & menghapus data presensi' },
    ],
  },
  {
    modul: 'gudang',
    label: 'Gudang',
    izin: [
      { kunci: 'gudang.lihat', label: 'Melihat stok, produk, dan mutasi' },
      { kunci: 'gudang.produk', label: 'Menambah & mengubah master produk' },
      { kunci: 'gudang.mutasi', label: 'Mencatat barang masuk & keluar' },
      { kunci: 'gudang.opname', label: 'Melakukan stok opname' },
      { kunci: 'gudang.kinerja', label: 'Melihat kinerja & perputaran produk' },
    ],
  },
  {
    modul: 'penjualan',
    label: 'Penjualan',
    izin: [
      { kunci: 'penjualan.lihat', label: 'Melihat order penjualan' },
      { kunci: 'penjualan.buat', label: 'Membuat order baru' },
      { kunci: 'penjualan.ubah', label: 'Mengubah order & status pesanan' },
      { kunci: 'penjualan.batal', label: 'Membatalkan order' },
      { kunci: 'penjualan.retur', label: 'Mencatat retur penjualan' },
      { kunci: 'penjualan.toko', label: 'Mengelola daftar toko / akun marketplace' },
      { kunci: 'penjualan.margin', label: 'Melihat analisis margin & HPP' },
    ],
  },
  {
    modul: 'pembelian',
    label: 'Pembelian',
    izin: [
      { kunci: 'pembelian.lihat', label: 'Melihat pesanan pembelian' },
      { kunci: 'pembelian.kelola', label: 'Membuat pesanan & menerima barang' },
    ],
  },
  {
    modul: 'iklan',
    label: 'Biaya Iklan',
    izin: [
      { kunci: 'iklan.lihat', label: 'Melihat dashboard biaya iklan' },
      { kunci: 'iklan.kelola', label: 'Mencatat & mengubah biaya iklan' },
    ],
  },
  {
    modul: 'target',
    label: 'Target & Pencapaian',
    izin: [
      { kunci: 'target.lihat', label: 'Melihat target bulanan & pencapaiannya' },
      { kunci: 'target.kelola', label: 'Menetapkan & mengubah target' },
    ],
  },
  {
    modul: 'penggajian',
    label: 'Penggajian',
    izin: [
      { kunci: 'penggajian.lihat', label: 'Melihat daftar gaji' },
      { kunci: 'penggajian.kelola', label: 'Menyusun & mengubah daftar gaji' },
      // Sengaja dipisah dari kelola: menyusun daftar boleh salah dan diperbaiki,
      // sedangkan memposting membuat jurnal yang mengurangi kas.
      { kunci: 'penggajian.posting', label: 'Memposting gaji ke pembukuan' },
    ],
  },
  {
    modul: 'keuangan',
    label: 'Keuangan',
    izin: [
      { kunci: 'keuangan.lihat', label: 'Melihat laporan keuangan' },
      { kunci: 'keuangan.kas', label: 'Mencatat kas masuk & keluar' },
      { kunci: 'keuangan.jurnal', label: 'Membuat jurnal manual' },
      { kunci: 'keuangan.coa', label: 'Mengubah bagan akun (Chart of Accounts)' },
    ],
  },
  {
    modul: 'mitra',
    label: 'Mitra',
    izin: [
      { kunci: 'mitra.lihat', label: 'Melihat supplier & pelanggan' },
      { kunci: 'mitra.kelola', label: 'Menambah & mengubah mitra' },
    ],
  },
  {
    modul: 'sistem',
    label: 'Sistem',
    izin: [
      { kunci: 'sistem.pengaturan', label: 'Mengubah pengaturan & identitas perusahaan' },
      { kunci: 'sistem.tim', label: 'Mengelola data tim & akun pengguna' },
      { kunci: 'sistem.peran', label: 'Mengelola peran & hak akses' },
      { kunci: 'sistem.kantor', label: 'Mengatur titik kantor / geofence' },
      { kunci: 'sistem.dokumen', label: 'Melihat & mencabut tautan dokumen terbit' },
    ],
  },
];

/** Seluruh kunci izin yang sah. */
const SEMUA_IZIN = KATALOG.flatMap((k) => k.izin.map((i) => i.kunci));

/**
 * Peran bawaan.
 *
 * Disusun dari pembagian kerja yang sudah berjalan, bukan dari daftar menu:
 * tim gudang tidak perlu melihat laba, tim konten tidak perlu menyentuh stok,
 * dan tim CS perlu melihat stok tetapi tidak boleh mengubahnya. Semuanya boleh
 * diubah lewat menu Peran & Hak Akses — daftar ini hanya titik mulai.
 */
const PERAN_BAWAAN = [
  {
    slug: 'admin',
    name: 'Admin',
    description: 'Akses penuh ke seluruh menu dan data.',
    izin: SEMUA_IZIN,
  },
  {
    slug: 'manager',
    name: 'Manajer',
    description:
      'Menjalankan operasional harian dan membaca seluruh laporan. Tidak mengubah bagan akun, ' +
      'pengaturan sistem, maupun hak akses — tiga hal yang salah ubahnya berdampak ke semua orang.',
    izin: SEMUA_IZIN.filter(
      (k) => !['keuangan.coa', 'sistem.peran', 'sistem.pengaturan'].includes(k)
    ),
  },
  {
    slug: 'cs_marketplace',
    name: 'Tim CS / Admin Marketplace',
    description:
      'Menerima dan memproses pesanan: membuat order, memperbarui status pengiriman dan pencairan, ' +
      'serta mencatat retur. Boleh melihat stok untuk memastikan barang tersedia, tetapi tidak mengubahnya.',
    izin: [
      'dashboard.lihat',
      'presensi.absen',
      'gudang.lihat', 'gudang.kinerja',
      'pembelian.lihat',
      'penjualan.lihat', 'penjualan.buat', 'penjualan.ubah', 'penjualan.retur', 'penjualan.margin',
      'mitra.lihat', 'mitra.kelola',
      'target.lihat',
    ],
  },
  {
    slug: 'konten',
    name: 'Tim Konten / Marketing',
    description:
      'Mengelola belanja iklan tiap toko dan membaca hasilnya. Melihat margin dan penjualan untuk ' +
      'menilai kampanye, tanpa bisa mengubah pesanan maupun stok.',
    izin: [
      'dashboard.lihat',
      'presensi.absen',
      'penjualan.lihat', 'penjualan.margin', 'penjualan.toko',
      'iklan.lihat', 'iklan.kelola',
      'target.lihat',
    ],
  },
  {
    slug: 'gudang',
    name: 'Tim Gudang',
    description:
      'Mengurus barang: master produk, barang masuk dan keluar, serta stok opname. ' +
      'Tidak melihat angka penjualan maupun keuangan.',
    izin: [
      'dashboard.lihat',
      'presensi.absen',
      'gudang.lihat', 'gudang.produk', 'gudang.mutasi', 'gudang.opname', 'gudang.kinerja',
      'pembelian.lihat', 'pembelian.kelola',
      'mitra.lihat',
    ],
  },
];

/**
 * Peran lama pada kolom users.role dipetakan ke peran baru.
 *
 * Akun yang sudah ada tidak boleh kehilangan akses hanya karena sistem peran
 * berganti, jadi selama role_id belum diisi, nilainya diambil dari sini.
 */
const PETA_PERAN_LAMA = { admin: 'admin', manager: 'manager', staff: 'cs_marketplace' };

module.exports = { KATALOG, SEMUA_IZIN, PERAN_BAWAAN, PETA_PERAN_LAMA };
