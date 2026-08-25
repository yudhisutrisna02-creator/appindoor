'use strict';
const express = require('express');
const { z } = require('zod');
const { db, nextNumber } = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');
const { ah, parse, httpError, dateRange } = require('../utils/http');
const { r2, ACC, postJournal, deleteJournalsBySource, buildSalesJournalLines } = require('../utils/accounting');
const { tableExcel } = require('../utils/exporters');
const { todayLocal } = require('../utils/time');

const router = express.Router();
router.use(requireAuth);

const CHANNELS = ['OFFLINE_WA', 'SOCIAL_MEDIA', 'WEBSITE', 'SHOPEE', 'TOKOPEDIA', 'TIKTOK_SHOP'];
const CHANNEL_LABEL = {
  OFFLINE_WA: 'Offline / WhatsApp',
  SOCIAL_MEDIA: 'Social Media',
  WEBSITE: 'Website',
  SHOPEE: 'Shopee',
  TOKOPEDIA: 'Tokopedia',
  TIKTOK_SHOP: 'TikTok Shop',
};

const orderSchema = z.object({
  order_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).default(() => todayLocal()),
  channel: z.enum(CHANNELS),
  customer: z.string().max(120).optional().nullable(),
  partner_id: z.number().int().positive().optional().nullable(),
  due_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().nullable(),
  marketplace_ref: z.string().max(80).optional().nullable(),
  items: z
    .array(
      z.object({
        product_id: z.number().int().positive(),
        qty: z.number().positive(),
        price: z.number().nonnegative(),
      })
    )
    .min(1, 'minimal satu item produk'),

  discount: z.number().nonnegative().default(0),
  admin_fee_pct: z.number().min(0).max(100).default(0),
  admin_fee: z.number().nonnegative().optional(),
  handling_fee: z.number().nonnegative().default(0),
  shipping_extra: z.number().nonnegative().default(0),
  voucher_platform: z.number().nonnegative().default(0),
  tax_pct: z.number().min(0).max(100).default(0),
  tax_amount: z.number().nonnegative().optional(),
  packing_cost: z.number().nonnegative().default(0),
  other_cost: z.number().nonnegative().default(0),

  payment_status: z.enum(['PAID', 'UNPAID']).default('PAID'),
  note: z.string().max(300).optional().nullable(),
});

/**
 * Menghitung seluruh struktur biaya & margin satu order.
 * Dipakai baik saat menyimpan maupun saat pratinjau di frontend.
 */
function computeOrder(input, items) {
  const gross_sales = r2(items.reduce((s, i) => s + i.subtotal, 0));
  const cogs = r2(items.reduce((s, i) => s + i.subcost, 0));
  const discount = r2(input.discount);
  const net_revenue = r2(gross_sales - discount);

  // Persentase dihitung dari pendapatan bersih; nilai eksplisit menang bila dikirim.
  const admin_fee = input.admin_fee != null
    ? r2(input.admin_fee)
    : r2((net_revenue * input.admin_fee_pct) / 100);
  const tax_amount = input.tax_amount != null
    ? r2(input.tax_amount)
    : r2((net_revenue * input.tax_pct) / 100);

  const total_fees = r2(
    admin_fee +
      r2(input.handling_fee) +
      r2(input.shipping_extra) +
      r2(input.voucher_platform) +
      tax_amount +
      r2(input.packing_cost) +
      r2(input.other_cost)
  );

  const gross_profit = r2(net_revenue - cogs);
  const net_profit = r2(gross_profit - total_fees);
  const margin_pct = net_revenue ? r2((net_profit / net_revenue) * 100) : 0;

  return { gross_sales, cogs, discount, net_revenue, admin_fee, tax_amount, total_fees, gross_profit, net_profit, margin_pct };
}

/** Menyiapkan baris item dengan snapshot HPP saat transaksi. */
function resolveItems(rawItems, { checkStock = true } = {}) {
  return rawItems.map((it) => {
    const product = db.prepare('SELECT * FROM products WHERE id = ?').get(it.product_id);
    if (!product) throw httpError(404, `Produk id ${it.product_id} tidak ditemukan`);
    if (checkStock && it.qty > product.stock) {
      throw httpError(422, `Stok ${product.name} tidak cukup (tersedia ${product.stock} ${product.unit}, diminta ${it.qty})`);
    }
    const qty = r2(it.qty);
    const price = r2(it.price);
    return {
      product,
      product_id: product.id,
      qty,
      price,
      cost: product.cost,
      subtotal: r2(qty * price),
      subcost: r2(qty * product.cost),
    };
  });
}

