'use strict';
const { daftarkanEkspor } = require('../utils/ekspor');
/**
 * Toko / akun marketplace.
 *
 * Satu perusahaan bisa punya banyak akun toko pada marketplace yang sama —
 * di data pengguna ada 8 toko Shopee dan 3 TikTok. Profitabilitas antar toko
 * bisa berbeda jauh, jadi toko diperlakukan sebagai dimensi tersendiri, bukan
 * sekadar teks pada order.
 */
const express = require('express');
const { z } = require('zod');
const { db } = require('../db');
const { requireAuth, butuhIzin } = require('../middleware/auth');
const { ah, parse, httpError, dateRange } = require('../utils/http');
const { r2 } = require('../utils/accounting');

const router = express.Router();
router.use(requireAuth);

const { CHANNELS } = require('../utils/kanal');

const shopSchema = z.object({
  name: z.string().trim().min(1, 'nama toko wajib diisi').max(100),
  channel: z.enum(CHANNELS).default('SHOPEE'),
  note: z.string().trim().max(300).optional().nullable(),
  // Rekening penerima uang toko ini. Marketplace mencairkan ke rekening
  // tertentu, dan yang mengetik order tidak perlu mengingat yang mana.
  cash_code: z.string().trim().optional().nullable(),
  // Toko utama untuk rekening itu — dipakai saat satu rekening dipakai
  // beberapa toko pada kanal yang sama.
  rekening_utama: z.boolean().default(false),
  active: z.boolean().default(true),
});

/** Memastikan kode yang dipilih memang rekening kas/bank yang aktif. */
function periksaRekening(code) {
  if (!code) return null;
  const akun = db.prepare('SELECT * FROM accounts WHERE code = ?').get(code);
  if (!akun) throw httpError(404, `Rekening ${code} tidak ditemukan`);
  if (!akun.is_cash) throw httpError(422, `${akun.code} · ${akun.name} bukan rekening kas/bank`);
  return akun.code;
}

/** GET /api/shops — daftar toko beserta ringkasan performanya. */
/** Pengambil daftar toko + performanya — dipakai layar dan berkas unduhan. */
function ambilToko(req) {
  const { from, to } = dateRange(req.query);

  const rows = db
    .prepare(
      `SELECT s.*,
              ak.name                           AS rekening_nama,
              COUNT(o.id)                       AS orders,
              COALESCE(SUM(o.net_revenue), 0)   AS net_revenue,
              COALESCE(SUM(o.cogs), 0)          AS cogs,
              COALESCE(SUM(o.total_fees), 0)    AS total_fees,
              COALESCE(SUM(o.net_profit), 0)    AS net_profit
         FROM shops s
         LEFT JOIN accounts ak ON ak.code = s.cash_code
         LEFT JOIN sales_orders o
                ON o.shop_id = s.id
               AND o.status = 'POSTED'
               AND o.order_date BETWEEN ? AND ?
        ${req.query.includeInactive === '1' ? '' : 'WHERE s.active = 1'}
        GROUP BY s.id
        ORDER BY net_profit DESC, s.name`
    )
    .all(from, to)
    .map((s) => ({
      ...s,
      net_revenue: r2(s.net_revenue),
      cogs: r2(s.cogs),
      total_fees: r2(s.total_fees),
      net_profit: r2(s.net_profit),
      margin_pct: s.net_revenue ? r2((s.net_profit / s.net_revenue) * 100) : 0,
      avg_order_value: s.orders ? r2(s.net_revenue / s.orders) : 0,
    }));

  return { from, to, shops: rows };
}

router.get('/', ah((req, res) => res.json(ambilToko(req))));

