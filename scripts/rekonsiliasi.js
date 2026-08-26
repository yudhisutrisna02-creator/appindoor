'use strict';
/**
 * Menyelaraskan data produk di aplikasi dengan berkas Excel terbaru.
 *
 *   node scripts/rekonsiliasi.js --file="..." [--target=produksi] [--apply]
 *
 * Bawaannya hanya membandingkan dan melaporkan. Tanpa --apply tidak ada
 * satu baris pun yang ditulis.
 *
 * Prinsip yang dipegang:
 *  - Tidak pernah membuat SKU yang sudah ada (mencegah duplikat).
 *  - Selisih stok diselesaikan lewat Stok Opname, bukan menimpa angka
 *    diam-diam, supaya perubahannya terjurnal dan bisa ditelusuri.
 *  - Produk yang hilang dari Excel tidak dihapus tanpa perintah eksplisit.
 */
require('dotenv').config();
const path = require('path');
const ExcelJS = require('exceljs');

const arg = (nama, bawaan = null) => {
  const a = process.argv.find((x) => x.startsWith(`--${nama}=`));
  return a ? a.split('=').slice(1).join('=') : bawaan;
};

const APPLY = process.argv.includes('--apply');
const NONAKTIFKAN_HILANG = process.argv.includes('--nonaktifkan-hilang');
const TARGET = arg('target', 'lokal');
const FILE = arg('file', 'REPORT INVENTORY 2025-2026.xlsx');

const BASE = TARGET === 'produksi'
  ? 'https://erp.indonesiaorganik.id'
  : `http://localhost:${process.env.PORT || 3000}`;

const EMAIL = process.env.IMPOR_EMAIL || process.env.SEED_ADMIN_EMAIL || 'admin@kebumen.local';
const PASSWORD = process.env.IMPOR_PASSWORD || process.env.SEED_ADMIN_PASSWORD || 'Admin#12345';

let token = null;

