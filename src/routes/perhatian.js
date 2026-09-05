'use strict';
/**
 * Pusat Perhatian — apa yang perlu dikerjakan hari ini.
 *
 * Setiap sinyal di sini sebenarnya sudah ada di menunya masing-masing: dana yang
 * lama tertahan di Pencairan, barang habis di Kinerja Produk, rekening minus di
 * Rekening Kas & Bank. Masalahnya sinyal itu tersebar di tujuh layar dan hanya
 * ketahuan kalau ketujuhnya dibuka satu per satu. Yang paling sering terjadi
 * bukan salah membaca angkanya, melainkan tidak pernah membukanya.
 *
 * Angkanya TIDAK dihitung ulang di sini. Berkas ini memanggil fungsi yang sama
 * dengan yang dipakai menunya, supaya peringatan dan menu tidak pernah
 * menyebutkan dua angka yang berbeda untuk hal yang sama.
 *
 * Tiap butir membawa izin yang dibutuhkan untuk melihatnya, dan disaring
 * menurut izin pembacanya. Tim gudang tidak perlu tahu rekening mana yang
 * minus, dan halaman yang membocorkannya lewat peringatan akan membatalkan
 * pembatasan yang sudah dipasang di menunya.
 */
const express = require('express');
const { db } = require('../db');
const { requireAuth, izinPengguna } = require('../middleware/auth');
const { ah } = require('../utils/http');
const { r2 } = require('../utils/accounting');
const { todayLocal } = require('../utils/time');

const { ambilPencairan } = require('./pencairan');
const { ambilKinerja } = require('./kinerja');
const { rekeningKas } = require('./cashflow');
const { ambilPencapaian } = require('./target');
const { ambilKadaluarsa } = require('./inventory');
const { daftar: daftarPembelian } = require('./pembelian');
const { daftarCadangan } = require('../utils/cadangan');

const router = express.Router();
router.use(requireAuth);

/** Urutan mendesak: yang di atas dikerjakan lebih dulu. */
const TINGKAT = { genting: 0, perhatian: 1, kabar: 2 };

/**
 * Permintaan tiruan untuk fungsi agregat yang menerima req.
 *
 * Fungsi-fungsi itu membaca penyaring dari query. Di sini tidak ada penyaring
 * yang sedang aktif, jadi yang dikirim adalah query kosong — nilai bawaannya
 * yang berlaku, sama seperti saat menunya baru dibuka.
 */
const permintaan = (req, query = {}) => ({
  query,
  user: req.user,
  protocol: req.protocol,
  get: (h) => req.get(h),
});

/** Selisih jam antara sekarang dan sebuah waktu ISO. */
const jamSejak = (iso) => (Date.now() - new Date(iso).getTime()) / 3600000;

