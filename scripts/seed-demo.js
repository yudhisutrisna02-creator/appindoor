'use strict';
/**
 * Mengisi database dengan data contoh yang realistis untuk demonstrasi,
 * pelatihan staf, dan pengujian tampilan.
 *
 *   npm run seed:demo
 *
 * Aman dijalankan berulang: bila SKU demo sudah ada, script berhenti dan
 * meminta konfirmasi lewat flag --force sebelum menambah data lagi.
 * TIDAK untuk dijalankan di database produksi yang sudah berisi transaksi asli.
 */
require('dotenv').config();

const bcrypt = require('bcryptjs');
const { db, nextNumber } = require('../src/db');
const { bootstrap } = require('../src/db/seed');
const { r2, ACC, postJournal, buildSalesJournalLines } = require('../src/utils/accounting');

const force = process.argv.includes('--force');

bootstrap();

const existing = db.prepare("SELECT COUNT(*) c FROM products WHERE sku LIKE 'DMK-%'").get().c;
if (existing > 0 && !force) {
  console.log('Data demo sudah ada di database ini.');
  console.log('Jalankan ulang dengan --force bila memang ingin menambah lagi.');
  process.exit(0);
}

/** Tanggal N hari lalu dalam format YYYY-MM-DD. */
function daysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toLocaleDateString('sv-SE');
}

const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const between = (min, max) => Math.round(min + Math.random() * (max - min));

// ------------------------------------------------------------------
// 1. Pengguna
// ------------------------------------------------------------------
const DEMO_USERS = [
  ['Siti Rahmawati', 'siti@kebumen.local', 'manager', 'Manajer Operasional'],
  ['Budi Santoso', 'budi@kebumen.local', 'staff', 'Admin Gudang'],
  ['Rina Kartika', 'rina@kebumen.local', 'staff', 'Admin Penjualan'],
];

const insertUser = db.prepare(
  `INSERT INTO users (name, email, password_hash, role, position, active)
   VALUES (?,?,?,?,?,1) ON CONFLICT(email) DO NOTHING`
);
const demoHash = bcrypt.hashSync('Demo#12345', 10);
for (const [name, email, role, position] of DEMO_USERS) {
  insertUser.run(name, email, demoHash, role, position);
}
const users = db.prepare("SELECT id, name FROM users WHERE email LIKE '%@kebumen.local'").all();

// ------------------------------------------------------------------
// 2. Produk
// ------------------------------------------------------------------
const DEMO_PRODUCTS = [
  ['DMK-KOP-001', 'Kopi Robusta Kebumen 250g', 'Makanan & Minuman', 'PCS', 28000, 55000, 20],
  ['DMK-KOP-002', 'Kopi Arabika Premium 200g', 'Makanan & Minuman', 'PCS', 45000, 89000, 15],
  ['DMK-GUL-001', 'Gula Semut Organik 500g', 'Makanan & Minuman', 'PCS', 22000, 42000, 25],
  ['DMK-LAN-001', 'Lanting Original 200g', 'Makanan & Minuman', 'PCS', 8500, 17000, 40],
  ['DMK-SAT-001', 'Sale Pisang Kering 250g', 'Makanan & Minuman', 'PCS', 12000, 25000, 30],
  ['DMK-BAT-001', 'Batik Tulis Motif Lawet', 'Fashion', 'PCS', 185000, 350000, 5],
  ['DMK-BAT-002', 'Kemeja Batik Pria Katun', 'Fashion', 'PCS', 125000, 245000, 8],
  ['DMK-TAS-001', 'Tas Anyaman Pandan', 'Kerajinan', 'PCS', 65000, 135000, 10],
  ['DMK-KER-001', 'Gerabah Hias Set 3pcs', 'Kerajinan', 'SET', 95000, 189000, 6],
  ['DMK-MAD-001', 'Madu Hutan Murni 500ml', 'Kesehatan', 'BTL', 78000, 145000, 12],
  ['DMK-JAH-001', 'Jahe Merah Instan 200g', 'Kesehatan', 'PCS', 18000, 35000, 25],
  ['DMK-MIN-001', 'Minyak Kelapa Murni 250ml', 'Kesehatan', 'BTL', 32000, 62000, 15],
];

const insertProduct = db.prepare(
  `INSERT INTO products (sku, name, category, unit, cost, price, min_stock, stock, active)
   VALUES (?,?,?,?,?,?,?,0,1) ON CONFLICT(sku) DO NOTHING`
);
for (const p of DEMO_PRODUCTS) insertProduct.run(...p);

const products = db.prepare("SELECT * FROM products WHERE sku LIKE 'DMK-%'").all();
console.log(`Produk demo: ${products.length}`);

