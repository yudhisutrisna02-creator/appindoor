# PROMPT DUPLIKASI WEB — ERP System Indoor

Panduan lengkap untuk membangun ulang aplikasi ERP ini untuk bisnis lain.

Dokumen ini bukan sekadar daftar fitur. Bagian **Aturan Arsitektur** berisi
keputusan yang lahir dari kesalahan nyata di aplikasi berjalan — bagian itulah
yang paling menentukan apakah hasil duplikasinya bisa dipakai bertahun-tahun
atau berantakan dalam tiga bulan. Jangan dilewati.

**Versi acuan:** 5 September 2026 · 37.400 baris kode · 33 tabel · 39 izin ·
41 akun COA · 39 halaman · 566 uji otomatis.

---

## 0. Cara Memakai Dokumen Ini

### Yang WAJIB dipahami sebelum mulai

Aplikasi ini **tidak membawa data contoh apa pun**. Tidak ada nama produk, nama
toko, nama supplier, atau angka penjualan yang tertanam di kode. Semuanya
diisi manual lewat layar setelah aplikasi berdiri:

| Data | Diisi lewat |
|---|---|
| Nama & profil bisnis, logo, alamat | Pengaturan → Aplikasi |
| Produk / SKU | Gudang → Master Produk |
| Toko / akun marketplace | Penjualan → Toko / Marketplace |
| Supplier & pelanggan | Mitra → Supplier & Pelanggan |
| Karyawan | Pengaturan → Data Tim |
| Titik kantor (geofence absensi) | Pengaturan → Titik Kantor |
| Stok awal | Gudang → Mutasi Stok (tipe IN) |
| Saldo awal kas/modal | Keuangan → Buku Besar & Jurnal |

Yang **disemai otomatis** hanya kerangka yang sama untuk semua bisnis:
41 akun COA, 5 peran bawaan beserta izinnya, dan satu akun admin pertama.

### Cara menjalankan promptnya

Jangan tempel seluruh dokumen ini sekaligus. Bangun bertahap — tiap tahap
diuji dulu sebelum lanjut. Urutan di **Bagian 14** sudah disusun supaya tiap
tahap berdiri di atas tahap sebelumnya yang sudah terbukti jalan.

---

## 1. Ringkasan Produk

Aplikasi ERP internal untuk usaha dagang yang berjualan lewat banyak kanal
(marketplace, offline, WhatsApp, website) sekaligus mengurus gudang, pembelian,
absensi, penggajian, dan pembukuan berpasangan dalam satu tempat.

**Masalah yang diselesaikan:** angka penjualan, stok, dan pembukuan biasanya
hidup di tiga tempat berbeda (spreadsheet marketplace, catatan gudang, buku kas)
dan tidak pernah cocok. Di sini satu order penjualan sekaligus: mengurangi stok,
menulis jurnal berpasangan, memindahkan piutang marketplace, dan memperbarui
dashboard — dalam satu transaksi database.

**Bahasa:** seluruh antarmuka, pesan galat, nama kolom, dan komentar kode
memakai bahasa Indonesia. Ini bukan preferensi gaya: yang memakainya tim
gudang dan admin marketplace, dan pesan galat berbahasa Inggris berakhir
sebagai telepon ke pemilik usaha.

---

## 2. Tumpukan Teknologi

### Peladen
```
Node.js 20 · Express 4
better-sqlite3   (sinkron, satu berkas, transaksi lewat db.transaction())
jsonwebtoken     (sesi)
bcryptjs         (kata sandi)
zod              (validasi seluruh masukan)
exceljs          (ekspor Excel)
pdfkit           (ekspor & laporan PDF berkop)
qrcode           (tanda tangan digital pada dokumen)
helmet · cors · compression · morgan · express-rate-limit
dayjs · dotenv
```

### Klien
```
React 18 · Vite 5
Tailwind CSS 3  (darkMode: 'class')
React Router 6
Recharts        (grafik)
lucide-react    (ikon)
```

### Kenapa SQLite, bukan Postgres

Satu berkas, tanpa peladen basis data terpisah, cadangannya cukup menyalin satu
berkas, dan cukup cepat untuk puluhan ribu transaksi setahun. Untuk usaha dengan
belasan pengguna, biaya mengurus Postgres jauh melebihi manfaatnya.

**Syaratnya:** berkas database harus di **luar** folder aplikasi
(mis. `/home/user/erp-data/erp.db`), supaya tidak terhapus saat kode diperbarui.
Ini bukan saran — pernah terjadi.

---

## 3. Aturan Arsitektur yang Tidak Boleh Dilanggar

Sepuluh aturan berikut lahir dari kesalahan nyata. Masing-masing pernah
menyebabkan angka salah atau data hilang di aplikasi berjalan.

### 3.1 Satu pintu untuk pembukuan

Setiap penulisan ke buku besar **wajib** lewat `postJournal()`, dan setiap
penghapusan lewat `deleteJournalsBySource()`. Tidak ada `INSERT INTO journal_lines`
di tempat lain, sama sekali.

`postJournal()` menolak jurnal yang debit ≠ kredit, dan menolak penulisan ke
periode yang sudah ditutup. Karena hanya ada dua pintu, aturan itu cukup
ditegakkan sekali dan berlaku untuk seluruh aplikasi — termasuk fitur yang
ditulis setahun kemudian oleh orang yang belum pernah membaca aturannya.

```js
// BENAR
postJournal({ date, description, lines, source: 'SALES', sourceId, userId });

// SALAH — melewati pemeriksaan seimbang dan kunci periode
db.prepare('INSERT INTO journal_lines ...').run(...);
```

### 3.2 Ubah = tulis ulang, bukan tambal

Saat order diubah, jurnalnya **dihapus seluruhnya lalu ditulis ulang**, bukan
ditambal selisihnya. Menambal menyisakan baris-baris yang saling meniadakan dan
tidak bisa dibaca siapa pun enam bulan kemudian.

### 3.3 Semua yang bertanya "sudah selesai belum" memakai satu daftar bersama

Status pesanan disimpan di satu berkas (`src/utils/status-pesanan.js`) beserta
**kelompoknya**: mana yang berarti "dananya sudah masuk", mana "barangnya
kembali", mana "masih berjalan".

Saat status baru ditambahkan, yang paling mudah terlewat bukan daftarnya —
melainkan tempat-tempat yang menuliskan `=== 'CAIR'` langsung. Kalau satu saja
terlewat, dana yang sudah diterima terus dihitung sebagai tertahan, **tanpa
pesan galat apa pun**. Ini benar-benar terjadi saat menambah status
"Pengiriman Kilat".

```js
// BENAR
if (STATUS.SELESAI_URUSAN.includes(o.fulfillment_status)) ...

// SALAH — akan terlewat saat ada status baru
if (o.fulfillment_status === 'CAIR' || o.fulfillment_status === 'RETUR') ...
```

### 3.4 Migrasi hanya menambah, tidak pernah mengurangi

`src/db/migrate.js` berisi migrasi yang aman dijalankan berulang kali: cek
kolom ada atau belum, baru tambahkan. Tidak ada `DROP`, tidak ada perubahan
tipe, tidak ada nomor versi migrasi.

Alasannya: migrasi berjalan otomatis tiap boot di produksi. Migrasi yang bisa
menghapus adalah migrasi yang suatu saat akan menghapus.

Penyemaian dicatat lewat penanda di tabel `settings` (mis.
`varian_katalog_disemai`), **bukan** dengan memeriksa apakah tabelnya kosong —
tabel kosong bisa berarti "belum disemai" atau "sudah, lalu dihapus pemiliknya",
dan menebaknya berarti mengembalikan data yang sengaja dibuang orang.

### 3.5 Kolom baru tidak boleh diam-diam mengosongkan data lama

Formulir lama yang belum mengenal sebuah kolom akan mengirim data tanpa kolom
itu. Kalau ditulis apa adanya, gaji pokok seseorang bisa terhapus hanya karena
admin mengubah nomor teleponnya lewat layar versi lama.

Aturannya: kolom yang **tidak dikirim sama sekali** mempertahankan isinya;
hanya yang dikirim sebagai kosong yang benar-benar dikosongkan.

### 3.6 Nilai historis dibekukan saat transaksi

Nama produk, nama varian, harga pokok, dan besaran gaji **disalin** ke baris
transaksi saat dibuat. Menaikkan gaji seseorang hari ini tidak boleh mengubah
slip gaji bulan lalu; mengganti nama produk tidak boleh mengubah nota yang
sudah dicetak.

### 3.7 Penjagaan dipasang di satu titik, bukan disebar

- **Izin menu** → di titik pasang router (`app.use('/api/x', halaman('x.lihat'), ...)`)
- **Pencatatan jejak** → satu middleware di `/api`
- **Kewajiban ganti kata sandi** → di dalam `requireAuth`

Penjagaan yang disebar di tiap endpoint adalah penjagaan yang suatu saat
terlewat di satu endpoint.

### 3.8 Pencarian dikerjakan peladen, bukan layar

Daftar order dibatasi jumlah barisnya. Menyaring di layar berarti baris yang
dicari — yang ada di luar batas itu — tidak akan pernah ketemu, dan pemakainya
menyimpulkan datanya hilang. Semua pencarian memakai `LIKE ... ESCAPE '\'` di
peladen, dengan karakter `%` dan `_` yang diketik pengguna di-escape.

### 3.9 Angka yang berubah wajib meninggalkan jejak

Stok, saldo rekening, dan angka apa pun yang muncul di neraca **tidak boleh
ditimpa begitu saja**, bahkan ketika yang diminta pengguna memang "ubah
angkanya langsung".

Stok dijelaskan oleh kartu stok dan muncul sebagai Persediaan di neraca.
Menimpanya diam-diam membuat kartu stok tidak bisa menjelaskan dari mana angka
barunya datang, dan membuat neraca berbeda dari valuasi gudang **tanpa tanda
apa pun** — selisih yang baru ketahuan berbulan-bulan kemudian, saat sudah
tidak bisa ditelusuri lagi.

