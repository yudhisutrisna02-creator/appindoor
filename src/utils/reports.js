'use strict';
const { db } = require('../db');
const { r2, ruleError } = require('./accounting');

/**
 * Saldo per akun.
 * @param {string} from 'YYYY-MM-DD' atau null (sejak awal)
 * @param {string} to   'YYYY-MM-DD'
 * Mengembalikan baris akun + debit, credit, dan `balance` bertanda saldo normal.
 */
function accountBalances(from, to) {
  const params = [];
  let filter = 'WHERE j.posted = 1';
  if (from) { filter += ' AND j.entry_date >= ?'; params.push(from); }
  if (to) { filter += ' AND j.entry_date <= ?'; params.push(to); }

  // Sub-query difilter lebih dulu agar LEFT JOIN tetap memunculkan akun tanpa mutasi.
  const rows = db
    .prepare(
      `SELECT a.id, a.code, a.name, a.type, a.subtype, a.normal, a.is_cash,
              COALESCE(SUM(m.debit), 0)  AS debit,
              COALESCE(SUM(m.credit), 0) AS credit
         FROM accounts a
         LEFT JOIN (
           SELECT l.account_id, l.debit, l.credit
             FROM journal_lines l
             JOIN journals j ON j.id = l.journal_id
             ${filter}
         ) m ON m.account_id = a.id
        GROUP BY a.id
        ORDER BY a.code`
    )
    .all(...params);

  return rows.map((r) => ({
    ...r,
    debit: r2(r.debit),
    credit: r2(r.credit),
    balance: r2(r.normal === 'D' ? r.debit - r.credit : r.credit - r.debit),
  }));
}

/** Neraca Saldo (Trial Balance) — bukti Debit = Kredit di seluruh buku. */
function trialBalance(from, to) {
  const rows = accountBalances(from, to).filter((r) => r.debit !== 0 || r.credit !== 0);
  const totalDebit = r2(rows.reduce((s, r) => s + r.debit, 0));
  const totalCredit = r2(rows.reduce((s, r) => s + r.credit, 0));
  return {
    rows,
    totalDebit,
    totalCredit,
    balanced: Math.abs(totalDebit - totalCredit) < 0.01,
  };
}

const sumBy = (rows, pred) => r2(rows.filter(pred).reduce((s, r) => s + r.balance, 0));
const listBy = (rows, pred) =>
  rows
    .filter((r) => pred(r) && Math.abs(r.balance) > 0.004)
    .map((r) => ({ code: r.code, name: r.name, amount: r.balance }));

/**
 * Laporan Laba Rugi.
 * Penjualan Kotor → Retur & Diskon → Penjualan Bersih → HPP → Laba Kotor
 * → Beban Operasional → Laba Usaha → Pendapatan/Beban Lain → Laba Bersih
 */
