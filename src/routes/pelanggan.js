'use strict';
/**
 * Analisis pelanggan & pembelian berulang.
 *
 * Data pembeli sudah dikumpulkan pada tiap order sejak awal — nama, kota,
 * kanal — tetapi belum pernah dibaca balik. Padahal di situlah satu-satunya
 * pertanyaan yang bisa menaikkan penjualan tanpa menambah biaya iklan:
 * siapa yang sudah pernah beli, dan siapa yang berhenti.
 *
 * CARA PEMBELI DIKENALI — dan batasnya.
 *
 * Nomor HP hampir tidak pernah terisi pada order marketplace, jadi yang
 * dipakai adalah namanya. Ini bekerja, tetapi tidak sempurna dan tidak boleh
 * dipura-purakan sempurna:
 *
 *   - Orang yang sama dengan nama tertulis berbeda ("Budi S" dan "Budi
 *     Santoso") terhitung dua orang.
 *   - Dua orang berbeda bernama sama terhitung satu.
 *
 * Karena itu angkanya disajikan sebagai petunjuk arah, bukan kebenaran mutlak,
 * dan layarnya menyebutkan hal ini terang-terangan. Nomor HP dipakai lebih
 * dulu bila ada, karena ia jauh lebih jarang keliru.
 *
 * Riwayatnya dihitung dari SELURUH waktu, bukan dari rentang yang sedang
 * dilihat. Pelanggan yang berhenti membeli justru tidak muncul di rentang mana
 * pun yang baru — dan merekalah yang paling perlu ditemukan.
 */
const express = require('express');
const { z } = require('zod');
const { db, getSetting, setSetting } = require('../db');
const { requireAuth, butuhIzin } = require('../middleware/auth');
const { ah, parse } = require('../utils/http');
const { r2 } = require('../utils/accounting');
const { daftarkanEkspor } = require('../utils/ekspor');
const { todayLocal } = require('../utils/time');

const router = express.Router();
router.use(requireAuth);

/** Batas hari bawaan: masih aktif, mulai tidur, dan dianggap hilang. */
const BAWAAN = { aktif: 60, hilang: 180 };

const angka = (v, bawaan, min, maks) => {
  const n = Number(v);
  return Number.isFinite(n) && n >= min && n <= maks ? n : bawaan;
};

/**
 * Kunci pengenal pembeli.
 *
 * Nomor HP menang bila ada — ia jauh lebih jarang keliru daripada nama. Nama
 * dirapikan seadanya (huruf kecil, spasi ganda dirapatkan) supaya "BUDI  S"
 * dan "Budi S" tidak terhitung dua orang; lebih dari itu tidak dilakukan,
 * karena menebak-nebak kemiripan nama justru menggabungkan orang yang berbeda.
 */
function kunciPembeli(o) {
  const hp = String(o.buyer_phone || '').replace(/[^0-9]/g, '');
  if (hp.length >= 8) return `hp:${hp}`;

  const nama = String(o.buyer_name || o.customer || '').trim().toLowerCase().replace(/\s+/g, ' ');
  return nama ? `nama:${nama}` : null;
}

/**
 * Titik kirim internal marketplace — terlihat seperti pelanggan, padahal bukan.
 *
 * Shopee mengirim sebagian pesanan lewat hub sortirnya sendiri, dan namanya
 * masuk ke kolom pembeli apa adanya: "Semarang RDC - Pengiriman SPX". Satu hub
 * bisa muncul ratusan kali, sehingga ia menjadi "pelanggan berulang" terbesar
 * dan menggelembungkan angka pembelian berulang seluruh toko.
 *
 * Yang dikecualikan TIDAK dibuang diam-diam: jumlah, omzet, dan daftarnya tetap
 * ditampilkan. Angka yang hilang tanpa penjelasan lebih meresahkan daripada
 * angka yang salah — orang akan menghabiskan waktu mencarinya.
 *
 * Daftar katanya bisa diubah lewat layar, karena tiap marketplace menamai
 * hubnya sendiri-sendiri dan namanya berganti tanpa memberi tahu siapa pun.
 */
const KUNCI_HUB = 'pelanggan_hub_internal';
const HUB_BAWAAN = ['RDC', 'SPX', 'SORTIR', 'HUB'];

function daftarHub() {
  const isi = getSetting(KUNCI_HUB, null);
  if (isi == null) return [...HUB_BAWAAN];
  try {
    const arr = JSON.parse(isi);
    if (!Array.isArray(arr)) return [...HUB_BAWAAN];
    return arr.map((x) => String(x).trim()).filter(Boolean);
  } catch {
    return [...HUB_BAWAAN];
  }
}

const lolosRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Dicocokkan sebagai KATA UTUH, bukan potongan huruf di tengah nama.
 *
 * "RDC" sebagai potongan akan ikut mengenai nama orang seperti "Firdaus", dan
 * pelanggan sungguhan yang hilang dari daftar jauh lebih merugikan daripada
 * satu hub yang lolos.
 */