Jalannya: sediakan layarnya seperti yang diminta, tetapi di belakangnya catat
sebagai penyesuaian bernomor lengkap dengan alasan wajib, mutasi, dan jurnalnya.
Pengguna mendapat kemudahan yang diminta; pembukuan tetap utuh.

```js
// SALAH — angka berubah, tidak ada yang bisa menjelaskan kenapa
db.prepare('UPDATE products SET stock = ? WHERE id = ?').run(baru, id);

// BENAR — stok berubah, kartu stok menjelaskan, neraca ikut menyesuaikan
db.transaction(() => {
  db.prepare('UPDATE products SET stock = ? WHERE id = ?').run(baru, id);
  catatMutasiADJ({ selisih, alasan });
  postJournal({ ... }); // Persediaan lawan Selisih Stok
})();
```

### 3.10 Angka rupiah ditulis penuh

Di seluruh kartu, tabel, dan daftar: `Rp 2.018.000`, bukan `Rp 2,02 jt`.
Pemilik usaha membaca angka ini untuk mengambil keputusan, dan pembulatan
menyembunyikan selisih yang justru sedang dicari.

Termasuk label sumbu grafik. Sumbunya diperlebar (116px, bukan 76px) supaya
"Rp 12.500.000" muat utuh — sumbu yang terpotong lebih buruk daripada sumbu
yang ringkas.

---

## 4. Skema Database (37 Tabel)

### Pengguna & hak akses
| Tabel | Isi |
|---|---|
| `users` | akun, data kepegawaian, gaji pokok, foto, `password_changed_at`, `must_change_password` |
| `roles` | peran, `seeded_json` (rekaman izin bawaan saat disemai) |
| `role_permissions` | izin per peran |
| `offices` | titik kantor + radius geofence |
| `settings` | pasangan kunci-nilai: profil perusahaan, jam kerja, logo, latar login |
| `audit_log` | jejak seluruh perubahan lewat `/api` |

### Gudang
| Tabel | Isi |
|---|---|
| `products` | SKU, nama, kategori, satuan, HPP, harga jual, stok, stok minimum, `needs_variant` |
| `product_variants` | katalog varian untuk produk yang dijual tanpa label |
| `stock_moves` | kartu stok: IN / OUT / ADJ, `balance_after`, sumber & id sumber |
| `stock_opnames`, `stock_opname_lines` | stok opname beserta selisihnya |
| `product_batches` | batch beserta tanggal kadaluarsa dan sisanya |
| `barang_perbaikan` | barang retur yang menunggu dikemas ulang, beserta nilai yang dibekukan |
| `batch_moves` | kartu pergerakan tiap batch |

### Penjualan
| Tabel | Isi |
|---|---|
| `sales_orders` | order: tanggal, kanal, toko, pembeli, resi, struktur biaya, status pesanan & pembayaran |
| `sales_items` | baris pesanan, dengan HPP yang dibekukan |
| `sales_item_variants` | label varian per baris, mengurangi stok produk induknya |
| `sales_returns` | retur penjualan |
| `shops` | toko / akun marketplace |

### Pembelian & mitra
| Tabel | Isi |
|---|---|
| `purchase_orders`, `purchase_items` | pesanan pembelian, no. faktur, jatuh tempo, tanggal bayar |
| `purchase_returns` | retur pembelian: barang yang dikembalikan ke supplier, beserta perlakuannya |
| `partners` | supplier & pelanggan, beserta piutang/utangnya |

### Keuangan
| Tabel | Isi |
|---|---|
| `accounts` | Chart of Accounts |
| `journals`, `journal_lines` | jurnal berpasangan |
| `period_locks` | penguncian periode (tutup buku) |
| `ad_spends` | biaya iklan per toko/kanal |
| `targets` | target omzet, laba, batas belanja iklan |
| `bank_statements`, `bank_statement_lines` | rekening koran yang diunggah, beserta baris yang sudah/belum cocok dengan jurnal |

### Presensi & gaji
| Tabel | Isi |
|---|---|
| `attendance` | absensi: selfie, GPS, tipe kerja, status |
| `payrolls`, `payroll_items` | daftar gaji per periode, dengan angka yang dibekukan |

### Lain-lain
| Tabel | Isi |
|---|---|
| `document_signatures` | tanda tangan digital + QR verifikasi |
| `laporan_terbit` | catatan laporan resmi yang diterbitkan |
| `counters` | penomoran dokumen berurutan (SO/2026-09/0001) |

---

## 5. Modul & Menu

Sidebar terbagi 9 seksi. Menu yang izinnya tidak dipegang **tidak ditampilkan**,
dan API-nya juga menolak — bukan sekadar disembunyikan.

### Ringkasan
- **Dashboard** — realtime hari ini, periode, stok, keuangan, temuan otomatis
- **Pusat Perhatian** — hal yang perlu ditindak: stok menipis, dana lama belum cair, faktur jatuh tempo
- **Akun Saya** — foto diri & ganti kata sandi (terbuka untuk semua peran)

### Presensi
- **Absen Sekarang** — selfie + GPS, diperiksa terhadap radius geofence
- **Rekap Absensi** — rekap per orang/periode, koreksi status, izin/cuti
- **Penggajian** — susun daftar gaji, posting ke jurnal, slip gaji ber-QR

### Gudang
- **Valuasi Stok** — nilai persediaan, potensi pendapatan & laba
- **Master Produk** — CRUD produk + katalog varian + koreksi stok langsung dari layar produk
- **Mutasi Stok** — kartu stok masuk/keluar/penyesuaian
- **Stok Opname** — hitung fisik, selisih, penyesuaian otomatis
- **Kinerja Produk** — laku/tidak, modal menganggur, margin per produk
- **Batch & Kadaluarsa** — batch menjelang kadaluarsa beserta nilainya, diurutkan dari yang mendesak
- **Barang Perlu Perbaikan** — barang retur yang masih bisa dijual setelah dikemas ulang

### Pembelian
- **Saran Pembelian** — barang yang perlu dibeli beserta jumlah dan perkiraan dananya
- **Pesanan Pembelian** — PO, faktur, jatuh tempo, penerimaan barang
- **Retur Pembelian** — barang dikembalikan ke supplier; stok berkurang, utang atau kas menyesuaikan

### Penjualan
- **Order Penjualan** — daftar + formulir order (8 kartu statistik, pencarian di semua submenu)
- **Papan Pengiriman** — kanban per tahap, ubah status massal
- **Pencairan Dana** — dana marketplace yang belum cair, rekonsiliasi
- **Analisis Margin** — margin per kanal & produk
- **Analisis Pelanggan** — pembeli berulang, nilai seumur hidup, sebaran kota
- **Retur Penjualan**
- **Toko / Marketplace** — kinerja per toko
- **Biaya Iklan** — belanja iklan per toko, laba setelah iklan, ROAS
- **Target & Pencapaian**

### Keuangan
- **Rekening Kas & Bank** — saldo per rekening, rincian pergerakan
- **Kas Masuk & Keluar**
- **Pindah Saldo** — memindahkan uang antar rekening sendiri (bank ke kas tunai, kas ke bank, antar bank)
- **Rekonsiliasi Bank** — mencocokkan rekening koran dengan jurnal, menandai yang belum tercatat
- **Proyeksi Arus Kas**
- **Utang & Piutang**
- **Laporan Keuangan** — neraca, laba rugi, arus kas, neraca saldo
- **Buku Besar & Jurnal** — bila rekening kas/bank bersaldo awal minus, panel di atas buku besar menunjukkan asalnya per sumber, lengkap dengan tombol **Pindahkan rekening** untuk pembayaran yang tercatat dari rekening yang salah
- **Chart of Accounts**

### Laporan
Enam laporan resmi berkop: Presensi, Persediaan, Pembelian, Penjualan,
Keuangan, Mitra. Bisa diunduh CSV / Excel / PDF / cetak, ukuran A4 atau Folio,
dengan tanda tangan digital ber-QR.

> **Aturan penting:** laporan **wajib memanggil fungsi agregat yang sama**
> dengan menu aslinya, bukan menghitung ulang dengan query sendiri. Kalau
> menghitung sendiri, suatu saat angka Laporan Penjualan akan berbeda dari
> menu Order Penjualan — dan tidak ada yang tahu mana yang benar.

### Mitra
- **Supplier & Pelanggan**

### Sistem
- **Pengaturan** — profil perusahaan, logo, latar halaman masuk, jam kerja, titik kantor, data tim, peran & hak akses
- **Dokumen Terbit** — dokumen bertanda tangan digital yang beredar
- **Pencadangan** — cadangan otomatis & unduh manual
- **Riwayat & Tutup Buku** — jejak perubahan, penguncian periode

---

## 6. Peran & Hak Akses (39 Izin)

```
dashboard.lihat

presensi.absen        presensi.lihat        presensi.kelola

gudang.lihat          gudang.produk         gudang.mutasi
gudang.opname         gudang.kinerja

penjualan.lihat       penjualan.buat        penjualan.ubah
penjualan.batal       penjualan.retur       penjualan.toko
penjualan.margin

pembelian.lihat       pembelian.kelola

iklan.lihat           iklan.kelola

target.lihat          target.kelola

penggajian.lihat      penggajian.kelola     penggajian.posting

keuangan.lihat        keuangan.kas          keuangan.jurnal
keuangan.coa          keuangan.tutupbuku

mitra.lihat           mitra.kelola

sistem.pengaturan     sistem.tim            sistem.peran
sistem.kantor         sistem.dokumen        sistem.cadangan
sistem.riwayat
```

### Peran bawaan
| Peran | Izin | Untuk |
|---|---|---|
| Admin | 39 (semua) | pemilik |
| Manajer | 35 | kepala operasional |
| Tim CS / Admin Marketplace | 13 | input order, pengiriman, pencairan |
| Tim Konten / Marketing | 8 | iklan, target, analisis |
| Tim Gudang | 10 | stok, opname, pembelian |

### Aturan penyemaian peran

Tiap peran menyimpan **rekaman izin bawaannya** (`seeded_json`). Saat aplikasi
diperbarui dan ada izin baru:

