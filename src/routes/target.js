'use strict';
/**
 * Target bulanan & pencapaian.
 *
 * Yang disimpan hanya targetnya. Realisasinya tidak pernah dicatat di tabel ini
 * melainkan dihitung ulang dari order penjualan dan belanja iklan setiap kali
 * dibuka — kalau angka pencapaian punya salinannya sendiri, cepat atau lambat
 * ia akan berbeda dari laporan penjualan, dan tidak akan ada yang tahu mana
 * yang benar.
 *
 * Istilahnya sengaja disamakan dengan menu Biaya Iklan: pendapatan kotor adalah
 * pendapatan bersih penjualan sebelum iklan, dan laba yang dikejar adalah laba
 * setelah belanja iklan dipotong — itu yang benar-benar tersisa.
 */
const express = require('express');
const { z } = require('zod');
const { db } = require('../db');
const { requireAuth, butuhIzin } = require('../middleware/auth');
const { ah, parse, httpError } = require('../utils/http');
const { r2 } = require('../utils/accounting');
const { CHANNEL_LABEL } = require('../utils/kanal');
const { daftarkanEkspor } = require('../utils/ekspor');
const { todayLocal } = require('../utils/time');

const router = express.Router();
router.use(requireAuth);

const PERIODE = /^\d{4}-\d{2}$/;

const targetSchema = z.object({
  period: z.string().regex(PERIODE, 'periode harus berbentuk YYYY-MM'),
  shop_id: z.number().int().positive().optional().nullable(),
  omzet: z.number().min(0).default(0),
  laba: z.number().min(0).default(0),
  orders: z.number().min(0).default(0),
  budget_iklan: z.number().min(0).default(0),
  note: z.string().trim().max(300).optional().nullable(),
});

const periodeIni = () => todayLocal().slice(0, 7);

/** Jumlah hari pada sebuah bulan, dan berapa yang sudah lewat. */
function hariBulan(period, hariIni) {
  const [th, bl] = period.split('-').map(Number);
  const total = new Date(Date.UTC(th, bl, 0)).getUTCDate();
  const sekarang = hariIni.slice(0, 7);
  // Bulan yang sudah lewat dihitung penuh; bulan yang belum datang belum
  // berjalan sama sekali. Hanya bulan berjalan yang separuh jalan.
  if (sekarang > period) return { total, lewat: total, berjalan: false };
  if (sekarang < period) return { total, lewat: 0, berjalan: false };
  return { total, lewat: Number(hariIni.slice(8, 10)), berjalan: true };
}

const batas = (period) => ({ from: `${period}-01`, to: `${period}-31` });

/**
 * Pencapaian satu periode.
 *
 * Setiap toko muncul walau belum punya target — toko yang belum diberi sasaran
 * justru yang paling mudah terlewat, dan menyembunyikannya membuat jumlah di
 * baris perusahaan tidak pernah cocok dengan jumlah barisnya.
 */