daftarkanEkspor(router, {
  path: '',
  judul: 'Toko Marketplace',
  kolom: [
    { header: 'Toko', key: 'name', width: 26 },
    { header: 'Channel', key: 'channel', width: 16 },
    { header: 'Order', key: 'orders', width: 10 },
    { header: 'Pendapatan Bersih', key: 'net_revenue', width: 17, money: true },
    { header: 'HPP', key: 'cogs', width: 15, money: true },
    { header: 'Total Biaya', key: 'total_fees', width: 15, money: true },
    { header: 'Laba Bersih', key: 'net_profit', width: 15, money: true },
    { header: 'Margin', key: 'margin_pct', width: 10, pct: true },
    { header: 'Rata-rata per Order', key: 'avg_order_value', width: 18, money: true },
  ],
  ambil: (req) => {
    const d = ambilToko(req);
    return {
      rows: d.shops,
      subtitle: `Periode ${d.from} s/d ${d.to}`,
      meta: [
        ['Jumlah toko', d.shops.length],
        ['Total laba bersih', r2(d.shops.reduce((s, x) => s + x.net_profit, 0))],
      ],
    };
  },
});

router.post('/', butuhIzin('penjualan.toko'), ah((req, res) => {
  const s = parse(shopSchema, req.body);
  if (db.prepare('SELECT id FROM shops WHERE name = ?').get(s.name)) {
    throw httpError(409, `Toko "${s.name}" sudah terdaftar`);
  }
  const info = db
    .prepare('INSERT INTO shops (name, channel, note, cash_code, rekening_utama, active) VALUES (?,?,?,?,?,?)')
    .run(s.name, s.channel, s.note || null, periksaRekening(s.cash_code), s.rekening_utama ? 1 : 0, s.active ? 1 : 0);

  res.status(201).json({ ok: true, shop: db.prepare('SELECT * FROM shops WHERE id = ?').get(info.lastInsertRowid) });
}));

router.put('/:id', butuhIzin('penjualan.toko'), ah((req, res) => {
  const s = parse(shopSchema, req.body);
  const existing = db.prepare('SELECT * FROM shops WHERE id = ?').get(req.params.id);
  if (!existing) throw httpError(404, 'Toko tidak ditemukan');

  const dupe = db.prepare('SELECT id FROM shops WHERE name = ? AND id <> ?').get(s.name, existing.id);
  if (dupe) throw httpError(409, `Toko "${s.name}" sudah terdaftar`);

  db.prepare('UPDATE shops SET name=?, channel=?, note=?, cash_code=?, rekening_utama=?, active=? WHERE id=?')
    .run(s.name, s.channel, s.note || null, periksaRekening(s.cash_code), s.rekening_utama ? 1 : 0, s.active ? 1 : 0, existing.id);

  res.json({ ok: true, shop: db.prepare('SELECT * FROM shops WHERE id = ?').get(existing.id) });
}));

/**
 * Menautkan banyak toko ke rekeningnya sekaligus.
 *
 * Dua puluh toko berarti dua puluh kali buka-pilih-simpan, dan di tengah jalan
 * pasti ada yang tertukar. Di sini daftarnya ditempel apa adanya dari catatan:
 *
 *   Sh Ratu Tanam  pakai BCA ROSIDAH (423-116-0331)
 *   Sh PIPIT BERKAH = BCA FITRI APRIYATI 423-046-6641
 *
 * Rekeningnya dicari lewat ANGKA pada tulisannya, bukan namanya: nama ditulis
 * berbeda-beda ("BCA Annisa" / "BCA ANNISA"), nomor rekening tidak.
 *
 * Toko yang menyebut sebuah rekening PALING AWAL menjadi toko utama untuk
 * rekening itu. Aturannya sengaja bisa dilihat: bila satu rekening dipakai dua
 * toko pada kanal yang sama, yang disebut lebih dulu itulah yang akan terpilih
 * otomatis saat rekeningnya dipilih di formulir order.
 */
const tautSchema = z.object({
  baris: z.array(z.string().trim().min(3)).min(1).max(200),
});

const digitSaja = (s) => String(s || '').replace(/\D/g, '');
const rapikan = (s) => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');

