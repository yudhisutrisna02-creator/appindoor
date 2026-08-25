# ERP Kebumen

Aplikasi web full-stack untuk UMKM dagang multi-channel. Empat modul terintegrasi
dalam satu basis data, sehingga presensi, stok, penjualan, dan pembukuan selalu
konsisten satu sama lain.

| Modul | Isi |
|---|---|
| **1. Presensi & Geofencing** | Selfie kamera (WebRTC), penguncian GPS, tipe WFO/WFH/Dinas Luar, kalkulasi keterlambatan otomatis, rekap ekspor Excel & PDF |
| **2. Keuangan Dual-Entry** | Chart of Accounts, jurnal berpasangan dengan validasi Debit = Kredit, Buku Besar, Laba Rugi, Neraca, Arus Kas (OCF/ICF/FCF) |
| **3. Gudang & Valuasi Stok** | Master produk, mutasi masuk/keluar, HPP rata-rata bergerak, stok opname, valuasi persediaan real-time |
| **4. Penjualan Multi-Channel** | Order per channel, struktur biaya lengkap per order, analisis Net Profit & Margin per transaksi dan per channel |

Setiap transaksi stok dan penjualan **otomatis membentuk jurnal akuntansi**, jadi
laporan keuangan tidak perlu diinput ulang.

---

## Tumpukan Teknologi

- **Backend** — Node.js 20+, Express 4, better-sqlite3, JWT, Zod, ExcelJS, PDFKit
- **Frontend** — React 18, Vite 5, Tailwind CSS 3, Recharts, React Router 6
- **Database** — SQLite (berkas tunggal, tanpa server DB terpisah)

---

## Menjalankan Secara Lokal

```bash
npm install
```

`npm install` sekaligus memasang dependensi frontend dan membangunnya
(lewat script `postinstall`).

Salin konfigurasi lalu isi nilainya:

```bash
cp .env.example .env
```

Minimal yang wajib diganti adalah `JWT_SECRET`. Buat nilai acak dengan:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```

Jalankan mode produksi (satu proses, frontend disajikan Express):

```bash
npm start
```

Atau mode pengembangan (API + Vite dev server dengan hot reload):

```bash
npm run dev
```

Buka `http://localhost:3000`. Saat database masih kosong, akun admin dibuat
otomatis dan kredensialnya dicetak di log server — kredensial itu berasal dari
`SEED_ADMIN_EMAIL` dan `SEED_ADMIN_PASSWORD`. **Ganti password setelah login pertama.**

### Data Demo

Untuk demonstrasi ke tim, pelatihan staf, atau sekadar melihat tampilan terisi:

```bash
npm run seed:demo
```

Script ini membuat 12 produk khas Kebumen, ~150 order penjualan tersebar di
enam channel selama 45 hari, pembelian stok dua gelombang (agar HPP rata-rata
bergerak terlihat nyata), beban operasional bulanan, dan ~90 catatan presensi.
Tiga akun tambahan ikut dibuat — `siti@`, `budi@`, `rina@kebumen.local`, semuanya
berpassword `Demo#12345`.

Script menolak berjalan dua kali kecuali diberi `--force`.
**Jangan dijalankan di database produksi yang sudah berisi transaksi asli.**
Untuk kembali ke database kosong, hentikan server lalu hapus folder `data/`.

### Uji Asap

Dengan server menyala di terminal lain:

```bash
npm run smoke
```

Skrip ini menembak API sungguhan dan memverifikasi 38 hal, termasuk bahwa Neraca
tetap seimbang setelah pembelian, penjualan, jurnal manual, opname, dan pembatalan order.

Agar tidak mengotori database utama, jalankan pada database dan port terpisah:

```bash
PORT=3100 DATABASE_URL=file:./data/smoke.db npm start
```

lalu di terminal lain:

```bash
SMOKE_BASE_URL=http://localhost:3100 npm run smoke
```

---

## Deploy ke Hostinger (Node.js Application Hosting)

> Panduan langkah demi langkah yang lebih rinci — termasuk jalur VPS,
> troubleshooting, dan backup — ada di **[DEPLOYMENT.md](DEPLOYMENT.md)**.

### 1. Dorong kode ke GitHub

```bash
git init
git add .
git commit -m "ERP Kebumen: rilis awal"
git branch -M main
git remote add origin https://github.com/USERNAME/NAMA-REPO.git
git push -u origin main
```

