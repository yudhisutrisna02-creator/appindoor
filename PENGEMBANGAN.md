# Panduan Mengubah Aplikasi

Alur kerja: **ubah di komputer → lihat hasilnya → push ke GitHub → otomatis live.**

```
komputer Anda            GitHub                Hostinger
─────────────            ──────                ─────────
edit tampilan/isi
      │
   npm run dev  ← lihat hasil langsung
      │
  git commit
      │
   git push  ─────────►  main  ──webhook──►  build & restart
                                              erp.indonesiaorganik.id
```

Biasanya 2–4 menit dari `git push` sampai perubahan terlihat di alamat produksi.

---

## 1. Menjalankan di komputer

```bash
npm run dev
```

Dua server menyala sekaligus:

| Alamat | Isi |
|---|---|
| **http://localhost:5173** | Yang Anda buka di browser. Perubahan tampilan langsung terlihat tanpa refresh. |
| http://localhost:3000 | API. Tidak perlu dibuka langsung. |

Buka **http://localhost:5173**. Setiap kali Anda menyimpan berkas di `client/src/`,
halaman menyegarkan dirinya sendiri dalam hitungan detik.

Hentikan dengan `Ctrl+C`.

> Kalau hanya ingin melihat hasil akhir seperti di produksi (tanpa hot reload):
> `npm run build` lalu `npm start`, buka http://localhost:3000

---

## 2. Data lokal terpisah dari produksi

Ini penting dan menguntungkan Anda:

| | Komputer Anda | Hostinger |
|---|---|---|
| Database | `data/erp.db` | `/home/u324879423/erp-data/erp.db` |
| Isi | data percobaan | data asli perusahaan |

Mengubah, menghapus, atau mengacak data di komputer **tidak berpengaruh sama sekali**
ke data produksi. Bereksperimenlah sebebasnya.

Untuk mengisi data contoh supaya tampilan terlihat penuh saat menata:

```bash
npm run seed:demo
```

Untuk mengosongkan kembali: hentikan server, hapus folder `data/`, jalankan lagi.

**Jangan pernah menjalankan `seed:demo` di produksi.**

---

## 3. Berkas mana yang diubah untuk apa

### Tampilan

| Ingin mengubah | Berkas |
|---|---|
| Warna, tombol, kartu, tabel | `client/src/index.css` |
| Warna utama (biru) | `client/tailwind.config.js` → bagian `brand` |
| Menu samping & daftar halaman | `client/src/App.jsx` |
| Halaman login | `client/src/pages/Login.jsx` |
| Dashboard | `client/src/pages/Dashboard.jsx` |
| Halaman presensi | `client/src/pages/Presensi.jsx` |
| Halaman lain | `client/src/pages/` (nama berkas sesuai menunya) |
| Format Rupiah, tanggal, label channel | `client/src/lib/format.js` |

### Isi & aturan bisnis

| Ingin mengubah | Berkas |
|---|---|
| Daftar akun (COA) bawaan | `src/db/coa.js` |
| Rumus margin & biaya penjualan | `src/routes/sales.js` → fungsi `computeOrder` |
| Aturan jurnal otomatis penjualan | `src/utils/accounting.js` → `buildSalesJournalLines` |
| Perhitungan Laba Rugi / Neraca / Arus Kas | `src/utils/reports.js` |
| Aturan keterlambatan presensi | `src/utils/time.js` → `evaluateLateness` |
| Radius & validasi geofence | `src/routes/attendance.js` |
| Isi berkas Excel / PDF | `src/utils/exporters.js` |

Hal yang **tidak perlu** diubah lewat kode karena sudah ada di menu Pengaturan:
nama perusahaan, jam masuk, toleransi terlambat, zona waktu, titik kantor, pengguna.

---

## 4. Sebelum push: pastikan tidak ada yang rusak

Di terminal lain, dengan server lokal menyala:

```bash
npm run smoke
```

40 pemeriksaan berjalan, termasuk memastikan Neraca tetap seimbang setelah
pembelian, penjualan, jurnal, opname, dan pembatalan order. Kalau ada yang
`GAGAL`, perbaiki dulu — jangan di-push.

---

## 5. Kirim ke produksi

```bash
git add -A
```

```bash
git commit -m "Rapikan tampilan dashboard"
```

```bash
git push
```

Selesai. Hostinger menarik sendiri dan me-restart aplikasi.

Memantau prosesnya: hPanel → erp.indonesiaorganik.id → **Penempatan**.
Status akan berubah *Sedang dibuat* → *Selesai*.

Memastikan versi baru sudah naik:

```bash
curl https://erp.indonesiaorganik.id/api/health
```

GitHub Actions juga menjalankan build + 40 uji asap pada setiap push. Kalau
tanda silang merah muncul di GitHub, ada yang rusak — perbaiki sebelum dipakai.

---

## 6. Kalau hasilnya tidak sesuai

Membatalkan perubahan yang belum di-commit:

```bash
git checkout -- .
```

Kembali ke versi sebelumnya yang sudah live:

```bash
git revert HEAD
```

```bash
git push
```

Hostinger akan otomatis kembali ke kondisi sebelumnya. Bisa juga lewat hPanel →
Penempatan → pilih deployment lama → jadikan aktif.

---

## 7. PENTING: mengubah struktur database

Ini satu-satunya bagian yang berbahaya.

Skema dibuat dengan `CREATE TABLE IF NOT EXISTS`. Artinya, kalau Anda menambah
kolom baru di `src/db/schema.sql`, tabel yang **sudah ada di produksi tidak akan
berubah** — perintah itu dilewati karena tabelnya sudah ada.

Akibatnya aplikasi error saat mencari kolom yang tidak ada di sana.

Contoh yang aman:

- menambah **tabel baru** → aman, langsung terbuat
- mengubah tampilan, rumus, label, laporan → aman
- menambah akun di `src/db/coa.js` → aman

Contoh yang **tidak** otomatis:

- menambah kolom pada tabel yang sudah ada
- mengubah tipe atau nama kolom
- mengubah aturan `CHECK`

Sejak versi ini sudah ada mekanisme migrasi otomatis di `src/db/migrate.js`.
Untuk menambah kolom, cukup daftarkan lewat `addColumn(...)` di berkas itu —
kolom akan ditambahkan sekali saat boot, aman diulang, dan tidak menyentuh
data lama. Untuk mengubah tipe atau nama kolom tetap beri tahu saya dulu,
karena SQLite memerlukan pembangunan ulang tabel.

Jangan menyiasatinya dengan menghapus `erp.db` di produksi — itu menghapus
seluruh absensi dan pembukuan.

---

## 8. Ringkasan perintah

| Perintah | Fungsi |
|---|---|
| `npm run dev` | Menjalankan mode pengembangan (hot reload) |
| `npm run build` | Membangun frontend |
| `npm start` | Menjalankan seperti di produksi |
| `npm run seed:demo` | Mengisi data contoh (lokal saja) |
| `npm run smoke` | 40 uji otomatis modul inti (perlu database kosong) |
| `npm run smoke:features` | 28 uji mitra, kas, utang-piutang, retur, izin |
| `git push` | Mengirim ke produksi |
