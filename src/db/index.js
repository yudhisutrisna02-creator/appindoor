'use strict';
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { runMigrations } = require('./migrate');
const { seedPeran } = require('./seed-peran');

/**
 * Menerjemahkan DATABASE_URL menjadi path file SQLite.
 * Menerima: file:./data/erp.db  |  ./data/erp.db  |  /abs/path/erp.db
 */
function resolveDbFile() {
  const url = process.env.DATABASE_URL || 'file:./data/erp.db';
  if (/^(postgres|postgresql|mysql):\/\//i.test(url)) {
    throw new Error(
      'DATABASE_URL menunjuk ke PostgreSQL/MySQL, sedangkan build ini memakai SQLite. ' +
        'Lihat README bagian "Migrasi ke PostgreSQL/MySQL".'
    );
  }
  const raw = url.replace(/^file:/, '');
  return path.isAbsolute(raw) ? raw : path.resolve(process.cwd(), raw);
}

const dbFile = resolveDbFile();
fs.mkdirSync(path.dirname(dbFile), { recursive: true });

const db = new Database(dbFile);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

/**
 * Menyiapkan struktur database.
 * 1. schema.sql membuat tabel yang belum ada.
 * 2. runMigrations menambahkan kolom baru pada tabel yang sudah terlanjur ada,
 *    karena CREATE TABLE IF NOT EXISTS tidak menyentuh tabel lama.
 */
function migrate() {
  const sql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  db.exec(sql);

  const applied = runMigrations(db);
  // Peran disemai setelah migrasi karena ia butuh kolom users.role_id.
  applied.push(...seedPeran(db));
  if (applied.length > 0) {
    console.log('Migrasi database diterapkan:', applied.join(', '));
  }
  return applied;
}

/**
 * Nomor dokumen berurutan, mis. nextNumber('SO', '2026-08') -> "SO/2026-08/0007".
 * Atomik karena dijalankan dalam satu transaksi better-sqlite3.
 */
const nextNumber = db.transaction((prefix, period) => {
  const key = `${prefix}:${period}`;
  db.prepare(
    'INSERT INTO counters (key, value) VALUES (?, 0) ON CONFLICT(key) DO NOTHING'
  ).run(key);
  db.prepare('UPDATE counters SET value = value + 1 WHERE key = ?').run(key);
  const { value } = db.prepare('SELECT value FROM counters WHERE key = ?').get(key);
  return `${prefix}/${period}/${String(value).padStart(4, '0')}`;
});

function getSetting(key, fallback = null) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : fallback;
}

function setSetting(key, value) {
  db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).run(key, String(value));
}

module.exports = { db, dbFile, migrate, nextNumber, getSetting, setSetting };
