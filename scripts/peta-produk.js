'use strict';
/**
 * Menjembatani dua kosakata produk.
 *
 * Sheet penjualan menyebut barang dengan nama dagang ("Asam Humat", "F Durian"),
 * sementara berkas inventory memakai nama gudang ("HUMIC ACID 1 KG", "Booster
 * Non Label NEW"). Tidak ada kolom kunci yang menghubungkan keduanya.
 *
 * Kuncinya bukan nama, melainkan angka: kolom HARGA HPP pada sheet penjualan
 * berisi nilai yang sama persis dengan HARGA BELI pada berkas inventory. Nama
 * justru menyesatkan — "Asam Humat" adalah "HUMIC ACID 1 KG", dan sepuluh nama
 * "F <buah>" yang berbeda semuanya satu barcode karena dijual dengan label buah
 * berbeda.
 *
 * Harga beli saja belum cukup: beberapa barang berbeda kebetulan berharga sama.
 * Untuk kelompok seperti itu dipakai dua bukti tambahan, berurutan — kemiripan
 * nama bila jelas, lalu kecocokan jumlah dengan catatan BARANG KELUAR pada
 * bulan yang sama. Bukti terakhir itu penting karena penjualan dan barang
 * keluar adalah peristiwa fisik yang sama, jadi jumlahnya harus berdekatan.
 */

/** Samakan bentuk penulisan: huruf besar, tanpa tanda baca, spasi tunggal. */
function normal(s) {
  return String(s || '')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, ' ')
    .trim();
}

/** Kata yang hanya menyebut kemasan, bukan identitas barang. */
const KATA_KEMASAN = new Set(['KG', 'GR', 'GRAM', 'ML', 'L', 'LITER', 'PACK', 'BOTOL', 'PCS', 'SACHET', 'NON', 'LABEL', 'NEW', 'CAIR', 'PADAT']);

function inti(s) {
  return normal(s).split(' ').filter((t) => t && !KATA_KEMASAN.has(t));
}

/** Kemiripan dua nama: irisan kata dibagi himpunan terkecil. */
function miripNama(a, b) {
  const A = new Set(inti(a));
  const B = new Set(inti(b));
  if (!A.size || !B.size) return 0;
  let sama = 0;
  for (const t of A) if (B.has(t)) sama += 1;
  return sama / Math.min(A.size, B.size);
}

/** Nilai yang paling sering muncul — dipakai untuk menentukan HPP wakil. */
function modus(daftar) {
  const hitung = new Map();
  for (const x of daftar) {
    if (!(x > 0)) continue;
    hitung.set(x, (hitung.get(x) || 0) + 1);
  }
  if (!hitung.size) return 0;
  return [...hitung.entries()].sort((a, b) => b[1] - a[1])[0][0];
}

/** Ringkas sheet penjualan menjadi satu baris per nama produk. */
function ringkasNama(barisPenjualan) {
  const per = new Map();
  for (const b of barisPenjualan) {
    const r = per.get(b.nama) || { nama: b.nama, qty: 0, hppList: [], hargaList: [] };
    r.qty += b.qty;
    r.hppList.push(b.hargaHpp);
    r.hargaList.push(b.hargaSatuan);
    per.set(b.nama, r);
  }
  for (const r of per.values()) {
    r.hpp = modus(r.hppList);
    r.harga = modus(r.hargaList);
  }
  return [...per.values()];
}

/**
 * Susun pemetaan nama penjualan ke barcode.
 *
 * @param {Array} barisPenjualan hasil bacaPenjualan()
 * @param {Array<{sku:string,nama:string,beli:number,keluar:number}>} katalog
 *        `keluar` = jumlah unit yang tercatat keluar pada bulan yang sama.
 */
function petakan(barisPenjualan, katalog) {
  const ringkas = ringkasNama(barisPenjualan);
  const peta = new Map();
  const gagal = [];

  // Kelompokkan nama penjualan berdasarkan HPP-nya.
  const perHpp = new Map();
  for (const r of ringkas) {
    if (!(r.hpp > 0)) {
      gagal.push({ ...r, alasan: 'baris penjualan tidak mencantumkan HPP', kandidat: [] });
      continue;
    }
    if (!perHpp.has(r.hpp)) perHpp.set(r.hpp, []);
    perHpp.get(r.hpp).push(r);
  }

  for (const [hpp, namaGrup] of perHpp) {
    const barcodeGrup = katalog.filter((k) => k.beli > 0 && Math.abs(k.beli - hpp) < 1);

    if (barcodeGrup.length === 0) {
      for (const r of namaGrup) {
        gagal.push({
          ...r,
          alasan: `tidak ada barang dengan harga beli ${hpp}`,
          kandidat: [],
        });
      }
      continue;
    }

    // Satu-satunya pilihan — tidak ada yang perlu dipisahkan.
    if (barcodeGrup.length === 1) {
      for (const r of namaGrup) {
        peta.set(r.nama, buat(r, barcodeGrup[0], 'harga beli sama', miripNama(r.nama, barcodeGrup[0].nama)));
      }
      continue;
    }

    // Sisa daya tampung tiap barcode menurut catatan BARANG KELUAR.
    const sisa = new Map(barcodeGrup.map((k) => [k.sku, k.keluar || 0]));
    const belum = [...namaGrup].sort((a, b) => b.qty - a.qty);
    const terpakai = new Set();

    // Tahap 1 — nama yang jelas merujuk satu barcode tertentu.
    for (let i = belum.length - 1; i >= 0; i -= 1) {
      const r = belum[i];
      const nilai = barcodeGrup
        .map((k) => ({ k, m: miripNama(r.nama, k.nama) }))
        .sort((a, b) => b.m - a.m);
      const juara = nilai[0];
      const kedua = nilai[1];
      if (juara.m >= 0.5 && (!kedua || juara.m > kedua.m + 0.001) && !terpakai.has(juara.k.sku)) {
        peta.set(r.nama, buat(r, juara.k, 'harga beli sama + nama mirip', juara.m));
        sisa.set(juara.k.sku, (sisa.get(juara.k.sku) || 0) - r.qty);
        terpakai.add(juara.k.sku);
        belum.splice(i, 1);
      }
    }

    // Tahap 2 — sisanya diletakkan pada barcode yang daya tampungnya paling besar.
    for (const r of belum) {
      const pilihan = barcodeGrup
        .map((k) => ({ k, sisa: sisa.get(k.sku) || 0 }))
        .sort((a, b) => b.sisa - a.sisa)[0];
      peta.set(r.nama, buat(r, pilihan.k, 'harga beli sama + jumlah keluar cocok', miripNama(r.nama, pilihan.k.nama)));
      sisa.set(pilihan.k.sku, (sisa.get(pilihan.k.sku) || 0) - r.qty);
    }
  }

  return { peta, gagal };
}

function buat(r, k, cara, mirip) {
  return {
    sku: k.sku,
    namaGudang: k.nama,
    hpp: r.hpp,
    harga: r.harga,
    qty: r.qty,
    cara,
    mirip: Number((mirip || 0).toFixed(2)),
  };
}

module.exports = { normal, inti, miripNama, modus, ringkasNama, petakan };
