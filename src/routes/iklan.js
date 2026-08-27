'use strict';
/**
 * Biaya iklan & pemasaran per akun toko.
 *
 * Iklan tidak dibebankan ke pesanan. Satu kampanye menarik banyak order
 * sekaligus, sebagian tidak menghasilkan order sama sekali, dan sebagian
 * hasilnya baru muncul berhari-hari kemudian — membaginya rata ke tiap pesanan
 * akan membuat margin per pesanan tampak pasti padahal angkanya karangan.
 *
 * Karena itu biayanya dicatat sebagai baris tersendiri, lalu dibandingkan
 * dengan penjualan toko yang sama pada periode yang sama. Perbandingan itulah
 * yang menjawab pertanyaan sebenarnya: toko mana yang iklannya balik modal.
 */
const express = require('express');
const { z } = require('zod');
const { db } = require('../db');
const { requireAuth, butuhIzin } = require('../middleware/auth');
const { ah, parse, httpError, dateRange } = require('../utils/http');
const { r2, ACC, postJournal, deleteJournalsBySource } = require('../utils/accounting');
const { CHANNELS, CHANNEL_LABEL } = require('../utils/kanal');
const { daftarkanEkspor } = require('../utils/ekspor');
const { todayLocal } = require('../utils/time');

const router = express.Router();
router.use(requireAuth);

const spendSchema = z.object({
  spend_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).default(() => todayLocal()),
  shop_id: z.number().int().positive().optional().nullable(),
  channel: z.enum(CHANNELS),
  platform: z.string().trim().max(60).optional().nullable(),
  amount: z.number().positive('nilai iklan harus lebih dari 0'),
  payment: z.enum(['CASH', 'BANK', 'CREDIT']).default('BANK'),
  note: z.string().trim().max(300).optional().nullable(),
});

/** Akun lawan sesuai sumber dananya. Kredit berarti tagihan platform belum dibayar. */
const akunLawan = (payment) =>
  payment === 'CASH' ? ACC.CASH : payment === 'CREDIT' ? ACC.AP : ACC.BANK;

const simpanBelanja = db.transaction((body, userId) => {
  if (body.shop_id) {
    const toko = db.prepare('SELECT id, channel FROM shops WHERE id = ?').get(body.shop_id);
    if (!toko) throw httpError(404, 'Toko tidak ditemukan');
  }

  const info = db
    .prepare(
      `INSERT INTO ad_spends (spend_date, shop_id, channel, platform, amount, payment, note, user_id)
       VALUES (?,?,?,?,?,?,?,?)`
    )
    .run(
      body.spend_date, body.shop_id || null, body.channel,
      body.platform || null, r2(body.amount), body.payment, body.note || null, userId
    );

  const id = info.lastInsertRowid;
  postJournal({
    date: body.spend_date,
    description: `Biaya iklan ${CHANNEL_LABEL[body.channel] || body.channel}${body.platform ? ` — ${body.platform}` : ''}`,
    lines: [
      { code: ACC.FEE_ADS, debit: r2(body.amount), credit: 0, memo: body.note || 'Belanja iklan' },
      { code: akunLawan(body.payment), debit: 0, credit: r2(body.amount), memo: 'Pembayaran iklan' },
    ],
    source: 'ADS',
    sourceId: id,
    userId,
  });

  return id;
});

router.post('/', butuhIzin('iklan.kelola'), ah((req, res) => {
  const body = parse(spendSchema, req.body);
  const id = simpanBelanja(body, req.user.id);
  res.status(201).json({
    ok: true,
    message: `Biaya iklan Rp ${r2(body.amount).toLocaleString('id-ID')} tercatat`,
    spend: db.prepare('SELECT * FROM ad_spends WHERE id = ?').get(id),
  });
}));

const ubahBelanja = db.transaction((id, body, userId) => {
  const lama = db.prepare('SELECT * FROM ad_spends WHERE id = ?').get(id);
  if (!lama) throw httpError(404, 'Catatan iklan tidak ditemukan');

  db.prepare(
    `UPDATE ad_spends SET spend_date=?, shop_id=?, channel=?, platform=?, amount=?, payment=?, note=?
      WHERE id=?`
  ).run(
    body.spend_date, body.shop_id || null, body.channel,
    body.platform || null, r2(body.amount), body.payment, body.note || null, id
  );

  // Jurnal ditulis ulang seluruhnya: nilai dan akun lawannya sama-sama bisa
  // berubah, dan menambal selisihnya meninggalkan jejak yang sulit dibaca.
  deleteJournalsBySource('ADS', id);
  postJournal({
    date: body.spend_date,
    description: `Biaya iklan ${CHANNEL_LABEL[body.channel] || body.channel}${body.platform ? ` — ${body.platform}` : ''}`,
    lines: [
      { code: ACC.FEE_ADS, debit: r2(body.amount), credit: 0, memo: body.note || 'Belanja iklan' },
      { code: akunLawan(body.payment), debit: 0, credit: r2(body.amount), memo: 'Pembayaran iklan' },
    ],
    source: 'ADS',
    sourceId: id,
    userId,
  });
});

