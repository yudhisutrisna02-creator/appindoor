'use strict';

/**
 * Identitas aplikasi.
 *
 * Ditaruh di modul sendiri, bukan di App.jsx, supaya halaman Login bisa
 * memakainya tanpa mengimpor balik App — impor melingkar seperti itu bekerja
 * secara kebetulan dan mudah patah begitu urutan modul berubah.
 */
export const NAMA_APP = 'ERP System Indoor';
export const NAMA_PERUSAHAAN = 'Grha Indonesia Organik';
export const MODUL_APP = 'Presensi • Keuangan • Gudang • Penjualan';
