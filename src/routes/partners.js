'use strict';
const express = require('express');
const { z } = require('zod');
const { db } = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');
const { ah, parse, httpError } = require('../utils/http');
const { r2, ACC } = require('../utils/accounting');

const router = express.Router();
router.use(requireAuth);

const partnerSchema = z.object({
  code: z.string().trim().max(30).optional().nullable(),
  name: z.string().trim().min(1, 'nama wajib diisi').max(150),
  kind: z.enum(['SUPPLIER', 'CUSTOMER', 'BOTH']).default('CUSTOMER'),
  phone: z.string().trim().max(30).optional().nullable(),
  email: z.string().trim().max(120).optional().nullable(),
  address: z.string().trim().max(300).optional().nullable(),
  note: z.string().trim().max(300).optional().nullable(),
  term_days: z.number().int().min(0).max(365).default(0),
  active: z.boolean().default(true),
});

/**
 * Saldo utang/piutang per mitra, dihitung langsung dari buku besar.
 * Piutang = saldo debit pada akun RECEIVABLE; Utang = saldo kredit pada PAYABLE.
 */
function balanceMap() {
  const rows = db
    .prepare(
      `SELECT l.partner_id,
              SUM(CASE WHEN a.subtype = 'RECEIVABLE' THEN l.debit - l.credit ELSE 0 END) AS receivable,
              SUM(CASE WHEN a.subtype = 'PAYABLE'    THEN l.credit - l.debit ELSE 0 END) AS payable
         FROM journal_lines l
         JOIN accounts a ON a.id = l.account_id
         JOIN journals j ON j.id = l.journal_id
        WHERE l.partner_id IS NOT NULL AND j.posted = 1
        GROUP BY l.partner_id`
    )
    .all();

  const map = new Map();
  for (const r of rows) {
    map.set(r.partner_id, { receivable: r2(r.receivable), payable: r2(r.payable) });
  }
  return map;
}

router.get('/', ah((req, res) => {
  const kind = req.query.kind;
  const search = `%${(req.query.q || '').trim()}%`;

  const rows = db
    .prepare(
      `SELECT * FROM partners
        WHERE (name LIKE ? OR COALESCE(code,'') LIKE ? OR COALESCE(phone,'') LIKE ?)
          ${kind ? "AND (kind = ? OR kind = 'BOTH')" : ''}
          ${req.query.includeInactive === '1' ? '' : 'AND active = 1'}
        ORDER BY name`
    )
    .all(...[search, search, search, kind].filter((x) => x !== undefined));

  const saldo = balanceMap();

  res.json({
    partners: rows.map((p) => ({
      ...p,
      receivable: saldo.get(p.id)?.receivable || 0,
      payable: saldo.get(p.id)?.payable || 0,
    })),
  });
}));

router.post('/', requireRole('admin', 'manager', 'staff'), ah((req, res) => {
  const p = parse(partnerSchema, req.body);
  if (p.code && db.prepare('SELECT id FROM partners WHERE code = ?').get(p.code)) {
    throw httpError(409, `Kode ${p.code} sudah dipakai mitra lain`);
  }
  const info = db
    .prepare(
      `INSERT INTO partners (code, name, kind, phone, email, address, note, term_days, active)
       VALUES (?,?,?,?,?,?,?,?,?)`
    )
    .run(p.code || null, p.name, p.kind, p.phone || null, p.email || null,
      p.address || null, p.note || null, p.term_days, p.active ? 1 : 0);

  res.status(201).json({ ok: true, partner: db.prepare('SELECT * FROM partners WHERE id = ?').get(info.lastInsertRowid) });
}));

router.put('/:id', requireRole('admin', 'manager'), ah((req, res) => {
  const p = parse(partnerSchema, req.body);
  const existing = db.prepare('SELECT * FROM partners WHERE id = ?').get(req.params.id);
  if (!existing) throw httpError(404, 'Mitra tidak ditemukan');

  if (p.code) {
    const dupe = db.prepare('SELECT id FROM partners WHERE code = ? AND id <> ?').get(p.code, existing.id);
    if (dupe) throw httpError(409, `Kode ${p.code} sudah dipakai mitra lain`);
  }

  db.prepare(
    `UPDATE partners SET code=?, name=?, kind=?, phone=?, email=?, address=?, note=?, term_days=?, active=?
      WHERE id=?`
  ).run(p.code || null, p.name, p.kind, p.phone || null, p.email || null,
    p.address || null, p.note || null, p.term_days, p.active ? 1 : 0, existing.id);

  res.json({ ok: true, partner: db.prepare('SELECT * FROM partners WHERE id = ?').get(existing.id) });
}));

router.delete('/:id', requireRole('admin'), ah((req, res) => {
  const partner = db.prepare('SELECT * FROM partners WHERE id = ?').get(req.params.id);
  if (!partner) throw httpError(404, 'Mitra tidak ditemukan');

  const dipakai = db.prepare('SELECT COUNT(*) c FROM journal_lines WHERE partner_id = ?').get(partner.id).c
    + db.prepare('SELECT COUNT(*) c FROM sales_orders WHERE partner_id = ?').get(partner.id).c;

  if (dipakai > 0) {
    // Riwayat transaksi harus tetap dapat ditelusuri
    db.prepare('UPDATE partners SET active = 0 WHERE id = ?').run(partner.id);
    return res.json({ ok: true, message: 'Mitra pernah bertransaksi — dinonaktifkan, bukan dihapus' });
  }

  db.prepare('DELETE FROM partners WHERE id = ?').run(partner.id);
  res.json({ ok: true, message: 'Mitra dihapus' });
}));

/** GET /api/partners/:id/ledger — riwayat transaksi & mutasi saldo satu mitra. */
router.get('/:id/ledger', ah((req, res) => {
  const partner = db.prepare('SELECT * FROM partners WHERE id = ?').get(req.params.id);
  if (!partner) throw httpError(404, 'Mitra tidak ditemukan');

  const entries = db
    .prepare(
      `SELECT j.entry_date, j.entry_no, j.description, j.source,
              a.code, a.name AS account_name, a.subtype,
              l.debit, l.credit, l.memo
         FROM journal_lines l
         JOIN journals j ON j.id = l.journal_id
         JOIN accounts a ON a.id = l.account_id
        WHERE l.partner_id = ? AND j.posted = 1
          AND a.subtype IN ('RECEIVABLE','PAYABLE')
        ORDER BY j.entry_date, j.id`
    )
    .all(partner.id);

  const saldo = balanceMap().get(partner.id) || { receivable: 0, payable: 0 };

  res.json({ partner, entries, ...saldo });
}));

module.exports = { router, balanceMap, ACC };
