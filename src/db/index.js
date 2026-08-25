'use strict';
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

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

/** Menjalankan schema.sql (idempoten — semua CREATE memakai IF NOT EXISTS). */
function migrate() {
  const sql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  db.exec(sql);
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