/** POST /api/sales/preview — hitung margin tanpa menyimpan. */
router.post('/preview', ah((req, res) => {
  const body = parse(orderSchema, req.body);
  const items = resolveItems(body.items, { checkStock: false });
  res.json({
    ...computeOrder(body, items),
    items: items.map((i) => ({
      product_id: i.product_id, name: i.product.name, sku: i.product.sku,
      qty: i.qty, price: i.price, cost: i.cost, subtotal: i.subtotal, subcost: i.subcost,
      margin: r2(i.subtotal - i.subcost),
    })),
  });
}));

/**
 * Menyimpan order: header + item + mutasi stok keluar + jurnal otomatis,
 * seluruhnya dalam satu transaksi database.
 */
const createOrder = db.transaction((body, userId) => {
  const items = resolveItems(body.items);
  const calc = computeOrder(body, items);
  const orderNo = nextNumber('SO', body.order_date.slice(0, 7));

  const info = db
    .prepare(
      `INSERT INTO sales_orders (
         order_no, order_date, channel, customer, marketplace_ref,
         gross_sales, discount, cogs,
         admin_fee_pct, admin_fee, handling_fee, shipping_extra, voucher_platform,
         tax_pct, tax_amount, packing_cost, other_cost,
         net_revenue, total_fees, gross_profit, net_profit, margin_pct,
         payment_status, status, note, user_id, partner_id, due_date
       ) VALUES (?,?,?,?,?, ?,?,?, ?,?,?,?,?, ?,?,?,?, ?,?,?,?,?, ?, 'POSTED', ?, ?, ?, ?)`
    )
    .run(
      orderNo, body.order_date, body.channel, body.customer || null, body.marketplace_ref || null,
      calc.gross_sales, calc.discount, calc.cogs,
      body.admin_fee_pct, calc.admin_fee, r2(body.handling_fee), r2(body.shipping_extra), r2(body.voucher_platform),
      body.tax_pct, calc.tax_amount, r2(body.packing_cost), r2(body.other_cost),
      calc.net_revenue, calc.total_fees, calc.gross_profit, calc.net_profit, calc.margin_pct,
      body.payment_status, body.note || null, userId,
      body.partner_id || null, body.due_date || null
    );

  const orderId = info.lastInsertRowid;

  const insertItem = db.prepare(
    `INSERT INTO sales_items (order_id, product_id, qty, price, cost, subtotal, subcost)
     VALUES (?,?,?,?,?,?,?)`
  );
  const insertMove = db.prepare(
    `INSERT INTO stock_moves
       (product_id, move_date, move_type, qty, unit_cost, balance_after, ref, source, source_id, note, user_id)
     VALUES (?,?,'OUT',?,?,?,?, 'SALES', ?, ?, ?)`
  );

  for (const it of items) {
    insertItem.run(orderId, it.product_id, it.qty, it.price, it.cost, it.subtotal, it.subcost);

    const newStock = r2(it.product.stock - it.qty);
    db.prepare('UPDATE products SET stock = ? WHERE id = ?').run(newStock, it.product_id);
    insertMove.run(
      it.product_id, body.order_date, it.qty, it.cost, newStock, orderNo, orderId,
      `Penjualan ${CHANNEL_LABEL[body.channel]}`, userId
    );
  }

  const journal = postJournal({
    date: body.order_date,
    description: `Penjualan ${orderNo} — ${CHANNEL_LABEL[body.channel]}`,
    lines: buildSalesJournalLines({ ...body, ...calc }),
    source: 'SALES',
    sourceId: orderId,
    userId,
  });

  return { orderId, orderNo, calc, journal };
});

router.post('/', requireRole('admin', 'manager', 'staff'), ah((req, res) => {
  const body = parse(orderSchema, req.body);
  const result = createOrder(body, req.user.id);
  res.status(201).json({
    ok: true,
    message: `Order ${result.orderNo} tersimpan — laba bersih Rp ${result.calc.net_profit.toLocaleString('id-ID')} (${result.calc.margin_pct}%)`,
    order: db.prepare('SELECT * FROM sales_orders WHERE id = ?').get(result.orderId),
    journal: result.journal,
  });
}));

