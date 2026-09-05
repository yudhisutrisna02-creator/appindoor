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
  return true;
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
 * Menyemai katalog varian bawaan, sekali saja.
 *
 * Penandanya disimpan di tabel settings, bukan diperiksa dari kosong-tidaknya
 * tabel varian. Kalau yang diperiksa isinya, katalog yang sengaja dikosongkan
 * pemiliknya akan terisi lagi sendiri pada penyalaan berikutnya.
 */
function semaiKatalogVarian(db, applied) {
  if (!tableExists(db, 'product_variants')) return;

  const sudah = db
    .prepare("SELECT value FROM settings WHERE key = 'varian_katalog_disemai'")
    .get();
  if (sudah) return;

  const { VARIAN_BAWAAN } = require('./varian-bawaan');
  const cariProduk = db.prepare('SELECT id FROM products WHERE sku = ?');
  const tandai = db.prepare('UPDATE products SET needs_variant = 1 WHERE id = ?');
  const tambah = db.prepare(
    'INSERT INTO product_variants (product_id, nama) VALUES (?,?) ON CONFLICT DO NOTHING'
  );

  let varian = 0;
  const hilang = [];

  db.transaction(() => {
    for (const [sku, daftar] of Object.entries(VARIAN_BAWAAN)) {
      const p = cariProduk.get(sku);
      if (!p) {
        hilang.push(sku);
        continue;
      }
      tandai.run(p.id);
      for (const nama of daftar) varian += tambah.run(p.id, nama).changes;
    }
    db.prepare("INSERT INTO settings (key, value) VALUES ('varian_katalog_disemai', '1')").run();
  })();

  if (varian) applied.push(varian + ' varian produk disemai');
  if (hilang.length) applied.push('katalog varian dilewati (SKU tidak ada): ' + hilang.join(', '));
}

/**
 * Tabel batch produk beserta kartu pergerakannya.
 *
 * qty_sisa disimpan, bukan dihitung ulang dari batch_moves setiap kali dibaca —
 * mengikuti pola yang sama dengan products.stock. batch_moves-lah yang
 * menjelaskan bagaimana angka itu terbentuk, sehingga selisih di antara
 * keduanya selalu bisa ditelusuri.
 */
function buatTabelBatch(db, applied) {
  if (tableExists(db, 'product_batches')) return;

  db.exec(`
    CREATE TABLE product_batches (
      id                 INTEGER PRIMARY KEY AUTOINCREMENT,
      product_id         INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
      kode               TEXT NOT NULL,
      tanggal_produksi   TEXT,
      tanggal_kadaluarsa TEXT,
      qty_awal           REAL NOT NULL DEFAULT 0,
      qty_sisa           REAL NOT NULL DEFAULT 0,
      unit_cost          REAL NOT NULL DEFAULT 0,
      catatan            TEXT,
      created_at         TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(product_id, kode)
    );
    CREATE INDEX idx_batch_produk ON product_batches(product_id);
    CREATE INDEX idx_batch_exp    ON product_batches(tanggal_kadaluarsa);

    CREATE TABLE batch_moves (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      batch_id   INTEGER NOT NULL REFERENCES product_batches(id) ON DELETE CASCADE,
      product_id INTEGER NOT NULL,
      move_date  TEXT NOT NULL,
      qty        REAL NOT NULL,
      source     TEXT NOT NULL DEFAULT 'MANUAL',
      source_id  INTEGER,
      note       TEXT,
      user_id    INTEGER REFERENCES users(id),
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX idx_bmove_batch  ON batch_moves(batch_id);
    CREATE INDEX idx_bmove_sumber ON batch_moves(source, source_id);
  `);

  applied.push('tabel product_batches & batch_moves');
}

/**
 * Tabel rekening koran untuk rekonsiliasi bank.
 *
 * Baris rekening koran disimpan apa adanya, termasuk yang tidak cocok dengan
 * catatan mana pun. Membuang yang tidak cocok berarti membuang justru bukti
 * yang paling dibutuhkan — selisih antara bank dan catatan hanya bisa
 * dijelaskan kalau kedua sisinya masih utuh.
 */
