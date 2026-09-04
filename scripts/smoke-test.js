'use strict';
/**
 * Uji asap end-to-end: menembak REST API sungguhan lalu memverifikasi bahwa
 * keempat modul saling konsisten — khususnya bahwa Neraca tetap seimbang
 * setelah rangkaian transaksi.
 *
 * Jalankan dengan server hidup:  node scripts/smoke-test.js
 * atau otomatis (server dinyalakan sendiri):  npm run smoke
 */
require('dotenv').config();

const BASE = process.env.SMOKE_BASE_URL || `http://localhost:${process.env.PORT || 3000}`;
let token = null;
let passed = 0;
let failed = 0;

async function call(method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : {};
  if (!res.ok) {
    const err = new Error(`${method} ${path} → ${res.status}: ${data.error || text}`);
    err.status = res.status;
    err.serverMessage = data.error || '';
    throw err;
  }
  return data;
}


const sandiAkun = new Map();

/**
 * Masuk sebagai akun selain admin.
 *
 * Akun yang dibuatkan pengelola wajib mengganti kata sandi sebelum boleh
 * memakai menu apa pun, jadi langkah itu ditirukan di sini — pemeriksaan hak
 * akses di bawah harus menguji izin, bukan kewajiban ganti kata sandi. Kata
 * sandi penggantinya diingat supaya akun yang sama bisa dipakai masuk lagi.
 */
async function masukSebagai(email, sandiAwal) {
  const sandi = sandiAkun.get(email) || sandiAwal;
  const masuk = await call('POST', '/api/auth/login', { email, password: sandi });
  if (!masuk.sandi || !masuk.sandi.wajib) return masuk.token;

  const simpan = token;
  token = masuk.token;
  const baru = `Uji#Sandi${Date.now()}a`;
  await call('POST', '/api/auth/ganti-sandi', { currentPassword: sandi, newPassword: baru });
  sandiAkun.set(email, baru);
  const lagi = await call('POST', '/api/auth/login', { email, password: baru });
  token = simpan;
  return lagi.token;
}
function check(label, condition, detail = '') {
  if (condition) {
    passed += 1;
    console.log(`  ✓ ${label}`);
  } else {
    failed += 1;
    console.log(`  ✗ ${label} ${detail}`);
  }
}

const near = (a, b, tol = 0.02) => Math.abs(a - b) <= tol;
const today = new Date().toLocaleDateString('sv-SE');

