'use strict';
const { CHANNEL_MARKETPLACE } = require('./kanal');
const { db, nextNumber } = require('../db');
const { ACC } = require('../db/coa');

/** Pembulatan ke 2 desimal untuk meredam galat floating point. */
const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

/**
 * Pelanggaran aturan akuntansi adalah kesalahan input pengguna, bukan kerusakan
 * server. Error diberi `status` agar penanganan error terpusat mengirimkannya
 * sebagai 4xx — kalau tidak, di NODE_ENV=production pesannya tersamarkan
 * menjadi "Terjadi kesalahan pada server" dan pengguna tidak tahu apa yang salah.
 */
function ruleError(message, status = 422) {
  const err = new Error(message);
  err.status = status;
  return err;
}

function accountByCode(code) {
  const acc = db.prepare('SELECT * FROM accounts WHERE code = ?').get(String(code));
  if (!acc) throw ruleError(`Akun dengan kode ${code} tidak ditemukan di COA`, 404);
  return acc;
}

function accountById(id) {
  const acc = db.prepare('SELECT * FROM accounts WHERE id = ?').get(id);
  if (!acc) throw ruleError(`Akun id ${id} tidak ditemukan`, 404);
  return acc;
}

/**
 * Memposting satu jurnal dual-entry.
 *
 * @param {object} p
 * @param {string} p.date        'YYYY-MM-DD'
 * @param {string} p.description
 * @param {Array}  p.lines       [{ code|account_id, debit, credit, memo, cashflow }]
 * @param {string} [p.source]    MANUAL | SALES | RETURN | STOCK | OPNAME | ...
 * @param {number} [p.sourceId]
 * @param {number} [p.userId]
 * @returns {{id:number, entry_no:string}}
 *
 * Melempar Error bila total debit ≠ total kredit, atau bila jurnal kosong.
 */
function postJournal({ date, description, lines, source = 'MANUAL', sourceId = null, userId = null }) {
  if (!date) throw ruleError('Tanggal jurnal wajib diisi', 400);
  if (!Array.isArray(lines) || lines.length < 2) {
    throw ruleError('Jurnal minimal terdiri dari 2 baris (debit dan kredit)', 400);
  }

  // Normalisasi + buang baris nol
  const norm = lines
    .map((l) => {
      const acc = l.account_id ? accountById(l.account_id) : accountByCode(l.code);
      return {
        account_id: acc.id,
        debit: r2(l.debit),
        credit: r2(l.credit),
        memo: l.memo || null,
        cashflow: l.cashflow || null,
        // Dimensi mitra: dipakai menghitung saldo utang/piutang per pihak
        partner_id: l.partner_id || null,
      };
    })
    .filter((l) => l.debit > 0 || l.credit > 0);

  if (norm.length < 2) throw ruleError('Jurnal minimal terdiri dari 2 baris bernilai', 400);
  for (const l of norm) {
    if (l.debit > 0 && l.credit > 0) {
      throw ruleError('Satu baris jurnal tidak boleh berisi debit dan kredit sekaligus');
    }
  }

  const totalDebit = r2(norm.reduce((s, l) => s + l.debit, 0));
  const totalCredit = r2(norm.reduce((s, l) => s + l.credit, 0));

  // Aturan emas dual-entry
  if (Math.abs(totalDebit - totalCredit) > 0.009) {
    throw ruleError(
      `Jurnal tidak seimbang: Debit ${totalDebit.toLocaleString('id-ID')} ≠ Kredit ${totalCredit.toLocaleString('id-ID')}`
    );
  }
  if (totalDebit === 0) throw ruleError('Nilai jurnal tidak boleh nol', 400);

  const period = String(date).slice(0, 7);
  pastikanTerbuka(period, date);
  const entryNo = nextNumber('JV', period);

  const info = db
    .prepare(
      `INSERT INTO journals (entry_no, entry_date, description, source, source_id, created_by)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(entryNo, date, description, source, sourceId, userId);

  const insertLine = db.prepare(
    `INSERT INTO journal_lines (journal_id, account_id, debit, credit, memo, cashflow, partner_id)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  );
  for (const l of norm) {
    insertLine.run(
      info.lastInsertRowid, l.account_id, l.debit, l.credit, l.memo, l.cashflow, l.partner_id
    );
  }

  return { id: info.lastInsertRowid, entry_no: entryNo };
}

/**
 * Menolak perubahan pada bulan yang sudah ditutup.
 *
 * Diletakkan di postJournal dan deleteJournalsBySource — dua-duanya satu-satunya
 * pintu menuju buku besar. Dengan begitu penjualan, pembelian, gaji, kas, iklan,
 * dan modul apa pun yang dibuat kemudian ikut terjaga tanpa perlu diberi
 * pemeriksaan sendiri-sendiri yang bisa terlupa.
 */
