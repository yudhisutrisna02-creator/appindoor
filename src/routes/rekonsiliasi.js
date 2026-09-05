'use strict';
/**
 * Rekonsiliasi bank: mencocokkan rekening koran dengan catatan aplikasi.
 *
 * Selisih antara saldo bank dan saldo di aplikasi hampir selalu punya sebab
 * yang membosankan — biaya admin bank yang belum dicatat, transfer masuk yang
 * belum diakui, atau catatan ganda. Yang sulit bukan membetulkannya, melainkan
 * MENEMUKANNYA di antara ratusan baris.
 *
 * Halaman ini menyandingkan kedua sisi lalu menyisakan yang tidak berpasangan.
 * Yang tersisa itulah pekerjaannya.
 *
 * Yang sengaja TIDAK dilakukan: membuat jurnal sendiri diam-diam agar saldonya
 * cocok. Rekonsiliasi yang "membetulkan" selisih tanpa menjelaskan sebabnya
 * hanya memindahkan masalah ke akun lain, dan menghilangkan satu-satunya
 * kesempatan mengetahui apa yang sebenarnya terjadi. Setiap catatan baru dibuat
 * lewat pintu yang sama dengan Kas Masuk/Keluar biasa, dengan kategori yang
 * dipilih orangnya.
 */
const express = require('express');
const { z } = require('zod');
const { db } = require('../db');
const { requireAuth, butuhIzin } = require('../middleware/auth');
const { ah, parse, httpError } = require('../utils/http');
const { r2, postJournal, accountByCode } = require('../utils/accounting');

const router = express.Router();
router.use(requireAuth);

/** Toleransi selisih hari saat mencocokkan otomatis. */
const TOLERANSI_HARI = 3;

const barisSchema = z.object({
  tanggal: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  keterangan: z.string().trim().max(300).optional().nullable(),
  masuk: z.number().nonnegative().default(0),
  keluar: z.number().nonnegative().default(0),
});

const imporSchema = z.object({
  account_code: z.string().trim().min(3, 'rekening wajib dipilih'),
  nama_berkas: z.string().trim().max(150).optional().nullable(),
  saldo_akhir: z.number().optional().nullable(),
  catatan: z.string().trim().max(200).optional().nullable(),
  rows: z.array(barisSchema).min(1, 'tidak ada baris yang bisa dibaca'),
});

/** Baris jurnal pada sebuah akun kas dalam rentang tanggal. */
function barisJurnalKas(accountId, dari, sampai) {
  return db
    .prepare(
      `SELECT l.id, l.debit, l.credit, l.memo,
              j.entry_no, j.entry_date, j.description, j.source, j.source_id
         FROM journal_lines l
         JOIN journals j ON j.id = l.journal_id
        WHERE l.account_id = ? AND j.entry_date BETWEEN ? AND ?
        ORDER BY j.entry_date, l.id`
    )
    .all(accountId, dari, sampai);
}

/**
 * Mencocokkan otomatis: nominal harus SAMA PERSIS, tanggal boleh meleset
 * beberapa hari.
 *
 * Nominalnya tidak diberi toleransi dengan sengaja. Dua transaksi berbeda yang
 * nominalnya mirip jauh lebih sering terjadi daripada bank yang salah menulis
 * angka, dan pasangan yang keliru lebih berbahaya daripada tidak berpasangan
 * sama sekali — yang tidak berpasangan setidaknya masih ditinjau orang.
 */
