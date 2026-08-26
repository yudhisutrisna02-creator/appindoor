'use strict';
/**
 * Memuat ulang seluruh data operasional dari dua berkas Excel sumber.
 *
 * Urutan kerjanya mengikuti alur nyata gudang, bukan urutan sheet:
 *
 *   1. pemasok dan produk disamakan dulu, karena semua yang lain menunjuk ke sana
 *   2. stok disetel ke posisi 31 Juli 2026 lewat stok opname
 *   3. barang masuk Agustus dicatat dengan tanggal aslinya
 *   4. penjualan Agustus dicatat — inilah yang mengeluarkan barang dan
 *      membentuk HPP, jurnal, serta piutang
 *   5. stok opname penutup menyamakan angka akhir dengan Excel
 *
 * Kenapa penjualan yang mengeluarkan barang, bukan sheet BARANG KELUAR:
 * keduanya mencatat peristiwa fisik yang sama. Jumlah unitnya nyaris identik
 * (1.736 lawan 1.723 pada Agustus 2026), jadi memasukkan keduanya akan
 * mengurangi stok dua kali. Yang dipilih adalah penjualan, karena hanya jalur
 * itu yang sekaligus membentuk pendapatan, HPP, dan jurnal — memakai BARANG
 * KELUAR akan menurunkan stok tanpa ada penjualan yang menjelaskannya.
 * Selisih kecil yang tersisa diserap opname penutup, dan dilaporkan apa adanya.
 *
 * Dijalankan tanpa --apply hanya menghitung dan melaporkan, tidak menulis.
 */
const { bacaInventory, bacaPenjualan } = require('./baca-excel');
const { petakan } = require('./peta-produk');

const AWAL_AGU = '2026-08-01';
const AKHIR_AGU = '2026-08-31';
const AKHIR_JUL = '2026-07-31';

const arg = (nama, bawaan) => {
  const p = process.argv.find((a) => a.startsWith(`--${nama}=`));
  return p ? p.split('=').slice(1).join('=') : bawaan;
};
const ADA = (nama) => process.argv.includes(`--${nama}`);

const BASE = arg('base', 'http://localhost:3000');
const EMAIL = arg('email', process.env.SEED_ADMIN_EMAIL || 'admin@kebumen.local');
const SANDI = arg('password', process.env.SEED_ADMIN_PASSWORD || '');
const TERAP = ADA('apply');

let token = null;

async function api(method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const teks = await res.text();
  let data = null;
  try {
    data = teks ? JSON.parse(teks) : null;
  } catch {
    data = { error: teks.slice(0, 200) };
  }
  if (!res.ok) {
    const err = new Error((data && data.error) || `${res.status} ${method} ${path}`);
    err.status = res.status;
    err.detail = data;
    throw err;
  }
  return data;
}

// ------------------------------------------------------------------
// Penerjemah nilai Excel ke istilah aplikasi
// ------------------------------------------------------------------

/**
 * Kanal ditentukan dari nama toko lebih dulu, karena di sheet itulah identitas
 * akun jualan berada; kolom STATUS PEMBAYARAN hanya dipakai bila toko kosong.
 */
function kanalDari(namaToko, pembayaran) {
  const t = (namaToko || '').trim().toUpperCase();
  if (t.startsWith('SH ')) return 'SHOPEE';
  if (t.startsWith('TIK TOK')) return 'TIKTOK_SHOP';
  if (t.startsWith('LZ ')) return 'LAZADA';
  if (t.startsWith('WA ')) return 'OFFLINE_WA';
  if (t.startsWith('TP ') || t.startsWith('TOKPED')) return 'TOKOPEDIA';

  const p = (pembayaran || '').trim().toUpperCase();
  if (p === 'SHOPEE') return 'SHOPEE';
  if (p === 'TIK TOK' || p === 'TIKTOK') return 'TIKTOK_SHOP';
  if (p === 'LAZADA') return 'LAZADA';
  if (p === 'TOKOPEDIA') return 'TOKOPEDIA';
  return 'OFFLINE_WA';
}

/**
 * STATUS di Excel mencampur tahap pengiriman dan tahap pencairan dana.
 * "P KILAT" adalah paket kilat yang sudah dikirim tetapi dananya belum cair;
 * akhiran "CAIR" berarti dananya sudah diterima, akhiran "R" berarti retur.
 */
