'use strict';
const express = require('express');
const bcrypt = require('bcryptjs');
const { z } = require('zod');
const { db, getSetting, setSetting } = require('../db');
const { requireAuth, butuhIzin } = require('../middleware/auth');
const { ah, parse, httpError } = require('../utils/http');
const { saveDataUrlImage, hapusBerkas } = require('../utils/upload');
const { daftarkanEkspor } = require('../utils/ekspor');

const router = express.Router();
router.use(requireAuth);

// ==================================================================
// PENGGUNA
// ==================================================================
const tanggalOpsional = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'tanggal harus YYYY-MM-DD').optional().nullable();

const userSchema = z.object({
  name: z.string().trim().min(1).max(100),
  email: z.string().email().transform((v) => v.toLowerCase()),
  password: z.string().min(8, 'password minimal 8 karakter').optional(),
  role: z.enum(['admin', 'manager', 'staff']).default('staff'),
  // Peran baru. Kolom role lama dipertahankan sebagai cadangan bagi akun yang
  // belum ditautkan, jadi keduanya hidup berdampingan sampai semuanya beralih.
  role_id: z.number().int().positive().optional().nullable(),
  position: z.string().max(80).optional().nullable(),
  phone: z.string().max(30).optional().nullable(),
  active: z.boolean().default(true),

  // --- Data kepegawaian, semuanya boleh dikosongkan ---
  // Foto dikirim sebagai data URL dari peramban, sama seperti selfie presensi,
  // lalu disimpan sebagai berkas. Yang tersimpan di basis data hanya namanya.
  photo: z.string().optional().nullable(),
  nik: z.string().trim().max(30).optional().nullable(),
  department: z.string().trim().max(60).optional().nullable(),
  employment_status: z.enum(['TETAP', 'KONTRAK', 'MAGANG', 'HARIAN', 'MITRA']).optional().nullable(),
  join_date: tanggalOpsional,
  birth_date: tanggalOpsional,
  gender: z.enum(['L', 'P']).optional().nullable(),
  address: z.string().trim().max(250).optional().nullable(),
  emergency_name: z.string().trim().max(100).optional().nullable(),
  emergency_phone: z.string().trim().max(30).optional().nullable(),
  bank_name: z.string().trim().max(60).optional().nullable(),
  bank_account: z.string().trim().max(50).optional().nullable(),
  note: z.string().trim().max(300).optional().nullable(),

  // Dipakai menu Penggajian sebagai nilai awal tiap bulan. Yang dibayarkan
  // tetap angka pada daftar gaji periode itu, bukan angka di sini.
  base_salary: z.number().min(0).optional(),
  allowance: z.number().min(0).optional(),
});

/** Kolom kepegawaian yang ditulis apa adanya ke basis data. */
const KOLOM_TIM = [
  'nik', 'department', 'employment_status', 'join_date', 'birth_date', 'gender',
  'address', 'emergency_name', 'emergency_phone', 'bank_name', 'bank_account', 'note',
  'base_salary', 'allowance',
];

/** Semua kolom pengguna yang boleh dibaca — password_hash tidak pernah ikut. */
const KOLOM_TAMPIL = `id, name, email, role, role_id, position, phone, active, created_at, photo, ${KOLOM_TIM.join(', ')}`;

/** Kolom kepegawaian yang berupa angka, bukan teks. */
const KOLOM_ANGKA = new Set(['base_salary', 'allowance']);

/**
 * Nilai satu kolom kepegawaian untuk disimpan.
 *
 * Kolom angka tidak boleh menjadi NULL, dan yang tidak dikirim sama sekali harus
 * mempertahankan isinya yang lama — form yang belum mengenal sebuah kolom baru
 * tidak boleh diam-diam mengosongkan gaji orang hanya karena tidak mengirimnya.
 */
function nilaiTim(u, k, lama) {
  if (KOLOM_ANGKA.has(k)) {
    if (u[k] === undefined) return lama ? lama[k] || 0 : 0;
    return Number(u[k]) || 0;
  }
  return u[k] || null;
}