/** Filter bersama untuk daftar & analisis. */
function orderFilter(query) {
  const { from, to } = dateRange(query);
  const params = [from, to];
  let where = "WHERE o.order_date BETWEEN ? AND ? AND o.status = 'POSTED'";
  if (query.channel && CHANNELS.includes(query.channel)) {
    where += ' AND o.channel = ?';
    params.push(query.channel);
  }
  return { from, to, where, params };
}

/** GET /api/sales — daftar order + ringkasan. */
router.get('/', ah((req, res) => {
  const { from, to, where, params } = orderFilter(req.query);
  const rows = db
    .prepare(
      `SELECT o.*, u.name AS user_name,
              (SELECT COUNT(*) FROM sales_items i WHERE i.order_id = o.id) AS item_count
         FROM sales_orders o LEFT JOIN users u ON u.id = o.user_id
         ${where}
        ORDER BY o.order_date DESC, o.id DESC LIMIT 500`
    )
    .all(...params);

  const sum = (k) => r2(rows.reduce((s, r) => s + r[k], 0));
  const netRevenue = sum('net_revenue');

  res.json({
    from, to, rows,
    summary: {
      orders: rows.length,
      grossSales: sum('gross_sales'),
      netRevenue,
      cogs: sum('cogs'),
      totalFees: sum('total_fees'),
      grossProfit: sum('gross_profit'),
      netProfit: sum('net_profit'),
      marginPct: netRevenue ? r2((sum('net_profit') / netRevenue) * 100) : 0,
      avgOrderValue: rows.length ? r2(netRevenue / rows.length) : 0,
    },
  });
}));

/** GET /api/sales/:id — detail order beserta item. */
router.get('/:id(\\d+)', ah((req, res) => {
  const order = db.prepare('SELECT * FROM sales_orders WHERE id = ?').get(req.params.id);
  if (!order) throw httpError(404, 'Order tidak ditemukan');

  const items = db
    .prepare(
      `SELECT i.*, p.sku, p.name AS product_name, p.unit
         FROM sales_items i JOIN products p ON p.id = i.product_id
        WHERE i.order_id = ?`
    )
    .all(order.id);

  const journal = db
    .prepare("SELECT * FROM journals WHERE source = 'SALES' AND source_id = ?")
    .get(order.id);

  res.json({ order, items, journal });
}));

/**
 * DELETE /api/sales/:id — membatalkan order:
 * stok dikembalikan, mutasi & jurnal terkait dihapus, status jadi CANCELLED.
 */
const cancelOrder = db.transaction((orderId) => {
  const order = db.prepare('SELECT * FROM sales_orders WHERE id = ?').get(orderId);
  if (!order) throw httpError(404, 'Order tidak ditemukan');
  if (order.status === 'CANCELLED') throw httpError(409, 'Order sudah dibatalkan');

  const items = db.prepare('SELECT * FROM sales_items WHERE order_id = ?').all(orderId);

  for (const it of items) {
    const product = db.prepare('SELECT * FROM products WHERE id = ?').get(it.product_id);
    db.prepare('UPDATE products SET stock = ? WHERE id = ?').run(r2(product.stock + it.qty), it.product_id);
  }

  db.prepare("DELETE FROM stock_moves WHERE source = 'SALES' AND source_id = ?").run(orderId);
  deleteJournalsBySource('SALES', orderId);
  db.prepare("UPDATE sales_orders SET status = 'CANCELLED' WHERE id = ?").run(orderId);

  return order.order_no;
});

router.delete('/:id', requireRole('admin', 'manager'), ah((req, res) => {
  const orderNo = cancelOrder(Number(req.params.id));
  res.json({ ok: true, message: `Order ${orderNo} dibatalkan, stok dikembalikan` });
}));

