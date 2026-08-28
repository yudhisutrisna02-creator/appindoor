'use strict';
/**
 * Kinerja produk — mempertemukan penjualan dengan stok yang tersisa.
 *
 * Dua angka yang selama ini terpisah: laporan penjualan tahu apa yang laku,
 * kartu stok tahu apa yang masih ada. Selama keduanya dibaca sendiri-sendiri,
 * dua kerugian terbesar tidak pernah terlihat — barang laris yang stoknya
 * habis (penjualan yang hilang tanpa jejak, karena order yang tidak jadi tidak
 * pernah tercatat di mana pun), dan barang diam yang uangnya tertahan di rak.
 *
 * Layar ini hanya membaca; tidak ada catatan yang diubah dari sini.
 */
const express = require('express');
const { db } = require('../db');
const { requireAuth, izinPengguna } = require('../middleware/auth');
const { ah, dateRange } = require('../utils/http');
const { r2 } = require('../utils/accounting');
const { daftarkanEkspor } = require('../utils/ekspor');
const { todayLocal } = require('../utils/time');

const router = express.Router();
router.use(requireAuth);

/** Batas hari sebuah produk dianggap berhenti bergerak. */
const HARI_MATI = 90;
/** Sisa hari persediaan yang sudah waktunya dipesan ulang. */
const HARI_MENIPIS = 14;

const selisihHari = (a, b) =>
  Math.round((Date.parse(a + 'T00:00:00Z') - Date.parse(b + 'T00:00:00Z')) / 86400000);

/**
 * Golongan produk.
 *
 * Urutannya sengaja: yang lebih mendesak menang. Produk laris yang stoknya
 * habis tetap disebut "habis" walau lajunya cepat, karena justru itu yang
 * perlu dikerjakan hari ini.
 */
function golongan({ stok, qty, perHari, cover, diamHari }) {
  if (stok <= 0) return qty > 0 ? 'habis' : 'kosong';
  if (qty <= 0) {
    if (diamHari === null) return 'belum-terjual';
    return diamHari > HARI_MATI ? 'mati' : 'diam';
  }
  if (perHari > 0 && cover !== null && cover <= HARI_MENIPIS) return 'menipis';
  return 'sehat';
}

const LABEL_GOLONGAN = {
  habis: 'Laku tapi stok habis',
  menipis: 'Cukup ' + HARI_MENIPIS + ' hari lagi atau kurang',
  sehat: 'Wajar',
  diam: 'Tidak terjual pada periode ini',
  mati: 'Diam lebih dari ' + HARI_MATI + ' hari',
  'belum-terjual': 'Belum pernah terjual',
  kosong: 'Stok kosong, tidak ada penjualan',
};

const GOLONGAN_DIAM = ['mati', 'diam', 'belum-terjual'];

/**
 * Data kinerja produk.
 *
 * Penjualan dibatasi periode, tetapi "terakhir terjual" sengaja dihitung dari
 * seluruh riwayat. Produk yang sepi bulan ini tetapi ramai bulan lalu bukan
 * barang mati, dan membatasinya ke periode yang sedang dilihat akan membuat
 * setiap awal bulan tampak seperti bencana.
 */
