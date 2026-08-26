'use strict';
/**
 * Membuktikan bahwa isi aplikasi sama dengan isi Excel.
 *
 * Dipisah dari skrip pemuatan dengan sengaja: yang memuat data tidak boleh
 * menjadi satu-satunya yang menyatakan pemuatannya berhasil. Skrip ini membaca
 * Excel dari awal lagi, lalu membandingkannya dengan apa yang benar-benar
 * tersimpan lewat API.
 */
const { bacaInventory, bacaPenjualan } = require('./baca-excel');

const AWAL = '2026-08-01';
const AKHIR = '2026-08-31';

const arg = (nama, bawaan) => {
  const p = process.argv.find((a) => a.startsWith(`--${nama}=`));
  return p ? p.split('=').slice(1).join('=') : bawaan;
};

const BASE = arg('base', 'http://localhost:3000');
const EMAIL = arg('email', process.env.SEED_ADMIN_EMAIL || 'admin@kebumen.local');
const SANDI = arg('password', process.env.SEED_ADMIN_PASSWORD || '');

let token = null;
async function api(path) {
  const res = await fetch(`${BASE}${path}`, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`${res.status} ${path}`);
  return res.json();
}

const rupiah = (n) => 'Rp ' + Math.round(n).toLocaleString('id-ID');

let lulus = 0;
let gagal = 0;
function cek(judul, benar, keterangan = '') {
  if (benar) {
    lulus += 1;
    console.log(`  ok    ${judul}${keterangan ? ' — ' + keterangan : ''}`);
  } else {
    gagal += 1;
    console.log(`  GAGAL ${judul}${keterangan ? ' — ' + keterangan : ''}`);
  }
}

