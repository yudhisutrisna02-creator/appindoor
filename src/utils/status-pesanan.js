'use strict';
/**
 * Tahapan pesanan penjualan.
 *
 * Dikumpulkan di satu berkas karena daftarnya dipakai formulir order, papan
 * pengiriman, ubah massal, dan dashboard. Saat tahap baru ditambahkan, yang
 * paling mudah terlewat bukan daftarnya — melainkan tempat-tempat yang
 * menanyakan "sudah cair atau belum". Karena itu pertanyaan-pertanyaan itu
 * dijawab lewat kelompok di bawah, bukan dengan menuliskan 'CAIR' lagi di
 * tiap berkas.
 *
 * Pengiriman kilat adalah jalur terpisah, bukan sekadar catatan pada pesanan
 * biasa: ongkos, tenggat, dan cara dananya cair berbeda, dan tim perlu
 * melihatnya berdiri sendiri di papan pengiriman.
 */

/** Sedang berjalan — barangnya belum selesai urusannya. */
const BERJALAN = ['DIPROSES', 'DIKIRIM', 'KILAT', 'SELESAI'];

/** Dananya sudah diterima. */
const CAIR = ['CAIR', 'KILAT_CAIR'];

/** Barangnya kembali. */
const RETUR = ['RETUR', 'KILAT_RETUR'];

/** Tidak ditunggu lagi — entah dananya masuk atau barangnya kembali. */
const SELESAI_URUSAN = [...CAIR, ...RETUR];

/** Seluruh tahap yang boleh disimpan pada sebuah pesanan. */
const SEMUA = [...BERJALAN, ...CAIR, ...RETUR, 'BATAL'];

/**
 * Urutan kolom papan pengiriman.
 *
 * BATAL sengaja tidak ikut: papan ini dipakai untuk mengurus pesanan yang
 * masih perlu dikerjakan, dan pesanan batal hanya menambah kolom yang tidak
 * pernah ditindaklanjuti.
 */
const TAHAP_PAPAN = ['DIPROSES', 'DIKIRIM', 'KILAT', 'SELESAI', 'CAIR', 'KILAT_CAIR', 'RETUR', 'KILAT_RETUR'];

/** Nama tahap sebagaimana dibaca tim. */
const LABEL = {
  DIPROSES: 'Diproses',
  DIKIRIM: 'Dikirim',
  KILAT: 'Pengiriman Kilat',
  SELESAI: 'Selesai',
  CAIR: 'Cair',
  KILAT_CAIR: 'Pengiriman Kilat Cair',
  RETUR: 'Retur',
  KILAT_RETUR: 'Retur Pengiriman Kilat',
  BATAL: 'Batal',
};

/** Potongan SQL `IN (...)` beserta nilainya, supaya tidak ditulis manual. */
function sqlIn(daftar) {
  return daftar.map(() => '?').join(', ');
}

module.exports = { BERJALAN, CAIR, RETUR, SELESAI_URUSAN, SEMUA, TAHAP_PAPAN, LABEL, sqlIn };