function incomeStatement(from, to) {
  const rows = accountBalances(from, to);

  const grossSales   = sumBy(rows, (r) => r.subtype === 'SALES');
  const salesReturn  = sumBy(rows, (r) => r.subtype === 'SALES_RETURN');
  const salesDiscount= sumBy(rows, (r) => r.subtype === 'SALES_DISCOUNT');
  const netSales     = r2(grossSales - salesReturn - salesDiscount);

  const cogs         = sumBy(rows, (r) => r.subtype === 'COGS');
  const grossProfit  = r2(netSales - cogs);

  const sellingRows  = listBy(rows, (r) => r.subtype === 'SELLING');
  const adminRows    = listBy(rows, (r) => r.subtype === 'ADMIN' || r.subtype === 'DEPRECIATION');
  const selling      = sumBy(rows, (r) => r.subtype === 'SELLING');
  const admin        = sumBy(rows, (r) => r.subtype === 'ADMIN' || r.subtype === 'DEPRECIATION');
  const opex         = r2(selling + admin);
  const operatingProfit = r2(grossProfit - opex);

  // Akun di luar usaha pokok bisa berbalik arah: selisih stok opname yang
  // menguntungkan bersaldo kredit di akun beban, dan kalau dijumlahkan apa
  // adanya ia muncul sebagai "beban lain −69 juta" — angka yang menaikkan laba
  // bersih melampaui laba kotor dan membuat laporan tidak masuk akal dibaca.
  // Karena itu tiap akun ditempatkan menurut arah saldonya, bukan menurut
  // golongan yang tertulis pada bagan akun.
  const diLuarUsaha = (r) =>
    (r.type === 'EXPENSE' && ['TAX', 'FINANCE', 'OTHER'].includes(r.subtype)) ||
    (r.type === 'REVENUE' && r.subtype === 'OTHER_INCOME');

  const barisLuar = rows.filter((r) => diLuarUsaha(r) && Math.abs(r.balance) > 0.004);
  const keBaris = (r) => ({ code: r.code, name: r.name, amount: r2(Math.abs(r.balance)) });

  // Untung bila akun pendapatan bersaldo normal, atau akun beban berbalik kredit.
  // Tipe akun pendapatan di bagan akun ini bernama REVENUE, bukan INCOME.
  const menguntungkan = (r) => (r.type === 'REVENUE' ? r.balance > 0 : r.balance < 0);

  const otherIncomeRows = barisLuar.filter(menguntungkan).map(keBaris);
  const otherExpenseRows = barisLuar.filter((r) => !menguntungkan(r)).map(keBaris);

  const otherIncome = r2(otherIncomeRows.reduce((s, r) => s + r.amount, 0));
  const otherExpense = r2(otherExpenseRows.reduce((s, r) => s + r.amount, 0));

  const netProfit    = r2(operatingProfit + otherIncome - otherExpense);

  return {
    period: { from, to },
    grossSales,
    salesReturn,
    salesDiscount,
    netSales,
    cogs,
    grossProfit,
    grossMarginPct: netSales ? r2((grossProfit / netSales) * 100) : 0,
    selling, sellingRows,
    admin, adminRows,
    opex,
    operatingProfit,
    otherIncome, otherIncomeRows,
    otherExpense, otherExpenseRows,
    netProfit,
    netMarginPct: netSales ? r2((netProfit / netSales) * 100) : 0,
  };
}

/** Laba bersih kumulatif sejak awal buku sampai tanggal tertentu. */
function earningsToDate(asOf) {
  return incomeStatement(null, asOf).netProfit;
}

/**
 * Neraca (Balance Sheet) per tanggal.
 * Ekuitas mencakup "Laba Berjalan" (akumulasi laba yang belum ditutup),
 * sehingga Aset selalu = Kewajiban + Ekuitas tanpa perlu jurnal penutup.
 */
