'use strict';
const { daftarkanEkspor } = require('../utils/ekspor');
/**
 * Kas Masuk / Kas Keluar dan Utang / Piutang.
 *
 * Tujuannya membuat pencatatan harian bisa dilakukan tanpa paham debit-kredit:
 * pengguna memilih kategori dan mengisi nominal, jurnal berpasangan dibentuk
 * otomatis di belakang layar. Buku besar tetap menjadi satu-satunya sumber
 * kebenaran — tidak ada tabel saldo terpisah yang bisa berbeda.
 */
const express = require('express');
const { z } = require('zod');
const { db } = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');
const { ah, parse, httpError, dateRange } = require('../utils/http');
const { r2, postJournal, deleteJournalsBySource, accountByCode } = require('../utils/accounting');
const { todayLocal } = require('../utils/time');

const router = express.Router();
router.use(requireAuth);

/** Akun kas & setara kas yang boleh dipakai sebagai sumber/tujuan dana. */
function cashAccounts() {
  return db.prepare('SELECT id, code, name FROM accounts WHERE is_cash = 1 AND active = 1 ORDER BY code').all();
}

/** Kategori yang masuk akal untuk pemasukan / pengeluaran non-penjualan. */
function categoryAccounts(direction) {
  const where = direction === 'IN'
    ? "type = 'REVENUE' AND subtype IN ('OTHER_INCOME','SALES')"
    : "type = 'EXPENSE' AND subtype IN ('SELLING','ADMIN','TAX','FINANCE','OTHER','COGS')";
  return db.prepare(`SELECT id, code, name, subtype FROM accounts WHERE ${where} AND active = 1 ORDER BY code`).all();
}

/** GET /api/cashflow/options — isi dropdown form. */
router.get('/options', ah((req, res) => {
  res.json({
    cashAccounts: cashAccounts(),
    incomeCategories: categoryAccounts('IN'),
    expenseCategories: categoryAccounts('OUT'),
    today: todayLocal(),
  });
}));

// ==================================================================
// KAS MASUK / KAS KELUAR
// ==================================================================
const cashSchema = z.object({
  entry_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).default(() => todayLocal()),
  direction: z.enum(['IN', 'OUT']),
  category_code: z.string().trim().min(3, 'kategori wajib dipilih'),
  cash_code: z.string().trim().min(3, 'sumber dana wajib dipilih'),
  amount: z.number().positive('nominal harus lebih dari 0'),
  description: z.string().trim().min(1, 'keterangan wajib diisi').max(200),
  partner_id: z.number().int().positive().optional().nullable(),
});

/**
 * POST /api/cashflow/entries
 *   Masuk  : D Kas       K Kategori pendapatan
 *   Keluar : D Kategori  K Kas
 */
router.post('/entries', requireRole('admin', 'manager', 'staff'), ah((req, res) => {
  const body = parse(cashSchema, req.body);

  const kas = accountByCode(body.cash_code);
  if (!kas.is_cash) throw httpError(422, `${kas.code} bukan akun kas`);

  const kategori = accountByCode(body.category_code);
  if (kategori.is_cash) throw httpError(422, 'Kategori tidak boleh berupa akun kas');

  const nilai = r2(body.amount);
  const lines = body.direction === 'IN'
    ? [
        { code: kas.code, debit: nilai, credit: 0, memo: body.description },
        { code: kategori.code, debit: 0, credit: nilai, memo: body.description, partner_id: body.partner_id },
      ]
    : [
        { code: kategori.code, debit: nilai, credit: 0, memo: body.description, partner_id: body.partner_id },
        { code: kas.code, debit: 0, credit: nilai, memo: body.description },
      ];

  const journal = postJournal({
    date: body.entry_date,
    description: `${body.direction === 'IN' ? 'Kas Masuk' : 'Kas Keluar'} — ${body.description}`,
    lines,
    source: 'CASH',
    userId: req.user.id,
  });

  res.status(201).json({
    ok: true,
    message: `${body.direction === 'IN' ? 'Kas masuk' : 'Kas keluar'} Rp ${nilai.toLocaleString('id-ID')} tercatat (${journal.entry_no})`,
    journal,
  });
}));

