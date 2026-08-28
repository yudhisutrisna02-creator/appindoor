'use strict';
/**
 * Pencairan dana marketplace.
 *
 * Uang penjualan tidak masuk ke bank pada hari pesanan dibuat. Marketplace
 * menahannya sampai pembeli menerima barang, dan selama itu jumlahnya hanya ada
 * sebagai piutang. Yang tidak terlihat di mana pun sampai sekarang: berapa
 * banyak yang sedang ditahan, milik toko mana, dan sudah berapa lama.
 *
 * Layar ini hanya membaca. Menandai dana sudah cair tetap lewat jalur yang sudah
 * ada di menu Order Penjualan (PATCH /api/sales/status-massal) — kalau ada dua
 * jalur tulis untuk hal yang sama, cepat atau lambat keduanya akan berbeda
 * memperlakukan jurnal.
 *
 * Bagian terpenting berkas ini adalah rekonsiliasinya. Nilai order yang belum
 * cair tidak sama dengan saldo Piutang Marketplace di neraca, dan itu memang
 * benar: iklan yang dibayar dengan potong saldo mengurangi piutang tanpa
 * menyentuh satu pun pesanan. Selisih yang tidak bisa dijelaskan oleh itu berarti
 * ada yang salah, dan lebih baik ketahuan di sini daripada saat menutup buku.
 */
const express = require('express');
const { db } = require('../db');
const { requireAuth } = require('../middleware/auth');
const { ah, dateRange } = require('../utils/http');
const { r2, ACC } = require('../utils/accounting');
const { CHANNEL_LABEL } = require('../utils/kanal');
const { daftarkanEkspor } = require('../utils/ekspor');
const { todayLocal } = require('../utils/time');

const router = express.Router();
router.use(requireAuth);

/** Kelompok umur dana yang masih ditahan. */
const EMBER = [
  { kunci: '0-7', label: 'Sampai 7 hari', min: 0, max: 7, wajar: true },
  { kunci: '8-14', label: '8–14 hari', min: 8, max: 14, wajar: true },
  { kunci: '15-30', label: '15–30 hari', min: 15, max: 30, wajar: false },
  { kunci: '>30', label: 'Lebih dari 30 hari', min: 31, max: Infinity, wajar: false },
];

const emberDari = (umur) => EMBER.find((e) => umur >= e.min && umur <= e.max) || EMBER[EMBER.length - 1];