async function main() {
  console.log(`\nUji asap ERP — ${BASE}\n`);

  // ---------- Kesehatan & autentikasi ----------
  console.log('1. Kesehatan & Autentikasi');
  const health = await call('GET', '/api/health');
  check('endpoint /api/health merespons', health.ok === true);

  const login = await call('POST', '/api/auth/login', {
    email: (process.env.SEED_ADMIN_EMAIL || 'admin@kebumen.local').toLowerCase(),
    password: process.env.SEED_ADMIN_PASSWORD || 'Admin#12345',
  });
  token = login.token;
  check('login admin berhasil', !!token);

  let rejected = false;
  try {
    await call('POST', '/api/auth/login', { email: login.user.email, password: 'salah-total' });
  } catch {
    rejected = true;
  }
  check('password salah ditolak', rejected);

  // ---------- Modul 3: Produk & stok ----------
  console.log('\n2. Modul Gudang');
  const sku = `TEST-${Date.now()}`;
  const { product } = await call('POST', '/api/inventory/products', {
    sku, name: 'Produk Uji Asap', category: 'Uji', unit: 'PCS',
    cost: 10000, price: 25000, min_stock: 5,
  });
  check('produk dibuat', product.id > 0);

  // Stok masuk 100 @ 12.000 → HPP rata-rata harus 12.000 (stok awal 0)
  await call('POST', '/api/inventory/moves', {
    product_id: product.id, move_date: today, move_type: 'IN',
    qty: 100, unit_cost: 12000, payment: 'CASH', ref: 'SMOKE-IN',
  });
  const afterIn = await call('GET', `/api/inventory/products?q=${sku}`);
  const p1 = afterIn.products[0];
  check('stok bertambah menjadi 100', p1.stock === 100, `(${p1.stock})`);
  check('HPP rata-rata bergerak = 12.000', near(p1.cost, 12000), `(${p1.cost})`);
  check('nilai persediaan = 1.200.000', near(p1.stock_value, 1_200_000), `(${p1.stock_value})`);

  // Stok masuk kedua 100 @ 14.000 → rata-rata (1.200.000 + 1.400.000)/200 = 13.000
  await call('POST', '/api/inventory/moves', {
    product_id: product.id, move_date: today, move_type: 'IN',
    qty: 100, unit_cost: 14000, payment: 'CREDIT',
  });
  const afterIn2 = await call('GET', `/api/inventory/products?q=${sku}`);
  check('HPP rata-rata jadi 13.000 setelah pembelian kedua',
    near(afterIn2.products[0].cost, 13000), `(${afterIn2.products[0].cost})`);

  // ---------- Modul 4: Penjualan ----------
  console.log('\n3. Modul Penjualan & Margin');
  // 10 unit @ 25.000 = 250.000 kotor; diskon 0; HPP 10×13.000 = 130.000
  // admin 8% dari 250.000 = 20.000; packing 5.000 → biaya 25.000
  // laba kotor 120.000; laba bersih 95.000; margin 38%
  const order = await call('POST', '/api/sales', {
    order_date: today,
    channel: 'SHOPEE',
    customer: 'Pembeli Uji',
    items: [{ product_id: product.id, qty: 10, price: 25000 }],
    admin_fee_pct: 8,
    packing_cost: 5000,
    payment_status: 'PAID',
  });
  const o = order.order;
  check('penjualan kotor = 250.000', near(o.gross_sales, 250_000), `(${o.gross_sales})`);
  check('HPP order = 130.000', near(o.cogs, 130_000), `(${o.cogs})`);
  check('biaya admin 8% = 20.000', near(o.admin_fee, 20_000), `(${o.admin_fee})`);
  check('total biaya = 25.000', near(o.total_fees, 25_000), `(${o.total_fees})`);
  check('laba kotor = 120.000', near(o.gross_profit, 120_000), `(${o.gross_profit})`);
  check('laba bersih = 95.000', near(o.net_profit, 95_000), `(${o.net_profit})`);
  check('margin = 38%', near(o.margin_pct, 38, 0.05), `(${o.margin_pct})`);

  const afterSale = await call('GET', `/api/inventory/products?q=${sku}`);
  check('stok berkurang menjadi 190', afterSale.products[0].stock === 190, `(${afterSale.products[0].stock})`);

  // Stok tidak cukup harus ditolak
  let stockGuard = false;
  try {
    await call('POST', '/api/sales', {
      order_date: today, channel: 'WEBSITE',
      items: [{ product_id: product.id, qty: 99999, price: 25000 }],
    });
  } catch {
    stockGuard = true;
  }
  check('penjualan melebihi stok ditolak', stockGuard);

  // ---------- Modul 2: Akuntansi ----------
  console.log('\n4. Modul Keuangan (Dual-Entry)');
  const tb = await call('GET', `/api/finance/reports/trial-balance?from=2000-01-01&to=${today}`);
  check('neraca saldo seimbang (Debit = Kredit)', tb.balanced,
    `(D ${tb.totalDebit} vs K ${tb.totalCredit})`);

  const bs = await call('GET', `/api/finance/reports/balance-sheet?asOf=${today}`);
  check('neraca seimbang (Aset = Kewajiban + Ekuitas)', bs.balanced,
    `(${bs.assets.total} vs ${bs.totalLiabilitiesAndEquity})`);
  check('persediaan di neraca = nilai stok gudang',
    near(bs.assets.current.totalInventory, afterSale.products[0].stock * afterSale.products[0].cost, 1),
    `(${bs.assets.current.totalInventory})`);

  const pnl = await call('GET', `/api/finance/reports/income-statement?from=2000-01-01&to=${today}`);
  check('laba rugi mencatat penjualan kotor 250.000', near(pnl.grossSales, 250_000), `(${pnl.grossSales})`);
  check('laba rugi mencatat HPP 130.000', near(pnl.cogs, 130_000), `(${pnl.cogs})`);
  check('laba kotor laporan = 120.000', near(pnl.grossProfit, 120_000), `(${pnl.grossProfit})`);
  check('laba bersih laporan = 95.000', near(pnl.netProfit, 95_000), `(${pnl.netProfit})`);

  const cf = await call('GET', `/api/finance/reports/cash-flow?from=2000-01-01&to=${today}`);
  check('arus kas: kas akhir = saldo kas di neraca',
    near(cf.closingCash, bs.assets.current.totalCash, 1),
    `(${cf.closingCash} vs ${bs.assets.current.totalCash})`);

  // Jurnal tidak seimbang harus ditolak
  const { accounts } = await call('GET', '/api/finance/accounts');
  const kas = accounts.find((a) => a.code === '1000');
  const beban = accounts.find((a) => a.code === '6110');

  let journalStatus = 0;
  let journalMessage = '';
  try {
    await call('POST', '/api/finance/journals', {
      entry_date: today, description: 'Jurnal sengaja tidak seimbang',
      lines: [
        { account_id: beban.id, debit: 100000, credit: 0 },
        { account_id: kas.id, debit: 0, credit: 90000 },
      ],
    });
  } catch (err) {
    journalStatus = err.status || 0;
    journalMessage = err.serverMessage || '';
  }
  check('jurnal tidak seimbang ditolak', journalStatus >= 400, `(status ${journalStatus})`);
  // Regresi: pelanggaran aturan harus 4xx, bukan 500. Bila 500, NODE_ENV=production
  // akan menyamarkan pesannya menjadi "Terjadi kesalahan pada server".
  check('penolakan jurnal berstatus 4xx, bukan 500',
    journalStatus >= 400 && journalStatus < 500, `(status ${journalStatus})`);
  check('pesan selisih jurnal tetap terbaca di mode produksi',
    /tidak seimbang/i.test(journalMessage), `("${journalMessage}")`);

  // Jurnal manual yang benar
  const jv = await call('POST', '/api/finance/journals', {
    entry_date: today, description: 'Bayar sewa gudang (uji asap)',
    lines: [
      { account_id: beban.id, debit: 500000, credit: 0 },
      { account_id: kas.id, debit: 0, credit: 500000 },
    ],
  });
  check('jurnal manual seimbang tersimpan', !!jv.journal.entry_no);

  const bs2 = await call('GET', `/api/finance/reports/balance-sheet?asOf=${today}`);
  check('neraca tetap seimbang setelah jurnal manual', bs2.balanced);

  // ---------- Stok opname ----------
  console.log('\n5. Stok Opname');
  // Fisik 185 vs sistem 190 → selisih -5 × 13.000 = -65.000
  const opname = await call('POST', '/api/inventory/opname', {
    opname_date: today,
    note: 'Opname uji asap',
    lines: [{ product_id: product.id, physical_qty: 185 }],
  });
  check('selisih opname = -65.000', near(opname.total_diff_value, -65_000), `(${opname.total_diff_value})`);

  const afterOpname = await call('GET', `/api/inventory/products?q=${sku}`);
  check('stok sistem disesuaikan menjadi 185', afterOpname.products[0].stock === 185,
    `(${afterOpname.products[0].stock})`);

  const bs3 = await call('GET', `/api/finance/reports/balance-sheet?asOf=${today}`);
  check('neraca tetap seimbang setelah opname', bs3.balanced);

  // ---------- Pembatalan order ----------
  console.log('\n6. Pembatalan Order');
  await call('DELETE', `/api/sales/${o.id}`);
  const afterCancel = await call('GET', `/api/inventory/products?q=${sku}`);
  check('stok dikembalikan menjadi 195', afterCancel.products[0].stock === 195,
    `(${afterCancel.products[0].stock})`);

  const bs4 = await call('GET', `/api/finance/reports/balance-sheet?asOf=${today}`);
  check('neraca tetap seimbang setelah pembatalan', bs4.balanced);

  const pnl2 = await call('GET', `/api/finance/reports/income-statement?from=2000-01-01&to=${today}`);
  check('penjualan kembali nol setelah order dibatalkan', near(pnl2.grossSales, 0), `(${pnl2.grossSales})`);

  // ---------- Dashboard & presensi ----------
  console.log('\n7. Dashboard & Presensi');
  const dash = await call('GET', '/api/dashboard');
  check('dashboard memuat keempat modul',
    !!(dash.penjualan && dash.presensi && dash.stok && dash.keuangan));
  check('dashboard punya bagian realtime hari ini',
    !!(dash.penjualan.hariIni && dash.presensi.hariIni));
  check('dashboard menyertakan analisis otomatis', Array.isArray(dash.temuan));
  check('setiap temuan menyebutkan dasar hitungnya',
    dash.temuan.every((t) => t.judul && t.pesan && t.dasar && t.aksi),
    `(${dash.temuan.length} temuan)`);

  const att = await call('GET', '/api/attendance/today');
  check('status presensi hari ini tersedia', !!att.date);
  check('titik kantor untuk geofencing tersedia', Array.isArray(att.offices));

  // WFO di luar radius harus ditolak (koordinat sengaja jauh)
  let geoGuard = false;
  try {
    await call('POST', '/api/attendance/check-in', {
      workType: 'WFO', lat: -6.2, lng: 106.816, accuracy: 10,
      photo: `data:image/jpeg;base64,${Buffer.from('x'.repeat(64)).toString('base64')}`,
    });
  } catch (err) {
    geoGuard = /ditolak|radius/i.test(err.message);
  }
  check('presensi WFO di luar geofence ditolak', geoGuard);

  // ---------- Kasus yang pernah merusak buku ----------
  // Ditaruh paling akhir karena menambah transaksi baru, sehingga tidak
  // mengganggu angka yang diperiksa pemeriksaan sebelumnya.
  console.log('\n7. Order dengan produk berulang');

  // Satu order boleh memuat produk yang sama dua kali. Dulu pengurangan kedua
  // menimpa yang pertama, sehingga stok tampak masih utuh padahal barangnya
  // sudah keluar dua kali — dan buku besar ikut salah karenanya.
  const sblmGanda = (await call('GET', `/api/inventory/products?q=${sku}`)).products[0].stock;
  await call('POST', '/api/sales', {
    order_date: today, channel: 'WEBSITE',
    items: [
      { product_id: product.id, qty: 3, price: 25000 },
      { product_id: product.id, qty: 2, price: 24000 },
    ],
  });
  const ssdhGanda = (await call('GET', `/api/inventory/products?q=${sku}`)).products[0].stock;
  check('produk yang sama dua kali dalam satu order mengurangi stok dua kali',
    ssdhGanda === sblmGanda - 5, `(${sblmGanda} menjadi ${ssdhGanda}, seharusnya ${sblmGanda - 5})`);

  const mutasiGanda = await call('GET', `/api/inventory/moves?from=${today}&to=${today}`);
  const duaBaris = mutasiGanda.rows.filter((m) => m.sku === sku && m.move_type === 'OUT').slice(0, 2);
  check('saldo pada mutasi ikut menurun bertahap',
    duaBaris.length === 2 && duaBaris[0].balance_after !== duaBaris[1].balance_after,
    duaBaris.map((m) => m.balance_after).join(' & '));

  // Kecukupan stok harus diukur dari total permintaan, bukan per baris.
  let gandaMelebihi = false;
  try {
    await call('POST', '/api/sales', {
      order_date: today, channel: 'WEBSITE',
      items: [
        { product_id: product.id, qty: ssdhGanda, price: 25000 },
        { product_id: product.id, qty: 1, price: 25000 },
      ],
    });
  } catch {
    gandaMelebihi = true;
  }
  check('total dua baris yang melebihi stok ditolak', gandaMelebihi);

  // ---------- Mengubah order yang sudah tersimpan ----------
  console.log('\n8. Ubah order penjualan');

  const stokSblmUbah = (await call('GET', `/api/inventory/products?q=${sku}`)).products[0].stock;
  const belumBayar = await call('POST', '/api/sales', {
    order_date: today, channel: 'SHOPEE', customer: 'Uji Ubah',
    items: [{ product_id: product.id, qty: 4, price: 25000 }],
    admin_fee: 5000, payment_status: 'UNPAID', fulfillment_status: 'DIKIRIM',
  });
  const idUbah = belumBayar.order.id;

  const akunSaldo = async (kode) => {
    const { accounts } = await call('GET', `/api/finance/accounts?asOf=${today}`);
    return accounts.find((a) => a.code === kode).balance;
  };
  // Dana marketplace yang belum cair punya akunnya sendiri, terpisah dari
  // piutang usaha biasa, jadi kodenya disebut eksplisit.
  const KODE_PIUTANG = '1110';

  const piutangAwal = await akunSaldo(KODE_PIUTANG);
  check('order belum cair menambah piutang', piutangAwal > 0, `(${piutangAwal})`);

  // Hanya status pengiriman yang berubah — angka tidak boleh bergeser.
  await call('PUT', `/api/sales/${idUbah}`, { fulfillment_status: 'SELESAI' });
  const setelahStatus = await call('GET', `/api/sales/${idUbah}`);
  check('status pesanan bisa diubah', setelahStatus.order.fulfillment_status === 'SELESAI');
  check('mengubah status pesanan tidak menggeser laba',
    near(setelahStatus.order.net_profit, belumBayar.order.net_profit),
    `(${setelahStatus.order.net_profit})`);
  check('mengubah status pesanan tidak menggeser piutang',
    near(await akunSaldo(KODE_PIUTANG), piutangAwal, 1));

  // Dana cair: piutang harus berpindah ke bank.
  await call('PUT', `/api/sales/${idUbah}`, {
    payment_status: 'PAID', fulfillment_status: 'CAIR', payout_date: today,
  });
  const piutangSetelahCair = await akunSaldo(KODE_PIUTANG);
  const nilaiBersih = belumBayar.order.net_revenue - belumBayar.order.total_fees;
  check('menandai lunas memindahkan piutang ke kas/bank',
    near(piutangSetelahCair, piutangAwal - nilaiBersih, 1),
    `(${piutangAwal} menjadi ${piutangSetelahCair}, nilai ${nilaiBersih})`);

  const bsUbah = await call('GET', `/api/finance/reports/balance-sheet?asOf=${today}`);
  check('neraca tetap seimbang setelah status pembayaran diubah', bsUbah.balanced);

  // Mengubah isi pesanan harus menggerakkan stok sesuai selisihnya.
  const stokSebelumItem = (await call('GET', `/api/inventory/products?q=${sku}`)).products[0].stock;
  await call('PUT', `/api/sales/${idUbah}`, {
    items: [{ product_id: product.id, qty: 6, price: 25000 }],
  });
  const stokSesudahItem = (await call('GET', `/api/inventory/products?q=${sku}`)).products[0].stock;
  check('menambah 2 unit pada order mengurangi stok 2 unit',
    stokSesudahItem === stokSebelumItem - 2,
    `(${stokSebelumItem} menjadi ${stokSesudahItem})`);

  const stlhItem = await call('GET', `/api/sales/${idUbah}`);
  check('penjualan kotor ikut dihitung ulang', near(stlhItem.order.gross_sales, 150_000),
    `(${stlhItem.order.gross_sales})`);

  // Menandai pesanan batal harus benar-benar membatalkan, bukan sekadar label.
  await call('PUT', `/api/sales/${idUbah}`, { fulfillment_status: 'BATAL' });
  const stokSetelahBatal = (await call('GET', `/api/inventory/products?q=${sku}`)).products[0].stock;
  check('menandai batal mengembalikan seluruh stok order',
    stokSetelahBatal === stokSblmUbah,
    `(${stokSetelahBatal}, sebelum order dibuat ${stokSblmUbah})`);

  const batalDetail = await call('GET', `/api/sales/${idUbah}`);
  check('order batal tidak lagi berstatus POSTED', batalDetail.order.status === 'CANCELLED',
    `(${batalDetail.order.status})`);
  check('piutang kembali seperti semula setelah order dibatalkan',
    near(await akunSaldo(KODE_PIUTANG), piutangAwal - nilaiBersih, 1));

  const bsBatal = await call('GET', `/api/finance/reports/balance-sheet?asOf=${today}`);
  check('neraca tetap seimbang setelah order dibatalkan', bsBatal.balanced);

  let tolakUbahBatal = false;
  try {
    await call('PUT', `/api/sales/${idUbah}`, { fulfillment_status: 'DIKIRIM' });
  } catch {
    tolakUbahBatal = true;
  }
  check('order yang sudah dibatalkan menolak diubah lagi', tolakUbahBatal);

  // ---------- Identitas perusahaan & data tim ----------
  console.log('\n9. Logo perusahaan & data tim');

  // PNG 16x16 sungguhan — cukup untuk membuktikan berkasnya benar-benar tersimpan
  // dan terbaca kembali, bukan sekadar namanya tercatat.
  const PNG_KECIL =
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAKElEQVR4nGP8//8/AybIKApjYKgyMEC' +
    'AsaHiQAsGBiOICFAGAFtvCk+eT318AAAAASUVORK5CYII=';

  const brandingAwal = await call('GET', '/api/branding');
  check('identitas perusahaan bisa dibaca tanpa login', !!brandingAwal.company, brandingAwal.company);

  const unggah = await call('PUT', '/api/branding/logo', { logo: PNG_KECIL });
  check('logo perusahaan bisa diunggah', !!unggah.logo);

  const brandingIsi = await call('GET', '/api/branding');
  check('logo muncul pada identitas', !!brandingIsi.logo, brandingIsi.logo || '');

  // Halaman masuk memerlukan logo sebelum ada sesi, jadi gambarnya sengaja
  // dilayani tanpa autentikasi — yang dibuka hanya logo, bukan data lain.
  const tanpaToken = await fetch(`${BASE}/api/branding/logo`);
  const gambar = Buffer.from(await tanpaToken.arrayBuffer());
  check('gambar logo terbaca tanpa login',
    tanpaToken.ok && gambar.slice(1, 4).toString() === 'PNG',
    `${tanpaToken.status}, ${gambar.length} byte`);

  const anggota = await call('POST', '/api/admin/users', {
    name: 'Anggota Uji', email: `tim-${Date.now()}@uji.local`, password: 'RahasiaKuat1',
    role: 'staff', position: 'Packing', phone: '081200000000',
    photo: PNG_KECIL, nik: 'UJI-001', department: 'Gudang',
    employment_status: 'KONTRAK', join_date: '2024-02-15', gender: 'L',
    emergency_name: 'Wali Uji', emergency_phone: '081211112222',
    bank_name: 'BCA', bank_account: '9876543210',
  });
  check('anggota tim tersimpan beserta data kepegawaian',
    anggota.user.nik === 'UJI-001' && anggota.user.department === 'Gudang' && !!anggota.user.photo,
    anggota.user.photo || '');

  const fotoRes = await call('GET', '/api/admin/users');
  const tersimpan = fotoRes.users.find((u) => u.id === anggota.user.id);
  check('ringkasan kelengkapan tim ikut dihitung',
    fotoRes.ringkas.berfoto >= 1 && fotoRes.ringkas.lengkap >= 1,
    JSON.stringify(fotoRes.ringkas));

  // Menyimpan ulang tanpa menyentuh foto tidak boleh menggandakan berkas.
  const ubahTim = await call('PUT', `/api/admin/users/${anggota.user.id}`, {
    name: 'Anggota Uji', email: tersimpan.email, role: 'staff',
    position: 'Kepala Packing', phone: '081200000000', active: true,
    photo: tersimpan.photo, nik: 'UJI-001', department: 'Gudang',
    employment_status: 'KONTRAK', join_date: '2024-02-15',
  });
  check('menyimpan ulang tidak mengganti berkas foto',
    ubahTim.user.photo === tersimpan.photo && ubahTim.user.position === 'Kepala Packing');

  let tolakTanggal = false;
  try {
    await call('PUT', `/api/admin/users/${anggota.user.id}`, {
      name: 'Anggota Uji', email: tersimpan.email, role: 'staff', join_date: '15-02-2024',
    });
  } catch {
    tolakTanggal = true;
  }
  check('tanggal berformat salah ditolak', tolakTanggal);

  for (const bentuk of ['excel', 'pdf']) {
    const res = await fetch(`${BASE}/api/admin/users/export/${bentuk}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const buf = Buffer.from(await res.arrayBuffer());
    const sah = res.ok && buf.length > 500 &&
      (bentuk === 'pdf' ? buf.slice(0, 4).toString() === '%PDF' : buf.slice(0, 2).toString('hex') === '504b');
    check(`data tim bisa diunduh sebagai ${bentuk.toUpperCase()}`, sah, `${res.status}, ${buf.length} byte`);
  }

  // Logo harus benar-benar tercetak di kop, bukan hanya tersimpan.
  const pdfLaporan = await fetch(`${BASE}/api/finance/reports/balance-sheet/export/pdf?asOf=${today}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const isiPdf = Buffer.from(await pdfLaporan.arrayBuffer());
  check('logo ikut tercetak pada kop laporan PDF',
    pdfLaporan.ok && isiPdf.includes(Buffer.from('/Image')),
    `${isiPdf.length} byte`);

  // ---------- Biaya iklan & penamaan pendapatan ----------
  console.log('\n10. Biaya iklan & pendapatan kotor/bersih');

  const daftarOrder = await call('GET', `/api/sales?from=${today}&to=${today}`);
  const rk = daftarOrder.summary;
  check('pendapatan bersih = pendapatan kotor − biaya channel',
    near(rk.netReceived, rk.netRevenue - rk.totalFees, 1),
    `${rk.netReceived} = ${rk.netRevenue} − ${rk.totalFees}`);
  check('laba bersih = pendapatan bersih − HPP',
    near(rk.netProfit, rk.netReceived - rk.cogs, 1),
    `${rk.netProfit} = ${rk.netReceived} − ${rk.cogs}`);

  const tokoIklan = await call('POST', '/api/shops', { name: `Toko Iklan ${Date.now()}`, channel: 'SHOPEE' });
  const idToko = (tokoIklan.shop || tokoIklan).id;

  const kasSblmIklan = (await call('GET', `/api/finance/reports/balance-sheet?asOf=${today}`)).assets.current.totalCash;
  const catat = await call('POST', '/api/iklan', {
    spend_date: today, shop_id: idToko, channel: 'SHOPEE',
    platform: 'Shopee Ads', amount: 300000, payment: 'BANK', note: 'Uji kampanye',
  });
  check('biaya iklan tersimpan', catat.spend.amount === 300000);

  const bsIklan = await call('GET', `/api/finance/reports/balance-sheet?asOf=${today}`);
  check('neraca tetap seimbang setelah biaya iklan', bsIklan.balanced);
  check('biaya iklan mengurangi kas/bank',
    near(bsIklan.assets.current.totalCash, kasSblmIklan - 300000, 1),
    `${kasSblmIklan} menjadi ${bsIklan.assets.current.totalCash}`);

  const pnlIklan = await call('GET', `/api/finance/reports/income-statement?from=2000-01-01&to=${today}`);
  const barisIklan = (pnlIklan.sellingRows || []).find((x) => x.code === '6050');
  check('biaya iklan masuk beban usaha di laba rugi',
    !!barisIklan && near(barisIklan.amount, 300000, 1),
    barisIklan ? String(barisIklan.amount) : 'baris 6050 tidak ada');

  // Iklan yang dipotong dari saldo marketplace bukan pengeluaran kas: yang
  // berkurang adalah dana penjualan yang belum cair, bukan uang di bank.
  const bsSblmSaldo = await call('GET', `/api/finance/reports/balance-sheet?asOf=${today}`);
  await call('POST', '/api/iklan', {
    spend_date: today, shop_id: idToko, channel: 'SHOPEE',
    platform: 'Shopee Ads', amount: 120000, payment: 'SALDO', note: 'Uji potong saldo',
  });
  const bsSaldo = await call('GET', `/api/finance/reports/balance-sheet?asOf=${today}`);
  check('iklan dari saldo marketplace tidak mengurangi kas/bank',
    near(bsSaldo.assets.current.totalCash, bsSblmSaldo.assets.current.totalCash, 1),
    `${bsSblmSaldo.assets.current.totalCash} -> ${bsSaldo.assets.current.totalCash}`);
  check('iklan dari saldo marketplace mengurangi piutang marketplace',
    near(bsSblmSaldo.assets.current.totalReceivable - bsSaldo.assets.current.totalReceivable, 120000, 1),
    `${bsSblmSaldo.assets.current.totalReceivable} -> ${bsSaldo.assets.current.totalReceivable}`);
  check('neraca tetap seimbang setelah iklan dari saldo', bsSaldo.balanced);

  const ringkasIklan = await call('GET', `/api/iklan?from=${today}&to=${today}`);
  check('ringkasan iklan menghitung total belanja',
    near(ringkasIklan.ringkas.totalIklan, 420000, 1), String(ringkasIklan.ringkas.totalIklan));
  check('laba setelah iklan = laba sebelum iklan − belanja iklan',
    near(ringkasIklan.ringkas.labaSetelahIklan, ringkasIklan.ringkas.labaSebelumIklan - 420000, 1),
    `${ringkasIklan.ringkas.labaSetelahIklan}`);

  const tokoDiRingkas = ringkasIklan.perToko.find((t) => t.shop_id === idToko);
  check('belanja iklan menempel pada tokonya', !!tokoDiRingkas && tokoDiRingkas.iklan === 420000);

  const dashIklan = await call('GET', `/api/dashboard?from=${today}&to=${today}`);
  check('dashboard memuat pendapatan kotor dan bersih',
    dashIklan.penjualan.periode.netReceived !== undefined &&
    near(dashIklan.penjualan.periode.netReceived,
      dashIklan.penjualan.periode.netRevenue - dashIklan.penjualan.periode.totalFees, 1));
  check('dashboard memuat laba setelah iklan',
    near(dashIklan.penjualan.iklan.labaSetelahIklan,
      dashIklan.penjualan.periode.netProfit - dashIklan.penjualan.iklan.periode, 1),
    `${dashIklan.penjualan.iklan.labaSetelahIklan}`);

  // Mengubah nilainya harus menulis ulang jurnalnya, bukan menambah baris baru.
  await call('PUT', `/api/iklan/${catat.spend.id}`, {
    spend_date: today, shop_id: idToko, channel: 'SHOPEE',
    platform: 'Shopee Ads', amount: 100000, payment: 'BANK', note: 'Dikoreksi',
  });
  const bsIklanUbah = await call('GET', `/api/finance/reports/balance-sheet?asOf=${today}`);
  check('mengubah biaya iklan menulis ulang jurnalnya',
    near(bsIklanUbah.assets.current.totalCash, kasSblmIklan - 100000, 1) && bsIklanUbah.balanced,
    `kas ${bsIklanUbah.assets.current.totalCash}`);

  await call('DELETE', `/api/iklan/${catat.spend.id}`);
  const bsIklanHapus = await call('GET', `/api/finance/reports/balance-sheet?asOf=${today}`);
  check('menghapus biaya iklan mengembalikan kas dan tetap seimbang',
    near(bsIklanHapus.assets.current.totalCash, kasSblmIklan, 1) && bsIklanHapus.balanced,
    `kas ${bsIklanHapus.assets.current.totalCash}`);

  for (const bentuk of ['excel', 'pdf']) {
    const res = await fetch(`${BASE}/api/iklan/export/${bentuk}?from=${today}&to=${today}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const buf = Buffer.from(await res.arrayBuffer());
    check(`biaya iklan bisa diunduh sebagai ${bentuk.toUpperCase()}`,
      res.ok && buf.length > 500 &&
      (bentuk === 'pdf' ? buf.slice(0, 4).toString() === '%PDF' : buf.slice(0, 2).toString('hex') === '504b'),
      `${res.status}, ${buf.length} byte`);
  }

  // ---------- Peran & hak akses ----------
  console.log('\n11. Peran & hak akses');

  const daftarPeran = await call('GET', '/api/peran');
  check('lima peran bawaan tersedia', daftarPeran.roles.length >= 5,
    daftarPeran.roles.map((r) => r.slug).join(', '));
  check('katalog izin dikelompokkan per modul', daftarPeran.katalog.length >= 8,
    `${daftarPeran.katalog.length} modul`);

  const izinSaya = await call('GET', '/api/peran/saya');
  check('admin memegang seluruh izin',
    izinSaya.permissions.length === daftarPeran.katalog.flatMap((k) => k.izin).length,
    `${izinSaya.permissions.length} izin`);

  // Menu baru harus sampai ke peran yang memang mengerjakannya. Kalau tidak,
  // memasang modul baru berarti diam-diam menyembunyikannya dari semua orang
  // kecuali admin, tanpa tanda apa pun bahwa ada yang perlu dinyalakan.
  const peranAdmin = daftarPeran.roles.find((r) => r.slug === 'admin');
  check('peran Tim Gudang menerima izin modul pembelian',
    daftarPeran.roles.find((r) => r.slug === 'gudang').permissions.includes('pembelian.kelola'));
  check('peran Admin memegang izin modul terbaru',
    peranAdmin.permissions.includes('pembelian.kelola') && peranAdmin.permissions.includes('iklan.kelola'));

  const peranGudang = daftarPeran.roles.find((r) => r.slug === 'gudang');
  const akunGudang = await call('POST', '/api/admin/users', {
    name: 'Uji Gudang', email: `gudang-${Date.now()}@uji.local`, password: 'RahasiaKuat1',
    role: 'staff', role_id: peranGudang.id,
  });
  check('akun bisa ditautkan ke peran', akunGudang.user.role_id === peranGudang.id);

  const tokenAdmin = token;
  token = await masukSebagai(akunGudang.user.email, 'RahasiaKuat1');

  const cobaAkses = async (path) => {
    try {
      await call('GET', path);
      return 200;
    } catch (err) {
      return err.status || 0;
    }
  };

  check('tim gudang boleh membuka menu gudang', (await cobaAkses('/api/inventory/products')) === 200);
  check('tim gudang boleh membuka dashboard', (await cobaAkses('/api/dashboard')) === 200);
  check('tim gudang ditolak dari penjualan', (await cobaAkses('/api/sales')) === 403);
  check('tim gudang ditolak dari keuangan', (await cobaAkses(`/api/finance/reports/balance-sheet?asOf=${today}`)) === 403);
  check('tim gudang ditolak dari biaya iklan', (await cobaAkses('/api/iklan')) === 403);
  check('tim gudang ditolak dari data tim', (await cobaAkses('/api/admin/users')) === 403);

  // Batas akses harus berlaku pada aktivitas juga, bukan cuma pada halaman.
  let tolakUbahProduk = 0;
  try {
    await call('POST', '/api/inventory/products', {
      sku: `X-${Date.now()}`, name: 'Uji Izin', category: 'Uji', unit: 'PCS',
    });
    tolakUbahProduk = 200;
  } catch (err) {
    tolakUbahProduk = err.status;
  }
  check('tim gudang boleh menambah produk (punya gudang.produk)', tolakUbahProduk === 201 || tolakUbahProduk === 200,
    `status ${tolakUbahProduk}`);

  // Kinerja produk memakai angka penjualan, jadi batasnya tidak cukup di
  // halaman: tim gudang perlu tahu apa yang bergerak dan apa yang menumpuk,
  // tetapi laba per produk bukan urusannya. Kolomnya harus benar-benar tidak
  // ikut terkirim — menyembunyikannya di layar saja berarti angkanya tetap ada
  // di dalam jawaban server dan tetap terbaca siapa pun yang mau melihat.
  check('tim gudang boleh membuka kinerja produk', (await cobaAkses('/api/kinerja/produk')) === 200);
  const kinerjaGudang = await call('GET', `/api/kinerja/produk?from=${today}&to=${today}`);
  check('kinerja produk menyembunyikan laba dari tim gudang',
    kinerjaGudang.tanpaLaba === true &&
    kinerjaGudang.rows.every((r) => r.laba_kotor === undefined && r.hpp === undefined) &&
    kinerjaGudang.ringkas.labaKotor === undefined);
  check('tim gudang tetap melihat pergerakan stoknya',
    kinerjaGudang.rows.every((r) => typeof r.stok === 'number' && typeof r.qty === 'number'));

  const judulKolom = async (bearer) => {
    const res = await fetch(`${BASE}/api/kinerja/produk/export/excel?from=${today}&to=${today}`, {
      headers: { Authorization: `Bearer ${bearer}` },
    });
    if (!res.ok) return [`gagal ${res.status}`];
    const wb = new (require('exceljs').Workbook)();
    await wb.xlsx.load(Buffer.from(await res.arrayBuffer()));
    const ws = wb.worksheets[0];
    let baris = [];
    // Kepala tabel tidak selalu di baris pertama; berkasnya diawali judul dan
    // keterangan periode.
    ws.eachRow((row) => {
      const isi = row.values.slice(1).map((v) => String(v ?? '').trim());
      if (isi.includes('SKU') && isi.includes('Produk')) baris = isi;
    });
    return baris;
  };

  const kolomGudang = await judulKolom(token);
  check('unduhan kinerja produk ikut menanggalkan kolom laba',
    kolomGudang.includes('Stok') && !kolomGudang.includes('Laba Kotor') && !kolomGudang.includes('Margin'),
    kolomGudang.join(', '));

  token = tokenAdmin;

  // Peran khusus: dibuat, dipakai, lalu diuji batasnya.
  const peranBaru = await call('POST', '/api/peran', {
    name: `Peran Uji ${Date.now()}`,
    description: 'Hanya boleh melihat dashboard',
    permissions: ['dashboard.lihat'],
  });
  check('peran baru bisa dibuat', peranBaru.role.permissions.length === 1);

  const akunSempit = await call('POST', '/api/admin/users', {
    name: 'Uji Sempit', email: `sempit-${Date.now()}@uji.local`, password: 'RahasiaKuat1',
    role: 'staff', role_id: peranBaru.role.id,
  });
  token = await masukSebagai(akunSempit.user.email, 'RahasiaKuat1');
  check('peran sempit hanya boleh membuka dashboard',
    (await cobaAkses('/api/dashboard')) === 200 &&
    (await cobaAkses('/api/inventory/products')) === 403 &&
    (await cobaAkses('/api/sales')) === 403);
  token = tokenAdmin;

  // Peran Admin tidak boleh dipersempit — kalau bisa, tidak ada lagi yang
  // dapat memperbaiki peran lain dari dalam aplikasi.
  let tolakUbahAdmin = false;
  try {
    const adminRole = daftarPeran.roles.find((r) => r.slug === 'admin');
    await call('PUT', `/api/peran/${adminRole.id}`, {
      name: 'Admin', permissions: ['dashboard.lihat'],
    });
  } catch {
    tolakUbahAdmin = true;
  }
  check('peran Admin tidak dapat dibatasi', tolakUbahAdmin);

  let tolakHapusBawaan = false;
  try {
    await call('DELETE', `/api/peran/${peranGudang.id}`);
  } catch {
    tolakHapusBawaan = true;
  }
  check('peran bawaan tidak dapat dihapus', tolakHapusBawaan);

  let tolakHapusTerpakai = false;
  try {
    await call('DELETE', `/api/peran/${peranBaru.role.id}`);
  } catch {
    tolakHapusTerpakai = true;
  }
  check('peran yang masih dipakai akun tidak dapat dihapus', tolakHapusTerpakai);

  // ---------- Kas menyeluruh ----------
  console.log('\n12. Kecocokan kas menyeluruh');

  // Belanja iklan pada seksi 10 sengaja dihapus di akhir pengujiannya, jadi
  // dicatat satu lagi di sini untuk membuktikan ia muncul sebagai kas keluar.
  await call('POST', '/api/iklan', {
    spend_date: today, channel: 'SHOPEE', platform: 'Shopee Ads',
    amount: 175000, payment: 'BANK', note: 'Uji kas iklan',
  });

  const kasSemua = await call('GET', `/api/cashflow/entries?from=2000-01-01&to=${today}`);
  const bsKas = await call('GET', `/api/finance/reports/balance-sheet?asOf=${today}`);

  // Inti kecocokannya: seluruh pergerakan kas yang pernah tercatat harus
  // berjumlah sama dengan saldo kas di Neraca. Sebelumnya layar ini hanya
  // menampilkan catatan yang diketik di sana, sehingga totalnya tidak pernah
  // cocok dan tidak ada yang bisa menunjukkan ke mana selisihnya pergi.
  check('total kas di menu Kas = saldo kas di Neraca',
    near(kasSemua.summary.net, bsKas.assets.current.totalCash, 1),
    `${kasSemua.summary.net} vs ${bsKas.assets.current.totalCash}`);

  const asal = (kasSemua.perSumber || []).map((x) => x.sumber);
  check('menu Kas memuat pergerakan dari luar catatan manual',
    asal.length > 1, asal.join(', '));

  const kasAdaIklan = kasSemua.rows.some((r) => r.source === 'ADS');
  check('belanja iklan ikut tampil sebagai kas keluar', kasAdaIklan);

  const kasBarisIklan = kasSemua.rows.find((r) => r.source === 'ADS');
  check('belanja iklan berkategori akun 6050',
    !!kasBarisIklan && String(kasBarisIklan.kategori || '').startsWith('6050'),
    kasBarisIklan ? kasBarisIklan.kategori : 'tidak ada');
  check('baris dari modul lain tidak bisa dihapus dari menu Kas',
    !!kasBarisIklan && kasBarisIklan.bisaHapus === false);

  // Satu belanja iklan hanya boleh punya satu pintu masuk. Kalau akun 6050
  // juga bisa dipilih di layar kas, belanja yang tercatat di kedua tempat akan
  // terhitung dua kali pada akun yang sama tanpa tanda apa pun.
  const opsiKas = await call('GET', '/api/cashflow/options');
  check('akun biaya iklan tidak ditawarkan di pilihan kategori kas',
    !opsiKas.expenseCategories.some((k) => k.code === '6050'),
    opsiKas.expenseCategories.map((k) => k.code).join(','));

  let tolakIklanLewatKas = false;
  try {
    await call('POST', '/api/cashflow/entries', {
      entry_date: today, direction: 'OUT', category_code: '6050',
      cash_code: '1000', amount: 50000, description: 'Uji iklan lewat kas',
    });
  } catch {
    tolakIklanLewatKas = true;
  }
  check('peladen menolak biaya iklan yang dicatat lewat layar kas', tolakIklanLewatKas);

  let tolakHapusAsing = false;
  try {
    await call('DELETE', `/api/cashflow/entries/${kasBarisIklan.id}`);
  } catch {
    tolakHapusAsing = true;
  }
  check('peladen menolak penghapusan jurnal milik modul lain', tolakHapusAsing);

  // Setelah ditolak, jurnalnya harus benar-benar masih ada.
  const kasSesudah = await call('GET', `/api/cashflow/entries?from=2000-01-01&to=${today}`);
  check('jurnal iklan tetap utuh setelah penolakan',
    near(kasSesudah.summary.net, kasSemua.summary.net, 1));

  // ---------- Papan pengiriman ----------
  console.log('\n13. Papan pengiriman');

  const papanAwal = await call('GET', `/api/sales/papan?from=${today}&to=${today}`);
  check('papan mengelompokkan pesanan per tahap',
    papanAwal.kolom.length === 8 && papanAwal.kolom.every((k) => Array.isArray(k.rows)),
    papanAwal.kolom.map((k) => `${k.status}=${k.orders}`).join(' '));

  const skuPapan = `PAPAN-${Date.now()}`;
  const prodPapan = (await call('POST', '/api/inventory/products', {
    sku: skuPapan, name: 'Produk Uji Papan', cost: 10000, price: 30000,
  })).product;
  await call('POST', '/api/inventory/moves', {
    product_id: prodPapan.id, move_date: today, move_type: 'IN',
    qty: 50, unit_cost: 10000, payment: 'CASH',
  });

  const idPapan = [];
  for (let i = 0; i < 3; i += 1) {
    const o = await call('POST', '/api/sales', {
      order_date: today, channel: 'SHOPEE', customer: `Papan ${i}`,
      items: [{ product_id: prodPapan.id, qty: 2, price: 30000 }],
      admin_fee: 5000, payment_status: 'UNPAID', fulfillment_status: 'DIPROSES',
    });
    idPapan.push(o.order.id);
  }

  const bsPapanA = (await call('GET', `/api/finance/reports/balance-sheet?asOf=${today}`)).assets.current;
  const kirim = await call('PATCH', '/api/sales/status-massal', {
    ids: idPapan, fulfillment_status: 'DIKIRIM',
  });
  check('status banyak pesanan bisa diubah sekaligus', kirim.berhasil === 3, kirim.message);

  const bsPapanB = (await call('GET', `/api/finance/reports/balance-sheet?asOf=${today}`)).assets.current;
  check('memindahkan tahap pengiriman tidak menggeser uang',
    near(bsPapanA.totalReceivable, bsPapanB.totalReceivable, 1) &&
    near(bsPapanA.totalCash, bsPapanB.totalCash, 1));

  const papanKirim = await call('GET', `/api/sales/papan?from=${today}&to=${today}`);
  const kolomKirim = papanKirim.kolom.find((k) => k.status === 'DIKIRIM');
  check('pesanan berpindah kolom di papan', kolomKirim.orders >= 3, String(kolomKirim.orders));

  // Menandai cair sekaligus lunas harus memindahkan piutang ke kas/bank.
  const cair = await call('PATCH', '/api/sales/status-massal', {
    ids: idPapan.slice(0, 2), fulfillment_status: 'CAIR',
    payment_status: 'PAID', payout_date: today,
  });
  check('menandai cair sekaligus lunas berhasil', cair.berhasil === 2, cair.message);

  const bsPapanC = (await call('GET', `/api/finance/reports/balance-sheet?asOf=${today}`)).assets.current;
  const nilaiDuaOrder = 2 * (60000 - 5000);
  check('menandai lunas memindahkan piutang ke kas/bank',
    near(bsPapanB.totalReceivable - bsPapanC.totalReceivable, nilaiDuaOrder, 1),
    `${bsPapanB.totalReceivable} -> ${bsPapanC.totalReceivable}`);

  const bsPapanSeimbang = await call('GET', `/api/finance/reports/balance-sheet?asOf=${today}`);
  check('neraca tetap seimbang setelah perubahan massal', bsPapanSeimbang.balanced);

  // Membatalkan mengembalikan stok dan menghapus jurnal — terlalu berat untuk
  // dijalankan lewat centang massal yang mudah tersenggol.
  let tolakBatalMassal = false;
  try {
    await call('PATCH', '/api/sales/status-massal', { ids: idPapan, fulfillment_status: 'BATAL' });
  } catch {
    tolakBatalMassal = true;
  }
  check('pembatalan massal ditolak', tolakBatalMassal);

  let tolakKosong = false;
  try {
    await call('PATCH', '/api/sales/status-massal', { ids: [], fulfillment_status: 'DIKIRIM' });
  } catch {
    tolakKosong = true;
  }
  check('perubahan massal tanpa pesanan terpilih ditolak', tolakKosong);

  // ---------- Pesanan pembelian ----------
  console.log('\n14. Pesanan pembelian');

  const supplierPO = (await call('POST', '/api/partners', {
    name: `PT Uji Pasok ${Date.now()}`, type: 'SUPPLIER',
  }));
  const idSupplier = (supplierPO.partner || supplierPO).id;

  const prodPO = (await call('POST', '/api/inventory/products', {
    sku: `PO-${Date.now()}`, name: 'Barang Uji Pembelian', cost: 0, price: 50000,
  })).product;

  const po = (await call('POST', '/api/pembelian', {
    order_date: today, expected_date: today, partner_id: idSupplier, payment: 'CREDIT',
    items: [{ product_id: prodPO.id, qty: 100, unit_cost: 20000 }],
  })).po;
  check('pesanan pembelian dibuat', po.total === 2_000_000 && po.status === 'DIPESAN',
    `${po.po_no} ${po.total}`);

  const daftarPO = await call('GET', `/api/pembelian?from=${today}&to=${today}`);
  check('nilai barang yang masih ditunggu dihitung',
    near(daftarPO.ringkas.nilaiMenunggu, 2_000_000, 1), String(daftarPO.ringkas.nilaiMenunggu));

  const utangSblm = (await call('GET', `/api/finance/reports/balance-sheet?asOf=${today}`)).liabilities.total;

  // Penerimaan sebagian: stok bertambah sebagian, pesanan belum selesai.
  const idItem = po.items[0].id;
  const terima1 = await call('POST', `/api/pembelian/${po.id}/terima`, {
    receive_date: today, lines: [{ item_id: idItem, qty: 40 }],
  });
  check('penerimaan sebagian menandai pesanan belum selesai',
    terima1.po.status === 'SEBAGIAN', terima1.po.status);

  const stokPO1 = (await call('GET', `/api/inventory/products?q=${prodPO.sku}`)).products[0];
  check('barang diterima menambah stok', stokPO1.stock === 40, String(stokPO1.stock));
  check('HPP rata-rata mengikuti harga beli', near(stokPO1.cost, 20000), String(stokPO1.cost));

  const utangSesudah = (await call('GET', `/api/finance/reports/balance-sheet?asOf=${today}`)).liabilities.total;
  check('pembelian tempo menambah utang supplier',
    near(utangSesudah - utangSblm, 40 * 20000, 1), `${utangSblm} -> ${utangSesudah}`);

  // Menerima lebih dari sisa pesanan harus ditolak — kelebihan kiriman lebih
  // baik ketahuan daripada diam-diam menambah pesanan yang sudah disepakati.
  let tolakLebih = false;
  try {
    await call('POST', `/api/pembelian/${po.id}/terima`, {
      receive_date: today, lines: [{ item_id: idItem, qty: 999 }],
    });
  } catch {
    tolakLebih = true;
  }
  check('penerimaan melebihi sisa pesanan ditolak', tolakLebih);

  // Membatalkan setelah barang masuk akan menyisakan mutasi stok tanpa dokumen.
  let tolakBatalPO = false;
  try {
    await call('PATCH', `/api/pembelian/${po.id}/batal`);
  } catch {
    tolakBatalPO = true;
  }
  check('pesanan yang sudah diterima sebagian tidak bisa dibatalkan', tolakBatalPO);

  const terima2 = await call('POST', `/api/pembelian/${po.id}/terima`, {
    receive_date: today, lines: [{ item_id: idItem, qty: 60 }],
  });
  check('penerimaan sisanya menutup pesanan', terima2.po.status === 'SELESAI', terima2.po.status);

  const stokPO2 = (await call('GET', `/api/inventory/products?q=${prodPO.sku}`)).products[0];
  check('seluruh barang pesanan masuk ke stok', stokPO2.stock === 100, String(stokPO2.stock));

  const bsPO = await call('GET', `/api/finance/reports/balance-sheet?asOf=${today}`);
  check('neraca tetap seimbang setelah pembelian', bsPO.balanced);

  // Pesanan yang belum diterima sama sekali masih boleh dibatalkan.
  const poBatal = (await call('POST', '/api/pembelian', {
    order_date: today, partner_id: idSupplier, payment: 'CREDIT',
    items: [{ product_id: prodPO.id, qty: 5, unit_cost: 20000 }],
  })).po;
  const hasilBatal = await call('PATCH', `/api/pembelian/${poBatal.id}/batal`);
  check('pesanan yang belum diterima bisa dibatalkan', hasilBatal.ok === true);

  for (const bentuk of ['excel', 'pdf']) {
    const res = await fetch(`${BASE}/api/pembelian/export/${bentuk}?from=${today}&to=${today}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const buf = Buffer.from(await res.arrayBuffer());
    check(`pesanan pembelian bisa diunduh sebagai ${bentuk.toUpperCase()}`,
      res.ok && buf.length > 500 &&
      (bentuk === 'pdf' ? buf.slice(0, 4).toString() === '%PDF' : buf.slice(0, 2).toString('hex') === '504b'),
      `${res.status}, ${buf.length} byte`);
  }

  // ---------- Rekening kas & bank ----------
  console.log('\n15. Rekening kas & bank');

  const rekAwal = await call('GET', `/api/cashflow/rekening?asOf=${today}`);
  check('saldo dihitung per rekening',
    rekAwal.rows.length >= 3 && rekAwal.rows.every((x) => 'saldo' in x && 'perSumber' in x),
    rekAwal.rows.map((x) => x.code).join(','));

  const kodeBaru = '1099';
  let adaRek = rekAwal.rows.some((x) => x.code === kodeBaru);
  if (!adaRek) {
    await call('POST', '/api/finance/accounts', {
      code: kodeBaru, name: 'Rekening Uji', type: 'ASSET', subtype: 'CASH',
      normal: 'D', cashflow: 'OCF', is_cash: true,
    });
    adaRek = true;
  }
  check('rekening baru bisa ditambahkan', adaRek);

  const tokoRek = await call('POST', '/api/shops', { name: `Toko Rek ${Date.now()}`, channel: 'SHOPEE' });
  await call('POST', '/api/iklan', {
    spend_date: today, shop_id: (tokoRek.shop || tokoRek).id, channel: 'SHOPEE',
    amount: 250000, payment: 'BANK', cash_code: kodeBaru, note: 'Uji rekening',
  });

  const rekIsi = await call('GET', `/api/cashflow/rekening?asOf=${today}`);
  const rekUji = rekIsi.rows.find((x) => x.code === kodeBaru);
  check('biaya iklan membebani rekening yang dipilih',
    near(rekUji.saldo, -250000, 1), String(rekUji.saldo));
  check('asal pergerakan rekening ikut dirinci',
    rekUji.perSumber.some((s2) => s2.sumber === 'Biaya Iklan' && near(s2.keluar, 250000, 1)),
    JSON.stringify(rekUji.perSumber));
  check('rekening bersaldo minus ditandai', rekUji.minus === true);

  // Rekening yang bukan kas harus ditolak — kalau tidak, biaya iklan bisa
  // mendarat di akun mana saja tanpa ada yang menghalangi.
  let tolakBukanKas = false;
  try {
    await call('POST', '/api/iklan', {
      spend_date: today, channel: 'SHOPEE', amount: 1000, payment: 'BANK', cash_code: '4000',
    });
  } catch {
    tolakBukanKas = true;
  }
  check('akun bukan kas ditolak sebagai sumber dana', tolakBukanKas);

  const totalRek = rekIsi.rows.reduce((s2, x) => s2 + x.saldo, 0);
  const bsRek = await call('GET', `/api/finance/reports/balance-sheet?asOf=${today}`);
  check('jumlah saldo seluruh rekening = kas di neraca',
    near(totalRek, bsRek.assets.current.totalCash, 1),
    `${totalRek} vs ${bsRek.assets.current.totalCash}`);

  for (const bentuk of ['excel', 'pdf']) {
    const res = await fetch(`${BASE}/api/cashflow/rekening/export/${bentuk}?asOf=${today}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const buf = Buffer.from(await res.arrayBuffer());
    check(`rekening bisa diunduh sebagai ${bentuk.toUpperCase()}`,
      res.ok && buf.length > 500 &&
      (bentuk === 'pdf' ? buf.slice(0, 4).toString() === '%PDF' : buf.slice(0, 2).toString('hex') === '504b'),
      `${res.status}, ${buf.length} byte`);
  }

  // ---------- Kinerja produk ----------
  console.log('\n16. Kinerja produk');

  const awalBulan = `${today.slice(0, 8)}01`;
  const kin = await call('GET', `/api/kinerja/produk?from=${awalBulan}&to=${today}`);
  const anal = await call('GET', `/api/sales/analytics?from=${awalBulan}&to=${today}`);
  const val = await call('GET', '/api/inventory/valuation');

  check('setiap produk muncul tepat sekali',
    new Set(kin.rows.map((r) => r.id)).size === kin.rows.length &&
    kin.rows.length === val.totalSku,
    `${kin.rows.length} baris, ${val.totalSku} SKU`);

  // Tiga pemeriksaan berikut yang membuat layar ini bisa dipercaya: angkanya
  // harus sama persis dengan laporan yang sudah ada. Kalau salah satunya
  // melenceng, berarti ada penjualan atau stok yang terhitung dua kali.
  check('nilai persediaan = valuasi stok gudang',
    near(kin.ringkas.nilaiStok, val.totalValue, 1),
    `${kin.ringkas.nilaiStok} vs ${val.totalValue}`);
  check('pendapatan per produk = penjualan kotor di analisis margin',
    near(kin.ringkas.pendapatan, anal.totals.gross_sales, 1),
    `${kin.ringkas.pendapatan} vs ${anal.totals.gross_sales}`);
  check('laba kotor per produk = laba kotor di analisis margin',
    near(kin.ringkas.labaKotor, anal.totals.gross_profit, 1),
    `${kin.ringkas.labaKotor} vs ${anal.totals.gross_profit}`);

  check('jumlah tiap golongan = jumlah seluruh produk',
    kin.perGolongan.reduce((s2, g) => s2 + g.produk, 0) === kin.rows.length);

  // Produk laris yang stoknya habis adalah penjualan yang hilang tanpa jejak —
  // pesanan yang batal karena barang kosong tidak tercatat di mana pun.
  const produkHabis = await call('POST', '/api/inventory/products', {
    sku: `HABIS-${Date.now()}`, name: 'Uji Barang Habis', category: 'Uji', unit: 'PCS',
    cost: 5000, price: 12000,
  });
  await call('POST', '/api/inventory/moves', {
    product_id: produkHabis.product.id, move_date: today, move_type: 'IN',
    qty: 4, unit_cost: 5000, note: 'Uji kinerja',
  });
  const dibuatKin = await call('POST', '/api/shops', { name: `Toko Kinerja ${Date.now()}`, channel: 'SHOPEE' });
  const tokoKin = dibuatKin.shop || dibuatKin;
  await call('POST', '/api/sales', {
    order_date: today, shop_id: tokoKin.id, channel: tokoKin.channel,
    items: [{ product_id: produkHabis.product.id, qty: 4, price: 12000 }],
  });

  const kin2 = await call('GET', `/api/kinerja/produk?from=${awalBulan}&to=${today}`);
  const barisHabis = kin2.rows.find((r) => r.id === produkHabis.product.id);
  check('produk laku yang stoknya habis ditandai "habis"',
    barisHabis.golongan === 'habis' && barisHabis.stok === 0 && barisHabis.qty === 4,
    `${barisHabis.golongan}, stok ${barisHabis.stok}, terjual ${barisHabis.qty}`);
  check('produk habis tidak dihitung sebagai modal menganggur',
    barisHabis.modal_tertahan === 0);
  check('produk yang belum pernah terjual punya golongan sendiri',
    kin2.rows.filter((r) => r.golongan === 'belum-terjual')
      .every((r) => r.terakhir_terjual === null && r.qty === 0));
  check('modal menganggur hanya dari barang yang diam',
    near(
      kin2.ringkas.modalTertahan,
      kin2.rows.filter((r) => r.modal_tertahan > 0).reduce((s2, r) => s2 + r.nilai_stok, 0),
      1
    ));

  // Sisa hari hanya bermakna bila barangnya memang bergerak; produk diam tidak
  // "cukup nol hari", ia tidak punya perkiraan sama sekali.
  check('sisa hari kosong untuk produk tanpa penjualan',
    kin2.rows.filter((r) => r.qty === 0).every((r) => r.cover_hari === null));
  check('sisa hari terisi untuk produk yang bergerak',
    kin2.rows.filter((r) => r.qty > 0 && r.stok > 0).every((r) => typeof r.cover_hari === 'number'));

  const kolomAdmin = await judulKolom(token);
  check('unduhan admin memuat kolom laba',
    kolomAdmin.includes('Laba Kotor') && kolomAdmin.includes('Margin'),
    kolomAdmin.join(', '));

  for (const bentuk of ['excel', 'pdf']) {
    const res = await fetch(`${BASE}/api/kinerja/produk/export/${bentuk}?from=${awalBulan}&to=${today}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const buf = Buffer.from(await res.arrayBuffer());
    check(`kinerja produk bisa diunduh sebagai ${bentuk.toUpperCase()}`,
      res.ok && buf.length > 500 &&
      (bentuk === 'pdf' ? buf.slice(0, 4).toString() === '%PDF' : buf.slice(0, 2).toString('hex') === '504b'),
      `${res.status}, ${buf.length} byte`);
  }

  // ---------- Target & pencapaian ----------
  console.log('\n17. Target & pencapaian');

  const periodeIni = today.slice(0, 7);
  const tokoTarget = (await call('POST', '/api/shops', {
    name: `Toko Target ${Date.now()}`, channel: 'TIKTOK_SHOP',
  }));
  const idTokoTarget = (tokoTarget.shop || tokoTarget).id;

  const produkTarget = await call('POST', '/api/inventory/products', {
    sku: `TGT-${Date.now()}`, name: 'Uji Target', category: 'Uji', unit: 'PCS',
    cost: 10000, price: 30000,
  });
  await call('POST', '/api/inventory/moves', {
    product_id: produkTarget.product.id, move_date: today, move_type: 'IN',
    qty: 20, unit_cost: 10000, note: 'Uji target',
  });
  await call('POST', '/api/sales', {
    order_date: today, shop_id: idTokoTarget, channel: 'TIKTOK_SHOP',
    items: [{ product_id: produkTarget.product.id, qty: 10, price: 30000 }],
  });
  await call('POST', '/api/iklan', {
    spend_date: today, shop_id: idTokoTarget, channel: 'TIKTOK_SHOP',
    amount: 50000, payment: 'BANK', note: 'Uji target',
  });

  const tgtBaru = await call('POST', '/api/target', {
    period: periodeIni, shop_id: idTokoTarget,
    omzet: 600000, laba: 100000, orders: 4, budget_iklan: 40000,
  });
  check('target toko bisa ditetapkan', tgtBaru.ok && tgtBaru.target.period === periodeIni);

  // Menetapkan target untuk bulan dan toko yang sama tidak boleh menambah baris
  // baru — kalau bisa, akan ada dua target berbeda untuk satu hal yang sama dan
  // tidak ada cara memilih mana yang berlaku.
  const tgtUlang = await call('POST', '/api/target', {
    period: periodeIni, shop_id: idTokoTarget,
    omzet: 500000, laba: 90000, orders: 5, budget_iklan: 40000,
  });
  check('target yang sama diperbarui, bukan digandakan',
    tgtUlang.target.id === tgtBaru.target.id && tgtUlang.target.omzet === 500000);

  const cap = await call('GET', `/api/target?period=${periodeIni}`);
  const barisTarget = cap.rows.find((r) => r.kunci === idTokoTarget);

  check('realisasi omzet diambil dari order penjualan',
    near(barisTarget.realisasi.omzet, 300000, 1), String(barisTarget.realisasi.omzet));
  check('realisasi iklan diambil dari belanja iklan',
    near(barisTarget.realisasi.iklan, 50000, 1), String(barisTarget.realisasi.iklan));
  check('laba yang dinilai sudah dikurangi belanja iklan',
    near(barisTarget.realisasi.laba, barisTarget.realisasi.labaSebelumIklan - 50000, 1),
    `${barisTarget.realisasi.laba} vs ${barisTarget.realisasi.labaSebelumIklan} − 50000`);
  check('pencapaian omzet = realisasi / target',
    near(barisTarget.capai.omzet, 60, 0.5), String(barisTarget.capai.omzet));
  check('belanja iklan yang melewati batas ditandai', barisTarget.iklanLewatBatas === true);
  check('kekurangan omzet dihitung', near(barisTarget.kurang.omzet, 200000, 1),
    String(barisTarget.kurang.omzet));

  // Baris perusahaan harus benar-benar menjumlahkan barisnya. Kalau ia dihitung
  // lewat jalur query sendiri, order yang tidak menunjuk toko mana pun akan
  // hilang dari salah satu sisi tanpa ada yang menyadarinya.
  const jumlahBaris = cap.rows.reduce((s2, r) => s2 + r.realisasi.omzet, 0);
  check('omzet perusahaan = jumlah seluruh baris toko',
    near(cap.perusahaan.realisasi.omzet, jumlahBaris, 1),
    `${cap.perusahaan.realisasi.omzet} vs ${jumlahBaris}`);
  const jumlahIklan = cap.rows.reduce((s2, r) => s2 + r.realisasi.iklan, 0);
  check('belanja iklan perusahaan = jumlah seluruh baris toko',
    near(cap.perusahaan.realisasi.iklan, jumlahIklan, 1));

  // Angkanya harus sama persis dengan menu yang sudah ada, kalau tidak akan ada
  // dua versi kebenaran untuk bulan yang sama.
  const iklanBulan = await call('GET', `/api/iklan?from=${periodeIni}-01&to=${periodeIni}-31`);
  check('omzet di target = pendapatan kotor di menu Biaya Iklan',
    near(cap.perusahaan.realisasi.omzet, iklanBulan.ringkas.pendapatanKotor, 1),
    `${cap.perusahaan.realisasi.omzet} vs ${iklanBulan.ringkas.pendapatanKotor}`);
  check('laba di target = laba setelah iklan di menu Biaya Iklan',
    near(cap.perusahaan.realisasi.laba, iklanBulan.ringkas.labaSetelahIklan, 1),
    `${cap.perusahaan.realisasi.laba} vs ${iklanBulan.ringkas.labaSetelahIklan}`);

  check('toko tanpa target tetap ditampilkan',
    cap.rows.some((r) => r.punyaTarget === false && r.capai.omzet === null));

  // Proyeksi hanya masuk akal untuk bulan yang masih berjalan.
  check('perkiraan akhir bulan terisi untuk bulan berjalan',
    cap.hari.berjalan === true && typeof cap.perusahaan.proyeksi.omzet === 'number');
  const capLalu = await call('GET', '/api/target?period=2020-01');
  check('bulan yang sudah lewat tidak diproyeksikan',
    capLalu.hari.berjalan === false && capLalu.perusahaan.proyeksi.omzet === null);

  const salinHasil = await call('POST', '/api/target/salin', {
    dari: periodeIni, ke: '2027-01', naikPersen: 10,
  });
  check('target bisa disalin ke bulan lain dengan kenaikan', salinHasil.dibuat >= 1);
  const capSalin = await call('GET', '/api/target?period=2027-01');
  const barisSalin = capSalin.rows.find((r) => r.kunci === idTokoTarget);
  check('target hasil salinan naik sesuai persentase',
    near(barisSalin.target.omzet, 550000, 1), String(barisSalin.target.omzet));

  const salinUlang = await call('POST', '/api/target/salin', {
    dari: periodeIni, ke: '2027-01', naikPersen: 50,
  });
  check('salinan tidak menimpa target yang sudah ada tanpa diminta',
    salinUlang.dilewati >= 1 && salinUlang.dibuat === 0);

  let tolakPeriode = 0;
  try {
    await call('POST', '/api/target', { period: 'Agustus', omzet: 1000 });
  } catch (err) {
    tolakPeriode = err.status;
  }
  check('periode yang bukan YYYY-MM ditolak', tolakPeriode === 400, `status ${tolakPeriode}`);

  const hapusTarget = await call('DELETE', `/api/target/${barisSalin.target_id}`);
  check('target bisa dihapus', hapusTarget.ok);

  for (const bentuk of ['excel', 'pdf']) {
    const res = await fetch(`${BASE}/api/target/export/${bentuk}?period=${periodeIni}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const buf = Buffer.from(await res.arrayBuffer());
    check(`target bisa diunduh sebagai ${bentuk.toUpperCase()}`,
      res.ok && buf.length > 500 &&
      (bentuk === 'pdf' ? buf.slice(0, 4).toString() === '%PDF' : buf.slice(0, 2).toString('hex') === '504b'),
      `${res.status}, ${buf.length} byte`);
  }

  // ---------- Penggajian ----------
  console.log('\n18. Penggajian');

  const periodeGaji = today.slice(0, 7);
  // Gaji dibayar tanggal 25, jadi pembukuannya diperiksa sampai akhir bulan
  // itu — bukan sampai hari ini, yang bisa saja masih tanggal 1.
  const akhirBulanGaji = new Date(Date.UTC(
    Number(periodeGaji.slice(0, 4)), Number(periodeGaji.slice(5, 7)), 0
  )).toISOString().slice(0, 10);
  const pegawai = await call('POST', '/api/admin/users', {
    name: 'Uji Gaji', email: `gaji-${Date.now()}@uji.local`, password: 'RahasiaKuat1',
    role: 'staff', position: 'Packing', base_salary: 3000000, allowance: 500000,
    bank_name: 'BCA', bank_account: '1234567890',
  });
  check('gaji pokok tersimpan pada data tim',
    pegawai.user.base_salary === 3000000 && pegawai.user.allowance === 500000,
    `${pegawai.user.base_salary} / ${pegawai.user.allowance}`);

  // Menyimpan ulang tanpa mengirim kolom gaji tidak boleh mengosongkannya —
  // form lama yang belum mengenal kolom ini akan menghapus gaji orang.
  await call('PUT', `/api/admin/users/${pegawai.user.id}`, {
    name: 'Uji Gaji', email: pegawai.user.email, role: 'staff', position: 'Packing Senior',
  });
  const setelahUbah = (await call('GET', '/api/admin/users')).users
    .find((u) => u.id === pegawai.user.id);
  check('gaji tidak hilang saat data tim disimpan tanpa kolom gaji',
    setelahUbah.base_salary === 3000000, String(setelahUbah.base_salary));

  const gaji = await call('POST', '/api/penggajian', {
    period: periodeGaji, payment: 'BANK', note: 'Uji penggajian',
  });
  check('daftar gaji tersusun sebagai draft',
    gaji.payroll.status === 'DRAFT' && gaji.payroll.rows.length >= 1);

  const idGaji = gaji.payroll.id;
  const barisSaya = gaji.payroll.rows.find((r) => r.employee_id === pegawai.user.id);
  check('gaji pokok disalin dari data tim',
    barisSaya.base === 3000000 && barisSaya.allowance === 500000 && barisSaya.net === 3500000,
    `net ${barisSaya.net}`);
  check('rekap presensi ikut dibekukan pada slipnya',
    typeof barisSaya.hadir === 'number' && typeof barisSaya.alpa === 'number');

  // Nilai gaji harus BEKU. Menaikkan gaji seseorang hari ini tidak boleh
  // mengubah slip bulan yang daftarnya sudah disusun.
  await call('PUT', `/api/admin/users/${pegawai.user.id}`, {
    name: 'Uji Gaji', email: pegawai.user.email, role: 'staff',
    base_salary: 9000000, allowance: 500000,
  });
  const gajiLagi = await call('GET', `/api/penggajian/${idGaji}`);
  const barisLagi = gajiLagi.rows.find((r) => r.employee_id === pegawai.user.id);
  check('menaikkan gaji di master tidak mengubah daftar yang sudah disusun',
    barisLagi.base === 3000000, String(barisLagi.base));

  const ubahBaris = await call('PUT', `/api/penggajian/${idGaji}/baris/${barisSaya.id}`, {
    overtime: 200000, bonus: 100000, deduction: 50000,
  });
  const barisUbah = ubahBaris.payroll.rows.find((r) => r.id === barisSaya.id);
  check('gaji bersih = pokok + tunjangan + lembur + bonus − potongan',
    barisUbah.net === 3000000 + 500000 + 200000 + 100000 - 50000, String(barisUbah.net));

  let tolakMinus = 0;
  try {
    await call('PUT', `/api/penggajian/${idGaji}/baris/${barisSaya.id}`, { deduction: 99000000 });
  } catch (err) {
    tolakMinus = err.status;
  }
  check('potongan yang melebihi gaji ditolak', tolakMinus === 422, `status ${tolakMinus}`);

  // Draft belum boleh menyentuh pembukuan sama sekali.
  const sebelumPosting = await call('GET', `/api/finance/reports/trial-balance?from=${today.slice(0,8)}01&to=${akhirBulanGaji}`);
  const cariAkun = (tb, kode) => {
    const baris = (tb.rows || []).find((x) => x.code === kode);
    return baris ? (baris.debit || 0) - (baris.credit || 0) : 0;
  };
  const gajiSebelum = cariAkun(sebelumPosting, '6100');
  check('draft belum menambah beban gaji di pembukuan', gajiSebelum === 0, String(gajiSebelum));

  const totalGaji = ubahBaris.payroll.total.net;
  const posting = await call('POST', `/api/penggajian/${idGaji}/posting`);
  check('daftar gaji bisa diposting', posting.payroll.status === 'POSTED');
  check('posting membuat jurnal', posting.payroll.jurnal.length === 1);

  const sesudahPosting = await call('GET', `/api/finance/reports/trial-balance?from=${today.slice(0,8)}01&to=${akhirBulanGaji}`);
  check('beban gaji di pembukuan = total gaji bersih',
    near(cariAkun(sesudahPosting, '6100'), totalGaji, 1),
    `${cariAkun(sesudahPosting, '6100')} vs ${totalGaji}`);
  check('neraca saldo tetap seimbang setelah gaji diposting',
    near(sesudahPosting.totalDebit, sesudahPosting.totalCredit, 1));

  // Daftar yang sudah diposting tidak boleh diubah diam-diam — jurnalnya sudah
  // terbentuk dan angkanya akan berbeda dari pembukuan.
  let tolakUbahTerkunci = 0;
  try {
    await call('PUT', `/api/penggajian/${idGaji}/baris/${barisSaya.id}`, { bonus: 1 });
  } catch (err) {
    tolakUbahTerkunci = err.status;
  }
  check('daftar yang sudah diposting tidak bisa diubah', tolakUbahTerkunci === 422);

  let tolakHapusTerkunci = 0;
  try {
    await call('DELETE', `/api/penggajian/${idGaji}`);
  } catch (err) {
    tolakHapusTerkunci = err.status;
  }
  check('daftar yang sudah diposting tidak bisa dihapus', tolakHapusTerkunci === 422);

  const batal = await call('POST', `/api/penggajian/${idGaji}/batal-posting`);
  check('posting bisa dibatalkan', batal.payroll.status === 'DRAFT' && batal.payroll.jurnal.length === 0);
  const setelahBatal = await call('GET', `/api/finance/reports/trial-balance?from=${today.slice(0,8)}01&to=${akhirBulanGaji}`);
  check('membatalkan posting mengembalikan beban gaji ke nol',
    cariAkun(setelahBatal, '6100') === 0, String(cariAkun(setelahBatal, '6100')));
  check('angka gajinya tidak ikut hilang saat posting dibatalkan',
    batal.payroll.total.net === totalGaji, `${batal.payroll.total.net} vs ${totalGaji}`);

  // Gaji yang belum dibayarkan mendarat di Utang Gaji, bukan mengurangi bank.
  await call('PUT', `/api/penggajian/${idGaji}`, { payment: 'CREDIT' });
  await call('POST', `/api/penggajian/${idGaji}/posting`);
  const tbUtang = await call('GET', `/api/finance/reports/trial-balance?from=${today.slice(0,8)}01&to=${akhirBulanGaji}`);
  check('gaji belum dibayar menjadi Utang Gaji, bukan kas keluar',
    near(-cariAkun(tbUtang, '2110'), totalGaji, 1),
    String(cariAkun(tbUtang, '2110')));
  await call('POST', `/api/penggajian/${idGaji}/batal-posting`);

  let tolakGanda = 0;
  try {
    await call('POST', '/api/penggajian', { period: periodeGaji });
  } catch (err) {
    tolakGanda = err.status;
  }
  check('satu bulan hanya boleh punya satu daftar gaji', tolakGanda === 409, `status ${tolakGanda}`);

  for (const bentuk of ['excel', 'pdf']) {
    const res = await fetch(`${BASE}/api/penggajian/${idGaji}/export/${bentuk}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const buf = Buffer.from(await res.arrayBuffer());
    check(`daftar gaji bisa diunduh sebagai ${bentuk.toUpperCase()}`,
      res.ok && buf.length > 500 &&
      (bentuk === 'pdf' ? buf.slice(0, 4).toString() === '%PDF' : buf.slice(0, 2).toString('hex') === '504b'),
      `${res.status}, ${buf.length} byte`);
  }

  await call('DELETE', `/api/penggajian/${idGaji}`);

  // ---------- Pencairan dana ----------
  console.log('\n19. Pencairan dana marketplace');

  const tokoCair = await call('POST', '/api/shops', {
    name: `Toko Cair ${Date.now()}`, channel: 'SHOPEE',
  });
  const idTokoCair = (tokoCair.shop || tokoCair).id;

  const produkCair = await call('POST', '/api/inventory/products', {
    sku: `CAIR-${Date.now()}`, name: 'Uji Pencairan', category: 'Uji', unit: 'PCS',
    cost: 10000, price: 25000,
  });
  await call('POST', '/api/inventory/moves', {
    product_id: produkCair.product.id, move_date: today, move_type: 'IN',
    qty: 30, unit_cost: 10000, note: 'Uji pencairan',
  });

  // Satu order baru dan satu order lama, supaya kelompok umurnya berbeda.
  const orderBaru = await call('POST', '/api/sales', {
    order_date: today, shop_id: idTokoCair, channel: 'SHOPEE',
    items: [{ product_id: produkCair.product.id, qty: 4, price: 25000 }],
    admin_fee: 10000, payment_status: 'UNPAID',
  });
  const tglLama = new Date(Date.now() - 20 * 86400000).toLocaleDateString('sv-SE');
  const orderLama = await call('POST', '/api/sales', {
    order_date: tglLama, shop_id: idTokoCair, channel: 'SHOPEE',
    items: [{ product_id: produkCair.product.id, qty: 2, price: 25000 }],
    payment_status: 'UNPAID',
  });

  const pcr = await call('GET', `/api/pencairan?asOf=${today}&from=${today.slice(0, 8)}01&to=${today}`);
  const barisBaru = pcr.rows.find((o) => o.id === orderBaru.order.id);
  const barisLama = pcr.rows.find((o) => o.id === orderLama.order.id);

  check('order yang belum cair muncul di daftar', !!barisBaru && !!barisLama);
  check('nilai yang akan diterima = pendapatan − potongan',
    near(barisBaru.nilai, barisBaru.net_revenue - barisBaru.total_fees, 1),
    `${barisBaru.nilai} vs ${barisBaru.net_revenue} − ${barisBaru.total_fees}`);
  check('umur dana dihitung dari tanggal order',
    barisBaru.umur_hari === 0 && barisLama.umur_hari === 20,
    `${barisBaru.umur_hari} / ${barisLama.umur_hari}`);
  check('kelompok umur ditentukan dari umurnya',
    barisBaru.ember === '0-7' && barisLama.ember === '15-30',
    `${barisBaru.ember} / ${barisLama.ember}`);
  check('dana yang tertahan lebih dari 14 hari ditandai',
    barisLama.perluDitanya === true && barisBaru.perluDitanya === false);

  check('jumlah tiap kelompok umur = jumlah seluruh order',
    pcr.perEmber.reduce((s2, e) => s2 + e.orders, 0) === pcr.rows.length);
  const jumlahToko = pcr.perToko.reduce((s2, t) => s2 + t.nilai, 0);
  check('nilai per toko = nilai seluruhnya',
    near(jumlahToko, pcr.ringkas.nilai, 1), `${jumlahToko} vs ${pcr.ringkas.nilai}`);

  // Inti layar ini: angkanya harus bisa dicocokkan dengan buku besar. Selisih
  // yang tidak bisa dijelaskan berarti ada jurnal yang tidak seperti seharusnya.
  const k = pcr.rekonsiliasi;
  check('rekonsiliasi cocok dengan saldo Piutang Marketplace di buku besar',
    k.cocok === true,
    `belum cair ${k.nilaiBelumCair} − iklan saldo ${k.iklanPotongSaldo} = ${k.seharusnya}, buku ${k.saldoBuku}`);

  // Iklan yang dibayar potong saldo mengurangi piutang tanpa menyentuh pesanan.
  // Rekonsiliasinya harus tetap cocok sesudahnya, kalau tidak selisihnya akan
  // muncul sebagai kesalahan yang sebenarnya bukan kesalahan.
  await call('POST', '/api/iklan', {
    spend_date: today, shop_id: idTokoCair, channel: 'SHOPEE',
    amount: 30000, payment: 'SALDO', note: 'Uji potong saldo',
  });
  const pcr2 = await call('GET', `/api/pencairan?asOf=${today}`);
  check('iklan potong saldo ikut diperhitungkan dalam rekonsiliasi',
    pcr2.rekonsiliasi.cocok === true && pcr2.rekonsiliasi.iklanPotongSaldo >= 30000,
    `iklan saldo ${pcr2.rekonsiliasi.iklanPotongSaldo}, selisih ${pcr2.rekonsiliasi.selisih}`);
  check('nilai order yang belum cair tidak ikut berubah oleh iklan',
    near(pcr2.rekonsiliasi.nilaiBelumCair, k.nilaiBelumCair, 1));

  // Menandai cair memakai jalur yang sudah ada; jurnalnya harus ikut berpindah.
  const nilaiTandai = barisLama.nilai;
  const hasilTandai = await call('PATCH', '/api/sales/status-massal', {
    ids: [orderLama.order.id],
    fulfillment_status: 'CAIR',
    payment_status: 'PAID',
    payout_date: today,
  });
  check('order bisa ditandai cair', hasilTandai.berhasil === 1);

  const pcr3 = await call('GET', `/api/pencairan?asOf=${today}&from=${today.slice(0, 8)}01&to=${today}`);
  check('order yang sudah cair keluar dari daftar belum cair',
    !pcr3.rows.some((o) => o.id === orderLama.order.id));
  check('nilai belum cair berkurang persis sebesar order yang dicairkan',
    near(pcr3.rekonsiliasi.nilaiBelumCair, pcr2.rekonsiliasi.nilaiBelumCair - nilaiTandai, 1),
    `${pcr3.rekonsiliasi.nilaiBelumCair} vs ${pcr2.rekonsiliasi.nilaiBelumCair} − ${nilaiTandai}`);
  check('rekonsiliasi tetap cocok setelah dana dicairkan',
    pcr3.rekonsiliasi.cocok === true,
    `selisih ${pcr3.rekonsiliasi.selisih}`);
  check('order yang cair masuk ringkasan pencairan periode ini',
    pcr3.ringkas.cairOrders >= 1 && pcr3.ringkas.cairNilai >= nilaiTandai - 1,
    `${pcr3.ringkas.cairOrders} order, ${pcr3.ringkas.cairNilai}`);

  // Order yang dibatalkan bukan piutang; ikut menghitungnya akan membuat
  // uang yang tidak akan pernah datang tampak seolah sedang ditahan.
  const orderBatal = await call('POST', '/api/sales', {
    order_date: today, shop_id: idTokoCair, channel: 'SHOPEE',
    items: [{ product_id: produkCair.product.id, qty: 1, price: 25000 }],
    payment_status: 'UNPAID',
  });
  await call('DELETE', `/api/sales/${orderBatal.order.id}`);
  const pcr4 = await call('GET', `/api/pencairan?asOf=${today}`);
  check('order yang dibatalkan tidak dihitung sebagai dana ditahan',
    !pcr4.rows.some((o) => o.id === orderBatal.order.id) && pcr4.rekonsiliasi.cocok === true);

  // Status bayar dan tanggal cair yang tidak sejalan tidak merusak pembukuan,
  // tetapi membuat umur dana keliru — jadi harus kelihatan, bukan didiamkan.
  check('order yang sejalan tidak dilaporkan sebagai janggal',
    !pcr4.takSejalan.some((o) => o.id === orderBaru.order.id));
  await call('PUT', `/api/sales/${orderBaru.order.id}`, { payout_date: today });
  const pcr5 = await call('GET', `/api/pencairan?asOf=${today}`);
  check('order belum lunas tapi punya tanggal cair terdeteksi janggal',
    pcr5.takSejalan.some((o) => o.id === orderBaru.order.id),
    `${pcr5.takSejalan.length} janggal`);
  check('order janggal tetap dihitung sebagai dana ditahan',
    pcr5.rows.some((o) => o.id === orderBaru.order.id) && pcr5.rekonsiliasi.cocok === true);
  await call('PUT', `/api/sales/${orderBaru.order.id}`, { payout_date: null });

  for (const bentuk of ['excel', 'pdf']) {
    const res = await fetch(`${BASE}/api/pencairan/export/${bentuk}?asOf=${today}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const buf = Buffer.from(await res.arrayBuffer());
    check(`pencairan bisa diunduh sebagai ${bentuk.toUpperCase()}`,
      res.ok && buf.length > 500 &&
      (bentuk === 'pdf' ? buf.slice(0, 4).toString() === '%PDF' : buf.slice(0, 2).toString('hex') === '504b'),
      `${res.status}, ${buf.length} byte`);
  }

  // ---------- Slip gaji & nota supplier ----------
  console.log('\n20. Slip gaji & nota supplier');

  const ambilBerkas = async (path) => {
    const res = await fetch(`${BASE}${path}`, { headers: { Authorization: `Bearer ${token}` } });
    const buf = Buffer.from(await res.arrayBuffer());
    return { res, buf, teks: buf.toString('latin1') };
  };

  // --- Slip gaji ---
  const periodeSlip = `${Number(today.slice(0, 4)) - 1}-${today.slice(5, 7)}`;
  const pegawaiSlip = await call('POST', '/api/admin/users', {
    name: 'Uji Slip', email: `slip-${Date.now()}@uji.local`, password: 'RahasiaKuat1',
    role: 'staff', position: 'Admin', base_salary: 4000000, allowance: 600000,
    bank_name: 'BRI', bank_account: '9876543210',
  });
  const gajiSlip = await call('POST', '/api/penggajian', { period: periodeSlip, payment: 'BANK' });
  const idSlip = gajiSlip.payroll.id;
  const barisSlip = gajiSlip.payroll.rows.find((r) => r.employee_id === pegawaiSlip.user.id);
  await call('PUT', `/api/penggajian/${idSlip}/baris/${barisSlip.id}`, {
    bonus: 250000, deduction: 100000, note: 'Bonus lembaran',
  });

  const satuSlip = await ambilBerkas(`/api/penggajian/${idSlip}/slip/${barisSlip.id}/pdf`);
  check('slip gaji satu orang terbentuk sebagai PDF',
    satuSlip.res.ok && satuSlip.buf.slice(0, 4).toString() === '%PDF' && satuSlip.buf.length > 800,
    `${satuSlip.res.status}, ${satuSlip.buf.length} byte`);
  // inline supaya bisa langsung dibuka dan dicetak, bukan dipaksa turun dulu.
  check('slip dikirim untuk dibuka di peramban, bukan sebagai unduhan paksa',
    (satuSlip.res.headers.get('Content-Disposition') || '').startsWith('inline'),
    satuSlip.res.headers.get('Content-Disposition'));

  const semuaSlip = await ambilBerkas(`/api/penggajian/${idSlip}/slip/pdf`);
  const halaman = (buf) => (buf.toString('latin1').match(/\/Type\s*\/Page[^s]/g) || []).length;
  check('slip semua pegawai jadi satu berkas, satu halaman per orang',
    semuaSlip.res.ok && halaman(semuaSlip.buf) === gajiSlip.payroll.rows.length,
    `${halaman(semuaSlip.buf)} halaman untuk ${gajiSlip.payroll.rows.length} pegawai`);
  check('berkas semua slip lebih besar daripada slip satu orang',
    semuaSlip.buf.length > satuSlip.buf.length);

  // Slip harus tetap berbunyi sama walau gaji di master sudah naik sejak itu —
  // inti dari nilai gaji yang dibekukan pada daftarnya.
  await call('PUT', `/api/admin/users/${pegawaiSlip.user.id}`, {
    name: 'Uji Slip', email: pegawaiSlip.user.email, role: 'staff', base_salary: 99000000,
  });
  const slipUlang = await ambilBerkas(`/api/penggajian/${idSlip}/slip/${barisSlip.id}/pdf`);
  check('mencetak ulang slip lama tidak memakai gaji yang sudah naik',
    slipUlang.res.ok && Math.abs(slipUlang.buf.length - satuSlip.buf.length) < 400,
    `${satuSlip.buf.length} lalu ${slipUlang.buf.length} byte`);

  let slipHilang = 0;
  try {
    await ambilBerkas(`/api/penggajian/${idSlip}/slip/999999/pdf`).then((x) => {
      slipHilang = x.res.status;
    });
  } catch {
    slipHilang = 0;
  }
  check('slip untuk baris yang tidak ada ditolak', slipHilang === 404, `status ${slipHilang}`);

  await call('DELETE', `/api/penggajian/${idSlip}`);

  // --- Nota supplier ---
  const supplierNota = await call('POST', '/api/partners', {
    name: `Supplier Nota ${Date.now()}`, kind: 'SUPPLIER',
    phone: '0812000111', address: 'Jl. Uji Nota 1',
  });
  const produkNota = await call('POST', '/api/inventory/products', {
    sku: `NOTA-${Date.now()}`, name: 'Uji Nota', category: 'Uji', unit: 'PCS',
    cost: 12000, price: 20000,
  });
  const faktur = `INV-${Date.now()}`;
  const poNota = await call('POST', '/api/pembelian', {
    order_date: today,
    partner_id: (supplierNota.partner || supplierNota).id,
    payment: 'CREDIT',
    invoice_no: faktur,
    due_date: today,
    items: [{ product_id: produkNota.product.id, qty: 5, unit_cost: 12000 }],
  });
  check('nomor faktur supplier tersimpan saat pesanan dibuat',
    poNota.po.invoice_no === faktur, String(poNota.po.invoice_no));

  const notaPdf = await ambilBerkas(`/api/pembelian/${poNota.po.id}/nota/pdf`);
  check('nota supplier terbentuk sebagai PDF',
    notaPdf.res.ok && notaPdf.buf.slice(0, 4).toString() === '%PDF' && notaPdf.buf.length > 800,
    `${notaPdf.res.status}, ${notaPdf.buf.length} byte`);
  check('nota dikirim untuk dibuka di peramban',
    (notaPdf.res.headers.get('Content-Disposition') || '').startsWith('inline'));

  const notaCsv = await ambilBerkas(`/api/pembelian/${poNota.po.id}/nota/csv`);
  const isiCsv = notaCsv.buf.toString('utf8');
  check('nota supplier bisa diunduh sebagai CSV',
    notaCsv.res.ok && isiCsv.includes(faktur) && isiCsv.includes(poNota.po.po_no),
    `${notaCsv.res.status}, ${notaCsv.buf.length} byte`);
  // Tanpa BOM, Excel berbahasa Indonesia membaca huruf beraksen jadi berantakan.
  check('CSV diawali BOM dan berpemisah titik koma',
    isiCsv.charCodeAt(0) === 0xfeff && isiCsv.split('\r\n')[0].includes(';'),
    JSON.stringify(isiCsv.slice(0, 40)));
  check('tiap baris CSV membawa nomor fakturnya sendiri',
    isiCsv.trim().split('\r\n').slice(1).every((b) => b.startsWith(faktur)));

  // Satu nomor faktur dipakai dua kali biasanya berarti pembayaran ganda.
  const poKedua = await call('POST', '/api/pembelian', {
    order_date: today,
    partner_id: (supplierNota.partner || supplierNota).id,
    payment: 'CREDIT',
    items: [{ product_id: produkNota.product.id, qty: 1, unit_cost: 12000 }],
  });
  let tolakFakturKembar = 0;
  try {
    await call('PATCH', `/api/pembelian/${poKedua.po.id}/nota`, { invoice_no: faktur });
  } catch (err) {
    tolakFakturKembar = err.status;
  }
  check('nomor faktur yang sudah dipakai pesanan lain ditolak',
    tolakFakturKembar === 409, `status ${tolakFakturKembar}`);

  const tandaiBayar = await call('PATCH', `/api/pembelian/${poNota.po.id}/nota`, {
    invoice_no: faktur, paid_date: today,
  });
  check('tanggal bayar tersimpan pada nota', tandaiBayar.po.paid_date === today);

  // Mencatat keterangan nota tidak boleh membukukan apa pun: jurnal pembelian
  // sudah terbentuk saat barang diterima.
  const jurnalSetelah = await call('GET',
    `/api/finance/reports/trial-balance?from=${today.slice(0, 8)}01&to=${today}`);
  check('mencatat nota tidak mengubah keseimbangan pembukuan',
    near(jurnalSetelah.totalDebit, jurnalSetelah.totalCredit, 1));

  const listCsv = await ambilBerkas(
    `/api/pembelian/export/csv?from=${today.slice(0, 8)}01&to=${today}`
  );
  check('daftar pesanan pembelian juga bisa diunduh sebagai CSV',
    listCsv.res.ok && listCsv.buf.toString('utf8').charCodeAt(0) === 0xfeff,
    `${listCsv.res.status}, ${listCsv.buf.length} byte`);

  // ---------- Tanda tangan digital & verifikasi ----------
  console.log('\n21. Tanda tangan digital dokumen');

  const periodeTtd = `${Number(today.slice(0, 4)) - 2}-${today.slice(5, 7)}`;
  const pegawaiTtd = await call('POST', '/api/admin/users', {
    name: 'Uji Tanda Tangan', email: `ttd-${Date.now()}@uji.local`, password: 'RahasiaKuat1',
    role: 'staff', position: 'Kurir', base_salary: 2500000,
  });
  const gajiTtd = await call('POST', '/api/penggajian', { period: periodeTtd, payment: 'BANK' });
  const idTtd = gajiTtd.payroll.id;
  const barisTtd = gajiTtd.payroll.rows.find((r) => r.employee_id === pegawaiTtd.user.id);

  const sebelumTerbit = await call('GET', '/api/dokumen');
  await ambilBerkas(`/api/penggajian/${idTtd}/slip/${barisTtd.id}/pdf`);
  const sesudahTerbit = await call('GET', '/api/dokumen');
  check('mencetak slip menerbitkan tanda tangan digitalnya',
    sesudahTerbit.rows.length === sebelumTerbit.rows.length + 1,
    `${sebelumTerbit.rows.length} lalu ${sesudahTerbit.rows.length}`);

  const dokSlip = sesudahTerbit.rows.find((d) => d.kind === 'SLIP_GAJI' && d.ref_id === barisTtd.id);
  check('tanda tangan membawa nomor, kode, dan tautannya',
    !!dokSlip && /^SLIP\//.test(dokSlip.nomor) && !!dokSlip.kode && /\/verifikasi\/[0-9a-f]{48}$/.test(dokSlip.tautan || ''),
    `${dokSlip && dokSlip.nomor} | ${dokSlip && dokSlip.tautan}`);

  const tokenSlip = dokSlip.tautan.split('/').pop();

  // Inti fiturnya: halaman pemeriksaan harus terbuka TANPA login. Yang memegang
  // slip gaji justru pihak yang tidak punya akun di sini.
  const publik = await fetch(`${BASE}/api/verifikasi/${tokenSlip}`);
  const isiPublik = await publik.json();
  check('halaman pemeriksaan terbuka tanpa login',
    publik.ok && isiPublik.status === 'sah', `${publik.status} ${isiPublik.status}`);
  check('pemeriksaan menyebut penerbitnya sistem ERP',
    /^Sistem ERP /.test(isiPublik.penerbit || ''), isiPublik.penerbit);
  check('pemeriksaan menampilkan angka dokumennya',
    isiPublik.dokumen && near(isiPublik.dokumen.total[1], barisTtd.net, 1),
    `${isiPublik.dokumen && isiPublik.dokumen.total[1]} vs ${barisTtd.net}`);

  // Token acak, tidak berurutan: satu tautan tidak boleh menuntun ke tautan lain.
  const tebakanToken = await fetch(`${BASE}/api/verifikasi/${'0'.repeat(48)}`);
  check('token yang ditebak-tebak ditolak', tebakanToken.status === 404);
  const bentukSalah = await fetch(`${BASE}/api/verifikasi/1`);
  check('token yang bentuknya salah ditolak sebelum menyentuh basis data',
    bentukSalah.status === 404);

  // Mencetak ulang tanpa mengubah apa pun tidak boleh menaikkan versi — kalau
  // naik, setiap cetakan akan membuat kertas sebelumnya tampak kedaluwarsa.
  await ambilBerkas(`/api/penggajian/${idTtd}/slip/${barisTtd.id}/pdf`);
  const setelahCetakUlang = await call('GET', '/api/dokumen');
  const dokUlang = setelahCetakUlang.rows.find((d) => d.id === dokSlip.id);
  check('mencetak ulang tanpa perubahan tidak menaikkan versi',
    dokUlang.versi === dokSlip.versi && dokUlang.cetak === dokSlip.cetak + 1,
    `versi ${dokUlang.versi}, cetak ${dokUlang.cetak}`);

  // Mengubah angkanya harus terlihat oleh yang memegang kertas lama.
  await call('PUT', `/api/penggajian/${idTtd}/baris/${barisTtd.id}`, { bonus: 175000 });
  const ttdSetelahUbah = await fetch(`${BASE}/api/verifikasi/${tokenSlip}`).then((r) => r.json());
  check('dokumen yang datanya berubah dilaporkan berubah, bukan sah',
    ttdSetelahUbah.status === 'berubah' && ttdSetelahUbah.kode !== ttdSetelahUbah.kodeSekarang,
    `${ttdSetelahUbah.status}`);
  check('kode lama dan kode terbaru sama-sama ditampilkan',
    !!ttdSetelahUbah.kode && !!ttdSetelahUbah.kodeSekarang);

  await ambilBerkas(`/api/penggajian/${idTtd}/slip/${barisTtd.id}/pdf`);
  const setelahCetakLagi = await call('GET', '/api/dokumen');
  const dokNaik = setelahCetakLagi.rows.find((d) => d.id === dokSlip.id);
  check('mencetak setelah data berubah menaikkan versinya',
    dokNaik.versi === dokSlip.versi + 1 && dokNaik.status === 'sah',
    `versi ${dokNaik.versi}, status ${dokNaik.status}`);
  check('token tetap sama walau versinya naik',
    (await fetch(`${BASE}/api/verifikasi/${tokenSlip}`)).ok);

  // Setiap pegawai punya tautannya sendiri — satu orang tidak boleh melihat
  // gaji rekannya hanya karena memindai QR di lembarnya.
  await ambilBerkas(`/api/penggajian/${idTtd}/slip/pdf`);
  const semuaDok = await call('GET', '/api/dokumen');
  const dokPeriode = semuaDok.rows.filter(
    (d) => d.kind === 'SLIP_GAJI' && gajiTtd.payroll.rows.some((r) => r.id === d.ref_id)
  );
  check('tiap pegawai punya tautan sendiri, bukan satu untuk seluruh berkas',
    dokPeriode.length === gajiTtd.payroll.rows.length &&
    new Set(dokPeriode.map((d) => d.tautan)).size === dokPeriode.length,
    `${dokPeriode.length} tautan untuk ${gajiTtd.payroll.rows.length} pegawai`);

  // Tautan yang tersebar ke tangan yang salah harus bisa dimatikan.
  const cabutTtd = await call('PATCH', `/api/dokumen/${dokSlip.id}/cabut`);
  check('tautan dokumen bisa dicabut', cabutTtd.ok);
  const setelahCabut = await fetch(`${BASE}/api/verifikasi/${tokenSlip}`);
  const isiCabut = await setelahCabut.json();
  check('tautan yang dicabut tidak lagi menampilkan isi dokumen',
    setelahCabut.status === 410 && isiCabut.status === 'dicabut' && !isiCabut.dokumen,
    `${setelahCabut.status} ${isiCabut.status}`);

  const aktifkanTtd = await call('PATCH', `/api/dokumen/${dokSlip.id}/aktifkan`);
  check('tautan bisa diaktifkan kembali dengan token yang sama', aktifkanTtd.ok);
  check('QR yang sudah tercetak berlaku lagi setelah diaktifkan',
    (await fetch(`${BASE}/api/verifikasi/${tokenSlip}`)).ok);

  // Nota supplier memakai jalur yang sama.
  const notaTtd = await ambilBerkas(`/api/pembelian/${poNota.po.id}/nota/pdf`);
  check('nota supplier ikut membawa tanda tangan digital', notaTtd.res.ok);
  const dokNota = (await call('GET', '/api/dokumen')).rows
    .find((d) => d.kind === 'NOTA_SUPPLIER' && d.ref_id === poNota.po.id);
  check('nota supplier tercatat di daftar dokumen terbit',
    !!dokNota && dokNota.nomor === faktur, dokNota && dokNota.nomor);
  const periksaNota = await fetch(`${BASE}/api/verifikasi/${dokNota.tautan.split('/').pop()}`)
    .then((r) => r.json());
  check('pemeriksaan nota menampilkan supplier dan nilainya',
    periksaNota.status === 'sah' && periksaNota.dokumen.untuk.startsWith('Supplier Nota'),
    `${periksaNota.status}`);

  // Dokumen yang sumbernya hilang tidak boleh menampilkan sisa data lama.
  await call('DELETE', `/api/penggajian/${idTtd}`);
  const setelahHapus = await fetch(`${BASE}/api/verifikasi/${tokenSlip}`);
  const isiHapus = await setelahHapus.json();
  check('dokumen yang sumbernya sudah dihapus dilaporkan hilang',
    setelahHapus.status === 410 && isiHapus.status === 'hilang' && !isiHapus.dokumen,
    `${setelahHapus.status} ${isiHapus.status}`);

  for (const bentuk of ['excel', 'csv', 'pdf']) {
    const res = await fetch(`${BASE}/api/dokumen/export/${bentuk}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const buf = Buffer.from(await res.arrayBuffer());
    check(`dokumen terbit bisa diunduh sebagai ${bentuk.toUpperCase()}`,
      res.ok && buf.length > 200, `${res.status}, ${buf.length} byte`);
  }

  // ---------- Pencadangan ----------
  console.log('\n22. Pencadangan basis data');

  const kosong = await call('GET', '/api/cadangan');
  check('keadaan basis data ikut dilaporkan',
    kosong.info.ukuran > 0 && kosong.info.isi.order !== null,
    `${kosong.info.ukuranTeks}, ${kosong.info.isi.order} order`);
  check('langkah pemulihan ikut dikirim, tidak perlu dicari saat panik',
    Array.isArray(kosong.langkahPulih) && kosong.langkahPulih.length >= 4);

  const dibuat = await call('POST', '/api/cadangan');
  check('cadangan bisa dibuat', dibuat.ok && dibuat.cadangan.ukuran > 0,
    `${dibuat.cadangan.nama} ${dibuat.cadangan.ukuranTeks}`);

  const daftarCad = await call('GET', '/api/cadangan');
  check('cadangan baru muncul di daftar',
    daftarCad.rows.some((c) => c.nama === dibuat.cadangan.nama));

  // Inti fiturnya: berkasnya harus benar-benar basis data SQLite yang utuh, dan
  // isinya sama dengan yang sedang berjalan. Menyalin berkas yang sedang dipakai
  // bisa menghasilkan berkas yang terbuka tanpa keluhan tetapi kehilangan
  // transaksi terakhir — kerusakan yang baru ketahuan saat dibutuhkan.
  const unduhan = await fetch(`${BASE}/api/cadangan/${dibuat.cadangan.nama}/unduh`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const isiCad = Buffer.from(await unduhan.arrayBuffer());
  check('cadangan bisa diunduh', unduhan.ok && isiCad.length === dibuat.cadangan.ukuran,
    `${unduhan.status}, ${isiCad.length} byte`);
  check('berkas yang turun benar-benar basis data SQLite',
    isiCad.slice(0, 15).toString() === 'SQLite format 3');

  const berkasUji = require('path').join(require('os').tmpdir(), `uji-cadangan-${Date.now()}.db`);
  require('fs').writeFileSync(berkasUji, isiCad);
  const Database = require('better-sqlite3');
  const salinan = new Database(berkasUji, { readonly: true });
  const integritas = salinan.pragma('integrity_check')[0].integrity_check;
  const orderSalinan = salinan.prepare('SELECT COUNT(*) c FROM sales_orders').get().c;
  const jurnalSalinan = salinan.prepare('SELECT COUNT(*) c FROM journals').get().c;
  salinan.close();
  require('fs').unlinkSync(berkasUji);

  check('cadangan lolos pemeriksaan integritas', integritas === 'ok', integritas);
  check('isi cadangan sama dengan basis data yang berjalan',
    orderSalinan === kosong.info.isi.order && jurnalSalinan === kosong.info.isi.jurnal,
    `${orderSalinan} order / ${jurnalSalinan} jurnal vs ${kosong.info.isi.order} / ${kosong.info.isi.jurnal}`);

  // Nama berkas tidak boleh dipakai mengambil berkas lain dari server.
  for (const jahat of ['..%2F..%2F.env', 'erp-2020-01-01.txt', 'sembarang.db']) {
    const res = await fetch(`${BASE}/api/cadangan/${jahat}/unduh`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    check(`nama berkas "${decodeURIComponent(jahat)}" ditolak`, res.status === 404, `status ${res.status}`);
  }

  // Berkas cadangan berisi seluruh data termasuk akun; izinnya harus berdiri
  // sendiri, bukan menumpang "sudah login".
  const simpanAdmin = token;
  token = await masukSebagai(akunGudang.user.email, 'RahasiaKuat1');
  const ditolak = await fetch(`${BASE}/api/cadangan`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  check('akun tanpa izin ditolak dari pencadangan', ditolak.status === 403, `status ${ditolak.status}`);
  token = simpanAdmin;

  // Dua cadangan berturut-turut jatuh pada detik yang sama. Kalau namanya sama,
  // yang kedua menimpa yang pertama — kehilangan diam-diam pada fitur yang
  // justru gunanya menjaga agar tidak ada yang hilang.
  const buatLagi = await call('POST', '/api/cadangan');
  check('cadangan kedua bisa dibuat', buatLagi.ok);
  check('cadangan pada detik yang sama tidak menimpa yang sebelumnya',
    buatLagi.cadangan.nama !== dibuat.cadangan.nama,
    `${dibuat.cadangan.nama} vs ${buatLagi.cadangan.nama}`);
  const duaAda = await call('GET', '/api/cadangan');
  check('keduanya tersimpan sebagai berkas terpisah',
    duaAda.rows.some((c) => c.nama === dibuat.cadangan.nama) &&
    duaAda.rows.some((c) => c.nama === buatLagi.cadangan.nama),
    `${duaAda.rows.length} berkas`);

  const hapusCad = await call('DELETE', `/api/cadangan/${dibuat.cadangan.nama}`);
  check('cadangan bisa dihapus', hapusCad.ok);

  // Cadangan terakhir tidak boleh hilang lewat layar.
  const sisa = await call('GET', '/api/cadangan');
  let tolakHapusTerakhir = 0;
  if (sisa.rows.length === 1) {
    try {
      await call('DELETE', `/api/cadangan/${sisa.rows[0].nama}`);
    } catch (err) {
      tolakHapusTerakhir = err.status;
    }
    check('cadangan terakhir tidak boleh dihapus', tolakHapusTerakhir === 422,
      `status ${tolakHapusTerakhir}`);
  } else {
    check('cadangan terakhir tidak boleh dihapus', true, `${sisa.rows.length} tersisa — dilewati`);
  }

  // ---------- Pusat Perhatian ----------
  console.log('\n23. Pusat Perhatian');

  const perhatian = await call('GET', '/api/perhatian');
  check('pusat perhatian bisa dibuka', Array.isArray(perhatian.rows));
  check('tidak ada sumber yang gagal dibaca',
    perhatian.gagal.length === 0, JSON.stringify(perhatian.gagal));
  check('jumlah per tingkat = jumlah seluruh butir',
    perhatian.ringkas.genting + perhatian.ringkas.perhatian + perhatian.ringkas.kabar
      === perhatian.rows.length);
  check('yang genting berada di urutan atas',
    perhatian.rows.every((b, i) =>
      i === 0 || ['genting', 'perhatian', 'kabar'].indexOf(perhatian.rows[i - 1].tingkat)
        <= ['genting', 'perhatian', 'kabar'].indexOf(b.tingkat)));
  check('tiap butir membawa tautan ke menu yang bersangkutan',
    perhatian.rows.every((b) => typeof b.tautan === 'string' && b.tautan.startsWith('/')));

  // Angkanya harus sama persis dengan menunya. Kalau peringatan menghitung
  // sendiri, cepat atau lambat ia akan menyebut angka yang berbeda dan tidak
  // ada yang tahu mana yang benar.
  const kinerjaBanding = await call('GET', '/api/kinerja/produk');
  const butirHabis = perhatian.rows.find((b) => b.kunci === 'stok-habis');
  const habisMenu = kinerjaBanding.rows.filter((r) => r.golongan === 'habis').length;
  check('jumlah produk habis sama dengan yang tampil di Kinerja Produk',
    (butirHabis ? butirHabis.jumlah : 0) === habisMenu,
    `${butirHabis ? butirHabis.jumlah : 0} vs ${habisMenu}`);

  const rekBanding = await call('GET', `/api/cashflow/rekening?asOf=${today}`);
  const minusMenu = rekBanding.rows.filter((a) => a.minus).length;
  const minusButir = perhatian.rows.filter((b) => b.kunci.startsWith('rekening-minus-')).length;
  check('rekening minus sama banyak dengan yang tampil di Rekening Kas & Bank',
    minusButir === minusMenu, `${minusButir} vs ${minusMenu}`);

  // Inti pembatasan: peringatan tidak boleh membocorkan apa yang sudah
  // disembunyikan di menunya. Tim gudang tidak melihat keuangan.
  const adminLagi = token;
  token = await masukSebagai(akunGudang.user.email, 'RahasiaKuat1');
  const perhatianGudang = await call('GET', '/api/perhatian');
  check('tim gudang tetap boleh membuka pusat perhatian',
    Array.isArray(perhatianGudang.rows));
  check('butir keuangan tidak bocor ke tim gudang',
    !perhatianGudang.rows.some((b) => b.kunci.startsWith('rekening-minus-')
      || b.kunci === 'pencairan-selisih' || b.kunci === 'dana-tertahan'),
    perhatianGudang.rows.map((b) => b.kunci).join(', '));
  check('butir gudang tetap sampai ke tim gudang',
    perhatianGudang.rows.every((b) => !b.izin || [].concat(b.izin).some((k) => k.startsWith('gudang.')
      || k.startsWith('pembelian.') || k.startsWith('presensi.') || k === 'dashboard.lihat')),
    perhatianGudang.rows.map((b) => b.izin).join(' | '));
  token = adminLagi;

  // ---------- Proyeksi arus kas ----------
  console.log('\n24. Proyeksi arus kas');

  const proy = await call('GET', '/api/proyeksi?minggu=8');
  check('proyeksi tersusun sebanyak minggu yang diminta',
    proy.rows.length === 8 && proy.minggu === 8, `${proy.rows.length} minggu`);

  // Titik mulainya harus kas yang sebenarnya, bukan angka lain.
  const rekProy = await call('GET', `/api/cashflow/rekening?asOf=${today}`);
  const kasNyata = rekProy.rows.reduce((s, a) => s + a.saldo, 0);
  check('saldo awal = jumlah seluruh rekening kas & bank',
    near(proy.ringkas.saldoAwal, kasNyata, 1),
    `${proy.ringkas.saldoAwal} vs ${kasNyata}`);

  // Saldo tiap minggu harus benar-benar berjalan dari minggu sebelumnya.
  let jalan = proy.mulai.saldo;
  const runut = proy.rows.every((b) => {
    jalan = Math.round((jalan + b.totalMasuk - b.totalKeluar) * 100) / 100;
    return near(jalan, b.saldoAkhir, 1);
  });
  check('saldo berjalan runut dari minggu ke minggu', runut);
  check('bersih tiap minggu = masuk dikurangi keluar',
    proy.rows.every((b) => near(b.bersih, b.totalMasuk - b.totalKeluar, 1)));
  check('total masuk & keluar = jumlah tiap minggunya',
    near(proy.ringkas.totalMasuk, proy.rows.reduce((s, b) => s + b.totalMasuk, 0), 1) &&
    near(proy.ringkas.totalKeluar, proy.rows.reduce((s, b) => s + b.totalKeluar, 0), 1));

  // Minggu tidak boleh bertumpuk atau berlubang: satu hari hanya boleh masuk
  // satu minggu, kalau tidak uang yang sama terhitung dua kali.
  check('minggu bersambung tanpa celah',
    proy.rows.every((b, i) => i === 0 || b.dari === new Date(
      Date.parse(`${proy.rows[i - 1].sampai}T00:00:00Z`) + 86400000
    ).toISOString().slice(0, 10)));

  // Dana marketplace yang belum cair harus seluruhnya muncul sebagai uang masuk
  // bila jangkanya cukup panjang; kalau ada yang hilang, proyeksinya
  // meremehkan uang yang akan datang.
  const pencairanBanding = await call('GET', `/api/pencairan?asOf=${today}`);
  const proyPanjang = await call('GET', '/api/proyeksi?minggu=26');
  const masukTotal = proyPanjang.rows.reduce(
    (s, b) => s + (b.masuk.find((m) => m.sumber === 'Pencairan marketplace') || { nilai: 0 }).nilai, 0
  );
  check('seluruh dana belum cair muncul di garis waktu',
    near(masukTotal, pencairanBanding.ringkas.nilai, 2),
    `${masukTotal} vs ${pencairanBanding.ringkas.nilai}`);

  check('asumsi disebutkan beserta dasarnya',
    proy.asumsi.length >= 4 && proy.asumsi.every((a) => a.label && a.dasar));
  check('batas perkiraan disebutkan apa adanya',
    Array.isArray(proy.tidakDihitung) && proy.tidakDihitung.length >= 3);

  // Jangka diminta di luar batas harus dijepit, bukan diikuti apa adanya.
  const terlaluPanjang = await call('GET', '/api/proyeksi?minggu=999');
  check('jangka proyeksi dijepit pada batas yang masuk akal',
    terlaluPanjang.minggu === 26, `${terlaluPanjang.minggu} minggu`);

  for (const bentuk of ['excel', 'csv', 'pdf']) {
    const res = await fetch(`${BASE}/api/proyeksi/export/${bentuk}?minggu=8`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const buf = Buffer.from(await res.arrayBuffer());
    check(`proyeksi bisa diunduh sebagai ${bentuk.toUpperCase()}`,
      res.ok && buf.length > 200, `${res.status}, ${buf.length} byte`);
  }

  // ---------- Riwayat perubahan & tutup buku ----------
  console.log('\n25. Riwayat perubahan & tutup buku');

  const tokoJejak = await call('POST', '/api/shops', {
    name: `Toko Jejak ${Date.now()}`, channel: 'SHOPEE',
  });
  const riwayat = await call('GET', `/api/riwayat?from=${today}&to=${today}&limit=500`);
  const jejakToko = riwayat.rows.find(
    (r) => r.method === 'POST' && r.path === '/api/shops' && r.status < 400
  );
  check('perubahan tercatat tanpa perlu dipasang di endpointnya',
    !!jejakToko && jejakToko.aksi === 'Tambah', jejakToko && jejakToko.path);
  check('riwayat menyebut siapa pelakunya',
    !!jejakToko && !!jejakToko.user_name && !!jejakToko.user_id);
  // Awalan "api" ada di semua alamat; kalau ikut dipakai, tiap baris bermodul
  // "api" dan penyaring per modul tidak menyaring apa pun.
  check('modul diambil dari nama modulnya, bukan awalan api',
    !!jejakToko && jejakToko.modul === 'shops', jejakToko && jejakToko.modul);
  check('membaca laporan tidak ikut dicatat',
    !riwayat.rows.some((r) => r.method === 'GET'));

  // Kata sandi tidak boleh ikut tersimpan — riwayat yang menyimpannya berubah
  // dari catatan pengaman menjadi kebocoran.
  const akunJejak = await call('POST', '/api/admin/users', {
    name: 'Uji Jejak', email: `jejak-${Date.now()}@uji.local`, password: 'RahasiaKuat1',
    role: 'staff',
  });
  const riwayat2 = await call('GET', `/api/riwayat?from=${today}&to=${today}&limit=500`);
  const jejakAkun = riwayat2.rows.find(
    (r) => r.method === 'POST' && r.path === '/api/admin/users' && r.status < 400
  );
  check('badan permintaan ikut tersimpan', !!jejakAkun && !!jejakAkun.isi);
  check('kata sandi tidak ikut tersimpan di riwayat',
    !!jejakAkun && jejakAkun.isi.password === '[disembunyikan]'
      && !JSON.stringify(jejakAkun.isi).includes('RahasiaKuat1'),
    JSON.stringify(jejakAkun && jejakAkun.isi));

  // Permintaan yang ditolak juga harus tercatat: percobaan yang gagal justru
  // yang paling perlu terlihat.
  try {
    await call('POST', '/api/shops', { name: '', channel: 'SHOPEE' });
  } catch { /* memang diharapkan gagal */ }
  const riwayat3 = await call('GET', `/api/riwayat?from=${today}&to=${today}&hanyaGagal=1&limit=500`);
  check('permintaan yang ditolak ikut tercatat',
    riwayat3.rows.length > 0 && riwayat3.rows.every((r) => !r.berhasil),
    `${riwayat3.rows.length} baris`);

  // --- Tutup buku ---
  const periodeAwal = await call('GET', '/api/riwayat/periode');
  check('bulan berjurnal terdaftar', periodeAwal.rows.length > 0);
  check('bulan berjalan ditandai sebagai sedang berjalan',
    periodeAwal.rows.some((p) => p.berjalan === true));

  let tolakTutupBerjalan = 0;
  try {
    await call('POST', '/api/riwayat/periode/kunci', { period: today.slice(0, 7) });
  } catch (err) {
    tolakTutupBerjalan = err.status;
  }
  check('bulan yang sedang berjalan tidak bisa ditutup',
    tolakTutupBerjalan === 422, `status ${tolakTutupBerjalan}`);

  // Tutup bulan lama, lalu pastikan pintu ke buku besar benar-benar terkunci.
  const bulanLama = `${Number(today.slice(0, 4)) - 3}-06`;
  const tutup = await call('POST', '/api/riwayat/periode/kunci', {
    period: bulanLama, note: 'Uji tutup buku',
  });
  check('bulan lama bisa ditutup', tutup.ok);

  const coa = await call('GET', '/api/finance/accounts');
  const akunKas = coa.accounts.find((a) => a.code === '1000');
  const akunModal = coa.accounts.find((a) => a.code === '3000');
  const barisUji = (nominal) => [
    { account_id: akunKas.id, debit: nominal, credit: 0 },
    { account_id: akunModal.id, debit: 0, credit: nominal },
  ];

  let tolakJurnal = 0;
  try {
    await call('POST', '/api/finance/journals', {
      entry_date: `${bulanLama}-15`,
      description: 'Uji jurnal pada bulan tertutup',
      lines: barisUji(50000),
    });
  } catch (err) {
    tolakJurnal = err.status;
  }
  check('jurnal pada bulan yang sudah ditutup ditolak',
    tolakJurnal === 409, `status ${tolakJurnal}`);

  // Penjagaannya harus berlaku untuk SEMUA modul, bukan cuma jurnal manual.
  let tolakKas = 0;
  try {
    await call('POST', '/api/cashflow/entries', {
      entry_date: `${bulanLama}-20`, direction: 'OUT', amount: 25000,
      category_code: '6190', cash_code: '1000',
      description: 'Uji kas pada bulan tertutup',
    });
  } catch (err) {
    tolakKas = err.status;
  }
  check('kas keluar pada bulan yang sudah ditutup juga ditolak',
    tolakKas === 409, `status ${tolakKas}`);

  let tolakOrder = 0;
  try {
    await call('POST', '/api/sales', {
      order_date: `${bulanLama}-10`, channel: 'SHOPEE',
      items: [{ product_id: produkCair.product.id, qty: 1, price: 25000 }],
    });
  } catch (err) {
    tolakOrder = err.status;
  }
  check('order penjualan pada bulan yang sudah ditutup juga ditolak',
    tolakOrder === 409, `status ${tolakOrder}`);

  // Bulan lain tidak boleh ikut terkunci.
  const jurnalBulanLain = await call('POST', '/api/finance/journals', {
    entry_date: today,
    description: 'Uji jurnal bulan terbuka',
    lines: barisUji(1000),
  });
  check('bulan lain tetap bisa menerima jurnal', !!jurnalBulanLain.journal || jurnalBulanLain.ok);

  const periodeKunci = await call('GET', '/api/riwayat/periode');
  // Bulan bisa ditutup sebelum ada jurnalnya; ia tetap harus muncul di daftar,
  // kalau tidak ia terkunci tanpa ada cara membukanya kembali lewat layar.
  check('bulan tertutup muncul di daftar walau belum punya jurnal, beserta pelakunya',
    periodeKunci.rows.some((p) => p.period === bulanLama && p.terkunci && p.oleh),
    JSON.stringify(periodeKunci.rows.find((p) => p.period === bulanLama)));

  const bukaLagi = await call('DELETE', `/api/riwayat/periode/${bulanLama}`);
  check('tutup buku bisa dibuka kembali', bukaLagi.ok);

  const setelahBuka = await call('POST', '/api/finance/journals', {
    entry_date: `${bulanLama}-15`,
    description: 'Uji jurnal setelah buku dibuka',
    lines: barisUji(50000),
  });
  check('setelah dibuka, jurnalnya bisa masuk lagi', !!setelahBuka.journal || setelahBuka.ok);

  // Membuka buku adalah tindakan yang harus meninggalkan jejak.
  const riwayat4 = await call('GET', `/api/riwayat?from=${today}&to=${today}&limit=500`);
  check('penutupan dan pembukaan buku ikut tercatat di riwayat',
    riwayat4.rows.some((r) => r.path.includes('/api/riwayat/periode') && r.method === 'POST') &&
    riwayat4.rows.some((r) => r.path.includes('/api/riwayat/periode') && r.method === 'DELETE'));

  for (const bentuk of ['excel', 'csv', 'pdf']) {
    const res = await fetch(`${BASE}/api/riwayat/export/${bentuk}?from=${today}&to=${today}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const buf = Buffer.from(await res.arrayBuffer());
    check(`riwayat bisa diunduh sebagai ${bentuk.toUpperCase()}`,
      res.ok && buf.length > 200, `${res.status}, ${buf.length} byte`);
  }

  // ---------- Pencarian order ----------
  console.log('\n26. Pencarian di menu Penjualan');

  const tokoCari = await call('POST', '/api/shops', {
    name: `Toko Cari ${Date.now()}`, channel: 'SHOPEE',
  });
  const idTokoCari = (tokoCari.shop || tokoCari).id;
  const resiUji = `JX${Date.now()}`;
  const refUji = `INV-CARI-${Date.now()}`;

  const orderCari = await call('POST', '/api/sales', {
    order_date: today, shop_id: idTokoCari, channel: 'SHOPEE',
    items: [{ product_id: produkCair.product.id, qty: 1, price: 25000 }],
    order_ref: refUji, tracking_no: resiUji, courier: 'JNE',
    buyer_name: 'Sitti Rahmawati Uji',
  });

  const cariLewat = async (kata) =>
    call('GET', `/api/sales?from=${today}&to=${today}&q=${encodeURIComponent(kata)}`);

  for (const [label, kata] of [
    ['nomor order', orderCari.order.order_no],
    ['nomor pesanan marketplace', refUji],
    ['nomor resi', resiUji],
    ['nama pembeli', 'Sitti Rahmawati'],
  ]) {
    const h = await cariLewat(kata);
    check(`order ketemu lewat ${label}`,
      h.rows.some((o) => o.id === orderCari.order.id), `${h.rows.length} hasil`);
  }

  // Pencarian sebagian kata harus tetap menemukan — orang mengetik separuh resi.
  const separuh = await cariLewat(resiUji.slice(2, 10));
  check('pencarian separuh nomor resi tetap menemukan',
    separuh.rows.some((o) => o.id === orderCari.order.id));

  const takAda = await cariLewat('zzz-tidak-ada-zzz');
  check('kata yang tidak cocok menghasilkan daftar kosong', takAda.rows.length === 0);

  // Ringkasan harus ikut menyempit; kalau tidak, angka di atas layar bertentangan
  // dengan daftar di bawahnya.
  const hasilCari = await cariLewat(refUji);
  check('ringkasan ikut menyempit mengikuti pencarian',
    hasilCari.summary.orders === hasilCari.rows.length && hasilCari.summary.orders === 1,
    `ringkas ${hasilCari.summary.orders} vs baris ${hasilCari.rows.length}`);

  // Pencarian tidak boleh mengabaikan penyaring lain yang sedang aktif.
  const dgnChannel = await call('GET',
    `/api/sales?from=${today}&to=${today}&q=${encodeURIComponent(refUji)}&channel=TIKTOK_SHOP`);
  check('pencarian tetap tunduk pada penyaring channel', dgnChannel.rows.length === 0);

  const satuHuruf = await cariLewat('a');
  const tanpaCari = await call('GET', `/api/sales?from=${today}&to=${today}`);
  check('kata terlalu pendek diabaikan, bukan menyaring asal',
    satuHuruf.rows.length === tanpaCari.rows.length,
    `${satuHuruf.rows.length} vs ${tanpaCari.rows.length}`);

  // Karakter khusus LIKE tidak boleh berlaku sebagai wildcard. Dipakai dua
  // karakter, bukan satu, supaya tidak keburu tersaring oleh batas kata minimum
  // dan lolos tanpa benar-benar menguji apa pun. Bila '%' tidak di-escape,
  // polanya menjadi cocok untuk semua baris.
  const persen = await cariLewat('%%');
  check('tanda % dicari apa adanya, bukan sebagai wildcard',
    persen.rows.length === 0, `${persen.rows.length} hasil`);

  const garisBawah = await cariLewat('__');
  check('tanda _ juga tidak berlaku sebagai wildcard',
    garisBawah.rows.length === 0, `${garisBawah.rows.length} hasil`);

  const papanCari = await call('GET',
    `/api/sales/papan?from=${today}&to=${today}&q=${encodeURIComponent(resiUji)}`);
  const semuaTahap = Object.values(papanCari.tahap || {}).flat();
  check('papan pengiriman ikut bisa dicari',
    semuaTahap.some((o) => o.id === orderCari.order.id) ||
    JSON.stringify(papanCari).includes(resiUji),
    `${semuaTahap.length} baris`);

  // Berkas unduhan harus berisi persis apa yang sedang dicari, bukan seluruhnya.
  const unduhCari = await fetch(
    `${BASE}/api/sales/export/csv?from=${today}&to=${today}&q=${encodeURIComponent(refUji)}`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  const isiUnduh = Buffer.from(await unduhCari.arrayBuffer()).toString('utf8');
  const barisUnduh = isiUnduh.trim().split('\r\n').length - 1;
  check('unduhan mengikuti pencarian yang sedang aktif',
    unduhCari.ok && barisUnduh === 1 && isiUnduh.includes(refUji),
    `${barisUnduh} baris`);

  // ---------- Ringkasan iklan pada Order Penjualan ----------
  console.log('\n27. Biaya iklan pada ringkasan penjualan');

  const bulanIni = `${today.slice(0, 8)}01`;
  const sblmIklan = await call('GET', `/api/sales?from=${bulanIni}&to=${today}&limit=1`);
  check('ringkasan penjualan membawa angka iklan',
    sblmIklan.iklan && typeof sblmIklan.summary.iklan === 'number');

  await call('POST', '/api/iklan', {
    spend_date: today, shop_id: idTokoCari, channel: 'SHOPEE',
    amount: 400000, payment: 'BANK', note: 'Uji kartu iklan',
  });

  const sslhIklan = await call('GET', `/api/sales?from=${bulanIni}&to=${today}&limit=1`);
  check('belanja iklan ikut terhitung di ringkasan',
    near(sslhIklan.summary.iklan, sblmIklan.summary.iklan + 400000, 1),
    `${sblmIklan.summary.iklan} lalu ${sslhIklan.summary.iklan}`);
  check('laba setelah iklan = laba bersih dikurangi iklan',
    near(sslhIklan.summary.labaSetelahIklan, sslhIklan.summary.netProfit - sslhIklan.summary.iklan, 1),
    `${sslhIklan.summary.labaSetelahIklan}`);
  check('ROAS = pendapatan kotor dibagi belanja iklan',
    sslhIklan.summary.roas === null ||
    near(sslhIklan.summary.roas, sslhIklan.summary.netRevenue / sslhIklan.summary.iklan, 0.02),
    `${sslhIklan.summary.roas}`);

  // Penyaring toko punya padanan di catatan iklan, jadi ikut menyempit.
  const perToko = await call('GET',
    `/api/sales?from=${bulanIni}&to=${today}&shop_id=${idTokoCari}&limit=1`);
  check('penyaring toko ikut menyempitkan belanja iklan',
    perToko.iklan.berlaku && near(perToko.summary.iklan, 400000, 1),
    `${perToko.summary.iklan}`);

  // Inti kehati-hatiannya: pencarian tidak punya padanan pada catatan iklan.
  // Menampilkan belanja sebulan penuh di sebelah satu order akan membuat
  // "laba setelah iklan" jadi angka minus yang sepenuhnya karangan.
  const dgnCari = await call('GET',
    `/api/sales?from=${bulanIni}&to=${today}&q=${encodeURIComponent(refUji)}&limit=1`);
  check('saat pencarian aktif, angka iklan dinyatakan tidak berlaku',
    dgnCari.iklan.berlaku === false && dgnCari.summary.labaSetelahIklan === null,
    JSON.stringify(dgnCari.iklan));
  check('alasannya disebutkan, bukan sekadar dikosongkan',
    typeof dgnCari.iklan.alasan === 'string' && dgnCari.iklan.alasan.length > 0,
    dgnCari.iklan.alasan);

  const dgnStatus = await call('GET',
    `/api/sales?from=${bulanIni}&to=${today}&fulfillment_status=DIPROSES&limit=1`);
  check('penyaring status pesanan juga menonaktifkan angka iklan',
    dgnStatus.iklan.berlaku === false);

  // ---------- Ubah detail pesanan ----------
  console.log('\n28. Ubah isi pesanan dari layar');

  const stokAwalUbah = (await call('GET', `/api/inventory/products?limit=2000`))
    .products.find((p) => p.id === produkCair.product.id).stock;

  const orderUbah = await call('POST', '/api/sales', {
    order_date: today, shop_id: idTokoCari, channel: 'SHOPEE',
    items: [{ product_id: produkCair.product.id, qty: 2, price: 25000 }],
    buyer_name: 'Pembeli Awal',
  });
  const stokSetelahBuat = (await call('GET', `/api/inventory/products?limit=2000`))
    .products.find((p) => p.id === produkCair.product.id).stock;
  check('membuat order memotong stok', near(stokSetelahBuat, stokAwalUbah - 2, 0.001),
    `${stokAwalUbah} lalu ${stokSetelahBuat}`);

  // Detail order harus membawa barisnya — layar mengambilnya dari sini saat
  // formulir ubah dibuka.
  const detailUbah = await call('GET', `/api/sales/${orderUbah.order.id}`);
  check('detail order membawa baris barangnya',
    Array.isArray(detailUbah.items) && detailUbah.items.length === 1
      && detailUbah.items[0].qty === 2);

  // Ubah data pembeli saja: stok tidak boleh ikut bergerak.
  await call('PUT', `/api/sales/${orderUbah.order.id}`, {
    buyer_name: 'Pembeli Diperbaiki', buyer_phone: '08123456789',
  });
  const stokSetelahPembeli = (await call('GET', `/api/inventory/products?limit=2000`))
    .products.find((p) => p.id === produkCair.product.id).stock;
  check('mengubah data pembeli tidak menyentuh stok',
    near(stokSetelahPembeli, stokSetelahBuat, 0.001));
  const cekPembeli = await call('GET', `/api/sales/${orderUbah.order.id}`);
  check('data pembeli tersimpan', cekPembeli.order.buyer_name === 'Pembeli Diperbaiki');

  // Ubah isi pesanan: stok harus menyesuaikan selisihnya, bukan dipotong ulang.
  await call('PUT', `/api/sales/${orderUbah.order.id}`, {
    items: [{ product_id: produkCair.product.id, qty: 5, price: 30000 }],
  });
  const stokSetelahItem = (await call('GET', `/api/inventory/products?limit=2000`))
    .products.find((p) => p.id === produkCair.product.id).stock;
  check('menaikkan qty memotong stok sebesar selisihnya saja',
    near(stokSetelahItem, stokSetelahBuat - 3, 0.001),
    `${stokSetelahBuat} lalu ${stokSetelahItem}`);

  const sesudahItem = await call('GET', `/api/sales/${orderUbah.order.id}`);
  check('baris pesanan tersimpan sesuai yang dikirim',
    sesudahItem.items.length === 1 && sesudahItem.items[0].qty === 5
      && near(sesudahItem.items[0].price, 30000, 1));
  check('nilai order dihitung ulang mengikuti barisnya',
    near(sesudahItem.order.gross_sales, 150000, 1), `${sesudahItem.order.gross_sales}`);

  // Jurnalnya harus ikut ditulis ulang, bukan menyisakan yang lama.
  const jurnalUbah = await call('GET',
    `/api/finance/reports/trial-balance?from=${bulanIni}&to=${today}`);
  check('pembukuan tetap seimbang setelah isi pesanan diubah',
    near(jurnalUbah.totalDebit, jurnalUbah.totalCredit, 1));

  // Menambah baris kedua pada order yang sama. Barang keduanya diberi stok
  // lebih dulu — produk dari uji nota tadi memang belum pernah diterima.
  await call('POST', '/api/inventory/moves', {
    product_id: produkNota.product.id, move_date: today, move_type: 'IN',
    qty: 10, unit_cost: 12000, note: 'Stok untuk uji ubah pesanan',
  });
  await call('PUT', `/api/sales/${orderUbah.order.id}`, {
    items: [
      { product_id: produkCair.product.id, qty: 2, price: 30000 },
      { product_id: produkNota.product.id, qty: 1, price: 20000 },
    ],
  });
  const duaBarisUbah = await call('GET', `/api/sales/${orderUbah.order.id}`);
  check('barang bisa ditambahkan ke pesanan yang sudah ada',
    duaBarisUbah.items.length === 2 && near(duaBarisUbah.order.gross_sales, 80000, 1),
    `${duaBarisUbah.items.length} baris, ${duaBarisUbah.order.gross_sales}`);

  const stokKembali = (await call('GET', `/api/inventory/products?limit=2000`))
    .products.find((p) => p.id === produkCair.product.id).stock;
  check('menurunkan qty mengembalikan stoknya',
    near(stokKembali, stokSetelahBuat, 0.001), `${stokKembali} vs ${stokSetelahBuat}`);

  // Stok tetap dijaga saat diubah, bukan hanya saat dibuat.
  let tolakStokUbah = 0;
  try {
    await call('PUT', `/api/sales/${orderUbah.order.id}`, {
      items: [{ product_id: produkCair.product.id, qty: 999999, price: 30000 }],
    });
  } catch (err) {
    tolakStokUbah = err.status;
  }
  check('mengubah pesanan melebihi stok tetap ditolak',
    tolakStokUbah === 422, `status ${tolakStokUbah}`);

  // ---------- Label varian produk non-label ----------
  console.log('\n29. Label varian produk yang dijual tanpa label');

  const produkVarian = await call('POST', '/api/inventory/products', {
    sku: `NLBL-${Date.now()}`, name: 'Booster Uji Non Label', category: 'Uji', unit: 'PCS',
    cost: 10000, price: 25000, needs_variant: true,
  });
  check('produk bisa ditandai dijual tanpa label',
    produkVarian.product.needs_variant === 1 || produkVarian.product.needs_variant === true,
    String(produkVarian.product.needs_variant));

  await call('POST', '/api/inventory/moves', {
    product_id: produkVarian.product.id, move_date: today, move_type: 'IN',
    qty: 100, unit_cost: 10000, note: 'Stok uji varian',
  });
  const stokSblmVarian = (await call('GET', '/api/inventory/products?limit=2000'))
    .products.find((p) => p.id === produkVarian.product.id).stock;

  // Tanpa label sama sekali harus ditolak — itu inti penandanya.
  let tolakTanpaLabel = 0;
  try {
    await call('POST', '/api/sales', {
      order_date: today, channel: 'OFFLINE_WA',
      items: [{ product_id: produkVarian.product.id, qty: 15, price: 25000 }],
    });
  } catch (err) {
    tolakTanpaLabel = err.status;
  }
  check('produk tanpa label ditolak bila label variannya kosong',
    tolakTanpaLabel === 422, `status ${tolakTanpaLabel}`);

  // Jumlah label yang tidak sama dengan jumlah pesanan juga ditolak: lembar
  // pengiriman tidak boleh menyebut jumlah berbeda dari yang dipotong stok.
  let tolakJumlah = 0;
  try {
    await call('POST', '/api/sales', {
      order_date: today, channel: 'OFFLINE_WA',
      items: [{
        product_id: produkVarian.product.id, qty: 15, price: 25000,
        variants: [{ label: 'Tani Makmur', qty: 10 }],
      }],
    });
  } catch (err) {
    tolakJumlah = err.status;
  }
  check('jumlah label yang tidak sama dengan jumlah pesanan ditolak',
    tolakJumlah === 422, `status ${tolakJumlah}`);

  const orderVarian = await call('POST', '/api/sales', {
    order_date: today, channel: 'OFFLINE_WA',
    items: [{
      product_id: produkVarian.product.id, qty: 15, price: 25000,
      variants: [
        { label: 'Tani Makmur', qty: 10 },
        { label: 'Subur Jaya', qty: 5 },
      ],
    }],
  });
  check('pesanan dengan beberapa label tersimpan', !!orderVarian.order);

  const detVarian = await call('GET', `/api/sales/${orderVarian.order.id}`);
  const barisVarian = detVarian.items[0].variants || [];
  check('label varian tersimpan lengkap beserta jumlahnya',
    barisVarian.length === 2 &&
    barisVarian.some((v) => v.label === 'Tani Makmur' && v.qty === 10) &&
    barisVarian.some((v) => v.label === 'Subur Jaya' && v.qty === 5),
    JSON.stringify(barisVarian));

  // Inti permintaannya: stok berkurang dari produk induk, bukan dari produk
  // baru per label. Kalau tiap label jadi SKU sendiri, stok dan HPP barang yang
  // sebenarnya sama akan terpecah.
  const stokSslhVarian = (await call('GET', '/api/inventory/products?limit=2000'))
    .products.find((p) => p.id === produkVarian.product.id).stock;
  check('stok berkurang dari produk induk sebesar seluruh pesanan',
    near(stokSslhVarian, stokSblmVarian - 15, 0.001),
    `${stokSblmVarian} lalu ${stokSslhVarian}`);

  const produkSetelah = await call('GET', '/api/inventory/products?limit=2000');
  check('tidak ada produk baru dibuat untuk tiap label',
    produkSetelah.products.filter((p) => /Tani Makmur|Subur Jaya/.test(p.name)).length === 0);

  // Label bisa diubah lewat modal ubah, dan jumlahnya tetap dijaga.
  await call('PUT', `/api/sales/${orderVarian.order.id}`, {
    items: [{
      product_id: produkVarian.product.id, qty: 15, price: 25000,
      variants: [
        { label: 'Tani Makmur', qty: 12 },
        { label: 'Subur Jaya', qty: 3 },
      ],
    }],
  });
  const setelahUbahVarian = await call('GET', `/api/sales/${orderVarian.order.id}`);
  const varianBaru = setelahUbahVarian.items[0].variants || [];
  check('label varian bisa diubah lewat ubah order',
    varianBaru.length === 2 && varianBaru.some((v) => v.label === 'Tani Makmur' && v.qty === 12),
    JSON.stringify(varianBaru));
  check('mengubah label saja tidak menggeser stok',
    near((await call('GET', '/api/inventory/products?limit=2000'))
      .products.find((p) => p.id === produkVarian.product.id).stock, stokSslhVarian, 0.001));

  let tolakUbahJumlah = 0;
  try {
    await call('PUT', `/api/sales/${orderVarian.order.id}`, {
      items: [{
        product_id: produkVarian.product.id, qty: 15, price: 25000,
        variants: [{ label: 'Tani Makmur', qty: 99 }],
      }],
    });
  } catch (err) {
    tolakUbahJumlah = err.status;
  }
  check('aturan jumlah label tetap berlaku saat mengubah pesanan',
    tolakUbahJumlah === 422, `status ${tolakUbahJumlah}`);

  // Produk biasa tidak boleh ikut menuntut label.
  const orderBiasa = await call('POST', '/api/sales', {
    order_date: today, channel: 'OFFLINE_WA',
    items: [{ product_id: produkCair.product.id, qty: 1, price: 25000 }],
  });
  check('produk biasa tetap bisa dipesan tanpa label varian', !!orderBiasa.order);

  // ---------- Menu Laporan ----------
  console.log('\n30. Menu Laporan');

  const JENIS_LAPORAN = ['presensi', 'persediaan', 'pembelian', 'penjualan', 'keuangan', 'mitra'];
  const bulanLap = `${today.slice(0, 8)}01`;

  const daftarLap = await call('GET', '/api/laporan');
  check('keenam laporan terdaftar untuk admin',
    JENIS_LAPORAN.every((j) => daftarLap.rows.some((r) => r.jenis === j)),
    daftarLap.rows.map((r) => r.jenis).join(', '));

  for (const jenis of JENIS_LAPORAN) {
    const d = await call('GET', `/api/laporan/${jenis}?from=${bulanLap}&to=${today}&asOf=${today}`);
    check(`laporan ${jenis} bisa dibuka dan berkolom`,
      Array.isArray(d.rows) && Array.isArray(d.kolom) && d.kolom.length > 0 && !!d.judul,
      `${d.rows ? d.rows.length : '?'} baris`);
  }

  // Neraca saldo harus seimbang; kalau tidak, laporannya sendiri yang salah.
  const lapKeu = await call('GET', `/api/laporan/keuangan?from=${bulanLap}&to=${today}`);
  check('laporan keuangan seimbang antara debit dan kredit',
    near(lapKeu.ringkasBawah.debit, lapKeu.ringkasBawah.credit, 1),
    `${lapKeu.ringkasBawah.debit} vs ${lapKeu.ringkasBawah.credit}`);

  // Angkanya wajib sama dengan menunya, bukan hitungan baru yang berdiri sendiri.
  const lapJual = await call('GET', `/api/laporan/penjualan?from=${bulanLap}&to=${today}`);
  const menuJual = await call('GET', `/api/sales?from=${bulanLap}&to=${today}&limit=5000`);
  check('laporan penjualan sama dengan menu Order Penjualan',
    lapJual.rows.length === menuJual.summary.orders &&
    near(lapJual.ringkasBawah.net_revenue, menuJual.summary.netRevenue, 1),
    `${lapJual.rows.length} vs ${menuJual.summary.orders} order`);

  const lapPersed = await call('GET', `/api/laporan/persediaan?asOf=${today}`);
  const valuasi = await call('GET', '/api/inventory/valuation');
  check('laporan persediaan sama dengan Valuasi Stok',
    near(lapPersed.ringkasBawah.nilai, valuasi.totalValue, 1),
    `${lapPersed.ringkasBawah.nilai} vs ${valuasi.totalValue}`);

  // PDF: berkop, bertanda tangan, dan dikirim inline agar bisa langsung dicetak.
  const pdfLap = await fetch(
    `${BASE}/api/laporan/penjualan/export/pdf?from=${bulanLap}&to=${today}`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  const bufLap = Buffer.from(await pdfLap.arrayBuffer());
  check('laporan bisa dicetak sebagai PDF',
    pdfLap.ok && bufLap.slice(0, 4).toString() === '%PDF' && bufLap.length > 1000,
    `${pdfLap.status}, ${bufLap.length} byte`);
  check('PDF laporan dikirim untuk langsung dibuka & dicetak',
    (pdfLap.headers.get('Content-Disposition') || '').startsWith('inline'));

  const dokSetelah = await call('GET', '/api/dokumen');
  const dokLap = dokSetelah.rows.find((r) => r.kind === 'LAPORAN');
  check('laporan yang dicetak ikut tercatat bertanda tangan digital',
    !!dokLap && /^LAP\//.test(dokLap.nomor) && !!dokLap.kode,
    dokLap && dokLap.nomor);

  const periksaLap = await fetch(`${BASE}/api/verifikasi/${dokLap.tautan.split('/').pop()}`)
    .then((r) => r.json());
  check('QR laporan bisa diperiksa tanpa login',
    periksaLap.status === 'sah' && periksaLap.jenis === 'Laporan Resmi',
    `${periksaLap.status}`);

  // Ukuran kertas bisa dipilih; Folio menghasilkan berkas yang berbeda dari A4.
  const pdfA4 = await fetch(
    `${BASE}/api/laporan/mitra/export/pdf?from=${bulanLap}&to=${today}&kertas=A4`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  const pdfFolio = await fetch(
    `${BASE}/api/laporan/mitra/export/pdf?from=${bulanLap}&to=${today}&kertas=FOLIO`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  check('ukuran kertas A4 dan Folio sama-sama bisa dicetak',
    pdfA4.ok && pdfFolio.ok);

  for (const bentuk of ['excel', 'csv']) {
    const res = await fetch(
      `${BASE}/api/laporan/pembelian/export/${bentuk}?from=${bulanLap}&to=${today}`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    const buf = Buffer.from(await res.arrayBuffer());
    check(`laporan bisa diunduh sebagai ${bentuk.toUpperCase()}`,
      res.ok && buf.length > 200, `${res.status}, ${buf.length} byte`);
  }

  // Hak akses: tim gudang hanya boleh laporan yang modulnya memang ia pegang.
  const adminLap = token;
  token = await masukSebagai(akunGudang.user.email, 'RahasiaKuat1');

  const daftarGudang = await call('GET', '/api/laporan');
  check('daftar laporan disaring menurut hak akses',
    daftarGudang.rows.some((r) => r.jenis === 'persediaan') &&
    !daftarGudang.rows.some((r) => r.jenis === 'keuangan' || r.jenis === 'penjualan'),
    daftarGudang.rows.map((r) => r.jenis).join(', '));

  const tolakLap = await fetch(`${BASE}/api/laporan/keuangan?from=${bulanLap}&to=${today}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  check('laporan di luar hak aksesnya ditolak', tolakLap.status === 403, `status ${tolakLap.status}`);

  const tolakUnduh = await fetch(
    `${BASE}/api/laporan/penjualan/export/pdf?from=${bulanLap}&to=${today}`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  check('unduhan laporan di luar hak akses juga ditolak',
    tolakUnduh.status === 403, `status ${tolakUnduh.status}`);
  token = adminLap;

  // ---------- Katalog varian produk ----------
  console.log('\n31. Katalog varian produk');

  const idVar = produkVarian.product.id;

  const kosongVar = await call('GET', `/api/inventory/products/${idVar}/variants`);
  check('katalog varian produk baru masih kosong', kosongVar.rows.length === 0);

  const v1 = await call('POST', `/api/inventory/products/${idVar}/variants`, { nama: 'Uji- Mangga' });
  const v2 = await call('POST', `/api/inventory/products/${idVar}/variants`, { nama: 'Uji- Durian' });
  check('varian bisa ditambahkan ke katalog', !!v1.variant && !!v2.variant);

  let tolakKembar = 0;
  try {
    await call('POST', `/api/inventory/products/${idVar}/variants`, { nama: 'Uji- Mangga' });
  } catch (err) {
    tolakKembar = err.status;
  }
  check('varian bernama sama pada satu produk ditolak', tolakKembar === 409, `status ${tolakKembar}`);

  // Varian TIDAK boleh menjadi produk: stok, HPP, dan riwayatnya tetap milik induk.
  const produkCek = await call('GET', '/api/inventory/products?limit=2000');
  check('varian tidak ikut menjadi produk baru',
    produkCek.products.filter((p) => /Uji- Mangga|Uji- Durian/.test(p.name)).length === 0);

  const stokSblmKat = produkCek.products.find((p) => p.id === idVar).stock;

  // Memesan dengan varian dari katalog.
  const orderKat = await call('POST', '/api/sales', {
    order_date: today, channel: 'OFFLINE_WA',
    items: [{
      product_id: idVar, qty: 9, price: 25000,
      variants: [
        { variant_id: v1.variant.id, label: 'Tani Makmur', qty: 5 },
        { variant_id: v2.variant.id, label: null, qty: 4 },
      ],
    }],
  });
  const detKat = await call('GET', `/api/sales/${orderKat.order.id}`);
  const varKat = detKat.items[0].variants;
  check('varian dari katalog tersimpan beserta salinan namanya',
    varKat.length === 2 &&
    varKat.some((v) => v.variant_id === v1.variant.id && v.variant_nama === 'Uji- Mangga' && v.label === 'Tani Makmur') &&
    varKat.some((v) => v.variant_id === v2.variant.id && v.variant_nama === 'Uji- Durian'),
    JSON.stringify(varKat));
  check('label boleh dikosongkan bila hanya variannya yang dipilih',
    varKat.some((v) => !v.label));
  check('katalog varian ikut dikirim bersama detail pesanan',
    !!detKat.katalogVarian && Array.isArray(detKat.katalogVarian[idVar]));

  const stokSslhKat = (await call('GET', '/api/inventory/products?limit=2000'))
    .products.find((p) => p.id === idVar).stock;
  check('stok tetap berkurang dari produk induk',
    near(stokSslhKat, stokSblmKat - 9, 0.001), `${stokSblmKat} lalu ${stokSslhKat}`);

  // Varian milik produk lain tidak boleh menempel di sini.
  const produkLain = await call('POST', '/api/inventory/products', {
    sku: `NLBL2-${Date.now()}`, name: 'Non Label Kedua', category: 'Uji', unit: 'PCS',
    cost: 5000, price: 9000, needs_variant: true,
  });
  const vLain = await call('POST', `/api/inventory/products/${produkLain.product.id}/variants`, {
    nama: 'Punya Produk Lain',
  });
  let tolakSalahInduk = 0;
  try {
    await call('POST', '/api/sales', {
      order_date: today, channel: 'OFFLINE_WA',
      items: [{
        product_id: idVar, qty: 1, price: 25000,
        variants: [{ variant_id: vLain.variant.id, qty: 1 }],
      }],
    });
  } catch (err) {
    tolakSalahInduk = err.status;
  }
  check('varian milik produk lain ditolak', tolakSalahInduk === 422, `status ${tolakSalahInduk}`);

  // Varian yang sudah dipakai tidak boleh hilang dari riwayat pesanan.
  const hapusTerpakai = await call('DELETE', `/api/inventory/variants/${v1.variant.id}`);
  check('varian yang sudah dipakai dinonaktifkan, bukan dihapus',
    /dinonaktifkan/.test(hapusTerpakai.message), hapusTerpakai.message);

  const masihAda = await call('GET', `/api/sales/${orderKat.order.id}`);
  check('pesanan lama tetap menyebut nama varian yang dikirim',
    masihAda.items[0].variants.some((v) => v.variant_nama === 'Uji- Mangga'));

  const hapusBelum = await call('DELETE', `/api/inventory/variants/${vLain.variant.id}`);
  check('varian yang belum pernah dipakai boleh dihapus',
    /dihapus/.test(hapusBelum.message), hapusBelum.message);

  // Produk yang belum punya katalog tetap bisa dipesan dengan label manual —
  // katalog kosong tidak boleh mengunci pekerjaan.
  const produkTanpaKatalog = await call('POST', '/api/inventory/products', {
    sku: `NLBL3-${Date.now()}`, name: 'Non Label Tanpa Katalog', category: 'Uji', unit: 'PCS',
    cost: 5000, price: 9000, needs_variant: true,
  });
  await call('POST', '/api/inventory/moves', {
    product_id: produkTanpaKatalog.product.id, move_date: today, move_type: 'IN',
    qty: 5, unit_cost: 5000, note: 'Stok uji katalog kosong',
  });
  const orderManual = await call('POST', '/api/sales', {
    order_date: today, channel: 'OFFLINE_WA',
    items: [{
      product_id: produkTanpaKatalog.product.id, qty: 2, price: 9000,
      variants: [{ label: 'Label Manual Saja', qty: 2 }],
    }],
  });
  check('produk tanpa katalog tetap bisa dipesan dengan label manual',
    !!orderManual.order);

  // ---------- Struktur biaya order ----------
  console.log('\n32. Struktur biaya order');

  // Biaya Platform kini diisi sebagai rupiah, bukan persen. Nilai yang dikirim
  // langsung harus dipakai apa adanya — bukan dihitung ulang dari tarif.
  const orderBiaya = await call('POST', '/api/sales', {
    order_date: today, channel: 'SHOPEE', shop_id: idTokoCari,
    items: [{ product_id: produkCair.product.id, qty: 4, price: 25000 }],
    discount: 5000,
    voucher_platform: 3000,
    admin_fee: 12500,
    shipping_extra: 7000,
    handling_fee: 2500,
    tax_pct: 1,
    packing_cost: 1500,
    other_cost: 1000,
  });
  const detBiaya = await call('GET', `/api/sales/${orderBiaya.order.id}`);
  const ob = detBiaya.order;

  check('Biaya Platform tersimpan sebagai nominal, bukan persentase',
    near(ob.admin_fee, 12500, 1), `${ob.admin_fee}`);
  check('Voucher & Subsidi tersimpan', near(ob.voucher_platform, 3000, 1));
  check('Biaya Gratis Ongkir XTRA tersimpan', near(ob.shipping_extra, 7000, 1));
  check('Biaya Layanan tersimpan', near(ob.handling_fee, 2500, 1));

  // Pajak tetap persentase, dihitung dari pendapatan bersih.
  const netHarap = 4 * 25000 - 5000;
  check('pendapatan bersih = penjualan dikurangi diskon',
    near(ob.net_revenue, netHarap, 1), `${ob.net_revenue} vs ${netHarap}`);
  check('pajak dihitung dari persentase terhadap pendapatan bersih',
    near(ob.tax_amount, netHarap * 0.01, 1), `${ob.tax_amount}`);

  const feeHarap = 12500 + 3000 + 7000 + 2500 + 1500 + 1000 + netHarap * 0.01;
  check('total biaya = jumlah seluruh potongan',
    near(ob.total_fees, feeHarap, 1), `${ob.total_fees} vs ${feeHarap}`);
  check('laba bersih = pendapatan bersih − HPP − total biaya',
    near(ob.net_profit, ob.net_revenue - ob.cogs - ob.total_fees, 1));

  // Berkas unduhan memakai istilah yang sama dengan layarnya.
  const csvBiaya = await fetch(
    `${BASE}/api/sales/export/csv?from=${today}&to=${today}`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  const kepalaCsv = Buffer.from(await csvBiaya.arrayBuffer()).toString('utf8').split('\r\n')[0];
  check('kolom unduhan memakai istilah yang sama dengan formulir',
    ['Voucher & Subsidi', 'Biaya Platform', 'Biaya Gratis Ongkir XTRA', 'Biaya Layanan']
      .every((k) => kepalaCsv.includes(k)),
    kepalaCsv.slice(0, 120));

  // ---------- Ganti produk pada pesanan yang sudah tersimpan ----------
  console.log('\n33. Ganti produk pada pesanan tersimpan');

  const pA = await call('POST', '/api/inventory/products', {
    sku: `SALAH-${Date.now()}`, name: 'Produk Salah Input', category: 'Uji', unit: 'PCS',
    cost: 8000, price: 20000,
  });
  const pB = await call('POST', '/api/inventory/products', {
    sku: `BENAR-${Date.now()}`, name: 'Produk Yang Benar', category: 'Uji', unit: 'PCS',
    cost: 11000, price: 26000,
  });
  for (const p of [pA, pB]) {
    await call('POST', '/api/inventory/moves', {
      product_id: p.product.id, move_date: today, move_type: 'IN',
      qty: 50, unit_cost: p.product.cost, note: 'Stok uji ganti produk',
    });
  }
  const stokA0 = (await call('GET', '/api/inventory/products?limit=2000'))
    .products.find((p) => p.id === pA.product.id).stock;
  const stokB0 = (await call('GET', '/api/inventory/products?limit=2000'))
    .products.find((p) => p.id === pB.product.id).stock;

  // Salah input: produk A, padahal seharusnya produk B.
  const orderSalah = await call('POST', '/api/sales', {
    order_date: today, channel: 'OFFLINE_WA',
    items: [{ product_id: pA.product.id, qty: 3, price: 20000 }],
  });

  // Detail harus membawa nama produknya — itu yang dipakai layar menampilkan
  // pilihan barang yang sedang terpasang pada baris.
  const detSalah = await call('GET', `/api/sales/${orderSalah.order.id}`);
  check('detail pesanan membawa nama produk tiap barisnya',
    detSalah.items[0].product_name === 'Produk Salah Input' && !!detSalah.items[0].sku,
    JSON.stringify(detSalah.items[0].product_name));

  // Ganti produknya.
  await call('PUT', `/api/sales/${orderSalah.order.id}`, {
    items: [{ product_id: pB.product.id, qty: 3, price: 26000 }],
  });

  const sesudahGanti = await call('GET', `/api/sales/${orderSalah.order.id}`);
  check('produk pada pesanan benar-benar terganti',
    sesudahGanti.items.length === 1 && sesudahGanti.items[0].product_id === pB.product.id,
    `${sesudahGanti.items[0].product_name}`);

  const stokA1 = (await call('GET', '/api/inventory/products?limit=2000'))
    .products.find((p) => p.id === pA.product.id).stock;
  const stokB1 = (await call('GET', '/api/inventory/products?limit=2000'))
    .products.find((p) => p.id === pB.product.id).stock;

  check('stok produk yang salah dikembalikan seluruhnya',
    near(stokA1, stokA0, 0.001), `${stokA0} lalu ${stokA1}`);
  check('stok produk yang benar berkurang',
    near(stokB1, stokB0 - 3, 0.001), `${stokB0} lalu ${stokB1}`);

  // HPP ikut berpindah ke produk yang benar, bukan tertinggal pada yang salah.
  check('HPP dihitung ulang dari produk yang baru',
    near(sesudahGanti.order.cogs, 3 * 11000, 1), `${sesudahGanti.order.cogs}`);
  check('nilai order mengikuti harga yang baru',
    near(sesudahGanti.order.gross_sales, 3 * 26000, 1), `${sesudahGanti.order.gross_sales}`);

  const tbGanti = await call('GET',
    `/api/finance/reports/trial-balance?from=${today.slice(0, 8)}01&to=${today}`);
  check('pembukuan tetap seimbang setelah produk diganti',
    near(tbGanti.totalDebit, tbGanti.totalCredit, 1));

  // Produk yang sudah dinonaktifkan tidak muncul di daftar aktif; pesanan lama
  // tetap harus menyebut namanya, kalau tidak barisnya terbaca kosong di layar
  // dan terhapus begitu formulir disimpan.
  await call('PUT', `/api/inventory/products/${pA.product.id}`, {
    sku: pA.product.sku, name: pA.product.name, category: 'Uji', unit: 'PCS',
    cost: 8000, price: 20000, active: false,
  });
  const daftarAktif = await call('GET', '/api/inventory/products?limit=2000');
  check('produk nonaktif tidak ikut daftar produk aktif',
    !daftarAktif.products.some((p) => p.id === pA.product.id));

  const orderLamaA = await call('POST', '/api/sales', {
    order_date: today, channel: 'OFFLINE_WA',
    items: [{ product_id: pB.product.id, qty: 1, price: 26000 }],
  });
  const detLamaA = await call('GET', `/api/sales/${orderLamaA.order.id}`);
  check('detail pesanan tetap menyebut nama produknya walau daftar aktif berubah',
    !!detLamaA.items[0].product_name);

  // ---------- Akun saya & kewajiban ganti kata sandi ----------
  console.log('\n34. Akun saya & kata sandi');

  const emailAkun = `akun-${Date.now()}@uji.local`;
  const akunBaru = await call('POST', '/api/admin/users', {
    name: 'Uji Akun Sendiri', email: emailAkun, password: 'Sementara#1',
    role: 'staff', position: 'Packing',
  });

  const masukPertama = await call('POST', '/api/auth/login', {
    email: emailAkun, password: 'Sementara#1',
  });
  check('akun baru wajib mengganti kata sandi pada masuk pertama',
    masukPertama.sandi.wajib === true && masukPertama.sandi.alasan === 'baru',
    JSON.stringify(masukPertama.sandi));
  check('syarat kata sandi ikut dikirim ke layar',
    Array.isArray(masukPertama.syaratSandi) && masukPertama.syaratSandi.length === 5);

  const adminAkun = token;
  token = masukPertama.token;

  // Inti kewajibannya: menu lain benar-benar terkunci di peladen, bukan hanya
  // disembunyikan di layar.
  const cobaAkun = async (path) => {
    const r = await fetch(`${BASE}${path}`, { headers: { Authorization: `Bearer ${token}` } });
    return { status: r.status, isi: await r.json().catch(() => ({})) };
  };

  const tolakSandi = await cobaAkun('/api/dashboard');
  check('menu lain ditolak selama kata sandi belum diganti',
    tolakSandi.status === 403 && tolakSandi.isi.harusGantiSandi === true,
    `status ${tolakSandi.status}`);
  const tolakSandi2 = await cobaAkun('/api/sales?from=2026-01-01&to=2026-12-31');
  check('penolakan berlaku untuk seluruh modul, bukan satu saja',
    tolakSandi2.status === 403 && tolakSandi2.isi.harusGantiSandi === true);

  const bolehAkun = await cobaAkun('/api/auth/akun');
  check('halaman akun sendiri tetap bisa dibuka', bolehAkun.status === 200);
  check('akun sendiri menampilkan data pemiliknya',
    bolehAkun.isi.user.email === emailAkun && !!bolehAkun.isi.user.peran_nama);

  // Aturan kata sandi ditegakkan di peladen, bukan hanya di layar.
  const lemah = [
    ['Pen1!aA', 'terlalu pendek'],
    ['semuahurufkecil1!', 'tanpa huruf besar'],
    ['SEMUAHURUFBESAR1!', 'tanpa huruf kecil'],
    ['TanpaAngkaSama!', 'tanpa angka'],
    ['TanpaSimbol123', 'tanpa simbol'],
  ];
  for (const [sandi, kenapa] of lemah) {
    let st = 0;
    try {
      await call('POST', '/api/auth/ganti-sandi', {
        currentPassword: 'Sementara#1', newPassword: sandi,
      });
    } catch (err) {
      st = err.status;
    }
    check(`kata sandi ${kenapa} ditolak`, st === 422, `status ${st}`);
  }

  let tolakSama = 0;
  try {
    await call('POST', '/api/auth/ganti-sandi', {
      currentPassword: 'Sementara#1', newPassword: 'Sementara#1',
    });
  } catch (err) {
    tolakSama = err.status;
  }
  check('kata sandi baru yang sama dengan yang lama ditolak', tolakSama === 422);

  let tolakSalahLama = 0;
  try {
    await call('POST', '/api/auth/ganti-sandi', {
      currentPassword: 'BukanIni#9', newPassword: 'RahasiaBaru#2026',
    });
  } catch (err) {
    tolakSalahLama = err.status;
  }
  check('kata sandi lama yang salah ditolak', tolakSalahLama === 400);

  const berhasil = await call('POST', '/api/auth/ganti-sandi', {
    currentPassword: 'Sementara#1', newPassword: 'RahasiaBaru#2026',
  });
  check('kata sandi yang memenuhi syarat diterima', berhasil.ok);
  check('kewajiban ganti hilang setelah diganti', berhasil.sandi.wajib === false);
  check('masa berlaku baru mulai dihitung',
    berhasil.sandi.sisaHari >= 89 && berhasil.sandi.sisaHari <= 90,
    `sisa ${berhasil.sandi.sisaHari} hari`);

  const setelahGanti = await cobaAkun('/api/dashboard');
  check('menu terbuka kembali setelah kata sandi diganti', setelahGanti.status === 200);

  // Profil sendiri: foto dan nomor HP boleh diubah, identitas tidak.
  const fotoUji =
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  const profilBaru = await call('PUT', '/api/auth/akun', { phone: '081299887766', photo: fotoUji });
  check('foto dan nomor HP sendiri bisa disimpan',
    !!profilBaru.user.photo && profilBaru.user.phone === '081299887766');

  const cekProfil = await call('GET', '/api/auth/akun');
  check('perubahan profil tersimpan', !!cekProfil.user.photo);

  // Identitas tidak boleh ikut berubah lewat endpoint akun sendiri.
  await call('PUT', '/api/auth/akun', { phone: '0812', photo: null });
  const cekIdentitas = await call('GET', '/api/auth/akun');
  check('nama, email, dan peran tidak berubah lewat akun sendiri',
    cekIdentitas.user.name === 'Uji Akun Sendiri' && cekIdentitas.user.email === emailAkun);

  // Reset oleh pengelola mewajibkan penggantian lagi.
  token = adminAkun;
  await call('PUT', `/api/admin/users/${akunBaru.user.id}`, {
    name: 'Uji Akun Sendiri', email: emailAkun, role: 'staff', password: 'DiresetAdmin#7',
  });
  const masukSetelahReset = await call('POST', '/api/auth/login', {
    email: emailAkun, password: 'DiresetAdmin#7',
  });
  check('kata sandi yang direset pengelola wajib diganti pemiliknya',
    masukSetelahReset.sandi.wajib === true, JSON.stringify(masukSetelahReset.sandi));


  // Wajibkan seluruh tim ganti kata sandi serentak.
  token = adminAkun;
  const sebelumWajib = await call('POST', '/api/auth/login', {
    email: emailAkun, password: 'DiresetAdmin#7',
  });
  void sebelumWajib;

  const wajibkan = await call('POST', '/api/admin/users/wajib-ganti-sandi', {});
  check('seluruh tim bisa diwajibkan ganti kata sandi sekaligus', wajibkan.jumlah > 0);

  const daftarSetelah = await call('GET', '/api/admin/users');
  const sayaSendiri = daftarSetelah.users.find((u) => u.email === 'admin@kebumen.local');
  check('pengelola yang menekan tidak ikut terkunci',
    sayaSendiri && !sayaSendiri.must_change_password);

  // Kata sandi lama harus tetap bisa dipakai masuk — kalau ikut diacak,
  // seluruh tim berhenti bekerja sampai ada yang membagikan yang baru.
  const masukWajib = await call('POST', '/api/auth/login', {
    email: emailAkun, password: 'DiresetAdmin#7',
  });
  check('kata sandi lama masih bisa dipakai masuk', !!masukWajib.token);
  check('tetapi wajib diganti sebelum membuka menu', masukWajib.sandi.wajib === true);

  token = masukWajib.token;
  const tertahan = await cobaAkun('/api/dashboard');
  check('menu terkunci sampai kata sandi diganti', tertahan.status === 403);
  token = adminAkun;


  console.log('\n35. Latar halaman masuk');

  // 1x1 piksel PNG — cukup untuk menguji alurnya tanpa memindahkan foto besar.
  const gambarUji =
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

  const latarAwal = await call('GET', '/api/branding');
  check('daftar latar ikut dikirim ke halaman masuk',
    Array.isArray(latarAwal.latar), JSON.stringify(latarAwal.latar));

  const tambah1 = await call('POST', '/api/branding/latar', { gambar: gambarUji });
  const tambah2 = await call('POST', '/api/branding/latar', { gambar: gambarUji });
  check('gambar latar bisa ditambahkan', tambah2.jumlah === tambah1.jumlah + 1);

  const latarIsi = await call('GET', '/api/branding');
  check('latar muncul di identitas terbuka', latarIsi.latar.length === tambah2.jumlah);

  // Halaman masuk tampil sebelum siapa pun login, jadi gambarnya harus bisa
  // diambil tanpa token sama sekali.
  const latarTanpaToken = await fetch(`${BASE}${latarIsi.latar[0]}`);
  check('gambar latar bisa diambil tanpa login', latarTanpaToken.status === 200,
    `status ${latarTanpaToken.status}`);

  let tolakTambah = 0;
  try {
    await call('POST', '/api/branding/latar', {});
  } catch (err) {
    tolakTambah = err.status;
  }
  check('menambah tanpa gambar ditolak', tolakTambah === 400, `status ${tolakTambah}`);

  // WebP dan GIF diterima supaya latar bisa dibuat seringan mungkin, dan GIF
  // bergerak bisa dipakai apa adanya.
  const gifUji = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
  const webpUji =
    'data:image/webp;base64,UklGRhoAAABXRUJQVlA4TA0AAAAvAAAAEAcQERGIiP4HAA==';

  const tambahGif = await call('POST', '/api/branding/latar', { gambar: gifUji });
  check('GIF diterima sebagai latar', tambahGif.ok === true);
  const tambahWebp = await call('POST', '/api/branding/latar', { gambar: webpUji });
  check('WebP diterima sebagai latar', tambahWebp.ok === true);

  let tolakTipe = 0;
  try {
    await call('POST', '/api/branding/latar', {
      gambar: 'data:application/pdf;base64,JVBERi0xLjQK',
    });
  } catch (err) {
    tolakTipe = err.status;
  }
  check('berkas yang bukan gambar ditolak', tolakTipe === 400, `status ${tolakTipe}`);

  const hapusLatar = await call('DELETE', '/api/branding/latar/0');
  check('gambar latar bisa dihapus', hapusLatar.jumlah === tambahWebp.jumlah - 1,
    `sisa ${hapusLatar.jumlah}`);

  let tolakHapusLatar = 0;
  try {
    await call('DELETE', '/api/branding/latar/99');
  } catch (err) {
    tolakHapusLatar = err.status;
  }
  check('menghapus latar yang tidak ada ditolak', tolakHapusLatar === 404);

  // Mengurus tampilan aplikasi adalah wewenang pengelola, bukan siapa saja
  // yang kebetulan sudah masuk.
  token = await masukSebagai(akunGudang.user.email, 'RahasiaKuat1');
  let tolakIzinLatar = 0;
  try {
    await call('POST', '/api/branding/latar', { gambar: gambarUji });
  } catch (err) {
    tolakIzinLatar = err.status;
  }
  check('tim tanpa izin pengaturan tidak bisa mengubah latar', tolakIzinLatar === 403,
    `status ${tolakIzinLatar}`);
  token = adminAkun;

  console.log('\n36. Pengiriman kilat');

  const skuKilat = `KILAT-${Date.now()}`;
  const prodKilat = (await call('POST', '/api/inventory/products', {
    sku: skuKilat, name: 'Produk Uji Kilat', cost: 10000, price: 40000,
  })).product;
  await call('POST', '/api/inventory/moves', {
    product_id: prodKilat.id, move_date: today, move_type: 'IN',
    qty: 30, unit_cost: 10000, payment: 'CASH',
  });

  const buatKilat = async (tahap) => (await call('POST', '/api/sales', {
    order_date: today, channel: 'SHOPEE', customer: `Kilat ${tahap}`,
    items: [{ product_id: prodKilat.id, qty: 1, price: 40000 }],
    payment_status: 'UNPAID', fulfillment_status: tahap,
  })).order;

  const oKilat = await buatKilat('KILAT');
  check('pesanan bisa disimpan sebagai Pengiriman Kilat',
    oKilat.fulfillment_status === 'KILAT', oKilat.fulfillment_status);
  const oKilatCair = await buatKilat('KILAT_CAIR');
  check('Pengiriman Kilat Cair tersimpan', oKilatCair.fulfillment_status === 'KILAT_CAIR');
  const oKilatRetur = await buatKilat('KILAT_RETUR');
  check('Retur Pengiriman Kilat tersimpan', oKilatRetur.fulfillment_status === 'KILAT_RETUR');

  const papanKilat = await call('GET', `/api/sales/papan?from=${today}&to=${today}`);
  const kolomKilat = papanKilat.kolom.find((k) => k.status === 'KILAT');
  check('Pengiriman Kilat punya kolom sendiri di papan pengiriman',
    !!kolomKilat && kolomKilat.orders >= 1,
    papanKilat.kolom.map((k) => k.status).join(' '));
  check('kedua tahap kilat lain ikut berkolom',
    papanKilat.kolom.some((k) => k.status === 'KILAT_CAIR')
    && papanKilat.kolom.some((k) => k.status === 'KILAT_RETUR'));

  // Inti bahayanya: kalau tahap kilat tidak diakui sebagai 'sudah selesai
  // urusannya', dana yang sudah cair akan terus dihitung sebagai tertahan.
  const barisKilatCair = papanKilat.kolom
    .find((k) => k.status === 'KILAT_CAIR').rows.map((r) => r.id);
  check('pesanan kilat yang sudah cair tidak dihitung belum selesai',
    !barisKilatCair.some((id) => id === oKilat.id));

  const papanSemua = papanKilat.kolom.reduce((n, k) => n + k.orders, 0);
  check('papan menghitung seluruh kolom termasuk kilat',
    papanKilat.ringkas.total === papanSemua,
    `${papanKilat.ringkas.total} vs ${papanSemua}`);

  // Dana tertahan di dashboard harus ikut menghitung pengiriman kilat yang
  // masih berjalan — kalau tidak, uang yang benar-benar ditunggu hilang
  // dari layar tanpa ada yang tahu.
  const dashKilat = await call('GET', '/api/dashboard');
  const tertahanIds = await call('GET',
    `/api/sales?from=${today}&to=${today}&fulfillment_status=KILAT&limit=100`);
  check('dashboard menghitung dana tertahan termasuk pengiriman kilat',
    dashKilat.penjualan.danaTertahan.orders >= tertahanIds.rows.length,
    `tertahan ${dashKilat.penjualan.danaTertahan.orders} order, kilat berjalan ${tertahanIds.rows.length}`);

  // Ubah massal harus menerima tahap kilat, bukan hanya tahap lama.
  const massalKilat = await call('PATCH', '/api/sales/status-massal', {
    ids: [oKilat.id], fulfillment_status: 'KILAT_CAIR',
    payout_date: today, payment_status: 'PAID',
  });
  check('ubah massal menerima tahap kilat', massalKilat.ok === true);
  const setelahMassal = (await call('GET', `/api/sales/${oKilat.id}`)).order;
  check('tahapnya benar-benar berubah menjadi Pengiriman Kilat Cair',
    setelahMassal.fulfillment_status === 'KILAT_CAIR', setelahMassal.fulfillment_status);

  let tolakTahapNgawur = 0;
  try {
    await call('POST', '/api/sales', {
      order_date: today, channel: 'SHOPEE', customer: 'Ngawur',
      items: [{ product_id: prodKilat.id, qty: 1, price: 40000 }],
      fulfillment_status: 'KILAT_NGAWUR',
    });
  } catch (err) {
    tolakTahapNgawur = err.status;
  }
  check('tahap yang tidak dikenal tetap ditolak', tolakTahapNgawur === 400,
    `status ${tolakTahapNgawur}`);

  console.log('\n37. Membetulkan tanggal order');

  // Persis kejadian nyatanya: order akhir Agustus terlanjur tersimpan
  // bertanggal awal September, dan baru ketahuan setelah tersimpan.
  const skuTgl = `TGL-${Date.now()}`;
  const prodTgl = (await call('POST', '/api/inventory/products', {
    sku: skuTgl, name: 'Produk Uji Tanggal', cost: 10000, price: 50000,
  })).product;
  await call('POST', '/api/inventory/moves', {
    product_id: prodTgl.id, move_date: '2026-08-01', move_type: 'IN',
    qty: 20, unit_cost: 10000, payment: 'CASH',
  });

  const SALAH = '2026-09-01';
  const BENAR = '2026-08-31';

  const oTgl = (await call('POST', '/api/sales', {
    order_date: SALAH, channel: 'SHOPEE', customer: 'Salah Tanggal',
    items: [{ product_id: prodTgl.id, qty: 2, price: 50000 }],
    payment_status: 'PAID',
  })).order;
  check('order tersimpan dengan tanggal yang keliru', oTgl.order_date === SALAH);

  const lrSepSebelum = (await call('GET',
    '/api/finance/reports/income-statement?from=2026-09-01&to=2026-09-30')).grossSales;

  const betul = await call('PUT', `/api/sales/${oTgl.id}`, { order_date: BENAR });
  check('tanggal order bisa dibetulkan setelah tersimpan', betul.ok === true);

  const sesudah = (await call('GET', `/api/sales/${oTgl.id}`)).order;
  check('tanggalnya benar-benar berpindah', sesudah.order_date === BENAR, sesudah.order_date);

  // Inti bahayanya: kalau jurnalnya tertinggal di tanggal lama, laporan
  // Agustus dan September dua-duanya salah tanpa ada yang tampak keliru.
  const lrAgustus = await call('GET',
    '/api/finance/reports/income-statement?from=2026-08-01&to=2026-08-31');
  const lrSeptember = await call('GET',
    '/api/finance/reports/income-statement?from=2026-09-01&to=2026-09-30');
  // Penjualan order ini Rp 100.000. Ia harus muncul di Agustus, dan sama
  // sekali tidak boleh tertinggal di September.
  check('penjualannya pindah ke laba rugi bulan yang benar',
    lrAgustus.grossSales >= 100000,
    `agustus ${lrAgustus.grossSales}`);
  check('penjualannya tidak tertinggal di bulan yang salah',
    lrSepSebelum - lrSeptember.grossSales >= 100000,
    `september ${lrSepSebelum} -> ${lrSeptember.grossSales}`);

  // Mutasi stoknya juga, supaya kartu stok tidak menunjukkan barang keluar
  // pada hari yang salah.
  const kartu = await call('GET',
    `/api/inventory/moves?product_id=${prodTgl.id}&from=2026-08-01&to=2026-09-30`);
  const keluar = kartu.rows.filter(
    (m) => m.source === 'SALES' && m.source_id === oTgl.id
  );
  check('tanggal mutasi stok ikut dibetulkan',
    keluar.length > 0 && keluar.every((m) => m.move_date === BENAR),
    keluar.map((m) => m.move_date).join(' ') || 'tidak ada mutasi keluar');

  const neracaTgl = await call('GET',
    '/api/finance/reports/trial-balance?from=2026-08-01&to=2026-09-30');
  check('neraca tetap seimbang setelah tanggal dibetulkan',
    Math.abs(neracaTgl.totalDebit - neracaTgl.totalCredit) < 0.01,
    `${neracaTgl.totalDebit} vs ${neracaTgl.totalCredit}`);

  let tolakTglNgawur = 0;
  try {
    await call('PUT', `/api/sales/${oTgl.id}`, { order_date: '31-08-2026' });
  } catch (err) {
    tolakTglNgawur = err.status;
  }
  check('format tanggal yang salah tetap ditolak', tolakTglNgawur === 400,
    `status ${tolakTglNgawur}`);

  console.log('\n38. Pindah saldo antar rekening');

  const tbSebelumPindah = await call('GET',
    `/api/finance/reports/trial-balance?from=${bulanIni}&to=${today}`);
  const barisAkun = (tb, kode) => (tb.rows || []).find((r) => r.code === kode) || {};
  const kasAwal = barisAkun(tbSebelumPindah, '1000');
  const bankAwal = barisAkun(tbSebelumPindah, '1010');

  const pindah = await call('POST', '/api/cashflow/pindah', {
    entry_date: today, from_code: '1010', to_code: '1000',
    amount: 500000, note: 'Tarik tunai untuk operasional',
  });
  check('saldo bisa dipindahkan antar rekening', pindah.ok === true);

  const tbSesudahPindah = await call('GET',
    `/api/finance/reports/trial-balance?from=${bulanIni}&to=${today}`);
  check('neraca tetap seimbang setelah pindah saldo',
    Math.abs(tbSesudahPindah.totalDebit - tbSesudahPindah.totalCredit) < 0.01);

  const kasBaru = barisAkun(tbSesudahPindah, '1000');
  const bankBaru = barisAkun(tbSesudahPindah, '1010');
  const naikKas = (kasBaru.debit || 0) - (kasAwal.debit || 0);
  const turunBank = (bankBaru.credit || 0) - (bankAwal.credit || 0);
  check('kas tunai bertambah sebesar yang dipindahkan',
    Math.abs(naikKas - 500000) < 0.01, `naik ${naikKas}`);
  check('rekening bank berkurang sebesar yang sama',
    Math.abs(turunBank - 500000) < 0.01, `turun ${turunBank}`);

  const daftarPindah = await call('GET', `/api/cashflow/pindah?from=${bulanIni}&to=${today}`);
  check('pemindahan muncul di riwayat', daftarPindah.rows.length >= 1);
  check('riwayat menyebut rekening asal dan tujuan',
    daftarPindah.rows.some((r) => r.dari && r.ke),
    JSON.stringify(daftarPindah.rows[0] || {}).slice(0, 120));
  check('daftar rekening ikut dikirim untuk pilihan',
    Array.isArray(daftarPindah.rekening) && daftarPindah.rekening.length >= 2);

  let tolakSamaRek = 0;
  try {
    await call('POST', '/api/cashflow/pindah', {
      entry_date: today, from_code: '1000', to_code: '1000', amount: 1000,
    });
  } catch (err) { tolakSamaRek = err.status; }
  check('rekening asal sama dengan tujuan ditolak', tolakSamaRek === 422,
    `status ${tolakSamaRek}`);

  let tolakTujuanBukanKas = 0;
  try {
    await call('POST', '/api/cashflow/pindah', {
      entry_date: today, from_code: '1010', to_code: '4000', amount: 1000,
    });
  } catch (err) { tolakTujuanBukanKas = err.status; }
  check('akun yang bukan kas/bank ditolak sebagai tujuan', tolakTujuanBukanKas === 422,
    `status ${tolakTujuanBukanKas}`);

  let tolakNolPindah = 0;
  try {
    await call('POST', '/api/cashflow/pindah', {
      entry_date: today, from_code: '1010', to_code: '1000', amount: 0,
    });
  } catch (err) { tolakNolPindah = err.status; }
  check('nominal nol ditolak', tolakNolPindah === 400 || tolakNolPindah === 422,
    `status ${tolakNolPindah}`);

  // Membatalkan satu pemindahan tidak boleh menyapu pemindahan lain. Jurnal
  // pemindahan tidak punya dokumen induk, jadi menghapusnya lewat source_id
  // yang kosong akan menghapus SELURUH pemindahan sekaligus.
  await call('POST', '/api/cashflow/pindah', {
    entry_date: today, from_code: '1000', to_code: '1010', amount: 25000,
  });
  const sebelumHapus = (await call('GET', `/api/cashflow/pindah?from=${bulanIni}&to=${today}`)).rows;
  await call('DELETE', `/api/cashflow/pindah/${sebelumHapus[0].id}`);
  const sesudahHapus = (await call('GET', `/api/cashflow/pindah?from=${bulanIni}&to=${today}`)).rows;
  check('membatalkan satu pemindahan hanya menghapus satu baris',
    sesudahHapus.length === sebelumHapus.length - 1,
    `${sebelumHapus.length} -> ${sesudahHapus.length}`);

  const tbAkhirPindah = await call('GET',
    `/api/finance/reports/trial-balance?from=${bulanIni}&to=${today}`);
  check('neraca tetap seimbang setelah pembatalan',
    Math.abs(tbAkhirPindah.totalDebit - tbAkhirPindah.totalCredit) < 0.01);

  console.log('\n39. Biaya Kirim Non MP');

  const skuOng = `ONG-${Date.now()}`;
  const prodOng = (await call('POST', '/api/inventory/products', {
    sku: skuOng, name: 'Produk Uji Ongkir', cost: 20000, price: 100000,
  })).product;
  await call('POST', '/api/inventory/moves', {
    product_id: prodOng.id, move_date: today, move_type: 'IN',
    qty: 20, unit_cost: 20000, payment: 'CASH',
  });

  const ONGKIR = 25000;
  const oOng = (await call('POST', '/api/sales', {
    order_date: today, channel: 'OFFLINE_WA', customer: 'Pembeli Ongkir',
    items: [{ product_id: prodOng.id, qty: 1, price: 100000 }],
    shipping_non_mp: ONGKIR, payment_status: 'PAID',
  })).order;
  check('biaya kirim non MP tersimpan pada order',
    Math.abs(oOng.shipping_non_mp - ONGKIR) < 0.01, String(oOng.shipping_non_mp));

  // Inti pemisahannya: ongkir TIDAK boleh menggelembungkan omzet maupun laba.
  check('ongkir tidak menambah penjualan kotor',
    Math.abs(oOng.gross_sales - 100000) < 0.01, String(oOng.gross_sales));
  check('ongkir tidak menambah pendapatan kotor',
    Math.abs(oOng.net_revenue - 100000) < 0.01, String(oOng.net_revenue));
  check('ongkir tidak menggelembungkan laba',
    Math.abs(oOng.net_profit - 80000) < 0.01, String(oOng.net_profit));

  const detailOng = await call('GET', `/api/sales/${oOng.id}`);
  check('order tersimpan dengan biaya kirim non MP-nya',
    Math.abs(detailOng.order.shipping_non_mp - ONGKIR) < 0.01);

  // Yang diminta: total order + ongkir itulah yang masuk rekening.
  const ringkasOng = await call('GET',
    `/api/sales?from=${today}&to=${today}&channel=OFFLINE_WA`);
  check('ongkir non MP punya totalnya sendiri di ringkasan',
    ringkasOng.summary.ongkirNonMp >= ONGKIR,
    String(ringkasOng.summary.ongkirNonMp));
  check('uang masuk rekening = omzet - biaya + ongkir non MP',
    Math.abs(ringkasOng.summary.netReceived
      - (ringkasOng.summary.netRevenue - ringkasOng.summary.totalFees
         + ringkasOng.summary.ongkirNonMp)) < 0.01,
    String(ringkasOng.summary.netReceived));

  const neracaOng = await call('GET',
    `/api/finance/reports/trial-balance?from=${bulanIni}&to=${today}`);
  check('neraca tetap seimbang dengan ongkir non MP',
    Math.abs(neracaOng.totalDebit - neracaOng.totalCredit) < 0.01,
    `${neracaOng.totalDebit} vs ${neracaOng.totalCredit}`);

  // Ongkir masuk akun pendapatannya sendiri, bukan dicampur ke Penjualan —
  // kalau digabung, omzet di laporan keuangan ikut menggelembung.
  const barisOngkir = (neracaOng.rows || []).find((r) => r.code === '4300');
  check('ongkir dicatat di akun pendapatan tersendiri (4300)',
    !!barisOngkir && barisOngkir.credit >= ONGKIR,
    barisOngkir ? String(barisOngkir.credit) : 'akun 4300 tidak ada');

  // Bisa dibetulkan setelah tersimpan, seperti kolom biaya lainnya.
  await call('PUT', `/api/sales/${oOng.id}`, { shipping_non_mp: 40000 });
  const oOngBaru = (await call('GET', `/api/sales/${oOng.id}`)).order;
  check('biaya kirim non MP bisa dibetulkan setelah tersimpan',
    Math.abs(oOngBaru.shipping_non_mp - 40000) < 0.01, String(oOngBaru.shipping_non_mp));
  check('omzetnya tetap tidak berubah saat ongkir dibetulkan',
    Math.abs(oOngBaru.net_revenue - 100000) < 0.01, String(oOngBaru.net_revenue));

  const neracaOng2 = await call('GET',
    `/api/finance/reports/trial-balance?from=${bulanIni}&to=${today}`);
  check('neraca tetap seimbang setelah ongkir dibetulkan',
    Math.abs(neracaOng2.totalDebit - neracaOng2.totalCredit) < 0.01);


  console.log('\n40. Koreksi stok dari layar produk');

  const skuKor = `KOR-${Date.now()}`;
  const prodKor = (await call('POST', '/api/inventory/products', {
    sku: skuKor, name: 'Produk Uji Koreksi', cost: 15000, price: 40000,
  })).product;
  await call('POST', '/api/inventory/moves', {
    product_id: prodKor.id, move_date: today, move_type: 'IN',
    qty: 100, unit_cost: 15000, payment: 'CASH',
  });

  // Stok berkurang: mis. terlanjur tercatat 100 padahal fisiknya 88.
  const kurang = await call('POST', `/api/inventory/products/${prodKor.id}/koreksi-stok`, {
    stock: 88, move_date: today, note: 'Salah input saat barang masuk',
  });
  check('stok bisa dikoreksi langsung dari produk', kurang.ok === true);
  check('stok produk benar-benar berubah', kurang.product.stock === 88,
    String(kurang.product.stock));
  check('selisihnya dihitung benar', kurang.selisih === -12, String(kurang.selisih));

  // Inti bahayanya: kalau angkanya ditimpa tanpa mutasi, kartu stok tidak bisa
  // menjelaskan dari mana angka barunya datang.
  const kartuKor = await call('GET',
    `/api/inventory/moves?product_id=${prodKor.id}&from=${today}&to=${today}`);
  const adj = kartuKor.rows.filter((m) => m.move_type === 'ADJ');
  check('koreksi tercatat di kartu stok sebagai penyesuaian', adj.length === 1,
    `${adj.length} baris ADJ`);
  check('kartu stok memuat alasan koreksinya',
    adj.length === 1 && /Salah input saat barang masuk/.test(adj[0].note || ''),
    adj[0] ? String(adj[0].note) : '-');
  check('saldo kartu stok sama dengan stok produk',
    adj.length === 1 && adj[0].balance_after === 88,
    adj[0] ? String(adj[0].balance_after) : '-');

  // Dan yang paling menentukan: neraca harus tetap cocok dengan gudang.
  const valuasiKor = await call('GET', '/api/inventory/valuation');
  const neracaKor = await call('GET',
    `/api/finance/reports/balance-sheet?from=${bulanIni}&to=${today}`);
  check('neraca tetap seimbang setelah koreksi stok',
    neracaKor.balanced === true || Math.abs(neracaKor.totalAssets
      - (neracaKor.totalLiabilities + neracaKor.totalEquity)) < 0.01);

  const tbKor = await call('GET',
    `/api/finance/reports/trial-balance?from=${bulanIni}&to=${today}`);
  check('neraca saldo tetap seimbang setelah koreksi',
    Math.abs(tbKor.totalDebit - tbKor.totalCredit) < 0.01,
    `${tbKor.totalDebit} vs ${tbKor.totalCredit}`);
  void valuasiKor;

  // Stok bertambah: koreksi ke arah sebaliknya juga harus jalan.
  const tambah = await call('POST', `/api/inventory/products/${prodKor.id}/koreksi-stok`, {
    stock: 95, move_date: today, note: 'Ditemukan sisa di rak belakang',
  });
  check('koreksi menambah stok juga bisa', tambah.product.stock === 95,
    String(tambah.product.stock));
  check('selisih naik dihitung benar', tambah.selisih === 7, String(tambah.selisih));

  const tbKor2 = await call('GET',
    `/api/finance/reports/trial-balance?from=${bulanIni}&to=${today}`);
  check('neraca tetap seimbang setelah koreksi naik',
    Math.abs(tbKor2.totalDebit - tbKor2.totalCredit) < 0.01);

  // Penjagaan.
  let tolakSamaKor = 0;
  try {
    await call('POST', `/api/inventory/products/${prodKor.id}/koreksi-stok`, {
      stock: 95, note: 'tidak ada yang berubah',
    });
  } catch (err) { tolakSamaKor = err.status; }
  check('koreksi ke angka yang sama ditolak', tolakSamaKor === 422,
    `status ${tolakSamaKor}`);

  let tolakTanpaAlasan = 0;
  try {
    await call('POST', `/api/inventory/products/${prodKor.id}/koreksi-stok`, { stock: 50 });
  } catch (err) { tolakTanpaAlasan = err.status; }
  check('koreksi tanpa alasan ditolak', tolakTanpaAlasan === 400,
    `status ${tolakTanpaAlasan}`);

  let tolakMinusKor = 0;
  try {
    await call('POST', `/api/inventory/products/${prodKor.id}/koreksi-stok`, {
      stock: -5, note: 'stok minus',
    });
  } catch (err) { tolakMinusKor = err.status; }
  check('stok minus ditolak', tolakMinusKor === 400, `status ${tolakMinusKor}`);

  // Mengubah data produk lewat jalur biasa tidak boleh menyentuh stok — kalau
  // bisa, satu kali menyimpan formulir akan menggeser nilai persediaan tanpa
  // catatan apa pun.
  await call('PUT', `/api/inventory/products/${prodKor.id}`, {
    sku: skuKor, name: 'Produk Uji Koreksi', cost: 15000, price: 40000, stock: 999,
  });
  const prodSetelahPut = (await call('GET', `/api/inventory/products?q=${skuKor}`)).products
    .find((r) => r.sku === skuKor);
  check('menyimpan data produk tidak menggeser stok',
    prodSetelahPut && prodSetelahPut.stock === 95,
    prodSetelahPut ? String(prodSetelahPut.stock) : 'produk tidak ketemu');

  // Wewenangnya disamakan dengan stok opname, bukan sekadar boleh ubah produk.
  token = await masukSebagai(akunSempit.user.email, 'RahasiaKuat1');
  let tolakIzinKor = 0;
  try {
    await call('POST', `/api/inventory/products/${prodKor.id}/koreksi-stok`, {
      stock: 10, note: 'coba tanpa izin',
    });
  } catch (err) { tolakIzinKor = err.status; }
  check('tim tanpa izin opname tidak bisa mengoreksi stok', tolakIzinKor === 403,
    `status ${tolakIzinKor}`);
  token = adminAkun;


  // ---------- Hasil ----------
  console.log(`\n${'─'.repeat(48)}`);
  console.log(`Lulus: ${passed}   Gagal: ${failed}`);
  console.log(`${'─'.repeat(48)}\n`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('\nUji asap berhenti karena error:', err.message);
  process.exit(1);
});
