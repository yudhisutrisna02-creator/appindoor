'use strict';
const jwt = require('jsonwebtoken');
const { db } = require('../db');

function jwtSecret() {
  const secret = process.env.JWT_SECRET;
  if (!secret || secret.length < 16) {
    throw new Error('JWT_SECRET belum diset atau terlalu pendek (minimal 16 karakter)');
  }
  return secret;
}

function signToken(user) {
  return jwt.sign(
    { sub: user.id, role: user.role, name: user.name },
    jwtSecret(),
    { expiresIn: process.env.JWT_EXPIRES_IN || '12h' }
  );
}

/** Memvalidasi Bearer token dan memuat user aktif ke req.user. */
function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Token tidak ditemukan' });

  try {
    const payload = jwt.verify(token, jwtSecret());
    const user = db
      .prepare('SELECT id, name, email, role, position, active FROM users WHERE id = ?')
      .get(payload.sub);
    if (!user || !user.active) {
      return res.status(401).json({ error: 'Akun tidak aktif atau tidak ditemukan' });
    }
    req.user = user;
    next();
  } catch {
    return res.status(401).json({ error: 'Sesi tidak valid atau sudah berakhir' });
  }
}

/** Membatasi akses berdasarkan peran, mis. requireRole('admin','manager'). */
function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Belum login' });
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'Peran Anda tidak berwenang untuk aksi ini' });
    }
    next();
  };
}

module.exports = { signToken, requireAuth, requireRole };
