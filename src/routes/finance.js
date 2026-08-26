'use strict';
const express = require('express');
const { z } = require('zod');
const { db, getSetting } = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');
const { ah, parse, httpError, dateRange } = require('../utils/http');
const { postJournal, r2 } = require('../utils/accounting');
const { incomeStatement, balanceSheet, cashFlow, generalLedger, trialBalance, accountBalances } = require('../utils/reports');
const { tableExcel, financialPdf } = require('../utils/exporters');
const { daftarkanEkspor } = require('../utils/ekspor');
const { todayLocal } = require('../utils/time');

const router = express.Router();
router.use(requireAuth);

const company = () => getSetting('company_name', 'Perusahaan');

// ==================================================================
// CHART OF ACCOUNTS
// ==================================================================
const accountSchema = z.object({
  code: z.string().trim().regex(/^\d{3,6}$/, 'kode akun harus 3–6 digit angka'),
  name: z.string().trim().min(1).max(120),
  type: z.enum(['ASSET', 'LIABILITY', 'EQUITY', 'REVENUE', 'EXPENSE']),
  subtype: z.string().trim().max(30).default('OTHER'),
  normal: z.enum(['D', 'K']),
  cashflow: z.enum(['OCF', 'ICF', 'FCF', 'NONE']).default('OCF'),
  is_cash: z.boolean().default(false),
  active: z.boolean().default(true),
});

/** GET /api/finance/accounts — COA lengkap dengan saldo berjalan. */
/** Pengambil bagan akun beserta saldonya — dipakai layar dan berkas unduhan. */
function ambilAkun(req) {
  const balances = accountBalances(null, req.query.asOf || todayLocal());
  const map = new Map(balances.map((b) => [b.id, b.balance]));

  const accounts = db.prepare('SELECT * FROM accounts ORDER BY code').all().map((a) => ({
    ...a,
    balance: map.get(a.id) ?? 0,
  }));

  return { accounts };
}

router.get('/accounts', ah((req, res) => res.json(ambilAkun(req))));

daftarkanEkspor(router, {
  path: '/accounts',
  judul: 'Chart of Accounts',
  kolom: [
    { header: 'Kode', key: 'code', width: 10 },
    { header: 'Nama Akun', key: 'name', width: 36 },
    { header: 'Tipe', key: 'type', width: 14 },
    { header: 'Subtipe', key: 'subtype', width: 16 },
    { header: 'Saldo Normal', key: 'normal', width: 12 },
    { header: 'Arus Kas', key: 'cashflow', width: 10 },
    { header: 'Saldo', key: 'balance', width: 18, money: true },
  ],
  ambil: (req) => {
    const d = ambilAkun(req);
    return {
      rows: d.accounts,
      subtitle: `Saldo per ${req.query.asOf || todayLocal()}`,
      meta: [['Jumlah akun', d.accounts.length]],
    };
  },
});

router.post('/accounts', requireRole('admin', 'manager'), ah((req, res) => {
  const a = parse(accountSchema, req.body);
  if (db.prepare('SELECT id FROM accounts WHERE code = ?').get(a.code)) {
    throw httpError(409, `Kode akun ${a.code} sudah dipakai`);
  }
  const info = db
    .prepare(
      `INSERT INTO accounts (code, name, type, subtype, normal, cashflow, is_cash, is_system, active)
       VALUES (?,?,?,?,?,?,?,0,?)`
    )
    .run(a.code, a.name, a.type, a.subtype, a.normal, a.cashflow, a.is_cash ? 1 : 0, a.active ? 1 : 0);

  res.status(201).json({ ok: true, account: db.prepare('SELECT * FROM accounts WHERE id = ?').get(info.lastInsertRowid) });
}));

