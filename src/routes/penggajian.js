'use strict';
/**
 * Penggajian bulanan.
 *
 * Sampai sekarang presensi berhenti sebagai catatan: siapa hadir, siapa telat,
 * siapa tidak masuk — lalu tidak berbuat apa-apa. Menu ini yang menyambungkannya
 * ke pembukuan, sehingga kehadiran punya akibat dan beban gaji tidak lagi
 * diketik ulang dari kertas.
 *
 * Dua hal yang dijaga di sini:
 *
 *  1. Nilai gaji DISALIN ke daftar saat disusun, bukan dibaca ulang dari akun
 *     orangnya. Kalau dibaca ulang, menaikkan gaji seseorang hari ini akan
 *     diam-diam mengubah slip bulan-bulan yang sudah dibayar.
 *
 *  2. Potongan karena tidak masuk hanya DISARANKAN, tidak pernah dipotong
 *     sendiri. Alasan seseorang tidak masuk tidak pernah seluruhnya ada di
 *     dalam basis data, dan aplikasi yang memotong gaji atas dasar itu akan
 *     salah pada hari yang paling tidak tepat.
 */
const express = require('express');
const { z } = require('zod');
const { db } = require('../db');
const { requireAuth, butuhIzin } = require('../middleware/auth');
const { ah, parse, httpError } = require('../utils/http');
const {
  r2, ACC, postJournal, deleteJournalsBySource, accountByCode,
} = require('../utils/accounting');
const { daftarkanEkspor } = require('../utils/ekspor');

const router = express.Router();
router.use(requireAuth);

const PERIODE = /^\d{4}-\d{2}$/;
const TANGGAL = /^\d{4}-\d{2}-\d{2}$/;

const buatSchema = z.object({
  period: z.string().regex(PERIODE, 'periode harus berbentuk YYYY-MM'),
  pay_date: z.string().regex(TANGGAL).optional(),
  payment: z.enum(['CASH', 'BANK', 'CREDIT']).default('BANK'),
  cash_code: z.string().trim().min(3).optional().nullable(),
  note: z.string().trim().max(300).optional().nullable(),
});

const ubahSchema = z.object({
  pay_date: z.string().regex(TANGGAL).optional(),
  payment: z.enum(['CASH', 'BANK', 'CREDIT']).optional(),
  cash_code: z.string().trim().min(3).optional().nullable(),
  note: z.string().trim().max(300).optional().nullable(),
});

const barisSchema = z.object({
  base: z.number().min(0).optional(),
  allowance: z.number().min(0).optional(),
  overtime: z.number().min(0).optional(),
  bonus: z.number().min(0).optional(),
  deduction: z.number().min(0).optional(),
  note: z.string().trim().max(200).optional().nullable(),
});

const batasBulan = (period) => ({ from: `${period}-01`, to: `${period}-31` });

/** Gaji bersih satu baris. Ditulis sekali supaya layar dan jurnal tidak berbeda. */
const hitungNet = (b) =>
  r2((b.base || 0) + (b.allowance || 0) + (b.overtime || 0) + (b.bonus || 0) - (b.deduction || 0));

/**
 * Akun lawan sesuai sumber dananya.
 *
 * CREDIT berarti gajinya sudah menjadi beban bulan ini tetapi uangnya belum
 * keluar — lawannya Utang Gaji. Memaksakan rekening kas ke sana akan mengurangi
 * saldo bank yang sebenarnya belum berkurang.
 */
function akunLawan(payment, cashCode) {
  if (payment === 'CREDIT') return ACC.SALARY_PAYABLE;
  if (cashCode) {
    const akun = accountByCode(cashCode);
    if (!akun.is_cash) throw httpError(422, `${akun.code} bukan akun kas atau bank`);
    return akun.code;
  }
  return payment === 'CASH' ? ACC.CASH : ACC.BANK;
}