function ambilPencapaian(req) {
  const period = PERIODE.test(String(req.query.period || '')) ? req.query.period : periodeIni();
  const { from, to } = batas(period);
  const hariIni = todayLocal();
  const hari = hariBulan(period, hariIni);

  const jual = new Map(
    db
      .prepare(
        `SELECT shop_id,
                COUNT(*)                        AS orders,
                COALESCE(SUM(net_revenue), 0)   AS pendapatan,
                COALESCE(SUM(net_profit), 0)    AS laba
           FROM sales_orders
          WHERE order_date BETWEEN ? AND ? AND status = 'POSTED'
          GROUP BY shop_id`
      )
      .all(from, to)
      .map((r) => [r.shop_id, r])
  );

  const iklan = new Map(
    db
      .prepare(
        `SELECT shop_id, COALESCE(SUM(amount), 0) AS iklan
           FROM ad_spends
          WHERE spend_date BETWEEN ? AND ?
          GROUP BY shop_id`
      )
      .all(from, to)
      .map((r) => [r.shop_id, r.iklan])
  );

  const targets = new Map(
    db.prepare('SELECT * FROM targets WHERE period = ?').all(period)
      .map((t) => [t.shop_id === null ? 0 : t.shop_id, t])
  );

  const toko = db.prepare('SELECT id, name, channel, active FROM shops ORDER BY name').all();

  /** Satu baris pencapaian: target di kiri, kenyataan di kanan. */
  const susun = (nama, kunci, t, real) => {
    const labaSetelahIklan = r2(real.laba - real.iklan);
    const capai = (nyata, sasaran) => (sasaran > 0 ? r2((nyata / sasaran) * 100) : null);

    // Perkiraan akhir bulan bila laju hari-hari yang sudah lewat diteruskan.
    // Hanya masuk akal untuk bulan yang sedang berjalan; bulan yang sudah
    // selesai tidak punya sisa hari untuk diproyeksikan.
    const proyeksi = (nyata) =>
      hari.berjalan && hari.lewat > 0 ? r2((nyata / hari.lewat) * hari.total) : null;

    const sisaHari = hari.berjalan ? Math.max(0, hari.total - hari.lewat) : 0;
    const kurang = (nyata, sasaran) => (sasaran > nyata ? r2(sasaran - nyata) : 0);
    const perHari = (nyata, sasaran) =>
      sisaHari > 0 && sasaran > nyata ? r2((sasaran - nyata) / sisaHari) : null;

    return {
      kunci,
      nama,
      target_id: t ? t.id : null,
      target: {
        omzet: t ? r2(t.omzet) : 0,
        laba: t ? r2(t.laba) : 0,
        orders: t ? r2(t.orders) : 0,
        budget_iklan: t ? r2(t.budget_iklan) : 0,
        note: t ? t.note : null,
      },
      realisasi: {
        omzet: r2(real.pendapatan),
        laba: labaSetelahIklan,
        labaSebelumIklan: r2(real.laba),
        orders: real.orders,
        iklan: r2(real.iklan),
      },
      capai: {
        omzet: t ? capai(real.pendapatan, t.omzet) : null,
        laba: t ? capai(labaSetelahIklan, t.laba) : null,
        orders: t ? capai(real.orders, t.orders) : null,
        // Iklan adalah batas, bukan sasaran: 100% berarti anggaran habis.
        iklan: t ? capai(real.iklan, t.budget_iklan) : null,
      },
      proyeksi: {
        omzet: proyeksi(real.pendapatan),
        laba: proyeksi(labaSetelahIklan),
        orders: proyeksi(real.orders),
        iklan: proyeksi(real.iklan),
      },
      kurang: t
        ? {
            omzet: kurang(real.pendapatan, t.omzet),
            laba: kurang(labaSetelahIklan, t.laba),
            orders: kurang(real.orders, t.orders),
          }
        : null,
      perHari: t
        ? {
            omzet: perHari(real.pendapatan, t.omzet),
            orders: perHari(real.orders, t.orders),
          }
        : null,
      // Anggaran iklan yang sudah terlampaui perlu terlihat tanpa dicari.
      iklanLewatBatas: !!(t && t.budget_iklan > 0 && real.iklan > t.budget_iklan),
      punyaTarget: !!t,
    };
  };

  const kosong = () => ({ orders: 0, pendapatan: 0, laba: 0, iklan: 0 });

  const rows = toko.map((s) => {
    const j = jual.get(s.id) || {};
    const real = {
      orders: j.orders || 0,
      pendapatan: j.pendapatan || 0,
      laba: j.laba || 0,
      iklan: iklan.get(s.id) || 0,
    };
    const baris = susun(s.name, s.id, targets.get(s.id), real);
    baris.channel = s.channel;
    baris.channelLabel = CHANNEL_LABEL[s.channel] || s.channel;
    baris.active = !!s.active;
    return baris;
  });

  // Order dan iklan yang tidak menunjuk toko mana pun tetap harus terhitung,
  // kalau tidak jumlah perusahaan akan lebih kecil daripada kenyataannya.
  const lepas = kosong();
  const jLepas = jual.get(null);
  if (jLepas) {
    lepas.orders = jLepas.orders;
    lepas.pendapatan = jLepas.pendapatan;
    lepas.laba = jLepas.laba;
  }
  lepas.iklan = iklan.get(null) || 0;
  const adaLepas = lepas.orders > 0 || lepas.iklan > 0;
  if (adaLepas) {
    const baris = susun('Tanpa toko', 'lepas', null, lepas);
    baris.channelLabel = 'tidak ditautkan ke toko';
    baris.active = true;
    rows.push(baris);
  }

  const seluruh = [...rows].reduce((a, r) => {
    a.orders += r.realisasi.orders;
    a.pendapatan += r.realisasi.omzet;
    a.laba += r.realisasi.labaSebelumIklan;
    a.iklan += r.realisasi.iklan;
    return a;
  }, kosong());

  const perusahaan = susun('Seluruh Perusahaan', 0, targets.get(0), seluruh);
  perusahaan.channelLabel = 'gabungan semua toko';
  perusahaan.active = true;

  // Bila target perusahaan belum diisi, jumlah target tiap toko dipakai sebagai
  // pembanding — lebih berguna daripada tidak menampilkan apa pun, tetapi harus
  // ditandai supaya tidak dikira angka yang memang ditetapkan.
  const jumlahTargetToko = rows.reduce(
    (a, r) => {
      a.omzet += r.target.omzet;
      a.laba += r.target.laba;
      a.orders += r.target.orders;
      a.budget_iklan += r.target.budget_iklan;
      return a;
    },
    { omzet: 0, laba: 0, orders: 0, budget_iklan: 0 }
  );
  perusahaan.targetTokoDijumlah = {
    omzet: r2(jumlahTargetToko.omzet),
    laba: r2(jumlahTargetToko.laba),
    orders: r2(jumlahTargetToko.orders),
    budget_iklan: r2(jumlahTargetToko.budget_iklan),
  };
  perusahaan.selisihDenganToko = perusahaan.punyaTarget
    ? r2(perusahaan.target.omzet - jumlahTargetToko.omzet)
    : null;

  const periodeAda = db
    .prepare('SELECT DISTINCT period FROM targets ORDER BY period DESC')
    .all()
    .map((r) => r.period);

  return { period, hari, hariIni, rows, perusahaan, periodeAda };
}