- **Belum pernah disesuaikan pemilik** (izin masih sama persis dengan rekaman)
  → disegarkan mengikuti daftar bawaan terbaru.
- **Sudah disesuaikan** → dibiarkan utuh, hanya dilaporkan di log.
- **Admin** → selalu menerima seluruh izin, termasuk yang baru.

Tanpa aturan admin ini, memasang menu baru justru mengunci pemiliknya sendiri
keluar dari fitur yang baru saja dipasang.

---

## 7. Chart of Accounts (43 Akun)

Kolom: kode, nama, tipe, arus kas, saldo normal (D/K).

| Kode | Nama | Tipe | Arus Kas | Normal |
|---|---|---|---|---|
| 1000 | Kas Tunai | ASSET | CASH | D |
| 1010 | Bank Operasional | ASSET | CASH | D |
| 1020 | E-Wallet / QRIS | ASSET | CASH | D |
| 1100 | Piutang Usaha | ASSET | - | D |
| 1110 | Piutang Marketplace (Dana Ditahan) | ASSET | - | D |
| 1200 | Persediaan Barang Dagang | ASSET | - | D |
| 1300 | Biaya Dibayar di Muka | ASSET | - | D |
| 1500 | Peralatan & Inventaris | ASSET | - | D |
| … | *(31 akun lainnya: kewajiban, ekuitas, pendapatan, beban)* | | | |

| 4300 | Pendapatan Ongkir Non-Marketplace | REVENUE | OTHER_INCOME | K |

| 3050 | Saldo Awal Kas & Bank | EQUITY | CAPITAL | K |

Ringkasan: **10 aset · 5 kewajiban · 4 ekuitas · 5 pendapatan · 17 beban**.

Akun bertanda `is_system = 1` tidak bisa dihapus — dipakai jurnal otomatis.
Pemilik boleh menambah akun sendiri lewat menu Chart of Accounts.

---

## 8. Aturan Akuntansi

### Alur satu order penjualan
```
Penjualan kotor        → Kredit  Pendapatan Penjualan
Diskon penjual         → Debit   Potongan Penjualan
Biaya platform/admin   → Debit   Beban Marketplace
HPP                    → Debit   HPP · Kredit Persediaan
Dana belum cair        → Debit   Piutang Marketplace
Sudah cair / lunas     → Debit   Kas atau Bank
```
Seluruhnya ditulis dalam satu `postJournal()`, dalam satu transaksi database
bersama pengurangan stok. Kalau salah satunya gagal, semuanya batal — tidak
pernah ada stok berkurang tanpa jurnal, atau sebaliknya.

### Struktur biaya order (semua rupiah, kecuali pajak persen)
```
Diskon Penjual (Rp) · Voucher & Subsidi · Biaya Platform
Biaya Gratis Ongkir XTRA · Biaya Layanan · Pajak (%)
Biaya Packing (Rp) · Biaya Lain (Rp)
```

### Ongkir yang ditagih di luar marketplace

Untuk penjualan offline/WA, ongkir sering ditagih ke pembeli dan **ikut
ditransfer bersama nilai ordernya**. Uang ini harus dipisahkan dari omzet:

| | Ikut ongkir? | Alasan |
|---|---|---|
| Omzet (penjualan kotor & bersih) | **tidak** | bukan hasil menjual barang |
| Laba order | **tidak** | uangnya diteruskan ke ekspedisi |
| Uang masuk rekening | **ya** | memang ikut ditransfer pembeli |

Di jurnal, ongkir dikreditkan ke **akun pendapatannya sendiri** (4300), bukan
digabung ke akun Penjualan. Menggabungnya membuat omzet di laporan keuangan
tampak lebih besar daripada barang yang benar-benar terjual, dan setelah
tercampur tidak bisa dipisahkan lagi.

### Pindah saldo antar rekening

Menarik tunai dari bank, menyetor tunai, atau memindahkan antar bank **bukan
pemasukan dan bukan pengeluaran** — uangnya tidak bertambah dan tidak berkurang,
hanya berpindah tempat.

Dicatat sebagai dua entri terpisah di Kas Masuk dan Kas Keluar, total pemasukan
dan pengeluaran bulan itu tampak membengkak padahal tidak ada uang yang
benar-benar mengalir keluar masuk. Jadi keduanya harus menjadi **satu jurnal**:
debit rekening tujuan, kredit rekening asal. Arus kas bersihnya nol dengan
sendirinya dan tidak bisa tercatat separuh.

Catatan teknis: jurnal pemindahan tidak punya dokumen induk, sehingga
`source_id`-nya kosong. Menghapusnya lewat `deleteJournalsBySource` akan
**menyapu seluruh pemindahan sekaligus** — sediakan `deleteJournalById(id)`
dengan pemeriksaan kunci periode yang sama.

### Saldo awal minus & pindah rekening

Saldo awal buku besar adalah jumlah semua catatan SEBELUM tanggal awal, jadi
catatan penyebabnya tidak tampil sebagai baris. Kalau rekening kas/bank
bersaldo awal minus — mustahil secara fisik — laporan buku besar menyertakan
`asalSaldoAwal`: ringkasan per sumber jurnal dan daftar pembayaran yang bisa
dipindah (15 terbesar).

`POST /api/finance/journals/:id/pindah-rekening {dari, ke}` mengganti HANYA
baris rekening kas pada jurnal itu. Aturannya:
- Hanya sumber SETTLEMENT, CASH, MANUAL. Jurnal penjualan/stok dibangun ulang
  dari dokumennya, jadi rekeningnya diubah di dokumen itu (Ubah Pesanan).
- Keduanya harus rekening kas/bank, tidak boleh sama, dan jurnal harus
  memakai rekening asal.
- Ditolak bila baris jurnalnya sudah dicocokkan di Rekonsiliasi Bank.
- Lewat `deleteJournalById` + `postJournal({ entryNo })` dalam satu transaksi:
  nomor jurnal, tanggal, nominal, dan mitra (utang/piutang) tetap; kunci
  periode ikut menjaga. `postJournal` menerima `entryNo` untuk keperluan ini.

Hapus jurnal manual juga lewat `deleteJournalById`, supaya bulan yang sudah
ditutup buku tidak bisa diubah dari tombol hapus.

### Membetulkan pembayaran & harga barang masuk yang salah

Kasus nyata: utang supplier Rp 8.735.000 (500 pack @17.470) dibayar dari Kas
Tunai, padahal harga pabrik @12.470 + ongkir Rp 125.000 = Rp 6.360.000 dan
dibayar dua kali transfer dari BCA. Tiga langkah, urutannya penting:

1. **Hapus pembayaran salah** — Utang & Piutang → Riwayat mitra → ikon hapus
   (juga dari Jurnal Umum). `DELETE /api/finance/journals/:id` kini menerima
   sumber MANUAL dan SETTLEMENT; utangnya terbuka kembali. Ditolak bila baris
   jurnalnya sudah dicocokkan di Rekonsiliasi Bank.
2. **Betulkan harga barang masuk** — Mutasi Stok → tombol Harga pada baris
   masuk. `PUT /api/inventory/moves/:id/harga {unit_cost, biaya_tambahan, alasan}`:
   nilai = qty × harga + biaya tambahan; jurnal Persediaan/Utang ditulis ulang
   dengan nomor & tanggal tetap; selisih nilai ditempelkan ke HPP rata-rata
   stok yang TERSISA (nilai persediaan di buku besar tetap = Σ stok × HPP);
   penjualan yang sudah tercatat tidak disentuh. Hanya untuk barang masuk
   sumber MANUAL (penerimaan PO lewat PO-nya). Ditolak bila utang supplier
   jadi minus (hapus pembayaran salah dulu), bila stok habis, atau bila jurnal
   tidak lagi dua baris senilai mutasinya.
3. **Catat ulang pembayaran yang benar** di Utang & Piutang dengan tanggal dan
   rekening sesuai rekening koran.

### Barang masuk lama → Pesanan Pembelian

Barang masuk hasil impor dicatat lewat Mutasi Stok, jadi tidak muncul di menu
Pembelian. Tombol **Jadikan PO** (Mutasi Stok, izin `pembelian.kelola`) →
`POST /api/pembelian/dari-barang-masuk {move_id, order_date, unit_cost,
biaya_tambahan, invoice_no, note}`: membuat PO berstatus SELESAI untuk supplier
mutasi itu, memakai mutasi & jurnal yang sudah ada sebagai penerimaannya (stok
TIDAK bertambah lagi), memberi mutasi nomor PO, dan — bila harganya berubah —
memakai `koreksiHargaMasuk` (fungsi yang sama dengan tombol Harga). Semua dalam
satu transaksi; ditolak bila utang supplier jadi minus, mutasi tanpa supplier,
atau sudah ber-PO.

### Transaksi Utang & Piutang (tab Transaksi)

Daftar per mitra hanya memuat mitra yang MASIH punya saldo, sehingga pembayaran
yang salah pada mitra bersaldo nol/minus tidak bisa dijangkau. Tab Transaksi
menampilkan semua jurnal utang/piutang menurut rentang tanggal (cari mitra /
no. jurnal, filter jenis, ekspor). `GET /api/cashflow/transaksi-mitra`;
`PUT /api/cashflow/settlements/:id` (tanggal, nominal ≤ sisa + nominal lama,
rekening, catatan; nomor tetap bila bulannya sama) dan
`DELETE /api/cashflow/settlements/:id` (hanya SETTLEMENT/AWAL), izin
`keuangan.kas`, ditolak bila sudah direkonsiliasi. `ar-ap` juga membawa
`lebihBayar` (saldo minus) yang ditampilkan sebagai peringatan.

### Kosongkan Satu Bulan (Sistem → Cadangan)

Untuk memulai bersih dari bulan berikutnya ketika data sebuah bulan sudah
terlanjur bercampur. `POST /api/kosongkan-bulan {bulan, terapkan, konfirmasi,
bawa_saldo_mitra}`, izin `sistem.cadangan`. Yang dihapus pada bulan itu:
- order penjualan — lewat `cancelOrder` (stok kembali, retur ikut dibalik,
  termasuk retur bertanggal bulan berikutnya),
