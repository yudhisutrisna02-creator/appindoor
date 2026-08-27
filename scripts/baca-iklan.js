'use strict';
/**
 * Pembaca sheet "7. IKLAN".
 *
 * Sheet ini memuat dua blok berdampingan pada baris yang sama: kolom 2–8 berisi
 * belanja bulan berjalan, kolom 10–16 berisi bulan sebelumnya. Keduanya dibaca
 * terpisah lalu ditandai bulannya, supaya pemanggil bisa memilih mana yang
 * hendak dimasukkan — memuat keduanya sekaligus akan menaruh beban di periode
 * yang belum punya penjualan pembanding.
 *
 * Tanggal ditulis sekali di baris pertama tiap kelompok, lalu dibiarkan kosong
 * di bawahnya — sama seperti sheet penjualan — jadi nilainya diteruskan ke bawah.
 */
const ExcelJS = require('exceljs');
const { isi, angka, teks, tanggal } = require('./baca-excel');

const FILE = process.env.FILE_WORKSHEET || 'C:/Users/HP/Downloads/Worksheet INDOOR AGUSTUS 2026.xlsx';

/** Satu blok = lima kolom berurutan mulai dari kolom tanggal. */
const BLOK = [
  { nama: 'berjalan', kolTanggal: 3, kolAkun: 4, kolNominal: 5, kolMedia: 6, kolRekening: 7 },
  { nama: 'sebelumnya', kolTanggal: 11, kolAkun: 12, kolNominal: 13, kolMedia: 14, kolRekening: 15 },
];

/**
 * Batas bawah tabel transaksi.
 *
 * Di bawahnya ada blok "REKAP DATA ADS PER TOKO" berisi SUMIF per toko dan
 * baris SUBTOTAL. Bentuknya mirip baris transaksi — ada nama toko dan ada
 * nominal — sehingga ikut terbaca bila tidak dipotong, dan seluruh belanja
 * akan terhitung dua kali. Batasnya dikenali dari kepala blok rekap itu, bukan
 * dipatok pada nomor baris, supaya tetap benar saat barisnya bertambah.
 */
function batasTransaksi(ws) {
  let batas = null;
  ws.eachRow((row, r) => {
    if (batas || r < 2) return;
    for (const kol of [2, 4, 12]) {
      const t = row.getCell(kol).value;
      if (typeof t === 'string' && /REKAP|SUBTOTAL|SELISIH/i.test(t)) {
        batas = r - 1;
        return;
      }
    }
  });
  return batas || ws.actualRowCount;
}

async function bacaIklan(file = FILE) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(file);
  const ws = wb.getWorksheet('7. IKLAN');
  if (!ws) throw new Error('Sheet "7. IKLAN" tidak ditemukan');

  const batas = batasTransaksi(ws);
  const hasil = [];

  for (const b of BLOK) {
    let tgl = null;
    ws.eachRow((row, r) => {
      if (r < 2 || r > batas) return;

      const t = tanggal(isi(row.getCell(b.kolTanggal)));
      if (t) tgl = t;

      const akun = teks(isi(row.getCell(b.kolAkun)));
      const nominal = angka(isi(row.getCell(b.kolNominal)));
      if (!akun || nominal <= 0 || !tgl) return;

      hasil.push({
        baris: r,
        blok: b.nama,
        tanggal: tgl,
        toko: akun,
        nominal,
        media: teks(isi(row.getCell(b.kolMedia))),
        rekening: teks(isi(row.getCell(b.kolRekening))),
      });
    });
  }

  return hasil;
}

module.exports = { bacaIklan, FILE };

if (require.main === module) {
  bacaIklan()
    .then((rows) => {
      const perBulan = {};
      const perRekening = {};
      const perMedia = {};
      const perToko = {};
      for (const r of rows) {
        const bln = r.tanggal.slice(0, 7);
        perBulan[bln] = perBulan[bln] || { baris: 0, nilai: 0 };
        perBulan[bln].baris += 1;
        perBulan[bln].nilai += r.nominal;
        perRekening[r.rekening || '(kosong)'] = (perRekening[r.rekening || '(kosong)'] || 0) + r.nominal;
        perMedia[r.media || '(kosong)'] = (perMedia[r.media || '(kosong)'] || 0) + r.nominal;
        perToko[r.toko] = (perToko[r.toko] || 0) + r.nominal;
      }

      const rp = (n) => 'Rp ' + Math.round(n).toLocaleString('id-ID');
      console.log('baris terbaca:', rows.length);
      console.log('\nper bulan:');
      for (const [b, v] of Object.entries(perBulan).sort()) {
        console.log(`  ${b}  ${String(v.baris).padStart(4)} baris  ${rp(v.nilai)}`);
      }
      console.log('\nsumber dana (REKENING):');
      for (const [k, v] of Object.entries(perRekening).sort((a, c) => c[1] - a[1])) {
        console.log(`  ${k.padEnd(18)} ${rp(v)}`);
      }
      console.log('\nmedia:');
      for (const [k, v] of Object.entries(perMedia).sort((a, c) => c[1] - a[1])) {
        console.log(`  ${k.padEnd(18)} ${rp(v)}`);
      }
      console.log('\nnama akun toko:', Object.keys(perToko).length);
      for (const [k, v] of Object.entries(perToko).sort((a, c) => c[1] - a[1])) {
        console.log(`  ${k.padEnd(26)} ${rp(v)}`);
      }
    })
    .catch((e) => {
      console.error(e.message);
      process.exit(1);
    });
}