router.put('/:id(\\d+)', butuhIzin('iklan.kelola'), ah((req, res) => {
  const body = parse(spendSchema, req.body);
  ubahBelanja(Number(req.params.id), body, req.user.id);
  res.json({ ok: true, message: 'Biaya iklan diperbarui', spend: db.prepare('SELECT * FROM ad_spends WHERE id = ?').get(req.params.id) });
}));

const hapusBelanja = db.transaction((id) => {
  const ada = db.prepare('SELECT * FROM ad_spends WHERE id = ?').get(id);
  if (!ada) throw httpError(404, 'Catatan iklan tidak ditemukan');
  deleteJournalsBySource('ADS', id);
  db.prepare('DELETE FROM ad_spends WHERE id = ?').run(id);
  return ada;
});

router.delete('/:id(\\d+)', butuhIzin('iklan.kelola'), ah((req, res) => {
  const ada = hapusBelanja(Number(req.params.id));
  res.json({ ok: true, message: `Biaya iklan ${ada.spend_date} dihapus beserta jurnalnya` });
}));

/**
 * Ringkasan iklan berikut hasil penjualan toko pada periode yang sama.
 *
 * Angka yang dicari bukan sekadar berapa yang dibelanjakan, melainkan apakah
 * belanja itu kembali: berapa laba yang tersisa setelah iklan, dan berapa
 * rupiah penjualan yang dihasilkan tiap rupiah iklan (ROAS).
 */
