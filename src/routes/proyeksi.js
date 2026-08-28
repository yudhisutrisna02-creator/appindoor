'use strict';
/**
 * Proyeksi arus kas.
 *
 * Menjawab satu pertanyaan yang tidak dijawab laporan mana pun: bulan depan
 * uangnya cukup atau tidak. Neraca menyebut posisi hari ini, laba rugi menyebut
 * yang sudah lewat; keduanya diam soal apa yang akan terjadi.
 *
 * Bahannya sudah tercatat semua — dana marketplace yang belum cair beserta
 * umurnya, faktur supplier beserta jatuh temponya, gaji, dan belanja iklan.
 * Yang belum ada hanyalah tempat yang menyusunnya menjadi satu garis waktu.
 *
 * Ini perkiraan, bukan ramalan. Setiap asumsinya disebutkan apa adanya beserta
 * dasarnya, karena angka proyeksi yang tidak menyebutkan asumsinya akan
 * diperlakukan seolah kepastian — dan itu justru berbahaya untuk keputusan yang
 * menyangkut uang.
 */
const express = require('express');
const { db } = require('../db');
const { requireAuth } = require('../middleware/auth');
const { ah } = require('../utils/http');
const { r2, ACC } = require('../utils/accounting');
const { daftarkanEkspor } = require('../utils/ekspor');
const { todayLocal } = require('../utils/time');

const router = express.Router();
router.use(requireAuth);

/** Berapa minggu ke depan yang diproyeksikan. */
const MINGGU_BAWAAN = 12;

const tambahHari = (tgl, n) => {
  const d = new Date(`${tgl}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

const selisihHari = (a, b) =>
  Math.round((Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86400000);

/** Saldo seluruh akun kas dan bank pada sebuah tanggal. */
function saldoKas(asOf) {
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(l.debit - l.credit), 0) AS saldo
         FROM journal_lines l
         JOIN journals j ON j.id = l.journal_id
         JOIN accounts a ON a.id = l.account_id
        WHERE a.is_cash = 1 AND j.entry_date <= ?`
    )
    .get(asOf);
  return r2(row.saldo);
}

/**
 * Rata-rata hari sejak pesanan dibuat sampai dananya cair.
 *
 * Dihitung dari pencairan yang benar-benar terjadi, bukan dari janji
 * marketplace. Kalau belum ada riwayatnya sama sekali, dipakai 10 hari — angka
 * yang disebutkan sebagai asumsi, bukan disembunyikan sebagai bawaan.
 */
function rataHariCair() {
  const row = db
    .prepare(
      `SELECT AVG(julianday(payout_date) - julianday(order_date)) AS rata, COUNT(*) AS n
         FROM sales_orders
        WHERE status = 'POSTED' AND payout_date IS NOT NULL`
    )
    .get();
  if (!row.n) return { hari: 10, dasar: 'belum ada riwayat pencairan — dipakai 10 hari', n: 0 };
  return {
    hari: r2(row.rata),
    dasar: `rata-rata ${r2(row.rata)} hari dari ${row.n} order yang sudah cair`,
    n: row.n,
  };
}

/** Belanja iklan rata-rata per hari, dari 30 hari terakhir. */
function iklanPerHari(hariIni) {
  const dari = tambahHari(hariIni, -30);
  const row = db
    .prepare('SELECT COALESCE(SUM(amount), 0) AS total, COUNT(*) AS n FROM ad_spends WHERE spend_date BETWEEN ? AND ?')
    .get(dari, hariIni);
  return {
    perHari: r2(row.total / 30),
    total: r2(row.total),
    n: row.n,
    dasar: row.n
      ? `${r2(row.total).toLocaleString('id-ID')} rupiah pada 30 hari terakhir`
      : 'belum ada belanja iklan 30 hari terakhir',
  };
}

/** Gaji bulanan, diambil dari daftar gaji terakhir yang ada. */
function gajiBulanan() {
  const p = db
    .prepare(
      `SELECT p.id, p.period, p.pay_date,
              COALESCE((SELECT SUM(i.net) FROM payroll_items i WHERE i.payroll_id = p.id), 0) AS total
         FROM payrolls p ORDER BY p.period DESC LIMIT 1`
    )
    .get();
  if (!p || p.total <= 0) {
    return { total: 0, tanggal: 25, dasar: 'belum ada daftar gaji berisi nilai' };
  }
  return {
    total: r2(p.total),
    tanggal: Number(String(p.pay_date || '').slice(8, 10)) || 25,
    dasar: `daftar gaji ${p.period} sebesar ${r2(p.total).toLocaleString('id-ID')} rupiah`,
  };
}

