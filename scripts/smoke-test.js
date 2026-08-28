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

  const masukGudang = await call('POST', '/api/auth/login', {
    email: akunGudang.user.email, password: 'RahasiaKuat1',
  });
  const tokenAdmin = token;
  token = masukGudang.token;

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
  const masukSempit = await call('POST', '/api/auth/login', {
    email: akunSempit.user.email, password: 'RahasiaKuat1',
  });
  token = masukSempit.token;
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
    papanAwal.kolom.length === 5 && papanAwal.kolom.every((k) => Array.isArray(k.rows)),
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
