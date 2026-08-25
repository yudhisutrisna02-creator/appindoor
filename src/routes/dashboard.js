'use strict';
const express = require('express');
const { db, getSetting } = require('../db');
const { requireAuth } = require('../middleware/auth');
const { ah, dateRange } = require('../utils/http');
const { r2 } = require('../utils/accounting');
const { incomeStatement, balanceSheet, cashFlow } = require('../utils/reports');
const { todayLocal } = require('../utils/time');

const router = express.Router();
router.use(requireAuth);

/**
 * GET /api/dashboard — ringkasan lintas keempat modul untuk halaman utama.
 */
router.get('/', ah((req, res) => {
  const { from, to } = dateRange(req.query);
  const today = todayLocal();

  // --- Modul 1: Presensi ---
  const attendanceToday = db
    .prepare(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN status = 'LATE' THEN 1 ELSE 0 END) AS late,
              SUM(CASE WHEN work_type = 'WFO' THEN 1 ELSE 0 END) AS wfo,
              SUM(CASE WHEN work_type = 'WFH' THEN 1 ELSE 0 END) AS wfh,
              SUM(CASE WHEN work_type = 'DINAS_LUAR' THEN 1 ELSE 0 END) AS dinas
         FROM attendance WHERE work_date = ?`
    )
    .get(today);

  const activeEmployees = db.prepare('SELECT COUNT(*) AS c FROM users WHERE active = 1').get().c;

  // --- Modul 3: Persediaan ---
  const inventory = db
    .prepare(
      `SELECT COUNT(*) AS sku_count,
              COALESCE(SUM(stock), 0) AS total_qty,
              COALESCE(SUM(stock * cost), 0) AS total_value,
              COALESCE(SUM(stock * price), 0) AS potential_revenue,
              SUM(CASE WHEN stock <= min_stock THEN 1 ELSE 0 END) AS low_stock_count
         FROM products WHERE active = 1`
    )
    .get();

  // --- Modul 4: Penjualan ---
  const sales = db
    .prepare(
      `SELECT COUNT(*) AS orders,
              COALESCE(SUM(gross_sales), 0) AS gross_sales,
              COALESCE(SUM(net_revenue), 0) AS net_revenue,
              COALESCE(SUM(cogs), 0) AS cogs,
              COALESCE(SUM(total_fees), 0) AS total_fees,
              COALESCE(SUM(net_profit), 0) AS net_profit
         FROM sales_orders
        WHERE order_date BETWEEN ? AND ? AND status = 'POSTED'`
    )
    .get(from, to);

  const byChannel = db
    .prepare(
      `SELECT channel, COUNT(*) AS orders,
              COALESCE(SUM(net_revenue), 0) AS net_revenue,
              COALESCE(SUM(net_profit), 0)  AS net_profit
         FROM sales_orders
        WHERE order_date BETWEEN ? AND ? AND status = 'POSTED'
        GROUP BY channel ORDER BY net_profit DESC`
    )
    .all(from, to)
    .map((c) => ({ ...c, margin_pct: c.net_revenue ? r2((c.net_profit / c.net_revenue) * 100) : 0 }));

  const dailyTrend = db
    .prepare(
      `SELECT order_date AS date,
              COALESCE(SUM(net_revenue), 0) AS revenue,
              COALESCE(SUM(net_profit), 0)  AS profit
         FROM sales_orders
        WHERE order_date BETWEEN ? AND ? AND status = 'POSTED'
        GROUP BY order_date ORDER BY order_date`
    )
    .all(from, to);

  // --- Modul 2: Keuangan ---
  const pnl = incomeStatement(from, to);
  const bs = balanceSheet(to);
  const cf = cashFlow(from, to);

  res.json({
    period: { from, to, today },
    company: getSetting('company_name', 'Perusahaan'),
    attendance: {
      today: {
        present: attendanceToday.total || 0,
        late: attendanceToday.late || 0,
        wfo: attendanceToday.wfo || 0,
        wfh: attendanceToday.wfh || 0,
        dinas: attendanceToday.dinas || 0,
        absent: Math.max(0, activeEmployees - (attendanceToday.total || 0)),
      },
      activeEmployees,
    },
    inventory: {
      skuCount: inventory.sku_count,
      totalQty: r2(inventory.total_qty),
      totalValue: r2(inventory.total_value),
      potentialRevenue: r2(inventory.potential_revenue),
      potentialMargin: r2(inventory.potential_revenue - inventory.total_value),
      lowStockCount: inventory.low_stock_count || 0,
    },
    sales: {
      orders: sales.orders,
      grossSales: r2(sales.gross_sales),
      netRevenue: r2(sales.net_revenue),
      cogs: r2(sales.cogs),
      totalFees: r2(sales.total_fees),
      netProfit: r2(sales.net_profit),
      marginPct: sales.net_revenue ? r2((sales.net_profit / sales.net_revenue) * 100) : 0,
      byChannel,
      dailyTrend,
    },
    finance: {
      netSales: pnl.netSales,
      grossProfit: pnl.grossProfit,
      opex: pnl.opex,
      netProfit: pnl.netProfit,
      netMarginPct: pnl.netMarginPct,
      cash: bs.assets.current.totalCash,
      receivable: bs.assets.current.totalReceivable,
      inventoryValue: bs.assets.current.totalInventory,
      totalAssets: bs.assets.total,
      totalLiabilities: bs.liabilities.total,
      totalEquity: bs.equity.total,
      balanced: bs.balanced,
      ocf: cf.operating.total,
      icf: cf.investing.total,
      fcf: cf.financing.total,
      netCashChange: cf.netChange,
      closingCash: cf.closingCash,
    },
    alerts: buildAlerts(inventory, bs, pnl),
  });
}));

/** Peringatan operasional ringkas untuk kartu notifikasi di dashboard. */
function buildAlerts(inventory, bs, pnl) {
  const alerts = [];
  if (inventory.low_stock_count > 0) {
    alerts.push({ level: 'warning', message: `${inventory.low_stock_count} produk berada di bawah stok minimum` });
  }
  if (!bs.balanced) {
    alerts.push({ level: 'danger', message: 'Neraca tidak seimbang — periksa jurnal manual terakhir' });
  }
  if (pnl.netProfit < 0) {
    alerts.push({ level: 'danger', message: `Laba bersih periode ini negatif (Rp ${pnl.netProfit.toLocaleString('id-ID')})` });
  }
  if (pnl.netSales > 0 && pnl.netMarginPct < 10) {
    alerts.push({ level: 'warning', message: `Margin laba bersih tipis (${pnl.netMarginPct}%) — tinjau biaya channel` });
  }
  if (bs.assets.current.totalCash < 0) {
    alerts.push({ level: 'danger', message: 'Saldo kas negatif — ada pengeluaran melebihi kas tercatat' });
  }
  return alerts;
}

module.exports = router;