function ambilProyeksi(req) {
  const hariIni = todayLocal();
  const minggu = Math.min(26, Math.max(4, Number(req.query.minggu) || MINGGU_BAWAAN));

  const mulaiSaldo = saldoKas(hariIni);
  const cair = rataHariCair();
  const iklan = iklanPerHari(hariIni);
  const gaji = gajiBulanan();

  // --- Uang masuk: dana marketplace yang belum cair ---
  const belumCair = db
    .prepare(
      `SELECT o.order_date, (o.net_revenue - o.total_fees) AS nilai
         FROM sales_orders o
        WHERE o.status = 'POSTED' AND o.payment_status <> 'PAID'
          AND o.fulfillment_status <> 'BATAL'`
    )
    .all()
    .map((o) => {
      const perkiraan = tambahHari(o.order_date, Math.round(cair.hari));
      return {
        // Yang perkiraan cairnya sudah lewat tidak dianggap hangus; ia
        // diharapkan masuk secepatnya, karena uangnya memang masih hak kita.
        tanggal: perkiraan < hariIni ? hariIni : perkiraan,
        nilai: r2(o.nilai),
        terlambat: perkiraan < hariIni,
      };
    });

  // --- Uang keluar: faktur supplier yang belum dibayar ---
  const faktur = db
    .prepare(
      `SELECT o.po_no, o.due_date, o.order_date,
              (SELECT COALESCE(SUM(i.qty * i.unit_cost), 0) FROM purchase_items i WHERE i.po_id = o.id) AS total
         FROM purchase_orders o
        WHERE o.status <> 'BATAL' AND o.paid_date IS NULL AND o.payment = 'CREDIT'`
    )
    .all()
    .filter((o) => o.total > 0)
    .map((o) => {
      // Faktur tanpa jatuh tempo diperkirakan 30 hari sejak pesanan — lebih
      // baik muncul di garis waktu dengan asumsi yang disebutkan daripada
      // hilang sama sekali dari perkiraan.
      const jatuh = o.due_date || tambahHari(o.order_date, 30);
      return {
        tanggal: jatuh < hariIni ? hariIni : jatuh,
        nilai: r2(o.total),
        po_no: o.po_no,
        tanpaTempo: !o.due_date,
      };
    });

  // --- Susun per minggu ---
  const baris = [];
  let saldo = mulaiSaldo;
  let terendah = { saldo: mulaiSaldo, dari: hariIni };

  for (let i = 0; i < minggu; i += 1) {
    const dari = tambahHari(hariIni, i * 7);
    const sampai = tambahHari(hariIni, i * 7 + 6);
    const dalam = (t) => t >= dari && t <= sampai;

    const masukCair = r2(belumCair.filter((x) => dalam(x.tanggal)).reduce((s, x) => s + x.nilai, 0));
    const keluarFaktur = r2(faktur.filter((x) => dalam(x.tanggal)).reduce((s, x) => s + x.nilai, 0));

    // Gaji jatuh pada tanggal tertentu tiap bulan; ia masuk ke minggu yang
    // memuat tanggal itu.
    let keluarGaji = 0;
    if (gaji.total > 0) {
      for (let d = 0; d < 7; d += 1) {
        const tgl = tambahHari(dari, d);
        if (Number(tgl.slice(8, 10)) === gaji.tanggal) keluarGaji = gaji.total;
      }
    }

    const keluarIklan = r2(iklan.perHari * 7);

    const masuk = [{ sumber: 'Pencairan marketplace', nilai: masukCair }].filter((x) => x.nilai > 0);
    const keluar = [
      { sumber: 'Faktur supplier', nilai: keluarFaktur },
      { sumber: 'Gaji', nilai: keluarGaji },
      { sumber: 'Belanja iklan', nilai: keluarIklan },
    ].filter((x) => x.nilai > 0);

    const totalMasuk = r2(masuk.reduce((s, x) => s + x.nilai, 0));
    const totalKeluar = r2(keluar.reduce((s, x) => s + x.nilai, 0));
    saldo = r2(saldo + totalMasuk - totalKeluar);

    if (saldo < terendah.saldo) terendah = { saldo, dari, sampai };

    baris.push({
      minggu: i + 1,
      dari,
      sampai,
      masuk,
      keluar,
      totalMasuk,
      totalKeluar,
      bersih: r2(totalMasuk - totalKeluar),
      saldoAkhir: saldo,
      minus: saldo < 0,
    });
  }

  const terlambat = belumCair.filter((x) => x.terlambat);
  const fakturTanpaTempo = faktur.filter((x) => x.tanpaTempo);

  return {
    hariIni,
    minggu,
    mulai: { tanggal: hariIni, saldo: mulaiSaldo },
    rows: baris,
    ringkas: {
      saldoAwal: mulaiSaldo,
      saldoAkhir: saldo,
      totalMasuk: r2(baris.reduce((s, b) => s + b.totalMasuk, 0)),
      totalKeluar: r2(baris.reduce((s, b) => s + b.totalKeluar, 0)),
      terendah,
      adaMinus: baris.some((b) => b.minus),
      mingguMinusPertama: (baris.find((b) => b.minus) || {}).minggu || null,
    },
    asumsi: [
      {
        label: 'Dana marketplace cair setelah',
        nilai: `${cair.hari} hari sejak pesanan`,
        dasar: cair.dasar,
      },
      {
        label: 'Belanja iklan per minggu',
        nilai: `${r2(iklan.perHari * 7).toLocaleString('id-ID')} rupiah`,
        dasar: iklan.dasar,
      },
      {
        label: 'Gaji per bulan',
        nilai: gaji.total > 0
          ? `${gaji.total.toLocaleString('id-ID')} rupiah tiap tanggal ${gaji.tanggal}`
          : 'belum diperhitungkan',
        dasar: gaji.dasar,
      },
      {
        label: 'Dana yang sudah lewat perkiraan',
        nilai: `${terlambat.length} order`,
        dasar: terlambat.length
          ? `Senilai ${r2(terlambat.reduce((s, x) => s + x.nilai, 0)).toLocaleString('id-ID')} rupiah, diharapkan masuk minggu ini`
          : 'tidak ada',
      },
      {
        label: 'Faktur tanpa jatuh tempo',
        nilai: `${fakturTanpaTempo.length} faktur`,
        dasar: fakturTanpaTempo.length
          ? 'Diperkirakan 30 hari sejak pesanan; isi jatuh temponya agar lebih tepat'
          : 'tidak ada',
      },
    ],
    // Yang sengaja TIDAK dihitung. Menyebutkannya membuat batas perkiraan ini
    // jelas, alih-alih membiarkan orang mengira semuanya sudah tercakup.
    tidakDihitung: [
      'Penjualan baru yang belum terjadi',
      'Pembelian stok yang belum dipesan',
      'Biaya operasional di luar gaji dan iklan',
      'Pajak dan angsuran',
    ],
  };
}