router.put('/accounts/:id', requireRole('admin', 'manager'), ah((req, res) => {
  const a = parse(accountSchema, req.body);
  const existing = db.prepare('SELECT * FROM accounts WHERE id = ?').get(req.params.id);
  if (!existing) throw httpError(404, 'Akun tidak ditemukan');
  if (existing.is_system && existing.code !== a.code) {
    throw httpError(422, 'Kode akun sistem tidak boleh diubah karena dipakai posting otomatis');
  }
  db.prepare(
    'UPDATE accounts SET code=?, name=?, type=?, subtype=?, normal=?, cashflow=?, is_cash=?, active=? WHERE id=?'
  ).run(a.code, a.name, a.type, a.subtype, a.normal, a.cashflow, a.is_cash ? 1 : 0, a.active ? 1 : 0, existing.id);

  res.json({ ok: true, account: db.prepare('SELECT * FROM accounts WHERE id = ?').get(existing.id) });
}));

router.delete('/accounts/:id', requireRole('admin'), ah((req, res) => {
  const account = db.prepare('SELECT * FROM accounts WHERE id = ?').get(req.params.id);
  if (!account) throw httpError(404, 'Akun tidak ditemukan');
  if (account.is_system) throw httpError(422, 'Akun sistem tidak dapat dihapus — nonaktifkan saja');

  const used = db.prepare('SELECT COUNT(*) c FROM journal_lines WHERE account_id = ?').get(account.id).c;
  if (used > 0) throw httpError(422, `Akun sudah dipakai ${used} baris jurnal — nonaktifkan saja`);

  db.prepare('DELETE FROM accounts WHERE id = ?').run(account.id);
  res.json({ ok: true, message: 'Akun dihapus' });
}));

// ==================================================================
// JURNAL UMUM
// ==================================================================
const journalSchema = z.object({
  entry_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  description: z.string().trim().min(1, 'keterangan wajib diisi').max(200),
  lines: z
    .array(
      z.object({
        account_id: z.number().int().positive(),
        debit: z.number().nonnegative().default(0),
        credit: z.number().nonnegative().default(0),
        memo: z.string().max(200).optional().nullable(),
      })
    )
    .min(2, 'jurnal minimal 2 baris'),
});

/** POST /api/finance/journals — jurnal manual (validasi Debit = Kredit). */
router.post('/journals', requireRole('admin', 'manager'), ah((req, res) => {
  const body = parse(journalSchema, req.body);
  const result = postJournal({
    date: body.entry_date,
    description: body.description,
    lines: body.lines,
    source: 'MANUAL',
    userId: req.user.id,
  });
  res.status(201).json({ ok: true, message: `Jurnal ${result.entry_no} tersimpan`, journal: result });
}));

/** GET /api/finance/journals — daftar jurnal beserta totalnya. */
/** Pengambil daftar jurnal — dipakai layar dan berkas unduhan. */
function ambilJurnal(req) {
  const { from, to } = dateRange(req.query);
  const params = [from, to];
  let where = 'WHERE j.entry_date BETWEEN ? AND ?';
  if (req.query.source) { where += ' AND j.source = ?'; params.push(req.query.source); }

  const rows = db
    .prepare(
      `SELECT j.*, u.name AS user_name,
              (SELECT COALESCE(SUM(debit),0)  FROM journal_lines l WHERE l.journal_id = j.id) AS total_debit,
              (SELECT COALESCE(SUM(credit),0) FROM journal_lines l WHERE l.journal_id = j.id) AS total_credit
         FROM journals j LEFT JOIN users u ON u.id = j.created_by
         ${where}
        ORDER BY j.entry_date DESC, j.id DESC LIMIT 500`
    )
    .all(...params);

  return { from, to, rows };
}

router.get('/journals', ah((req, res) => res.json(ambilJurnal(req))));