function kumpulkan(req) {
  const izin = izinPengguna(req.user);
  const boleh = (...k) => k.some((x) => izin.has(x));
  const butir = [];
  const gagal = [];

  /** Menambahkan satu butir bila pembacanya memang berhak melihatnya. */
  const tambah = (b) => {
    if (b.izin && !boleh(...[].concat(b.izin))) return;
    butir.push(b);
  };

  /**
   * Satu sumber yang bermasalah tidak boleh menjatuhkan seluruh halaman.
   * Layar ini justru dibuka saat ada yang tidak beres; ia harus tetap
   * menampilkan sisanya dan menyebut bagian mana yang gagal dibaca.
   */
  const coba = (nama, fn) => {
    try {
      fn();
    } catch (err) {
      gagal.push({ sumber: nama, pesan: err.message });
    }
  };

  // ---- Dana marketplace yang lama tertahan ----
  coba('pencairan', () => {
    if (!boleh('penjualan.lihat')) return;
    const d = ambilPencairan(permintaan(req));

    if (d.ringkas.perluDitanya > 0) {
      tambah({
        kunci: 'dana-tertahan',
        tingkat: d.ringkas.umurTertua > 30 ? 'genting' : 'perhatian',
        judul: `${d.ringkas.perluDitanya} order dananya tertahan lebih dari 14 hari`,
        rincian:
          `Senilai ${d.ringkas.nilaiPerluDitanya.toLocaleString('id-ID')} rupiah. ` +
          `Yang tertua sudah ${d.ringkas.umurTertua} hari, sementara rata-rata pencairan Anda ${d.ringkas.cairRataHari} hari.`,
        nilai: d.ringkas.nilaiPerluDitanya,
        jumlah: d.ringkas.perluDitanya,
        tautan: '/penjualan/pencairan',
        tombol: 'Lihat Pencairan',
        izin: 'penjualan.lihat',
      });
    }

    if (!d.rekonsiliasi.cocok) {
      tambah({
        kunci: 'pencairan-selisih',
        tingkat: 'genting',
        judul: 'Piutang marketplace tidak cocok dengan buku besar',
        rincian: `Selisih ${Math.abs(d.rekonsiliasi.selisih).toLocaleString('id-ID')} rupiah yang belum bisa dijelaskan.`,
        nilai: Math.abs(d.rekonsiliasi.selisih),
        tautan: '/penjualan/pencairan',
        tombol: 'Periksa',
        izin: 'penjualan.lihat',
      });
    }

    if (d.ringkas.takSejalan > 0) {
      tambah({
        kunci: 'penanda-janggal',
        tingkat: 'kabar',
        judul: `${d.ringkas.takSejalan} order status bayar dan tanggal cairnya tidak sejalan`,
        rincian: 'Tidak merusak pembukuan, tetapi membuat laporan umur dana keliru.',
        jumlah: d.ringkas.takSejalan,
        tautan: '/penjualan/pencairan',
        tombol: 'Lihat',
        izin: 'penjualan.lihat',
      });
    }
  });

  // ---- Stok ----
  coba('kinerja', () => {
    if (!boleh('gudang.kinerja')) return;
    const d = ambilKinerja(permintaan(req), { tanpaLaba: !izin.has('penjualan.margin') });

    const habis = d.rows.filter((r) => r.golongan === 'habis');
    if (habis.length > 0) {
      tambah({
        kunci: 'stok-habis',
        tingkat: 'genting',
        judul: `${habis.length} produk laku tapi stoknya habis`,
        // Order yang batal karena barang kosong tidak tercatat di mana pun,
        // jadi kerugiannya tidak akan muncul di laporan mana pun juga.
        rincian: `Penjualan yang hilang karenanya tidak tercatat di laporan mana pun. Teratas: ${habis.slice(0, 3).map((r) => r.name).join(', ')}.`,
        jumlah: habis.length,
        tautan: '/gudang/kinerja',
        tombol: 'Lihat Kinerja Produk',
        izin: 'gudang.kinerja',
      });
    }

    const menipis = d.rows.filter((r) => r.golongan === 'menipis');
    if (menipis.length > 0) {
      tambah({
        kunci: 'stok-menipis',
        tingkat: 'perhatian',
        judul: `${menipis.length} produk cukup untuk ${d.ambang.menipis} hari lagi atau kurang`,
        rincian: `Tercepat habis: ${menipis.slice(0, 3).map((r) => `${r.name} (${r.cover_hari} hari)`).join(', ')}.`,
        jumlah: menipis.length,
        tautan: '/gudang/kinerja',
        tombol: 'Pesan Ulang',
        izin: 'gudang.kinerja',
      });
    }

    if (d.ringkas.modalTertahan > 0) {
      tambah({
        kunci: 'modal-diam',
        tingkat: 'kabar',
        judul: `${d.ringkas.modalTertahan.toLocaleString('id-ID')} rupiah menganggur di ${d.ringkas.diam} produk`,
        rincian: `Barang yang tidak bergerak lebih dari ${d.ambang.mati} hari. Uangnya tertahan di rak, bukan di kas.`,
        nilai: d.ringkas.modalTertahan,
        jumlah: d.ringkas.diam,
        tautan: '/gudang/kinerja',
        tombol: 'Lihat',
        izin: 'gudang.kinerja',
      });
    }
  });

  // ---- Rekening ----
  coba('rekening', () => {
    if (!boleh('keuangan.lihat')) return;
    const d = rekeningKas(permintaan(req));
    const minus = d.rows.filter((a) => a.minus);
    for (const a of minus) {
      tambah({
        kunci: `rekening-minus-${a.code}`,
        tingkat: 'genting',
        judul: `${a.name} bersaldo minus ${Math.abs(a.saldo).toLocaleString('id-ID')} rupiah`,
        rincian: 'Kas atau bank tidak mungkin minus secara fisik. Biasanya pengeluaran tercatat dari rekening yang salah.',
        nilai: a.saldo,
        tautan: '/keuangan/rekening',
        tombol: 'Telusuri',
        izin: 'keuangan.lihat',
      });
    }
  });

  // ---- Target bulan berjalan ----
  coba('target', () => {
    if (!boleh('target.lihat')) return;
    const d = ambilPencapaian(permintaan(req));
    const p = d.perusahaan;

    if (!p.punyaTarget) {
      tambah({
        kunci: 'target-kosong',
        tingkat: 'kabar',
        judul: `Target ${d.period} belum ditetapkan`,
        rincian: 'Realisasi berjalan tanpa pembanding, jadi tidak ada yang bisa dinilai tercapai atau tidak.',
        tautan: '/penjualan/target',
        tombol: 'Tetapkan Target',
        izin: 'target.kelola',
      });
    } else if (d.hari.berjalan && p.proyeksi.omzet !== null && p.target.omzet > 0
      && p.proyeksi.omzet < p.target.omzet) {
      tambah({
        kunci: 'target-tertinggal',
        tingkat: 'perhatian',
        judul: `Perkiraan omzet akhir bulan di bawah target`,
        rincian:
          `Bila laju ${d.hari.lewat} hari terakhir diteruskan, bulan ini ditutup di ` +
          `${p.proyeksi.omzet.toLocaleString('id-ID')} dari target ${p.target.omzet.toLocaleString('id-ID')} rupiah.`,
        nilai: r2(p.target.omzet - p.proyeksi.omzet),
        tautan: '/penjualan/target',
        tombol: 'Lihat Target',
        izin: 'target.lihat',
      });
    }

    const lewatIklan = d.rows.filter((r) => r.iklanLewatBatas);
    if (lewatIklan.length > 0) {
      tambah({
        kunci: 'iklan-lewat-batas',
        tingkat: 'perhatian',
        judul: `${lewatIklan.length} toko belanja iklannya melewati anggaran`,
        rincian: lewatIklan.slice(0, 3).map((r) => r.nama).join(', '),
        jumlah: lewatIklan.length,
        tautan: '/penjualan/target',
        tombol: 'Lihat',
        izin: 'target.lihat',
      });
    }
  });

  // ---- Pembelian ----
  // ---- Batch mendekati kadaluarsa ----
  // Ditaruh di sini, bukan hanya di halamannya sendiri: barang kedaluwarsa
  // adalah kerugian yang sudah terjadi dan tidak bisa ditarik kembali, jadi ia
  // harus menghampiri orangnya — bukan menunggu ada yang ingat membukanya.
  coba('kadaluarsa', () => {
    if (!boleh('gudang.lihat')) return;
    const d = ambilKadaluarsa({ query: { hari: 60 } });

    if (d.ringkas.kedaluwarsa.batch > 0) {
      tambah({
        kunci: 'batch-kedaluwarsa',
        tingkat: 'mendesak',
        judul: `${d.ringkas.kedaluwarsa.batch} batch sudah kedaluwarsa`,
        rincian:
          `Senilai ${d.ringkas.kedaluwarsa.nilai.toLocaleString('id-ID')} rupiah masih tercatat sebagai stok. ` +
          'Barang ini tidak boleh dijual — keluarkan lewat koreksi stok agar nilainya tidak ikut terhitung.',
        jumlah: d.ringkas.kedaluwarsa.batch,
        tautan: '/gudang/kadaluarsa',
        tombol: 'Lihat',
        izin: 'gudang.lihat',
      });
    }

    if (d.ringkas.mendekati.batch > 0) {
      const terdekat = d.rows.filter((b) => b.status === 'MENDEKATI').slice(0, 3);
      tambah({
        kunci: 'batch-mendekati',
        tingkat: 'perhatian',
        judul: `${d.ringkas.mendekati.batch} batch kedaluwarsa dalam 60 hari`,
        rincian:
          `Senilai ${d.ringkas.mendekati.nilai.toLocaleString('id-ID')} rupiah. Dahulukan menjualnya: ` +
          terdekat.map((b) => `${b.product_name} (${b.sisa_hari} hari)`).join(', '),
        jumlah: d.ringkas.mendekati.batch,
        tautan: '/gudang/kadaluarsa',
        tombol: 'Lihat',
        izin: 'gudang.lihat',
      });
    }
  });

  coba('pembelian', () => {
    if (!boleh('pembelian.lihat')) return;
    const d = daftarPembelian(permintaan(req, { from: '2000-01-01', to: '2999-12-31' }));

    const lama = d.rows.filter(
      (o) => (o.status === 'DIPESAN' || o.status === 'SEBAGIAN') && o.umur_hari >= 14
    );
    if (lama.length > 0) {
      tambah({
        kunci: 'po-lama',
        tingkat: lama.some((o) => o.umur_hari >= 30) ? 'genting' : 'perhatian',
        judul: `${lama.length} pesanan pembelian belum tiba lebih dari 14 hari`,
        rincian: `Terlama ${Math.max(...lama.map((o) => o.umur_hari))} hari. Senilai ${lama.reduce((s, o) => s + o.sisa, 0).toLocaleString('id-ID')} rupiah.`,
        nilai: r2(lama.reduce((s, o) => s + o.sisa, 0)),
        jumlah: lama.length,
        tautan: '/pembelian',
        tombol: 'Tanyakan Supplier',
        izin: 'pembelian.lihat',
      });
    }

    const hariIni = todayLocal();
    const tempo = d.rows.filter(
      (o) => o.due_date && !o.paid_date && o.status !== 'BATAL' && o.due_date <= hariIni
    );
    if (tempo.length > 0) {
      tambah({
        kunci: 'faktur-jatuh-tempo',
        tingkat: 'genting',
        judul: `${tempo.length} faktur supplier sudah jatuh tempo`,
        rincian: `Senilai ${tempo.reduce((s, o) => s + o.total, 0).toLocaleString('id-ID')} rupiah dan belum ditandai lunas.`,
        nilai: r2(tempo.reduce((s, o) => s + o.total, 0)),
        jumlah: tempo.length,
        tautan: '/pembelian',
        tombol: 'Lihat Nota',
        izin: 'pembelian.lihat',
      });
    }
  });

  // ---- Penggajian ----
  coba('penggajian', () => {
    if (!boleh('penggajian.lihat')) return;

    const draft = db
      .prepare("SELECT period, id FROM payrolls WHERE status = 'DRAFT' ORDER BY period")
      .all();
    if (draft.length > 0) {
      tambah({
        kunci: 'gaji-draft',
        tingkat: 'kabar',
        judul: `${draft.length} daftar gaji masih berstatus draft`,
        rincian: `Periode ${draft.map((d) => d.period).join(', ')} belum masuk pembukuan.`,
        jumlah: draft.length,
        tautan: '/presensi/penggajian',
        tombol: 'Lihat Penggajian',
        izin: 'penggajian.lihat',
      });
    }

    const belum = db
      .prepare(
        `SELECT COUNT(*) c FROM users
          WHERE active = 1 AND (base_salary IS NULL OR base_salary = 0)`
      )
      .get().c;
    if (belum > 0) {
      tambah({
        kunci: 'gaji-belum-diisi',
        tingkat: 'kabar',
        judul: `${belum} pegawai belum diisi gaji pokoknya`,
        rincian: 'Daftar gaji akan terbentuk dengan nilai nol untuk mereka.',
        jumlah: belum,
        tautan: '/pengaturan',
        tombol: 'Isi Data Tim',
        izin: 'sistem.tim',
      });
    }
  });

  // ---- Cadangan ----
  coba('cadangan', () => {
    if (!boleh('sistem.cadangan')) return;
    const rows = daftarCadangan();
    const terbaru = rows.length ? rows[0].dibuat : null;
    if (!terbaru || jamSejak(terbaru) > 48) {
      tambah({
        kunci: 'cadangan-basi',
        tingkat: rows.length === 0 ? 'genting' : 'perhatian',
        judul: rows.length === 0
          ? 'Belum ada cadangan basis data sama sekali'
          : 'Cadangan terakhir sudah lebih dari dua hari',
        rincian: 'Seluruh isi aplikasi ada di satu berkas. Tanpa salinan di luar server, tidak ada jalan kembali.',
        tautan: '/sistem/cadangan',
        tombol: 'Buat Cadangan',
        izin: 'sistem.cadangan',
      });
    }
  });

  butir.sort((a, b) => TINGKAT[a.tingkat] - TINGKAT[b.tingkat] || (b.nilai || 0) - (a.nilai || 0));

  return {
    hariIni: todayLocal(),
    rows: butir,
    ringkas: {
      total: butir.length,
      genting: butir.filter((b) => b.tingkat === 'genting').length,
      perhatian: butir.filter((b) => b.tingkat === 'perhatian').length,
      kabar: butir.filter((b) => b.tingkat === 'kabar').length,
    },
    gagal,
  };
}

router.get('/', ah((req, res) => res.json(kumpulkan(req))));

module.exports = router;