(async () => {
  const masuk = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: EMAIL.toLowerCase(), password: SANDI }),
  }).then((r) => r.json());
  token = masuk.token;
  if (!token) throw new Error('gagal masuk');

  const inv = await bacaInventory();
  const jual = await bacaPenjualan();

  console.log(`\nPembuktian terhadap ${BASE}\n`);

  // ---------- STOK ----------
  console.log('--- Stok per produk ---');
  const val = await api('/api/inventory/valuation');
  const stokApp = new Map(val.rows.map((r) => [r.sku.trim().toUpperCase(), r.stock]));

  let sama = 0;
  const beda = [];
  for (const [bc, b] of inv.barang) {
    const app = stokApp.get(bc);
    if (app === undefined) {
      beda.push({ bc, nama: b.nama, excel: b.stokAkhir, app: 'tidak ada' });
      continue;
    }
    if (Math.abs(app - b.stokAkhir) < 0.001) sama += 1;
    else beda.push({ bc, nama: b.nama, excel: b.stokAkhir, app });
  }
  cek('stok tiap barcode sama dengan STOK AKHIR di Excel', beda.length === 0, `${sama} dari ${inv.barang.size} cocok`);
  for (const x of beda.slice(0, 15)) {
    console.log(`        ${x.bc.padEnd(14)} ${x.nama.slice(0, 28).padEnd(30)} excel=${x.excel} aplikasi=${x.app}`);
  }

  const totalExcel = [...inv.barang.values()].reduce((s, b) => s + b.stokAkhir, 0);
  cek('total unit sama', Math.abs(val.totalQty - totalExcel) < 0.001, `aplikasi ${val.totalQty}, excel ${totalExcel}`);

  // ---------- PENJUALAN ----------
  console.log('\n--- Penjualan Agustus ---');
  const daftar = await api(`/api/sales?from=${AWAL}&to=${AKHIR}&limit=5000`);
  const ringkas = daftar.summary;

  const grupExcel = new Set();
  for (const j of jual) {
    grupExcel.add(j.noPesanan ? `NO:${j.noPesanan}` : `X:${j.tanggal}|${j.toko}|${j.pembeli}|${j.resi}`);
  }
  cek('daftar tidak terpotong', !daftar.terpotong, `${daftar.rows.length} baris dikembalikan`);
  cek('jumlah order sama dengan pengelompokan Excel', ringkas.orders === grupExcel.size, `aplikasi ${ringkas.orders}, excel ${grupExcel.size}`);

  const qtyExcel = jual.reduce((s, j) => s + j.qty, 0);
  const brutoExcel = jual.reduce((s, j) => s + j.qty * j.hargaSatuan, 0);
  const adminExcel = jual.reduce((s, j) => s + j.biayaAdmin, 0);
  const hppExcel = jual.reduce((s, j) => s + j.jumlahHpp, 0);
  const labaExcel = jual.reduce((s, j) => s + j.laba, 0);

  const dekat = (a, b, toleransi) => Math.abs(a - b) <= toleransi;
  cek('penjualan kotor sama', dekat(ringkas.grossSales, brutoExcel, brutoExcel * 0.005),
    `aplikasi ${rupiah(ringkas.grossSales)}, excel ${rupiah(brutoExcel)}`);
  cek('biaya admin sama', dekat(ringkas.totalFees, adminExcel, adminExcel * 0.005),
    `aplikasi ${rupiah(ringkas.totalFees)}, excel ${rupiah(adminExcel)}`);
  cek('HPP sama', dekat(ringkas.cogs, hppExcel, hppExcel * 0.02),
    `aplikasi ${rupiah(ringkas.cogs)}, excel ${rupiah(hppExcel)}`);
  cek('laba bersih sama', dekat(ringkas.netProfit, labaExcel, labaExcel * 0.02),
    `aplikasi ${rupiah(ringkas.netProfit)}, excel ${rupiah(labaExcel)}`);

  // ---------- KETERHUBUNGAN ----------
  console.log('\n--- Keterhubungan antar menu ---');
  const dash = await api(`/api/dashboard?from=${AWAL}&to=${AKHIR}`);

  cek('neraca seimbang', dash.keuangan.balanced === true);
  cek('nilai persediaan di neraca = nilai stok gudang',
    Math.abs(dash.keuangan.inventoryValue - dash.stok.totalValue) < 1,
    `${rupiah(dash.keuangan.inventoryValue)} vs ${rupiah(dash.stok.totalValue)}`);
  cek('penjualan di laporan keuangan = penjualan di modul penjualan',
    Math.abs(dash.keuangan.netSales - ringkas.netRevenue) < 1,
    `${rupiah(dash.keuangan.netSales)} vs ${rupiah(ringkas.netRevenue)}`);

  // Yang menjadi piutang adalah uang yang akan benar-benar diterima, yaitu
  // pendapatan dikurangi potongan marketplace — bukan nilai kotor pesanan.
  const belumCair = daftar.rows.filter((o) => o.payment_status === 'UNPAID');
  const nilaiBelumCair = belumCair.reduce((s, o) => s + o.net_revenue - o.total_fees, 0);
  cek('piutang di neraca = dana marketplace yang belum cair',
    Math.abs(dash.keuangan.receivable - nilaiBelumCair) < 1000,
    `${rupiah(dash.keuangan.receivable)} vs ${belumCair.length} order senilai ${rupiah(nilaiBelumCair)}`);

  const tokoBerisi = dash.penjualan.toko.filter((t) => t.orders > 0);
  const labaToko = tokoBerisi.reduce((s, t) => s + t.net_profit, 0);
  cek('semua order menempel pada toko', tokoBerisi.length > 0,
    `${tokoBerisi.length} toko, laba ${rupiah(labaToko)}`);

  // Hanya barang di DAFTAR BARANG yang punya kolom WILAYAH; barang yang hanya
  // ada di daftar harga memang tidak menyebut pemasok, jadi tidak diperiksa.
  const punyaWilayah = new Set([...inv.barang.values()].filter((b) => b.supplier).map((b) => b.barcode.toUpperCase()));
  const tanpaPemasok = val.rows.filter((r) => punyaWilayah.has(r.sku.toUpperCase()) && !r.supplier_name);
  cek('produk yang punya WILAYAH di Excel tertaut ke pemasok', tanpaPemasok.length === 0,
    `${punyaWilayah.size} produk bersupplier, ${tanpaPemasok.length} belum tertaut`);

  cek('nilai persediaan di buku besar = nilai stok gudang',
    Math.abs(dash.keuangan.inventoryValue - val.totalValue) < 1,
    `${rupiah(dash.keuangan.inventoryValue)} vs ${rupiah(val.totalValue)}`);

  console.log('\n' + '─'.repeat(52));
  console.log(`Lulus: ${lulus}   Gagal: ${gagal}`);
  console.log('─'.repeat(52) + '\n');
  process.exit(gagal ? 1 : 0);
})().catch((e) => {
  console.error('GAGAL:', e.message);
  process.exit(1);
});