const MEMO_LAWAN = {
  CASH: 'Pembayaran gaji tunai',
  BANK: 'Pembayaran gaji lewat bank',
  CREDIT: 'Gaji belum dibayarkan',
};

/** Rekap presensi seluruh pegawai pada satu periode. */
function rekapPresensi(period) {
  const { from, to } = batasBulan(period);
  return new Map(
    db
      .prepare(
        `SELECT user_id,
                SUM(CASE WHEN status IN ('ONTIME','LATE') THEN 1 ELSE 0 END) AS hadir,
                SUM(CASE WHEN status = 'LATE'   THEN 1 ELSE 0 END)           AS telat,
                SUM(CASE WHEN status = 'LEAVE'  THEN 1 ELSE 0 END)           AS izin,
                SUM(CASE WHEN status = 'ABSENT' THEN 1 ELSE 0 END)           AS alpa
           FROM attendance
          WHERE work_date BETWEEN ? AND ?
          GROUP BY user_id`
      )
      .all(from, to)
      .map((r) => [r.user_id, r])
  );
}

/**
 * Hari kerja pada sebuah bulan — Senin sampai Sabtu.
 *
 * Dipakai hanya untuk menghitung nilai satu hari kerja pada saran potongan,
 * bukan untuk menilai kehadiran siapa pun. Hari libur nasional tidak dikenali;
 * itulah salah satu sebab angkanya berhenti sebagai saran.
 */
function hariKerja(period) {
  const [th, bl] = period.split('-').map(Number);
  const akhir = new Date(Date.UTC(th, bl, 0)).getUTCDate();
  let n = 0;
  for (let d = 1; d <= akhir; d += 1) {
    if (new Date(Date.UTC(th, bl - 1, d)).getUTCDay() !== 0) n += 1;
  }
  return n;
}

const ambilDaftar = db.prepare('SELECT * FROM payrolls WHERE id = ?');

/** Satu daftar gaji beserta barisnya dan rekap presensinya. */
function detail(id) {
  const p = ambilDaftar.get(id);
  if (!p) throw httpError(404, 'Daftar gaji tidak ditemukan');

  const rows = db
    .prepare(
      `SELECT i.*, u.name, u.email, u.position, u.department, u.employment_status,
              u.bank_name, u.bank_account, u.photo
         FROM payroll_items i
         JOIN users u ON u.id = i.employee_id
        WHERE i.payroll_id = ?
        ORDER BY u.name`
    )
    .all(id);

  const hk = hariKerja(p.period);

  const isi = rows.map((r) => {
    // Nilai satu hari kerja dihitung dari gaji pokok pada periode ini, bukan
    // dari master, supaya sarannya cocok dengan angka yang benar-benar dipakai.
    const perHari = hk > 0 ? r2(r.base / hk) : 0;
    return {
      ...r,
      net: hitungNet(r),
      hari_kerja: hk,
      nilai_per_hari: perHari,
      // Saran, bukan keputusan. Lihat catatan di kepala berkas ini.
      potongan_saran: r2(perHari * r.alpa),
    };
  });

  const total = isi.reduce(
    (a, r) => {
      a.base += r.base;
      a.allowance += r.allowance;
      a.overtime += r.overtime;
      a.bonus += r.bonus;
      a.deduction += r.deduction;
      a.net += r.net;
      a.hadir += r.hadir;
      a.telat += r.telat;
      a.izin += r.izin;
      a.alpa += r.alpa;
      return a;
    },
    { base: 0, allowance: 0, overtime: 0, bonus: 0, deduction: 0, net: 0, hadir: 0, telat: 0, izin: 0, alpa: 0 }
  );
  for (const k of ['base', 'allowance', 'overtime', 'bonus', 'deduction', 'net']) total[k] = r2(total[k]);

  const jurnal = db
    .prepare(
      `SELECT j.id, j.entry_no, j.entry_date, j.description
         FROM journals j WHERE j.source = 'PAYROLL' AND j.source_id = ?`
    )
    .all(id);

  return {
    ...p,
    terkunci: p.status === 'POSTED',
    hari_kerja: hk,
    rows: isi,
    total,
    jurnal,
  };
}