const tautkanRekening = db.transaction((body) => {
  const semuaToko = db.prepare('SELECT * FROM shops').all();
  const petaToko = new Map(semuaToko.map((t) => [rapikan(t.name), t]));

  const semuaAkun = db.prepare('SELECT * FROM accounts WHERE is_cash = 1').all();
  const petaNomor = new Map();
  for (const a of semuaAkun) {
    const d = digitSaja(a.name);
    if (d.length >= 6) petaNomor.set(d, a);
  }
  const petaNamaAkun = new Map(semuaAkun.map((a) => [rapikan(a.name), a]));

  // Rekening yang sudah punya toko utama — baik dari data lama maupun dari
  // baris yang sudah diproses lebih dulu dalam tempelan ini.
  const sudahUtama = new Set(
    semuaToko.filter((t) => t.rekening_utama && t.cash_code).map((t) => t.cash_code)
  );

  const berhasil = [];
  const gagal = [];

  for (const barisAsli of body.baris) {
    const teks = barisAsli.trim();
    const pisah = teks.split(/\s*=\s*|\s+pakai\s+/i);
    if (pisah.length < 2) {
      gagal.push({ baris: teks, alasan: 'tidak ada pemisah "pakai" atau "="' });
      continue;
    }

    const namaToko = pisah[0].trim();
    const teksAkun = pisah.slice(1).join(' ').trim();

    const toko = petaToko.get(rapikan(namaToko));
    if (!toko) {
      gagal.push({ baris: teks, alasan: `toko "${namaToko}" tidak terdaftar` });
      continue;
    }

    const d = digitSaja(teksAkun);

    // Cocok persis dulu. Bila tidak ketemu, dicari rekening yang nomornya
    // MEMUAT angka itu — nama rekening kadang membawa angka lain di depan,
    // dan nomor yang ditulis sebagian tetap harus dikenali. Diterima hanya
    // bila calonnya tunggal: dua calon berarti tebakan, dan menautkan toko ke
    // rekening yang keliru memindahkan seluruh omzetnya ke rekening orang lain.
    let akun = d.length >= 6 ? petaNomor.get(d) : null;
    if (!akun && d.length >= 6) {
      const calon = semuaAkun.filter((a) => digitSaja(a.name).includes(d));
      if (calon.length === 1) [akun] = calon;
      else if (calon.length > 1) {
        gagal.push({
          baris: teks,
          alasan: `nomor "${teksAkun}" cocok dengan ${calon.length} rekening — tulis nomor lengkapnya`,
        });
        continue;
      }
    }
    if (!akun) akun = petaNamaAkun.get(rapikan(teksAkun));

    if (!akun) {
      gagal.push({
        baris: teks,
        alasan: `rekening "${teksAkun}" belum ada — tambahkan dulu di Rekening Kas & Bank`,
      });
      continue;
    }

    const jadiUtama = !sudahUtama.has(akun.code);
    db.prepare('UPDATE shops SET cash_code = ?, rekening_utama = ? WHERE id = ?')
      .run(akun.code, jadiUtama ? 1 : 0, toko.id);
    if (jadiUtama) sudahUtama.add(akun.code);

    berhasil.push({
      toko: toko.name,
      rekening: `${akun.code} · ${akun.name}`,
      utama: jadiUtama,
    });
  }

  return { berhasil, gagal };
});

router.post('/tautkan-rekening', butuhIzin('penjualan.toko'), ah((req, res) => {
  const body = parse(tautSchema, req.body);
  const hasil = tautkanRekening(body);
  res.json({
    ok: true,
    ...hasil,
    message:
      `${hasil.berhasil.length} toko ditautkan` +
      (hasil.gagal.length ? `, ${hasil.gagal.length} baris tidak dikenali` : ''),
  });
}));

router.delete('/:id', butuhIzin('penjualan.toko'), ah((req, res) => {
  const shop = db.prepare('SELECT * FROM shops WHERE id = ?').get(req.params.id);
  if (!shop) throw httpError(404, 'Toko tidak ditemukan');

  const dipakai = db.prepare('SELECT COUNT(*) c FROM sales_orders WHERE shop_id = ?').get(shop.id).c;
  if (dipakai > 0) {
    // Riwayat penjualan harus tetap dapat ditelusuri ke tokonya
    db.prepare('UPDATE shops SET active = 0 WHERE id = ?').run(shop.id);
    return res.json({ ok: true, message: `Toko pernah dipakai ${dipakai} order — dinonaktifkan, bukan dihapus` });
  }

  db.prepare('DELETE FROM shops WHERE id = ?').run(shop.id);
  res.json({ ok: true, message: 'Toko dihapus' });
}));

module.exports = router;