- mutasi stok selain penjualan/retur — stok produk dikurangi sebesar
  pengaruhnya; arah mutasi ADJ diambil dari `stock_opname_lines.diff_qty`
  atau catatan "Koreksi stok A → B",
- dokumen stok opname, belanja iklan, pesanan pembelian bulan itu,
- SEMUA jurnal bertanggal bulan itu (via `deleteJournalById`).

Penghalang: bulan ditutup buku, retur macet, jurnal modul lain yang punya
status sendiri (mis. PAYROLL), PO yang penerimaannya di bulan lain, mutasi
penjualan/retur yang tidak terhubung ke order bulan itu.

Utang/piutang mitra yang TERBENTUK di bulan itu dibawa sebagai jurnal `AWAL`
tertanggal akhir bulan (Modal lawan Utang/Piutang mitra), dipilih per mitra
(`mitra_dibawa`; bawaan semua) — tanpa ini,
pembayaran di bulan berikutnya untuk utang bulan itu membuat utang minus.
Pratinjau memperingatkan dana marketplace yang belum cair (tidak akan
tercatat saat masuk), retur bulan lain yang ikut terhapus, dan produk yang
stoknya jadi minus. Cadangan otomatis dibuat tepat sebelum penghapusan.

Pratinjau Hapus Periode menampilkan saldo akhir rekening sebelum → sesudah dan
memperingatkan rekening/piutang yang akan minus: pemasukan periode itu hilang,
tetapi pengeluarannya (bayar supplier, iklan) tetap tercatat.

### Koreksi stok

Membetulkan angka stok yang keliru tanpa mengarang mutasi masuk/keluar yang
tidak pernah terjadi. Diperlakukan persis seperti selisih stok opname: satu
mutasi ADJ beserta alasan wajibnya, dan satu jurnal Persediaan lawan Selisih
Stok. Dua jalan menuju hal yang sama tidak boleh menghasilkan angka berbeda
di neraca.

### Kategori kas bukan hanya pendapatan dan beban

Uang yang masuk ke rekening sering bukan hasil berjualan, dan uang keluar
sering bukan biaya. Layar kas **wajib** menawarkan tiga kelompok di tiap arah:

| Kas Masuk | Kas Keluar |
|---|---|
| Pemasukan Usaha (REVENUE) | Biaya Operasional (EXPENSE) |
| Modal & Saldo Awal (EQUITY/CAPITAL) | Pengambilan Pemilik (EQUITY/DRAWING) |
| Pinjaman Diterima (LIABILITY/LOAN) | Pembayaran Utang (LIABILITY) |

Tanpa kelompok "Saldo Awal", saldo yang sudah ada di kas dan bank sebelum
aplikasi dipakai **tidak bisa dimasukkan sama sekali** — sehingga setiap
pembayaran tampak keluar dari nol dan seluruh rekening berakhir minus meski
uangnya sebenarnya ada. Ini bukan kemungkinan teoretis; ini benar-benar
terjadi dan baru ketahuan berbulan-bulan kemudian.

Akun yang punya menunya sendiri (Utang Usaha, Utang Gaji, Biaya Iklan) harus
**ditolak peladen**, bukan sekadar disembunyikan dari daftar.

### Batch & tanggal kadaluarsa

Wajib bila barangnya punya masa aktif — produk hayati, makanan, obat, kosmetik.

- Pelacakan dinyalakan **per produk**, bukan menyeluruh.
- Menyalakannya memasukkan stok yang ada sebagai **batch pembuka**; tanpa itu
  sisa batch nol sementara stoknya ratusan, dan penjualan pertama ditolak.
- Barang keluar memakai **FEFO**, bukan FIFO: yang lebih dulu kedaluwarsa
  keluar lebih dulu, karena barang yang datang belakangan bisa saja
  kedaluwarsa lebih cepat.
- Batch **tanpa tanggal disisakan paling akhir** — ia bisa jadi stok lama yang
  datanya belum lengkap, dan mengeluarkannya duluan menyembunyikan batch yang
  justru mendesak.
- Pembatalan mengembalikan ke **batch asalnya** lewat catatan pergerakan, bukan
  menebak. Menebak membuat barang "pindah" batch hanya karena ordernya
  disunting, dan penelusurannya salah persis saat paling dibutuhkan.
- Jumlah batch **tidak boleh bisa diketik** di layar — ia dibentuk pergerakan
  barang. Yang dilengkapi hanya kode dan tanggalnya.

### Kunci periode
Tutup buku mengunci satu bulan. Setelah dikunci, `postJournal()` dan
`deleteJournalsBySource()` menolak semua penulisan ke bulan itu — termasuk
lewat jalur tidak langsung seperti membetulkan tanggal order. Pemilik bisa
membuka kuncinya lagi, dan tindakan itu tercatat di jejak.

### Membetulkan tanggal order
Mengubah tanggal order **wajib** memindahkan tiga hal sekaligus:
1. tanggal ordernya,
2. tanggal jurnalnya (lewat tulis ulang),
3. tanggal mutasi stoknya.

Kalau nomor 3 terlewat, kartu stok menunjukkan barang keluar di hari yang
salah dan valuasi per tanggal meleset di sekitar pergantian bulan — persis
masalah yang membuat orang membetulkan tanggalnya sejak awal.

---

### Retur pembelian

Arah uangnya berlawanan dengan retur penjualan, jadi **tidak boleh memakai
jalur yang sama**: retur penjualan mengurangi pendapatan, retur pembelian
mengurangi utang atau mengembalikan kas.

- Dua perlakuan, dan **orangnya yang memilih** — bukan ditebak dari status
  pembayaran PO. Menebaknya terdengar pintar tetapi salah: satu PO bisa dibayar
  sebagian, dan supplier sering memotong tagihan berikutnya alih-alih mengirim
  uang kembali. Yang tahu kesepakatannya hanya orang yang menelepon suppliernya.
  - **Potong utang** — barang belum dibayar: Utang Usaha didebit, Persediaan dikredit.
  - **Dana kembali** — barang sudah dibayar: rekening kas didebit, Persediaan dikredit.
- Menolak mengembalikan lebih banyak daripada stok yang ada. Membiarkannya
  membuat stok minus, dan stok minus tidak pernah bisa dijelaskan kepada siapa
  pun yang menghitung fisik.
- Batch dipotong FEFO seperti pengeluaran lain. Barang cacat memang biasanya
  dari batch tertentu, tetapi memilihnya butuh orang yang melihat fisiknya.
- **Tanpa menu ini**, barang rusak hanya bisa dicatat lewat koreksi stok:
  stoknya berkurang tetapi utangnya tidak, sehingga aplikasi tetap menagih
  pembayaran untuk barang yang sudah dikembalikan.

### Retur penjualan: tiga kondisi, bukan dua

Barang yang dikembalikan pembeli tidak selalu "bagus" atau "rusak". Botol
kemasan cair yang pecah memang langsung jadi kerugian, tetapi kemasan foil yang
hanya rusak label cukup dikemas ulang dan bisa dijual lagi.

- **Bagus** — masuk stok jual, HPP dibalik seperti biasa.
- **Perlu dikemas ulang** — TIDAK masuk stok jual, tetapi nilainya pindah dari
  HPP ke pos aset tersendiri. Tanpa pos ini, barang yang sedang dikerjakan
  tidak tercatat di mana pun: yang lupa mengerjakannya tidak pernah tahu, dan
  laba turun di bulan barang masuk lalu naik di bulan barang keluar tanpa sebab
  yang bisa dijelaskan.
- **Rusak total** — nilainya pindah dari HPP ke akun kerugian tersendiri. Laba
  tidak berubah sedikit pun; yang berubah hanya namanya, sehingga berapa yang
  hilang karena barang rusak akhirnya bisa dibaca.

Aturan yang mudah dilanggar:

- Pos "menunggu perbaikan" **jangan diberi subtipe INVENTORY**. Nilai persediaan
  di neraca harus tetap sama persis dengan valuasi stok gudang, dan barang ini
  belum boleh dijual.
- Nilai barangnya **dibekukan saat masuk**. Kalau HPP produknya bergerak setelah
  itu, yang dikembalikan saat keluar tetap angka yang dipindahkan dari HPP.
- Saat selesai, **HPP rata-rata produknya wajib dihitung ulang** dengan rumus
  yang sama seperti barang masuk biasa. Barang ini kembali dengan modal berbeda
  karena biaya kemasan barunya menempel; melewatkannya membuat nilai persediaan
  di neraca berbeda dari stok dikali HPP, dan selisihnya tidak akan pernah bisa
  dijelaskan.
- Biaya label dan kemasan baru **menempel ke HPP barangnya**, bukan menjadi
  beban terpisah — kalau tidak, margin barang itu tampak lebih besar daripada
  kenyataan.

### Rekonsiliasi bank

Mencocokkan rekening koran dengan jurnal — bukan menggantikan jurnal.

- Kecocokan hanya diterima kalau **nilainya persis sama** dan tanggalnya dalam
  toleransi ±3 hari.
- Kalau calon pasangannya **lebih dari satu, menyerah** dan menyerahkannya ke
  orang. Memilih salah satu secara sembarang menghasilkan pembukuan yang
  terlihat rapi tetapi menunjuk transaksi yang keliru — dan itu jauh lebih
  sulit ditemukan daripada baris yang jujur belum cocok.
- Baris yang ada di koran tetapi tidak ada di jurnal adalah **temuan**, bukan
  galat: biasanya biaya admin bank atau bunga yang memang belum dicatat.

### Saran pembelian

- **Tidak pernah menyarankan barang yang tidak laku.** Produk berstatus diam
  bukan kekurangan stok — membelinya lagi justru menambah modal menganggur.
- Barang yang **sudah dipesan tetapi belum datang dikurangkan** dari sarannya,
  kalau tidak barang yang sama dipesan dua kali.
- Waktu tunggu dihitung dari **riwayat penerimaan yang sesungguhnya**, bukan
  angka tetap yang ditebak.

### Analisis pelanggan