daftarkanEkspor(router, {
  path: '/journals',
  judul: 'Buku Besar & Jurnal',
  kolom: [
    { header: 'Tanggal', key: 'entry_date', width: 12 },
    { header: 'Nomor', key: 'entry_no', width: 18 },
    { header: 'Keterangan', key: 'description', width: 46 },
    { header: 'Sumber', key: 'source', width: 12 },
    { header: 'Total Debit', key: 'total_debit', width: 17, money: true },
    { header: 'Total Kredit', key: 'total_credit', width: 17, money: true },
    { header: 'Dicatat Oleh', key: 'user_name', width: 18 },
  ],
  ambil: (req) => {
    const d = ambilJurnal(req);
    return {
      rows: d.rows,
      subtitle: `Periode ${d.from} s/d ${d.to}`,
      meta: [
        ['Jumlah jurnal', d.rows.length],
        ['Total debit', r2(d.rows.reduce((s, r) => s + r.total_debit, 0))],
        ['Total kredit', r2(d.rows.reduce((s, r) => s + r.total_credit, 0))],
      ],
    };
  },
});

router.get('/journals/:id', ah((req, res) => {
  const journal = db.prepare('SELECT * FROM journals WHERE id = ?').get(req.params.id);
  if (!journal) throw httpError(404, 'Jurnal tidak ditemukan');

  const lines = db
    .prepare(
      `SELECT l.*, a.code, a.name AS account_name
         FROM journal_lines l JOIN accounts a ON a.id = l.account_id
        WHERE l.journal_id = ? ORDER BY l.debit DESC, l.id`
    )
    .all(journal.id);

  res.json({ journal, lines });
}));

router.delete('/journals/:id', requireRole('admin'), ah((req, res) => {
  const journal = db.prepare('SELECT * FROM journals WHERE id = ?').get(req.params.id);
  if (!journal) throw httpError(404, 'Jurnal tidak ditemukan');
  if (journal.source !== 'MANUAL') {
    throw httpError(422, `Jurnal otomatis dari modul ${journal.source} harus dibatalkan lewat dokumen sumbernya`);
  }
  db.prepare('DELETE FROM journals WHERE id = ?').run(journal.id);
  res.json({ ok: true, message: `Jurnal ${journal.entry_no} dihapus` });
}));

// ==================================================================
// LAPORAN
// ==================================================================
router.get('/reports/income-statement', ah((req, res) => {
  const { from, to } = dateRange(req.query);
  res.json(incomeStatement(from, to));
}));

router.get('/reports/balance-sheet', ah((req, res) => {
  res.json(balanceSheet(req.query.asOf || dateRange(req.query).to));
}));

router.get('/reports/cash-flow', ah((req, res) => {
  const { from, to } = dateRange(req.query);
  res.json(cashFlow(from, to));
}));

router.get('/reports/trial-balance', ah((req, res) => {
  const { from, to } = dateRange(req.query);
  res.json(trialBalance(from, to));
}));

router.get('/reports/ledger/:accountId', ah((req, res) => {
  const { from, to } = dateRange(req.query);
  res.json(generalLedger(Number(req.params.accountId), from, to));
}));

// ---------- EKSPOR LAPORAN ----------
/** Menyusun baris teks Laba Rugi (dipakai PDF & Excel). */
function incomeLines(rep) {
  const lines = [
    { label: 'PENDAPATAN', bold: true, value: null },
    { label: 'Penjualan Kotor', value: rep.grossSales, indent: true },
    { label: 'Retur Penjualan', value: -rep.salesReturn, indent: true },
    { label: 'Diskon Penjualan', value: -rep.salesDiscount, indent: true },
    { label: 'Penjualan Bersih', value: rep.netSales, bold: true },
    { divider: true },
    { label: 'Harga Pokok Penjualan (HPP)', value: -rep.cogs },
    { label: 'LABA KOTOR', value: rep.grossProfit, bold: true },
    { divider: true },
    { label: 'BEBAN OPERASIONAL', bold: true, value: null },
  ];
  rep.sellingRows.forEach((r) => lines.push({ label: `${r.code} ${r.name}`, value: -r.amount, indent: true }));
  rep.adminRows.forEach((r) => lines.push({ label: `${r.code} ${r.name}`, value: -r.amount, indent: true }));
  lines.push({ label: 'Total Beban Operasional', value: -rep.opex, bold: true });
  lines.push({ label: 'LABA USAHA', value: rep.operatingProfit, bold: true });
  lines.push({ divider: true });
  if (rep.otherIncome) lines.push({ label: 'Pendapatan Lain-lain', value: rep.otherIncome });
  rep.otherExpenseRows.forEach((r) => lines.push({ label: `${r.code} ${r.name}`, value: -r.amount, indent: true }));
  lines.push({ divider: true });
  lines.push({ label: 'LABA BERSIH', value: rep.netProfit, bold: true });
  lines.push({ label: `Margin Laba Bersih: ${rep.netMarginPct}%`, value: null });
  return lines;
}