router.get('/', ah((req, res) => res.json(ambilProyeksi(req))));

daftarkanEkspor(router, {
  path: '/',
  judul: 'Proyeksi Arus Kas',
  kolom: [
    { header: 'Minggu', key: 'minggu', width: 9 },
    { header: 'Dari', key: 'dari', width: 12 },
    { header: 'Sampai', key: 'sampai', width: 12 },
    { header: 'Masuk', key: 'totalMasuk', width: 16, money: true },
    { header: 'Keluar', key: 'totalKeluar', width: 16, money: true },
    { header: 'Bersih', key: 'bersih', width: 16, money: true },
    { header: 'Saldo Akhir', key: 'saldoAkhir', width: 18, money: true },
  ],
  ambil: (req) => {
    const d = ambilProyeksi(req);
    return {
      rows: d.rows,
      subtitle: `${d.minggu} minggu sejak ${d.hariIni} — saldo awal ${d.ringkas.saldoAwal}`,
      meta: [
        ['Saldo awal', d.ringkas.saldoAwal],
        ['Perkiraan uang masuk', d.ringkas.totalMasuk],
        ['Perkiraan uang keluar', d.ringkas.totalKeluar],
        ['Perkiraan saldo akhir', d.ringkas.saldoAkhir],
        ['Titik terendah', d.ringkas.terendah.saldo],
        ...d.asumsi.map((a) => [`Asumsi — ${a.label}`, a.nilai]),
      ],
    };
  },
});

module.exports = router;
