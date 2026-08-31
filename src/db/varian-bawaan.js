'use strict';
/**
 * Katalog varian bawaan untuk produk yang dijual tanpa label.
 *
 * Ini hanya TITIK MULAI, bukan daftar yang mengikat. Isinya disemai sekali ke
 * tabel product_variants, lalu selanjutnya dikelola dari menu Master Produk —
 * varian bertambah dan berkurang mengikuti pesanan pembeli, dan daftar yang
 * terkunci di dalam kode akan tertinggal tanpa ada yang menyadarinya.
 *
 * Dikunci per SKU induknya, bukan per nama produk: nama boleh diperbaiki
 * ejaannya kapan saja, SKU tidak.
 */
const VARIAN_BAWAAN = {
  // GREEN POWER NUTRALINDO
  GPN: [
    'GPN- Alpukat', 'GPN- Anggur', 'GPN- Bawang', 'GPN- Belimbing', 'GPN- Cabai',
    'GPN- Duku', 'GPN- Durian', 'GPN- Jagung', 'GPN- Jambu', 'GPN- Jeruk',
    'GPN- Kacang', 'GPN- Kedelai', 'GPN- Karet', 'GPN- Kelengkeng', 'GPN- Kubis',
    'GPN- Kurma', 'GPN- Kentang', 'GPN- Mangga', 'GPN- Matoa', 'GPN- Multiguna',
    'GPN- Nanas', 'GPN- Padi', 'GPN- Sawit', 'GPN- Sawo', 'GPN- Sayur',
    'GPN- Singkong', 'GPN- Semangka', 'GPN- Strawberry', 'GPN- Terong',
    'GPN- Tomat', 'GPN- Vanili',
  ],

  // Booster Non Label NEW
  'B-NLN': [
    'F Alpukat', 'F Anggrek', 'F Anggur', 'F Buah Naga', 'F Bunga', 'F Durian',
    'F Jambu', 'F Jamur', 'F Jengkol', 'F Jeruk', 'F Kelengkeng',
    'F Kopi & Kakao', 'F Mangga', 'F Manggis', 'F Melon', 'F Pete', 'F Porang',
    'F Sawo', 'F Strawberry', 'Fortune Buah dan Sayur', 'Pupuk Multiguna',
  ],

  // FloraOne Cair NON LABEL
  'F-ON-NL': [
    'Pupuk Hayati Bawang', 'Pupuk Hayati Cabe', 'Pupuk Hayati Deka',
    'Pupuk Hayati Jagung', 'Pupuk Hayati Padi', 'Pupuk Hayati Tebu',
    'Pupuk Hayati Rhizobium', 'Pupuk Hayati Sawit',
  ],

  // BEN SUBUR 1 L Non Label
  'BN-SBRNL': [
    'POC Ben Subur Alpukat', 'POC Ben Subur Durian',
    'POC Ben Subur Kelengkeng', 'POC Ben Subur Anggur',
  ],

  // Reliq Booster Hayati 250gr
  RBH: [
    'Booster Hayati Apel', 'Booster Hayati Kurma', 'Booster Hayati Durian',
    'Booster Hayati Rambutan', 'Booster Hayati Pisang', 'Booster Hayati Duku',
    'Booster Hayati Kelengkeng',
  ],
};

module.exports = { VARIAN_BAWAAN };
