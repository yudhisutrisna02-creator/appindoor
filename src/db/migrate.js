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
 * Melepas batasan CHECK pada kolom channel.
 *
 * Daftar kanal jualan bertambah seiring waktu — Lazada muncul setelah tabel
 * dibuat, dan besok bisa muncul yang lain. Menuliskannya sebagai CHECK di dalam
 * tabel berarti setiap kanal baru menuntut pembongkaran tabel berisi data,
 * jadi daftar itu dipindahkan ke lapisan validasi (Zod) yang memang boleh
 * berubah. Isi kolomnya tetap divalidasi, hanya tempat validasinya yang pindah.
 *
 * SQLite tidak bisa mengubah CHECK lewat ALTER TABLE, jadi tabelnya disusun
 * ulang mengikuti prosedur resmi: matikan foreign key, salin ke tabel baru,
 * bandingkan jumlah baris, baru buang tabel lama. Seluruhnya dalam satu
 * transaksi sehingga kegagalan di tengah jalan tidak meninggalkan tabel
 * separuh jadi.
 */
function lepasCekKanal(db, tabel, applied) {
  if (!tableExists(db, tabel)) return;

  const asli = db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(tabel);
  if (!asli || !asli.sql) return;
  if (!/CHECK\s*\(\s*channel\s+IN/i.test(asli.sql)) return; // sudah pernah dilepas

  const ddlBaru = asli.sql.replace(/\s*CHECK\s*\(\s*channel\s+IN\s*\([^)]*\)\s*\)/i, '');
  if (/CHECK\s*\(\s*channel\s+IN/i.test(ddlBaru)) {
    throw new Error(`Gagal melepas CHECK channel pada ${tabel}: pola tidak dikenali`);
  }

  const kolom = columnsOf(db, tabel).map((c) => `"${c}"`).join(', ');
  const indeks = db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND tbl_name = ? AND sql IS NOT NULL")
    .all(tabel)
    .map((r) => r.sql);

  const sebelum = db.prepare(`SELECT COUNT(*) AS c FROM ${tabel}`).get().c;

  // Rename bawaan SQLite ikut menulis ulang klausa REFERENCES di tabel lain;
  // mode lawas mematikan perilaku itu supaya tabel anak tetap menunjuk nama asli.
  const fkSemula = db.pragma('foreign_keys', { simple: true });
  db.pragma('foreign_keys = OFF');
  db.pragma('legacy_alter_table = ON');

  try {
    db.transaction(() => {
      db.exec(`ALTER TABLE ${tabel} RENAME TO ${tabel}_lama_migrasi`);
      db.exec(ddlBaru);
      db.exec(`INSERT INTO ${tabel} (${kolom}) SELECT ${kolom} FROM ${tabel}_lama_migrasi`);

      const sesudah = db.prepare(`SELECT COUNT(*) AS c FROM ${tabel}`).get().c;
      if (sesudah !== sebelum) {
        throw new Error(`Penyalinan ${tabel} tidak utuh: ${sebelum} baris menjadi ${sesudah}`);
      }

      db.exec(`DROP TABLE ${tabel}_lama_migrasi`);
      for (const sql of indeks) db.exec(sql);
    })();
  } finally {
    db.pragma('legacy_alter_table = OFF');
    db.pragma(`foreign_keys = ${fkSemula ? 'ON' : 'OFF'}`);
  }

  const rusak = db.pragma('foreign_key_check');
  if (rusak.length) {
    throw new Error(`Relasi rusak setelah menyusun ulang ${tabel}: ${JSON.stringify(rusak.slice(0, 3))}`);
  }

  applied.push(`${tabel}.channel (CHECK dilepas, ${sebelum} baris disalin)`);
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

  // --- Pemasok utama tiap produk ---
  // Dipakai menjawab "barang ini biasanya dibeli dari siapa", terpisah dari
  // partner_id pada stock_moves yang mencatat pembelian per transaksi.
  addColumn(db, 'products', 'supplier_id', 'INTEGER REFERENCES partners(id)', applied);

  // --- Kolom pendukung penjualan marketplace ---
  // Diambil dari sheet "3. Penjualan": tiap order marketplace membawa
  // identitas pesanan, ekspedisi, status pencairan, dan data pembeli yang
  // tidak muat pada struktur order sederhana.
  addColumn(db, 'sales_orders', 'shop_id', 'INTEGER REFERENCES shops(id)', applied);
  addColumn(db, 'sales_orders', 'order_ref', 'TEXT', applied);          // NO PESANAN
  addColumn(db, 'sales_orders', 'courier', 'TEXT', applied);            // EKSPEDISI
  addColumn(db, 'sales_orders', 'tracking_no', 'TEXT', applied);        // RESI / KODE BOOKING
  addColumn(db, 'sales_orders', 'fulfillment_status', "TEXT NOT NULL DEFAULT 'DIPROSES'", applied);
  addColumn(db, 'sales_orders', 'payout_date', 'TEXT', applied);        // TGL CAIR
  addColumn(db, 'sales_orders', 'shipping_charged', 'REAL NOT NULL DEFAULT 0', applied);  // ONGKIR ditagih ke pembeli
  addColumn(db, 'sales_orders', 'buyer_name', 'TEXT', applied);
  addColumn(db, 'sales_orders', 'buyer_account', 'TEXT', applied);
  addColumn(db, 'sales_orders', 'buyer_phone', 'TEXT', applied);
  addColumn(db, 'sales_orders', 'buyer_address', 'TEXT', applied);
  addColumn(db, 'sales_orders', 'buyer_city', 'TEXT', applied);         // ASAL KOTA
  addColumn(db, 'sales_orders', 'lead_source', 'TEXT', applied);        // ASAL LEADS

  // --- Jatuh tempo ---
  addColumn(db, 'sales_orders', 'due_date', 'TEXT', applied);
  addColumn(db, 'stock_moves', 'due_date', 'TEXT', applied);

  // --- Data tim yang lebih lengkap ---
  // Kolom kepegawaian yang selama ini hanya ada di kepala pemilik usaha:
  // nomor induk, penempatan, status kerja, dan kontak darurat. Semuanya boleh
  // kosong karena karyawan yang sudah terdaftar tidak boleh mendadak dianggap
  // tidak sah hanya karena ada kolom baru.
  addColumn(db, 'users', 'photo', 'TEXT', applied);             // nama berkas di folder unggahan
  addColumn(db, 'users', 'nik', 'TEXT', applied);               // nomor induk karyawan
  addColumn(db, 'users', 'department', 'TEXT', applied);        // divisi / bagian
  addColumn(db, 'users', 'employment_status', 'TEXT', applied); // tetap, kontrak, magang
  addColumn(db, 'users', 'join_date', 'TEXT', applied);
  addColumn(db, 'users', 'birth_date', 'TEXT', applied);
  addColumn(db, 'users', 'gender', 'TEXT', applied);
  addColumn(db, 'users', 'address', 'TEXT', applied);
  addColumn(db, 'users', 'emergency_name', 'TEXT', applied);
  addColumn(db, 'users', 'emergency_phone', 'TEXT', applied);
  addColumn(db, 'users', 'bank_name', 'TEXT', applied);
  addColumn(db, 'users', 'bank_account', 'TEXT', applied);
  addColumn(db, 'users', 'note', 'TEXT', applied);

  // --- Peran & hak akses ---
  // Kolom lama users.role dibiarkan utuh. Ia tetap dipakai sebagai cadangan
  // selama role_id belum diisi, sehingga akun yang sudah ada tidak kehilangan
  // akses hanya karena sistem perannya berganti.
  addColumn(db, 'users', 'role_id', 'INTEGER REFERENCES roles(id)', applied);

  // --- Daftar kanal jualan tidak lagi dikunci di dalam tabel ---
  lepasCekKanal(db, 'sales_orders', applied);
  lepasCekKanal(db, 'shops', applied);

  // Indeks menyusul kolomnya
  db.exec('CREATE INDEX IF NOT EXISTS idx_ads_date ON ad_spends(spend_date)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_users_role ON users(role_id)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_po_status ON purchase_orders(status)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_po_partner ON purchase_orders(partner_id)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_poi_po ON purchase_items(po_id)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_ads_shop ON ad_spends(shop_id)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_jl_partner ON journal_lines(partner_id)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_so_partner ON sales_orders(partner_id)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_mv_partner ON stock_moves(partner_id)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_prod_supplier ON products(supplier_id)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_so_shop ON sales_orders(shop_id)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_so_fulfillment ON sales_orders(fulfillment_status)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_so_payout ON sales_orders(payout_date)');

  return applied;
}

module.exports = { runMigrations, columnsOf, tableExists };