/**
 * Menyusun daftar gaji baru.
 *
 * Seluruh pegawai aktif ikut, termasuk yang gaji pokoknya masih nol — orang
 * yang belum diisi gajinya justru yang paling mudah terlewat, dan barisnya yang
 * kosong itulah tandanya.
 */
const buatDaftar = db.transaction((body, userId) => {
  const ada = db.prepare('SELECT id FROM payrolls WHERE period = ?').get(body.period);
  if (ada) throw httpError(409, `Daftar gaji ${body.period} sudah ada`);

  const info = db
    .prepare(
      `INSERT INTO payrolls (period, pay_date, status, payment, cash_code, note, user_id)
       VALUES (?,?,'DRAFT',?,?,?,?)`
    )
    .run(
      body.period,
      body.pay_date || `${body.period}-25`,
      body.payment,
      body.cash_code || null,
      body.note || null,
      userId
    );

  const id = info.lastInsertRowid;
  const presensi = rekapPresensi(body.period);
  const pegawai = db
    .prepare('SELECT id, base_salary, allowance FROM users WHERE active = 1 ORDER BY name')
    .all();

  const tambah = db.prepare(
    `INSERT INTO payroll_items
       (payroll_id, employee_id, base, allowance, overtime, bonus, deduction, net, hadir, telat, izin, alpa)
     VALUES (?,?,?,?,0,0,0,?,?,?,?,?)`
  );

  for (const u of pegawai) {
    const a = presensi.get(u.id) || { hadir: 0, telat: 0, izin: 0, alpa: 0 };
    const net = hitungNet({ base: u.base_salary, allowance: u.allowance });
    tambah.run(id, u.id, r2(u.base_salary), r2(u.allowance), net, a.hadir, a.telat, a.izin, a.alpa);
  }

  return id;
});

router.get('/', ah((req, res) => {
  const rows = db
    .prepare(
      `SELECT p.*,
              (SELECT COUNT(*) FROM payroll_items i WHERE i.payroll_id = p.id)      AS pegawai,
              (SELECT COALESCE(SUM(i.net), 0) FROM payroll_items i WHERE i.payroll_id = p.id) AS total
         FROM payrolls p ORDER BY p.period DESC`
    )
    .all();

  const ringkas = {
    daftar: rows.length,
    draft: rows.filter((r) => r.status === 'DRAFT').length,
    totalTerbayar: r2(rows.filter((r) => r.status === 'POSTED').reduce((s, r) => s + r.total, 0)),
  };
  res.json({ rows, ringkas });
}));

router.get('/:id(\\d+)', ah((req, res) => res.json(detail(Number(req.params.id)))));

router.post('/', butuhIzin('penggajian.kelola'), ah((req, res) => {
  const body = parse(buatSchema, req.body);
  if (body.cash_code) akunLawan(body.payment, body.cash_code); // validasi lebih awal
  const id = buatDaftar(body, req.user.id);
  res.status(201).json({ ok: true, payroll: detail(id), message: `Daftar gaji ${body.period} disusun` });
}));

/** Menolak perubahan pada daftar yang sudah diposting. */
function pastikanDraft(id) {
  const p = ambilDaftar.get(id);
  if (!p) throw httpError(404, 'Daftar gaji tidak ditemukan');
  if (p.status === 'POSTED') {
    throw httpError(422, 'Daftar gaji sudah diposting — batalkan postingnya dulu sebelum diubah');
  }
  return p;
}