function balanceSheet(asOf) {
  const rows = accountBalances(null, asOf);

  const cash        = listBy(rows, (r) => r.subtype === 'CASH');
  const receivable  = listBy(rows, (r) => r.subtype === 'RECEIVABLE');
  const inventory   = listBy(rows, (r) => r.subtype === 'INVENTORY');
  const otherCur    = listBy(rows, (r) => r.subtype === 'OTHER_CURRENT');
  const fixed       = listBy(rows, (r) => r.subtype === 'FIXED_ASSET');
  const accDep      = sumBy(rows, (r) => r.subtype === 'ACC_DEPRECIATION');

  const totalCash       = sumBy(rows, (r) => r.subtype === 'CASH');
  const totalReceivable = sumBy(rows, (r) => r.subtype === 'RECEIVABLE');
  const totalInventory  = sumBy(rows, (r) => r.subtype === 'INVENTORY');
  const totalOtherCur   = sumBy(rows, (r) => r.subtype === 'OTHER_CURRENT');
  const totalFixedGross = sumBy(rows, (r) => r.subtype === 'FIXED_ASSET');
  const totalFixedNet   = r2(totalFixedGross - accDep);

  const currentAssets = r2(totalCash + totalReceivable + totalInventory + totalOtherCur);
  const totalAssets   = r2(currentAssets + totalFixedNet);

  const payable   = listBy(rows, (r) => ['PAYABLE', 'ACCRUED', 'TAX'].includes(r.subtype) && r.type === 'LIABILITY');
  const loan      = listBy(rows, (r) => r.subtype === 'LOAN');
  const totalCurrentLiab = sumBy(rows, (r) => ['PAYABLE', 'ACCRUED', 'TAX'].includes(r.subtype) && r.type === 'LIABILITY');
  const totalLoan        = sumBy(rows, (r) => r.subtype === 'LOAN');
  const totalLiabilities = r2(totalCurrentLiab + totalLoan);

  const capital  = sumBy(rows, (r) => r.subtype === 'CAPITAL');
  const drawing  = sumBy(rows, (r) => r.subtype === 'DRAWING');
  const retained = sumBy(rows, (r) => r.subtype === 'RETAINED');
  const currentEarnings = earningsToDate(asOf);
  const totalEquity = r2(capital - drawing + retained + currentEarnings);

  return {
    asOf,
    assets: {
      current: { cash, receivable, inventory, other: otherCur, totalCash, totalReceivable, totalInventory, totalOtherCur, total: currentAssets },
      fixed: { items: fixed, gross: totalFixedGross, accumulatedDepreciation: accDep, net: totalFixedNet },
      total: totalAssets,
    },
    liabilities: { current: payable, longTerm: loan, totalCurrent: totalCurrentLiab, totalLongTerm: totalLoan, total: totalLiabilities },
    equity: { capital, drawing, retained, currentEarnings, total: totalEquity },
    totalLiabilitiesAndEquity: r2(totalLiabilities + totalEquity),
    balanced: Math.abs(totalAssets - (totalLiabilities + totalEquity)) < 0.01,
  };
}

/**
 * Laporan Arus Kas.
 *
 * Metode: setiap jurnal yang menyentuh akun kas dihitung delta kasnya, lalu
 * delta itu dialokasikan ke OCF/ICF/FCF secara proporsional terhadap nilai
 * baris lawan (non-kas) berdasarkan klasifikasi `cashflow` akun lawan.
 * Baris kas boleh menimpa klasifikasi lewat kolom `journal_lines.cashflow`.
 */