/** GET /api/cashflow/entries — riwayat kas masuk & keluar. */
/** Pengambil daftar kas masuk & keluar — dipakai layar dan berkas unduhan. */
function ambilKas(req) {
  const { from, to } = dateRange(req.query);

  const rows = db
    .prepare(
      `SELECT j.id, j.entry_no, j.entry_date, j.description, u.name AS user_name,
              (SELECT COALESCE(SUM(l.debit),0) FROM journal_lines l
                 JOIN accounts a ON a.id = l.account_id
                WHERE l.journal_id = j.id AND a.is_cash = 1) AS masuk,
              (SELECT COALESCE(SUM(l.credit),0) FROM journal_lines l
                 JOIN accounts a ON a.id = l.account_id
                WHERE l.journal_id = j.id AND a.is_cash = 1) AS keluar,
              (SELECT a.name FROM journal_lines l
                 JOIN accounts a ON a.id = l.account_id
                WHERE l.journal_id = j.id AND a.is_cash = 0 LIMIT 1) AS kategori
         FROM journals j
         LEFT JOIN users u ON u.id = j.created_by
        WHERE j.source = 'CASH' AND j.entry_date BETWEEN ? AND ?
        ORDER BY j.entry_date DESC, j.id DESC`
    )
    .all(from, to);

  return {
    from, to, rows,
    summary: {
      masuk: r2(rows.reduce((s, r) => s + r.masuk, 0)),
      keluar: r2(rows.reduce((s, r) => s + r.keluar, 0)),
      net: r2(rows.reduce((s, r) => s + r.masuk - r.keluar, 0)),
    },
  };
}

router.get('/entries', ah((req, res) => res.json(ambilKas(req))));

daftarkanEkspor(router, {
  path: '/entries',
  judul: 'Kas Masuk & Keluar',
  kolom: [
    { header: 'Tanggal', key: 'entry_date', width: 12 },
    { header: 'Nomor', key: 'entry_no', width: 18 },
    { header: 'Keterangan', key: 'description', width: 40 },
    { header: 'Kategori', key: 'kategori', width: 26 },
    { header: 'Masuk', key: 'masuk', width: 16, money: true },
    { header: 'Keluar', key: 'keluar', width: 16, money: true },
    { header: 'Dicatat Oleh', key: 'user_name', width: 18 },
  ],
  ambil: (req) => {
    const d = ambilKas(req);
    return {
      rows: d.rows,
      subtitle: `Periode ${d.from} s/d ${d.to}`,
      meta: [
        ['Total kas masuk', d.summary.masuk],
        ['Total kas keluar', d.summary.keluar],
        ['Selisih bersih', d.summary.net],
      ],
    };
  },
});

router.delete('/entries/:id', requireRole('admin', 'manager'), ah((req, res) => {
  const journal = db.prepare("SELECT * FROM journals WHERE id = ? AND source = 'CASH'").get(req.params.id);
  if (!journal) throw httpError(404, 'Catatan kas tidak ditemukan');

  db.prepare('DELETE FROM journals WHERE id = ?').run(journal.id);
  res.json({ ok: true, message: `${journal.entry_no} dihapus` });
}));

// ==================================================================
// UTANG & PIUTANG
// ==================================================================
/** Akun tempat saldo mitra berada, dipilih yang saldonya terbesar. */
function accountWithBalance(partnerId, subtype) {
  const rows = db
    .prepare(
      `SELECT a.code,
              SUM(CASE WHEN ? = 'RECEIVABLE' THEN l.debit - l.credit ELSE l.credit - l.debit END) AS saldo
         FROM journal_lines l
         JOIN accounts a ON a.id = l.account_id
         JOIN journals j ON j.id = l.journal_id
        WHERE l.partner_id = ? AND a.subtype = ? AND j.posted = 1
        GROUP BY a.code
        HAVING saldo > 0.004
        ORDER BY saldo DESC`
    )
    .all(subtype, partnerId, subtype);

  return rows[0] || null;
}

/** GET /api/cashflow/ar-ap — daftar piutang & utang per mitra. */
/** Pengambil saldo utang & piutang per mitra — dipakai layar dan unduhan. */
function ambilUtangPiutang() {
  const rows = db
    .prepare(
      `SELECT p.id, p.name, p.code, p.kind, p.phone, p.term_days,
              COALESCE(SUM(CASE WHEN a.subtype = 'RECEIVABLE' THEN l.debit - l.credit ELSE 0 END), 0) AS piutang,
              COALESCE(SUM(CASE WHEN a.subtype = 'PAYABLE'    THEN l.credit - l.debit ELSE 0 END), 0) AS utang,
              MAX(j.entry_date) AS transaksi_terakhir
         FROM partners p
         JOIN journal_lines l ON l.partner_id = p.id
         JOIN accounts a      ON a.id = l.account_id
         JOIN journals j      ON j.id = l.journal_id
        WHERE j.posted = 1 AND a.subtype IN ('RECEIVABLE','PAYABLE')
        GROUP BY p.id`
    )
    .all()
    .map((r) => ({ ...r, piutang: r2(r.piutang), utang: r2(r.utang) }));

  const piutang = rows.filter((r) => r.piutang > 0.004);
  const utang = rows.filter((r) => r.utang > 0.004);

  return {
    piutang,
    utang,
    totalPiutang: r2(piutang.reduce((s, r) => s + r.piutang, 0)),
    totalUtang: r2(utang.reduce((s, r) => s + r.utang, 0)),
  };
}

