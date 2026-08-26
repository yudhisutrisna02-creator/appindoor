'use strict';
require('dotenv').config();

const path = require('path');
const fs = require('fs');
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const compression = require('compression');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');

const { bootstrap } = require('./src/db/seed');
const { UPLOAD_DIR } = require('./src/utils/upload');
const { requireAuth } = require('./src/middleware/auth');

const app = express();
const PORT = process.env.PORT || 3000;
const isProd = process.env.NODE_ENV === 'production';

// ------------------------------------------------------------------
// Validasi konfigurasi sebelum server menerima permintaan.
//
// Tanpa ini, JWT_SECRET yang lupa diisi di panel hosting baru ketahuan saat
// pengguna gagal login dengan pesan yang menyesatkan. Lebih baik server
// menolak menyala disertai instruksi yang jelas.
// ------------------------------------------------------------------
function verifyConfig() {
  const problems = [];
  const secret = process.env.JWT_SECRET || '';

  if (!secret) {
    problems.push('JWT_SECRET belum diisi.');
  } else if (secret.length < 32) {
    problems.push(`JWT_SECRET terlalu pendek (${secret.length} karakter, minimal 32).`);
  } else if (secret.includes('ganti-dengan')) {
    problems.push('JWT_SECRET masih memakai nilai contoh dari .env.example.');
  }

  if (isProd) {
    const password = process.env.SEED_ADMIN_PASSWORD || '';
    if (password && (password.length < 10 || password.startsWith('GANTI'))) {
      problems.push('SEED_ADMIN_PASSWORD terlalu lemah atau masih berupa placeholder.');
    }
  }

  if (problems.length === 0) return;

  console.error('\n╔══════════════════════════════════════════════════════════');
  console.error('║ KONFIGURASI BELUM LENGKAP — server tidak dijalankan');
  console.error('╠══════════════════════════════════════════════════════════');
  problems.forEach((p) => console.error('║  • ' + p));
  console.error('╠══════════════════════════════════════════════════════════');
  console.error('║ Perbaiki lewat Environment Variables di panel hosting');
  console.error('║ (atau berkas .env bila menjalankan secara lokal).');
  console.error('║');
  console.error('║ Membuat JWT_SECRET yang aman:');
  console.error('║   node -e "console.log(require(\'crypto\').randomBytes(48).toString(\'hex\'))"');
  console.error('╚══════════════════════════════════════════════════════════\n');
  process.exit(1);
}

verifyConfig();

// Hostinger menjalankan aplikasi di belakang reverse proxy (Apache/LiteSpeed),
// sehingga IP asli klien berasal dari header X-Forwarded-For.
app.set('trust proxy', 1);

// ------------------------------------------------------------------
// Keamanan & middleware dasar
// ------------------------------------------------------------------
app.use(
  helmet({
    // CSP dimatikan agar bundel Vite + data URL kamera tidak diblokir.
    contentSecurityPolicy: false,
    crossOriginResourcePolicy: { policy: 'cross-origin' },
  })
);
app.use(compression());
app.use(morgan(isProd ? 'combined' : 'dev'));

const corsOrigin = (process.env.CORS_ORIGIN || '').split(',').map((s) => s.trim()).filter(Boolean);
app.use(cors(corsOrigin.length ? { origin: corsOrigin, credentials: true } : {}));

// Payload dibuat longgar karena foto selfie dikirim sebagai data URL base64.
app.use(express.json({ limit: '8mb' }));
app.use(express.urlencoded({ extended: true, limit: '2mb' }));

// Pembatas laju khusus endpoint login untuk meredam brute force.
app.use(
  '/api/auth/login',
  rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 20,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Terlalu banyak percobaan login. Coba lagi dalam 15 menit.' },
  })
);

// ------------------------------------------------------------------
// Inisialisasi database (migrasi + seed idempoten)
// ------------------------------------------------------------------
const createdAdmin = bootstrap();
if (createdAdmin) {
  console.log('┌─────────────────────────────────────────────');
  console.log('│ Akun admin awal dibuat:');
  console.log('│   Email    :', createdAdmin.email);
  console.log('│   Password :', createdAdmin.password);
  console.log('│ Segera ganti password setelah login pertama.');
  console.log('└─────────────────────────────────────────────');
}

// ------------------------------------------------------------------
// REST API
// ------------------------------------------------------------------
app.get('/api/health', (req, res) =>
  res.json({
    ok: true,
    service: 'erp-kebumen',
    version: require('./package.json').version,
    env: process.env.NODE_ENV || 'development',
    time: new Date().toISOString(),
  })
);

app.use('/api/auth', require('./src/routes/auth'));
app.use('/api/dashboard', require('./src/routes/dashboard'));
app.use('/api/attendance', require('./src/routes/attendance'));
app.use('/api/finance', require('./src/routes/finance'));
app.use('/api/inventory', require('./src/routes/inventory'));
app.use('/api/sales', require('./src/routes/sales'));
app.use('/api/shops', require('./src/routes/shops'));
app.use('/api/partners', require('./src/routes/partners').router);
app.use('/api/cashflow', require('./src/routes/cashflow'));
app.use('/api/admin', require('./src/routes/admin'));

// Foto selfie presensi hanya boleh diakses pengguna yang sudah login.
app.use('/api/uploads', requireAuth, express.static(UPLOAD_DIR, { maxAge: '7d' }));

app.use('/api', (req, res) => res.status(404).json({ error: `Endpoint ${req.method} ${req.originalUrl} tidak ditemukan` }));

// ------------------------------------------------------------------
// Frontend (hasil build Vite)
// ------------------------------------------------------------------
const CLIENT_DIST = path.join(__dirname, 'client', 'dist');
const hasBuild = fs.existsSync(path.join(CLIENT_DIST, 'index.html'));

if (hasBuild) {
  // Aset ber-hash aman di-cache lama; index.html harus selalu segar.
  app.use(express.static(CLIENT_DIST, { index: false, maxAge: '30d' }));
  app.get('*', (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.sendFile(path.join(CLIENT_DIST, 'index.html'));
  });
} else {
  app.get('*', (req, res) =>
    res
      .status(503)
      .type('html')
      .send(
        '<h1>Frontend belum di-build</h1>' +
          '<p>Jalankan <code>npm run build</code> terlebih dahulu, lalu muat ulang halaman ini.</p>' +
          '<p>API tetap aktif di <code>/api/health</code>.</p>'
      )
  );
}

// ------------------------------------------------------------------
// Penanganan error terpusat
// ------------------------------------------------------------------
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  const status = err.status || 500;
  if (status >= 500) console.error('[ERROR]', err);

  res.status(status).json({
    error: status >= 500 && isProd ? 'Terjadi kesalahan pada server' : err.message,
    ...(isProd ? {} : { stack: status >= 500 ? err.stack : undefined }),
  });
});

const server = app.listen(PORT, () => {
  console.log(`ERP Kebumen berjalan di port ${PORT} (${process.env.NODE_ENV || 'development'})`);
  console.log(`Frontend: ${hasBuild ? 'tersedia' : 'BELUM di-build — jalankan npm run build'}`);
});

// Hostinger mengirim SIGTERM saat restart/redeploy.
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    console.log(`${signal} diterima — menutup server dengan rapi...`);
    server.close(() => process.exit(0));
  });
}

module.exports = app;
