-- ============================================================
-- ERP KEBUMEN — Skema Basis Data
-- Konvensi: semua nominal disimpan sebagai REAL dalam Rupiah penuh.
-- Tanggal transaksi disimpan sebagai TEXT 'YYYY-MM-DD'.
-- Timestamp disimpan sebagai TEXT ISO-8601.
-- ============================================================

PRAGMA foreign_keys = ON;

-- ---------- PENGGUNA & ORGANISASI ----------
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  name          TEXT    NOT NULL,
  email         TEXT    NOT NULL UNIQUE,
  password_hash TEXT    NOT NULL,
  role          TEXT    NOT NULL DEFAULT 'staff'
                CHECK (role IN ('admin','manager','staff')),
  position      TEXT,
  phone         TEXT,

  -- Data kepegawaian. Semuanya boleh kosong: yang wajib untuk masuk aplikasi
  -- hanya nama, email, dan sandi; sisanya dilengkapi sambil jalan.
  photo             TEXT,   -- nama berkas di folder unggahan
  nik               TEXT,   -- nomor induk karyawan
  department        TEXT,
  employment_status TEXT,   -- tetap, kontrak, magang
  join_date         TEXT,
  birth_date        TEXT,
  gender            TEXT,
  address           TEXT,
  emergency_name    TEXT,
  emergency_phone   TEXT,
  bank_name         TEXT,
  bank_account      TEXT,
  note              TEXT,

  active        INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- Titik lokasi kerja untuk geofencing WFO
CREATE TABLE IF NOT EXISTS offices (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  name      TEXT NOT NULL,
  address   TEXT,
  lat       REAL NOT NULL,
  lng       REAL NOT NULL,
  radius_m  REAL NOT NULL DEFAULT 150,
  active    INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT
);

-- ---------- MODUL 1: PRESENSI & GEOFENCING ----------
CREATE TABLE IF NOT EXISTS attendance (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id        INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  work_date      TEXT    NOT NULL,
  work_type      TEXT    NOT NULL
                 CHECK (work_type IN ('WFO','WFH','DINAS_LUAR')),

  check_in_at    TEXT,
  in_lat         REAL,
  in_lng         REAL,
  in_accuracy_m  REAL,
  in_photo       TEXT,
  in_address     TEXT,
  in_office_id   INTEGER REFERENCES offices(id),
  in_distance_m  REAL,
  in_inside_geofence INTEGER NOT NULL DEFAULT 0,

  check_out_at   TEXT,
  out_lat        REAL,
  out_lng        REAL,
  out_accuracy_m REAL,
  out_photo      TEXT,
  out_address    TEXT,
  out_distance_m REAL,

  status         TEXT NOT NULL DEFAULT 'ONTIME'
                 CHECK (status IN ('ONTIME','LATE','LEAVE','ABSENT')),
  late_minutes   INTEGER NOT NULL DEFAULT 0,
  work_minutes   INTEGER NOT NULL DEFAULT 0,
  notes          TEXT,
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),

  UNIQUE (user_id, work_date)
);
CREATE INDEX IF NOT EXISTS idx_att_date ON attendance(work_date);
CREATE INDEX IF NOT EXISTS idx_att_user_date ON attendance(user_id, work_date);