/**
 * Simpan foto bila yang dikirim berupa data URL baru.
 *
 * Nilai yang dikirim balik dari layar bisa berupa nama berkas yang sudah ada
 * (tidak diubah), data URL (foto baru), atau kosong (foto dihapus). Ketiganya
 * dibedakan di sini supaya menyimpan formulir tanpa menyentuh foto tidak
 * menulis ulang berkas yang sama berkali-kali.
 */
function simpanFoto(nilai, fotoLama, prefix) {
  if (nilai === undefined) return fotoLama || null;
  if (!nilai) {
    hapusBerkas(fotoLama);
    return null;
  }
  if (!/^data:/.test(nilai)) return fotoLama || null;

  const baru = saveDataUrlImage(nilai, prefix);
  hapusBerkas(fotoLama);
  return baru;
}

router.get('/users', butuhIzin('sistem.tim'), ah((req, res) => {
  const users = db
    .prepare(
      `SELECT ${KOLOM_TAMPIL.split(', ').map((k) => 'u.' + k).join(', ')}, r.name AS role_name, r.slug AS role_slug
         FROM users u LEFT JOIN roles r ON r.id = u.role_id ORDER BY u.name`
    )
    .all();
  res.json({
    users,
    // Dipakai layar untuk menunjukkan seberapa lengkap data timnya.
    ringkas: {
      total: users.length,
      aktif: users.filter((u) => u.active).length,
      berfoto: users.filter((u) => u.photo).length,
      lengkap: users.filter((u) => u.nik && u.department && u.join_date && u.phone).length,
    },
  });
}));

const STATUS_KERJA = {
  TETAP: 'Karyawan Tetap', KONTRAK: 'Kontrak', MAGANG: 'Magang',
  HARIAN: 'Harian', MITRA: 'Mitra / Freelance',
};

daftarkanEkspor(router, {
  path: '/users',
  judul: 'Data Tim',
  kolom: [
    { header: 'NIK', key: 'nik', width: 14 },
    { header: 'Nama', key: 'name', width: 28 },
    { header: 'Email', key: 'email', width: 28 },
    { header: 'Bagian', key: 'department', width: 18 },
    { header: 'Jabatan', key: 'position', width: 22 },
    { header: 'Status Kerja', key: 'status_kerja', width: 16 },
    { header: 'Peran Aplikasi', key: 'role', width: 13 },
    { header: 'Telepon', key: 'phone', width: 16 },
    { header: 'Tanggal Masuk', key: 'join_date', width: 13 },
    { header: 'Masa Kerja', key: 'masa_kerja', width: 13 },
    { header: 'Kontak Darurat', key: 'kontak_darurat', width: 26 },
    { header: 'Bank', key: 'bank', width: 22 },
    { header: 'Status Akun', key: 'status_akun', width: 12 },
  ],
  ambil: () => {
    const rows = db.prepare(`SELECT ${KOLOM_TAMPIL} FROM users ORDER BY department, name`).all();
    const hariIni = new Date();

    return {
      rows: rows.map((u) => ({
        ...u,
        status_kerja: STATUS_KERJA[u.employment_status] || '',
        status_akun: u.active ? 'Aktif' : 'Nonaktif',
        kontak_darurat: [u.emergency_name, u.emergency_phone].filter(Boolean).join(' — '),
        bank: [u.bank_name, u.bank_account].filter(Boolean).join(' — '),
        masa_kerja: masaKerja(u.join_date, hariIni),
      })),
      subtitle: 'Daftar anggota tim beserta data kepegawaiannya',
      meta: [
        ['Jumlah anggota', rows.length],
        ['Aktif', rows.filter((u) => u.active).length],
        ['Profil lengkap', rows.filter((u) => u.nik && u.department && u.join_date && u.phone).length],
      ],
    };
  },
});