function penyaringHub(kata) {
  if (!kata.length) return () => false;
  const re = new RegExp(`(^|[^a-z0-9])(${kata.map(lolosRegex).join('|')})([^a-z0-9]|$)`, 'i');
  return (nama) => re.test(String(nama || ''));
}

function ambilPelanggan(req) {
  const q = (req && req.query) || {};
  const aktif = angka(q.aktif, BAWAAN.aktif, 7, 365);
  const hilang = angka(q.hilang, BAWAAN.hilang, aktif + 1, 730);
  const hariIni = todayLocal();

  const orders = db
    .prepare(
      `SELECT o.id, o.order_date, o.buyer_name, o.buyer_phone, o.customer,
              o.buyer_city, o.channel, o.net_revenue, o.total_fees, o.net_profit
         FROM sales_orders o
        WHERE o.status = 'POSTED' AND o.fulfillment_status <> 'BATAL'
        ORDER BY o.order_date`
    )
    .all();

  const peta = new Map();
  let tanpaIdentitas = 0;

  for (const o of orders) {
    const k = kunciPembeli(o);
    if (!k) { tanpaIdentitas += 1; continue; }

    if (!peta.has(k)) {
      peta.set(k, {
        kunci: k,
        nama: (o.buyer_name || o.customer || '').trim(),
        kota: o.buyer_city || null,
        channel: o.channel,
        orders: 0,
        omzet: 0,
        laba: 0,
        pertama: o.order_date,
        terakhir: o.order_date,
      });
    }

    const p = peta.get(k);
    p.orders += 1;
    p.omzet = r2(p.omzet + (o.net_revenue || 0));
    p.laba = r2(p.laba + (o.net_profit || 0));
    if (o.order_date < p.pertama) p.pertama = o.order_date;
    if (o.order_date > p.terakhir) {
      p.terakhir = o.order_date;
      // Kota dan kanal diambil dari order TERAKHIR: orang pindah rumah dan
      // berpindah marketplace, dan yang berguna untuk menghubunginya lagi
      // adalah yang terbaru.
      p.kota = o.buyer_city || p.kota;
      p.channel = o.channel;
    }
  }

  const selisihHari = (a, b) => Math.floor((new Date(b) - new Date(a)) / 86400000);

  const kataHub = daftarHub();
  const adalahHub = penyaringHub(kataHub);

  const semua = [...peta.values()].map((p) => {
    const jeda = selisihHari(p.terakhir, hariIni);
    const umur = selisihHari(p.pertama, hariIni);

    let status;
    if (jeda <= aktif) status = p.orders > 1 ? 'BERULANG' : 'BARU';
    else if (jeda <= hilang) status = 'TIDUR';
    else status = 'HILANG';

    return {
      ...p,
      hariSejakTerakhir: jeda,
      umurHari: umur,
      berulang: p.orders > 1,
      rataOrder: r2(p.omzet / p.orders),
      // Jarak rata-rata antar pembelian. Hanya bermakna bagi yang sudah beli
      // lebih dari sekali; bagi yang baru sekali, tidak ada jaraknya.
      jedaRataHari: p.orders > 1 ? Math.round(selisihHari(p.pertama, p.terakhir) / (p.orders - 1)) : null,
      status,
      internal: adalahHub(p.nama),
    };
  });

  const hub = semua.filter((x) => x.internal).sort((a, b) => b.omzet - a.omzet);
  const rows = semua.filter((x) => !x.internal);

  rows.sort((a, b) => b.omzet - a.omzet);

  const per = (st) => rows.filter((r) => r.status === st);
  const jum = (arr, f) => r2(arr.reduce((s, x) => s + f(x), 0));
  const berulang = rows.filter((r) => r.berulang);

  return {
    parameter: { aktif, hilang, hariIni },
    rows,
    ringkas: {
      pelanggan: rows.length,
      tanpaIdentitas,
      // Inti nilainya: pelanggan berulang biasanya jauh lebih murah dilayani
      // daripada mencari yang baru, dan porsinya menunjukkan seberapa besar
      // penjualan bertumpu pada iklan.
      berulang: {
        pelanggan: berulang.length,
        persen: rows.length ? r2((berulang.length / rows.length) * 100) : 0,
        omzet: jum(berulang, (r) => r.omzet),
      },
      baru: { pelanggan: per('BARU').length, omzet: jum(per('BARU'), (r) => r.omzet) },
      // Yang paling bernilai untuk ditindak: sudah pernah beli, lalu berhenti.
      tidur: {
        pelanggan: per('TIDUR').length,
        omzet: jum(per('TIDUR'), (r) => r.omzet),
        berulang: per('TIDUR').filter((r) => r.berulang).length,
      },
      hilang: { pelanggan: per('HILANG').length, omzet: jum(per('HILANG'), (r) => r.omzet) },
      omzetTotal: jum(rows, (r) => r.omzet),
      rataOrderPerPelanggan: rows.length ? r2(rows.reduce((s, r) => s + r.orders, 0) / rows.length) : 0,
      nilaiRataPelanggan: rows.length ? r2(jum(rows, (r) => r.omzet) / rows.length) : 0,
    },
    hubInternal: {
      kata: kataHub,
      jumlah: hub.length,
      orders: hub.reduce((s, x) => s + x.orders, 0),
      omzet: jum(hub, (x) => x.omzet),
      daftar: hub.slice(0, 20).map((x) => ({
        kunci: x.kunci, nama: x.nama, kota: x.kota, orders: x.orders, omzet: x.omzet,
      })),
    },
    wilayah: ringkasWilayah(rows),
  };
}

