'use strict';
const express = require('express');
const bcrypt = require('bcryptjs');
const { z } = require('zod');
const { db } = require('../db');
const { signToken, requireAuth } = require('../middleware/auth');
const { ah, parse, httpError } = require('../utils/http');
const { saveDataUrlImage, hapusBerkas } = require('../utils/upload');
const {
  MASA_BERLAKU_HARI, SYARAT_TEKS, periksaSandi, pesanSandi, statusSandi,
} = require('../utils/sandi');

const router = express.Router();

const loginSchema = z.object({
  email: z.string().email('format email tidak valid'),
  password: z.string().min(1, 'password wajib diisi'),
});

router.post('/login', ah((req, res) => {
  const { email, password } = parse(loginSchema, req.body);
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email.toLowerCase());

  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    throw httpError(401, 'Email atau password salah');
  }
  if (!user.active) throw httpError(403, 'Akun Anda dinonaktifkan');

  res.json({
    token: signToken(user),
    user: {
      id: user.id, name: user.name, email: user.email,
      role: user.role, position: user.position, photo: user.photo,
    },
    // Layar perlu tahu ini SEBELUM menampilkan menu apa pun, supaya pengguna
    // yang wajib mengganti kata sandi langsung diarahkan ke sana.
    sandi: statusSandi(user),
    syaratSandi: SYARAT_TEKS,
    masaBerlakuHari: MASA_BERLAKU_HARI,
  });
}));

router.get('/me', requireAuth, ah((req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  res.json({
    user: req.user,
    sandi: statusSandi(user),
    syaratSandi: SYARAT_TEKS,
    masaBerlakuHari: MASA_BERLAKU_HARI,
  });
}));

// ==================================================================
// AKUN SAYA
//
// Terbuka untuk semua peran tanpa izin tambahan. Data yang boleh disentuh di
// sini hanya milik pengguna itu sendiri: foto, nomor telepon, dan kata sandi.
// Nama, email, jabatan, dan peran sengaja TIDAK ikut — mengubahnya berarti
// mengubah identitas dan hak akses, dan itu urusan pengelola tim.
// ==================================================================
const KOLOM_AKUN = `
  id, name, email, role, position, department, phone, photo, nik,
  employment_status, join_date, bank_name, bank_account, active,
  password_changed_at, must_change_password
`;

router.get('/akun', requireAuth, ah((req, res) => {
  const user = db.prepare(`SELECT ${KOLOM_AKUN} FROM users WHERE id = ?`).get(req.user.id);
  if (!user) throw httpError(404, 'Akun tidak ditemukan');

  const peran = user.role_id
    ? db.prepare('SELECT name FROM roles WHERE id = ?').get(user.role_id)
    : null;

  res.json({
    user: { ...user, peran_nama: peran ? peran.name : user.role },
    sandi: statusSandi(user),
    syaratSandi: SYARAT_TEKS,
    masaBerlakuHari: MASA_BERLAKU_HARI,
  });
}));

const profilSchema = z.object({
  phone: z.string().trim().max(30).optional().nullable(),
  // Foto dikirim sebagai data URL dari kamera atau berkas yang dipilih.
  photo: z.string().optional().nullable(),
});

router.put('/akun', requireAuth, ah((req, res) => {
  const body = parse(profilSchema, req.body);
  const lama = db.prepare('SELECT photo FROM users WHERE id = ?').get(req.user.id);

  let foto = lama ? lama.photo : null;
  if (body.photo === null) {
    // Foto memang wajib ada, tetapi menghapusnya tetap diizinkan — yang
    // menuntutnya adalah pengingat di layar, bukan larangan menyimpan. Menolak
    // penghapusan hanya membuat foto yang salah unggah terkunci selamanya.
    if (foto) hapusBerkas(foto);
    foto = null;
  } else if (body.photo && body.photo.startsWith('data:')) {
    foto = saveDataUrlImage(body.photo, `akun${req.user.id}`);
    if (lama && lama.photo && lama.photo !== foto) hapusBerkas(lama.photo);
  }

  db.prepare('UPDATE users SET phone = ?, photo = ? WHERE id = ?')
    .run(body.phone || null, foto, req.user.id);

  res.json({
    ok: true,
    message: 'Profil diperbarui',
    user: db.prepare(`SELECT ${KOLOM_AKUN} FROM users WHERE id = ?`).get(req.user.id),
  });
}));

const passwordSchema = z.object({
  currentPassword: z.string().min(1, 'kata sandi saat ini wajib diisi'),
  newPassword: z.string().min(1, 'kata sandi baru wajib diisi'),
});

function gantiSandi(req, res) {
  const { currentPassword, newPassword } = parse(passwordSchema, req.body);
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);

  if (!bcrypt.compareSync(currentPassword, user.password_hash)) {
    throw httpError(400, 'Kata sandi saat ini salah');
  }

  const hasil = periksaSandi(newPassword);
  if (!hasil.ok) throw httpError(422, pesanSandi(hasil.kurang));

  // Kata sandi baru yang sama dengan yang lama membatalkan seluruh gunanya
  // penggantian berkala.
  if (bcrypt.compareSync(newPassword, user.password_hash)) {
    throw httpError(422, 'Kata sandi baru tidak boleh sama dengan yang lama');
  }

  db.prepare(
    `UPDATE users
        SET password_hash = ?, password_changed_at = datetime('now'), must_change_password = 0
      WHERE id = ?`
  ).run(bcrypt.hashSync(newPassword, 10), user.id);

  res.json({
    ok: true,
    message: `Kata sandi diperbarui. Berlaku ${MASA_BERLAKU_HARI} hari ke depan.`,
    sandi: statusSandi(db.prepare('SELECT * FROM users WHERE id = ?').get(user.id)),
  });
}

router.post('/change-password', requireAuth, ah(gantiSandi));
// Nama Indonesia untuk endpoint yang sama; yang lama tetap ada supaya
// pemanggil lama tidak mendadak gagal.
router.post('/ganti-sandi', requireAuth, ah(gantiSandi));

module.exports = router;