// ==================================================================
// ANALISIS MARGIN PER CHANNEL
// ==================================================================
/** GET /api/sales/analytics — agregasi profitabilitas per channel & produk. */
router.get('/analytics', ah((req, res) => {
  const { from, to } = dateRange(req.query);

  const byChannel = db
    .prepare(
      `SELECT channel,
              COUNT(*)              AS orders,
              SUM(gross_sales)      AS gross_sales,
              SUM(discount)         AS discount,
              SUM(net_revenue)      AS net_revenue,
              SUM(cogs)             AS cogs,
              SUM(admin_fee)        AS admin_fee,
              SUM(handling_fee)     AS handling_fee,
              SUM(shipping_extra)   AS shipping_extra,
              SUM(voucher_platform) AS voucher_platform,
              SUM(tax_amount)       AS tax_amount,
              SUM(packing_cost)     AS packing_cost,
              SUM(other_cost)       AS other_cost,
              SUM(total_fees)       AS total_fees,
              SUM(gross_profit)     AS gross_profit,
              SUM(net_profit)       AS net_profit
         FROM sales_orders
        WHERE order_date BETWEEN ? AND ? AND status = 'POSTED'
        GROUP BY channel
        ORDER BY net_profit DESC`
    )
    .all(from, to)
    .map((r) => ({
      ...r,
      label: CHANNEL_LABEL[r.channel],
      margin_pct: r.net_revenue ? r2((r.net_profit / r.net_revenue) * 100) : 0,
      fee_ratio_pct: r.net_revenue ? r2((r.total_fees / r.net_revenue) * 100) : 0,
      avg_order_value: r.orders ? r2(r.net_revenue / r.orders) : 0,
    }));

  const byProduct = db
    .prepare(
      `SELECT p.id, p.sku, p.name, p.unit,
              SUM(i.qty)      AS qty,
              SUM(i.subtotal) AS revenue,
              SUM(i.subcost)  AS cost,
              SUM(i.subtotal - i.subcost) AS gross_profit
         FROM sales_items i
         JOIN sales_orders o ON o.id = i.order_id
         JOIN products p     ON p.id = i.product_id
        WHERE o.order_date BETWEEN ? AND ? AND o.status = 'POSTED'
        GROUP BY p.id
        ORDER BY gross_profit DESC
        LIMIT 50`
    )
    .all(from, to)
    .map((r) => ({ ...r, margin_pct: r.revenue ? r2((r.gross_profit / r.revenue) * 100) : 0 }));

  const daily = db
    .prepare(
      `SELECT order_date,
              SUM(net_revenue) AS net_revenue,
              SUM(net_profit)  AS net_profit,
              COUNT(*)         AS orders
         FROM sales_orders
        WHERE order_date BETWEEN ? AND ? AND status = 'POSTED'
        GROUP BY order_date ORDER BY order_date`
    )
    .all(from, to);

  const totals = byChannel.reduce(
    (acc, c) => {
      for (const k of ['orders', 'gross_sales', 'net_revenue', 'cogs', 'total_fees', 'gross_profit', 'net_profit']) {
        acc[k] = r2((acc[k] || 0) + (c[k] || 0));
      }
      return acc;
    },
    {}
  );
  totals.margin_pct = totals.net_revenue ? r2((totals.net_profit / totals.net_revenue) * 100) : 0;

  res.json({ from, to, byChannel, byProduct, daily, totals, channelLabels: CHANNEL_LABEL });
}));

router.get('/export/excel', ah(async (req, res) => {
  const { from, to, where, params } = orderFilter(req.query);
  const rows = db.prepare(`SELECT o.* FROM sales_orders o ${where} ORDER BY o.order_date`).all(...params);

  const buffer = await tableExcel(
    'Penjualan',
    [
      { header: 'No. Order', key: 'order_no', width: 20 },
      { header: 'Tanggal', key: 'order_date', width: 12 },
      { header: 'Channel', key: 'channel_label', width: 18 },
      { header: 'Pelanggan', key: 'customer', width: 22 },
      { header: 'Penjualan Kotor', key: 'gross_sales', width: 16, money: true },
      { header: 'Diskon', key: 'discount', width: 12, money: true },
      { header: 'Pendapatan Bersih', key: 'net_revenue', width: 17, money: true },
      { header: 'HPP', key: 'cogs', width: 14, money: true },
      { header: 'Laba Kotor', key: 'gross_profit', width: 15, money: true },
      { header: 'Adm. Marketplace', key: 'admin_fee', width: 16, money: true },
      { header: 'Handling', key: 'handling_fee', width: 12, money: true },
      { header: 'Ongkir Extra', key: 'shipping_extra', width: 13, money: true },
      { header: 'Voucher Platform', key: 'voucher_platform', width: 16, money: true },
      { header: 'Pajak', key: 'tax_amount', width: 12, money: true },
      { header: 'Packing', key: 'packing_cost', width: 12, money: true },
      { header: 'Biaya Lain', key: 'other_cost', width: 12, money: true },
      { header: 'Total Biaya', key: 'total_fees', width: 15, money: true },
      { header: 'Laba Bersih', key: 'net_profit', width: 15, money: true },
      { header: 'Margin (%)', key: 'margin_pct', width: 12 },
    ],
    rows.map((r) => ({ ...r, channel_label: CHANNEL_LABEL[r.channel] })),
    [
      ['Periode', `${from} s/d ${to}`],
      ['Total Order', rows.length],
      ['Total Pendapatan Bersih', r2(rows.reduce((s, r) => s + r.net_revenue, 0))],
      ['Total Laba Bersih', r2(rows.reduce((s, r) => s + r.net_profit, 0))],
    ]
  );

  res
    .set('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
    .set('Content-Disposition', `attachment; filename="penjualan-${from}_${to}.xlsx"`)
    .send(buffer);
}));

// ==================================================================
// RETUR PENJUALAN
// ==================================================================
const returnSchema = z.object({
  return_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).default(() => todayLocal()),
  order_id: z.number().int().positive().optional().nullable(),
  product_id: z.number().int().positive(),
  qty: z.number().positive(),
  price: z.number().nonnegative(),
  restock: z.boolean().default(true),
  reason: z.string().max(300).optional().nullable(),
});