- Identitas pembeli disusun dari nomor telepon dulu, baru nama yang
  dinormalkan. Kalau data yang ada memang tidak lengkap, **katakan
  keterbatasannya di layar** — angka pelanggan berulang yang dihitung dari nama
  saja bisa menggabungkan dua orang berbeda.
- Marketplace menuliskan **nama hub sortirnya sendiri** di kolom pembeli
  ("Semarang RDC - Pengiriman SPX"). Satu hub muncul ratusan kali dan menjadi
  "pelanggan berulang" terbesar kalau dibiarkan.
  - Dikecualikan lewat daftar kata penanda yang **bisa diubah dari layar**,
    karena tiap marketplace menamai hubnya sendiri-sendiri dan namanya berganti
    tanpa memberi tahu siapa pun.
  - Dicocokkan sebagai **kata utuh**, bukan potongan huruf. "RDC" sebagai
    potongan ikut mengenai nama orang, dan pelanggan sungguhan yang lenyap dari
    daftar jauh lebih merugikan daripada satu hub yang lolos.
  - Penanda satu huruf **ditolak** — ia akan mengenai hampir semua nama, dan
    pemakainya baru sadar setelah daftar pelanggannya nyaris kosong.
  - Yang dikecualikan **tetap ditampilkan** beserta jumlah, order, dan omzetnya.
    Angka yang hilang tanpa penjelasan lebih meresahkan daripada angka yang
    salah — orang akan menghabiskan waktu mencarinya.

---

## 9. Fitur Lintas Modul

### Ekspor terpadu
Satu helper `daftarkanEkspor(router, { path, judul, kolom, ambil })` memasang
endpoint CSV / Excel / PDF sekaligus untuk sebuah daftar. PDF-nya otomatis
berkop perusahaan (logo, nama, alamat), bernomor halaman "Halaman N dari M".

Kolom yang disembunyikan karena izin **tidak boleh ikut terunduh** — batasan
yang hanya berlaku di layar bukan batasan sama sekali.

### Tanda tangan digital
Dokumen resmi (slip gaji, nota, laporan) memuat QR yang mengarah ke halaman
verifikasi publik. Alamatnya diambil dari pengaturan `app_url`, jadi QR yang
sudah tercetak tetap sah setelah pindah domain.

### Pencadangan
Cadangan otomatis berkala + unduh manual. Dua cadangan dalam detik yang sama
diberi imbuhan urutan, supaya tidak saling menimpa.

### Jejak perubahan
Satu middleware di `/api` mencatat siapa mengubah apa, kapan, dari nilai apa
ke nilai apa. Nama modul diambil dari jalur URL **setelah** segmen `api` —
kalau tidak, seluruh baris jejak bermodul "api" dan tidak berguna sama sekali.

### Latar halaman masuk
Gambar diunggah pemilik lewat Pengaturan (maks. 8, JPG/PNG/WebP/GIF, 3 MB),
berganti perlahan dengan cross-fade. Bila belum ada yang diunggah, dipakai
pemandangan buatan CSS — halaman masuk tidak boleh pernah tampak rusak hanya
karena satu berkas hilang.

> **Catatan teknis:** widget unggah tidak boleh menyeragamkan semua gambar
> menjadi JPEG. WebP yang dipaksa jadi JPEG justru membengkak, dan GIF bergerak
> yang digambar ke kanvas kehilangan animasinya.

---

## 10. Keamanan

### Kebijakan kata sandi
- Minimal 8 karakter, wajib ada huruf besar, huruf kecil, angka, dan simbol.
- Wajib diganti pada masuk pertama, setelah direset pengelola, dan tiap 90 hari.
- Ditegakkan **di dalam `requireAuth`**: selama kewajiban belum dipenuhi,
  seluruh API menjawab 403 dan hanya halaman akun sendiri yang terbuka.
- Kata sandi baru tidak boleh sama dengan yang lama.

> **Saat memasang di aplikasi yang sudah berjalan:** kolom umur kata sandi
> awalnya kosong untuk semua akun lama, yang berarti seluruh tim mendadak
> terkunci begitu pembaruan terpasang. Migrasinya **wajib** mengisi umur itu
> dari tanggal akun dibuat.

### Lain-lain
- Sesi JWT, kata sandi di-hash bcrypt.
- Pembatasan percobaan login (rate limit).
- Helmet, CORS, batas ukuran badan permintaan 8 MB.
- Berkas unggahan hanya bisa diakses setelah login — kecuali logo dan latar
  halaman masuk, yang memang perlu tampil sebelum siapa pun masuk.
- Berkas rahasia (`.env`, catatan akses, database) **wajib** masuk `.gitignore`.

---

## 11. Ketentuan Tampilan

- **Tema terang & gelap**, mengikuti perangkat atau dipilih manual.
- **Responsif**, tabel lebar bergulir sendiri di dalam wadahnya.
- **Angka rupiah penuh** (lihat aturan 3.9).
- **Lencana kanal** memakai warna merek yang dikenali orang dari aplikasi
  marketplace-nya, supaya satu baris bisa dikenali tanpa membaca tulisannya:
  Shopee oranye tajam · TikTok hitam tajam · Lazada pink tajam · Tokopedia hijau
  army · Offline/WA hijau · Website biru. Semua bertulisan putih.
- **Lencana status** hijau hanya untuk yang uangnya sudah benar-benar diterima.
- **Kolom pencarian wajib ada di seluruh submenu Penjualan.**
- **Formulir ubah wajib bisa mengubah tanggal**, diletakkan di kiri paling atas.
- Menghormati `prefers-reduced-motion` untuk animasi latar.

---

## 12. Pengujian

Dua rangkaian uji yang dijalankan terhadap peladen sungguhan:

```bash
npm run smoke            # 855 pemeriksaan, 59 bagian
npm run smoke:features   # 29 pemeriksaan alur ujung-ke-ujung
npm run cek:ikon         # tiap ikon menu benar-benar diimpor
```

### Aturan menulis uji

1. **Selalu jalankan terhadap database kosong yang baru.** Menjalankan dua kali
   di database yang sama membuat uji berbasis nilai mutlak gagal karena datanya
   menumpuk — dan kelihatan seperti bug padahal bukan.
2. **Uji akibat, bukan hanya respons.** Setelah mengubah tanggal order, periksa
   laba rugi bulan lama **dan** bulan baru, tanggal mutasi stok, dan
   keseimbangan neraca. Endpoint yang menjawab `{ok:true}` sambil merusak
   pembukuan adalah kegagalan yang paling mahal.
3. **Jangan pakai tanggal hari ini sebagai batas jendela laporan.** Uji
   penggajian pernah gagal setiap tanggal 1 karena gaji jatuh tempo tanggal 25,
   di luar jendela "awal bulan sampai hari ini".
4. **Setiap perbaikan bug ditemani satu uji** yang gagal sebelum perbaikan.
5. **Uji tidak menggantikan membuka halamannya.** Uji asap berbicara dengan
   API, bukan dengan layar. Satu ikon menu yang lupa diimpor pernah membuat
   seluruh aplikasi di produksi layar putih total — build lulus, 611 pemeriksaan
   lulus, dan tidak ada satu pun yang menyadarinya. Sejak itu: `npm run cek:ikon`
   berjalan sebelum penyebaran, dan setiap halaman baru DIBUKA di peramban
   beserta konsolnya sebelum kode didorong.

---

## 13. Penyebaran

```
Hostinger (atau VPS mana pun) + Node.js 20
Auto-deploy dari GitHub: push ke main → build diverifikasi → webhook deploy
```

**Wajib:**
- Database di luar folder aplikasi: `/home/<user>/erp-data/erp.db`
- Folder unggahan juga di luar: `/home/<user>/erp-data/uploads`
- Isi `.env`: `JWT_SECRET`, `DATABASE_URL`, `UPLOAD_DIR`, `SEED_ADMIN_EMAIL`,
  `SEED_ADMIN_PASSWORD`, `PORT`
- **Jangan pernah** menjalankan perintah penyemaian data contoh terhadap
  database produksi.

---

## 14. Prompt Bertahap (Salin Satu per Satu)

Tempel satu tahap, tunggu selesai dan diuji, baru lanjut ke tahap berikutnya.

---

### TAHAP 0 — Fondasi

```
Bangun aplikasi ERP internal berbahasa Indonesia untuk usaha dagang
multi-kanal, dengan tumpukan: Node.js 20 + Express 4 + better-sqlite3 di
peladen, React 18 + Vite 5 + Tailwind 3 di klien. Validasi masukan memakai
Zod, sesi memakai JWT, kata sandi di-hash bcrypt.

Buat kerangkanya lebih dulu:
1. Struktur folder: server.js, src/{routes,db,utils,middleware}, client/src/{pages,components,lib}
2. src/db/index.js — koneksi better-sqlite3, jalur database dari DATABASE_URL,
   helper getSetting/setSetting dan nextNumber untuk penomoran dokumen.
3. src/db/schema.sql + src/db/migrate.js — migrasi yang HANYA MENAMBAH dan
   aman dijalankan berulang kali (cek kolom ada atau belum, baru tambahkan).
   Tidak ada DROP, tidak ada perubahan tipe.
4. src/utils/http.js — pembungkus async handler, parse Zod, httpError, dateRange.
5. Autentikasi: login, /me, requireAuth, JWT.
6. Klien: kerangka React Router, tata letak dengan sidebar, tema terang/gelap
   (Tailwind darkMode:'class'), halaman Login.

SEMUA antarmuka, pesan galat, dan komentar kode memakai bahasa Indonesia.
Komentar menjelaskan KENAPA sebuah keputusan diambil, bukan mengulang apa
yang sudah terbaca dari kodenya.

Jangan tanam data contoh apa pun. Nama bisnis, produk, toko, dan supplier
semuanya diisi manual lewat layar nanti.
```

---

### TAHAP 1 — Pembukuan Berpasangan (fondasi semua angka)

