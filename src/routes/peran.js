'use strict';
/**
 * Peran & hak akses.
 *
 * Satu peran adalah sekumpulan izin. Yang disimpan hanya nama peran dan daftar
 * izinnya; katalog izinnya sendiri hidup di kode (src/utils/izin.js) supaya
 * tidak ada izin yang tercatat di basis data tetapi tak ada penjaganya di mana
 * pun.
 */
const express = require('express');
const { z } = require('zod');
const { db } = require('../db');
const { requireAuth, butuhIzin } = require('../middleware/auth');
const { ah, parse, httpError } = require('../utils/http');
const { KATALOG, SEMUA_IZIN } = require('../utils/izin');
const { daftarkanEkspor } = require('../utils/ekspor');

const router = express.Router();
router.use(requireAuth);

const peranSchema = z.object({
  name: z.string().trim().min(1, 'nama peran wajib diisi').max(60),
  description: z.string().trim().max(300).optional().nullable(),
  active: z.boolean().default(true),
  permissions: z.array(z.string()).default([]),
});

/** Ubah nama peran menjadi slug yang aman dan tetap. */
function keSlug(nama) {
  return String(nama).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40);
}

function ambilPeran() {
  const roles = db.prepare('SELECT * FROM roles ORDER BY is_system DESC, name').all();
  const izin = db.prepare('SELECT role_id, permission FROM role_permissions').all();
  const jumlahUser = db
    .prepare('SELECT role_id, COUNT(*) AS n FROM users WHERE role_id IS NOT NULL GROUP BY role_id')
    .all();
  const petaUser = new Map(jumlahUser.map((j) => [j.role_id, j.n]));

  return roles.map((r) => ({
    ...r,
    permissions: izin.filter((i) => i.role_id === r.id).map((i) => i.permission),
    jumlahPengguna: petaUser.get(r.id) || 0,
  }));
}

/** GET /api/peran — daftar peran + katalog izin untuk menyusun formulirnya. */
router.get('/', butuhIzin('sistem.peran', 'sistem.tim'), ah((req, res) => {
  res.json({ roles: ambilPeran(), katalog: KATALOG });
}));

/** GET /api/peran/saya — izin milik pengguna yang sedang masuk. */
router.get('/saya', ah((req, res) => {
  res.json({
    role: req.user.role_name || req.user.role,
    slug: req.user.role_slug || req.user.role,
    permissions: [...req.izin],
  });
}));

const simpanIzin = db.transaction((roleId, daftar) => {
  db.prepare('DELETE FROM role_permissions WHERE role_id = ?').run(roleId);
  const pasang = db.prepare('INSERT INTO role_permissions (role_id, permission) VALUES (?,?)');
  for (const izin of daftar) {
    if (SEMUA_IZIN.includes(izin)) pasang.run(roleId, izin);
  }
});

router.post('/', butuhIzin('sistem.peran'), ah((req, res) => {
  const b = parse(peranSchema, req.body);
  const slug = keSlug(b.name);
  if (!slug) throw httpError(400, 'Nama peran tidak menghasilkan kode yang sah');
  if (db.prepare('SELECT id FROM roles WHERE slug = ?').get(slug)) {
    throw httpError(409, `Peran "${b.name}" sudah ada`);
  }

  const info = db
    .prepare('INSERT INTO roles (slug, name, description, is_system, active) VALUES (?,?,?,0,?)')
    .run(slug, b.name, b.description || null, b.active ? 1 : 0);
  simpanIzin(info.lastInsertRowid, b.permissions);

  res.status(201).json({ ok: true, message: `Peran ${b.name} dibuat`, role: ambilPeran().find((r) => r.id === info.lastInsertRowid) });
}));

router.put('/:id(\\d+)', butuhIzin('sistem.peran'), ah((req, res) => {
  const b = parse(peranSchema, req.body);
  const lama = db.prepare('SELECT * FROM roles WHERE id = ?').get(req.params.id);
  if (!lama) throw httpError(404, 'Peran tidak ditemukan');

  // Peran Admin adalah jalan keluar terakhir bila peran lain salah disusun.
  // Mengurangi izinnya bisa mengunci pemiliknya sendiri keluar dari menu peran,
  // dan setelah itu tidak ada lagi yang bisa memperbaikinya dari dalam aplikasi.
  if (lama.slug === 'admin') {
    throw httpError(422, 'Peran Admin selalu memegang akses penuh dan tidak dapat dibatasi');
  }

  db.prepare('UPDATE roles SET name = ?, description = ?, active = ? WHERE id = ?')
    .run(b.name, b.description || null, b.active ? 1 : 0, lama.id);
  simpanIzin(lama.id, b.permissions);

  res.json({ ok: true, message: `Peran ${b.name} diperbarui`, role: ambilPeran().find((r) => r.id === lama.id) });
}));

router.delete('/:id(\\d+)', butuhIzin('sistem.peran'), ah((req, res) => {
  const peran = db.prepare('SELECT * FROM roles WHERE id = ?').get(req.params.id);
  if (!peran) throw httpError(404, 'Peran tidak ditemukan');
  if (peran.is_system) throw httpError(422, 'Peran bawaan tidak dapat dihapus — nonaktifkan saja bila tidak dipakai');

  const dipakai = db.prepare('SELECT COUNT(*) AS n FROM users WHERE role_id = ?').get(peran.id).n;
  if (dipakai > 0) {
    throw httpError(422, `Peran ini masih dipakai ${dipakai} akun — pindahkan dulu akunnya ke peran lain`);
  }

  db.prepare('DELETE FROM roles WHERE id = ?').run(peran.id);
  res.json({ ok: true, message: `Peran ${peran.name} dihapus` });
}));

daftarkanEkspor(router, {
  path: '/',
  judul: 'Peran & Hak Akses',
  kolom: [
    { header: 'Peran', key: 'name', width: 28 },
    { header: 'Keterangan', key: 'description', width: 52 },
    { header: 'Jumlah Izin', key: 'jumlahIzin', width: 12 },
    { header: 'Jumlah Pengguna', key: 'jumlahPengguna', width: 16 },
    { header: 'Status', key: 'status', width: 12 },
    { header: 'Daftar Izin', key: 'daftarIzin', width: 80 },
  ],
  ambil: () => {
    const roles = ambilPeran();
    return {
      rows: roles.map((r) => ({
        ...r,
        jumlahIzin: r.permissions.length,
        status: r.active ? 'Aktif' : 'Nonaktif',
        daftarIzin: r.permissions.join(', '),
      })),
      subtitle: 'Daftar peran beserta hak akses yang dipegangnya',
      meta: [['Jumlah peran', roles.length], ['Total izin tersedia', SEMUA_IZIN.length]],
    };
  },
});

module.exports = router;
