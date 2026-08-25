# Panduan Deploy ERP Kebumen ke Hostinger

> **Status: SUDAH LIVE di https://erp.indonesiaorganik.id**
> (paket Business, Web Apps Node.js, auto-deploy dari GitHub aktif)
>
> Dokumen ini tetap berguna sebagai rujukan bila perlu deploy ulang,
> memindahkan ke domain lain, atau menelusuri masalah.

Runbook langkah demi langkah. Ikuti berurutan — setiap tahap punya cara
verifikasi supaya Anda tahu pasti tahap itu berhasil sebelum lanjut.

Nama menu di hPanel bisa sedikit berbeda antar versi. Yang penting fungsinya,
bukan teksnya persis.

---

## Tahap 0 — Pastikan paket Anda mendukung Node.js

**Ini penentu.** Aplikasi ini butuh proses Node.js yang berjalan terus-menerus.
Shared hosting umumnya dirancang untuk PHP dan tidak menjalankan proses
persisten; Node.js tersedia di VPS, dan pada shared hosting hanya di tier
tertentu.

Cek di hPanel: apakah ada menu **Node.js** / **Node.js App** pada hosting Anda?

| Yang Anda lihat | Ikuti |
|---|---|
| Ada menu Node.js App | **Jalur A** (shared/cloud) di bawah |
| Tidak ada, tapi punya VPS | **Jalur B** (VPS) di bawah |
| Tidak ada dan tidak punya VPS | Perlu upgrade paket — keputusan dan pembeliannya di tangan Anda |

> Jangan lanjut sebelum tahap ini jelas. Mengisi konfigurasi di paket yang tidak
> mendukung Node.js hanya membuang waktu.

---

## Tahap 1 — Naikkan kode ke GitHub

Auto-deploy Hostinger menarik kode dari GitHub. Selama repo masih lokal, tidak
ada yang bisa ditarik.

### 1.1 Buat repository kosong

Buka https://github.com/new dan isi:

| Kolom | Nilai |
|---|---|
| Repository name | `erp-kebumen` (atau sesuka Anda) |
| Visibility | **Private** — disarankan, ini aplikasi internal |
| Initialize with README | **Jangan dicentang** — repo lokal sudah punya isi |

Klik **Create repository**, lalu salin URL-nya.

### 1.2 Hubungkan dan push

Jalankan di folder proyek. Ganti `USERNAME` dan `NAMA-REPO`:

```bash
git remote add origin https://github.com/USERNAME/NAMA-REPO.git
```

```bash
git push -u origin main
```

Saat `git push` dijalankan, akan muncul **popup Git Credential Manager** yang
meminta Anda login ke GitHub. Selesaikan popup itu sendiri — kredensialnya
disimpan Windows, tidak perlu diketik ulang di push berikutnya.

### 1.3 Verifikasi

Buka repo di GitHub. Anda harus melihat `server.js`, folder `src/`, dan `client/`.

Pastikan **tidak ada**: folder `data/`, `uploads/` yang berisi, berkas `.env`,
`PRODUCTION-ENV.txt`, dan berkas `.xlsx`. Semuanya sudah di-`.gitignore`, tapi
sempatkan melihat — `.env` dan `PRODUCTION-ENV.txt` berisi `JWT_SECRET`.

---

## Jalur A — Shared / Cloud Hosting (menu Node.js App)

### A.1 Buat aplikasi Node.js

hPanel → hosting Anda → **Node.js** → **Create application**:

| Kolom | Nilai |
|---|---|
| Node.js version | **20** atau lebih baru |
| Application mode | `production` |
| Application root | folder aplikasi, mis. `domains/namadomain.com/erp` |
| Application URL | domain/subdomain yang dipakai |
| Application startup file | `server.js` |

**Jangan mengisi Port secara manual.** Hostinger meng-inject `process.env.PORT`
dan `server.js` sudah membacanya.

### A.2 Isi Environment Variables

Masih di panel aplikasi, cari **Environment Variables**. Tambahkan satu per satu
dari berkas `PRODUCTION-ENV.txt` di komputer Anda (nama variabel di kiri tanda
`=`, nilainya di kanan).

Yang **wajib** diganti sebelum disimpan:

- `SEED_ADMIN_EMAIL` — email admin pertama Anda
- `SEED_ADMIN_PASSWORD` — password kuat, minimal 10 karakter

