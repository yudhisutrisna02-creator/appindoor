'use strict';
/**
 * Memeriksa konsistensi kedua berkas Excel sebelum apa pun ditulis ke basis
 * data. Tidak mengubah apa pun.
 */
const { bacaInventory, bacaPenjualan } = require('./baca-excel');

const AWAL_AGU = '2026-08-01';
const AKHIR_AGU = '2026-08-31';

function rekapMutasi(gerak) {
  const per = new Map();
  for (const g of gerak) {
    const c = per.get(g.barcode) || { in: 0, out: 0, inSblm: 0, outSblm: 0, inAgu: 0, outAgu: 0 };
    const sebelum = g.tanggal && g.tanggal < AWAL_AGU;
    const agustus = g.tanggal && g.tanggal >= AWAL_AGU && g.tanggal <= AKHIR_AGU;
    if (g.arah === 'IN') {
      c.in += g.qty;
      if (sebelum) c.inSblm += g.qty;
      if (agustus) c.inAgu += g.qty;
    } else {
      c.out += g.qty;
      if (sebelum) c.outSblm += g.qty;
      if (agustus) c.outAgu += g.qty;
    }
    per.set(g.barcode, c);
  }
  return per;
}

(async () => {
  const inv = await bacaInventory();
  const jual = await bacaPenjualan();
  const per = rekapMutasi(inv.gerak);
  const KOSONG = { in: 0, out: 0, inSblm: 0, outSblm: 0, inAgu: 0, outAgu: 0 };

  console.log('DAFTAR BARANG   :', inv.barang.size, 'barcode');
  console.log('HARGA BARANG    :', inv.harga.size, 'baris');
  console.log('mutasi tercatat :', inv.gerak.length);
  console.log('baris penjualan :', jual.length);

  // --- 1. Apakah aritmetika DAFTAR BARANG konsisten dengan log mutasi? ---
  let cocok = 0;
  const beda = [];
  for (const [bc, b] of inv.barang) {
    const c = per.get(bc) || KOSONG;
    const hasil = b.stokAwal + c.in - c.out;
    if (Math.abs(hasil - b.stokAkhir) < 0.001) cocok++;
    else beda.push({ bc, nama: b.nama, excel: b.stokAkhir, hitung: hasil, selisih: hasil - b.stokAkhir });
  }
  console.log('\n--- Aritmetika DAFTAR BARANG ---');
  console.log(`stok awal + masuk - keluar = stok akhir : ${cocok} dari ${inv.barang.size}`);
  if (beda.length) {
    console.log('tidak cocok:', beda.length);
    for (const x of beda.slice(0, 15)) {
      console.log(`   ${x.bc.padEnd(14)} ${x.nama.slice(0, 26).padEnd(28)} excel=${x.excel} hitung=${x.hitung} selisih=${x.selisih}`);
    }
  }

  // --- 2. Posisi akhir Juli vs akhir Agustus ---
  let totJul = 0;
  let totAkhir = 0;
  let masukAgu = 0;
  let keluarAgu = 0;
  for (const [bc, b] of inv.barang) {
    const c = per.get(bc) || KOSONG;
    totJul += b.stokAwal + c.inSblm - c.outSblm;
    totAkhir += b.stokAkhir;
    masukAgu += c.inAgu;
    keluarAgu += c.outAgu;
  }
  console.log('\n--- Posisi stok ---');
  console.log('total unit akhir Juli    :', totJul);
  console.log('masuk Agustus            :', masukAgu);
  console.log('keluar Agustus           :', keluarAgu);
  console.log('stok akhir menurut Excel :', totAkhir);
  console.log('cek juli + masuk - keluar:', totJul + masukAgu - keluarAgu);

  // --- 3. Apakah penjualan dan BARANG KELUAR gerakan yang sama? ---
  const qtyJual = jual.reduce((s, j) => s + j.qty, 0);
  console.log('\n--- Penjualan Agustus vs BARANG KELUAR Agustus ---');
  console.log('qty penjualan Agustus :', qtyJual);
  console.log('qty barang keluar Agu :', keluarAgu);
  console.log('selisih               :', qtyJual - keluarAgu);

  // --- 4. Nama produk di sheet penjualan vs nama di DAFTAR BARANG ---
  const namaBarang = new Map();
  for (const [bc, b] of inv.barang) namaBarang.set(b.nama.toUpperCase(), bc);

  const namaJual = new Map();
  for (const j of jual) {
    const k = j.nama.toUpperCase();
    namaJual.set(k, (namaJual.get(k) || 0) + j.qty);
  }
  const takKenal = [];
  let kenal = 0;
  for (const [nama, qty] of namaJual) {
    if (namaBarang.has(nama)) kenal++;
    else takKenal.push({ nama, qty });
  }
  console.log('\n--- Pencocokan nama produk ---');
  console.log(`nama penjualan cocok persis dengan DAFTAR BARANG : ${kenal} dari ${namaJual.size}`);
  console.log('belum cocok:', takKenal.length);
  for (const x of takKenal.sort((a, b) => b.qty - a.qty)) {
    console.log(`   ${String(x.qty).padStart(5)}  ${x.nama}`);
  }

  // --- 5. Toko yang muncul di penjualan ---
  const toko = new Map();
  for (const j of jual) {
    const t = j.toko || '(kosong)';
    toko.set(t, (toko.get(t) || 0) + 1);
  }
  console.log('\n--- Toko pada sheet penjualan ---');
  for (const [t, c] of [...toko].sort((a, b) => b[1] - a[1])) {
    console.log(`   ${String(c).padStart(4)}  ${t}`);
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