router.get('/', ah((req, res) => res.json(ambilPencapaian(req))));

const simpanTarget = db.transaction((body, userId) => {
  if (body.shop_id) {
    const toko = db.prepare('SELECT id FROM shops WHERE id = ?').get(body.shop_id);
    if (!toko) throw httpError(404, 'Toko tidak ditemukan');
  }

  const ada = db
    .prepare('SELECT id FROM targets WHERE period = ? AND IFNULL(shop_id, 0) = ?')
    .get(body.period, body.shop_id || 0);

  if (ada) {
    db.prepare(
      `UPDATE targets
          SET omzet = ?, laba = ?, orders = ?, budget_iklan = ?, note = ?,
              user_id = ?, updated_at = datetime('now')
        WHERE id = ?`
    ).run(
      r2(body.omzet), r2(body.laba), r2(body.orders), r2(body.budget_iklan),
      body.note || null, userId, ada.id
    );
    return { id: ada.id, dibuat: false };
  }

  const info = db
    .prepare(
      `INSERT INTO targets (period, shop_id, omzet, laba, orders, budget_iklan, note, user_id)
       VALUES (?,?,?,?,?,?,?,?)`
    )
    .run(
      body.period, body.shop_id || null, r2(body.omzet), r2(body.laba),
      r2(body.orders), r2(body.budget_iklan), body.note || null, userId
    );
  return { id: info.lastInsertRowid, dibuat: true };
});

router.post('/', butuhIzin('target.kelola'), ah((req, res) => {
  const body = parse(targetSchema, req.body);
  const hasil = simpanTarget(body, req.user.id);
  const row = db.prepare('SELECT * FROM targets WHERE id = ?').get(hasil.id);
  res.status(hasil.dibuat ? 201 : 200).json({
    ok: true,
    target: row,
    message: hasil.dibuat ? 'Target disimpan' : 'Target diperbarui',
  });
}));

router.delete('/:id(\\d+)', butuhIzin('target.kelola'), ah((req, res) => {
  const row = db.prepare('SELECT * FROM targets WHERE id = ?').get(Number(req.params.id));
  if (!row) throw httpError(404, 'Target tidak ditemukan');
  db.prepare('DELETE FROM targets WHERE id = ?').run(row.id);
  res.json({ ok: true, message: `Target ${row.period} dihapus` });
}));

/**
 * Menyalin target bulan lain sebagai titik mulai.
 *
 * Menyusun target dari nol setiap bulan adalah pekerjaan yang jarang benar-benar
 * dikerjakan; yang lebih sering terjadi target tidak pernah diisi sama sekali.
 * Target yang sudah ada bisa ditumpuk hanya bila diminta secara tegas.
 */