router.put('/:id(\\d+)', butuhIzin('penggajian.kelola'), ah((req, res) => {
  const id = Number(req.params.id);
  const p = pastikanDraft(id);
  const body = parse(ubahSchema, req.body);
  const payment = body.payment || p.payment;
  const cashCode = body.cash_code === undefined ? p.cash_code : body.cash_code;
  if (cashCode) akunLawan(payment, cashCode);

  db.prepare(
    'UPDATE payrolls SET pay_date = ?, payment = ?, cash_code = ?, note = ? WHERE id = ?'
  ).run(
    body.pay_date || p.pay_date,
    payment,
    cashCode || null,
    body.note === undefined ? p.note : body.note || null,
    id
  );
  res.json({ ok: true, payroll: detail(id), message: 'Daftar gaji diperbarui' });
}));

router.put('/:id(\\d+)/baris/:itemId(\\d+)', butuhIzin('penggajian.kelola'), ah((req, res) => {
  const id = Number(req.params.id);
  pastikanDraft(id);

  const baris = db
    .prepare('SELECT * FROM payroll_items WHERE id = ? AND payroll_id = ?')
    .get(Number(req.params.itemId), id);
  if (!baris) throw httpError(404, 'Baris gaji tidak ditemukan');

  const body = parse(barisSchema, req.body);
  const isi = {
    base: body.base === undefined ? baris.base : r2(body.base),
    allowance: body.allowance === undefined ? baris.allowance : r2(body.allowance),
    overtime: body.overtime === undefined ? baris.overtime : r2(body.overtime),
    bonus: body.bonus === undefined ? baris.bonus : r2(body.bonus),
    deduction: body.deduction === undefined ? baris.deduction : r2(body.deduction),
  };
  const net = hitungNet(isi);
  if (net < 0) throw httpError(422, 'Potongan melebihi gaji — gaji bersih tidak boleh minus');

  db.prepare(
    `UPDATE payroll_items
        SET base = ?, allowance = ?, overtime = ?, bonus = ?, deduction = ?, net = ?, note = ?
      WHERE id = ?`
  ).run(
    isi.base, isi.allowance, isi.overtime, isi.bonus, isi.deduction, net,
    body.note === undefined ? baris.note : body.note || null,
    baris.id
  );

  res.json({ ok: true, payroll: detail(id), message: 'Baris gaji diperbarui' });
}));

router.delete('/:id(\\d+)/baris/:itemId(\\d+)', butuhIzin('penggajian.kelola'), ah((req, res) => {
  const id = Number(req.params.id);
  pastikanDraft(id);
  const info = db
    .prepare('DELETE FROM payroll_items WHERE id = ? AND payroll_id = ?')
    .run(Number(req.params.itemId), id);
  if (info.changes === 0) throw httpError(404, 'Baris gaji tidak ditemukan');
  res.json({ ok: true, payroll: detail(id), message: 'Baris dikeluarkan dari daftar gaji' });
}));

/**
 * Memposting daftar gaji ke pembukuan.
 *
 *   D  Beban Gaji & Tunjangan   sebesar total gaji bersih
 *   K  Kas / Bank / Utang Gaji  sebesar yang sama
 *
 * Potongan sengaja tidak dibukukan sebagai baris tersendiri: yang benar-benar
 * menjadi beban perusahaan adalah jumlah yang dibayarkan. Rinciannya tetap
 * tersimpan pada tiap baris untuk slip gajinya.
 */
const postingDaftar = db.transaction((id, userId) => {
  const p = ambilDaftar.get(id);
  if (!p) throw httpError(404, 'Daftar gaji tidak ditemukan');
  if (p.status === 'POSTED') throw httpError(422, 'Daftar gaji ini sudah diposting');

  const rows = db.prepare('SELECT * FROM payroll_items WHERE payroll_id = ?').all(id);
  if (rows.length === 0) throw httpError(422, 'Daftar gaji masih kosong');

  const total = r2(rows.reduce((s, r) => s + hitungNet(r), 0));
  if (total <= 0) {
    throw httpError(422, 'Total gaji masih nol — isi gaji pokok pegawai terlebih dahulu');
  }

  const lawan = akunLawan(p.payment, p.cash_code);

  postJournal({
    date: p.pay_date,
    description: `Gaji ${p.period} — ${rows.length} pegawai`,
    source: 'PAYROLL',
    sourceId: id,
    userId,
    lines: [
      { code: ACC.SALARY, debit: total, credit: 0, memo: 'Beban gaji & tunjangan' },
      { code: lawan, debit: 0, credit: total, memo: MEMO_LAWAN[p.payment] },
    ],
  });

  db.prepare("UPDATE payrolls SET status = 'POSTED', posted_at = datetime('now') WHERE id = ?").run(id);
  return total;
});