function buatTabelRekonsiliasi(db, applied) {
  if (tableExists(db, 'bank_statements')) return;

  db.exec(`
    CREATE TABLE bank_statements (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      account_code TEXT NOT NULL,
      nama_berkas  TEXT,
      periode_dari TEXT NOT NULL,
      periode_sampai TEXT NOT NULL,
      saldo_akhir  REAL,
      catatan      TEXT,
      user_id      INTEGER REFERENCES users(id),
      created_at   TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE bank_statement_lines (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      statement_id INTEGER NOT NULL REFERENCES bank_statements(id) ON DELETE CASCADE,
      tanggal      TEXT NOT NULL,
      keterangan   TEXT,
      masuk        REAL NOT NULL DEFAULT 0,
      keluar       REAL NOT NULL DEFAULT 0,
      -- Baris jurnal yang dianggap sepadan. NULL berarti belum ketemu
      -- pasangannya, dan itu justru informasi yang dicari.
      journal_line_id INTEGER REFERENCES journal_lines(id) ON DELETE SET NULL,
      cara_cocok   TEXT,
      created_at   TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX idx_bsl_statement ON bank_statement_lines(statement_id);
    CREATE INDEX idx_bsl_jurnal    ON bank_statement_lines(journal_line_id);
  `);

  applied.push('tabel bank_statements & bank_statement_lines');
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

  // Ongkir yang ditagih ke pembeli di luar marketplace. Uang ini ikut masuk ke
  // rekening bersama nilai ordernya, jadi ia menambah penerimaan — bukan biaya,
  // meski tim menyebutnya begitu dalam percakapan sehari-hari.
  addColumn(db, 'sales_orders', 'shipping_non_mp', 'REAL NOT NULL DEFAULT 0', applied);

  // --- Batch & tanggal kadaluarsa ---
  // Produk hayati punya masa aktif: stok yang cuma satu angka tidak bisa
  // menjawab 'mana yang mau kedaluwarsa'. Pelacakannya dinyalakan per produk,
  // bukan menyeluruh, supaya produk yang memang tidak kedaluwarsa tidak
  // dibebani pencatatan batch yang tidak berguna baginya.
  addColumn(db, 'products', 'lacak_batch', 'INTEGER NOT NULL DEFAULT 0', applied);
  buatTabelBatch(db, applied);
  buatTabelRekonsiliasi(db, applied);
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

  // Rekaman izin bawaan saat peran pertama kali disemai. Dipakai membedakan
  // peran yang masih apa adanya dari peran yang sudah disesuaikan pemiliknya —
  // lihat src/db/seed-peran.js.
  addColumn(db, 'roles', 'seeded_json', 'TEXT', applied);

  // --- Penggajian ---
  // Gaji pokok dan tunjangan tetap disimpan pada akun orangnya, bukan pada tiap
  // periode gaji, supaya tidak perlu diketik ulang setiap bulan. Nilainya tetap
  // boleh diubah per periode saat menyusun daftar gaji — yang dipakai untuk
  // membayar adalah angka pada periode itu, bukan angka di master.
  addColumn(db, 'users', 'base_salary', 'REAL NOT NULL DEFAULT 0', applied);
  addColumn(db, 'users', 'allowance', 'REAL NOT NULL DEFAULT 0', applied);

  // --- Label varian untuk produk yang dijual tanpa label ---
  // Penandanya di master produk, bukan daftar SKU di dalam kode: produk non
  // label bertambah dari waktu ke waktu, dan daftar di kode akan tertinggal
  // tanpa ada yang menyadarinya.
  const varianBaru = addColumn(db, 'products', 'needs_variant', 'INTEGER NOT NULL DEFAULT 0', applied);
  if (varianBaru) {
    // Hanya saat kolomnya pertama kali dibuat. Menyetel ulang tiap boot akan
    // menghidupkan kembali penanda yang sengaja dimatikan pemiliknya.
    const tandai = db.prepare('UPDATE products SET needs_variant = 1 WHERE sku = ?');
    let n = 0;
    for (const sku of ['GPN', 'B-NLN', 'F-ON-NL', 'BN-SBRNL']) n += tandai.run(sku).changes;
    if (n) applied.push(n + ' produk ditandai butuh label varian');
  }

  // Varian yang dipilih dari katalog, beserta salinan namanya. Salinan itu
  // yang membuat riwayat pesanan tetap terbaca walau katalognya kemudian
  // diubah atau varian itu dihapus.
  addColumn(db, 'sales_item_variants', 'variant_id', 'INTEGER REFERENCES product_variants(id)', applied);
  addColumn(db, 'sales_item_variants', 'variant_nama', 'TEXT', applied);

  // --- Masa berlaku kata sandi ---
  // Kolom baru dibiarkan kosong untuk akun yang sudah ada. Itu memang berarti
  // mereka diminta mengganti kata sandi pada masuk berikutnya — dan untuk akun
  // yang kata sandinya belum pernah diganti sejak dibuat, itu justru yang
  // seharusnya terjadi.
  const sandiBaru = addColumn(db, 'users', 'password_changed_at', 'TEXT', applied);
  addColumn(db, 'users', 'must_change_password', 'INTEGER NOT NULL DEFAULT 0', applied);

  if (sandiBaru) {
    // Umur kata sandi akun yang sudah ada diisi dari tanggal akunnya dibuat.
    //
    // Membiarkannya kosong berarti SELURUH akun mendadak wajib mengganti kata
    // sandi begitu pembaruan ini terpasang — termasuk pemilik usaha sendiri,
    // pada hari kerja, tanpa pemberitahuan. Menyamakannya dengan umur akun
    // adalah tebakan paling masuk akal yang bisa dibuat: kata sandinya memang
    // belum pernah diganti sejak itu. Yang akunnya sudah lewat masa berlaku
    // tetap diminta mengganti, yang belum diminta pada waktunya nanti.
    const n = db
      .prepare('UPDATE users SET password_changed_at = created_at WHERE password_changed_at IS NULL')
      .run().changes;
    if (n) applied.push(`${n} akun: umur kata sandi diisi dari tanggal akun dibuat`);
  }

  semaiKatalogVarian(db, applied);

  // --- Nota pembayaran ke supplier ---
  // Nomor faktur yang dikeluarkan supplier. Berbeda dari po_no yang kita buat
  // sendiri: saat menanyakan sebuah pembayaran, yang dikenali supplier adalah
  // nomor mereka, bukan nomor kita.
  addColumn(db, 'purchase_orders', 'invoice_no', 'TEXT', applied);
  addColumn(db, 'purchase_orders', 'due_date', 'TEXT', applied);
  addColumn(db, 'purchase_orders', 'paid_date', 'TEXT', applied);

  // Rekening kas/bank yang dipakai. Kosong berarti memakai akun bawaan, seperti
  // perilaku sebelum kolom ini ada.
  addColumn(db, 'ad_spends', 'cash_code', 'TEXT', applied);
  addColumn(db, 'purchase_orders', 'cash_code', 'TEXT', applied);

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