function ringkasan(req) {
  const { from, to } = dateRange(req.query);

  const baris = db
    .prepare(
      `SELECT a.*, s.name AS shop_name, u.name AS user_name
         FROM ad_spends a
         LEFT JOIN shops s ON s.id = a.shop_id
         LEFT JOIN users u ON u.id = a.user_id
        WHERE a.spend_date BETWEEN ? AND ?
        ORDER BY a.spend_date DESC, a.id DESC`
    )
    .all(from, to)
    .map((b) => ({ ...b, channel_label: CHANNEL_LABEL[b.channel] || b.channel }));

  const totalIklan = r2(baris.reduce((s, b) => s + b.amount, 0));

  // Penjualan per toko pada periode yang sama — dasar pembanding.
  const jual = db
    .prepare(
      `SELECT o.shop_id,
              COUNT(*) AS orders,
              COALESCE(SUM(o.net_revenue), 0) AS net_revenue,
              COALESCE(SUM(o.total_fees), 0)  AS total_fees,
              COALESCE(SUM(o.net_profit), 0)  AS net_profit
         FROM sales_orders o
        WHERE o.status = 'POSTED' AND o.order_date BETWEEN ? AND ?
        GROUP BY o.shop_id`
    )
    .all(from, to);
  const jualPerToko = new Map(jual.map((j) => [j.shop_id, j]));

  const iklanPerToko = new Map();
  for (const b of baris) {
    const kunci = b.shop_id || 0;
    const c = iklanPerToko.get(kunci) || {
      shop_id: b.shop_id, shop_name: b.shop_name || 'Tanpa toko',
      channel: b.channel, channel_label: b.channel_label, iklan: 0, jumlahCatatan: 0,
    };
    c.iklan = r2(c.iklan + b.amount);
    c.jumlahCatatan += 1;
    iklanPerToko.set(kunci, c);
  }

  // Toko yang berjualan tetapi belum ada catatan iklannya tetap ditampilkan.
  // Tanpa itu, toko yang beriklan lewat jalur lain terlihat seolah tidak ada.
  for (const j of jual) {
    const kunci = j.shop_id || 0;
    if (iklanPerToko.has(kunci)) continue;
    const toko = j.shop_id ? db.prepare('SELECT name, channel FROM shops WHERE id = ?').get(j.shop_id) : null;
    iklanPerToko.set(kunci, {
      shop_id: j.shop_id,
      shop_name: toko ? toko.name : 'Tanpa toko',
      channel: toko ? toko.channel : null,
      channel_label: toko ? CHANNEL_LABEL[toko.channel] || toko.channel : '-',
      iklan: 0,
      jumlahCatatan: 0,
    });
  }

  const perToko = [...iklanPerToko.values()].map((t) => {
    const j = jualPerToko.get(t.shop_id) || { orders: 0, net_revenue: 0, total_fees: 0, net_profit: 0 };
    const pendapatanKotor = r2(j.net_revenue);
    const labaSebelumIklan = r2(j.net_profit);
    const labaSetelahIklan = r2(labaSebelumIklan - t.iklan);
    return {
      ...t,
      orders: j.orders,
      pendapatanKotor,
      pendapatanBersih: r2(j.net_revenue - j.total_fees),
      labaSebelumIklan,
      labaSetelahIklan,
      // ROAS: tiap Rp 1 iklan menghasilkan berapa rupiah penjualan.
      roas: t.iklan > 0 ? r2(pendapatanKotor / t.iklan) : null,
      // Porsi iklan terhadap penjualan — makin besar makin tipis sisanya.
      rasioIklanPct: pendapatanKotor > 0 ? r2((t.iklan / pendapatanKotor) * 100) : null,
      marginSetelahIklanPct: pendapatanKotor > 0 ? r2((labaSetelahIklan / pendapatanKotor) * 100) : null,
    };
  }).sort((a, b) => b.iklan - a.iklan || b.pendapatanKotor - a.pendapatanKotor);

  const perPlatform = [...baris.reduce((m, b) => {
    const k = b.platform || 'Tidak disebut';
    m.set(k, r2((m.get(k) || 0) + b.amount));
    return m;
  }, new Map())].map(([platform, iklan]) => ({ platform, iklan }))
    .sort((a, b) => b.iklan - a.iklan);

  const harian = db
    .prepare(
      `SELECT spend_date AS date, COALESCE(SUM(amount), 0) AS iklan
         FROM ad_spends WHERE spend_date BETWEEN ? AND ?
        GROUP BY spend_date ORDER BY spend_date`
    )
    .all(from, to)
    .map((h) => ({ ...h, iklan: r2(h.iklan) }));

  const totalPenjualan = jual.reduce(
    (s, j) => ({
      pendapatanKotor: s.pendapatanKotor + j.net_revenue,
      pendapatanBersih: s.pendapatanBersih + (j.net_revenue - j.total_fees),
      laba: s.laba + j.net_profit,
      orders: s.orders + j.orders,
    }),
    { pendapatanKotor: 0, pendapatanBersih: 0, laba: 0, orders: 0 }
  );

  return {
    from, to, rows: baris,
    ringkas: {
      totalIklan,
      jumlahCatatan: baris.length,
      pendapatanKotor: r2(totalPenjualan.pendapatanKotor),
      pendapatanBersih: r2(totalPenjualan.pendapatanBersih),
      labaSebelumIklan: r2(totalPenjualan.laba),
      labaSetelahIklan: r2(totalPenjualan.laba - totalIklan),
      roas: totalIklan > 0 ? r2(totalPenjualan.pendapatanKotor / totalIklan) : null,
      rasioIklanPct: totalPenjualan.pendapatanKotor > 0
        ? r2((totalIklan / totalPenjualan.pendapatanKotor) * 100)
        : null,
    },
    perToko,
    perPlatform,
    harian,
  };
}

router.get('/', ah((req, res) => res.json(ringkasan(req))));

daftarkanEkspor(router, {
  path: '/',
  judul: 'Biaya Iklan & Pemasaran',
  kolom: [
    { header: 'Tanggal', key: 'spend_date', width: 12 },
    { header: 'Toko', key: 'shop_name', width: 24 },
    { header: 'Channel', key: 'channel_label', width: 20 },
    { header: 'Platform Iklan', key: 'platform', width: 18 },
    { header: 'Nilai', key: 'amount', width: 16, money: true },
    { header: 'Sumber Dana', key: 'payment', width: 12 },
    { header: 'Catatan', key: 'note', width: 34 },
    { header: 'Dicatat Oleh', key: 'user_name', width: 18 },
  ],
  ambil: (req) => {
    const d = ringkasan(req);
    return {
      rows: d.rows,
      subtitle: `Periode ${d.from} s/d ${d.to}`,
      meta: [
        ['Total belanja iklan', d.ringkas.totalIklan],
        ['Pendapatan kotor', d.ringkas.pendapatanKotor],
        ['Laba sebelum iklan', d.ringkas.labaSebelumIklan],
        ['Laba setelah iklan', d.ringkas.labaSetelahIklan],
        ['ROAS', d.ringkas.roas ?? '-'],
      ],
    };
  },
});

module.exports = { router, ringkasan };