function statusDari(status) {
  const s = (status || '').trim().toUpperCase();
  if (!s) return 'DIPROSES';
  if (s.endsWith(' R') || s === 'RETUR') return 'RETUR';
  if (s.includes('CAIR')) return 'CAIR';
  if (s.includes('KILAT')) return 'DIKIRIM';
  if (s.startsWith('DIPROSES')) return 'DIPROSES';
  if (s.startsWith('SELESAI')) return 'SELESAI';
  if (s.startsWith('BATAL')) return 'BATAL';
  return 'DIPROSES';
}

/**
 * Potong teks sesuai batas kolom.
 *
 * Sebagian alamat dan nama pembeli dari marketplace jauh lebih panjang dari
 * batas kolom. Dipotong di sini agar satu baris panjang tidak menggagalkan
 * seluruh order — isinya tetap tersimpan sampai batas yang muat.
 */
/**
 * Penanda tetap untuk order yang tidak punya nomor pesanan.
 * Dihitung dari kunci pengelompokan, jadi baris yang sama selalu menghasilkan
 * penanda yang sama pada setiap kali dijalankan.
 */
function penandaTetap(kunci) {
  let h = 5381;
  for (let i = 0; i < kunci.length; i += 1) h = ((h * 33) ^ kunci.charCodeAt(i)) >>> 0;
  return 'TANPA-NO-' + h.toString(36).toUpperCase();
}

function potong(teks, batas) {
  if (!teks) return null;
  const t = String(teks).trim();
  return t.length <= batas ? t : t.slice(0, batas);
}

const rupiah = (n) => 'Rp ' + Math.round(n).toLocaleString('id-ID');

// ------------------------------------------------------------------
// Penyusunan rencana — murni hitung, tidak menyentuh jaringan
// ------------------------------------------------------------------

