'use strict';
/**
 * Memastikan tiap ikon yang dipakai menu benar-benar diimpor.
 *
 * Build TIDAK menangkap kesalahan ini. Identifier yang tidak ada bukan galat
 * sintaks — ia baru meledak saat halaman dijalankan, dan hasilnya layar putih
 * total tanpa pesan apa pun di layar. Uji asap pun tidak menangkapnya, karena
 * uji asap berbicara dengan API, bukan membuka halamannya.
 *
 * Ini benar-benar terjadi: satu ikon menu yang lupa diimpor membuat seluruh
 * aplikasi di produksi tidak bisa dibuka sama sekali.
 */
const fs = require('fs');
const path = require('path');

const berkas = path.join(__dirname, '..', 'client', 'src', 'App.jsx');
const isi = fs.readFileSync(berkas, 'utf8');

// Diambil tepat dari blok impor lucide-react saja, bukan dari impor lain yang
// kebetulan berada di atasnya.
const blok = isi.match(/import\s*\{([^}]*)\}\s*from\s*'lucide-react'/);
if (!blok) {
  console.error('Blok impor lucide-react tidak ditemukan di App.jsx');
  process.exit(1);
}

const diimpor = new Set(
  blok[1]
    .split(',')
    .map((x) => x.trim().split(/\s+as\s+/).pop().trim())
    .filter(Boolean)
);

const dipakai = [...new Set([...isi.matchAll(/icon:\s*([A-Za-z0-9_]+)/g)].map((m) => m[1]))];
const hilang = dipakai.filter((i) => !diimpor.has(i));

console.log(`Ikon dipakai menu : ${dipakai.length}`);
console.log(`Ikon diimpor      : ${diimpor.size}`);

if (hilang.length) {
  console.error(`\nGAGAL — ikon dipakai tetapi tidak diimpor: ${hilang.join(', ')}`);
  console.error('Tambahkan ke blok impor lucide-react di client/src/App.jsx.');
  process.exit(1);
}

console.log('\nSemua ikon menu sudah diimpor.');