async function call(method, jalur, body) {
  const res = await fetch(`${BASE}${jalur}`, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const teks = await res.text();
  const data = teks ? JSON.parse(teks) : {};
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

const val = (x) => {
  if (x == null) return '';
  if (typeof x === 'object') {
    if (x instanceof Date) return x.toISOString().slice(0, 10);
    if (x.text) return String(x.text).trim();
    if (x.result != null) return String(x.result).trim();
    if (x.richText) return x.richText.map((r) => r.text).join('').trim();
    return '';
  }
  return String(x).trim();
};

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

const rp = (n) => 'Rp ' + Math.round(n).toLocaleString('id-ID');

/** Katalog dari Excel: DAFTAR BARANG digabung HARGA BARANG lewat BARCODE. */
async function bacaExcel() {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(path.resolve(FILE));

  const barang = bacaSheet(wb.getWorksheet('DAFTAR BARANG'));
  const harga = bacaSheet(wb.getWorksheet('HARGA BARANG'));

  const petaHarga = new Map();
  for (const h of harga) {
    const kode = (h['BARCODE'] || '').toUpperCase();
    if (kode) petaHarga.set(kode, h);
  }

  const katalog = new Map();
  const ganda = [];

  const tambah = (sku, nama, satuan, hpp, jual, stok) => {
    if (!sku || !nama) return;
    if (katalog.has(sku)) { ganda.push(`${sku} — ${nama}`); return; }
    katalog.set(sku, {
      sku,
      name: nama,
      unit: (satuan || 'PCS').toUpperCase().slice(0, 15),
      cost: hpp,
      price: jual,
      stock: stok,
    });
  };

  for (const b of barang) {
    const sku = (b['BARCODE'] || '').toUpperCase();
    const h = petaHarga.get(sku);
    tambah(
      sku,
      b['NAMA BARANG'] || '',
      b['SATUAN'],
      angka(b['HARGA BELI']) || angka(h && h['HARGA BELI']),
      angka(h && h['HARGA JUAL']),
      angka(b['STOK AKHIR'])
    );
  }

  // Produk yang hanya tercantum di daftar harga — dianggap berstok nol
  for (const h of harga) {
    const sku = (h['BARCODE'] || '').toUpperCase();
    if (katalog.has(sku)) continue;
    tambah(sku, h['NAMA BARANG'] || '', h['SATUAN'], angka(h['HARGA BELI']), angka(h['HARGA JUAL']), 0);
  }

  return { katalog, ganda };
}

async function main() {
  console.log(`\nRekonsiliasi → ${BASE}`);
  console.log(`Berkas       : ${path.basename(FILE)}`);
  console.log(`Mode         : ${APPLY ? 'MENULIS SUNGGUHAN' : 'BANDINGKAN SAJA (tidak menulis)'}\n`);

  const login = await call('POST', '/api/auth/login', { email: EMAIL, password: PASSWORD });
  token = login.token;

  const { katalog, ganda } = await bacaExcel();
  const adaRes = await call('GET', '/api/inventory/products?includeInactive=1');
  const ada = new Map(adaRes.products.map((p) => [p.sku.toUpperCase(), p]));

  const baru = [];
  const bedaStok = [];
  const bedaHarga = [];
  const cocok = [];
  const hilangDariExcel = [];

  for (const [sku, x] of katalog) {
    const p = ada.get(sku);
    if (!p) { baru.push(x); continue; }

    const selisih = x.stock - p.stock;
    if (Math.abs(selisih) > 0.004) {
      bedaStok.push({ ...x, id: p.id, stokAplikasi: p.stock, selisih, hppAplikasi: p.cost });
    }
    // Harga/HPP hanya diperbarui bila Excel punya nilai; jangan menimpa dengan 0
    const ubahHarga = {};
    if (x.price > 0 && Math.abs(x.price - p.price) > 0.004) ubahHarga.price = x.price;
    if (x.cost > 0 && Math.abs(x.cost - p.cost) > 0.004) ubahHarga.cost = x.cost;
    if (Object.keys(ubahHarga).length) {
      bedaHarga.push({ ...x, id: p.id, lama: { price: p.price, cost: p.cost }, ubah: ubahHarga, produk: p });
    }
    if (Math.abs(selisih) <= 0.004 && !Object.keys(ubahHarga).length) cocok.push(sku);
  }

  for (const [sku, p] of ada) {
    if (!katalog.has(sku) && p.active) hilangDariExcel.push(p);
  }

  const nilaiSelisih = bedaStok.reduce((s, x) => s + x.selisih * (x.cost || x.hppAplikasi), 0);

  console.log('─'.repeat(64));
  console.log('PERBANDINGAN');
  console.log('─'.repeat(64));
  console.log(`  Produk di Excel               : ${katalog.size}`);
  console.log(`  Produk di aplikasi            : ${ada.size}`);
  console.log('');
  console.log(`  Sudah sama persis             : ${cocok.length}`);
  console.log(`  Belum ada di aplikasi (baru)  : ${baru.length}`);
  console.log(`  Beda stok                     : ${bedaStok.length}`);
  console.log(`  Beda harga / HPP              : ${bedaHarga.length}`);
  console.log(`  Ada di aplikasi, hilang di Excel : ${hilangDariExcel.length}`);
  if (ganda.length) {
    console.log(`  Barcode ganda di Excel (dilewati): ${ganda.length}`);
    ganda.slice(0, 5).forEach((g) => console.log(`      ${g}`));
  }

  if (bedaStok.length) {
    console.log('');
    console.log(`  Nilai penyesuaian stok        : ${rp(nilaiSelisih)}`);
    console.log('');
    console.log('  Contoh 10 selisih terbesar:');
    [...bedaStok]
      .sort((a, b) => Math.abs(b.selisih) - Math.abs(a.selisih))
      .slice(0, 10)
      .forEach((x) => {
        const tanda = x.selisih > 0 ? '+' : '';
        console.log(`    ${x.sku.padEnd(14)} ${x.name.slice(0, 26).padEnd(28)} aplikasi ${String(x.stokAplikasi).padStart(5)} → excel ${String(x.stock).padStart(5)}  (${tanda}${x.selisih})`);
      });
  }

  if (hilangDariExcel.length) {
    console.log('');
    console.log('  Produk yang tidak ada di Excel terbaru:');
    hilangDariExcel.slice(0, 10).forEach((p) => console.log(`    ${p.sku.padEnd(14)} ${p.name.slice(0, 34).padEnd(36)} stok ${p.stock}`));
    if (!NONAKTIFKAN_HILANG) {
      console.log('    (dibiarkan apa adanya — tambahkan --nonaktifkan-hilang bila ingin dinonaktifkan)');
    }
  }

  if (!APPLY) {
    console.log('\n  Ini baru perbandingan. Tambahkan --apply untuk menerapkan.\n');
    return;
  }

  // ================= MENERAPKAN =================
  console.log('\n' + '─'.repeat(64));
  console.log('MENERAPKAN PERUBAHAN');
  console.log('─'.repeat(64));

  const hariIni = new Date().toLocaleDateString('sv-SE');

  // 1) Produk baru — dibuat tanpa stok dulu
  let dibuat = 0;
  const idBaru = new Map();
  for (const x of baru) {
    try {
      const res = await call('POST', '/api/inventory/products', {
        sku: x.sku, name: x.name, category: 'Produk Organik',
        unit: x.unit || 'PCS', cost: x.cost, price: x.price, min_stock: 0,
      });
      idBaru.set(x.sku, res.product.id);
      dibuat += 1;
    } catch (err) {
      console.log(`  GAGAL buat ${x.sku}: ${err.message}`);
    }
  }
  console.log(`  Produk baru dibuat            : ${dibuat}`);

  // 2) Harga & HPP diselaraskan
  let hargaDiubah = 0;
  for (const x of bedaHarga) {
    try {
      const p = x.produk;
      await call('PUT', `/api/inventory/products/${x.id}`, {
        sku: p.sku, name: p.name, category: p.category, unit: p.unit,
        cost: x.ubah.cost != null ? x.ubah.cost : p.cost,
        price: x.ubah.price != null ? x.ubah.price : p.price,
        min_stock: p.min_stock, active: !!p.active,
      });
      hargaDiubah += 1;
    } catch (err) {
      console.log(`  GAGAL harga ${x.sku}: ${err.message}`);
    }
  }
  console.log(`  Harga / HPP diselaraskan      : ${hargaDiubah}`);

  // 3) Stok diselaraskan lewat Stok Opname supaya selisihnya terjurnal
  const barisOpname = [];
  for (const x of bedaStok) barisOpname.push({ product_id: x.id, physical_qty: x.stock });
  for (const x of baru) {
    const id = idBaru.get(x.sku);
    if (id && x.stock > 0) barisOpname.push({ product_id: id, physical_qty: x.stock });
  }

  if (barisOpname.length) {
    try {
      const res = await call('POST', '/api/inventory/opname', {
        opname_date: hariIni,
        note: `Penyelarasan dengan ${path.basename(FILE)} (data per 24 Agustus 2026)`,
        lines: barisOpname,
      });
      console.log(`  Stok diselaraskan             : ${barisOpname.length} produk`);
      console.log(`  Dokumen opname                : ${res.opname_no}`);
      console.log(`  Nilai penyesuaian             : ${rp(res.total_diff_value)}`);
    } catch (err) {
      console.log(`  GAGAL opname: ${err.message}`);
    }
  } else {
    console.log('  Stok sudah sama, tidak perlu opname');
  }

  // 4) Produk yang hilang dari Excel
  if (NONAKTIFKAN_HILANG && hilangDariExcel.length) {
    let dinonaktifkan = 0;
    for (const p of hilangDariExcel) {
      try {
        await call('PUT', `/api/inventory/products/${p.id}`, {
          sku: p.sku, name: p.name, category: p.category, unit: p.unit,
          cost: p.cost, price: p.price, min_stock: p.min_stock, active: false,
        });
        dinonaktifkan += 1;
      } catch (err) {
        console.log(`  GAGAL nonaktifkan ${p.sku}: ${err.message}`);
      }
    }
    console.log(`  Produk dinonaktifkan          : ${dinonaktifkan}`);
  }

  // ================= VERIFIKASI =================
  console.log('\n' + '─'.repeat(64));
  console.log('VERIFIKASI — hasil akhir harus sama dengan Excel');
  console.log('─'.repeat(64));

  const akhirRes = await call('GET', '/api/inventory/products?includeInactive=1');
  const akhir = new Map(akhirRes.products.map((p) => [p.sku.toUpperCase(), p]));

  let samaStok = 0;
  const belumCocok = [];
  for (const [sku, x] of katalog) {
    const p = akhir.get(sku);
    if (!p) { belumCocok.push(`${sku} — tidak ada di aplikasi`); continue; }
    if (Math.abs(p.stock - x.stock) > 0.004) {
      belumCocok.push(`${sku} — aplikasi ${p.stock} vs excel ${x.stock}`);
    } else samaStok += 1;
  }

  const duplikat = akhirRes.products.length - new Set(akhirRes.products.map((p) => p.sku.toUpperCase())).size;

  console.log(`  Produk di Excel               : ${katalog.size}`);
  console.log(`  Stok sudah sama               : ${samaStok}`);
  console.log(`  Belum cocok                   : ${belumCocok.length}`);
  belumCocok.slice(0, 10).forEach((b) => console.log(`      ${b}`));
  console.log(`  SKU duplikat di aplikasi      : ${duplikat}${duplikat ? '  <-- MASALAH' : ''}`);

  const valuasi = await call('GET', '/api/inventory/valuation');
  const neraca = await call('GET', '/api/finance/reports/balance-sheet');
  console.log('');
  console.log(`  Nilai persediaan aplikasi     : ${rp(valuasi.totalValue)}`);
  console.log(`  Persediaan di Neraca          : ${rp(neraca.assets.current.totalInventory)}`);
  console.log(`  Neraca seimbang               : ${neraca.balanced ? 'YA' : 'TIDAK — periksa!'}`);
  console.log('');
}

main().catch((e) => { console.error('\nGagal:', e.message, '\n'); process.exit(1); });
