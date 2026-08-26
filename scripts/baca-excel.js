'use strict';
/**
 * Pembaca kedua berkas Excel sumber.
 *
 * Dipisah dari skrip impor supaya cara membaca berkas hanya ditulis sekali:
 * skrip pemeriksa, skrip impor, dan skrip rekonsiliasi memakai hasil yang
 * sama persis, jadi tidak mungkin satu skrip menafsirkan kolom berbeda dari
 * skrip lain.
 */
const ExcelJS = require('exceljs');

const FILE_INV = process.env.FILE_INVENTORY || 'C:/Users/HP/Downloads/REPORT INVENTORY 2025-2026.xlsx';
const FILE_WS = process.env.FILE_WORKSHEET || 'C:/09. INDOOR/Worksheet INDOOR AGUSTUS 2026.xlsx';

/** Nilai sel apa adanya — rumus diambil hasilnya, bukan teks rumusnya. */
function isi(cell) {
  const x = cell && cell.value;
  if (x == null) return null;
  if (typeof x === 'object') {
    if (x.result !== undefined) return x.result;
    if (x.text !== undefined) return x.text;
    return x;
  }
  return x;
}

function angka(x) {
  if (x == null || x === '') return 0;
  const n = Number(String(x).replace(/[^0-9.-]/g, ''));
  return Number.isNaN(n) ? 0 : n;
}

function teks(x) {
  return String(x == null ? '' : x).trim();
}

/** Tanggal ke YYYY-MM-DD; mengembalikan null bila tidak terbaca. */
function tanggal(x) {
  if (x == null) return null;
  if (x instanceof Date) return x.toISOString().slice(0, 10);
  const s = String(x).trim();
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return m[0];
  m = s.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})/);
  if (m) return `${m[3]}-${String(m[2]).padStart(2, '0')}-${String(m[1]).padStart(2, '0')}`;
  return null;
}

async function bacaInventory(file = FILE_INV) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(file);

  const barang = new Map();
  wb.getWorksheet('DAFTAR BARANG').eachRow((row, r) => {
    if (r === 1) return;
    const bc = teks(isi(row.getCell(1)));
    if (!bc) return;
    barang.set(bc.toUpperCase(), {
      barcode: bc,
      nama: teks(isi(row.getCell(2))),
      satuan: teks(isi(row.getCell(3))) || 'PCS',
      stokAwal: angka(isi(row.getCell(4))),
      stokAkhir: angka(isi(row.getCell(7))),
      hargaBeli: angka(isi(row.getCell(8))),
      hargaDiskon: angka(isi(row.getCell(9))),
      minStok: angka(isi(row.getCell(10))),
      supplier: teks(isi(row.getCell(11))),
    });
  });

  const gerak = [];
  const ambil = (sheet, arah) => {
    wb.getWorksheet(sheet).eachRow((row, r) => {
      if (r === 1) return;
      const bc = teks(isi(row.getCell(2)));
      if (!bc) return;
      gerak.push({
        tanggal: tanggal(isi(row.getCell(1))),
        barcode: bc.toUpperCase(),
        nama: teks(isi(row.getCell(3))),
        qty: angka(isi(row.getCell(4))),
        arah,
        oleh: teks(isi(row.getCell(5))),
        ket: teks(isi(row.getCell(6))),
      });
    });
  };
  ambil('BARANG MASUK', 'IN');
  ambil('BARANG KELUAR', 'OUT');

  const harga = new Map();
  wb.getWorksheet('HARGA BARANG').eachRow((row, r) => {
    if (r === 1) return;
    const bc = teks(isi(row.getCell(2)));
    if (!bc) return;
    harga.set(bc.toUpperCase(), {
      nama: teks(isi(row.getCell(3))),
      satuan: teks(isi(row.getCell(4))),
      hargaBeli: angka(isi(row.getCell(5))),
      hargaJual: angka(isi(row.getCell(6))),
      hargaDiskon: angka(isi(row.getCell(7))),
    });
  });

  return { barang, gerak, harga };
}

/**
 * Sheet "3. Penjualan" menulis tanggal sekali di baris pertama tiap hari,
 * lalu membiarkan sel di bawahnya kosong. Tanggal itu diteruskan ke bawah.
 * Di bawah baris 1663 ada tabel rekap produk, bukan transaksi — jadi dipotong.
 */
async function bacaPenjualan(file = FILE_WS) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(file);
  const ws = wb.getWorksheet('3. Penjualan');
  const baris = [];
  let tgl = null;

  ws.eachRow((row, r) => {
    if (r < 5 || r > 1663) return;
    const t = row.getCell(2).value;
    if (t instanceof Date) tgl = t.toISOString().slice(0, 10);

    const nama = teks(isi(row.getCell(4)));
    const qty = angka(isi(row.getCell(3)));
    if (!nama || qty <= 0) return;

    baris.push({
      baris: r,
      tanggal: tgl,
      qty,
      nama,
      hargaSatuan: angka(isi(row.getCell(5))),
      jumlah: angka(isi(row.getCell(6))),
      pembayaran: teks(isi(row.getCell(7))),
      bank: teks(isi(row.getCell(8))),
      asalLeads: teks(isi(row.getCell(9))),
      asalKota: teks(isi(row.getCell(10))),
      hargaHpp: angka(isi(row.getCell(11))),
      jumlahHpp: angka(isi(row.getCell(12))),
      ongkir: angka(isi(row.getCell(13))),
      laba: angka(isi(row.getCell(14))),
      biayaAdmin: angka(isi(row.getCell(15))),
      ongkirKirim: angka(isi(row.getCell(16))),
      noPesanan: teks(isi(row.getCell(17))),
      ekspedisi: teks(isi(row.getCell(18))),
      status: teks(isi(row.getCell(19))),
      tglCair: tanggal(isi(row.getCell(20))),
      toko: teks(isi(row.getCell(21))),
      pembeli: teks(isi(row.getCell(22))),
      akun: teks(isi(row.getCell(23))),
      alamat: teks(isi(row.getCell(24))),
      hp: teks(isi(row.getCell(25))),
      resi: teks(isi(row.getCell(26))),
    });
  });

  return baris;
}

module.exports = { bacaInventory, bacaPenjualan, isi, angka, teks, tanggal, FILE_INV, FILE_WS };