const createReturn = db.transaction((body, userId) => {
  const product = db.prepare('SELECT * FROM products WHERE id = ?').get(body.product_id);
  if (!product) throw httpError(404, 'Produk tidak ditemukan');

  const qty = r2(body.qty);
  const amount = r2(qty * body.price);
  const costValue = r2(qty * product.cost);
  const returnNo = nextNumber('RTN', body.return_date.slice(0, 7));

  const info = db
    .prepare(
      `INSERT INTO sales_returns (return_no, return_date, order_id, product_id, qty, price, cost, amount, restock, reason, user_id)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`
    )
    .run(returnNo, body.return_date, body.order_id || null, product.id, qty, r2(body.price), product.cost, amount, body.restock ? 1 : 0, body.reason || null, userId);

  const lines = [
    { code: ACC.SALES_RETURN, debit: amount, credit: 0, memo: `Retur ${product.name}` },
    { code: ACC.CASH, debit: 0, credit: amount, memo: 'Pengembalian dana pelanggan' },
  ];

  if (body.restock) {
    const newStock = r2(product.stock + qty);
    db.prepare('UPDATE products SET stock = ? WHERE id = ?').run(newStock, product.id);
    db.prepare(
      `INSERT INTO stock_moves (product_id, move_date, move_type, qty, unit_cost, balance_after, ref, source, source_id, note, user_id)
       VALUES (?,?,'IN',?,?,?,?, 'RETURN', ?, 'Retur masuk gudang', ?)`
    ).run(product.id, body.return_date, qty, product.cost, newStock, returnNo, info.lastInsertRowid, userId);

    // Barang kembali ke gudang → HPP dibalik
    lines.push({ code: ACC.INVENTORY, debit: costValue, credit: 0, memo: 'Persediaan kembali' });
    lines.push({ code: ACC.COGS, debit: 0, credit: costValue, memo: 'Pembalikan HPP' });
  }

  postJournal({
    date: body.return_date,
    description: `Retur Penjualan ${returnNo} — ${product.name}`,
    lines,
    source: 'RETURN',
    sourceId: info.lastInsertRowid,
    userId,
  });

  return { id: info.lastInsertRowid, return_no: returnNo, amount };
});

router.post('/returns', requireRole('admin', 'manager', 'staff'), ah((req, res) => {
  const body = parse(returnSchema, req.body);
  res.status(201).json({ ok: true, ...createReturn(body, req.user.id) });
}));

router.get('/returns/list', ah((req, res) => {
  const { from, to } = dateRange(req.query);
  const rows = db
    .prepare(
      `SELECT r.*, p.sku, p.name AS product_name
         FROM sales_returns r JOIN products p ON p.id = r.product_id
        WHERE r.return_date BETWEEN ? AND ?
        ORDER BY r.return_date DESC, r.id DESC`
    )
    .all(from, to);
  res.json({ from, to, rows, total: r2(rows.reduce((s, r) => s + r.amount, 0)) });
}));

module.exports = router;
