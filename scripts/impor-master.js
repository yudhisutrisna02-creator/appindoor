'use strict';
/**
 * Mengimpor data master dari berkas Excel ke aplikasi lewat REST API.
 *
 *   node scripts/impor-master.js                    → pratinjau saja (aman)
 *   node scripts/impor-master.js --apply            → benar-benar menulis
 *   node scripts/impor-master.js --target=produksi  → arahkan ke server live
 *   node scripts/impor-master.js --karyawan         → ikut membuat akun karyawan
 *
 * Sengaja lewat API, bukan langsung ke database, supaya semua validasi dan
 * pembentukan jurnal otomatis tetap berjalan.
 *
 * Sifatnya idempoten: SKU yang sudah ada dilewati, jadi aman diulang.
 */
require('dotenv').config();
const crypto = require('crypto');
const ExcelJS = require('exceljs');
const path = require('path');

const APPLY = process.argv.includes('--apply');
const IKUT_KARYAWAN = process.argv.includes('--karyawan');
const targetArg = process.argv.find((a) => a.startsWith('--target='));
const TARGET = targetArg ? targetArg.split('=')[1] : 'lokal';

const BASE = TARGET === 'produksi'
  ? 'https://erp.indonesiaorganik.id'
  : `http://localhost:${process.env.PORT || 3000}`;

const EMAIL = process.env.IMPOR_EMAIL || process.env.SEED_ADMIN_EMAIL || 'admin@kebumen.local';
const PASSWORD = process.env.IMPOR_PASSWORD || process.env.SEED_ADMIN_PASSWORD || 'Admin#12345';

const FILE_INVENTORY = 'REPORT INVENTORY 2025 (1).xlsx';
const FILE_ABSENSI = 'ABSENSI INDOOR (1).xlsx';
const DOMAIN_EMAIL = 'indonesiaorganik.id';

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

/** Menyusun katalog gabungan DAFTAR BARANG + HARGA BARANG. */
async function bacaKatalog() {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(path.resolve(process.cwd(), FILE_INVENTORY));

  const barang = bacaSheet(wb.getWorksheet('DAFTAR BARANG'));
  const harga = bacaSheet(wb.getWorksheet('HARGA BARANG'));

  const petaHarga = new Map();
  for (const h of harga) {
    const kode = (h['BARCODE'] || '').toUpperCase();
    if (kode) petaHarga.set(kode, h);
  }

  const katalog = [];
  const terlihat = new Set();

  for (const b of barang) {
    const sku = (b['BARCODE'] || '').toUpperCase();
    const nama = b['NAMA BARANG'] || '';
    if (!sku || !nama || terlihat.has(sku)) continue;
    terlihat.add(sku);

    const h = petaHarga.get(sku);
    katalog.push({
      sku,
      name: nama,
      unit: (b['SATUAN'] || 'PCS').toUpperCase().slice(0, 15),
      cost: angka(b['HARGA BELI']) || angka(h && h['HARGA BELI']),
      price: angka(h && h['HARGA JUAL']),
      stock: angka(b['STOK AKHIR']),
    });
  }

  // Produk yang hanya tercantum di daftar harga — belum punya stok
  for (const h of harga) {
    const sku = (h['BARCODE'] || '').toUpperCase();
    const nama = h['NAMA BARANG'] || '';
    if (!sku || !nama || terlihat.has(sku)) continue;
    terlihat.add(sku);
    katalog.push({
      sku,
      name: nama,
      unit: (h['SATUAN'] || 'PCS').toUpperCase().slice(0, 15),
      cost: angka(h['HARGA BELI']),
      price: angka(h['HARGA JUAL']),
      stock: 0,
    });
  }

  return katalog;
}

async function bacaKaryawan() {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(path.resolve(process.cwd(), FILE_ABSENSI));
  return bacaSheet(wb.getWorksheet('DAFTAR NAMA'))
    .map((n) => ({ kode: n['NO TEAM'] || '', nama: n['NAMA SISWA'] || '' }))
    .filter((n) => n.nama);
}