// ------------------------------------------------------------------
// 3. Modal awal pemilik (agar kas tidak negatif)
// ------------------------------------------------------------------
postJournal({
  date: daysAgo(60),
  description: 'Setoran modal awal pemilik',
  lines: [
    { code: ACC.CASH, debit: 20_000_000, credit: 0, memo: 'Kas awal' },
    { code: ACC.BANK, debit: 60_000_000, credit: 0, memo: 'Rekening operasional' },
    { code: ACC.CAPITAL, debit: 0, credit: 80_000_000, memo: 'Modal disetor' },
  ],
  source: 'MANUAL',
  userId: 1,
});

// Pembelian peralatan (arus kas investasi)
postJournal({
  date: daysAgo(58),
  description: 'Pembelian rak gudang & peralatan packing',
  lines: [
    { code: '1500', debit: 8_500_000, credit: 0, memo: 'Rak & meja packing' },
    { code: ACC.BANK, debit: 0, credit: 8_500_000 },
  ],
  source: 'MANUAL',
  userId: 1,
});

// ------------------------------------------------------------------
// 4. Pembelian stok (mutasi masuk + jurnal)
// ------------------------------------------------------------------
const insertMove = db.prepare(
  `INSERT INTO stock_moves
     (product_id, move_date, move_type, qty, unit_cost, balance_after, ref, source, note, user_id)
   VALUES (?,?,?,?,?,?,?,?,?,?)`
);

const restock = db.transaction((product, qty, unitCost, date, payment) => {
  const fresh = db.prepare('SELECT * FROM products WHERE id = ?').get(product.id);
  const newStock = r2(fresh.stock + qty);
  const avgCost = newStock > 0
    ? r2((fresh.stock * fresh.cost + qty * unitCost) / newStock)
    : unitCost;

  db.prepare('UPDATE products SET stock = ?, cost = ? WHERE id = ?').run(newStock, avgCost, product.id);
  insertMove.run(product.id, date, 'IN', qty, unitCost, newStock, 'PO-DEMO', 'MANUAL', 'Pembelian stok awal', 1);

  const value = r2(qty * unitCost);
  postJournal({
    date,
    description: `Stok Masuk — ${product.name} (${qty} ${product.unit})`,
    lines: [
      { code: ACC.INVENTORY, debit: value, credit: 0 },
      { code: payment === 'CREDIT' ? ACC.AP : ACC.BANK, debit: 0, credit: value },
    ],
    source: 'STOCK',
    userId: 1,
  });
});

for (const p of products) {
  // Dua gelombang pembelian agar HPP rata-rata bergerak terlihat nyata
  restock(p, between(30, 80), p.cost, daysAgo(55), 'BANK');
  restock(p, between(20, 50), Math.round(p.cost * (1 + Math.random() * 0.12)), daysAgo(28), 'CREDIT');
}
console.log('Pembelian stok demo selesai.');

// ------------------------------------------------------------------
// 5. Penjualan multi-channel selama 45 hari terakhir
// ------------------------------------------------------------------
const CHANNEL_PROFILE = {
  OFFLINE_WA:  { weight: 25, adminPct: 0,   packing: 2000, ongkir: 0,     voucher: 0 },
  SOCIAL_MEDIA:{ weight: 15, adminPct: 0,   packing: 3000, ongkir: 8000,  voucher: 0 },
  WEBSITE:     { weight: 10, adminPct: 2.9, packing: 3000, ongkir: 5000,  voucher: 0 },
  SHOPEE:      { weight: 25, adminPct: 8,   packing: 3000, ongkir: 12000, voucher: 15000 },
  TOKOPEDIA:   { weight: 15, adminPct: 6.5, packing: 3000, ongkir: 10000, voucher: 10000 },
  TIKTOK_SHOP: { weight: 10, adminPct: 8,   packing: 3000, ongkir: 14000, voucher: 20000 },
};

const channelPool = Object.entries(CHANNEL_PROFILE).flatMap(([key, cfg]) =>
  Array(cfg.weight).fill(key)
);

const CHANNEL_LABEL = {
  OFFLINE_WA: 'Offline / WhatsApp',
  SOCIAL_MEDIA: 'Social Media',
  WEBSITE: 'Website',
  SHOPEE: 'Shopee',
  TOKOPEDIA: 'Tokopedia',
  TIKTOK_SHOP: 'TikTok Shop',
};

const CUSTOMERS = [
  'Toko Berkah Jaya', 'Ibu Wulan', 'Warung Sari Rasa', 'Pak Hendra',
  'Minimarket Amanah', 'Dewi Anggraini', 'Toko Oleh-oleh Mekar', 'Agus Setiawan',
  'Cafe Sudut Kota', 'Ny. Purwanti', null, null,
];