`JWT_SECRET` sudah digenerate acak, pakai apa adanya. Jangan dibagikan ke siapa
pun; kalau bocor, generate ulang dengan:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```

> Server sengaja **menolak menyala** bila `JWT_SECRET` kosong, terlalu pendek,
> atau masih nilai contoh. Kalau aplikasi gagal start, baca log-nya — pesannya
> menyebutkan persis apa yang kurang.

### A.3 Hubungkan repository GitHub

Di panel aplikasi, cari bagian **Git** / **Auto Deployment**:

1. Tempel URL repository, pilih branch `main`.
2. Untuk repo **private**, Hostinger akan meminta otorisasi GitHub (OAuth).
   Setujui sendiri lewat akun GitHub Anda.
3. Aktifkan **Auto Deployment**.
4. Salin **Webhook URL** yang diberikan.

Lalu di GitHub: repo → **Settings** → **Webhooks** → **Add webhook**

| Kolom | Nilai |
|---|---|
| Payload URL | Webhook URL dari hPanel |
| Content type | `application/json` |
| Which events | *Just the push event* |
| Active | dicentang |

Sejak ini, setiap `git push` ke `main` memicu Hostinger menarik kode dan
me-restart aplikasi.

### A.4 Build

Hostinger menjalankan `npm install`, dan script `postinstall` otomatis
membangun frontend. Bila panel menyediakan kolom **Build command** terpisah,
isi dengan:

```
npm run build
```

Build pertama memakan beberapa menit karena memasang dependensi backend dan
frontend sekaligus.

### A.5 Nyalakan dan verifikasi

Klik **Restart**, lalu buka:

```
https://domainanda.com/api/health
```

Yang benar: `{"ok":true,"service":"erp-kebumen","env":"production",...}`

Kalau gagal, lihat **Tahap 4 — Bila ada masalah**.

---

## Jalur B — VPS

Di VPS tidak ada panel Node.js; aplikasi dijalankan sendiri dan dijaga oleh
process manager.

### B.1 Siapkan server

Masuk lewat SSH, lalu pasang Node.js 20 dan PM2:

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash - && sudo apt install -y nodejs git
```

```bash
sudo npm install -g pm2
```

### B.2 Ambil kode

```bash
git clone https://github.com/USERNAME/NAMA-REPO.git /var/www/erp && cd /var/www/erp
```

Untuk repo private, gunakan SSH deploy key atau Personal Access Token milik Anda.

### B.3 Konfigurasi

```bash
cp .env.example .env && nano .env
```

Salin isi `PRODUCTION-ENV.txt` ke situ, ganti `SEED_ADMIN_EMAIL` dan
`SEED_ADMIN_PASSWORD`. Simpan dengan `Ctrl+O`, keluar dengan `Ctrl+X`.

### B.4 Pasang dan jalankan

```bash
npm install
```

```bash
pm2 start server.js --name erp-kebumen && pm2 save && pm2 startup
```

`pm2 startup` mencetak satu perintah — jalankan perintah itu agar aplikasi
otomatis hidup lagi setelah server reboot.

### B.5 Reverse proxy + SSL

Arahkan Nginx ke port aplikasi, lalu pasang sertifikat:

```bash
sudo apt install -y nginx certbot python3-certbot-nginx
```

```bash
sudo certbot --nginx -d domainanda.com
```

### B.6 Auto-deploy

Buat webhook sederhana, atau paling mudah — tambahkan langkah SSH pada GitHub
Actions yang menjalankan:

```bash
cd /var/www/erp && git pull && npm install && pm2 restart erp-kebumen
```

---

## Tahap 2 — Aktifkan HTTPS (wajib, bukan opsional)

**Tanpa HTTPS, Modul Presensi tidak akan berfungsi sama sekali.**

Browser hanya mengizinkan `getUserMedia` (kamera) dan `geolocation` (GPS) pada
origin aman. Di HTTP biasa, tombol kamera akan gagal di semua HP karyawan.

hPanel → **SSL** → terbitkan sertifikat gratis untuk domain Anda, lalu aktifkan
**Force HTTPS**.

Verifikasi: buka `https://domainanda.com/presensi`, klik **Aktifkan Kamera**.
Browser harus meminta izin kamera. Kalau tidak muncul apa-apa, HTTPS belum aktif.