function cocokkan(barisBank, barisJurnal) {
  const terpakai = new Set();

  for (const b of barisBank) {
    if (b.journal_line_id) {
      terpakai.add(b.journal_line_id);
      continue;
    }

    const nilaiBank = r2(b.masuk) > 0 ? r2(b.masuk) : -r2(b.keluar);

    const calon = barisJurnal.filter((j) => {
      if (terpakai.has(j.id)) return false;
      const nilaiJurnal = r2(j.debit) > 0 ? r2(j.debit) : -r2(j.credit);
      if (Math.abs(nilaiJurnal - nilaiBank) > 0.004) return false;
      const beda = Math.abs(
        (new Date(j.entry_date) - new Date(b.tanggal)) / 86400000
      );
      return beda <= TOLERANSI_HARI;
    });

    // Hanya dipasangkan bila calonnya TUNGGAL. Dua calon dengan nominal dan
    // tanggal sama tidak bisa dibedakan mesin — memilih salah satunya berarti
    // menebak, dan tebakan yang salah menyembunyikan transaksi yang hilang.
    if (calon.length === 1) {
      b.journal_line_id = calon[0].id;
      b.cara_cocok = 'OTOMATIS';
      terpakai.add(calon[0].id);
    }
  }

  return barisBank;
}

/** POST /api/rekonsiliasi/impor — menyimpan rekening koran & mencocokkan. */
router.post('/impor', butuhIzin('keuangan.kas'), ah((req, res) => {
  const body = parse(imporSchema, req.body);

  const akun = accountByCode(body.account_code);
  if (!akun.is_cash) throw httpError(422, `${akun.code} · ${akun.name} bukan rekening kas/bank`);

  const tanggal = body.rows.map((r) => r.tanggal).sort();
  const dari = tanggal[0];
  const sampai = tanggal[tanggal.length - 1];

  const hasil = db.transaction(() => {
    const statementId = db
      .prepare(
        `INSERT INTO bank_statements
           (account_code, nama_berkas, periode_dari, periode_sampai, saldo_akhir, catatan, user_id)
         VALUES (?,?,?,?,?,?,?)`
      )
      .run(
        akun.code, body.nama_berkas || null, dari, sampai,
        body.saldo_akhir == null ? null : r2(body.saldo_akhir),
        body.catatan || null, req.user.id
      ).lastInsertRowid;

    const baris = body.rows.map((r) => ({
      ...r,
      masuk: r2(r.masuk),
      keluar: r2(r.keluar),
      journal_line_id: null,
      cara_cocok: null,
    }));

    cocokkan(baris, barisJurnalKas(akun.id, dari, sampai));

    const simpan = db.prepare(
      `INSERT INTO bank_statement_lines
         (statement_id, tanggal, keterangan, masuk, keluar, journal_line_id, cara_cocok)
       VALUES (?,?,?,?,?,?,?)`
    );
    for (const b of baris) {
      simpan.run(statementId, b.tanggal, b.keterangan || null, b.masuk, b.keluar,
        b.journal_line_id, b.cara_cocok);
    }

    return {
      statementId,
      total: baris.length,
      cocok: baris.filter((b) => b.journal_line_id).length,
    };
  })();

  res.status(201).json({
    ok: true,
    ...hasil,
    message:
      `${hasil.total} baris rekening koran ${akun.name} tersimpan, ` +
      `${hasil.cocok} cocok otomatis dengan catatan.`,
  });
}));

/** GET /api/rekonsiliasi — daftar rekening koran yang pernah diimpor. */
router.get('/', ah((req, res) => {
  const rows = db
    .prepare(
      `SELECT s.*, u.name AS user_name,
              (SELECT COUNT(*) FROM bank_statement_lines l WHERE l.statement_id = s.id) AS baris,
              (SELECT COUNT(*) FROM bank_statement_lines l
                WHERE l.statement_id = s.id AND l.journal_line_id IS NOT NULL) AS cocok
         FROM bank_statements s LEFT JOIN users u ON u.id = s.user_id
        ORDER BY s.id DESC LIMIT 100`
    )
    .all();

  res.json({
    rows,
    rekening: db
      .prepare('SELECT id, code, name FROM accounts WHERE is_cash = 1 AND active = 1 ORDER BY code')
      .all(),
  });
}));

/**
 * GET /api/rekonsiliasi/:id — hasil rekonsiliasi satu rekening koran.
 *
 * Dikembalikan sebagai tiga kelompok, bukan satu daftar campur: yang sudah
 * berpasangan tidak perlu ditindak, dan menyembunyikannya di antara yang perlu
 * ditindak membuat pekerjaan yang tersisa jadi tidak kelihatan.
 */
