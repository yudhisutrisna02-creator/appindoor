'use strict';
/**
 * Saran pembelian: menjawab "beli apa, berapa, kapan".
 *
 * Seluruh datanya sudah ada di aplikasi — kecepatan jual tiap produk, stok
 * sekarang, dan berapa lama supplier biasanya mengirim. Yang belum ada adalah
 * yang menyatukannya menjadi satu keputusan.
 *
 * Stok minimum yang diketik manual tidak menjawab ini. Ia angka mati: tidak
 * tahu produknya sedang laris atau melambat, dan tidak tahu suppliernya kirim
 * tiga hari atau tiga minggu. Dua produk dengan stok minimum sama bisa
 * berbeda nasib sepenuhnya.
 *
 * Dua kesalahan yang sengaja dihindari di sini:
 *
 *  1. Menyarankan pembelian barang yang TIDAK LAKU. Barang diam yang dibeli
 *     lagi adalah cara tercepat mengubah uang menjadi tumpukan di gudang.
 *     Produk tanpa penjualan sama sekali tidak pernah masuk daftar saran —
 *     ia justru dilaporkan terpisah sebagai modal yang mengendap.
 *
 *  2. Menyarankan pembelian yang SUDAH DIPESAN. Barang yang masih di jalan
 *     tetap barang; menghitungnya sebagai belum ada membuat pesanan ganda,
 *     dan gudang menerima dua kali lipat dari yang dibutuhkan.
 */
const express = require('express');
const { db } = require('../db');
const { requireAuth, butuhIzin } = require('../middleware/auth');
const { ah } = require('../utils/http');
const { r2 } = require('../utils/accounting');
const { daftarkanEkspor } = require('../utils/ekspor');
const { todayLocal } = require('../utils/time');

const router = express.Router();
router.use(requireAuth);

/** Lead time bawaan bila supplier belum pernah punya riwayat pengiriman. */
const LEAD_TIME_BAWAAN = 7;

/** Angka bawaan, semuanya bisa ditimpa lewat query. */
const BAWAAN = {
  hari: 60,      // jendela pengamatan penjualan
  penyangga: 14, // cadangan hari, untuk jaga-jaga permintaan naik
  cakupan: 45,   // berapa hari ke depan yang ingin ditutupi sekali beli
};

const angka = (v, bawaan, min, maks) => {
  const n = Number(v);
  return Number.isFinite(n) && n >= min && n <= maks ? n : bawaan;
};

/**
 * Lama pengiriman tiap supplier, dari riwayatnya sendiri.
 *
 * Dihitung dari selisih tanggal pesan sampai barangnya benar-benar masuk
 * gudang, bukan dari expected_date — tanggal harapan adalah niat, bukan
 * kenyataan, dan yang menentukan kapan harus memesan adalah kenyataannya.
 */
function leadTimeSupplier() {
  const rows = db
    .prepare(
      `SELECT po.partner_id,
              AVG(julianday(m.terima) - julianday(po.order_date)) AS hari,
              COUNT(*) AS jumlah
         FROM purchase_orders po
         JOIN (SELECT source_id, MIN(move_date) AS terima
                 FROM stock_moves
                WHERE source = 'PURCHASE' AND source_id IS NOT NULL
                GROUP BY source_id) m ON m.source_id = po.id
        WHERE po.partner_id IS NOT NULL
          AND julianday(m.terima) >= julianday(po.order_date)
        GROUP BY po.partner_id`
    )
    .all();

  const peta = new Map();
  for (const r of rows) {
    if (r.hari != null && r.jumlah > 0) {
      peta.set(r.partner_id, { hari: Math.max(1, Math.round(r.hari)), dari: r.jumlah });
    }
  }

  const semua = rows.filter((r) => r.hari != null);
  const rerata = semua.length
    ? Math.max(1, Math.round(semua.reduce((s, r) => s + r.hari, 0) / semua.length))
    : LEAD_TIME_BAWAAN;

  return { peta, rerata };
}

/** Barang yang sudah dipesan tetapi belum diterima, per produk. */
function sedangDipesan() {
  const rows = db
    .prepare(
      `SELECT i.product_id, SUM(i.qty - i.qty_received) AS qty
         FROM purchase_items i
         JOIN purchase_orders po ON po.id = i.po_id
        WHERE po.status IN ('DIPESAN', 'SEBAGIAN')
          AND i.qty > i.qty_received
        GROUP BY i.product_id`
    )
    .all();
  return new Map(rows.map((r) => [r.product_id, r2(r.qty)]));
}