/**
 * Sebaran pelanggan per wilayah.
 *
 * Isinya apa adanya sesuai yang diketik tim — sebagian provinsi, sebagian
 * kota. Tidak dirapikan menjadi satu tingkatan, karena menebak "Semarang"
 * masuk "Jawa Tengah" berarti mengarang data yang tidak pernah dimasukkan.
 * Yang bisa dilakukan adalah menampilkannya jujur, dan itu sudah cukup untuk
 * melihat di mana pasarnya menumpuk.
 */
function ringkasWilayah(rows) {
  const peta = new Map();
  for (const r of rows) {
    const k = (r.kota || '').trim() || '(tidak diisi)';
    if (!peta.has(k)) peta.set(k, { wilayah: k, pelanggan: 0, orders: 0, omzet: 0, berulang: 0 });
    const w = peta.get(k);
    w.pelanggan += 1;
    w.orders += r.orders;
    w.omzet = r2(w.omzet + r.omzet);
    if (r.berulang) w.berulang += 1;
  }
  return [...peta.values()].sort((a, b) => b.omzet - a.omzet);
}

router.get('/', butuhIzin('penjualan.lihat'), ah((req, res) => res.json(ambilPelanggan(req))));

router.get('/hub', butuhIzin('penjualan.lihat'), ah((req, res) =>
  res.json({ kata: daftarHub(), bawaan: HUB_BAWAAN })));

const hubSchema = z.object({
  // Minimal dua huruf: satu huruf akan mengenai hampir semua nama sekaligus,
  // dan pemakainya baru sadar setelah daftar pelanggannya nyaris kosong.
  kata: z.array(z.string().trim().min(2, 'kata penanda minimal 2 huruf').max(40)).max(30),
});

router.put('/hub', butuhIzin('penjualan.ubah'), ah((req, res) => {
  const body = parse(hubSchema, req.body);
  const kata = [...new Set(body.kata.map((k) => k.trim()).filter(Boolean))];
  setSetting(KUNCI_HUB, JSON.stringify(kata));
  res.json({
    ok: true,
    kata,
    message: kata.length
      ? `${kata.length} kata penanda titik kirim internal disimpan`
      : 'Tidak ada yang dikecualikan — semua nama dihitung sebagai pelanggan',
  });
}));

daftarkanEkspor(router, {
  path: '/',
  judul: 'Analisis Pelanggan',
  kolom: [
    { header: 'Nama Pembeli', key: 'nama', width: 30 },
    { header: 'Wilayah', key: 'kota', width: 22 },
    { header: 'Kanal Terakhir', key: 'channel', width: 16 },
    { header: 'Jumlah Order', key: 'orders', width: 13 },
    { header: 'Total Omzet', key: 'omzet', width: 18, money: true },
    { header: 'Rata per Order', key: 'rataOrder', width: 18, money: true },
    { header: 'Pertama Beli', key: 'pertama', width: 14 },
    { header: 'Terakhir Beli', key: 'terakhir', width: 14 },
    { header: 'Hari Sejak Terakhir', key: 'hariSejakTerakhir', width: 18 },
    { header: 'Status', key: 'status', width: 12 },
  ],
  ambil: (req) => {
    const d = ambilPelanggan(req);
    return {
      rows: d.rows,
      subtitle:
        `Riwayat seluruh waktu · aktif ${d.parameter.aktif} hari, hilang di atas ${d.parameter.hilang} hari. ` +
        'Pembeli dikenali dari namanya, jadi nama yang tertulis berbeda terhitung orang berbeda.',
      meta: [
        ['Pelanggan teridentifikasi', d.ringkas.pelanggan],
        ['Pernah beli berulang', `${d.ringkas.berulang.pelanggan} (${d.ringkas.berulang.persen}%)`],
        ['Tidur — pernah beli lalu berhenti', d.ringkas.tidur.pelanggan],
        ['Order tanpa identitas pembeli', d.ringkas.tanpaIdentitas],
        ['Titik kirim internal dikecualikan', `${d.hubInternal.jumlah} nama, ${d.hubInternal.orders} order`],
      ],
    };
  },
});

module.exports = router;
module.exports.ambilPelanggan = ambilPelanggan;