function balanceLines(rep) {
  const lines = [{ label: 'ASET', bold: true, value: null }, { label: 'Aset Lancar', bold: true, value: null }];
  rep.assets.current.cash.forEach((r) => lines.push({ label: `${r.code} ${r.name}`, value: r.amount, indent: true }));
  rep.assets.current.receivable.forEach((r) => lines.push({ label: `${r.code} ${r.name}`, value: r.amount, indent: true }));
  rep.assets.current.inventory.forEach((r) => lines.push({ label: `${r.code} ${r.name}`, value: r.amount, indent: true }));
  rep.assets.current.other.forEach((r) => lines.push({ label: `${r.code} ${r.name}`, value: r.amount, indent: true }));
  lines.push({ label: 'Total Aset Lancar', value: rep.assets.current.total, bold: true });
  lines.push({ label: 'Aset Tetap', bold: true, value: null });
  rep.assets.fixed.items.forEach((r) => lines.push({ label: `${r.code} ${r.name}`, value: r.amount, indent: true }));
  lines.push({ label: 'Akumulasi Penyusutan', value: -rep.assets.fixed.accumulatedDepreciation, indent: true });
  lines.push({ label: 'Total Aset Tetap (Neto)', value: rep.assets.fixed.net, bold: true });
  lines.push({ divider: true });
  lines.push({ label: 'TOTAL ASET', value: rep.assets.total, bold: true });
  lines.push({ divider: true });

  lines.push({ label: 'KEWAJIBAN', bold: true, value: null });
  rep.liabilities.current.forEach((r) => lines.push({ label: `${r.code} ${r.name}`, value: r.amount, indent: true }));
  rep.liabilities.longTerm.forEach((r) => lines.push({ label: `${r.code} ${r.name}`, value: r.amount, indent: true }));
  lines.push({ label: 'Total Kewajiban', value: rep.liabilities.total, bold: true });
  lines.push({ divider: true });

  lines.push({ label: 'EKUITAS', bold: true, value: null });
  lines.push({ label: 'Modal Pemilik', value: rep.equity.capital, indent: true });
  lines.push({ label: 'Prive', value: -rep.equity.drawing, indent: true });
  lines.push({ label: 'Laba Ditahan', value: rep.equity.retained, indent: true });
  lines.push({ label: 'Laba Berjalan', value: rep.equity.currentEarnings, indent: true });
  lines.push({ label: 'Total Ekuitas', value: rep.equity.total, bold: true });
  lines.push({ divider: true });
  lines.push({ label: 'TOTAL KEWAJIBAN + EKUITAS', value: rep.totalLiabilitiesAndEquity, bold: true });
  lines.push({ label: rep.balanced ? 'Status: SEIMBANG ✓' : 'Status: TIDAK SEIMBANG — periksa jurnal', value: null });
  return lines;
}

function cashFlowLines(rep) {
  const lines = [];
  const section = (title, block) => {
    lines.push({ label: title, bold: true, value: null });
    block.items.forEach((i) => lines.push({ label: i.label, value: i.amount, indent: true }));
    lines.push({ label: `Total ${title}`, value: block.total, bold: true });
    lines.push({ divider: true });
  };
  section('Arus Kas Operasi (OCF)', rep.operating);
  section('Arus Kas Investasi (ICF)', rep.investing);
  section('Arus Kas Pendanaan (FCF)', rep.financing);
  lines.push({ label: 'KENAIKAN (PENURUNAN) KAS BERSIH', value: rep.netChange, bold: true });
  lines.push({ label: 'Kas Awal Periode', value: rep.openingCash });
  lines.push({ label: 'KAS AKHIR PERIODE', value: rep.closingCash, bold: true });
  return lines;
}