/** Pengambil saran pembelian — dipakai layar, Pusat Perhatian, dan unduhan. */
function ambilSaran(req) {
  const q = (req && req.query) || {};
  const hari = angka(q.hari, BAWAAN.hari, 7, 365);
  const penyangga = angka(q.penyangga, BAWAAN.penyangga, 0, 90);
  const cakupan = angka(q.cakupan, BAWAAN.cakupan, 7, 180);

  const sampai = todayLocal();
  const dari = new Date(new Date(sampai).getTime() - hari * 86400000)
    .toISOString()
    .slice(0, 10);

  // Penjualan hanya dihitung dari order yang benar-benar jadi. Order batal
  // barangnya kembali ke gudang — memasukkannya membuat produk tampak lebih
  // laris daripada kenyataannya, dan sarannya ikut menggelembung.
  const jual = db
    .prepare(
      `SELECT i.product_id, SUM(i.qty) AS qty
         FROM sales_items i
         JOIN sales_orders o ON o.id = i.order_id
        WHERE o.status = 'POSTED'
          AND o.fulfillment_status <> 'BATAL'
          AND o.order_date BETWEEN ? AND ?
        GROUP BY i.product_id`
    )
    .all(dari, sampai);
  const terjual = new Map(jual.map((r) => [r.product_id, r2(r.qty)]));

  const { peta: leadPeta, rerata: leadRerata } = leadTimeSupplier();
  const dipesan = sedangDipesan();

  const produk = db
    .prepare(
      `SELECT p.*, s.name AS supplier_name
         FROM products p
         LEFT JOIN partners s ON s.id = p.supplier_id
        WHERE p.active = 1
        ORDER BY p.name`
    )
    .all();

  const rows = produk.map((p) => {
    const laku = terjual.get(p.id) || 0;
    const perHari = r2(laku / hari);
    const lead = p.supplier_id && leadPeta.has(p.supplier_id)
      ? leadPeta.get(p.supplier_id).hari
      : leadRerata;
    const leadDariRiwayat = !!(p.supplier_id && leadPeta.has(p.supplier_id));

    const stok = r2(p.stock);
    const diJalan = dipesan.get(p.id) || 0;
    const tersedia = r2(stok + diJalan);

    // Berapa hari lagi stok habis pada kecepatan sekarang. Produk yang tidak
    // laku sama sekali tidak punya jawaban di sini, dan memang tidak perlu.
    const hariTersisa = perHari > 0 ? Math.floor(stok / perHari) : null;
    const titikPesan = r2(perHari * (lead + penyangga));

    let status;
    if (perHari <= 0) status = stok > 0 ? 'DIAM' : 'TIDAK_LAKU';
    else if (stok <= 0) status = 'HABIS';
    else if (hariTersisa < lead) status = 'MENDESAK';
    else if (hariTersisa < lead + penyangga) status = 'SEGERA';
    else status = 'AMAN';

    // Yang disarankan menutupi lead time + penyangga + cakupan, dikurangi apa
    // yang sudah ada DAN yang sudah dipesan.
    const kebutuhan = r2(perHari * (lead + penyangga + cakupan));
    const saranQty = ['HABIS', 'MENDESAK', 'SEGERA'].includes(status)
      ? Math.max(0, Math.ceil(kebutuhan - tersedia))
      : 0;

    return {
      id: p.id,
      sku: p.sku,
      name: p.name,
      unit: p.unit,
      category: p.category,
      supplier_id: p.supplier_id,
      supplier_name: p.supplier_name,
      cost: r2(p.cost),
      stok,
      diJalan,
      terjual: laku,
      perHari,
      hariTersisa,
      leadTime: lead,
      leadDariRiwayat,
      titikPesan,
      saranQty,
      nilaiSaran: r2(saranQty * p.cost),
      nilaiDiam: status === 'DIAM' ? r2(stok * p.cost) : 0,
      status,
    };
  });

  const per = (st) => rows.filter((r) => r.status === st);
  const nilai = (arr, f) => r2(arr.reduce((s, x) => s + f(x), 0));
  const disarankan = rows.filter((r) => r.saranQty > 0);

  return {
    parameter: { hari, penyangga, cakupan, dari, sampai, leadTimeRerata: leadRerata },
    rows,
    ringkas: {
      habis: { produk: per('HABIS').length, nilai: nilai(per('HABIS'), (r) => r.nilaiSaran) },
      mendesak: { produk: per('MENDESAK').length, nilai: nilai(per('MENDESAK'), (r) => r.nilaiSaran) },
      segera: { produk: per('SEGERA').length, nilai: nilai(per('SEGERA'), (r) => r.nilaiSaran) },
      aman: { produk: per('AMAN').length },
      // Modal yang mengendap: bukan untuk dibeli lagi, justru untuk dihabiskan.
      diam: { produk: per('DIAM').length, nilai: nilai(per('DIAM'), (r) => r.nilaiDiam) },
      totalSaran: nilai(disarankan, (r) => r.nilaiSaran),
      produkDisarankan: disarankan.length,
    },
  };
}

router.get('/', butuhIzin('pembelian.lihat'), ah((req, res) => res.json(ambilSaran(req))));

daftarkanEkspor(router, {
  path: '/',
  judul: 'Saran Pembelian',
  kolom: [
    { header: 'SKU', key: 'sku', width: 16 },
    { header: 'Produk', key: 'name', width: 34 },
    { header: 'Supplier', key: 'supplier_name', width: 22 },
    { header: 'Stok', key: 'stok', width: 10 },
    { header: 'Sedang Dipesan', key: 'diJalan', width: 14 },
    { header: 'Terjual/Hari', key: 'perHari', width: 13 },
    { header: 'Sisa Hari', key: 'hariTersisa', width: 11 },
    { header: 'Lead Time', key: 'leadTime', width: 11 },
    { header: 'Saran Beli', key: 'saranQty', width: 12 },
    { header: 'Nilai Saran', key: 'nilaiSaran', width: 16, money: true },
    { header: 'Status', key: 'status', width: 12 },
  ],
  ambil: (req) => {
    const d = ambilSaran(req);
    return {
      rows: d.rows.filter((r) => r.saranQty > 0 || r.status === 'DIAM'),
      subtitle:
        `Berdasarkan penjualan ${d.parameter.dari} s/d ${d.parameter.sampai} ` +
        `(${d.parameter.hari} hari), penyangga ${d.parameter.penyangga} hari, cakupan ${d.parameter.cakupan} hari`,
      meta: [
        ['Produk perlu dibeli', d.ringkas.produkDisarankan],
        ['Nilai saran pembelian', d.ringkas.totalSaran],
        ['Produk diam (jangan dibeli lagi)', d.ringkas.diam.produk],
      ],
    };
  },
});

module.exports = router;
module.exports.ambilSaran = ambilSaran;