const salinSchema = z.object({
  dari: z.string().regex(PERIODE),
  ke: z.string().regex(PERIODE),
  naikPersen: z.number().min(-100).max(1000).default(0),
  timpa: z.boolean().default(false),
});

router.post('/salin', butuhIzin('target.kelola'), ah((req, res) => {
  const body = parse(salinSchema, req.body);
  if (body.dari === body.ke) throw httpError(422, 'Bulan asal dan tujuan tidak boleh sama');

  const sumber = db.prepare('SELECT * FROM targets WHERE period = ?').all(body.dari);
  if (sumber.length === 0) throw httpError(404, `Belum ada target pada ${body.dari}`);

  const faktor = 1 + body.naikPersen / 100;
  let dibuat = 0;
  let diperbarui = 0;
  let dilewati = 0;

  db.transaction(() => {
    for (const t of sumber) {
      const ada = db
        .prepare('SELECT id FROM targets WHERE period = ? AND IFNULL(shop_id, 0) = ?')
        .get(body.ke, t.shop_id || 0);
      if (ada && !body.timpa) {
        dilewati += 1;
        continue;
      }
      const isi = {
        period: body.ke,
        shop_id: t.shop_id,
        omzet: r2(t.omzet * faktor),
        laba: r2(t.laba * faktor),
        orders: Math.round(t.orders * faktor),
        budget_iklan: r2(t.budget_iklan * faktor),
        note: t.note,
      };
      const hasil = simpanTarget(isi, req.user.id);
      if (hasil.dibuat) dibuat += 1;
      else diperbarui += 1;
    }
  })();

  res.json({
    ok: true,
    dibuat,
    diperbarui,
    dilewati,
    message:
      `${dibuat} target dibuat` +
      (diperbarui ? `, ${diperbarui} diperbarui` : '') +
      (dilewati ? `, ${dilewati} dilewati karena sudah ada` : ''),
  });
}));

daftarkanEkspor(router, {
  path: '/',
  judul: 'Target & Pencapaian',
  kolom: [
    { header: 'Toko', key: 'nama', width: 26 },
    { header: 'Channel', key: 'channelLabel', width: 16 },
    { header: 'Target Omzet', key: 'target_omzet', width: 16, money: true },
    { header: 'Realisasi Omzet', key: 'real_omzet', width: 16, money: true },
    { header: 'Capai Omzet', key: 'capai_omzet', width: 12, pct: true },
    { header: 'Target Laba', key: 'target_laba', width: 15, money: true },
    { header: 'Laba Setelah Iklan', key: 'real_laba', width: 17, money: true },
    { header: 'Capai Laba', key: 'capai_laba', width: 12, pct: true },
    { header: 'Target Order', key: 'target_orders', width: 12 },
    { header: 'Realisasi Order', key: 'real_orders', width: 14 },
    { header: 'Budget Iklan', key: 'target_iklan', width: 15, money: true },
    { header: 'Belanja Iklan', key: 'real_iklan', width: 15, money: true },
  ],
  ambil: (req) => {
    const d = ambilPencapaian(req);
    const rata = (r) => ({
      nama: r.nama,
      channelLabel: r.channelLabel || '',
      target_omzet: r.target.omzet,
      real_omzet: r.realisasi.omzet,
      capai_omzet: r.capai.omzet ?? 0,
      target_laba: r.target.laba,
      real_laba: r.realisasi.laba,
      capai_laba: r.capai.laba ?? 0,
      target_orders: r.target.orders,
      real_orders: r.realisasi.orders,
      target_iklan: r.target.budget_iklan,
      real_iklan: r.realisasi.iklan,
    });
    return {
      rows: [...d.rows.map(rata), rata(d.perusahaan)],
      subtitle: `Periode ${d.period} — ${d.hari.lewat} dari ${d.hari.total} hari`,
      meta: [
        ['Target omzet perusahaan', d.perusahaan.target.omzet],
        ['Realisasi omzet', d.perusahaan.realisasi.omzet],
        ['Laba setelah iklan', d.perusahaan.realisasi.laba],
        ['Belanja iklan', d.perusahaan.realisasi.iklan],
      ],
    };
  },
});

module.exports = router;