router.get('/ar-ap', ah((req, res) => res.json(ambilUtangPiutang())));

daftarkanEkspor(router, {
  path: '/ar-ap',
  judul: 'Utang & Piutang',
  kolom: [
    { header: 'Kode', key: 'code', width: 14 },
    { header: 'Mitra', key: 'name', width: 30 },
    { header: 'Jenis', key: 'kind', width: 12 },
    { header: 'Telepon', key: 'phone', width: 18 },
    { header: 'Tempo (hari)', key: 'term_days', width: 12 },
    { header: 'Piutang', key: 'piutang', width: 16, money: true },
    { header: 'Utang', key: 'utang', width: 16, money: true },
    { header: 'Transaksi Terakhir', key: 'transaksi_terakhir', width: 16 },
  ],
  ambil: () => {
    const d = ambilUtangPiutang();
    // Satu mitra bisa punya utang sekaligus piutang, jadi digabung agar tidak
    // muncul dua kali dengan angka yang saling melengkapi.
    const gabung = new Map();
    for (const r of [...d.piutang, ...d.utang]) gabung.set(r.id, { ...gabung.get(r.id), ...r });
    return {
      rows: [...gabung.values()].sort((a, b) => (b.piutang + b.utang) - (a.piutang + a.utang)),
      subtitle: 'Saldo berjalan menurut buku besar',
      meta: [['Total piutang', d.totalPiutang], ['Total utang', d.totalUtang]],
    };
  },
});

const settlementSchema = z.object({
  entry_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).default(() => todayLocal()),
  partner_id: z.number().int().positive(),
  direction: z.enum(['RECEIVE', 'PAY']),  // RECEIVE = terima piutang, PAY = bayar utang
  amount: z.number().positive(),
  cash_code: z.string().trim().min(3),
  note: z.string().trim().max(200).optional().nullable(),
});

/**
 * POST /api/cashflow/settlements
 *   RECEIVE : D Kas          K Piutang(mitra)
 *   PAY     : D Utang(mitra) K Kas
 */
router.post('/settlements', requireRole('admin', 'manager', 'staff'), ah((req, res) => {
  const body = parse(settlementSchema, req.body);

  const partner = db.prepare('SELECT * FROM partners WHERE id = ?').get(body.partner_id);
  if (!partner) throw httpError(404, 'Mitra tidak ditemukan');

  const kas = accountByCode(body.cash_code);
  if (!kas.is_cash) throw httpError(422, `${kas.code} bukan akun kas`);

  const subtype = body.direction === 'RECEIVE' ? 'RECEIVABLE' : 'PAYABLE';
  const lawan = accountWithBalance(partner.id, subtype);
  if (!lawan) {
    throw httpError(422, `${partner.name} tidak memiliki ${subtype === 'RECEIVABLE' ? 'piutang' : 'utang'} yang tercatat`);
  }

  const nilai = r2(body.amount);
  if (nilai > r2(lawan.saldo) + 0.004) {
    throw httpError(
      422,
      `Nominal melebihi sisa ${subtype === 'RECEIVABLE' ? 'piutang' : 'utang'} ` +
        `(sisa Rp ${r2(lawan.saldo).toLocaleString('id-ID')})`
    );
  }

  const memo = body.note || (body.direction === 'RECEIVE' ? 'Pelunasan piutang' : 'Pembayaran utang');
  const lines = body.direction === 'RECEIVE'
    ? [
        { code: kas.code, debit: nilai, credit: 0, memo },
        { code: lawan.code, debit: 0, credit: nilai, memo, partner_id: partner.id },
      ]
    : [
        { code: lawan.code, debit: nilai, credit: 0, memo, partner_id: partner.id },
        { code: kas.code, debit: 0, credit: nilai, memo },
      ];

  const journal = postJournal({
    date: body.entry_date,
    description: `${body.direction === 'RECEIVE' ? 'Pelunasan piutang' : 'Pembayaran utang'} — ${partner.name}`,
    lines,
    source: 'SETTLEMENT',
    sourceId: partner.id,
    userId: req.user.id,
  });

  res.status(201).json({
    ok: true,
    message: `Rp ${nilai.toLocaleString('id-ID')} tercatat untuk ${partner.name} (${journal.entry_no})`,
    sisa: r2(lawan.saldo - nilai),
    journal,
  });
}));

module.exports = router;