/** Lama bekerja dalam tahun dan bulan, mis. "1 thn 5 bln". */
function masaKerja(mulai, sampai) {
  if (!mulai) return '';
  const awal = new Date(mulai);
  if (Number.isNaN(awal.getTime()) || awal > sampai) return '';
  let bulan = (sampai.getFullYear() - awal.getFullYear()) * 12 + (sampai.getMonth() - awal.getMonth());
  if (sampai.getDate() < awal.getDate()) bulan -= 1;
  if (bulan < 0) return '';
  const tahun = Math.floor(bulan / 12);
  const sisa = bulan % 12;
  return [tahun ? `${tahun} thn` : '', sisa ? `${sisa} bln` : ''].filter(Boolean).join(' ') || '0 bln';
}

router.post('/users', butuhIzin('sistem.tim'), ah((req, res) => {
  const u = parse(userSchema, req.body);
  if (!u.password) throw httpError(400, 'Password wajib diisi untuk pengguna baru');
  if (db.prepare('SELECT id FROM users WHERE email = ?').get(u.email)) {
    throw httpError(409, 'Email sudah terdaftar');
  }

  const foto = simpanFoto(u.photo, null, 'tim');

  const info = db
    .prepare(
      `INSERT INTO users (name, email, password_hash, role, role_id, position, phone, active, photo, ${KOLOM_TIM.join(', ')})
       VALUES (?,?,?,?,?,?,?,?,?, ${KOLOM_TIM.map(() => '?').join(', ')})`
    )
    .run(
      u.name, u.email, bcrypt.hashSync(u.password, 10), u.role, u.role_id || null,
      u.position || null, u.phone || null, u.active ? 1 : 0, foto,
      ...KOLOM_TIM.map((k) => nilaiTim(u, k, null))
    );

  res.status(201).json({
    ok: true,
    user: db.prepare(`SELECT ${KOLOM_TAMPIL} FROM users WHERE id = ?`).get(info.lastInsertRowid),
  });
}));

router.put('/users/:id', butuhIzin('sistem.tim'), ah((req, res) => {
  const u = parse(userSchema, req.body);
  const existing = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!existing) throw httpError(404, 'Pengguna tidak ditemukan');

  const dupe = db.prepare('SELECT id FROM users WHERE email = ? AND id <> ?').get(u.email, existing.id);
  if (dupe) throw httpError(409, 'Email sudah dipakai pengguna lain');

  // Admin terakhir tidak boleh diturunkan perannya atau dinonaktifkan
  if (existing.role === 'admin' && (u.role !== 'admin' || !u.active)) {
    const admins = db.prepare("SELECT COUNT(*) c FROM users WHERE role = 'admin' AND active = 1").get().c;
    if (admins <= 1) throw httpError(422, 'Minimal harus ada satu admin aktif');
  }

  const foto = simpanFoto(u.photo, existing.photo, `tim${existing.id}`);

  db.prepare(
    `UPDATE users SET name=?, email=?, role=?, role_id=?, position=?, phone=?, active=?, photo=?,
            ${KOLOM_TIM.map((k) => `${k}=?`).join(', ')}
      WHERE id=?`
  ).run(
    u.name, u.email, u.role, u.role_id || null, u.position || null, u.phone || null, u.active ? 1 : 0, foto,
    ...KOLOM_TIM.map((k) => nilaiTim(u, k, existing)),
    existing.id
  );

  if (u.password) {
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(bcrypt.hashSync(u.password, 10), existing.id);
  }

  res.json({
    ok: true,
    user: db.prepare(`SELECT ${KOLOM_TAMPIL} FROM users WHERE id = ?`).get(existing.id),
  });
}));

router.delete('/users/:id', butuhIzin('sistem.tim'), ah((req, res) => {
  const target = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!target) throw httpError(404, 'Pengguna tidak ditemukan');
  if (target.id === req.user.id) throw httpError(422, 'Anda tidak dapat menghapus akun sendiri');

  // Nonaktifkan agar riwayat presensi & transaksi tetap dapat ditelusuri
  db.prepare('UPDATE users SET active = 0 WHERE id = ?').run(target.id);
  res.json({ ok: true, message: `${target.name} dinonaktifkan` });
}));

