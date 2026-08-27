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
const FILE_WS = process.env.FILE_WORKSHEET || 'C:/Users/HP/Downloads/Worksheet INDOOR AGUSTUS 2026.xlsx';

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

/**
 * Angka dari sel, termasuk yang tersimpan sebagai teks.
 *
 * Sebagian sel diketik manual dengan pemisah ribuan gaya Indonesia
 * ("1.277.500"). Dibaca apa adanya, teks seperti itu menjadi NaN lalu jatuh ke
 * nol — satu baris belanja Rp 1,2 juta hilang tanpa jejak, dan totalnya tetap
 * tampak wajar sehingga tidak ada yang curiga. Karena itu titik ribuan dikenali
 * lebih dulu, dan koma diperlakukan sebagai pemisah desimal.
 */
function angka(x) {
  if (x == null || x === '') return 0;
  if (typeof x === 'number') return x;

  // Buang apa pun yang bukan angka, titik, koma, atau tanda minus — mis. "Rp".
  let s = String(x).trim().replace(/[^0-9.,-]/g, '');
  // Titik sebagai pemisah ribuan: selalu diikuti tepat tiga angka, berulang.
  if (/^-?\d{1,3}(\.\d{3})+(,\d+)?$/.test(s)) s = s.replace(/\./g, '');
  s = s.replace(',', '.');

  const n = Number(s);
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
 * Cari baris tempat tabel transaksi berakhir.
 *
 * Di bawah daftar transaksi ada tabel rekap produk yang bentuknya mirip dan
 * akan ikut terbaca sebagai transaksi bila tidak dipotong. Batasnya dikenali
 * dari kepala tabel rekap ("PRODUK" pada kolom B) supaya tetap benar ketika
 * jumlah baris transaksi bertambah — mematoknya pada nomor baris tertentu
 * hanya bekerja sampai berkasnya diperbarui.
 */
function batasTransaksi(ws) {
  let batas = null;
  ws.eachRow((row, r) => {
    if (batas || r < 5) return;
    const b = row.getCell(2).value;
    if (typeof b === 'string' && b.trim().toUpperCase() === 'PRODUK') batas = r - 1;
  });
  return batas || ws.actualRowCount;
}

/**
 * Sheet "3. Penjualan" menulis tanggal sekali di baris pertama tiap hari,
 * lalu membiarkan sel di bawahnya kosong. Tanggal itu diteruskan ke bawah.
 */
async function bacaPenjualan(file = FILE_WS) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(file);
  const ws = wb.getWorksheet('3. Penjualan');
  const batas = batasTransaksi(ws);
  const baris = [];
  let tgl = null;

  ws.eachRow((row, r) => {
    if (r < 5 || r > batas) return;
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