/** Email dari nama: "Aji Suroso" -> aji.suroso@domain */
function buatEmail(nama) {
  const bersih = nama.toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z\s]/g, '')
    .trim().split(/\s+/).slice(0, 2).join('.');
  return `${bersih}@${DOMAIN_EMAIL}`;
}

function buatPassword() {
  const U = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  const L = 'abcdefghijkmnpqrstuvwxyz';
  const D = '23456789';
  const semua = U + L + D;
  const p = [U[crypto.randomInt(U.length)], L[crypto.randomInt(L.length)], D[crypto.randomInt(D.length)]];
  for (let i = 0; i < 9; i += 1) p.push(semua[crypto.randomInt(semua.length)]);
  for (let i = p.length - 1; i > 0; i -= 1) {
    const j = crypto.randomInt(i + 1);
    [p[i], p[j]] = [p[j], p[i]];
  }
  return p.join('');
}

async function main() {
  console.log(`\nImpor data master → ${BASE}`);
  console.log(`Mode: ${APPLY ? 'MENULIS SUNGGUHAN' : 'PRATINJAU (tidak menulis apa pun)'}\n`);

  const login = await call('POST', '/api/auth/login', { email: EMAIL, password: PASSWORD });
  token = login.token;
  console.log(`Masuk sebagai ${login.user.name}\n`);

  const katalog = await bacaKatalog();
  const adaSekarang = await call('GET', '/api/inventory/products?includeInactive=1');
  const skuAda = new Set(adaSekarang.products.map((p) => p.sku.toUpperCase()));

  const baru = katalog.filter((p) => !skuAda.has(p.sku));
  const dilewati = katalog.length - baru.length;
  const berstok = baru.filter((p) => p.stock > 0 && p.cost > 0);
  const nilaiAwal = berstok.reduce((s, p) => s + p.stock * p.cost, 0);

  console.log('─'.repeat(60));
  console.log('RENCANA IMPOR');
  console.log('─'.repeat(60));
  console.log(`  Produk di Excel            : ${katalog.length}`);
  console.log(`  Sudah ada (dilewati)       : ${dilewati}`);
  console.log(`  Akan dibuat                : ${baru.length}`);
  console.log(`  Akan diisi stok awal       : ${berstok.length}`);
  console.log(`  Nilai persediaan awal      : Rp ${Math.round(nilaiAwal).toLocaleString('id-ID')}`);
  console.log('');
  console.log('  Stok awal dibukukan sebagai:');
  console.log('    Debit  1200 Persediaan Barang Dagang');
  console.log('    Kredit 3000 Modal Pemilik');
  console.log('  (barangnya memang sudah ada sebelum sistem dipakai, bukan pembelian baru)');

  const tanpaHarga = baru.filter((p) => !p.price).length;
  const tanpaHpp = baru.filter((p) => !p.cost).length;
  if (tanpaHarga || tanpaHpp) {
    console.log('');
    console.log(`  Catatan: ${tanpaHarga} produk tanpa harga jual, ${tanpaHpp} tanpa HPP.`);
    console.log('  Tetap diimpor dengan nilai 0 — bisa dilengkapi lewat menu Master Produk.');
  }

  if (!APPLY) {
    console.log('\n  Ini baru pratinjau. Tambahkan --apply untuk benar-benar menulis.\n');
    return;
  }

  // ---------- Menulis produk ----------
  console.log('\n' + '─'.repeat(60));
  console.log('MENULIS DATA...');
  console.log('─'.repeat(60));

  let dibuat = 0;
  let gagal = 0;
  const petaId = new Map();

  for (const p of baru) {
    try {
      const res = await call('POST', '/api/inventory/products', {
        sku: p.sku,
        name: p.name,
        category: 'Produk Organik',
        unit: p.unit || 'PCS',
        cost: p.cost,
        price: p.price,
        min_stock: 0,
      });
      petaId.set(p.sku, res.product.id);
      dibuat += 1;
      if (dibuat % 25 === 0) console.log(`  ${dibuat} produk dibuat...`);
    } catch (err) {
      gagal += 1;
      console.log(`  GAGAL ${p.sku}: ${err.message}`);
    }
  }
  console.log(`  Produk dibuat: ${dibuat}${gagal ? `, gagal: ${gagal}` : ''}`);

  // ---------- Stok awal ----------
  const hariIni = new Date().toLocaleDateString('sv-SE');
  let stokDiisi = 0;

  for (const p of berstok) {
    const id = petaId.get(p.sku);
    if (!id) continue;
    try {
      await call('POST', '/api/inventory/moves', {
        product_id: id,
        move_date: hariIni,
        move_type: 'IN',
        qty: p.stock,
        unit_cost: p.cost,
        payment: 'OPENING',
        ref: 'SALDO-AWAL',
        note: 'Stok awal dari REPORT INVENTORY 2025',
      });
      stokDiisi += 1;
      if (stokDiisi % 25 === 0) console.log(`  ${stokDiisi} stok awal dicatat...`);
    } catch (err) {
      console.log(`  GAGAL stok ${p.sku}: ${err.message}`);
    }
  }
  console.log(`  Stok awal dicatat: ${stokDiisi} produk`);

  // ---------- Karyawan ----------
  if (IKUT_KARYAWAN) {
    const karyawan = await bacaKaryawan();
    const penggunaAda = await call('GET', '/api/admin/users');
    const emailAda = new Set(penggunaAda.users.map((u) => u.email.toLowerCase()));

    console.log('');
    const kredensial = [];
    for (const k of karyawan) {
      const email = buatEmail(k.nama);
      if (emailAda.has(email)) { console.log(`  dilewati (sudah ada): ${email}`); continue; }
      const pw = buatPassword();
      try {
        await call('POST', '/api/admin/users', {
          name: k.nama, email, password: pw, role: 'staff',
          position: k.kode ? `Team ${k.kode}` : null,
        });
        kredensial.push({ nama: k.nama, email, password: pw });
      } catch (err) {
        console.log(`  GAGAL ${k.nama}: ${err.message}`);
      }
    }

    if (kredensial.length) {
      console.log('\n' + '='.repeat(60));
      console.log('AKUN KARYAWAN DIBUAT — bagikan ke masing-masing orang');
      console.log('='.repeat(60));
      kredensial.forEach((k) => {
        console.log(`  ${k.nama.padEnd(22)} ${k.email.padEnd(34)} ${k.password}`);
      });
      console.log('\n  Minta setiap orang mengganti passwordnya di menu Pengaturan → Akun Saya.');
    }
  }

  // ---------- Verifikasi ----------
  console.log('\n' + '─'.repeat(60));
  console.log('VERIFIKASI');
  console.log('─'.repeat(60));

  const valuasi = await call('GET', '/api/inventory/valuation');
  console.log(`  Produk aktif           : ${valuasi.totalSku}`);
  console.log(`  Total unit             : ${valuasi.totalQty.toLocaleString('id-ID')}`);
  console.log(`  Nilai persediaan       : Rp ${Math.round(valuasi.totalValue).toLocaleString('id-ID')}`);

  const neraca = await call('GET', '/api/finance/reports/balance-sheet');
  console.log(`  Persediaan di Neraca   : Rp ${Math.round(neraca.assets.current.totalInventory).toLocaleString('id-ID')}`);
  console.log(`  Modal Pemilik          : Rp ${Math.round(neraca.equity.capital).toLocaleString('id-ID')}`);
  console.log(`  Neraca seimbang        : ${neraca.balanced ? 'YA' : 'TIDAK — periksa!'}`);
  console.log('');
}

main().catch((e) => { console.error('\nGagal:', e.message, '\n'); process.exit(1); });