```
Tambahkan modul keuangan berpasangan. Ini fondasi seluruh angka di aplikasi,
jadi kerjakan sebelum modul lain.

1. Tabel: accounts, journals, journal_lines, period_locks.
2. src/db/coa.js — 39 akun standar usaha dagang: 10 aset, 5 kewajiban,
   3 ekuitas, 4 pendapatan, 17 beban. Tiap akun punya kode, nama, tipe,
   penanda arus kas, saldo normal (D/K), dan penanda is_system.
   Akun is_system tidak bisa dihapus.
3. src/utils/accounting.js dengan DUA SATU-SATUNYA PINTU ke buku besar:
   - postJournal({date, description, lines, source, sourceId, userId})
   - deleteJournalsBySource(source, sourceId)
   Keduanya WAJIB menolak jika debit != kredit, dan menolak penulisan ke
   periode yang sudah dikunci di period_locks.
   TIDAK BOLEH ada INSERT ke journal_lines di tempat lain, sama sekali.
4. Laporan: neraca, laba rugi, arus kas, neraca saldo, buku besar.
5. Halaman klien: Chart of Accounts, Buku Besar & Jurnal, Laporan Keuangan.

Tulis uji yang membuktikan: jurnal tidak seimbang ditolak, penulisan ke
periode terkunci ditolak, dan neraca saldo selalu seimbang.
```

---

### TAHAP 2 — Peran & Hak Akses

```
Tambahkan sistem peran sebelum modul lain, supaya tiap modul baru bisa langsung
memasang izinnya.

1. Tabel roles (dengan kolom seeded_json), role_permissions.
2. src/utils/izin.js — katalog 39 izin dikelompokkan per modul, dan 5 peran
   bawaan: Admin (semua), Manajer, Tim CS/Admin Marketplace, Tim Konten, Tim Gudang.
3. Penyemaian peran yang aman terhadap pembaruan:
   - Peran yang izinnya masih sama persis dengan seeded_json (belum pernah
     disesuaikan pemilik) disegarkan mengikuti daftar bawaan terbaru.
   - Peran yang sudah disesuaikan dibiarkan utuh, hanya dilaporkan.
   - Admin SELALU menerima seluruh izin termasuk yang baru — kalau tidak,
     memasang menu baru justru mengunci pemiliknya sendiri.
4. middleware: requireAuth, butuhIzin(izin), dan halaman(...izin) untuk dipasang
   di titik mount router — BUKAN disebar di tiap endpoint.
5. Di klien: menu yang izinnya tidak dipegang tidak ditampilkan. Tapi
   penyembunyian di layar bukan pengamanan — API-nya harus menolak juga.

Uji: tiap peran hanya bisa membuka modulnya, dan ditolak 403 di modul lain.
```

---

### TAHAP 3 — Gudang

```
Modul gudang:
1. Tabel: products (SKU, nama, kategori, satuan, HPP, harga jual, stok, stok
   minimum, needs_variant), stock_moves (IN/OUT/ADJ, balance_after, sumber),
   stock_opnames, stock_opname_lines, product_variants.
2. Master Produk — CRUD, unggah foto, penanda "dijual tanpa label" untuk produk
   yang butuh katalog varian.
3. Mutasi Stok — kartu stok masuk/keluar/penyesuaian. Setiap mutasi menulis
   balance_after, supaya kartu stok bisa dibaca tanpa menghitung ulang.
   Mutasi masuk yang dibeli tunai/kredit ikut menulis jurnal lewat postJournal.
4. Stok Opname — hitung fisik, tampilkan selisih, penyesuaian otomatis beserta
   jurnalnya.
5. Valuasi Stok — nilai persediaan, potensi pendapatan & laba, daftar stok menipis.
6. Kinerja Produk — laku/tidak laku, modal menganggur, margin per produk.
7. Koreksi Stok langsung dari layar Ubah Produk — membetulkan angka stok yang
   keliru tanpa mengarang mutasi masuk/keluar. JANGAN menimpa products.stock
   begitu saja: catat sebagai mutasi ADJ dengan alasan WAJIB, plus jurnal
   Persediaan lawan Selisih Stok, sama seperti selisih opname. Menimpanya
   diam-diam membuat kartu stok tidak bisa menjelaskan angka barunya dan
   membuat neraca berbeda dari valuasi gudang tanpa tanda apa pun.

Nilai persediaan di neraca WAJIB sama dengan valuasi stok gudang. Tulis uji
yang membandingkan keduanya.
```

---

### TAHAP 4 — Penjualan (modul terbesar)

```
Modul penjualan multi-kanal:
1. Tabel: sales_orders, sales_items, sales_item_variants, sales_returns, shops.
2. Kanal: Shopee, Tokopedia, TikTok Shop, Lazada, Offline/WA, Social Media, Website.
3. Formulir order — kolom berurutan: Tanggal (kiri paling atas), Channel,
   Toko, Nama pembeli, No. pesanan, Resi/kode booking, lalu detail pesanan.
4. Struktur biaya order (semua rupiah, HANYA pajak yang persen):
   Diskon Penjual (Rp), Voucher & Subsidi, Biaya Platform, Biaya Gratis Ongkir
   XTRA, Biaya Layanan, Pajak (%), Biaya Packing (Rp), Biaya Kirim Non MP (Rp),
   Biaya Lain (Rp).
   PERHATIAN pada Biaya Kirim Non MP: namanya "biaya" mengikuti sebutan tim
   sehari-hari, tetapi perlakuannya KEBALIKANNYA. Ini ongkir yang ditagih ke
   pembeli di luar marketplace dan ikut ditransfer ke rekening bersama nilai
   ordernya, jadi ia MENAMBAH penerimaan. Ia TIDAK boleh masuk omzet (bukan
   hasil menjual barang) dan TIDAK boleh masuk laba (uangnya diteruskan ke
   ekspedisi). Di jurnal dikreditkan ke akun pendapatannya sendiri, bukan
   digabung ke akun Penjualan.
5. Status pesanan di SATU berkas bersama (src/utils/status-pesanan.js), beserta
   KELOMPOKNYA: mana yang berarti dananya sudah masuk, mana barangnya kembali,
   mana masih berjalan. Semua pemeriksaan "sudah selesai belum" memakai
   kelompok itu, JANGAN menulis === 'CAIR' langsung di mana pun.
   Status: Diproses, Dikirim, Selesai, Cair, Retur, Batal.
6. Menyimpan order = satu transaksi database yang sekaligus: mengurangi stok,
   menulis mutasi stok, dan menulis jurnal lewat postJournal.
7. Mengubah order = HAPUS jurnalnya lalu TULIS ULANG seluruhnya, bukan ditambal.
   Mengubah tanggal order wajib ikut memindahkan tanggal jurnal DAN tanggal
   mutasi stoknya.
8. Papan Pengiriman — kanban per tahap, ubah status massal.
9. Pencairan Dana — dana marketplace yang belum cair beserta rekonsiliasinya.
10. Kolom pencarian WAJIB ada di seluruh submenu Penjualan, dan pencariannya
    dikerjakan PELADEN (LIKE ... ESCAPE), bukan disaring di layar — baris di luar
    batas tampilan tidak akan pernah ketemu kalau disaring di layar.
11. Delapan kartu statistik dalam dua baris, tiap kartu berlatar warna berbeda.
12. Lencana kanal berwarna merek: Shopee oranye tajam, TikTok hitam tajam,
    Lazada pink tajam, Tokopedia hijau army, Offline/WA hijau, Website biru,
    semua bertulisan putih.

Uji: laba bersih = pendapatan bersih − HPP − biaya; neraca tetap seimbang
setelah order dibuat, diubah, dan dibatalkan; pembatalan mengembalikan stok.
```

---

### TAHAP 5 — Presensi & Penggajian

```
1. Tabel: attendance, offices, payrolls, payroll_items.
2. Absen Sekarang — selfie dari kamera + koordinat GPS, diperiksa terhadap
   radius geofence titik kantor. Tipe kerja: WFO, WFH, Dinas Luar.
   Status otomatis: Tepat Waktu / Terlambat, berdasarkan jam kerja dan
   toleransi di pengaturan.
3. Rekap Absensi — rekap per orang/periode, koreksi status, izin/cuti.
4. Penggajian — susun daftar gaji per periode dari gaji pokok di data tim.
   Angka gaji DIBEKUKAN saat daftar disusun: menaikkan gaji seseorang hari ini
   tidak boleh mengubah slip bulan lalu.
   Bisa diposting ke jurnal (beban gaji; utang gaji bila belum dibayar) dan
   dibatalkan postingnya tanpa kehilangan angkanya.
5. Slip gaji PDF berkop dengan QR verifikasi.
```

---

### TAHAP 6 — Pembelian, Mitra, Iklan, Target

```
1. Pesanan Pembelian — PO, no. faktur, jatuh tempo, tanggal bayar, penerimaan
   barang yang menambah stok dan menulis jurnalnya.
2. Supplier & Pelanggan (partners) — beserta utang/piutangnya.
3. Biaya Iklan per toko/kanal. Iklan yang dibayar dari saldo marketplace
   mengurangi piutang marketplace, BUKAN kas — bedanya nyata di arus kas.
   Hitung laba setelah iklan dan ROAS.
4. Target & Pencapaian — target omzet, laba, batas belanja iklan, beserta
   persentase pencapaiannya.
5. Rekening Kas & Bank, Kas Masuk & Keluar, Utang & Piutang, Proyeksi Arus Kas.
6. Pindah Saldo antar rekening sendiri — bank ke kas tunai, kas ke bank, antar
   bank. WAJIB satu jurnal (debit tujuan, kredit asal), bukan dua entri terpisah
   di Kas Masuk dan Kas Keluar: dua entri membuat total pemasukan dan pengeluaran
   bulan itu membengkak padahal tidak ada uang yang benar-benar mengalir keluar
   masuk. Sediakan juga deleteJournalById() — jurnal pemindahan tidak punya
   dokumen induk, jadi menghapusnya lewat source_id yang kosong akan menyapu
   SELURUH pemindahan sekaligus.
```

---

### TAHAP 7 — Dashboard & Pusat Perhatian