-- ---------- MODUL 2: AKUNTANSI DUAL-ENTRY ----------
CREATE TABLE IF NOT EXISTS accounts (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  code       TEXT NOT NULL UNIQUE,
  name       TEXT NOT NULL,
  type       TEXT NOT NULL
             CHECK (type IN ('ASSET','LIABILITY','EQUITY','REVENUE','EXPENSE')),
  subtype    TEXT NOT NULL DEFAULT 'OTHER',
  normal     TEXT NOT NULL CHECK (normal IN ('D','K')),
  cashflow   TEXT NOT NULL DEFAULT 'OCF'
             CHECK (cashflow IN ('OCF','ICF','FCF','NONE')),
  is_cash    INTEGER NOT NULL DEFAULT 0,
  is_system  INTEGER NOT NULL DEFAULT 0,
  active     INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_acc_type ON accounts(type);

CREATE TABLE IF NOT EXISTS journals (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  entry_no    TEXT NOT NULL UNIQUE,
  entry_date  TEXT NOT NULL,
  description TEXT NOT NULL,
  source      TEXT NOT NULL DEFAULT 'MANUAL',
  source_id   INTEGER,
  posted      INTEGER NOT NULL DEFAULT 1,
  created_by  INTEGER REFERENCES users(id),
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_jr_date ON journals(entry_date);
CREATE INDEX IF NOT EXISTS idx_jr_source ON journals(source, source_id);

-- Baris jurnal. Validasi SUM(debit) = SUM(credit) dilakukan di layer aplikasi.
CREATE TABLE IF NOT EXISTS journal_lines (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  journal_id INTEGER NOT NULL REFERENCES journals(id) ON DELETE CASCADE,
  account_id INTEGER NOT NULL REFERENCES accounts(id),
  debit      REAL NOT NULL DEFAULT 0 CHECK (debit  >= 0),
  credit     REAL NOT NULL DEFAULT 0 CHECK (credit >= 0),
  memo       TEXT,
  cashflow   TEXT CHECK (cashflow IN ('OCF','ICF','FCF','NONE')),
  CHECK (NOT (debit > 0 AND credit > 0))
);
CREATE INDEX IF NOT EXISTS idx_jl_journal ON journal_lines(journal_id);
CREATE INDEX IF NOT EXISTS idx_jl_account ON journal_lines(account_id);

-- ---------- MODUL 3: GUDANG & VALUASI STOK ----------
CREATE TABLE IF NOT EXISTS products (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  sku        TEXT NOT NULL UNIQUE,
  name       TEXT NOT NULL,
  category   TEXT NOT NULL DEFAULT 'Umum',
  unit       TEXT NOT NULL DEFAULT 'PCS',
  cost       REAL NOT NULL DEFAULT 0,
  price      REAL NOT NULL DEFAULT 0,
  stock      REAL NOT NULL DEFAULT 0,
  min_stock  REAL NOT NULL DEFAULT 0,
  active     INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_prod_cat ON products(category);

CREATE TABLE IF NOT EXISTS stock_moves (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id    INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  move_date     TEXT NOT NULL,
  move_type     TEXT NOT NULL CHECK (move_type IN ('IN','OUT','ADJ')),
  qty           REAL NOT NULL,
  unit_cost     REAL NOT NULL DEFAULT 0,
  balance_after REAL NOT NULL DEFAULT 0,
  ref           TEXT,
  source        TEXT NOT NULL DEFAULT 'MANUAL',
  source_id     INTEGER,
  note          TEXT,
  user_id       INTEGER REFERENCES users(id),
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_mv_prod ON stock_moves(product_id, move_date);
CREATE INDEX IF NOT EXISTS idx_mv_date ON stock_moves(move_date);

CREATE TABLE IF NOT EXISTS stock_opnames (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  opname_no        TEXT NOT NULL UNIQUE,
  opname_date      TEXT NOT NULL,
  note             TEXT,
  status           TEXT NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','POSTED')),
  total_diff_value REAL NOT NULL DEFAULT 0,
  user_id          INTEGER REFERENCES users(id),
  created_at       TEXT NOT NULL DEFAULT (datetime('now')),
  posted_at        TEXT
);

CREATE TABLE IF NOT EXISTS stock_opname_lines (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  opname_id    INTEGER NOT NULL REFERENCES stock_opnames(id) ON DELETE CASCADE,
  product_id   INTEGER NOT NULL REFERENCES products(id),
  system_qty   REAL NOT NULL DEFAULT 0,
  physical_qty REAL NOT NULL DEFAULT 0,
  diff_qty     REAL NOT NULL DEFAULT 0,
  unit_cost    REAL NOT NULL DEFAULT 0,
  diff_value   REAL NOT NULL DEFAULT 0,
  note         TEXT
);
CREATE INDEX IF NOT EXISTS idx_opl_opname ON stock_opname_lines(opname_id);

-- ---------- MODUL 4: PENJUALAN MULTI-CHANNEL ----------
CREATE TABLE IF NOT EXISTS sales_orders (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  order_no        TEXT NOT NULL UNIQUE,
  order_date      TEXT NOT NULL,
  -- Daftar kanal divalidasi di lapisan aplikasi, bukan di sini: kanal baru
  -- muncul dari waktu ke waktu dan tidak boleh menuntut pembongkaran tabel.
  channel         TEXT NOT NULL,
  customer        TEXT,
  marketplace_ref TEXT,

  gross_sales     REAL NOT NULL DEFAULT 0,
  discount        REAL NOT NULL DEFAULT 0,
  cogs            REAL NOT NULL DEFAULT 0,

  admin_fee_pct    REAL NOT NULL DEFAULT 0,
  admin_fee        REAL NOT NULL DEFAULT 0,
  handling_fee     REAL NOT NULL DEFAULT 0,
  shipping_extra   REAL NOT NULL DEFAULT 0,
  voucher_platform REAL NOT NULL DEFAULT 0,
  tax_pct          REAL NOT NULL DEFAULT 0,
  tax_amount       REAL NOT NULL DEFAULT 0,
  packing_cost     REAL NOT NULL DEFAULT 0,
  other_cost       REAL NOT NULL DEFAULT 0,

  net_revenue     REAL NOT NULL DEFAULT 0,
  total_fees      REAL NOT NULL DEFAULT 0,
  gross_profit    REAL NOT NULL DEFAULT 0,
  net_profit      REAL NOT NULL DEFAULT 0,
  margin_pct      REAL NOT NULL DEFAULT 0,

  payment_status  TEXT NOT NULL DEFAULT 'PAID'
                  CHECK (payment_status IN ('PAID','UNPAID')),
  status          TEXT NOT NULL DEFAULT 'POSTED'
                  CHECK (status IN ('DRAFT','POSTED','CANCELLED')),
  note            TEXT,
  user_id         INTEGER REFERENCES users(id),
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_so_date ON sales_orders(order_date);
CREATE INDEX IF NOT EXISTS idx_so_channel ON sales_orders(channel);

CREATE TABLE IF NOT EXISTS sales_items (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id   INTEGER NOT NULL REFERENCES sales_orders(id) ON DELETE CASCADE,
  product_id INTEGER NOT NULL REFERENCES products(id),
  qty        REAL NOT NULL,
  price      REAL NOT NULL,
  cost       REAL NOT NULL,
  subtotal   REAL NOT NULL,
  subcost    REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_si_order ON sales_items(order_id);

CREATE TABLE IF NOT EXISTS sales_returns (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  return_no   TEXT NOT NULL UNIQUE,
  return_date TEXT NOT NULL,
  order_id    INTEGER REFERENCES sales_orders(id),
  product_id  INTEGER NOT NULL REFERENCES products(id),
  qty         REAL NOT NULL,
  price       REAL NOT NULL,
  cost        REAL NOT NULL,
  amount      REAL NOT NULL,
  restock     INTEGER NOT NULL DEFAULT 1,
  reason      TEXT,
  user_id     INTEGER REFERENCES users(id),
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_sr_date ON sales_returns(return_date);

CREATE TABLE IF NOT EXISTS counters (
  key   TEXT PRIMARY KEY,
  value INTEGER NOT NULL DEFAULT 0
);

-- ---------- MITRA USAHA (SUPPLIER & PELANGGAN) ----------
CREATE TABLE IF NOT EXISTS partners (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  code       TEXT UNIQUE,
  name       TEXT NOT NULL,
  -- Satu mitra bisa berperan sebagai pemasok sekaligus pelanggan
  kind       TEXT NOT NULL DEFAULT 'CUSTOMER'
             CHECK (kind IN ('SUPPLIER','CUSTOMER','BOTH')),
  phone      TEXT,
  email      TEXT,
  address    TEXT,
  note       TEXT,
  term_days  INTEGER NOT NULL DEFAULT 0,   -- tempo bawaan (hari)
  active     INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_partner_kind ON partners(kind);

-- ---------- TOKO / AKUN MARKETPLACE ----------
-- Satu perusahaan bisa punya banyak akun toko pada marketplace yang sama.
-- Profitabilitas per toko sering berbeda jauh karena biaya iklan, voucher,
-- dan tarif admin yang tidak seragam.
CREATE TABLE IF NOT EXISTS shops (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL UNIQUE,
  channel    TEXT NOT NULL DEFAULT 'SHOPEE',
  note       TEXT,
  active     INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_shop_channel ON shops(channel);