router.get('/:id(\\d+)', ah((req, res) => {
  const st = db.prepare('SELECT * FROM bank_statements WHERE id = ?').get(req.params.id);
  if (!st) throw httpError(404, 'Rekening koran tidak ditemukan');

  const akun = accountByCode(st.account_code);

  const baris = db
    .prepare(
      `SELECT l.*, j.entry_no, j.entry_date, j.description AS jurnal_deskripsi
         FROM bank_statement_lines l
         LEFT JOIN journal_lines jl ON jl.id = l.journal_line_id
         LEFT JOIN journals j ON j.id = jl.journal_id
        WHERE l.statement_id = ?
        ORDER BY l.tanggal, l.id`
    )
    .all(st.id);

  const jurnal = barisJurnalKas(akun.id, st.periode_dari, st.periode_sampai);
  const terpasang = new Set(baris.map((b) => b.journal_line_id).filter(Boolean));

  const bankSaja = baris.filter((b) => !b.journal_line_id);
  const catatanSaja = jurnal.filter((j) => !terpasang.has(j.id));

  const jum = (arr, f) => r2(arr.reduce((s, x) => s + f(x), 0));

  res.json({
    statement: st,
    akun: { code: akun.code, name: akun.name },
    cocok: baris.filter((b) => b.journal_line_id),
    bankSaja,
    catatanSaja,
    ringkas: {
      totalBaris: baris.length,
      jumlahCocok: baris.length - bankSaja.length,
      // Selisih dipecah per arah supaya kelihatan apakah yang kurang itu uang
      // masuk yang belum diakui, atau uang keluar yang belum dicatat.
      bankSaja: {
        baris: bankSaja.length,
        masuk: jum(bankSaja, (b) => b.masuk),
        keluar: jum(bankSaja, (b) => b.keluar),
      },
      catatanSaja: {
        baris: catatanSaja.length,
        masuk: jum(catatanSaja, (j) => j.debit),
        keluar: jum(catatanSaja, (j) => j.credit),
      },
      mutasiBank: r2(jum(baris, (b) => b.masuk) - jum(baris, (b) => b.keluar)),
      mutasiCatatan: r2(jum(jurnal, (j) => j.debit) - jum(jurnal, (j) => j.credit)),
    },
  });
}));

const pasangSchema = z.object({ journal_line_id: z.number().int().positive().nullable() });

/**
 * PATCH /api/rekonsiliasi/baris/:id — memasangkan atau melepas secara manual.
 *
 * Diperlukan karena pencocokan otomatis sengaja menyerah saat ragu: nominal
 * yang dipecah bank menjadi dua baris, atau transfer yang tanggalnya meleset
 * seminggu, hanya bisa dikenali orang yang tahu ceritanya.
 */
router.patch('/baris/:id(\\d+)', butuhIzin('keuangan.kas'), ah((req, res) => {
  const body = parse(pasangSchema, req.body);
  const baris = db.prepare('SELECT * FROM bank_statement_lines WHERE id = ?').get(req.params.id);
  if (!baris) throw httpError(404, 'Baris rekening koran tidak ditemukan');

  if (body.journal_line_id) {
    const dipakai = db
      .prepare('SELECT id FROM bank_statement_lines WHERE journal_line_id = ? AND id <> ?')
      .get(body.journal_line_id, baris.id);
    if (dipakai) {
      throw httpError(409, 'Catatan itu sudah dipasangkan ke baris rekening koran lain');
    }
  }

  db.prepare('UPDATE bank_statement_lines SET journal_line_id = ?, cara_cocok = ? WHERE id = ?')
    .run(body.journal_line_id, body.journal_line_id ? 'MANUAL' : null, baris.id);

  res.json({
    ok: true,
    message: body.journal_line_id ? 'Baris dipasangkan' : 'Pasangan dilepas',
  });
}));

