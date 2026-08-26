'use strict';
const express = require('express');
const bcrypt = require('bcryptjs');
const { z } = require('zod');
const { db, getSetting, setSetting } = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');
const { ah, parse, httpError } = require('../utils/http');

const router = express.Router();
router.use(requireAuth);

// ==================================================================
// PENGGUNA
// ==================================================================
const userSchema = z.object({
  name: z.string().trim().min(1).max(100),
  email: z.string().email().transform((v) => v.toLowerCase()),
  password: z.string().min(8, 'password minimal 8 karakter').optional(),
  role: z.enum(['admin', 'manager', 'staff']).default('staff'),
  position: z.string().max(80).optional().nullable(),
  phone: z.string().max(30).optional().nullable(),
  active: z.boolean().default(true),
});

router.get('/users', requireRole('admin', 'manager'), ah((req, res) => {
  const users = db
    .prepare('SELECT id, name, email, role, position, phone, active, created_at FROM users ORDER BY name')
    .all();
  res.json({ users });
}));

router.post('/users', requireRole('admin'), ah((req, res) => {
  const u = parse(userSchema, req.body);
  if (!u.password) throw httpError(400, 'Password wajib diisi untuk pengguna baru');
  if (db.prepare('SELECT id FROM users WHERE email = ?').get(u.email)) {
    throw httpError(409, 'Email sudah terdaftar');
  }

  const info = db
    .prepare(
      `INSERT INTO users (name, email, password_hash, role, position, phone, active)
       VALUES (?,?,?,?,?,?,?)`
    )
    .run(u.name, u.email, bcrypt.hashSync(u.password, 10), u.role, u.position || null, u.phone || null, u.active ? 1 : 0);

  res.status(201).json({
    ok: true,
    user: db.prepare('SELECT id, name, email, role, position, phone, active FROM users WHERE id = ?').get(info.lastInsertRowid),
  });
}));

router.put('/users/:id', requireRole('admin'), ah((req, res) => {
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

  db.prepare(
    'UPDATE users SET name=?, email=?, role=?, position=?, phone=?, active=? WHERE id=?'
  ).run(u.name, u.email, u.role, u.position || null, u.phone || null, u.active ? 1 : 0, existing.id);

  if (u.password) {
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(bcrypt.hashSync(u.password, 10), existing.id);
  }

  res.json({
    ok: true,
    user: db.prepare('SELECT id, name, email, role, position, phone, active FROM users WHERE id = ?').get(existing.id),
  });
}));

router.delete('/users/:id', requireRole('admin'), ah((req, res) => {
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

router.post('/offices', requireRole('admin', 'manager'), ah((req, res) => {
  const o = parse(officeSchema, req.body);
  const info = db
    .prepare('INSERT INTO offices (name, address, lat, lng, radius_m, active) VALUES (?,?,?,?,?,?)')
    .run(o.name, o.address || null, o.lat, o.lng, o.radius_m, o.active ? 1 : 0);
  res.status(201).json({ ok: true, office: db.prepare('SELECT * FROM offices WHERE id = ?').get(info.lastInsertRowid) });
}));

router.put('/offices/:id', requireRole('admin', 'manager'), ah((req, res) => {
  const o = parse(officeSchema, req.body);
  const existing = db.prepare('SELECT * FROM offices WHERE id = ?').get(req.params.id);
  if (!existing) throw httpError(404, 'Titik kantor tidak ditemukan');

  db.prepare('UPDATE offices SET name=?, address=?, lat=?, lng=?, radius_m=?, active=? WHERE id=?')
    .run(o.name, o.address || null, o.lat, o.lng, o.radius_m, o.active ? 1 : 0, existing.id);

  res.json({ ok: true, office: db.prepare('SELECT * FROM offices WHERE id = ?').get(existing.id) });
}));

router.delete('/offices/:id', requireRole('admin'), ah((req, res) => {
  db.prepare('DELETE FROM offices WHERE id = ?').run(req.params.id);
  res.json({ ok: true, message: 'Titik kantor dihapus' });
}));

// ==================================================================
// PENGATURAN APLIKASI
// ==================================================================
const EDITABLE_SETTINGS = [
  'company_name', 'work_start', 'work_end', 'late_tolerance_minutes',
  'max_gps_accuracy_m', 'currency', 'timezone',
];

router.get('/settings', ah((req, res) => {
  const settings = {};
  for (const key of EDITABLE_SETTINGS) settings[key] = getSetting(key, '');
  res.json({ settings });
}));

router.put('/settings', requireRole('admin'), ah((req, res) => {
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