```
1. Dashboard — realtime hari ini (penjualan, laba, laba setelah iklan, nilai
   stok, kehadiran), ringkasan periode, grafik tren, kinerja per kanal dan
   produk, ringkasan keuangan.
2. Pusat Perhatian — hal yang perlu ditindak: stok menipis, dana lama belum
   cair, faktur jatuh tempo, modal menganggur, kejanggalan data.
3. SEMUA angka rupiah ditulis PENUH: "Rp 2.018.000", BUKAN "Rp 2,02 jt".
   Termasuk label sumbu grafik — lebarkan sumbunya (116px, bukan 76px) supaya
   angkanya muat utuh.
```

---

### TAHAP 8 — Laporan Resmi

```
Enam laporan berkop: Presensi, Persediaan, Pembelian, Penjualan, Keuangan, Mitra.
- Bisa diunduh CSV / Excel / PDF / cetak, ukuran A4 atau Folio.
- PDF berkop perusahaan (logo, nama, alamat) dan bernomor "Halaman N dari M".
- Tanda tangan digital ber-QR yang mengarah ke halaman verifikasi publik.
  Alamat QR diambil dari pengaturan app_url, supaya QR yang sudah tercetak
  tetap sah setelah pindah domain.
- Terkunci per peran: tim hanya melihat laporan modul yang dipegangnya.
- Kolom yang disembunyikan karena izin TIDAK BOLEH ikut terunduh.

ATURAN PALING PENTING: tiap laporan WAJIB memanggil fungsi agregat yang SAMA
dengan menu aslinya, bukan query sendiri. Tulis uji yang membandingkan angka
Laporan Penjualan dengan menu Order Penjualan, dan Laporan Persediaan dengan
valuasi stok gudang.
```

---

### TAHAP 9 — Sistem & Keamanan

```
1. Pengaturan — profil perusahaan (nama, tagline, alamat, telepon, email, NPWP,
   website, logo, app_url), jam kerja & toleransi terlambat, titik kantor
   (geofence), data tim, peran & hak akses.
2. Akun Saya — terbuka untuk SEMUA peran tanpa izin tambahan, isinya HANYA
   foto diri (wajib, dari unggah/kamera) dan ganti kata sandi. Nama, email,
   peran, dan jabatan hanya ditampilkan — mengubahnya berarti mengubah
   identitas dan hak akses, dan itu urusan pengelola tim.
3. Kebijakan kata sandi: minimal 8 karakter dengan huruf besar, huruf kecil,
   angka, dan simbol. Wajib diganti pada masuk pertama, setelah direset
   pengelola, dan tiap 90 hari.
   DITEGAKKAN DI DALAM requireAuth: selama kewajiban belum dipenuhi, seluruh
   API menjawab 403 dan hanya halaman akun sendiri yang terbuka. Menyembunyikan
   menu di layar saja tidak cukup.
   Kata sandi baru tidak boleh sama dengan yang lama.
4. Tombol "Wajibkan Ganti Sandi" untuk seluruh tim sekaligus. Kata sandinya
   TIDAK diacak — mengacak kata sandi belasan orang serentak berarti mereka
   tidak bisa bekerja sampai ada yang membagikan yang baru satu per satu.
   Yang lama tetap dipakai masuk, lalu ditahan di halaman akun sampai diganti.
   Akun yang menekan tombol dikecualikan.
5. Jejak Perubahan — satu middleware di /api mencatat siapa mengubah apa,
   kapan, dari nilai apa ke nilai apa. Nama modul diambil dari jalur URL
   SETELAH segmen "api", kalau tidak seluruh jejak bermodul "api".
6. Tutup Buku — kunci periode per bulan, bisa dibuka lagi dan tercatat.
   Daftar periodenya gabungan bulan yang ada jurnalnya DAN bulan yang terkunci —
   kalau tidak, periode terkunci yang belum ada jurnalnya tidak bisa dibuka lagi.
7. Pencadangan otomatis berkala + unduh manual. Dua cadangan dalam detik yang
   sama diberi imbuhan urutan supaya tidak saling menimpa.
8. Latar halaman masuk — pemilik mengunggah sampai 8 gambar (JPG/PNG/WebP/GIF,
   maks 3 MB) lewat Pengaturan, berganti perlahan dengan cross-fade dan gerakan
   Ken Burns. Bila belum ada yang diunggah, pakai pemandangan buatan CSS.
   Widget unggah HARUS mempertahankan bentuk berkasnya: WebP tetap WebP (kalau
   dipaksa jadi JPEG justru membengkak), GIF dikirim apa adanya (kalau digambar
   ke kanvas, animasinya hilang).
```

---

### TAHAP 10 — Pengujian & Penyebaran

```
1. Buat scripts/smoke-test.js — rangkaian uji terhadap peladen sungguhan,
   dikelompokkan per modul, dijalankan dengan `npm run smoke`.
   Aturan menulisnya:
   - SELALU dijalankan terhadap database kosong yang baru.
   - Uji AKIBATNYA, bukan hanya respons: setelah mengubah data, periksa juga
     laporan, kartu stok, dan keseimbangan neraca.
   - JANGAN memakai tanggal hari ini sebagai batas jendela laporan — uji akan
     gagal di tanggal tertentu saja, dan itu sangat membingungkan.
   - Tiap perbaikan bug ditemani satu uji yang gagal sebelum perbaikan.
2. Buat scripts/smoke-features.js untuk alur ujung-ke-ujung.
3. Buat scripts/cek-ikon.js — memeriksa tiap ikon yang dipakai menu benar-benar
   diimpor. Build TIDAK menangkap ini: identifier yang tidak ada bukan galat
   sintaks, ia baru meledak saat halaman dibuka dan hasilnya LAYAR PUTIH TOTAL.
   Uji asap pun tidak menangkapnya karena ia berbicara dengan API, bukan
   membuka halaman.
4. SEBELUM setiap penyebaran, BUKA halaman yang baru dibuat di peramban dan
   periksa konsolnya. Build lulus dan uji lulus tidak berarti halamannya bisa
   dibuka.
3. Penyebaran: GitHub Actions memverifikasi build, lalu webhook deploy.
   Database dan folder unggahan WAJIB di luar folder aplikasi supaya tidak
   terhapus saat kode diperbarui.
   .gitignore WAJIB memuat .env, berkas database, dan catatan akses.
   JANGAN PERNAH menjalankan penyemaian data contoh terhadap database produksi.
```

---

### TAHAP 11 — Pelengkap Operasional

```
Dibangun paling akhir karena semuanya membaca data yang sudah ada, bukan
membuat data baru. Jangan dikerjakan sebelum penjualan dan pembelian benar.

1. Saran Pembelian — barang yang perlu dibeli beserta jumlah dan perkiraan
   dananya, dihitung dari kecepatan penjualan dan waktu tunggu supplier yang
   diambil dari riwayat penerimaan sesungguhnya.
   JANGAN menyarankan produk yang tidak laku — itu bukan kekurangan stok,
   melainkan modal menganggur yang akan bertambah.
   Barang yang sudah dipesan tetapi belum datang WAJIB dikurangkan, kalau tidak
   barang yang sama dipesan dua kali.

2. Retur Pembelian — barang dikembalikan ke supplier. Stok berkurang lewat
   jalur pengeluaran yang sama dengan penjualan (batch ikut terpotong FEFO),
   dan pembukuannya menyesuaikan.
   Perlakuannya DIPILIH ORANGNYA, bukan ditebak dari status pembayaran PO:
   potong utang (debit Utang Usaha) atau dana kembali (debit kas), keduanya
   mengkredit Persediaan.
   Tolak mengembalikan lebih banyak daripada stok yang ada.

3. Rekonsiliasi Bank — unggah rekening koran, cocokkan dengan jurnal.
   Hanya cocok bila nilainya PERSIS sama dan tanggalnya dalam toleransi 3 hari.
   Bila calonnya lebih dari satu, MENYERAH dan serahkan ke orang — tebakan yang
   salah menghasilkan pembukuan yang terlihat rapi tetapi menunjuk transaksi
   keliru, dan itu jauh lebih sulit ditemukan daripada baris yang belum cocok.

4. Analisis Pelanggan — pembeli berulang, nilai seumur hidup, sebaran kota.
   Identitas disusun dari nomor telepon dulu, baru nama yang dinormalkan.
   Periksa DULU kelengkapan data pembelinya sebelum membangun layarnya; kalau
   nomor teleponnya jarang terisi, katakan keterbatasan itu di layar alih-alih
   menyajikan angka yang terdengar pasti.
```

---

## 15. Daftar Periksa Sebelum Dipakai Tim

- [ ] Profil perusahaan & logo terisi di Pengaturan
- [ ] `app_url` diisi alamat produksi (dipakai QR pada dokumen)
- [ ] Titik kantor & radius geofence disetel
- [ ] Jam kerja dan toleransi terlambat disetel
- [ ] Akun admin pertama sudah ganti kata sandi
- [ ] Karyawan dibuatkan akun dan diberi peran
- [ ] Produk dimasukkan beserta HPP dan harga jualnya
- [ ] Toko / akun marketplace dimasukkan
- [ ] Supplier & pelanggan dimasukkan
- [ ] Stok awal dimasukkan lewat Mutasi Stok (tipe IN)
- [ ] Saldo awal kas & modal dimasukkan lewat Jurnal
      (JANGAN dilewati: tanpa saldo awal, setiap pembayaran tampak keluar dari
      nol dan saldo rekening menjadi minus meski uangnya sebenarnya ada)
- [ ] Neraca diperiksa: **seimbang**
- [ ] Nilai persediaan di neraca cocok dengan valuasi stok gudang
- [ ] Pencadangan otomatis menyala dan berkasnya benar-benar terbentuk
- [ ] Latar halaman masuk diunggah (opsional)
- [ ] Uji coba satu order penuh: buat → kirim → cair, lalu periksa jurnalnya

---

## 16. Kesalahan yang Sudah Pernah Terjadi

Daftar ini ada supaya tidak terulang di duplikasinya.

