'use strict';
const jwt = require('jsonwebtoken');
const { db } = require('../db');
const { statusSandi } = require('../utils/sandi');
const { PETA_PERAN_LAMA } = require('../utils/izin');

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

/**
 * Alamat yang tetap boleh dibuka walau kata sandinya wajib diganti.
 *
 * Hanya yang benar-benar diperlukan untuk mengganti kata sandi dan menampilkan
 * halaman akun. Kalau daftar ini kelewat longgar, kewajibannya berhenti jadi
 * kewajiban.
 */
function jalurBebasSandi(req) {
  const jalur = (req.baseUrl || '') + (req.path || '');
  return (
    jalur.startsWith('/api/auth/akun') ||
    jalur.startsWith('/api/auth/me') ||
    jalur.startsWith('/api/auth/change-password') ||
    jalur.startsWith('/api/auth/ganti-sandi')
  );
}

/** Memvalidasi Bearer token dan memuat user aktif ke req.user. */
function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Token tidak ditemukan' });

  // Kesalahan konfigurasi server tidak boleh menyamar sebagai sesi kedaluwarsa —
  // teruskan ke penanganan error agar tercatat sebagai 500 di log.
  const secret = jwtSecret();

  try {
    const payload = jwt.verify(token, secret);
    const user = db
      .prepare(
        `SELECT u.id, u.name, u.email, u.role, u.position, u.active, u.role_id,
                u.photo, u.password_changed_at, u.must_change_password,
                r.slug AS role_slug, r.name AS role_name
           FROM users u LEFT JOIN roles r ON r.id = u.role_id
          WHERE u.id = ?`
      )
      .get(payload.sub);
    if (!user || !user.active) {
      return res.status(401).json({ error: 'Akun tidak aktif atau tidak ditemukan' });
    }

    // Kewajiban mengganti kata sandi ditegakkan di sini — satu-satunya pintu
    // yang dilewati SETIAP permintaan yang sudah masuk. Menegakkannya di layar
    // saja berarti "wajib" hanya berlaku bagi yang memakai layar; siapa pun
    // yang memanggil API langsung tetap bisa bekerja dengan kata sandi
    // sementara yang belum pernah diganti.
    const sandi = statusSandi(user);
    if (sandi.wajib && !jalurBebasSandi(req)) {
      return res.status(403).json({
        error: sandi.pesan,
        // Ditandai supaya layar bisa mengarahkan ke penggantian kata sandi,
        // bukan menampilkannya sebagai penolakan hak akses biasa.
        harusGantiSandi: true,
        alasan: sandi.alasan,
      });
    }

    req.user = user;
    // Izin dibaca tiap permintaan, bukan disimpan di dalam token: peran yang
    // dicabut harus langsung berlaku, bukan menunggu token kedaluwarsa.
    req.izin = izinPengguna(user);
    next();
  } catch {
    return res.status(401).json({ error: 'Sesi tidak valid atau sudah berakhir' });
  }
}

/**
 * Kumpulan izin yang dipegang seorang pengguna.
 *
 * Diambil dari peran yang tertaut. Bila akunnya belum punya peran baru — misal
 * dibuat sebelum sistem peran ada — nilainya jatuh ke pemetaan dari kolom role
 * lama, sehingga tidak ada akun yang mendadak kehilangan akses.
 */
function izinPengguna(user) {
  if (user.role_id) {
    const baris = db
      .prepare(
        `SELECT rp.permission FROM role_permissions rp
           JOIN roles r ON r.id = rp.role_id
          WHERE rp.role_id = ? AND r.active = 1`
      )
      .all(user.role_id);
    if (baris.length) return new Set(baris.map((b) => b.permission));
  }

  const slug = PETA_PERAN_LAMA[user.role] || 'cs_marketplace';
  const baris = db
    .prepare(
      `SELECT rp.permission FROM role_permissions rp
         JOIN roles r ON r.id = rp.role_id
        WHERE r.slug = ? AND r.active = 1`
    )
    .all(slug);
  return new Set(baris.map((b) => b.permission));
}

/**
 * Menuntut satu izin tertentu.
 *
 * Menolak dengan menyebut izin yang kurang, bukan sekadar "tidak berwenang" —
 * yang mengatur peran perlu tahu tombol mana yang harus dinyalakan, dan pesan
 * yang samar hanya memindahkan pekerjaan menebak ke orang lain.
 */
function butuhIzin(...izin) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Belum login' });
    if (izin.some((k) => req.izin.has(k))) return next();
    return res.status(403).json({
      error: `Peran "${req.user.role_name || req.user.role}" tidak memiliki hak akses: ${izin.join(' atau ')}`,
    });
  };
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

module.exports = { signToken, requireAuth, requireRole, butuhIzin, izinPengguna };
