'use strict';
/**
 * Menguji pemetaan nama penjualan ke barcode gudang, lalu membuktikannya:
 * jumlah unit terjual per barcode harus mendekati jumlah BARANG KELUAR pada
 * bulan yang sama. Bila dua angka itu berjauhan, pemetaannya salah.
 */
const { bacaInventory, bacaPenjualan } = require('./baca-excel');
const { petakan } = require('./peta-produk');

const AWAL = '2026-08-01';
const AKHIR = '2026-08-31';

async function susunKatalog() {
  const inv = await bacaInventory();

  const keluarAgu = new Map();
  for (const g of inv.gerak) {
    if (g.arah !== 'OUT' || !g.tanggal || g.tanggal < AWAL || g.tanggal > AKHIR) continue;
    keluarAgu.set(g.barcode, (keluarAgu.get(g.barcode) || 0) + g.qty);
  }

  const katalog = [];
  const sudah = new Set();
  for (const [bc, b] of inv.barang) {
    katalog.push({ sku: b.barcode, nama: b.nama, beli: b.hargaBeli, keluar: keluarAgu.get(bc) || 0 });
    sudah.add(bc);
  }
  for (const [bc, h] of inv.harga) {
    if (sudah.has(bc)) continue;
    katalog.push({ sku: bc, nama: h.nama, beli: h.hargaBeli, keluar: keluarAgu.get(bc) || 0 });
    sudah.add(bc);
  }

  return { inv, katalog, keluarAgu };
}

module.exports = { susunKatalog, AWAL, AKHIR };

if (require.main === module) {
  (async () => {
    const { katalog, keluarAgu } = await susunKatalog();
    const jual = await bacaPenjualan();
    const { peta, gagal } = petakan(jual, katalog);

    console.log('nama penjualan :', peta.size + gagal.length);
    console.log('terpetakan     :', peta.size);
    console.log('gagal          :', gagal.length);

    const cara = {};
    for (const v of peta.values()) cara[v.cara] = (cara[v.cara] || 0) + 1;
    console.log('cara           :', JSON.stringify(cara));

    // Bukti: qty terjual per barcode vs BARANG KELUAR Agustus per barcode.
    const jualPerSku = new Map();
    for (const [nama, v] of peta) {
      jualPerSku.set(v.sku, (jualPerSku.get(v.sku) || 0) + v.qty);
    }

    const semuaSku = new Set([...jualPerSku.keys(), ...keluarAgu.keys()]);
    const baris = [];
    let cocok = 0;
    let totalJual = 0;
    let totalKeluar = 0;
    for (const sku of semuaSku) {
      const j = jualPerSku.get(sku) || 0;
      const k = keluarAgu.get(sku) || 0;
      totalJual += j;
      totalKeluar += k;
      const selisih = j - k;
      // Toleransi 10%: sebagian barang keluar bukan karena penjualan.
      if (k > 0 && Math.abs(selisih) <= Math.max(3, k * 0.1)) cocok += 1;
      baris.push({ sku, jual: j, keluar: k, selisih });
    }

    console.log('\n--- Bukti: qty terjual vs BARANG KELUAR Agustus ---');
    console.log(`barcode selaras : ${cocok} dari ${semuaSku.size}`);
    console.log(`total terjual   : ${totalJual}`);
    console.log(`total keluar    : ${totalKeluar}`);
    baris.sort((a, b) => b.keluar - a.keluar || b.jual - a.jual);
    for (const b of baris) {
      const tanda = b.keluar === 0 ? 'tidak keluar' : Math.abs(b.selisih) <= Math.max(3, b.keluar * 0.1) ? 'ok' : 'PERIKSA';
      console.log(
        `  ${b.sku.padEnd(13)} jual=${String(b.jual).padStart(5)}  keluar=${String(b.keluar).padStart(5)}  selisih=${String(b.selisih).padStart(5)}  ${tanda}`
      );
    }

    console.log('\n--- Pemetaan ---');
    for (const [nama, v] of [...peta].sort((a, b) => b[1].qty - a[1].qty)) {
      console.log(
        `  ${String(v.qty).padStart(5)}  ${nama.padEnd(24)} -> ${v.sku.padEnd(13)} ${v.namaGudang.slice(0, 30).padEnd(32)} [${v.cara}]`
      );
    }

    if (gagal.length) {
      console.log('\n--- Belum terpetakan ---');
      for (const g of gagal.sort((a, b) => b.qty - a.qty)) {
        console.log(`  ${String(g.qty).padStart(5)}  ${g.nama.padEnd(24)} HPP=${g.hpp}  (${g.alasan})`);
        for (const k of g.kandidat) console.log(`           kandidat: ${k}`);
      }
    }
  })().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
