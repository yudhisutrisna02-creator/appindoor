'use strict';
/**
 * Toko / akun marketplace.
 *
 * Satu perusahaan bisa punya banyak akun toko pada marketplace yang sama —
 * di data pengguna ada 8 toko Shopee dan 3 TikTok. Profitabilitas antar toko
 * bisa berbeda jauh, jadi toko diperlakukan sebagai dimensi tersendiri, bukan
 * sekadar teks pada order.
 */
const express = require('express');
const { z } = require('zod');
const { db } = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');
const { ah, parse, httpError, dateRange } = require('../utils/http');
const { r2 } = require('../utils/accounting');

const router = express.Router();
router.use(requireAuth);

const { CHANNELS } = require('../utils/kanal');

const shopSchema = z.object({
  name: z.string().trim().min(1, 'nama toko wajib diisi').max(100),
  channel: z.enum(CHANNELS).default('SHOPEE'),
  note: z.string().trim().max(300).optional().nullable(),
  active: z.boolean().default(true),
});

/** GET /api/shops — daftar toko beserta ringkasan performanya. */
router.get('/', ah((req, res) => {
  const { from, to } = dateRange(req.query);

  const rows = db
    .prepare(
      `SELECT s.*,
              COUNT(o.id)                       AS orders,
              COALESCE(SUM(o.net_revenue), 0)   AS net_revenue,
              COALESCE(SUM(o.cogs), 0)          AS cogs,
              COALESCE(SUM(o.total_fees), 0)    AS total_fees,
              COALESCE(SUM(o.net_profit), 0)    AS net_profit
         FROM shops s
         LEFT JOIN sales_orders o
                ON o.shop_id = s.id
               AND o.status = 'POSTED'
               AND o.order_date BETWEEN ? AND ?
        ${req.query.includeInactive === '1' ? '' : 'WHERE s.active = 1'}
        GROUP BY s.id
        ORDER BY net_profit DESC, s.name`
    )
    .all(from, to)
    .map((s) => ({
      ...s,
      net_revenue: r2(s.net_revenue),
      cogs: r2(s.cogs),
      total_fees: r2(s.total_fees),
      net_profit: r2(s.net_profit),
      margin_pct: s.net_revenue ? r2((s.net_profit / s.net_revenue) * 100) : 0,
      avg_order_value: s.orders ? r2(s.net_revenue / s.orders) : 0,
    }));

  res.json({ from, to, shops: rows });
}));

router.post('/', requireRole('admin', 'manager'), ah((req, res) => {
  const s = parse(shopSchema, req.body);
  if (db.prepare('SELECT id FROM shops WHERE name = ?').get(s.name)) {
    throw httpError(409, `Toko "${s.name}" sudah terdaftar`);
  }
  const info = db
    .prepare('INSERT INTO shops (name, channel, note, active) VALUES (?,?,?,?)')
    .run(s.name, s.channel, s.note || null, s.active ? 1 : 0);

  res.status(201).json({ ok: true, shop: db.prepare('SELECT * FROM shops WHERE id = ?').get(info.lastInsertRowid) });
}));

router.put('/:id', requireRole('admin', 'manager'), ah((req, res) => {
  const s = parse(shopSchema, req.body);
  const existing = db.prepare('SELECT * FROM shops WHERE id = ?').get(req.params.id);
  if (!existing) throw httpError(404, 'Toko tidak ditemukan');

  const dupe = db.prepare('SELECT id FROM shops WHERE name = ? AND id <> ?').get(s.name, existing.id);
  if (dupe) throw httpError(409, `Toko "${s.name}" sudah terdaftar`);

  db.prepare('UPDATE shops SET name=?, channel=?, note=?, active=? WHERE id=?')
    .run(s.name, s.channel, s.note || null, s.active ? 1 : 0, existing.id);

  res.json({ ok: true, shop: db.prepare('SELECT * FROM shops WHERE id = ?').get(existing.id) });
}));

router.delete('/:id', requireRole('admin'), ah((req, res) => {
  const shop = db.prepare('SELECT * FROM shops WHERE id = ?').get(req.params.id);
  if (!shop) throw httpError(404, 'Toko tidak ditemukan');

  const dipakai = db.prepare('SELECT COUNT(*) c FROM sales_orders WHERE shop_id = ?').get(shop.id).c;
  if (dipakai > 0) {
    // Riwayat penjualan harus tetap dapat ditelusuri ke tokonya
    db.prepare('UPDATE shops SET active = 0 WHERE id = ?').run(shop.id);
    return res.json({ ok: true, message: `Toko pernah dipakai ${dipakai} order — dinonaktifkan, bukan dihapus` });
  }

  db.prepare('DELETE FROM shops WHERE id = ?').run(shop.id);
  res.json({ ok: true, message: 'Toko dihapus' });
}));

module.exports = router;