const catatSchema = z.object({
  category_code: z.string().trim().min(3, 'kategori wajib dipilih'),
  description: z.string().trim().min(1, 'keterangan wajib diisi').max(200),
});

/**
 * POST /api/rekonsiliasi/baris/:id/catat — membuat catatan kas dari baris bank.
 *
 * Kategorinya dipilih orangnya, tidak ditebak sistem. Biaya admin bank, bunga,
 * dan transfer masuk yang belum diakui semuanya tampak sama dari sisi bank —
 * yang membedakan hanya orang yang tahu konteksnya.
 */
router.post('/baris/:id(\\d+)/catat', butuhIzin('keuangan.kas'), ah((req, res) => {
  const body = parse(catatSchema, req.body);
  const baris = db.prepare('SELECT * FROM bank_statement_lines WHERE id = ?').get(req.params.id);
  if (!baris) throw httpError(404, 'Baris rekening koran tidak ditemukan');
  if (baris.journal_line_id) throw httpError(409, 'Baris ini sudah berpasangan dengan catatan');

  const st = db.prepare('SELECT * FROM bank_statements WHERE id = ?').get(baris.statement_id);
  const kas = accountByCode(st.account_code);
  const kategori = accountByCode(body.category_code);
  if (kategori.is_cash) throw httpError(422, 'Kategori tidak boleh berupa akun kas');

  const masuk = r2(baris.masuk) > 0;
  const nilai = masuk ? r2(baris.masuk) : r2(baris.keluar);
  if (nilai <= 0) throw httpError(422, 'Baris ini tidak bernilai');

  const hasil = db.transaction(() => {
    const jurnal = postJournal({
      date: baris.tanggal,
      description: `${masuk ? 'Kas Masuk' : 'Kas Keluar'} — ${body.description}`,
      lines: masuk
        ? [
            { code: kas.code, debit: nilai, credit: 0, memo: body.description },
            { code: kategori.code, debit: 0, credit: nilai, memo: body.description },
          ]
        : [
            { code: kategori.code, debit: nilai, credit: 0, memo: body.description },
            { code: kas.code, debit: 0, credit: nilai, memo: body.description },
          ],
      source: 'CASH',
      userId: req.user.id,
    });

    // Baris jurnal pada akun kas-nya itulah pasangan baris rekening koran ini.
    const barisKas = db
      .prepare(
        `SELECT l.id FROM journal_lines l
          WHERE l.journal_id = ? AND l.account_id = ? LIMIT 1`
      )
      .get(jurnal.id, kas.id);

    db.prepare('UPDATE bank_statement_lines SET journal_line_id = ?, cara_cocok = ? WHERE id = ?')
      .run(barisKas ? barisKas.id : null, 'DICATAT', baris.id);

    return jurnal;
  })();

  res.status(201).json({
    ok: true,
    message: `Tercatat sebagai ${masuk ? 'kas masuk' : 'kas keluar'} Rp ${nilai.toLocaleString('id-ID')} (${hasil.entry_no})`,
    journal: hasil,
  });
}));

/** DELETE /api/rekonsiliasi/:id — membuang satu rekening koran yang diimpor. */
router.delete('/:id(\\d+)', butuhIzin('keuangan.kas'), ah((req, res) => {
  const st = db.prepare('SELECT * FROM bank_statements WHERE id = ?').get(req.params.id);
  if (!st) throw httpError(404, 'Rekening koran tidak ditemukan');

  // Hanya barisnya yang dibuang. Jurnal yang sempat dibuat dari sini TETAP ada:
  // ia catatan keuangan yang sah, dan menghapusnya karena rekening korannya
  // dibuang akan melubangi pembukuan tanpa ada yang menyadarinya.
  db.prepare('DELETE FROM bank_statements WHERE id = ?').run(st.id);

  res.json({ ok: true, message: 'Rekening koran dibuang. Catatan kas yang terlanjur dibuat tetap tersimpan.' });
}));

module.exports = router;