const insertOrder = db.prepare(
  `INSERT INTO sales_orders (
     order_no, order_date, channel, customer, marketplace_ref,
     gross_sales, discount, cogs,
     admin_fee_pct, admin_fee, handling_fee, shipping_extra, voucher_platform,
     tax_pct, tax_amount, packing_cost, other_cost,
     net_revenue, total_fees, gross_profit, net_profit, margin_pct,
     payment_status, status, note, user_id
   ) VALUES (?,?,?,?,?, ?,?,?, ?,?,?,?,?, ?,?,?,?, ?,?,?,?,?, ?, 'POSTED', ?, ?)`
);
const insertItem = db.prepare(
  `INSERT INTO sales_items (order_id, product_id, qty, price, cost, subtotal, subcost)
   VALUES (?,?,?,?,?,?,?)`
);

const createDemoOrder = db.transaction((date) => {
  const channel = pick(channelPool);
  const cfg = CHANNEL_PROFILE[channel];

  // 1–3 item per order, hanya produk yang stoknya cukup
  const itemCount = between(1, 3);
  const chosen = [];
  for (let i = 0; i < itemCount; i += 1) {
    const p = pick(products);
    const fresh = db.prepare('SELECT * FROM products WHERE id = ?').get(p.id);
    const qty = between(1, 4);
    if (fresh.stock < qty) continue;
    if (chosen.some((c) => c.product_id === fresh.id)) continue;
    chosen.push({
      product_id: fresh.id,
      product: fresh,
      qty,
      price: fresh.price,
      cost: fresh.cost,
      subtotal: r2(qty * fresh.price),
      subcost: r2(qty * fresh.cost),
    });
  }
  if (chosen.length === 0) return null;

  const gross_sales = r2(chosen.reduce((s, i) => s + i.subtotal, 0));
  const cogs = r2(chosen.reduce((s, i) => s + i.subcost, 0));
  const discount = Math.random() < 0.25 ? r2(gross_sales * 0.05) : 0;
  const net_revenue = r2(gross_sales - discount);

  const admin_fee = r2((net_revenue * cfg.adminPct) / 100);
  const shipping_extra = Math.random() < 0.6 ? cfg.ongkir : 0;
  const voucher_platform = Math.random() < 0.35 ? cfg.voucher : 0;
  const packing_cost = cfg.packing;
  const handling_fee = channel === 'SHOPEE' || channel === 'TIKTOK_SHOP' ? 1250 : 0;

  const total_fees = r2(admin_fee + handling_fee + shipping_extra + voucher_platform + packing_cost);
  const gross_profit = r2(net_revenue - cogs);
  const net_profit = r2(gross_profit - total_fees);
  const margin_pct = net_revenue ? r2((net_profit / net_revenue) * 100) : 0;

  const orderNo = nextNumber('SO', date.slice(0, 7));
  const userId = pick(users).id;
  const payment_status = Math.random() < 0.12 ? 'UNPAID' : 'PAID';

  const info = insertOrder.run(
    orderNo, date, channel, pick(CUSTOMERS),
    ['SHOPEE', 'TOKOPEDIA', 'TIKTOK_SHOP'].includes(channel) ? `INV/${between(100000, 999999)}` : null,
    gross_sales, discount, cogs,
    cfg.adminPct, admin_fee, handling_fee, shipping_extra, voucher_platform,
    0, 0, packing_cost, 0,
    net_revenue, total_fees, gross_profit, net_profit, margin_pct,
    payment_status, null, userId
  );

  const orderId = info.lastInsertRowid;

  for (const it of chosen) {
    insertItem.run(orderId, it.product_id, it.qty, it.price, it.cost, it.subtotal, it.subcost);

    const fresh = db.prepare('SELECT stock FROM products WHERE id = ?').get(it.product_id);
    const newStock = r2(fresh.stock - it.qty);
    db.prepare('UPDATE products SET stock = ? WHERE id = ?').run(newStock, it.product_id);
    insertMove.run(
      it.product_id, date, 'OUT', it.qty, it.cost, newStock, orderNo, 'SALES',
      `Penjualan ${CHANNEL_LABEL[channel]}`, userId
    );
  }

  postJournal({
    date,
    description: `Penjualan ${orderNo} — ${CHANNEL_LABEL[channel]}`,
    lines: buildSalesJournalLines({
      channel, payment_status,
      gross_sales, discount, cogs, admin_fee, handling_fee, shipping_extra,
      voucher_platform, tax_amount: 0, packing_cost, other_cost: 0,
      net_revenue, total_fees,
    }),
    source: 'SALES',
    sourceId: orderId,
    userId,
  });

  return orderNo;
});

let orderCount = 0;
for (let day = 45; day >= 0; day -= 1) {
  const date = daysAgo(day);
  const isWeekend = [0, 6].includes(new Date(`${date}T00:00:00`).getDay());
  const ordersToday = isWeekend ? between(1, 3) : between(2, 6);

  for (let i = 0; i < ordersToday; i += 1) {
    if (createDemoOrder(date)) orderCount += 1;
  }
}
console.log(`Order penjualan demo: ${orderCount}`);

