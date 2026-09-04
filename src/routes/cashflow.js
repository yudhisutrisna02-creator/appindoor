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
const { requireAuth, butuhIzin } = require('../middleware/auth');
const { ah, parse, httpError, dateRange } = require('../utils/http');
const { r2, ACC, postJournal, deleteJournalsBySource, deleteJournalById, accountByCode } = require('../utils/accounting');
const { todayLocal } = require('../utils/time');

const router = express.Router();
router.use(requireAuth);

/** Akun kas & setara kas yang boleh dipakai sebagai sumber/tujuan dana. */
function cashAccounts() {
  return db.prepare('SELECT id, code, name FROM accounts WHERE is_cash = 1 AND active = 1 ORDER BY code').all();
}

/**
 * Akun yang punya menu sendiri, sehingga tidak boleh dicatat lewat layar kas.
 *
 * Biaya iklan dicatat di menu Biaya Iklan karena di sana belanjanya menempel ke
 * toko — itulah yang membuat ROAS dan laba per toko bisa dihitung. Bila akun
 * yang sama juga bisa dipilih di layar kas, satu belanja yang tercatat di
 * kedua tempat akan terhitung dua kali pada akun yang sama, dan labanya tampak
 * lebih kecil daripada yang sebenarnya tanpa ada tanda apa pun.
 */
const AKUN_BERMENU_SENDIRI = {
  [ACC.FEE_ADS]: 'Biaya Iklan (menu Penjualan → Biaya Iklan)',
};