`.gitignore` sudah mengecualikan `node_modules/`, `client/dist/`, `data/`,
`uploads/`, `.env`, dan berkas `.xlsx` lokal.

### 2. Buat aplikasi di hPanel

Masuk **hPanel → Websites → Node.js**, lalu isi:

| Kolom | Nilai |
|---|---|
| Node.js version | 20 atau lebih baru |
| Application root | direktori aplikasi (mis. `domains/namadomain.com/erp`) |
| Application startup file | `server.js` |
| Application mode | `production` |

Jangan mengisi Port secara manual — Hostinger meng-inject `process.env.PORT`
dan `server.js` sudah membacanya.

### 3. Hubungkan repository GitHub

Di panel aplikasi, buka bagian **Git / Auto Deployment**:

1. Tempelkan URL repository dan pilih branch `main`.
2. Aktifkan **Auto Deployment**.
3. Salin **Webhook URL** yang diberikan Hostinger.

Lalu di GitHub: **Settings → Webhooks → Add webhook**

| Kolom | Nilai |
|---|---|
| Payload URL | Webhook URL dari hPanel |
| Content type | `application/json` |
| Events | *Just the push event* |

Sejak titik ini, setiap `git push` ke `main` akan memicu Hostinger menarik kode
terbaru dan menjalankan ulang aplikasi.

### 4. Isi Environment Variables

Di hPanel → Node.js App → **Environment Variables**, tambahkan minimal:

```
NODE_ENV=production
JWT_SECRET=<string acak panjang>
DATABASE_URL=file:./data/erp.db
SEED_ADMIN_EMAIL=admin@perusahaananda.com
SEED_ADMIN_PASSWORD=<password kuat>
WORK_START=08:00
LATE_TOLERANCE_MINUTES=10
GEOFENCE_RADIUS_M=150
UPLOAD_DIR=./uploads
```

Daftar lengkap beserta penjelasannya ada di [.env.example](.env.example).

### 5. Build

Hostinger menjalankan `npm install`, dan script `postinstall` di
[package.json](package.json) otomatis membangun frontend. Bila panel Anda
menyediakan kolom **Build command** terpisah, isi dengan:

```
npm run build
```

### 6. Jalankan dan verifikasi

Klik **Restart** di hPanel, lalu buka:

```
https://domainanda.com/api/health
```

Respon `{"ok":true,...}` menandakan backend hidup. Buka domain utama untuk
mengakses antarmuka.

### GitHub Actions (opsional)

[.github/workflows/deploy.yml](.github/workflows/deploy.yml) memverifikasi build
dan menguji boot server pada setiap push. Bila Anda ingin Actions yang memicu
deploy (bukan webhook GitHub bawaan), simpan Webhook URL Hostinger sebagai
repository secret bernama `HOSTINGER_DEPLOY_WEBHOOK`. Tanpa secret itu, langkah
deploy dilewati tanpa menggagalkan pipeline.

---

## Catatan Penting untuk Produksi

**HTTPS wajib.** `getUserMedia` (kamera) dan `geolocation` (GPS) hanya berjalan
pada origin aman. Aktifkan SSL gratis di hPanel — tanpa itu, modul presensi tidak
akan berfungsi di perangkat pengguna.

**Persistensi data.** Berkas database berada di `data/` dan foto presensi di
`uploads/`. Keduanya di-ignore oleh Git dan **tidak** ikut ter-deploy. Pastikan
direktori aplikasi di Hostinger tidak dihapus total saat redeploy, dan lakukan
backup berkala terhadap kedua folder tersebut.

**Zona waktu.** Tanggal presensi memakai zona waktu dari pengaturan aplikasi
(default `Asia/Jakarta`), dapat diubah di menu Pengaturan.

---

## Struktur Proyek

