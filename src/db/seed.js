'use strict';
require('dotenv').config();
const bcrypt = require('bcryptjs');
const { db, migrate } = require('./index');
const { COA } = require('./coa');

/** Menanam COA standar. Akun yang sudah ada tidak ditimpa. */
function seedAccounts() {
  const insert = db.prepare(
    `INSERT INTO accounts (code, name, type, subtype, normal, cashflow, is_cash, is_system)
     VALUES (?, ?, ?, ?, ?, ?, ?, 1)
     ON CONFLICT(code) DO NOTHING`
  );
  const run = db.transaction((rows) => {
    for (const r of rows) insert.run(...r);
  });
  run(COA);
}

/** Membuat akun admin pertama bila belum ada pengguna sama sekali. */
function seedAdmin() {
  const { c } = db.prepare('SELECT COUNT(*) AS c FROM users').get();
  if (c > 0) return null;

  const name = process.env.SEED_ADMIN_NAME || 'Administrator';
  const email = (process.env.SEED_ADMIN_EMAIL || 'admin@kebumen.local').toLowerCase();
  const password = process.env.SEED_ADMIN_PASSWORD || 'Admin#12345';

  db.prepare(
    // Kata sandi admin pertama ditetapkan pemiliknya sendiri lewat
    // SEED_ADMIN_PASSWORD, bukan oleh orang lain — jadi tidak diwajibkan ganti
    // seketika. Masa berlakunya tetap berjalan seperti akun lain, dan
    // dihitung sejak sekarang.
    `INSERT INTO users (name, email, password_hash, role, position, password_changed_at)
     VALUES (?, ?, ?, 'admin', 'Owner', datetime('now'))`
  ).run(name, email, bcrypt.hashSync(password, 10));

  return { email, password };
}

/** Titik kantor default untuk geofencing (alun-alun Kebumen sebagai placeholder). */
function seedOffice() {
  const { c } = db.prepare('SELECT COUNT(*) AS c FROM offices').get();
  if (c > 0) return;
  db.prepare(
    `INSERT INTO offices (name, address, lat, lng, radius_m)
     VALUES (?, ?, ?, ?, ?)`
  ).run(
    'Kantor Pusat',
    'Kebumen, Jawa Tengah — ubah koordinat di menu Pengaturan',
    -7.669_5,
    109.652_2,
    Number(process.env.GEOFENCE_RADIUS_M || 150)
  );
}

function seedSettings() {
  const defaults = {
    company_name: 'Digital Marketing Kebumen',
    work_start: process.env.WORK_START || '08:00',
    work_end: '17:00',
    late_tolerance_minutes: process.env.LATE_TOLERANCE_MINUTES || '10',
    max_gps_accuracy_m: process.env.MAX_GPS_ACCURACY_M || '100',
    currency: 'IDR',
  };
  const stmt = db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING'
  );
  const run = db.transaction(() => {
    for (const [k, v] of Object.entries(defaults)) stmt.run(k, String(v));
  });
  run();
}

/** Dipanggil saat boot server — aman dijalankan berulang kali. */
function bootstrap() {
  migrate();
  seedAccounts();
  seedSettings();
  seedOffice();
  return seedAdmin();
}

module.exports = { bootstrap };

// Dijalankan langsung: `npm run seed`
if (require.main === module) {
  const created = bootstrap();
  if (created) {
    console.log('Akun admin dibuat:');
    console.log('  Email    :', created.email);
    console.log('  Password :', created.password);
  } else {
    console.log('Database sudah terisi — tidak ada akun baru yang dibuat.');
  }
  console.log('Seed selesai.');
}