function cashFlow(from, to) {
  const openingCash = from
    ? sumBy(accountBalances(null, prevDay(from)), (r) => r.is_cash === 1)
    : 0;

  const journalIds = db
    .prepare(
      `SELECT DISTINCT j.id
         FROM journals j
         JOIN journal_lines l ON l.journal_id = j.id
         JOIN accounts a      ON a.id = l.account_id
        WHERE j.posted = 1 AND a.is_cash = 1
          ${from ? 'AND j.entry_date >= ?' : ''}
          ${to ? 'AND j.entry_date <= ?' : ''}`
    )
    .all(...[from, to].filter(Boolean))
    .map((r) => r.id);

  const buckets = { OCF: 0, ICF: 0, FCF: 0 };
  const details = { OCF: {}, ICF: {}, FCF: {} };

  const lineStmt = db.prepare(
    `SELECT l.debit, l.credit, l.cashflow AS line_cf,
            a.is_cash, a.cashflow AS acc_cf, a.code, a.name
       FROM journal_lines l
       JOIN accounts a ON a.id = l.account_id
      WHERE l.journal_id = ?`
  );

  for (const jid of journalIds) {
    const lines = lineStmt.all(jid);
    const cashLines = lines.filter((l) => l.is_cash === 1);
    const otherLines = lines.filter((l) => l.is_cash !== 1);

    const cashDelta = r2(cashLines.reduce((s, l) => s + l.debit - l.credit, 0));
    if (Math.abs(cashDelta) < 0.005) continue;

    // Override eksplisit pada baris kas
    const explicit = cashLines.find((l) => l.line_cf);
    if (explicit) {
      const cls = explicit.line_cf === 'NONE' ? 'OCF' : explicit.line_cf;
      buckets[cls] += cashDelta;
      details[cls]['Lain-lain'] = r2((details[cls]['Lain-lain'] || 0) + cashDelta);
      continue;
    }

    const weighted = otherLines
      .map((l) => ({
        cls: l.acc_cf === 'NONE' ? 'OCF' : l.acc_cf,
        weight: Math.abs(l.debit - l.credit),
        label: `${l.code} — ${l.name}`,
      }))
      .filter((x) => x.weight > 0);

    const totalWeight = weighted.reduce((s, x) => s + x.weight, 0);
    if (totalWeight === 0) {
      buckets.OCF += cashDelta;
      continue;
    }

    for (const w of weighted) {
      const share = r2(cashDelta * (w.weight / totalWeight));
      buckets[w.cls] += share;
      details[w.cls][w.label] = r2((details[w.cls][w.label] || 0) + share);
    }
  }

  const toList = (obj) =>
    Object.entries(obj)
      .map(([label, amount]) => ({ label, amount: r2(amount) }))
      .filter((x) => Math.abs(x.amount) > 0.004)
      .sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount));

  const ocf = r2(buckets.OCF);
  const icf = r2(buckets.ICF);
  const fcf = r2(buckets.FCF);
  const netChange = r2(ocf + icf + fcf);

  return {
    period: { from, to },
    operating: { total: ocf, items: toList(details.OCF) },
    investing: { total: icf, items: toList(details.ICF) },
    financing: { total: fcf, items: toList(details.FCF) },
    netChange,
    openingCash: r2(openingCash),
    closingCash: r2(openingCash + netChange),
  };
}

function prevDay(dateStr) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

/** Buku Besar satu akun: saldo awal + mutasi + saldo berjalan. */
function generalLedger(accountId, from, to) {
  const account = db.prepare('SELECT * FROM accounts WHERE id = ?').get(accountId);
  if (!account) throw ruleError('Akun tidak ditemukan', 404);

  const openRow = db
    .prepare(
      `SELECT COALESCE(SUM(l.debit),0) d, COALESCE(SUM(l.credit),0) c
         FROM journal_lines l JOIN journals j ON j.id = l.journal_id
        WHERE l.account_id = ? AND j.posted = 1 ${from ? 'AND j.entry_date < ?' : ''}`
    )
    .get(...[accountId, from].filter((x) => x !== undefined && x !== null));

  let running = r2(account.normal === 'D' ? openRow.d - openRow.c : openRow.c - openRow.d);
  const opening = running;

  const params = [accountId];
  let where = 'WHERE l.account_id = ? AND j.posted = 1';
  if (from) { where += ' AND j.entry_date >= ?'; params.push(from); }
  if (to) { where += ' AND j.entry_date <= ?'; params.push(to); }

  const entries = db
    .prepare(
      `SELECT j.entry_date, j.entry_no, j.description, j.source, l.debit, l.credit, l.memo
         FROM journal_lines l JOIN journals j ON j.id = l.journal_id
         ${where}
        ORDER BY j.entry_date, j.id, l.id`
    )
    .all(...params)
    .map((e) => {
      running = r2(running + (account.normal === 'D' ? e.debit - e.credit : e.credit - e.debit));
      return { ...e, debit: r2(e.debit), credit: r2(e.credit), balance: running };
    });

  return {
    account,
    opening,
    entries,
    closing: running,
    totalDebit: r2(entries.reduce((s, e) => s + e.debit, 0)),
    totalCredit: r2(entries.reduce((s, e) => s + e.credit, 0)),
  };
}

module.exports = {
  accountBalances,
  trialBalance,
  incomeStatement,
  balanceSheet,
  cashFlow,
  generalLedger,
};