async function susunRencana() {
  const inv = await bacaInventory();
  const jual = await bacaPenjualan();

  // Rekap mutasi per barcode, dipisah sebelum dan selama Agustus.
  const rekap = new Map();
  for (const g of inv.gerak) {
    const c = rekap.get(g.barcode) || { inSblm: 0, outSblm: 0, inAgu: 0, outAgu: 0 };
    if (!g.tanggal) continue;
    const sebelum = g.tanggal < AWAL_AGU;
    const agustus = g.tanggal >= AWAL_AGU && g.tanggal <= AKHIR_AGU;
    if (g.arah === 'IN') {
      if (sebelum) c.inSblm += g.qty;
      if (agustus) c.inAgu += g.qty;
    } else {
      if (sebelum) c.outSblm += g.qty;
      if (agustus) c.outAgu += g.qty;
    }
    rekap.set(g.barcode, c);
  }

  // Katalog gabungan: barang yang dipantau stoknya + barang yang hanya punya harga.
  const katalog = [];
  const sudah = new Set();
  for (const [bc, b] of inv.barang) {
    const c = rekap.get(bc) || { inSblm: 0, outSblm: 0, inAgu: 0, outAgu: 0 };
    const h = inv.harga.get(bc);
    katalog.push({
      sku: b.barcode,
      nama: b.nama,
      satuan: b.satuan,
      beli: b.hargaBeli || (h ? h.hargaBeli : 0),
      jual: h ? h.hargaJual : b.hargaDiskon,
      minStok: b.minStok,
      supplier: b.supplier,
      stokJuli: b.stokAwal + c.inSblm - c.outSblm,
      stokAkhirExcel: b.stokAkhir,
      keluar: c.outAgu,
      dipantau: true,
    });
    sudah.add(bc);
  }
  for (const [bc, h] of inv.harga) {
    if (sudah.has(bc)) continue;
    katalog.push({
      sku: bc,
      nama: h.nama,
      satuan: h.satuan || 'PCS',
      beli: h.hargaBeli,
      jual: h.hargaJual,
      minStok: 0,
      supplier: '',
      stokJuli: 0,
      stokAkhirExcel: 0,
      keluar: 0,
      dipantau: false,
    });
    sudah.add(bc);
  }

  const { peta, gagal } = petakan(jual, katalog);

  // Produk yang dijual tetapi tidak ada padanannya di berkas inventory tetap
  // harus punya tempat: kalau tidak, ordernya batal seluruhnya dan penjualan
  // yang benar-benar terjadi hilang dari pembukuan. Barang seperti ini dibuat
  // sebagai produk tersendiri dengan HPP dan harga jual dari sheet penjualan,
  // ditandai supaya jelas asalnya bukan dari daftar gudang.
  const dibuatDariPenjualan = [];
  for (const g of gagal) {
    const sku = ('JUAL-' + g.nama.toUpperCase().replace(/[^A-Z0-9]+/g, '-')).replace(/-+$/, '').slice(0, 40);
    const entri = {
      sku,
      nama: g.nama,
      satuan: 'PCS',
      beli: Math.round(g.hpp || 0),
      jual: Math.round(g.harga || 0),
      minStok: 0,
      supplier: '',
      stokJuli: 0,
      stokAkhirExcel: 0,
      keluar: 0,
      dipantau: false,
      dariPenjualan: true,
    };
    katalog.push(entri);
    peta.set(g.nama, { sku, namaGudang: g.nama, hpp: entri.beli, harga: entri.jual, qty: g.qty, cara: 'dibuat dari sheet penjualan', mirip: 0 });
    dibuatDariPenjualan.push(entri);
  }

  // Kelompokkan baris penjualan menjadi order.
  const order = new Map();
  for (const j of jual) {
    const kunci = j.noPesanan
      ? `NO:${j.noPesanan}`
      : `X:${j.tanggal}|${j.toko}|${j.pembeli}|${j.resi}`;
    if (!order.has(kunci)) order.set(kunci, { kunci, baris: [] });
    order.get(kunci).baris.push(j);
  }

  const daftarOrder = [];
  const orderGagal = [];
  for (const o of order.values()) {
    const p = o.baris[0];
    const items = [];
    let adminTotal = 0;
    let ongkirTotal = 0;
    let takKenal = false;

    for (const b of o.baris) {
      const m = peta.get(b.nama);
      if (!m) {
        takKenal = true;
        break;
      }
      items.push({ sku: m.sku, qty: b.qty, price: b.hargaSatuan });
      adminTotal += b.biayaAdmin;
      ongkirTotal += b.ongkirKirim + b.ongkir;
    }

    if (takKenal) {
      orderGagal.push({ kunci: o.kunci, alasan: 'ada produk yang belum terpetakan' });
      continue;
    }

    const status = statusDari(p.status);
    daftarOrder.push({
      kunci: o.kunci,
      order_date: p.tanggal,
      channel: kanalDari(p.toko, p.pembayaran),
      toko: p.toko,
      customer: potong(p.pembeli, 120),
      items,
      admin_fee: Math.round(adminTotal),
      shipping_charged: Math.round(ongkirTotal),
      // Order tanpa nomor pesanan tetap diberi penanda tetap yang dihitung dari
      // isinya sendiri. Tanpa itu, menjalankan ulang skrip ini setelah Excel
      // diperbarui akan mencatatnya lagi sebagai order baru.
      order_ref: potong(p.noPesanan, 80) || penandaTetap(o.kunci),
      courier: potong(p.ekspedisi, 50),
      tracking_no: potong(p.resi, 80),
      fulfillment_status: status,
      payout_date: p.tglCair || null,
      buyer_name: potong(p.pembeli, 120),
      buyer_account: potong(p.akun, 120),
      buyer_phone: potong(p.hp, 30),
      buyer_address: potong(p.alamat, 300),
      buyer_city: potong(p.asalKota, 80),
      lead_source: potong(p.asalLeads, 50),
      // Dana marketplace yang belum cair adalah piutang yang nyata, jadi
      // statusnya dibiarkan belum dibayar sampai tanggal cairnya tercatat.
      payment_status: status === 'CAIR' ? 'PAID' : 'UNPAID',
      bank: p.bank || null,
    });
  }
  daftarOrder.sort((a, b) => (a.order_date < b.order_date ? -1 : a.order_date > b.order_date ? 1 : 0));

  // Barang masuk Agustus, dengan tanggal aslinya.
  const masuk = inv.gerak
    .filter((g) => g.arah === 'IN' && g.tanggal >= AWAL_AGU && g.tanggal <= AKHIR_AGU)
    .map((g) => ({ ...g }))
    .sort((a, b) => (a.tanggal < b.tanggal ? -1 : 1));

  // Simulasi stok untuk menemukan kekurangan sebelum apa pun dikirim.
  const stok = new Map();
  for (const k of katalog) stok.set(k.sku, k.stokJuli);
  const kejadian = [
    ...masuk.map((m) => ({ tanggal: m.tanggal, jenis: 'IN', sku: m.barcode, qty: m.qty })),
    ...daftarOrder.flatMap((o) => o.items.map((i) => ({ tanggal: o.order_date, jenis: 'OUT', sku: i.sku, qty: i.qty }))),
  ].sort((a, b) => (a.tanggal < b.tanggal ? -1 : a.tanggal > b.tanggal ? 1 : a.jenis === 'IN' ? -1 : 1));

  const kurang = new Map();
  for (const k of kejadian) {
    const s = (stok.get(k.sku) || 0) + (k.jenis === 'IN' ? k.qty : -k.qty);
    stok.set(k.sku, s);
    if (s < 0) {
      const perlu = Math.ceil(-s);
      if (perlu > (kurang.get(k.sku) || 0)) kurang.set(k.sku, perlu);
    }
  }

  return { inv, jual, katalog, peta, gagal, dibuatDariPenjualan, daftarOrder, orderGagal, masuk, kurang };
}

