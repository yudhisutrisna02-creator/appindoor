'use strict';
const express = require('express');
const bcrypt = require('bcryptjs');
const { z } = require('zod');
const { db } = require('../db');
const { signToken, requireAuth } = require('../middleware/auth');
const { ah, parse, httpError } = require('../utils/http');

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
      role: user.role, position: user.position,
    },
  });
}));

router.get('/me', requireAuth, (req, res) => res.json({ user: req.user }));

const passwordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(8, 'password baru minimal 8 karakter'),
});

router.post('/change-password', requireAuth, ah((req, res) => {
  const { currentPassword, newPassword } = parse(passwordSchema, req.body);
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);

  if (!bcrypt.compareSync(currentPassword, user.password_hash)) {
    throw httpError(400, 'Password saat ini salah');
  }
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?')
    .run(bcrypt.hashSync(newPassword, 10), user.id);

  res.json({ ok: true, message: 'Password berhasil diperbarui' });
}));

module.exports = router;