const selisihHari = (a, b) =>
  Math.round((Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86400000);

/**
 * Saldo buku akun Piutang Marketplace sampai sebuah tanggal.
 *
 * Dibaca langsung dari jurnal, bukan dari ringkasan mana pun, supaya
 * pembandingnya benar-benar berdiri sendiri. Kalau angka ini diambil dari
 * perhitungan yang sama dengan yang sedang diperiksa, pemeriksaannya tidak
 * membuktikan apa-apa.
 */
function saldoPiutangBuku(asOf) {
  const rows = db
    .prepare(
      `SELECT j.source,
              COALESCE(SUM(l.debit - l.credit), 0) AS net,
              COUNT(*) AS baris
         FROM journal_lines l
         JOIN journals j   ON j.id = l.journal_id
         JOIN accounts a   ON a.id = l.account_id
        WHERE a.code = ? AND j.entry_date <= ?
        GROUP BY j.source
        ORDER BY ABS(SUM(l.debit - l.credit)) DESC`
    )
    .all(ACC.AR_MARKETPLACE, asOf)
    .map((r) => ({ sumber: r.source, net: r2(r.net), baris: r.baris }));

  return { saldo: r2(rows.reduce((s, r) => s + r.net, 0)), perSumber: rows };
}

/** Iklan yang dibayar dengan memotong saldo marketplace, sampai sebuah tanggal. */
function iklanPotongSaldo(asOf) {
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(amount), 0) AS total, COUNT(*) AS jumlah
         FROM ad_spends WHERE payment = 'SALDO' AND spend_date <= ?`
    )
    .get(asOf);
  return { total: r2(row.total), jumlah: row.jumlah };
}

/**
 * Data pencairan.
 *
 * `asOf` menentukan umur dana dan saldo buku pembandingnya; `from`/`to`
 * menentukan periode mana yang pencairannya dirangkum. Keduanya dipisah karena
 * pertanyaannya memang dua: "berapa yang masih ditahan sekarang" dan "berapa
 * yang cair bulan ini".
 */
function ambilPencairan(req) {
  const asOf = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.asOf || ''))
    ? req.query.asOf
    : todayLocal();
  const { from, to } = dateRange(req.query);

  // Nilai yang benar-benar akan diterima: pendapatan dikurangi seluruh potongan
  // marketplace. Memakai pendapatan kotor akan membuat piutang tampak lebih
  // besar daripada uang yang akan mendarat di bank.
  const NILAI = '(o.net_revenue - o.total_fees)';

  // Yang menentukan sebuah order masih berupa piutang adalah STATUS PEMBAYARAN,
  // bukan tanggal cair. Itu pula yang dipakai jurnalnya untuk memilih antara
  // Piutang Marketplace dan bank — memakai tanggal cair di sini akan membuat
  // layar ini dan buku besar menghitung dua himpunan yang berbeda, dan
  // rekonsiliasinya akan menyalahkan sesuatu yang sebenarnya tidak salah.
  const belum = db
    .prepare(
      `SELECT o.id, o.order_no, o.order_ref, o.order_date, o.channel, o.shop_id,
              o.fulfillment_status, o.payment_status, o.payout_date, o.buyer_city, o.courier,
              o.net_revenue, o.total_fees, ${NILAI} AS nilai,
              sh.name AS shop_name
         FROM sales_orders o
         LEFT JOIN shops sh ON sh.id = o.shop_id
        WHERE o.status = 'POSTED'
          AND o.payment_status <> 'PAID'
          AND o.fulfillment_status <> 'BATAL'
          AND o.order_date <= ?
        ORDER BY o.order_date, o.id`
    )
    .all(asOf)
    .map((o) => {
      const umur = Math.max(0, selisihHari(asOf, o.order_date));
      const e = emberDari(umur);
      return {
        ...o,
        nilai: r2(o.nilai),
        umur_hari: umur,
        ember: e.kunci,
        perluDitanya: !e.wajar,
        channelLabel: CHANNEL_LABEL[o.channel] || o.channel,
      };
    });

  const jumlah = (arr) => r2(arr.reduce((s, o) => s + o.nilai, 0));

  const perEmber = EMBER.map((e) => {
    const isi = belum.filter((o) => o.ember === e.kunci);
    return { ...e, max: e.max === Infinity ? null : e.max, orders: isi.length, nilai: jumlah(isi) };
  });

  const perToko = [...new Map(belum.map((o) => [o.shop_id, o])).keys()]
    .map((sid) => {
      const isi = belum.filter((o) => o.shop_id === sid);
      const tertua = isi.reduce((m, o) => Math.max(m, o.umur_hari), 0);
      return {
        shop_id: sid,
        nama: isi[0].shop_name || 'Tanpa toko',
        channelLabel: isi[0].channelLabel,
        orders: isi.length,
        nilai: jumlah(isi),
        umur_tertua: tertua,
        perluDitanya: isi.some((o) => o.perluDitanya),
      };
    })
    .sort((a, b) => b.nilai - a.nilai);

  // Yang cair pada periode yang sedang dilihat.
  const cair = db
    .prepare(
      `SELECT COUNT(*) AS orders,
              COALESCE(SUM(o.net_revenue - o.total_fees), 0) AS nilai,
              COALESCE(AVG(julianday(o.payout_date) - julianday(o.order_date)), 0) AS rata_hari
         FROM sales_orders o
        WHERE o.status = 'POSTED' AND o.payout_date BETWEEN ? AND ?`
    )
    .get(from, to);

  // --- Rekonsiliasi terhadap buku besar ---
  const buku = saldoPiutangBuku(asOf);
  const iklan = iklanPotongSaldo(asOf);
  const nilaiBelum = jumlah(belum);
  const seharusnya = r2(nilaiBelum - iklan.total);
  const selisih = r2(seharusnya - buku.saldo);

  // Kalau ada sumber jurnal lain yang menyentuh akun ini, sebutkan — lebih
  // menolong daripada sekadar mengumumkan bahwa angkanya tidak cocok.
  const sumberLain = buku.perSumber.filter((s) => !['SALES', 'ADS'].includes(s.sumber));

  const rekonsiliasi = {
    nilaiBelumCair: nilaiBelum,
    iklanPotongSaldo: iklan.total,
    iklanJumlah: iklan.jumlah,
    seharusnya,
    saldoBuku: buku.saldo,
    perSumber: buku.perSumber,
    sumberLain,
    selisih,
    cocok: Math.abs(selisih) < 1,
  };

  // Dua penanda yang seharusnya selalu sejalan: order yang sudah lunas semestinya
  // punya tanggal cair, dan yang belum lunas semestinya belum punya. Yang tidak
  // sejalan tidak merusak pembukuan, tetapi membuat laporan umur dana keliru.
  const takSejalan = db
    .prepare(
      `SELECT o.id, o.order_no, o.order_ref, o.order_date, o.payment_status, o.payout_date,
              o.fulfillment_status, sh.name AS shop_name, ${NILAI} AS nilai
         FROM sales_orders o
         LEFT JOIN shops sh ON sh.id = o.shop_id
        WHERE o.status = 'POSTED' AND o.fulfillment_status <> 'BATAL'
          AND o.order_date <= ?
          AND ((o.payment_status = 'PAID' AND o.payout_date IS NULL)
            OR (o.payment_status <> 'PAID' AND o.payout_date IS NOT NULL))
        ORDER BY o.order_date DESC
        LIMIT 100`
    )
    .all(asOf)
    .map((o) => ({ ...o, nilai: r2(o.nilai) }));

  const ringkas = {
    orders: belum.length,
    nilai: nilaiBelum,
    umurRata: belum.length
      ? r2(belum.reduce((s, o) => s + o.umur_hari, 0) / belum.length)
      : 0,
    umurTertua: belum.reduce((m, o) => Math.max(m, o.umur_hari), 0),
    perluDitanya: belum.filter((o) => o.perluDitanya).length,
    nilaiPerluDitanya: jumlah(belum.filter((o) => o.perluDitanya)),
    cairOrders: cair.orders,
    cairNilai: r2(cair.nilai),
    cairRataHari: r2(cair.rata_hari),
    takSejalan: takSejalan.length,
  };

  return { asOf, from, to, rows: belum, perEmber, perToko, ringkas, rekonsiliasi, takSejalan };
}

router.get('/', ah((req, res) => res.json(ambilPencairan(req))));

daftarkanEkspor(router, {
  path: '/',
  judul: 'Dana Belum Cair',
  kolom: [
    { header: 'No. Order', key: 'order_no', width: 18 },
    { header: 'No. Pesanan', key: 'order_ref', width: 20 },
    { header: 'Tanggal', key: 'order_date', width: 12 },
    { header: 'Umur (hari)', key: 'umur_hari', width: 12 },
    { header: 'Toko', key: 'shop_name', width: 24 },
    { header: 'Channel', key: 'channelLabel', width: 16 },
    { header: 'Status', key: 'fulfillment_status', width: 12 },
    { header: 'Ekspedisi', key: 'courier', width: 14 },
    { header: 'Pendapatan', key: 'net_revenue', width: 15, money: true },
    { header: 'Potongan', key: 'total_fees', width: 14, money: true },
    { header: 'Akan Diterima', key: 'nilai', width: 16, money: true },
  ],
  ambil: (req) => {
    const d = ambilPencairan(req);
    return {
      rows: d.rows,
      subtitle: `Posisi ${d.asOf} — ${d.rows.length} order belum cair`,
      meta: [
        ['Nilai belum cair', d.ringkas.nilai],
        ['Umur rata-rata (hari)', d.ringkas.umurRata],
        ['Umur tertua (hari)', d.ringkas.umurTertua],
        ['Perlu ditanyakan (lebih 14 hari)', d.ringkas.nilaiPerluDitanya],
        ['Saldo Piutang Marketplace di buku', d.rekonsiliasi.saldoBuku],
      ],
    };
  },
});

module.exports = router;
// Dipakai ulang oleh Pusat Perhatian supaya angka peringatannya tidak pernah
// berbeda dari angka yang tampil di menu ini sendiri.
module.exports.ambilPencairan = ambilPencairan;