---

## Tahap 3 — Setelah aplikasi hidup

1. **Login** dengan `SEED_ADMIN_EMAIL` dan `SEED_ADMIN_PASSWORD` yang Anda isi.
2. **Ganti password** — Pengaturan → Akun Saya.
3. **Perbaiki titik kantor** — Pengaturan → Titik Kantor. Koordinat bawaan masih
   placeholder. Buka menu itu dari HP **sambil berdiri di kantor**, klik
   *"Isi dari Lokasi Saya Sekarang"*, lalu atur radius (100–200 m wajar).
4. **Tambahkan karyawan** — Pengaturan → Pengguna.
5. **Isi master produk** — Gudang → Master Produk, lalu catat stok awal lewat
   Mutasi Stok (Stok Masuk).
6. **Sesuaikan jam kerja** — Pengaturan → Aplikasi.

> Jangan menjalankan `npm run seed:demo` di server produksi. Itu untuk latihan
> saja dan akan mencampur data contoh dengan transaksi asli.

---

## Tahap 4 — Bila ada masalah

| Gejala | Penyebab & tindakan |
|---|---|
| Build gagal: `vite: command not found` | Panel membangun dengan NODE_ENV=production sehingga npm melewati devDependencies. Sudah ditangani lewat `--include=dev` di scripts/build-client.js. |
| Password admin ditolak padahal sudah benar | Nilai environment variable mengandung `#`; hPanel menambahkan backslash di depannya. Pakai huruf dan angka saja. |
| Log: *"KONFIGURASI BELUM LENGKAP"* | `JWT_SECRET` kosong/pendek/masih contoh. Perbaiki di Environment Variables lalu Restart. |
| Halaman: *"Frontend belum di-build"* | `npm run build` belum jalan. Jalankan build atau Restart agar `postinstall` terpicu. |
| Kamera tidak jalan di HP | HTTPS belum aktif — lihat Tahap 2. |
| GPS: *"Izin lokasi ditolak"* | Karyawan menolak izin lokasi. Aktifkan di pengaturan browser HP, lalu muat ulang. |
| Presensi WFO ditolak terus | Koordinat kantor salah atau radius kekecilan. Perbaiki di Pengaturan → Titik Kantor. Pesan errornya menyebutkan jarak sebenarnya. |
| *"Akurasi GPS ... melebihi batas"* | Sinyal lemah (dalam gedung). Coba di area terbuka, atau naikkan `MAX_GPS_ACCURACY_M`. |
| Push GitHub tidak memicu deploy | Cek Webhook di GitHub → Settings → Webhooks → Recent Deliveries. Status harus 2xx. |
| Data hilang setelah redeploy | **Penyebab utama di Hostinger.** Aplikasi dijalankan dari `hbuilds/versions/<id>/` dan setiap deploy membuat folder versi baru, sehingga `./data` dan `./uploads` ikut hilang. Arahkan `DATABASE_URL` dan `UPLOAD_DIR` ke path absolut di luar `hbuilds`, mis. `/home/<user>/erp-data/`. |

Log aplikasi: hPanel → Node.js App → **Logs**, atau di VPS `pm2 logs erp-kebumen`.

---

## Tahap 5 — Backup (jangan ditunda)

Dua hal ini **tidak ada di GitHub** dan tidak ikut ter-deploy:

- `data/erp.db` — seluruh pembukuan, stok, penjualan, presensi
- `uploads/` — foto selfie presensi

Kalau folder aplikasi terhapus saat redeploy, data hilang permanen. Unduh
keduanya lewat File Manager hPanel secara berkala, atau di VPS:

```bash
tar -czf backup-$(date +%F).tar.gz data uploads
```

Untuk backup otomatis harian di VPS, tambahkan ke crontab:

```bash
0 2 * * * cd /var/www/erp && tar -czf /root/backup-$(date +\%F).tar.gz data uploads
```

---

## Alur kerja setelah live

Setiap kali ada perubahan kode:

```bash
git add -A && git commit -m "deskripsi perubahan" && git push
```

Hostinger menarik dan me-restart otomatis. Untuk memastikan versi baru sudah
naik, cek `https://domainanda.com/api/health` — kolom `time` akan menunjukkan
waktu terkini.