function ambilKinerja(req, opsi) {
  const tanpaLaba = !!(opsi && opsi.tanpaLaba);
  const { from, to } = dateRange(req.query);
  const hariPeriode = Math.max(1, selisihHari(to, from) + 1);
  const hariIni = todayLocal();

  const jual = new Map(
    db
      .prepare(
        `SELECT i.product_id AS id,
                SUM(i.qty)                 AS qty,
                SUM(i.subtotal)            AS pendapatan,
                SUM(i.subcost)             AS hpp,
                COUNT(DISTINCT i.order_id) AS orders
           FROM sales_items i
           JOIN sales_orders o ON o.id = i.order_id
          WHERE o.order_date BETWEEN ? AND ? AND o.status = 'POSTED'
          GROUP BY i.product_id`
      )
      .all(from, to)
      .map((r) => [r.id, r])
  );

  const terakhir = new Map(
    db
      .prepare(
        `SELECT i.product_id AS id, MAX(o.order_date) AS tgl
           FROM sales_items i
           JOIN sales_orders o ON o.id = i.order_id
          WHERE o.status = 'POSTED'
          GROUP BY i.product_id`
      )
      .all()
      .map((r) => [r.id, r.tgl])
  );

  const rows = db
    .prepare('SELECT id, sku, name, category, unit, cost, price, stock, min_stock, active FROM products')
    .all()
    .map((p) => {
      const s = jual.get(p.id) || { qty: 0, pendapatan: 0, hpp: 0, orders: 0 };
      const stok = r2(p.stock);
      const qty = r2(s.qty);
      const perHari = r2(qty / hariPeriode);
      const cover = perHari > 0 ? Math.floor(stok / perHari) : null;
      const tglTerakhir = terakhir.get(p.id) || null;
      const diamHari = tglTerakhir ? selisihHari(hariIni, tglTerakhir) : null;
      const nilaiStok = r2(stok * p.cost);
      const labaKotor = r2(s.pendapatan - s.hpp);

      const baris = {
        id: p.id,
        sku: p.sku,
        name: p.name,
        category: p.category,
        unit: p.unit,
        active: !!p.active,
        stok,
        min_stock: r2(p.min_stock),
        cost: r2(p.cost),
        price: r2(p.price),
        nilai_stok: nilaiStok,
        qty,
        orders: s.orders,
        pendapatan: r2(s.pendapatan),
        per_hari: perHari,
        cover_hari: cover,
        terakhir_terjual: tglTerakhir,
        diam_hari: diamHari,
        golongan: golongan({ stok, qty, perHari, cover, diamHari }),
      };

      // Modal yang menganggur — hanya bermakna untuk barang yang memang diam.
      baris.modal_tertahan = GOLONGAN_DIAM.includes(baris.golongan) ? nilaiStok : 0;

      // HPP dan margin bukan angka yang perlu dilihat semua orang; tim gudang
      // butuh pergerakannya, bukan untungnya.
      if (!tanpaLaba) {
        baris.hpp = r2(s.hpp);
        baris.laba_kotor = labaKotor;
        baris.margin_pct = s.pendapatan ? r2((labaKotor / s.pendapatan) * 100) : 0;
        // Perputaran: berapa kali nilai persediaan berputar pada periode ini.
        baris.perputaran = nilaiStok > 0 ? r2(s.hpp / nilaiStok) : null;
      }

      return baris;
    })
    .sort((a, b) => b.pendapatan - a.pendapatan || b.nilai_stok - a.nilai_stok);

  const saring = (f) => rows.filter(f);
  const jumlah = (arr, k) => r2(arr.reduce((s, r) => s + (r[k] || 0), 0));

  const perluRestok = saring((r) => r.golongan === 'habis' || r.golongan === 'menipis');
  const diam = saring((r) => r.modal_tertahan > 0);

  const ringkas = {
    produk: rows.length,
    terjual: saring((r) => r.qty > 0).length,
    nilaiStok: jumlah(rows, 'nilai_stok'),
    perluRestok: perluRestok.length,
    habis: saring((r) => r.golongan === 'habis').length,
    diam: diam.length,
    modalTertahan: jumlah(diam, 'modal_tertahan'),
    pendapatan: jumlah(rows, 'pendapatan'),
  };
  if (!tanpaLaba) ringkas.labaKotor = jumlah(rows, 'laba_kotor');

  const perGolongan = Object.keys(LABEL_GOLONGAN)
    .map((g) => {
      const isi = saring((r) => r.golongan === g);
      return {
        golongan: g,
        label: LABEL_GOLONGAN[g],
        produk: isi.length,
        nilai_stok: jumlah(isi, 'nilai_stok'),
        pendapatan: jumlah(isi, 'pendapatan'),
      };
    })
    .filter((g) => g.produk > 0);

  return {
    from,
    to,
    hariPeriode,
    hariIni,
    ambang: { mati: HARI_MATI, menipis: HARI_MENIPIS },
    rows,
    ringkas,
    perGolongan,
    labelGolongan: LABEL_GOLONGAN,
    tanpaLaba,
  };
}

const tanpaLabaUntuk = (req) => !izinPengguna(req.user).has('penjualan.margin');

router.get('/produk', ah((req, res) => res.json(ambilKinerja(req, { tanpaLaba: tanpaLabaUntuk(req) }))));

const KOLOM = [
  { header: 'SKU', key: 'sku', width: 16 },
  { header: 'Produk', key: 'name', width: 34 },
  { header: 'Kategori', key: 'category', width: 16 },
  { header: 'Stok', key: 'stok', width: 10 },
  { header: 'Nilai Stok', key: 'nilai_stok', width: 15, money: true },
  { header: 'Qty Terjual', key: 'qty', width: 12 },
  { header: 'Order', key: 'orders', width: 9 },
  { header: 'Pendapatan', key: 'pendapatan', width: 15, money: true },
  { header: 'Laba Kotor', key: 'laba_kotor', width: 15, money: true },
  { header: 'Margin', key: 'margin_pct', width: 10, pct: true },
  { header: 'Rata/Hari', key: 'per_hari', width: 11 },
  { header: 'Cukup (hari)', key: 'cover_hari', width: 12 },
  { header: 'Terakhir Terjual', key: 'terakhir_terjual', width: 16 },
  { header: 'Status', key: 'status_label', width: 28 },
];

daftarkanEkspor(router, {
  path: '/produk',
  judul: 'Kinerja Produk',
  kolom: KOLOM,
  ambil: (req) => {
    const tanpaLaba = tanpaLabaUntuk(req);
    const d = ambilKinerja(req, { tanpaLaba });
    return {
      kolom: tanpaLaba ? KOLOM.filter((k) => !['laba_kotor', 'margin_pct'].includes(k.key)) : KOLOM,
      rows: d.rows.map((r) => ({ ...r, status_label: LABEL_GOLONGAN[r.golongan] })),
      subtitle: `Periode ${d.from} s/d ${d.to}`,
      meta: [
        ['Jumlah produk', d.ringkas.produk],
        ['Nilai persediaan', d.ringkas.nilaiStok],
        ['Perlu restok', d.ringkas.perluRestok],
        ['Modal tertahan di barang diam', d.ringkas.modalTertahan],
      ],
    };
  },
});

module.exports = router;
// Dipakai ulang oleh Pusat Perhatian supaya angka peringatannya tidak pernah
// berbeda dari angka yang tampil di menu ini sendiri.
module.exports.ambilKinerja = ambilKinerja;