router.post('/:id(\\d+)/posting', butuhIzin('penggajian.posting'), ah((req, res) => {
  const id = Number(req.params.id);
  const total = postingDaftar(id, req.user.id);
  res.json({ ok: true, payroll: detail(id), message: `Gaji diposting — total ${total}` });
}));

/**
 * Membatalkan posting.
 *
 * Jurnalnya dihapus, daftarnya kembali menjadi draft. Angka gajinya tidak
 * disentuh sama sekali — yang batal adalah pembukuannya, bukan perhitungannya.
 */
const batalkanPosting = db.transaction((id) => {
  const p = ambilDaftar.get(id);
  if (!p) throw httpError(404, 'Daftar gaji tidak ditemukan');
  if (p.status !== 'POSTED') throw httpError(422, 'Daftar gaji ini belum diposting');
  deleteJournalsBySource('PAYROLL', id);
  db.prepare("UPDATE payrolls SET status = 'DRAFT', posted_at = NULL WHERE id = ?").run(id);
});

router.post('/:id(\\d+)/batal-posting', butuhIzin('penggajian.posting'), ah((req, res) => {
  const id = Number(req.params.id);
  batalkanPosting(id);
  res.json({ ok: true, payroll: detail(id), message: 'Posting dibatalkan, daftar kembali menjadi draft' });
}));

router.delete('/:id(\\d+)', butuhIzin('penggajian.kelola'), ah((req, res) => {
  const id = Number(req.params.id);
  const p = pastikanDraft(id);
  db.prepare('DELETE FROM payrolls WHERE id = ?').run(id);
  res.json({ ok: true, message: `Daftar gaji ${p.period} dihapus` });
}));

daftarkanEkspor(router, {
  path: '/:id(\\d+)',
  judul: 'Daftar Gaji',
  kolom: [
    { header: 'Nama', key: 'name', width: 24 },
    { header: 'Jabatan', key: 'position', width: 20 },
    { header: 'Bank', key: 'bank_name', width: 14 },
    { header: 'No. Rekening', key: 'bank_account', width: 20 },
    { header: 'Hadir', key: 'hadir', width: 8 },
    { header: 'Telat', key: 'telat', width: 8 },
    { header: 'Izin', key: 'izin', width: 8 },
    { header: 'Alpa', key: 'alpa', width: 8 },
    { header: 'Gaji Pokok', key: 'base', width: 15, money: true },
    { header: 'Tunjangan', key: 'allowance', width: 14, money: true },
    { header: 'Lembur', key: 'overtime', width: 13, money: true },
    { header: 'Bonus', key: 'bonus', width: 13, money: true },
    { header: 'Potongan', key: 'deduction', width: 13, money: true },
    { header: 'Gaji Bersih', key: 'net', width: 16, money: true },
  ],
  ambil: (req) => {
    const d = detail(Number(req.params.id));
    return {
      rows: d.rows,
      subtitle: `Periode ${d.period} — dibayar ${d.pay_date} — ${d.status === 'POSTED' ? 'sudah diposting' : 'masih draft'}`,
      meta: [
        ['Jumlah pegawai', d.rows.length],
        ['Total gaji pokok', d.total.base],
        ['Total tunjangan', d.total.allowance],
        ['Total potongan', d.total.deduction],
        ['Total dibayarkan', d.total.net],
      ],
    };
  },
});

module.exports = router;