/** Kategori yang masuk akal untuk pemasukan / pengeluaran non-penjualan. */
function categoryAccounts(direction) {
  const where = direction === 'IN'
    ? "type = 'REVENUE' AND subtype IN ('OTHER_INCOME','SALES')"
    : "type = 'EXPENSE' AND subtype IN ('SELLING','ADMIN','TAX','FINANCE','OTHER','COGS')";
  return db
    .prepare(`SELECT id, code, name, subtype FROM accounts WHERE ${where} AND active = 1 ORDER BY code`)
    .all()
    .filter((a) => !AKUN_BERMENU_SENDIRI[a.code]);
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
router.post('/entries', butuhIzin('keuangan.kas'), ah((req, res) => {
  const body = parse(cashSchema, req.body);

  const kas = accountByCode(body.cash_code);
  if (!kas.is_cash) throw httpError(422, `${kas.code} bukan akun kas`);

  const kategori = accountByCode(body.category_code);
  if (kategori.is_cash) throw httpError(422, 'Kategori tidak boleh berupa akun kas');

  // Ditolak di peladen, bukan hanya disembunyikan dari daftar pilihan: layar
  // lama yang masih terbuka di peramban lain tetap bisa mengirim kode ini.
  const menuSendiri = AKUN_BERMENU_SENDIRI[kategori.code];
  if (menuSendiri) {
    throw httpError(
      422,
      `${kategori.code} · ${kategori.name} dicatat lewat ${menuSendiri}, bukan dari sini. ` +
        'Mencatatnya di dua tempat membuat satu belanja terhitung dua kali pada akun yang sama.'
    );
  }

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

const pindahSchema = z.object({
  entry_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  from_code: z.string().min(1),
  to_code: z.string().min(1),
  amount: z.number().positive('nominal harus lebih dari nol'),
  note: z.string().trim().max(200).optional().nullable(),
});

/**
 * POST /api/cashflow/pindah — memindahkan saldo antar rekening sendiri.
 *
 * Menarik tunai dari bank, menyetor tunai ke bank, atau memindahkan antar bank
 * bukan pemasukan dan bukan pengeluaran: uangnya tidak bertambah dan tidak
 * berkurang, hanya berpindah tempat. Sebelum ada menu ini, satu-satunya cara
 * mencatatnya adalah dua entri terpisah — kas keluar di satu sisi dan kas masuk
 * di sisi lain — yang membuat total pemasukan dan pengeluaran bulan itu tampak
 * membengkak padahal tidak ada uang yang benar-benar mengalir keluar masuk.
 *
 * Di sini keduanya menjadi satu jurnal, sehingga arus kas bersihnya nol dengan
 * sendirinya dan tidak bisa dicatat separuh.
 */
router.post('/pindah', butuhIzin('keuangan.kas'), ah((req, res) => {
  const body = parse(pindahSchema, req.body);

  const asal = accountByCode(body.from_code);
  const tujuan = accountByCode(body.to_code);

  if (!asal.is_cash) throw httpError(422, `${asal.code} · ${asal.name} bukan rekening kas/bank`);
  if (!tujuan.is_cash) throw httpError(422, `${tujuan.code} · ${tujuan.name} bukan rekening kas/bank`);
  if (asal.code === tujuan.code) {
    throw httpError(422, 'Rekening asal dan tujuan tidak boleh sama');
  }

  const nilai = r2(body.amount);
  const keterangan = body.note
    ? `${asal.name} → ${tujuan.name} — ${body.note}`
    : `${asal.name} → ${tujuan.name}`;

  const journal = postJournal({
    date: body.entry_date,
    description: `Pindah Saldo — ${keterangan}`,
    lines: [
      { code: tujuan.code, debit: nilai, credit: 0, memo: `Masuk dari ${asal.name}` },
      { code: asal.code, debit: 0, credit: nilai, memo: `Pindah ke ${tujuan.name}` },
    ],
    source: 'TRANSFER',
    userId: req.user.id,
  });

  res.status(201).json({
    ok: true,
    message:
      `Rp ${nilai.toLocaleString('id-ID')} dipindahkan dari ${asal.name} ke ${tujuan.name} (${journal.entry_no})`,
    journal,
  });
}));

/** GET /api/cashflow/pindah — riwayat pemindahan saldo. */
router.get('/pindah', ah((req, res) => {
  const { from, to } = dateRange(req.query);

  const rows = db
    .prepare(
      `SELECT j.id, j.entry_no, j.entry_date AS date, j.description,
              (SELECT a.name FROM journal_lines l JOIN accounts a ON a.id = l.account_id
                WHERE l.journal_id = j.id AND l.credit > 0 LIMIT 1) AS dari,
              (SELECT a.name FROM journal_lines l JOIN accounts a ON a.id = l.account_id
                WHERE l.journal_id = j.id AND l.debit > 0 LIMIT 1)  AS ke,
              (SELECT SUM(l.debit) FROM journal_lines l WHERE l.journal_id = j.id) AS nilai
         FROM journals j
        WHERE j.source = 'TRANSFER' AND j.entry_date BETWEEN ? AND ?
        ORDER BY j.entry_date DESC, j.id DESC
        LIMIT 200`
    )
    .all(from, to);

  res.json({
    from, to, rows,
    total: r2(rows.reduce((n, r) => n + (r.nilai || 0), 0)),
    rekening: cashAccounts(),
  });
}));

/** DELETE /api/cashflow/pindah/:id — membatalkan satu pemindahan. */
router.delete('/pindah/:id(\\d+)', butuhIzin('keuangan.kas'), ah((req, res) => {
  const j = db
    .prepare("SELECT id, entry_no FROM journals WHERE id = ? AND source = 'TRANSFER'")
    .get(req.params.id);
  if (!j) throw httpError(404, 'Pemindahan saldo tidak ditemukan');

  // Lewat pintu yang sama dengan penghapusan jurnal lain, supaya kunci periode
  // tetap berlaku: pemindahan di bulan yang sudah ditutup tidak bisa dihapus.
  deleteJournalById(j.id);

  res.json({ ok: true, message: `Pemindahan ${j.entry_no} dibatalkan` });
}));

/** Dari mana sebuah pergerakan kas berasal, dalam bahasa yang dikenali pemakai. */
const LABEL_SUMBER = {
  CASH: 'Catatan Kas',
  ADS: 'Biaya Iklan',
  SALES: 'Penjualan',
  STOCK: 'Barang Masuk',
  SETTLEMENT: 'Pelunasan Utang/Piutang',
  TRANSFER: 'Pindah Saldo',
  OPNAME: 'Stok Opname',
  MANUAL: 'Jurnal Manual',
};

/**
 * Saldo tiap rekening kas & bank, berikut asal pergerakannya.
 *
 * Satu usaha bisa memakai banyak rekening — sheet iklan saja menyebut sepuluh
 * nama rekening berbeda. Selama semuanya menumpuk di satu akun, tidak ada cara
 * mencocokkan aplikasi dengan mutasi bank yang sebenarnya; yang cocok hanya
 * jumlah keseluruhannya, dan itu tidak menolong siapa pun yang sedang mencari
 * selisih.
 */
function rekeningKas(req) {
  const asOf = req.query.asOf || todayLocal();

  const akun = db
    .prepare("SELECT id, code, name FROM accounts WHERE is_cash = 1 AND active = 1 ORDER BY code")
    .all();

  const rows = akun.map((a) => {
    const saldo = db
      .prepare(
        `SELECT COALESCE(SUM(l.debit) - SUM(l.credit), 0) AS saldo,
                COUNT(*) AS mutasi,
                MAX(j.entry_date) AS terakhir
           FROM journal_lines l JOIN journals j ON j.id = l.journal_id
          WHERE l.account_id = ? AND j.entry_date <= ?`
      )
      .get(a.id, asOf);

    const perSumber = db
      .prepare(
        `SELECT j.source,
                COALESCE(SUM(l.debit), 0)  AS masuk,
                COALESCE(SUM(l.credit), 0) AS keluar
           FROM journal_lines l JOIN journals j ON j.id = l.journal_id
          WHERE l.account_id = ? AND j.entry_date <= ?
          GROUP BY j.source ORDER BY (SUM(l.debit) + SUM(l.credit)) DESC`
      )
      .all(a.id, asOf)
      .map((x) => ({
        sumber: LABEL_SUMBER[x.source] || x.source,
        masuk: r2(x.masuk),
        keluar: r2(x.keluar),
      }));

    return {
      ...a,
      saldo: r2(saldo.saldo),
      mutasi: saldo.mutasi,
      terakhir: saldo.terakhir,
      perSumber,
      // Kas atau bank yang minus tidak mungkin secara fisik. Umumnya karena ada
      // pengeluaran tercatat sementara pemasukannya belum, atau beberapa
      // rekening yang sebenarnya berbeda digabung ke satu akun.
      minus: saldo.saldo < -0.004,
    };
  });

  return {
    asOf,
    rows,
    ringkas: {
      total: r2(rows.reduce((s2, x) => s2 + x.saldo, 0)),
      jumlahRekening: rows.length,
      minus: rows.filter((x) => x.minus).length,
    },
  };
}

router.get('/rekening', ah((req, res) => res.json(rekeningKas(req))));

daftarkanEkspor(router, {
  path: '/rekening',
  judul: 'Rekening Kas & Bank',
  kolom: [
    { header: 'Kode', key: 'code', width: 10 },
    { header: 'Nama Rekening', key: 'name', width: 34 },
    { header: 'Saldo', key: 'saldo', width: 20, money: true },
    { header: 'Jumlah Mutasi', key: 'mutasi', width: 14 },
    { header: 'Mutasi Terakhir', key: 'terakhir', width: 16 },
  ],
  ambil: (req) => {
    const d = rekeningKas(req);
    return {
      rows: d.rows,
      subtitle: `Saldo per ${d.asOf}`,
      meta: [
        ['Jumlah rekening', d.ringkas.jumlahRekening],
        ['Total saldo', d.ringkas.total],
        ['Rekening bersaldo minus', d.ringkas.minus],
      ],
    };
  },
});

/**
 * Riwayat kas masuk & keluar.
 *
 * Menampilkan SEMUA jurnal yang menyentuh akun kas atau bank, bukan hanya yang
 * diketik lewat layar ini. Sebelumnya daftarnya disaring ke source='CASH'
 * saja, sehingga belanja iklan, pembelian barang, dan penerimaan penjualan —
 * yang semuanya benar-benar menggerakkan uang — tidak tampak di sini. Akibatnya
 * total di layar ini tidak pernah cocok dengan saldo kas di Neraca, dan yang
 * membacanya tidak punya cara tahu ke mana selisihnya pergi.
 *
 * Barisnya tetap dibedakan menurut asalnya, dan hanya catatan kas manual yang
 * boleh dihapus dari sini: menghapus jurnal milik order atau belanja iklan dari
 * layar ini akan menyisakan dokumen aslinya tanpa jurnal, dan itu justru
 * merusak kecocokan yang sedang diusahakan.
 */
function ambilKas(req) {
  const { from, to } = dateRange(req.query);

  const rows = db
    .prepare(
      `SELECT j.id, j.entry_no, j.entry_date, j.description, j.source, u.name AS user_name,
              (SELECT COALESCE(SUM(l.debit),0) FROM journal_lines l
                 JOIN accounts a ON a.id = l.account_id
                WHERE l.journal_id = j.id AND a.is_cash = 1) AS masuk,
              (SELECT COALESCE(SUM(l.credit),0) FROM journal_lines l
                 JOIN accounts a ON a.id = l.account_id
                WHERE l.journal_id = j.id AND a.is_cash = 1) AS keluar,
              (SELECT a.code || ' · ' || a.name FROM journal_lines l
                 JOIN accounts a ON a.id = l.account_id
                WHERE l.journal_id = j.id AND a.is_cash = 0
                ORDER BY (l.debit + l.credit) DESC LIMIT 1) AS kategori
         FROM journals j
         LEFT JOIN users u ON u.id = j.created_by
        WHERE j.entry_date BETWEEN ? AND ?
          AND EXISTS (
            SELECT 1 FROM journal_lines l
              JOIN accounts a ON a.id = l.account_id
             WHERE l.journal_id = j.id AND a.is_cash = 1
          )
        ORDER BY j.entry_date DESC, j.id DESC`
    )
    .all(from, to)
    .map((r) => ({
      ...r,
      sumber: LABEL_SUMBER[r.source] || r.source,
      // Hanya catatan yang lahir di layar ini yang boleh dihapus dari sini.
      bisaHapus: r.source === 'CASH',
    }));

  const perSumber = [...rows.reduce((m, r) => {
    const c = m.get(r.sumber) || { sumber: r.sumber, masuk: 0, keluar: 0, baris: 0 };
    c.masuk += r.masuk;
    c.keluar += r.keluar;
    c.baris += 1;
    m.set(r.sumber, c);
    return m;
  }, new Map()).values()]
    .map((c) => ({ ...c, masuk: r2(c.masuk), keluar: r2(c.keluar) }))
    .sort((a, b) => b.keluar + b.masuk - (a.keluar + a.masuk));

  return {
    from, to, rows, perSumber,
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
    { header: 'Sumber', key: 'sumber', width: 20 },
    { header: 'Kategori', key: 'kategori', width: 30 },
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

router.delete('/entries/:id', butuhIzin('keuangan.kas'), ah((req, res) => {
  const journal = db.prepare('SELECT * FROM journals WHERE id = ?').get(req.params.id);
  if (!journal) throw httpError(404, 'Catatan kas tidak ditemukan');
  if (journal.source !== 'CASH') {
    throw httpError(
      422,
      `${journal.entry_no} berasal dari ${LABEL_SUMBER[journal.source] || journal.source} — ` +
        'hapus atau ubah dari menu asalnya agar dokumen dan jurnalnya tetap sejalan'
    );
  }

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
router.post('/settlements', butuhIzin('keuangan.kas'), ah((req, res) => {
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
// Dipakai ulang oleh Pusat Perhatian supaya angka peringatannya tidak pernah
// berbeda dari angka yang tampil di menu ini sendiri.
module.exports.rekeningKas = rekeningKas;