const REPORT_BUILDERS = {
  'income-statement': (q) => {
    const { from, to } = dateRange(q);
    const rep = incomeStatement(from, to);
    return { title: 'LAPORAN LABA RUGI', subtitle: `Periode ${from} s/d ${to}`, lines: incomeLines(rep), file: `laba-rugi-${from}_${to}` };
  },
  'balance-sheet': (q) => {
    const asOf = q.asOf || dateRange(q).to;
    const rep = balanceSheet(asOf);
    return { title: 'NERACA KEUANGAN', subtitle: `Per ${asOf}`, lines: balanceLines(rep), file: `neraca-${asOf}` };
  },
  'cash-flow': (q) => {
    const { from, to } = dateRange(q);
    const rep = cashFlow(from, to);
    return { title: 'LAPORAN ARUS KAS', subtitle: `Periode ${from} s/d ${to}`, lines: cashFlowLines(rep), file: `arus-kas-${from}_${to}` };
  },
};

/** GET /api/finance/reports/:report/export/pdf */
router.get('/reports/:report/export/pdf', ah(async (req, res) => {
  const builder = REPORT_BUILDERS[req.params.report];
  if (!builder) throw httpError(404, 'Jenis laporan tidak dikenal');

  const { title, subtitle, lines, file } = builder(req.query);
  const buffer = await financialPdf(title, subtitle, lines, company());

  res
    .set('Content-Type', 'application/pdf')
    .set('Content-Disposition', `attachment; filename="${file}.pdf"`)
    .send(buffer);
}));

/** GET /api/finance/reports/:report/export/excel */
router.get('/reports/:report/export/excel', ah(async (req, res) => {
  const builder = REPORT_BUILDERS[req.params.report];
  if (!builder) throw httpError(404, 'Jenis laporan tidak dikenal');

  const { title, subtitle, lines, file } = builder(req.query);
  const buffer = await tableExcel(
    title.slice(0, 28),
    [
      { header: 'Keterangan', key: 'label', width: 46 },
      { header: 'Nilai (Rp)', key: 'value', width: 20, money: true },
    ],
    lines.filter((l) => !l.divider).map((l) => ({ label: l.label, value: l.value ?? '' })),
    [['Laporan', title], ['Keterangan', subtitle], ['Dicetak', new Date().toLocaleString('id-ID')]]
  );

  res
    .set('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
    .set('Content-Disposition', `attachment; filename="${file}.xlsx"`)
    .send(buffer);
}));

/** GET /api/finance/reports/ledger/:accountId/export/excel */
router.get('/ledger/:accountId/export/excel', ah(async (req, res) => {
  const { from, to } = dateRange(req.query);
  const led = generalLedger(Number(req.params.accountId), from, to);

  const buffer = await tableExcel(
    `BB ${led.account.code}`,
    [
      { header: 'Tanggal', key: 'entry_date', width: 12 },
      { header: 'No. Jurnal', key: 'entry_no', width: 20 },
      { header: 'Keterangan', key: 'description', width: 40 },
      { header: 'Debit', key: 'debit', width: 16, money: true },
      { header: 'Kredit', key: 'credit', width: 16, money: true },
      { header: 'Saldo', key: 'balance', width: 18, money: true },
    ],
    led.entries,
    [
      ['Akun', `${led.account.code} — ${led.account.name}`],
      ['Periode', `${from} s/d ${to}`],
      ['Saldo Awal', led.opening],
      ['Total Debit', led.totalDebit],
      ['Total Kredit', led.totalCredit],
      ['Saldo Akhir', led.closing],
    ]
  );

  res
    .set('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
    .set('Content-Disposition', `attachment; filename="buku-besar-${led.account.code}-${from}_${to}.xlsx"`)
    .send(buffer);
}));

module.exports = router;