```
├── server.js                  # Entry point Express (dibaca Hostinger)
├── package.json               # start / build / postinstall
├── .env.example               # Template environment variables
├── src/
│   ├── db/
│   │   ├── schema.sql         # Skema seluruh tabel
│   │   ├── coa.js             # Chart of Accounts standar + kode akun sistem
│   │   ├── index.js           # Koneksi, migrasi, penomoran dokumen
│   │   └── seed.js            # Bootstrap idempoten saat boot
│   ├── middleware/auth.js     # JWT + kontrol peran
│   ├── routes/
│   │   ├── auth.js            # Login, profil, ganti password
│   │   ├── attendance.js      # Modul 1
│   │   ├── finance.js         # Modul 2
│   │   ├── inventory.js       # Modul 3
│   │   ├── sales.js           # Modul 4
│   │   ├── dashboard.js       # Ringkasan lintas modul
│   │   └── admin.js           # Pengguna, titik kantor, pengaturan
│   └── utils/
│       ├── accounting.js      # Posting jurnal + validasi Debit = Kredit
│       ├── reports.js         # Laba Rugi, Neraca, Arus Kas, Buku Besar
│       ├── geo.js             # Haversine & pencarian kantor terdekat
│       ├── exporters.js       # Excel (ExcelJS) & PDF (PDFKit)
│       ├── upload.js          # Penyimpanan foto selfie base64
│       ├── time.js            # Zona waktu & kalkulasi keterlambatan
│       └── http.js            # Helper validasi & error
├── client/                    # Frontend React + Vite + Tailwind
│   └── src/pages/             # 14 halaman aplikasi
├── scripts/
│   ├── build-client.js        # Build frontend dari root
│   ├── dev-client.js          # Vite dev server dari root
│   ├── seed-demo.js           # Data contoh untuk demo & pelatihan
│   └── smoke-test.js          # Uji integrasi end-to-end
└── .github/workflows/         # CI + pemicu deploy
```

---

## Peran Pengguna

| Peran | Kewenangan |
|---|---|
| `staff` | Presensi sendiri, input mutasi stok & order penjualan, lihat laporan |
| `manager` | Semua di atas + kelola produk, akun COA, jurnal, opname, koreksi presensi |
| `admin` | Akses penuh termasuk pengelolaan pengguna dan pengaturan aplikasi |

---

## Ringkasan REST API

Semua endpoint kecuali `/api/health` dan `/api/auth/login` memerlukan header
`Authorization: Bearer <token>`.

**Autentikasi** — `POST /api/auth/login`, `GET /api/auth/me`, `POST /api/auth/change-password`

**Presensi** — `GET /api/attendance/today`, `POST /api/attendance/check-in`,
`POST /api/attendance/check-out`, `GET /api/attendance`,
`GET /api/attendance/export/{excel|pdf}`, `PATCH /api/attendance/:id`

**Keuangan** — `GET|POST|PUT|DELETE /api/finance/accounts`,
`GET|POST /api/finance/journals`, `GET /api/finance/reports/income-statement`,
`/balance-sheet`, `/cash-flow`, `/trial-balance`, `/ledger/:accountId`,
`GET /api/finance/reports/:report/export/{pdf|excel}`

**Gudang** — `GET|POST|PUT|DELETE /api/inventory/products`,
`GET|POST /api/inventory/moves`, `GET /api/inventory/valuation`,
`GET /api/inventory/opname/sheet`, `GET|POST /api/inventory/opname`

**Penjualan** — `GET|POST /api/sales`, `POST /api/sales/preview`,
`GET /api/sales/:id`, `DELETE /api/sales/:id`, `GET /api/sales/analytics`,
`POST /api/sales/returns`, `GET /api/sales/export/excel`

**Dashboard & Admin** — `GET /api/dashboard`, `GET|POST|PUT|DELETE /api/admin/users`,
`/api/admin/offices`, `GET|PUT /api/admin/settings`

---

## Migrasi ke PostgreSQL / MySQL

Build ini memakai SQLite karena cukup untuk beban UMKM dan tidak memerlukan
server database tambahan di Hostinger. Bila kelak butuh pindah:

1. Seluruh akses database terpusat di `src/db/index.js` dan query SQL di dalam
   `src/routes/*` serta `src/utils/reports.js`.
2. Ganti `better-sqlite3` dengan `pg` atau `mysql2`, lalu sesuaikan
   `resolveDbFile()` menjadi pembuatan connection pool.
3. Sesuaikan `schema.sql`: `INTEGER PRIMARY KEY AUTOINCREMENT` menjadi `SERIAL`
   (PostgreSQL) atau `AUTO_INCREMENT` (MySQL), dan `datetime('now')` menjadi
   `NOW()`.
4. better-sqlite3 bersifat sinkron; driver PostgreSQL/MySQL asinkron, sehingga
   handler route perlu diubah menjadi `async/await`.

`DATABASE_URL` sudah menolak URL PostgreSQL/MySQL secara eksplisit dengan pesan
yang jelas, sehingga tidak ada kegagalan senyap bila salah konfigurasi.