| Kesalahan | Akibatnya |
|---|---|
| Menyaring pencarian di layar, bukan di peladen | Baris di luar batas tampilan tidak pernah ketemu; pemakai menyimpulkan datanya hilang |
| Menulis `=== 'CAIR'` langsung, bukan lewat kelompok status | Menambah status baru membuat dana yang sudah cair terus dihitung tertahan, tanpa pesan galat |
| Tanggal mutasi stok tidak ikut pindah saat tanggal order dibetulkan | Kartu stok menunjukkan barang keluar di hari yang salah; valuasi per tanggal meleset |
| Kolom umur kata sandi dibiarkan kosong saat migrasi | Seluruh tim mendadak terkunci di hari kerja, tanpa pemberitahuan |
| Laporan menghitung ulang dengan query sendiri | Angka laporan berbeda dari menunya, dan tidak ada yang tahu mana yang benar |
| Nama modul jejak diambil dari segmen URL pertama | Seluruh baris jejak bermodul "api", tidak berguna sama sekali |
| Kolom baru yang tidak dikirim ditulis sebagai kosong | Gaji pokok terhapus saat admin sekadar mengubah nomor telepon |
| Periode terkunci tanpa jurnal tidak muncul di daftar | Periodenya tidak bisa dibuka kembali |
| Dua cadangan dalam detik yang sama | Saling menimpa, satu cadangan hilang |
| Widget unggah menyeragamkan semua gambar jadi JPEG | WebP membengkak, GIF bergerak kehilangan animasi |
| Uji dijalankan dua kali di database yang sama | Uji berbasis nilai mutlak gagal karena data menumpuk — terlihat seperti bug |
| Jendela laporan uji berakhir di "hari ini" | Uji penggajian gagal tiap tanggal 1, karena gaji jatuh tempo tanggal 25 |
| Menghapus jurnal tanpa dokumen induk lewat `source_id` yang kosong | Satu klik "batal" menghapus SELURUH catatan sejenis |
| Ongkir non-marketplace digabung ke akun Penjualan | Omzet menggelembung dan tidak bisa dipisahkan lagi |
| Skrip pengganti massal memakai penanda sementara | Penanda tidak terpulihkan karena backslash regex termakan shell; sumbu grafik kehilangan formatternya dan menampilkan angka mentah — lolos build karena JSX menerima atribut apa pun |
| Saldo awal tidak pernah dimasukkan | Semua rekening minus meski uangnya ada; setiap pembayaran tampak keluar dari nol |
| Akun COA baru diberi kode arus kas di luar OCF/ICF/FCF/NONE | Peladen GAGAL START total saat penyemaian akun |
| Ikon menu dipakai tetapi lupa diimpor | SELURUH aplikasi di produksi layar putih, tanpa pesan apa pun — build lulus, uji lulus, karena keduanya tidak pernah membuka halamannya |
| Penjaga skrip penyunting memeriksa potongan teks yang justru baru saja ditambahkan | Penjaganya selalu "sudah ada", impornya tidak pernah ditambahkan |
| Jejak perubahan memakai `datetime('now')` (UTC) sementara aplikasi memakai waktu setempat | Perubahan pukul 00:00–07:00 tercatat di tanggal kemarin; halaman Riwayat tampak kosong padahal ada isinya |
| Menelan galat pencatatan jejak dengan `catch {}` kosong | Jejak berhenti tercatat tanpa ada yang tahu |
| Nilai tingkat peringatan yang tidak dikenal ditulis begitu saja | Hitungan dan urutan Pusat Perhatian salah diam-diam; baru ketahuan setelah butir kedua memakainya juga — beri penjaga yang MELEMPAR galat |
| Kolom unduhan diberi nama "Pendapatan Bersih" padahal isinya penjualan setelah diskon | Pada order tanpa diskon angkanya sama persis dengan penjualan kotor, dan pembacanya menyimpulkan biaya channel tidak ikut terhitung |
| Nilai penerimaan dihitung ulang sebagai qty × harga pesanan | Begitu harga sisa boleh diperbarui, layar menyebut nilai yang berbeda dari jurnalnya — simpan nilai yang benar-benar dibukukan di kolom sendiri |
| Kotak cari diletakkan jauh dari tabel yang disaringnya | Tidak ada yang menemukannya; pemakai melapor fiturnya belum ada padahal sudah lama terpasang |
| Nama parameter kueri yang salah dikirim ke peladen | Zod mengabaikannya diam-diam dan penyaringnya tidak berlaku — daftar supplier ikut memuat pelanggan |
| Laporan resmi tidak menyebut retur sama sekali | Seluruh angkanya adalah angka sebelum dikurangi barang yang dikembalikan — dan laporan itulah yang berkop, bertanda tangan, dan diserahkan ke pihak luar |
| Dampak retur pada laba disamakan dengan nilainya | Barang yang kembali ke stok mengembalikan HPP-nya; menyamakannya dengan barang rusak total membuat laba salah |
| Uji dijalankan berurutan pada satu peladen tanpa memperhitungkan batas laju login | Rangkaian kedua berhenti di login pertamanya, dikira brute force — CI merah berminggu-minggu tanpa ada yang benar-benar rusak |
| Retur dicatat tanpa memeriksa order asalnya | Barang yang tidak pernah dikirim ke pembeli itu tetap bisa diretur, dan satu order bisa diretur berkali-kali melebihi yang dikirim |
| Mengubah dokumen dikerjakan sebagai hapus-lalu-buat-baru | Id barisnya berganti tiap kali diubah, sehingga riwayat perubahannya putus dan tautan dari tabel lain menunjuk baris yang sudah tidak ada |
| Pemeriksaan sisa ikut menghitung baris yang sedang diubah | Mengubah retur 4 menjadi 2 ditolak dengan alasan barangnya sudah habis diretur |
| Rekening dianggap sama bila NAMANYA sama | Nama ditulis berbeda-beda; nomor rekening tidak pernah berubah — cocokkan lewat angka pada namanya |
| Seluruh penerimaan penjualan jatuh ke satu akun kas | Saldo aplikasi tidak akan pernah cocok dengan mutasi bank mana pun; uang order hampir tidak pernah masuk ke laci |
| Pengembalian dana retur dikreditkan ke kas tunai | Saldo tunai berkurang untuk uang yang tidak pernah ada di laci, sementara rekening toko yang benar-benar terpotong tetap tampak utuh |
| Rekening dihitung dua kali: sekali untuk baris order, sekali untuk jurnalnya | Keduanya bisa berbeda, dan jurnal yang menunjuk rekening lain dari ordernya adalah selisih yang tak terjelaskan — hitung sekali, pakai dua kali |
| Memilih rekening ikut memilih toko walau rekeningnya dipakai beberapa toko | Order tercatat ke toko yang keliru; tebak hanya bila pemakainya tunggal |
| Mencocokkan nomor rekening dengan kesamaan persis saja | Nama rekening kadang membawa angka lain, dan nomor yang ditulis sebagian jadi tidak dikenali — cocokkan juga secara memuat, tetapi terima hanya bila calonnya tunggal |
| Membatalkan order yang sudah punya retur tanpa membalik returnya | Barang yang sudah kembali lewat retur dikembalikan lagi oleh pembatalan — stok terhitung dua kali — dan jurnal retur mengurangi pendapatan dari penjualan yang sudah tidak ada |
| Tombol hapus massal yang langsung bekerja | Harus dua langkah: periksa akibatnya dulu (stok, saldo rekening, laba rugi), lalu ketik ulang jumlah ordernya |
| Formulir ubah mengisi rekening dari toko saat dibuka | Membetulkan resi diam-diam memindahkan uang ke rekening lain; isi otomatis hanya saat tokonya diganti atau lewat tombol yang ditekan sendiri |
| Formulir pembelian stok memilih Kas Tunai secara bawaan | Setiap pembelian yang dibayar transfer tercatat mengurangi uang tunai di laci; saldo Kas Tunai minus tanpa ada uang yang benar-benar hilang. Cara bayar harus dipilih sendiri |
| Uji asap dijalankan pada database yang sudah berisi data | Ratusan produk, order, dan jurnal tiruan tercampur ke data sungguhan dan tidak bisa dipisahkan lagi — sempat dipakai menganalisis data pemilik usaha. Uji kini berhenti sendiri bila databasenya tidak kosong |
| Database uji diletakkan di dalam folder data/ proyek | Cadangan otomatis tersimpan di sebelah databasenya, jadi cadangan hasil uji ikut bercampur dengan cadangan sungguhan. Letakkan database, cadangan, dan unggahan uji di folder sementara |
| Formulir pelunasan utang/piutang memilih rekening kas pertama secara bawaan | Pembayaran Rp 8,7 juta ke supplier yang ditransfer dari bank tercatat dari Kas Tunai; saldo awal Kas Tunai bulan berikutnya minus Rp 4,5 juta. Rekening harus dipilih sendiri, dan jurnal yang terlanjur salah dipindah lewat Buku Besar |
| Pembayaran utang dicatat sebesar nilai barang masuk yang salah harga | Utang tampak lunas, kas tampak berkurang Rp 8,7 juta padahal yang ditransfer Rp 6,36 juta; kesalahan harga tidak kelihatan karena utangnya sudah nol. Pembayaran harus dicocokkan dengan rekening koran, bukan dengan angka utang di layar |
| Menghapus satu bulan tanpa membawa sisa utang mitra | Pembayaran supplier tanggal 1 bulan berikutnya (untuk barang bulan yang dihapus) membuat Utang Usaha minus Rp 25 juta. Sisa utang/piutang bulan itu harus dibawa sebagai saldo awal |
| Hapus jurnal manual memakai DELETE langsung | Bulan yang sudah ditutup buku tetap bisa berubah dari satu tombol; semua penghapusan jurnal harus lewat pintu yang memeriksa kunci periode |
| Logika batch disebar ke tiap titik yang mengubah stok | Titik ke-sepuluh pasti terlewat; sisa batch berbeda dari stok tanpa pesan galat |

---

*Dokumen ini menggambarkan aplikasi sebagaimana adanya pada 11 September 2026.
Saat aplikasinya berkembang, perbarui dokumen ini bersamaan — panduan duplikasi
yang tertinggal dari kenyataan lebih menyesatkan daripada tidak ada panduan.*
