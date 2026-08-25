'use strict';
/**
* Uji end-to-end fitur mitra usaha, kas, utang-piutang, retur, dan izin: mitra usaha, kas masuk/keluar, utang & piutang,
 * retur, dan izin/cuti. Menembak API lokal yang sungguhan.
 */
require('dotenv').config();

const BASE = process.env.SMOKE_BASE_URL || `http://localhost:${process.env.PORT || 3000}`;
let token = null;
let lulus = 0;
let gagal = 0;

function cek(label, kondisi, detail = '') {
  if (kondisi) { lulus += 1; console.log(`  ok     ${label}`); }
  else { gagal += 1; console.log(`  GAGAL  ${label} ${detail}`); }
}

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
    const err = new Error(data.error || `HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return data;
}

const near = (a, b, tol = 0.02) => Math.abs(a - b) <= tol;
const today = new Date().toLocaleDateString('sv-SE');

(async () => {
  console.log('\nUji fitur baru\n');

  const login = await call('POST', '/api/auth/login', {
    email: process.env.SEED_ADMIN_EMAIL || 'admin@kebumen.local',
    password: process.env.SEED_ADMIN_PASSWORD || 'Admin#12345',
  });
  token = login.token;
  cek('login admin', !!token);

  // ---------- MITRA ----------
  console.log('\n1. Supplier & Pelanggan');
  const stamp = Date.now();
  const sup = await call('POST', '/api/partners', {
    name: `Supplier Uji ${stamp}`, kind: 'SUPPLIER', phone: '08123', term_days: 30,
  });
  const cust = await call('POST', '/api/partners', {
    name: `Pelanggan Uji ${stamp}`, kind: 'CUSTOMER', term_days: 14,
  });
  cek('supplier dibuat', sup.partner.id > 0);
  cek('pelanggan dibuat', cust.partner.id > 0);

  const daftar = await call('GET', '/api/partners');
  cek('daftar mitra memuat keduanya',
    daftar.partners.some((p) => p.id === sup.partner.id) &&
    daftar.partners.some((p) => p.id === cust.partner.id));

  const hanyaSupplier = await call('GET', '/api/partners?kind=SUPPLIER');
  cek('filter jenis bekerja',
    hanyaSupplier.partners.every((p) => p.kind === 'SUPPLIER' || p.kind === 'BOTH'));

  // ---------- KAS MASUK / KELUAR ----------
  console.log('\n2. Kas Masuk & Kas Keluar');
  const opsi = await call('GET', '/api/cashflow/options');
  cek('daftar akun kas tersedia', opsi.cashAccounts.length > 0);
  cek('kategori pengeluaran tersedia', opsi.expenseCategories.length > 0);

  const kasSebelum = (await call('GET', `/api/finance/reports/balance-sheet?asOf=${today}`))
    .assets.current.totalCash;

  await call('POST', '/api/cashflow/entries', {
    entry_date: today, direction: 'OUT', category_code: '6110',
    cash_code: '1000', amount: 500000, description: 'Uji bayar sewa',
  });
  const kasSesudah = (await call('GET', `/api/finance/reports/balance-sheet?asOf=${today}`))
    .assets.current.totalCash;
  cek('kas keluar mengurangi saldo kas 500.000',
    near(kasSebelum - kasSesudah, 500000), `(selisih ${kasSebelum - kasSesudah})`);

  await call('POST', '/api/cashflow/entries', {
    entry_date: today, direction: 'IN', category_code: '4900',
    cash_code: '1000', amount: 200000, description: 'Uji pendapatan lain',
  });
  const kasAkhir = (await call('GET', `/api/finance/reports/balance-sheet?asOf=${today}`))
    .assets.current.totalCash;
  cek('kas masuk menambah saldo kas 200.000',
    near(kasAkhir - kasSesudah, 200000), `(selisih ${kasAkhir - kasSesudah})`);

  const daftarKas = await call('GET', `/api/cashflow/entries?from=${today}&to=${today}`);
  cek('riwayat kas mencatat kedua transaksi', daftarKas.rows.length >= 2);
  cek('ringkasan kas benar',
    near(daftarKas.summary.masuk, 200000) && near(daftarKas.summary.keluar, 500000),
    `(masuk ${daftarKas.summary.masuk}, keluar ${daftarKas.summary.keluar})`);

  const neraca1 = await call('GET', `/api/finance/reports/balance-sheet?asOf=${today}`);
  cek('neraca tetap seimbang setelah kas manual', neraca1.balanced);

  // ---------- UTANG (pembelian tempo) ----------
  console.log('\n3. Utang Supplier');
  const prod = await call('POST', '/api/inventory/products', {
    sku: `UJI-${stamp}`, name: 'Produk Uji Mitra', cost: 10000, price: 20000,
  });

  await call('POST', '/api/inventory/moves', {
    product_id: prod.product.id, move_date: today, move_type: 'IN',
    qty: 50, unit_cost: 10000, payment: 'CREDIT', partner_id: sup.partner.id,
  });

  const arap1 = await call('GET', '/api/cashflow/ar-ap');
  const utangSup = arap1.utang.find((u) => u.id === sup.partner.id);
  cek('utang supplier tercatat 500.000', utangSup && near(utangSup.utang, 500000),
    `(${utangSup ? utangSup.utang : 'tidak ada'})`);

  // Bayar sebagian
  const bayar = await call('POST', '/api/cashflow/settlements', {
    entry_date: today, partner_id: sup.partner.id, direction: 'PAY',
    amount: 200000, cash_code: '1000',
  });
  cek('pembayaran sebagian menyisakan 300.000', near(bayar.sisa, 300000), `(${bayar.sisa})`);

  const arap2 = await call('GET', '/api/cashflow/ar-ap');
  const utangSisa = arap2.utang.find((u) => u.id === sup.partner.id);
  cek('sisa utang di daftar sesuai', utangSisa && near(utangSisa.utang, 300000),
    `(${utangSisa ? utangSisa.utang : 0})`);

  let tolakLebih = false;
  try {
    await call('POST', '/api/cashflow/settlements', {
      entry_date: today, partner_id: sup.partner.id, direction: 'PAY',
      amount: 999999999, cash_code: '1000',
    });
  } catch (err) { tolakLebih = /melebihi/i.test(err.message); }
  cek('pembayaran melebihi sisa utang ditolak', tolakLebih);

  // ---------- PIUTANG (penjualan tempo) ----------
  console.log('\n4. Piutang Pelanggan');
  await call('POST', '/api/sales', {
    order_date: today, channel: 'OFFLINE_WA',
    partner_id: cust.partner.id, customer: cust.partner.name,
    items: [{ product_id: prod.product.id, qty: 10, price: 20000 }],
    payment_status: 'UNPAID',
  });

  const arap3 = await call('GET', '/api/cashflow/ar-ap');
  const piutang = arap3.piutang.find((p) => p.id === cust.partner.id);
  cek('piutang pelanggan tercatat 200.000', piutang && near(piutang.piutang, 200000),
    `(${piutang ? piutang.piutang : 'tidak ada'})`);

  const terima = await call('POST', '/api/cashflow/settlements', {
    entry_date: today, partner_id: cust.partner.id, direction: 'RECEIVE',
    amount: 200000, cash_code: '1000',
  });
  cek('pelunasan piutang menutup saldo', near(terima.sisa, 0), `(${terima.sisa})`);

  const arap4 = await call('GET', '/api/cashflow/ar-ap');
  cek('piutang lunas hilang dari daftar',
    !arap4.piutang.some((p) => p.id === cust.partner.id));

  const ledger = await call('GET', `/api/partners/${cust.partner.id}/ledger`);
  cek('riwayat mitra mencatat mutasi', ledger.entries.length >= 2);

  // ---------- RETUR ----------
  console.log('\n5. Retur Penjualan');
  const retur = await call('POST', '/api/sales/returns', {
    return_date: today, product_id: prod.product.id, qty: 2, price: 20000,
    restock: true, reason: 'Uji retur',
  });
  cek('retur tersimpan senilai 40.000', near(retur.amount, 40000));

  const daftarRetur = await call('GET', `/api/sales/returns/list?from=${today}&to=${today}`);
  cek('daftar retur dapat dibaca', daftarRetur.rows.length >= 1);
  cek('retur muncul di daftar', daftarRetur.rows.some((r) => r.return_no === retur.return_no));

  // ---------- IZIN / CUTI ----------
  console.log('\n6. Izin / Cuti');
  const users = await call('GET', '/api/admin/users');
  const target = users.users.find((u) => u.active);
  const tglIzin = '2026-01-15';

  const izin = await call('POST', '/api/attendance/leave', {
    user_id: target.id, work_date: tglIzin, status: 'LEAVE', notes: 'Cuti uji',
  });
  cek('izin tercatat', izin.ok === true);

  const rekap = await call('GET', `/api/attendance?from=${tglIzin}&to=${tglIzin}`);
  const barisIzin = rekap.rows.find((r) => r.user_id === target.id);
  cek('izin muncul di rekap dengan status LEAVE',
    barisIzin && barisIzin.status === 'LEAVE', `(${barisIzin ? barisIzin.status : 'tidak ada'})`);

  await call('PATCH', `/api/attendance/${barisIzin.id}`, { status: 'ABSENT', notes: 'Dikoreksi' });
  const rekap2 = await call('GET', `/api/attendance?from=${tglIzin}&to=${tglIzin}`);
  cek('koreksi status berhasil',
    rekap2.rows.find((r) => r.id === barisIzin.id).status === 'ABSENT');

  // ---------- INTEGRITAS ----------
  console.log('\n7. Integritas Pembukuan');
  const tb = await call('GET', `/api/finance/reports/trial-balance?from=2000-01-01&to=${today}`);
  cek('neraca saldo seimbang (Debit = Kredit)', tb.balanced,
    `(D ${tb.totalDebit} vs K ${tb.totalCredit})`);

  const bs = await call('GET', `/api/finance/reports/balance-sheet?asOf=${today}`);
  cek('neraca seimbang setelah semua transaksi baru', bs.balanced);

  console.log('\n' + '─'.repeat(50));
  console.log(`Lulus: ${lulus}   Gagal: ${gagal}`);
  console.log('─'.repeat(50) + '\n');
  process.exit(gagal === 0 ? 0 : 1);
})().catch((err) => {
  console.error('\nUji berhenti:', err.message);
  process.exit(1);
});