function pastikanTerbuka(period, tanggal) {
  const kunci = db.prepare('SELECT period, locked_at FROM period_locks WHERE period = ?').get(period);
  if (!kunci) return;
  throw ruleError(
    `Bulan ${period} sudah ditutup pada ${kunci.locked_at}, jadi ${tanggal} tidak bisa diubah lagi. ` +
      'Buka kembali tutup bukunya bila perubahan ini memang diperlukan.',
    409
  );
}

/** Menghapus jurnal yang berasal dari dokumen tertentu (dipakai saat edit/batal). */
function deleteJournalsBySource(source, sourceId) {
  // Menghapus jurnal pada bulan tertutup sama saja dengan mengubahnya; kalau
  // hanya penulisan yang dijaga, mengubah dokumen lama akan tetap membongkar
  // laporan yang sudah ditutup — jurnalnya terhapus lalu gagal ditulis ulang.
  const terkunci = db
    .prepare(
      `SELECT DISTINCT substr(j.entry_date, 1, 7) AS period
         FROM journals j
         JOIN period_locks p ON p.period = substr(j.entry_date, 1, 7)
        WHERE j.source = ? AND j.source_id = ?`
    )
    .all(source, sourceId);

  if (terkunci.length > 0) {
    throw ruleError(
      `Dokumen ini punya jurnal pada bulan yang sudah ditutup (${terkunci.map((t) => t.period).join(', ')}), ` +
        'jadi tidak bisa diubah. Buka kembali tutup bukunya bila perubahan ini memang diperlukan.',
      409
    );
  }

  return db.prepare('DELETE FROM journals WHERE source = ? AND source_id = ?').run(source, sourceId)
    .changes;
}

/**
 * Membangun baris jurnal untuk satu order penjualan.
 * Struktur (semua nominal positif):
 *   D  Kas/Bank atau Piutang Marketplace   (net_revenue - total_fees)
 *   D  Diskon Penjualan                    (discount)
 *   D  Biaya Admin / Handling / Ongkir / Voucher / Packing / Pajak / Lain
 *      K  Penjualan                        (gross_sales)
 *   D  HPP                                 (cogs)
 *      K  Persediaan                       (cogs)
 */
function buildSalesJournalLines(o) {
  const lines = [];
  const settleAccount = o.payment_status === 'PAID'
    ? (CHANNEL_MARKETPLACE.includes(o.channel) ? ACC.BANK : ACC.CASH)
    : ACC.AR_MARKETPLACE;

  const settlement = r2(o.net_revenue - o.total_fees);

  if (settlement >= 0) {
    lines.push({
      code: settleAccount, debit: settlement, credit: 0,
      memo: 'Penerimaan bersih order',
      partner_id: o.payment_status === 'PAID' ? null : o.partner_id || null,
    });
  } else {
    // Kasus ekstrem: biaya melebihi nilai order → kas justru keluar
    lines.push({ code: settleAccount, debit: 0, credit: Math.abs(settlement), memo: 'Kekurangan bayar order' });
  }

  if (o.discount > 0) lines.push({ code: ACC.SALES_DISCOUNT, debit: r2(o.discount), credit: 0 });

  const feeMap = [
    [ACC.FEE_ADMIN, o.admin_fee, 'Biaya admin marketplace'],
    [ACC.FEE_HANDLING, o.handling_fee, 'Biaya handling'],
    [ACC.FEE_SHIPPING, o.shipping_extra, 'Ongkir ditanggung penjual'],
    [ACC.FEE_VOUCHER, o.voucher_platform, 'Voucher promo platform'],
    [ACC.FEE_PACKING, o.packing_cost, 'Biaya packing'],
    [ACC.TAX_EXPENSE, o.tax_amount, 'Pajak transaksi'],
    [ACC.OTHER_EXPENSE, o.other_cost, 'Biaya lain-lain'],
  ];
  for (const [code, amount, memo] of feeMap) {
    if (r2(amount) > 0) lines.push({ code, debit: r2(amount), credit: 0, memo });
  }

  lines.push({ code: ACC.SALES, debit: 0, credit: r2(o.gross_sales), memo: 'Penjualan' });

  if (r2(o.cogs) > 0) {
    lines.push({ code: ACC.COGS, debit: r2(o.cogs), credit: 0, memo: 'Harga pokok penjualan' });
    lines.push({ code: ACC.INVENTORY, debit: 0, credit: r2(o.cogs), memo: 'Pengurangan persediaan' });
  }

  return lines;
}

module.exports = {
  r2,
  ruleError,
  ACC,
  accountByCode,
  accountById,
  postJournal,
  deleteJournalsBySource,
  buildSalesJournalLines,
  pastikanTerbuka,
};
