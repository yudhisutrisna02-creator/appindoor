'use strict';
/**
 * Membaca berkas Excel milik pengguna dan menggabungkan DAFTAR BARANG dengan
 * HARGA BARANG menjadi satu katalog produk.
 *
 * Hanya membaca dan melaporkan — tidak menulis apa pun ke database.
 *
 *   node scripts/analisa-excel.js
 */
const path = require('path');
const ExcelJS = require('exceljs');

const FILE_INVENTORY = 'REPORT INVENTORY 2025 (1).xlsx';
const FILE_ABSENSI = 'ABSENSI INDOOR (1).xlsx';

/** Sel Excel bisa berupa teks, rumus, atau rich text — normalkan jadi string. */
function val(x) {
  if (x == null) return '';
  if (typeof x === 'object') {
    if (x.text) return String(x.text).trim();
    if (x.result != null) return String(x.result).trim();
    if (x.richText) return x.richText.map((r) => r.text).join('').trim();
    return '';
  }
  return String(x).trim();
}

/** Membaca satu sheet menjadi array objek dengan header baris pertama. */
function bacaSheet(ws) {
  const baris = [];
  let header = null;

  ws.eachRow((row) => {
    const nilai = row.values.slice(1).map(val);
    if (!nilai.some((v) => v)) return;

    if (!header) { header = nilai; return; }

    const obj = {};
    header.forEach((h, i) => { if (h) obj[h] = nilai[i] || ''; });
    baris.push(obj);
  });

  return baris;
}

const angka = (s) => {
  const n = Number(String(s).replace(/[^\d.-]/g, ''));
  return Number.isFinite(n) ? n : 0;
};

async function main() {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(path.resolve(process.cwd(), FILE_INVENTORY));

  const barang = bacaSheet(wb.getWorksheet('DAFTAR BARANG'));
  const harga = bacaSheet(wb.getWorksheet('HARGA BARANG'));

  // Harga jual diambil dari sheet HARGA BARANG, dicocokkan lewat BARCODE
  const petaHarga = new Map();
  for (const h of harga) {
    const kode = (h['BARCODE'] || '').toUpperCase();
    if (kode) petaHarga.set(kode, h);
  }

  const katalog = [];
  const masalah = { tanpaKode: 0, tanpaNama: 0, tanpaHargaJual: [], tanpaHpp: [], kodeGanda: [] };
  const terlihat = new Set();

  for (const b of barang) {
    const kode = (b['BARCODE'] || '').toUpperCase();
    const nama = b['NAMA BARANG'] || '';

    if (!kode) { masalah.tanpaKode += 1; continue; }
    if (!nama) { masalah.tanpaNama += 1; continue; }

    if (terlihat.has(kode)) { masalah.kodeGanda.push(`${kode} — ${nama}`); continue; }
    terlihat.add(kode);

    const h = petaHarga.get(kode);
    const hpp = angka(b['HARGA BELI']) || angka(h && h['HARGA BELI']);
    const jual = angka(h && h['HARGA JUAL']);
    const stok = angka(b['STOK AKHIR']);

    if (!jual) masalah.tanpaHargaJual.push(`${kode} — ${nama}`);
    if (!hpp) masalah.tanpaHpp.push(`${kode} — ${nama}`);

    katalog.push({
      sku: kode,
      name: nama,
      unit: (b['SATUAN'] || 'PCS').toUpperCase(),
      cost: hpp,
      price: jual,
      stock: stok,
      nilai: stok * hpp,
    });
  }

  // Produk yang hanya ada di daftar harga, belum ada di daftar barang
  const hanyaDiHarga = harga
    .filter((h) => h['BARCODE'] && !terlihat.has((h['BARCODE'] || '').toUpperCase()))
    .map((h) => ({
      sku: (h['BARCODE'] || '').toUpperCase(),
      name: h['NAMA BARANG'] || '',
      unit: (h['SATUAN'] || 'PCS').toUpperCase(),
      cost: angka(h['HARGA BELI']),
      price: angka(h['HARGA JUAL']),
      stock: 0,
      nilai: 0,
    }))
    .filter((p) => p.sku && p.name);

  console.log('\n' + '='.repeat(64));
  console.log('KATALOG PRODUK DARI EXCEL');
  console.log('='.repeat(64));
  console.log(`  Dari DAFTAR BARANG          : ${katalog.length} produk`);
  console.log(`  Hanya ada di HARGA BARANG   : ${hanyaDiHarga.length} produk (stok 0)`);
  console.log(`  TOTAL siap impor            : ${katalog.length + hanyaDiHarga.length} produk`);

  const totalNilai = katalog.reduce((s, p) => s + p.nilai, 0);
  const totalUnit = katalog.reduce((s, p) => s + p.stock, 0);
  console.log(`\n  Total stok                  : ${totalUnit.toLocaleString('id-ID')} unit`);
  console.log(`  Nilai persediaan awal       : Rp ${Math.round(totalNilai).toLocaleString('id-ID')}`);

  console.log('\n' + '-'.repeat(64));
  console.log('PERLU PERHATIAN');
  console.log('-'.repeat(64));
  console.log(`  Baris tanpa barcode         : ${masalah.tanpaKode}`);
  console.log(`  Baris tanpa nama            : ${masalah.tanpaNama}`);
  console.log(`  Barcode ganda (dilewati)    : ${masalah.kodeGanda.length}`);
  masalah.kodeGanda.slice(0, 5).forEach((x) => console.log(`      ${x}`));
  console.log(`  Tanpa harga jual            : ${masalah.tanpaHargaJual.length}`);
  masalah.tanpaHargaJual.slice(0, 5).forEach((x) => console.log(`      ${x}`));
  console.log(`  Tanpa HPP                   : ${masalah.tanpaHpp.length}`);
  masalah.tanpaHpp.slice(0, 5).forEach((x) => console.log(`      ${x}`));

  console.log('\n' + '-'.repeat(64));
  console.log('CONTOH 5 PRODUK PERTAMA');
  console.log('-'.repeat(64));
  for (const p of katalog.slice(0, 5)) {
    console.log(`  ${p.sku.padEnd(12)} ${p.name.slice(0, 30).padEnd(32)} ${String(p.stock).padStart(5)} ${p.unit.padEnd(6)} HPP ${String(p.cost).padStart(8)}  Jual ${String(p.price).padStart(8)}`);
  }

  // ---------- Karyawan ----------
  const wb2 = new ExcelJS.Workbook();
  await wb2.xlsx.readFile(path.resolve(process.cwd(), FILE_ABSENSI));
  const nama = bacaSheet(wb2.getWorksheet('DAFTAR NAMA'));

  console.log('\n' + '-'.repeat(64));
  console.log(`KARYAWAN: ${nama.length} orang`);
  console.log('-'.repeat(64));
  nama.forEach((n) => console.log(`  ${(n['NO TEAM'] || '').padEnd(12)} ${n['NAMA SISWA'] || ''}`));

  console.log('');
  return { katalog, hanyaDiHarga, karyawan: nama };
}

if (require.main === module) main().catch((e) => { console.error(e.message); process.exit(1); });

module.exports = { main, bacaSheet, val };