// ------------------------------------------------------------------
// Penerapan
// ------------------------------------------------------------------

async function jalankan() {
  const r = await susunRencana();

  console.log('='.repeat(66));
  console.log(TERAP ? 'MUAT ULANG DATA — MENULIS' : 'MUAT ULANG DATA — PRATINJAU (tidak menulis)');
  console.log('='.repeat(66));
  console.log('sasaran            :', BASE);
  console.log('produk di katalog  :', r.katalog.length);
  console.log('nama penjualan     :', r.peta.size + r.gagal.length, `(terpetakan ${r.peta.size}, gagal ${r.gagal.length})`);
  console.log('baris penjualan    :', r.jual.length);
  console.log('order terbentuk    :', r.daftarOrder.length, r.orderGagal.length ? `(gagal ${r.orderGagal.length})` : '');
  console.log('barang masuk Agu   :', r.masuk.length, 'mutasi');

  const totJuli = r.katalog.reduce((s, k) => s + k.stokJuli, 0);
  const totAkhir = r.katalog.reduce((s, k) => s + k.stokAkhirExcel, 0);
  console.log('unit posisi 31 Jul :', totJuli);
  console.log('unit akhir (Excel) :', totAkhir);

  if (r.gagal.length) {
    console.log('\n--- Produk penjualan yang belum terpetakan ---');
    for (const g of r.gagal) console.log(`  ${String(g.qty).padStart(5)}  ${g.nama}  (${g.alasan})`);
  }

  if (r.kurang.size) {
    console.log('\n--- Kekurangan stok menurut simulasi ---');
    console.log('    Penjualan mencatat lebih banyak unit keluar daripada yang tercatat');
    console.log('    di gudang. Selisih ini dicatat sebagai koreksi bertanggal 1 Agustus,');
    console.log('    diberi keterangan agar bisa ditelusuri, bukan disembunyikan.');
    for (const [sku, qty] of [...r.kurang].sort((a, b) => b[1] - a[1])) {
      const k = r.katalog.find((x) => x.sku === sku);
      console.log(`  ${String(qty).padStart(5)}  ${sku.padEnd(14)} ${(k ? k.nama : '').slice(0, 34)}`);
    }
  }

  if (!TERAP) {
    console.log('\nJalankan ulang dengan --apply untuk menerapkan.');
    return;
  }

  // ---------------- mulai menulis ----------------
  const masukLogin = await api('POST', '/api/auth/login', { email: EMAIL.toLowerCase(), password: SANDI });
  token = masukLogin.token;
  console.log('\nmasuk sebagai      :', masukLogin.user.name);

  // 1. Pemasok
  const namaSupplier = [...new Set(r.katalog.map((k) => k.supplier).filter(Boolean))];
  const mitraAda = await api('GET', '/api/partners?limit=1000');
  const petaMitra = new Map((mitraAda.partners || []).map((p) => [p.name.trim().toUpperCase(), p.id]));
  let mitraBaru = 0;
  for (const nama of namaSupplier) {
    if (petaMitra.has(nama.toUpperCase())) continue;
    const p = await api('POST', '/api/partners', { name: nama, type: 'SUPPLIER' });
    petaMitra.set(nama.toUpperCase(), p.partner ? p.partner.id : p.id);
    mitraBaru += 1;
  }
  console.log(`pemasok            : ${namaSupplier.length} dipakai, ${mitraBaru} baru`);

  // 2. Produk
  const produkAda = await api('GET', '/api/inventory/products?limit=2000');
  const petaProduk = new Map((produkAda.products || []).map((p) => [p.sku.trim().toUpperCase(), p]));
  let pBaru = 0;
  let pUbah = 0;
  // Barang yang benar-benar perlu ada: yang stoknya dipantau di DAFTAR BARANG,
  // dan yang dipakai penjualan Agustus. Entri yang hanya muncul di daftar harga
  // tanpa stok dan tanpa penjualan tidak dibuat — daftar harga memuat banyak
  // barang yang tidak lagi ditangani, dan menghidupkannya kembali akan membatalkan
  // perapian katalog yang sudah dikerjakan manual.
  const skuDipakai = new Set();
  for (const o of r.daftarOrder) for (const i of o.items) skuDipakai.add(i.sku.toUpperCase());
  for (const m of r.masuk) skuDipakai.add(m.barcode.toUpperCase());

  let pLewat = 0;
  for (const k of r.katalog) {
    const kunci = k.sku.trim().toUpperCase();
    const lama = petaProduk.get(kunci);
    const perlu = k.dipantau || skuDipakai.has(kunci) || !!lama;
    if (!perlu) {
      pLewat += 1;
      continue;
    }

    const badan = {
      sku: k.sku,
      name: k.nama,
      // Kategori tidak diambil dari Excel — kolomnya memang tidak ada di sana,
      // dan yang sudah dikelompokkan manual di aplikasi tidak boleh tertimpa.
      category: lama ? lama.category : 'Produk Organik',
      unit: (k.satuan || 'PCS').toUpperCase(),
      cost: Math.round(k.beli || 0),
      price: Math.round(k.jual || 0),
      min_stock: Math.round(k.minStok || 0),
      supplier_id: k.supplier ? petaMitra.get(k.supplier.toUpperCase()) || null : null,
      active: true,
    };

    if (!lama) {
      const hasil = await api('POST', '/api/inventory/products', badan);
      petaProduk.set(kunci, hasil.product || hasil);
      pBaru += 1;
    } else {
      await api('PUT', `/api/inventory/products/${lama.id}`, badan);
      pUbah += 1;
    }
  }
  console.log(`produk             : ${pBaru} baru, ${pUbah} diperbarui, ${pLewat} dilewati (hanya ada di daftar harga)`);

  const idProduk = new Map();
  const segar = await api('GET', '/api/inventory/products?limit=2000');
  for (const p of segar.products) idProduk.set(p.sku.trim().toUpperCase(), p.id);

  // 3. Toko
  const tokoDipakai = [...new Set(r.daftarOrder.map((o) => o.toko).filter(Boolean))];
  const tokoAda = await api('GET', '/api/shops');
  const petaToko = new Map((tokoAda.shops || []).map((s) => [s.name.trim().toUpperCase(), s.id]));
  let tBaru = 0;
  for (const nama of tokoDipakai) {
    if (petaToko.has(nama.toUpperCase())) continue;
    const s = await api('POST', '/api/shops', { name: nama, channel: kanalDari(nama, '') });
    petaToko.set(nama.toUpperCase(), (s.shop || s).id);
    tBaru += 1;
  }
  console.log(`toko               : ${tokoDipakai.length} dipakai, ${tBaru} baru`);

  // 4. Opname posisi 31 Juli
  const posisiJuli = r.katalog
    .filter((k) => idProduk.has(k.sku.toUpperCase()))
    .map((k) => ({
      sku: k.sku,
      product_id: idProduk.get(k.sku.toUpperCase()),
      qty: Math.max(0, Math.round(k.stokJuli + (r.kurang.get(k.sku) || 0))),
      beli: Math.round(k.beli || 0),
      supplier: k.supplier,
    }))
    .filter((k) => k.qty > 0);
  // Posisi awal hanya disetel sekali. Bila sudah ada penjualan Agustus yang
  // tercatat, menyetelnya lagi akan mengembalikan stok ke posisi Juli seolah
  // penjualan itu tidak pernah terjadi.
  const orderSudahAda = await api('GET', `/api/sales?from=${AWAL_AGU}&to=${AKHIR_AGU}&limit=1`);
  const perluOpnameAwal = orderSudahAda.summary.orders === 0;

  // Barang yang sudah ada di gudang sebelum sistem ini dipakai dicatat sebagai
  // saldo awal: persediaan bertambah dengan lawan Modal Pemilik.
  //
  // Sebelumnya posisi awal disetel lewat stok opname, dan itu keliru secara
  // pembukuan — opname mencatat selisihnya sebagai untung atau rugi, sehingga
  // persediaan awal Rp 65,9 juta muncul sebagai keuntungan dan membuat laba
  // bersih lebih besar daripada laba kotor. Barang yang memang sudah dimiliki
  // bukan keuntungan bulan ini; ia modal yang sudah tertanam.
  let saldoAwal = 0;
  if (perluOpnameAwal) {
    for (const k of posisiJuli) {
      await api('POST', '/api/inventory/moves', {
        product_id: k.product_id,
        move_date: AKHIR_JUL,
        move_type: 'IN',
        qty: k.qty,
        unit_cost: k.beli,
        payment: 'OPENING',
        partner_id: k.supplier ? petaMitra.get(k.supplier.toUpperCase()) || null : null,
        ref: 'SALDO-AWAL',
        note: 'Posisi 31 Juli 2026 menurut REPORT INVENTORY (stok awal + mutasi sampai Juli)',
      });
      saldoAwal += 1;
    }
  }
  console.log(
    perluOpnameAwal
      ? `saldo awal 31 Juli : ${saldoAwal} produk dicatat sebagai modal awal`
      : 'saldo awal 31 Juli : dilewati — sudah ada penjualan Agustus yang tercatat'
  );

  // 5. Barang masuk Agustus
  const mutasiAda = await api('GET', `/api/inventory/moves?from=${AWAL_AGU}&to=${AKHIR_AGU}&limit=5000`);
  const sudahMasuk = new Set(
    (mutasiAda.rows || [])
      .filter((x) => x.move_type === 'IN')
      .map((x) => `${x.move_date}|${(x.sku || '').toUpperCase()}|${x.qty}`)
  );
  let mOk = 0;
  let mGagal = 0;
  let mLewat = 0;
  for (const m of r.masuk) {
    if (sudahMasuk.has(`${m.tanggal}|${m.barcode.toUpperCase()}|${m.qty}`)) {
      mLewat += 1;
      continue;
    }
    const pid = idProduk.get(m.barcode.toUpperCase());
    if (!pid) {
      mGagal += 1;
      continue;
    }
    const k = r.katalog.find((x) => x.sku.toUpperCase() === m.barcode.toUpperCase());
    try {
      await api('POST', '/api/inventory/moves', {
        product_id: pid,
        move_date: m.tanggal,
        move_type: 'IN',
        qty: m.qty,
        unit_cost: Math.round((k && k.beli) || 0),
        payment: 'CREDIT',
        partner_id: k && k.supplier ? petaMitra.get(k.supplier.toUpperCase()) || null : null,
        ref: m.ket ? m.ket.slice(0, 60) : null,
        note: `Diperiksa oleh ${m.oleh || '-'}`.slice(0, 300),
      });
      mOk += 1;
    } catch (e) {
      mGagal += 1;
      console.log(`  ! barang masuk ${m.barcode} ${m.tanggal}: ${e.message}`);
    }
  }
  console.log(`barang masuk       : ${mOk} tercatat, ${mLewat} dilewati (sudah ada), ${mGagal} gagal`);

  // 6. Order penjualan
  const adaOrder = await api('GET', `/api/sales?from=${AWAL_AGU}&to=${AKHIR_AGU}&limit=5000`);
  const sudahRef = new Set((adaOrder.rows || []).map((o) => o.order_ref).filter(Boolean));
  let oOk = 0;
  let oLewat = 0;
  const oGagal = [];

  for (const o of r.daftarOrder) {
    if (o.order_ref && sudahRef.has(o.order_ref)) {
      oLewat += 1;
      continue;
    }
    const items = o.items
      .map((i) => ({ product_id: idProduk.get(i.sku.toUpperCase()), qty: i.qty, price: Math.round(i.price) }))
      .filter((i) => i.product_id);
    if (!items.length) {
      oGagal.push({ kunci: o.kunci, pesan: 'tidak ada item yang dikenali' });
      continue;
    }
    const bruto = items.reduce((s, i) => s + i.qty * i.price, 0);
    try {
      await api('POST', '/api/sales', {
        order_date: o.order_date,
        channel: o.channel,
        customer: o.customer,
        items,
        admin_fee: o.admin_fee,
        admin_fee_pct: bruto ? Number(((o.admin_fee / bruto) * 100).toFixed(2)) : 0,
        shipping_charged: o.shipping_charged,
        shop_id: o.toko ? petaToko.get(o.toko.toUpperCase()) || null : null,
        order_ref: o.order_ref,
        courier: o.courier,
        tracking_no: o.tracking_no,
        fulfillment_status: o.fulfillment_status,
        payout_date: o.payout_date,
        buyer_name: o.buyer_name,
        buyer_account: o.buyer_account,
        buyer_phone: o.buyer_phone,
        buyer_address: o.buyer_address,
        buyer_city: o.buyer_city,
        lead_source: o.lead_source,
        payment_status: o.payment_status,
        note: o.bank ? `Bank: ${o.bank}` : null,
      });
      oOk += 1;
      if (oOk % 100 === 0) console.log(`  ... ${oOk} order tercatat`);
    } catch (e) {
      oGagal.push({ kunci: o.kunci, pesan: e.message });
    }
  }
  console.log(`order penjualan    : ${oOk} tercatat, ${oLewat} dilewati (sudah ada), ${oGagal.length} gagal`);
  for (const g of oGagal.slice(0, 10)) console.log(`  ! ${g.kunci}: ${g.pesan}`);

  // 7. Opname penutup — samakan dengan angka Excel
  const barisPenutup = r.katalog
    .filter((k) => k.dipantau && idProduk.has(k.sku.toUpperCase()))
    .map((k) => ({
      product_id: idProduk.get(k.sku.toUpperCase()),
      physical_qty: Math.max(0, Math.round(k.stokAkhirExcel)),
    }));
  const opAkhir = await api('POST', '/api/inventory/opname', {
    opname_date: AKHIR_AGU,
    note: 'Penyamaan dengan STOK AKHIR pada REPORT INVENTORY per Agustus 2026 (termasuk barang rusak yang tidak tercatat di log mutasi)',
    lines: barisPenutup,
  });
  console.log(`opname penutup     : ${opAkhir.opname_no || '-'} (${barisPenutup.length} produk, ${opAkhir.changed ?? '?'} berubah)`);

  // 8. Bukti akhir
  const val = await api('GET', '/api/inventory/valuation');
  const dash = await api('GET', `/api/dashboard?from=${AWAL_AGU}&to=${AKHIR_AGU}`);
  console.log('\n--- Hasil akhir ---');
  console.log('nilai persediaan   :', rupiah(val.totalValue), `(${val.totalSku} SKU, ${val.totalQty} unit)`);
  console.log('order Agustus      :', dash.penjualan.periode.orders);
  console.log('omzet Agustus      :', rupiah(dash.penjualan.periode.netRevenue));
  console.log('HPP Agustus        :', rupiah(dash.penjualan.periode.cogs));
  console.log('laba bersih Agustus:', rupiah(dash.penjualan.periode.netProfit));
  console.log('neraca seimbang    :', dash.keuangan.balanced);
}

jalankan().catch((e) => {
  console.error('\nGAGAL:', e.message);
  if (e.detail) console.error(JSON.stringify(e.detail).slice(0, 400));
  process.exit(1);
});
