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
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status}: ${data.error || text}`);
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

  let journalGuard = false;
  try {
    await call('POST', '/api/finance/journals', {
      entry_date: today, description: 'Jurnal sengaja tidak seimbang',
      lines: [
        { account_id: beban.id, debit: 100000, credit: 0 },
        { account_id: kas.id, debit: 0, credit: 90000 },
      ],
    });
  } catch (err) {
    journalGuard = /tidak seimbang/i.test(err.message);
  }
  check('jurnal tidak seimbang ditolak', journalGuard);

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
    dash.attendance && dash.inventory && dash.sales && dash.finance);

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
