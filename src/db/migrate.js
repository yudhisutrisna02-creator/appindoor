'use strict';
/**
 * Migrasi bertahap untuk database yang SUDAH berisi data.
 *
 * schema.sql memakai CREATE TABLE IF NOT EXISTS, sehingga tabel baru otomatis
 * terbuat tetapi kolom baru pada tabel lama TIDAK. Berkas ini menutup celah itu.
 *
 * Aturan yang dipegang:
 *  - Idempoten: aman dijalankan pada setiap boot.
 *  - Hanya menambah, tidak pernah menghapus atau mengubah kolom yang sudah ada.
 *  - Kolom baru selalu boleh NULL atau punya nilai bawaan, supaya baris lama
 *    tetap valid tanpa perlu diisi ulang.
 */

/** Daftar nama kolom pada sebuah tabel. */
function columnsOf(db, table) {
  return db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
}

function tableExists(db, table) {
  return !!db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(table);
}

/**
 * Menambah kolom bila belum ada.
 * @param {string} definition potongan SQL setelah nama kolom, mis. "TEXT" atau
 *        "INTEGER NOT NULL DEFAULT 0". SQLite melarang DEFAULT non-konstan dan
 *        penambahan kolom UNIQUE lewat ALTER TABLE.
 */
function addColumn(db, table, column, definition, applied) {
  if (!tableExists(db, table)) return;
  if (columnsOf(db, table).includes(column)) return;

  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  applied.push(`${table}.${column}`);
}

/**
 * Menjalankan seluruh migrasi. Dipanggil sekali saat boot, setelah schema.sql.
 * @returns {string[]} daftar perubahan yang benar-benar diterapkan
 */
function runMigrations(db) {
  const applied = [];

  // --- Mitra usaha (supplier & pelanggan) ---
  // Relasi ditaruh sebagai kolom baru agar data lama tetap utuh; nilainya NULL
  // untuk transaksi yang tercatat sebelum fitur ini ada.
  addColumn(db, 'stock_moves', 'partner_id', 'INTEGER REFERENCES partners(id)', applied);
  addColumn(db, 'sales_orders', 'partner_id', 'INTEGER REFERENCES partners(id)', applied);
  addColumn(db, 'sales_returns', 'partner_id', 'INTEGER REFERENCES partners(id)', applied);

  // --- Dimensi mitra pada buku besar ---
  // Dipakai menghitung saldo utang/piutang per mitra langsung dari jurnal,
  // sehingga tidak ada sumber kebenaran kedua yang bisa berbeda.
  addColumn(db, 'journal_lines', 'partner_id', 'INTEGER REFERENCES partners(id)', applied);

  // --- Jatuh tempo ---
  addColumn(db, 'sales_orders', 'due_date', 'TEXT', applied);
  addColumn(db, 'stock_moves', 'due_date', 'TEXT', applied);

  // Indeks menyusul kolomnya
  db.exec('CREATE INDEX IF NOT EXISTS idx_jl_partner ON journal_lines(partner_id)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_so_partner ON sales_orders(partner_id)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_mv_partner ON stock_moves(partner_id)');

  return applied;
}

module.exports = { runMigrations, columnsOf, tableExists };
