'use strict';
const express = require('express');
const { db, getSetting } = require('../db');
const { requireAuth } = require('../middleware/auth');
const { ah, dateRange } = require('../utils/http');
const { r2 } = require('../utils/accounting');
const { incomeStatement, balanceSheet, cashFlow } = require('../utils/reports');
const { todayLocal } = require('../utils/time');
const analisa = require('../utils/insights');
const { CHANNEL_LABEL } = require('../utils/kanal');

const router = express.Router();
router.use(requireAuth);


/**
 * GET /api/dashboard — ringkasan lintas modul + analisis otomatis.
 *
 * Dipecah menjadi tiga bagian realtime (penjualan, presensi, stok) supaya
 * halaman depan bisa menampilkan keadaan hari ini tanpa perlu berpindah menu.
 */
router.get('/', ah((req, res) => {
  const { from, to } = dateRange(req.query);
  const today = todayLocal();

  // ================= PENJUALAN =================
  const ringkas = (klausa, params) => {
    const row = db
      .prepare(
        `SELECT COUNT(*) AS orders,
                COALESCE(SUM(gross_sales), 0)  AS gross_sales,
                COALESCE(SUM(net_revenue), 0)  AS net_revenue,
                COALESCE(SUM(cogs), 0)         AS cogs,
                COALESCE(SUM(total_fees), 0)   AS total_fees,
                COALESCE(SUM(gross_profit), 0) AS gross_profit,
                COALESCE(SUM(net_profit), 0)   AS net_profit
           FROM sales_orders
          WHERE status = 'POSTED' ${klausa}`
      )
      .get(...params);

    return {
      orders: row.orders,
      grossSales: r2(row.gross_sales),
      // netRevenue = penjualan − diskon, sebelum potongan marketplace.
      // Di layar disebut Pendapatan Kotor karena uang sebesar itu tidak pernah
      // benar-benar masuk rekening.
      netRevenue: r2(row.net_revenue),
      netReceived: r2(row.net_revenue - row.total_fees),
      cogs: r2(row.cogs),
      totalFees: r2(row.total_fees),
      grossProfit: r2(row.gross_profit),
      netProfit: r2(row.net_profit),
      marginPct: row.net_revenue ? r2((row.net_profit / row.net_revenue) * 100) : 0,
      avgOrderValue: row.orders ? r2(row.net_revenue / row.orders) : 0,
    };
  };

  const hariIni = ringkas('AND order_date = ?', [today]);
  const kemarin = ringkas("AND order_date = date(?, '-1 day')", [today]);
  const periode = ringkas('AND order_date BETWEEN ? AND ?', [from, to]);
  const bulanIni = ringkas("AND strftime('%Y-%m', order_date) = strftime('%Y-%m', ?)", [today]);

  const byChannel = db
    .prepare(
      `SELECT channel, COUNT(*) AS orders,
              COALESCE(SUM(net_revenue), 0) AS net_revenue,
              COALESCE(SUM(net_profit), 0)  AS net_profit
         FROM sales_orders
        WHERE status = 'POSTED' AND order_date BETWEEN ? AND ?
        GROUP BY channel ORDER BY net_profit DESC`
    )
    .all(from, to)
    .map((c) => ({
      ...c,
      label: CHANNEL_LABEL[c.channel] || c.channel,
      net_revenue: r2(c.net_revenue),
      net_profit: r2(c.net_profit),
      margin_pct: c.net_revenue ? r2((c.net_profit / c.net_revenue) * 100) : 0,
    }));

  const dailyTrend = db
    .prepare(
      `SELECT order_date AS date,
              COUNT(*) AS orders,
              COALESCE(SUM(net_revenue), 0) AS revenue,
              COALESCE(SUM(net_profit), 0)  AS profit
         FROM sales_orders
        WHERE status = 'POSTED' AND order_date BETWEEN ? AND ?
        GROUP BY order_date ORDER BY order_date`
    )
    .all(from, to);

  const orderTerbaru = db
    .prepare(
      `SELECT o.order_no, o.order_date, o.channel, o.net_profit, o.margin_pct,
              o.fulfillment_status, o.buyer_name, o.buyer_city, o.courier,
              sh.name AS shop_name
         FROM sales_orders o
         LEFT JOIN shops sh ON sh.id = o.shop_id
        WHERE o.status = 'POSTED'
        ORDER BY o.created_at DESC, o.id DESC
        LIMIT 8`
    )
    .all()
    .map((o) => ({ ...o, label: CHANNEL_LABEL[o.channel] || o.channel }));

  const statusPencairan = db
    .prepare(
      `SELECT fulfillment_status AS status, COUNT(*) AS orders,
              COALESCE(SUM(net_revenue - total_fees), 0) AS nilai
         FROM sales_orders
        WHERE status = 'POSTED' AND order_date BETWEEN ? AND ?
        GROUP BY fulfillment_status ORDER BY orders DESC`
    )
    .all(from, to)
    .map((s) => ({ ...s, nilai: r2(s.nilai) }));

  const produkTeratas = db
    .prepare(
      `SELECT p.sku, p.name, p.unit,
              SUM(i.qty) AS qty,
              SUM(i.subtotal) AS revenue,
              SUM(i.subtotal - i.subcost) AS profit
         FROM sales_items i
         JOIN sales_orders o ON o.id = i.order_id
         JOIN products p     ON p.id = i.product_id
        WHERE o.status = 'POSTED' AND o.order_date BETWEEN ? AND ?
        GROUP BY p.id ORDER BY profit DESC LIMIT 8`
    )
    .all(from, to)
    .map((p) => ({ ...p, revenue: r2(p.revenue), profit: r2(p.profit) }));

  // ================= PRESENSI =================
  const absenHariIni = db
    .prepare(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN status = 'LATE'   THEN 1 ELSE 0 END) AS late,
              SUM(CASE WHEN status = 'LEAVE'  THEN 1 ELSE 0 END) AS leave_,
              SUM(CASE WHEN work_type = 'WFO' THEN 1 ELSE 0 END) AS wfo,
              SUM(CASE WHEN work_type = 'WFH' THEN 1 ELSE 0 END) AS wfh,
              SUM(CASE WHEN work_type = 'DINAS_LUAR' THEN 1 ELSE 0 END) AS dinas,
              SUM(CASE WHEN check_out_at IS NOT NULL THEN 1 ELSE 0 END) AS pulang
         FROM attendance WHERE work_date = ?`
    )
    .get(today);

  const karyawanAktif = db.prepare('SELECT COUNT(*) AS c FROM users WHERE active = 1').get().c;

  const absenTerbaru = db
    .prepare(
      `SELECT u.name, u.position, a.work_type, a.status, a.check_in_at, a.check_out_at,
              a.late_minutes, a.in_inside_geofence, a.in_distance_m, o.name AS office_name
         FROM attendance a
         JOIN users u ON u.id = a.user_id
         LEFT JOIN offices o ON o.id = a.in_office_id
        WHERE a.work_date = ?
        ORDER BY a.check_in_at DESC NULLS LAST
        LIMIT 10`
    )
    .all(today);

  const trenAbsen = db
    .prepare(
      `SELECT work_date AS date,
              COUNT(*) AS hadir,
              SUM(CASE WHEN status = 'LATE' THEN 1 ELSE 0 END) AS telat
         FROM attendance
        WHERE work_date BETWEEN ? AND ?
        GROUP BY work_date ORDER BY work_date`
    )
    .all(from, to);

  // ================= STOK =================
  const stok = db
    .prepare(
      `SELECT COUNT(*) AS sku_count,
              COALESCE(SUM(stock), 0) AS total_qty,
              COALESCE(SUM(stock * cost), 0)  AS total_value,
              COALESCE(SUM(stock * price), 0) AS potential_revenue,
              SUM(CASE WHEN min_stock > 0 AND stock <= min_stock THEN 1 ELSE 0 END) AS low_stock_count,
              SUM(CASE WHEN stock <= 0 THEN 1 ELSE 0 END) AS out_of_stock_count
         FROM products WHERE active = 1`
    )
    .get();

  const mutasiTerbaru = db
    .prepare(
      `SELECT m.move_date, m.move_type, m.qty, m.unit_cost, m.balance_after,
              p.name AS product_name, p.sku, p.unit, u.name AS user_name
         FROM stock_moves m
         JOIN products p ON p.id = m.product_id
         LEFT JOIN users u ON u.id = m.user_id
        ORDER BY m.created_at DESC, m.id DESC
        LIMIT 8`
    )
    .all();

  const nilaiPerKategori = db
    .prepare(
      `SELECT category, COUNT(*) AS skus,
              COALESCE(SUM(stock * cost), 0) AS value
         FROM products WHERE active = 1
        GROUP BY category ORDER BY value DESC`
    )
    .all()
    .map((k) => ({ ...k, value: r2(k.value) }));

  // ================= KEUANGAN =================
  const pnl = incomeStatement(from, to);
  const bs = balanceSheet(to);
  const cf = cashFlow(from, to);

  // ================= IKLAN =================
  // Iklan tidak menempel pada pesanan mana pun, jadi angkanya diambil terpisah
  // lalu dikurangkan dari laba periode yang sama.
  const iklanPeriode = db
    .prepare('SELECT COALESCE(SUM(amount), 0) AS total, COUNT(*) AS n FROM ad_spends WHERE spend_date BETWEEN ? AND ?')
    .get(from, to);
  const iklanHariIni = db
    .prepare('SELECT COALESCE(SUM(amount), 0) AS total FROM ad_spends WHERE spend_date = ?')
    .get(today);
  const iklanBulanIni = db
    .prepare("SELECT COALESCE(SUM(amount), 0) AS total FROM ad_spends WHERE strftime('%Y-%m', spend_date) = strftime('%Y-%m', ?)")
    .get(today);

  const iklanPerToko = db
    .prepare(
      `SELECT a.shop_id, COALESCE(s.name, 'Tanpa toko') AS shop_name,
              COALESCE(SUM(a.amount), 0) AS iklan
         FROM ad_spends a LEFT JOIN shops s ON s.id = a.shop_id
        WHERE a.spend_date BETWEEN ? AND ?
        GROUP BY a.shop_id ORDER BY iklan DESC`
    )
    .all(from, to)
    .map((x) => ({ ...x, iklan: r2(x.iklan) }));

  const iklan = {
    hariIni: r2(iklanHariIni.total),
    periode: r2(iklanPeriode.total),
    bulanIni: r2(iklanBulanIni.total),
    jumlahCatatan: iklanPeriode.n,
    perToko: iklanPerToko,
    labaSetelahIklan: r2(periode.netProfit - iklanPeriode.total),
    labaHariIniSetelahIklan: r2(hariIni.netProfit - iklanHariIni.total),
    roas: iklanPeriode.total > 0 ? r2(periode.netRevenue / iklanPeriode.total) : null,
    rasioPct: periode.netRevenue > 0 ? r2((iklanPeriode.total / periode.netRevenue) * 100) : null,
  };

  // ================= ANALISIS =================
  const toko = analisa.performaToko(from, to);
  const akanHabis = analisa.stokAkanHabis();
  const mati = analisa.stokMati();
  const tertahan = analisa.danaTertahan();
  const ongkir = analisa.bebanOngkir(from, to);
  const telat = analisa.seringTerlambat(from, to);

  const temuan = analisa.susunTemuan({
    from, to, toko, akanHabis, mati, tertahan, ongkir, telat,
    ringkasPenjualan: periode,
  });

  res.json({
    period: { from, to, today },
    company: getSetting('company_name', 'Perusahaan'),

    penjualan: {
      hariIni,
      kemarin,
      periode,
      bulanIni,
      byChannel,
      dailyTrend,
      orderTerbaru,
      statusPencairan,
      produkTeratas,
      toko,
      ongkir,
      danaTertahan: tertahan,
      kota: analisa.kotaTeratas(from, to),
      ekspedisi: analisa.ekspedisiTeratas(from, to),
      iklan,
    },

    presensi: {
      hariIni: {
        hadir: absenHariIni.total || 0,
        telat: absenHariIni.late || 0,
        izin: absenHariIni.leave_ || 0,
        wfo: absenHariIni.wfo || 0,
        wfh: absenHariIni.wfh || 0,
        dinas: absenHariIni.dinas || 0,
        sudahPulang: absenHariIni.pulang || 0,
        belumAbsen: Math.max(0, karyawanAktif - (absenHariIni.total || 0)),
      },
      karyawanAktif,
      terbaru: absenTerbaru,
      tren: trenAbsen,
      seringTerlambat: telat,
    },

    stok: {
      skuCount: stok.sku_count,
      totalQty: r2(stok.total_qty),
      totalValue: r2(stok.total_value),
      potentialRevenue: r2(stok.potential_revenue),
      potentialMargin: r2(stok.potential_revenue - stok.total_value),
      lowStockCount: stok.low_stock_count || 0,
      outOfStockCount: stok.out_of_stock_count || 0,
      mutasiTerbaru,
      nilaiPerKategori,
      akanHabis: akanHabis.slice(0, 10),
      stokMati: mati.slice(0, 10),
    },

    keuangan: {
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

    temuan,
  });
}));

module.exports = router;