// ==================================================================
// TITIK KANTOR (GEOFENCE)
// ==================================================================
const officeSchema = z.object({
  name: z.string().trim().min(1).max(100),
  address: z.string().max(250).optional().nullable(),
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  radius_m: z.number().min(20, 'radius minimal 20 meter').max(5000).default(150),
  active: z.boolean().default(true),
});

router.get('/offices', ah((req, res) => {
  res.json({ offices: db.prepare('SELECT * FROM offices ORDER BY name').all() });
}));

router.post('/offices', butuhIzin('sistem.kantor'), ah((req, res) => {
  const o = parse(officeSchema, req.body);
  const info = db
    .prepare('INSERT INTO offices (name, address, lat, lng, radius_m, active) VALUES (?,?,?,?,?,?)')
    .run(o.name, o.address || null, o.lat, o.lng, o.radius_m, o.active ? 1 : 0);
  res.status(201).json({ ok: true, office: db.prepare('SELECT * FROM offices WHERE id = ?').get(info.lastInsertRowid) });
}));

router.put('/offices/:id', butuhIzin('sistem.kantor'), ah((req, res) => {
  const o = parse(officeSchema, req.body);
  const existing = db.prepare('SELECT * FROM offices WHERE id = ?').get(req.params.id);
  if (!existing) throw httpError(404, 'Titik kantor tidak ditemukan');

  db.prepare('UPDATE offices SET name=?, address=?, lat=?, lng=?, radius_m=?, active=? WHERE id=?')
    .run(o.name, o.address || null, o.lat, o.lng, o.radius_m, o.active ? 1 : 0, existing.id);

  res.json({ ok: true, office: db.prepare('SELECT * FROM offices WHERE id = ?').get(existing.id) });
}));

router.delete('/offices/:id', butuhIzin('sistem.kantor'), ah((req, res) => {
  db.prepare('DELETE FROM offices WHERE id = ?').run(req.params.id);
  res.json({ ok: true, message: 'Titik kantor dihapus' });
}));

// ==================================================================
// PENGATURAN APLIKASI
// ==================================================================
const EDITABLE_SETTINGS = [
  'company_name', 'work_start', 'work_end', 'late_tolerance_minutes',
  'max_gps_accuracy_m', 'currency', 'timezone',
  // Identitas perusahaan untuk kop laporan dan berkas yang diunduh.
  'company_tagline', 'company_address', 'company_phone', 'company_email',
  'company_tax_id', 'company_website',
  // Alamat tetap aplikasi. Dipakai membuat QR pada slip gaji dan nota supplier;
  // tanpa ini alamatnya ditebak dari permintaan yang sedang berjalan, dan
  // dokumen yang dicetak dari alamat berbeda akan membawa QR yang berbeda pula.
  'app_url',
];

router.get('/settings', ah((req, res) => {
  const settings = {};
  for (const key of EDITABLE_SETTINGS) settings[key] = getSetting(key, '');
  res.json({ settings });
}));

router.put('/settings', butuhIzin('sistem.pengaturan'), ah((req, res) => {
  const patch = req.body || {};
  const applied = {};

  for (const [key, value] of Object.entries(patch)) {
    if (!EDITABLE_SETTINGS.includes(key)) continue;
    if (key === 'work_start' || key === 'work_end') {
      if (!/^\d{2}:\d{2}$/.test(String(value))) throw httpError(400, `${key} harus berformat HH:mm`);
    }
    if (key === 'timezone') {
      // Zona kosong pernah membuat halaman depan gagal total, jadi nilainya
      // diuji dulu ke runtime sebelum disimpan.
      const nama = String(value).trim();
      if (!nama) throw httpError(400, 'Zona waktu tidak boleh kosong, mis. Asia/Jakarta');
      try {
        new Intl.DateTimeFormat('en-US', { timeZone: nama }).format(new Date());
      } catch {
        throw httpError(400, `Zona waktu "${nama}" tidak dikenali, mis. Asia/Jakarta`);
      }
    }
    setSetting(key, value);
    applied[key] = String(value);
  }

  res.json({ ok: true, message: 'Pengaturan disimpan', settings: applied });
}));

module.exports = router;