// ------------------------------------------------------------------
// 6. Beban operasional bulanan
// ------------------------------------------------------------------
const EXPENSES = [
  ['6110', 'Sewa gudang & toko', 3_500_000],
  ['6100', 'Gaji karyawan', 8_400_000],
  ['6120', 'Listrik, air & internet', 1_250_000],
  ['6050', 'Iklan Shopee & Meta Ads', 2_800_000],
  ['6130', 'Transportasi & BBM', 950_000],
];

for (const monthOffset of [1, 0]) {
  const date = daysAgo(monthOffset * 30 + 3);
  for (const [code, label, amount] of EXPENSES) {
    postJournal({
      date,
      description: `${label} periode ${date.slice(0, 7)}`,
      lines: [
        { code, debit: amount, credit: 0 },
        { code: ACC.BANK, debit: 0, credit: amount },
      ],
      source: 'MANUAL',
      userId: 1,
    });
  }
}
console.log('Beban operasional demo dicatat.');

// ------------------------------------------------------------------
// 7. Presensi 21 hari kerja terakhir
// ------------------------------------------------------------------
const office = db.prepare('SELECT * FROM offices WHERE active = 1 LIMIT 1').get();
const insertAttendance = db.prepare(
  `INSERT INTO attendance
     (user_id, work_date, work_type, check_in_at, in_lat, in_lng, in_accuracy_m,
      in_address, in_office_id, in_distance_m, in_inside_geofence,
      check_out_at, out_lat, out_lng, out_accuracy_m,
      status, late_minutes, work_minutes, notes)
   VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
   ON CONFLICT(user_id, work_date) DO NOTHING`
);

let attendanceCount = 0;
for (let day = 30; day >= 1; day -= 1) {
  const date = daysAgo(day);
  const dow = new Date(`${date}T00:00:00`).getDay();
  if (dow === 0) continue; // Minggu libur

  for (const user of users) {
    if (Math.random() < 0.08) continue; // sesekali tidak masuk

    const roll = Math.random();
    const workType = roll < 0.72 ? 'WFO' : roll < 0.9 ? 'WFH' : 'DINAS_LUAR';

    // Jam masuk 07:35–08:45
    const inMinutes = between(7 * 60 + 35, 8 * 60 + 45);
    const lateMinutes = Math.max(0, inMinutes - (8 * 60 + 10)); // toleransi 10 menit
    const outMinutes = between(16 * 60 + 45, 18 * 60);

    const toIso = (mins) => {
      const d = new Date(`${date}T00:00:00+07:00`);
      d.setMinutes(d.getMinutes() + mins);
      return d.toISOString();
    };

    // WFO di dalam radius; WFH/Dinas menyebar di sekitar kota
    const jitter = workType === 'WFO' ? 0.0006 : 0.02;
    const lat = office.lat + (Math.random() - 0.5) * jitter;
    const lng = office.lng + (Math.random() - 0.5) * jitter;
    const distance = workType === 'WFO' ? between(5, 90) : between(800, 6000);

    insertAttendance.run(
      user.id, date, workType, toIso(inMinutes), lat, lng, between(5, 25),
      workType === 'WFO' ? 'Kantor Pusat' : workType === 'WFH' ? 'Rumah' : 'Kunjungan mitra',
      workType === 'WFO' ? office.id : null,
      distance, workType === 'WFO' ? 1 : 0,
      toIso(outMinutes), lat, lng, between(5, 25),
      lateMinutes > 0 ? 'LATE' : 'ONTIME', lateMinutes, outMinutes - inMinutes,
      workType === 'DINAS_LUAR' ? 'Kunjungan ke toko mitra' : null
    );
    attendanceCount += 1;
  }
}
console.log(`Catatan presensi demo: ${attendanceCount}`);

// ------------------------------------------------------------------
// Ringkasan
// ------------------------------------------------------------------
const summary = {
  produk: db.prepare("SELECT COUNT(*) c FROM products WHERE sku LIKE 'DMK-%'").get().c,
  order: db.prepare('SELECT COUNT(*) c FROM sales_orders').get().c,
  jurnal: db.prepare('SELECT COUNT(*) c FROM journals').get().c,
  mutasi: db.prepare('SELECT COUNT(*) c FROM stock_moves').get().c,
  presensi: db.prepare('SELECT COUNT(*) c FROM attendance').get().c,
};

console.log('\nData demo siap:');
console.table(summary);
console.log('Login tambahan (semua password: Demo#12345):');
for (const [name, email, role] of DEMO_USERS) console.log(`  ${email}  — ${role} (${name})`);
console.log('');
