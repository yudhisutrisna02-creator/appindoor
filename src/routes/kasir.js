'use strict';
/**
 * Kasir / POS.
 *
 * Transaksi kasir adalah order penjualan biasa (kanal KASIR, langsung lunas,
 * langsung selesai) yang dibuat lewat createOrder milik modul penjualan —
 * stok, HPP, dan jurnalnya tidak punya versi kedua. Yang khas di sini:
 *   - sesi: laci dibuka dengan modal, setiap transaksi menempel ke sesinya,
 *     dan saat ditutup uang yang dihitung dibandingkan dengan yang seharusnya;
 *   - metode bayar menentukan ke mana uangnya masuk: Tunai ke laci kasir, QRIS
 *     ke rekening QRIS, Transfer ke rekening bank yang dipilih;
 *   - struk: data lengkap untuk dicetak di printer thermal, atau sebagai PDF.
 */
const express = require('express');
const PDFDocument = require('pdfkit');
const { z } = require('zod');
const { db, nextNumber, getSetting } = require('../db');
const { requireAuth, butuhIzin } = require('../middleware/auth');
const { ah, parse, httpError, dateRange } = require('../utils/http');
const { r2, ACC, postJournal, accountByCode } = require('../utils/accounting');
const { dayjs, todayLocal, keLokal, nowLocal } = require('../utils/time');
const sales = require('./sales');

const router = express.Router();
router.use(requireAuth);

const METODE = { TUNAI: 'Tunai', QRIS: 'QRIS', TRANSFER: 'Transfer' };

const bolehKelola = (req) => req.izin && (req.izin.has('sistem.peran') || req.izin.has('penjualan.ubah'));

/** Rekening tujuan uang QRIS — bisa diganti lewat pengaturan kasir_rekening_qris. */
function rekeningQris() {
  const kode = getSetting('kasir_rekening_qris', ACC.QRIS);
  const a = db.prepare('SELECT code FROM accounts WHERE code = ? AND is_cash = 1').get(kode);
  return a ? a.code : ACC.QRIS;
}

/** Sesi yang sedang dibuka oleh pengguna ini, bila ada. */
function sesiTerbuka(userId) {
  return db.prepare("SELECT * FROM pos_sessions WHERE user_id = ? AND status = 'OPEN' ORDER BY id DESC LIMIT 1").get(userId);
}

/**
 * Rekap satu sesi: jumlah transaksi dan uang per metode.
 *
 * Uang yang SEHARUSNYA ada di laci = modal awal + penjualan tunai. QRIS dan
 * transfer tidak pernah menyentuh laci, jadi tidak ikut dihitung.
 */
function rekapSesi(sesi) {
  const baris = db
    .prepare(
      `SELECT pos_method, COUNT(*) AS n,
              COALESCE(SUM(net_revenue - total_fees + COALESCE(shipping_non_mp, 0)), 0) AS nilai
         FROM sales_orders
        WHERE pos_session_id = ? AND status = 'POSTED'
        GROUP BY pos_method`
    )
    .all(sesi.id);
  const per = { TUNAI: 0, QRIS: 0, TRANSFER: 0 };
  let transaksi = 0;
  for (const b of baris) {
    per[b.pos_method] = r2(b.nilai);
    transaksi += b.n;
  }
  const total = r2(per.TUNAI + per.QRIS + per.TRANSFER);
  const seharusnya = r2(sesi.opening_cash + per.TUNAI);
  return { transaksi, perMetode: per, total, uangLaciSeharusnya: seharusnya };
}

function ambilSesi(id) {
  const s = db
    .prepare(
      `SELECT s.*, u.name AS user_name, c.name AS closed_by_name, a.name AS laci_nama
         FROM pos_sessions s
         JOIN users u ON u.id = s.user_id
         LEFT JOIN users c ON c.id = s.closed_by
         LEFT JOIN accounts a ON a.code = s.cash_code
        WHERE s.id = ?`
    )
    .get(id);
  if (!s) throw httpError(404, 'Sesi kasir tidak ditemukan');
  return { ...s, rekap: rekapSesi(s) };
}

// ==================================================================
// PRODUK UNTUK KASIR
// ==================================================================
/**
 * GET /api/kasir/produk?q= — cari produk untuk kasir.
 *
 * Kode yang persis sama dengan barcode atau SKU didahulukan: pemindai
 * mengirim kodenya lalu Enter, dan kasir harus langsung mendapat satu barang,
 * bukan daftar.
 */
router.get('/produk', butuhIzin('penjualan.kasir'), ah((req, res) => {
  const q = String(req.query.q || '').trim();
  const kolom = 'id, sku, barcode, name, unit, price, stock, needs_variant';
  if (!q) {
    return res.json({
      rows: db.prepare(`SELECT ${kolom} FROM products WHERE active = 1 ORDER BY name LIMIT 60`).all(),
    });
  }
  const persis = db
    .prepare(`SELECT ${kolom} FROM products WHERE active = 1 AND (barcode = ? OR UPPER(sku) = UPPER(?)) LIMIT 1`)
    .get(q, q);
  const rows = db
    .prepare(
      `SELECT ${kolom} FROM products
        WHERE active = 1 AND (name LIKE ? OR sku LIKE ? OR barcode LIKE ?)
        ORDER BY name LIMIT 40`
    )
    .all(`%${q}%`, `%${q}%`, `%${q}%`);
  res.json({ persis: persis || null, rows });
}));

// ==================================================================
// SESI KASIR
// ==================================================================
/** GET /api/kasir/sesi-aktif — sesi pengguna ini beserta rekap berjalannya. */
router.get('/sesi-aktif', butuhIzin('penjualan.kasir'), ah((req, res) => {
  const s = sesiTerbuka(req.user.id);
  res.json({
    sesi: s ? ambilSesi(s.id) : null,
    rekeningQris: rekeningQris(),
    rekening: db.prepare('SELECT code, name FROM accounts WHERE is_cash = 1 AND active = 1 ORDER BY code').all(),
  });
}));

const bukaSchema = z.object({
  opening_cash: z.number().nonnegative().default(0),
  // Laci kasir berjalan di atas akun kas mana. Bawaan Kas Tunai.
  cash_code: z.string().trim().min(3).optional().nullable(),
  note: z.string().trim().max(200).optional().nullable(),
});

/** POST /api/kasir/sesi/buka — membuka laci dengan modal awal. */
router.post('/sesi/buka', butuhIzin('penjualan.kasir'), ah((req, res) => {
  const body = parse(bukaSchema, req.body);
  const ada = sesiTerbuka(req.user.id);
  if (ada) throw httpError(409, `Anda masih punya sesi terbuka (${ada.session_no}) — tutup dulu sebelum membuka yang baru`);

  const laci = accountByCode(body.cash_code || ACC.CASH);
  if (!laci.is_cash) throw httpError(422, `${laci.code} bukan akun kas`);

  const no = nextNumber('KS', todayLocal().slice(0, 7));
  const info = db
    .prepare(
      `INSERT INTO pos_sessions (session_no, user_id, cash_code, opened_at, opening_cash, note)
       VALUES (?,?,?,?,?,?)`
    )
    .run(no, req.user.id, laci.code, dayjs().toISOString(), r2(body.opening_cash), body.note || null);

  res.status(201).json({
    ok: true,
    sesi: ambilSesi(info.lastInsertRowid),
    message: `Sesi ${no} dibuka dengan modal laci Rp ${r2(body.opening_cash).toLocaleString('id-ID')}`,
  });
}));

const tutupSchema = z.object({
  counted_cash: z.number().nonnegative('uang di laci tidak boleh minus'),
  // Uang tunai yang disetor ke bank saat laci ditutup.
  setor_amount: z.number().nonnegative().default(0),
  setor_to: z.string().trim().min(3).optional().nullable(),
  note: z.string().trim().max(300).optional().nullable(),
});

/**
 * POST /api/kasir/sesi/:id/tutup — menghitung laci dan menutup sesi.
 *
 * Selisih antara uang yang dihitung dan yang seharusnya dibukukan ke akun
 * Selisih Kas Kasir — kurang menjadi beban, lebih menjadi pengurang beban —
 * supaya saldo Kas Tunai di buku sama dengan uang yang benar-benar ada.
 * Setoran tunai ke bank dicatat sebagai pindah saldo.
 */
router.post('/sesi/:id(\\d+)/tutup', butuhIzin('penjualan.kasir'), ah((req, res) => {
  const body = parse(tutupSchema, req.body);
  const s = db.prepare('SELECT * FROM pos_sessions WHERE id = ?').get(req.params.id);
  if (!s) throw httpError(404, 'Sesi kasir tidak ditemukan');
  if (s.status !== 'OPEN') throw httpError(409, `Sesi ${s.session_no} sudah ditutup`);
  if (s.user_id !== req.user.id && !bolehKelola(req)) {
    throw httpError(403, 'Sesi ini milik kasir lain — hanya pemiliknya atau pengelola yang boleh menutup');
  }

  const rekap = rekapSesi(s);
  const seharusnya = rekap.uangLaciSeharusnya;
  const dihitung = r2(body.counted_cash);
  const selisih = r2(dihitung - seharusnya);
  const setor = r2(body.setor_amount);
  if (setor > dihitung + 0.004) throw httpError(422, 'Setoran tidak boleh melebihi uang yang ada di laci');
  let tujuanSetor = null;
  if (setor > 0) {
    if (!body.setor_to) throw httpError(422, 'Pilih rekening bank tujuan setoran');
    tujuanSetor = accountByCode(body.setor_to);
    if (!tujuanSetor.is_cash) throw httpError(422, `${tujuanSetor.code} bukan rekening kas/bank`);
    if (tujuanSetor.code === s.cash_code) throw httpError(422, 'Rekening setoran tidak boleh laci kasir itu sendiri');
  }

  const hari = todayLocal();
  db.transaction(() => {
    if (Math.abs(selisih) >= 0.01) {
      const nilai = Math.abs(selisih);
      postJournal({
        date: hari,
        description: `Selisih kas kasir ${s.session_no} — ${selisih < 0 ? 'kurang' : 'lebih'} Rp ${nilai.toLocaleString('id-ID')}`,
        lines: selisih < 0
          ? [
            { code: ACC.CASH_OVER_SHORT, debit: nilai, credit: 0, memo: 'Uang laci kurang dari seharusnya' },
            { code: s.cash_code, debit: 0, credit: nilai, memo: `Selisih ${s.session_no}` },
          ]
          : [
            { code: s.cash_code, debit: nilai, credit: 0, memo: `Selisih ${s.session_no}` },
            { code: ACC.CASH_OVER_SHORT, debit: 0, credit: nilai, memo: 'Uang laci lebih dari seharusnya' },
          ],
        source: 'KASIR',
        sourceId: s.id,
        userId: req.user.id,
      });
    }
    if (setor > 0) {
      const laci = accountByCode(s.cash_code);
      postJournal({
        date: hari,
        description: `Setoran kasir ${s.session_no} — ${laci.name} → ${tujuanSetor.name}`,
        lines: [
          { code: tujuanSetor.code, debit: setor, credit: 0, memo: `Setoran tunai ${s.session_no}` },
          { code: laci.code, debit: 0, credit: setor, memo: `Disetor ke ${tujuanSetor.name}` },
        ],
        source: 'TRANSFER',
        userId: req.user.id,
      });
    }
    db.prepare(
      `UPDATE pos_sessions
          SET status = 'CLOSED', closed_at = ?, expected_cash = ?, counted_cash = ?, selisih = ?,
              setor_amount = ?, setor_to = ?, note = COALESCE(?, note), closed_by = ?
        WHERE id = ?`
    ).run(
      dayjs().toISOString(), seharusnya, dihitung, selisih, setor,
      tujuanSetor ? tujuanSetor.code : null, body.note || null, req.user.id, s.id
    );
  })();

  const rp = (n) => `Rp ${Math.abs(n).toLocaleString('id-ID')}`;
  res.json({
    ok: true,
    sesi: ambilSesi(s.id),
    message:
      `Sesi ${s.session_no} ditutup — ${rekap.transaksi} transaksi, ` +
      (Math.abs(selisih) < 0.01 ? 'laci pas' : `laci ${selisih < 0 ? 'kurang' : 'lebih'} ${rp(selisih)}`) +
      (setor > 0 ? `, setor ${rp(setor)} ke ${tujuanSetor.name}` : ''),
  });
}));

/** GET /api/kasir/sesi — riwayat sesi, untuk rekap setoran harian. */
router.get('/sesi', butuhIzin('penjualan.kasir'), ah((req, res) => {
  const { from, to } = dateRange(req.query);
  const semua = bolehKelola(req);
  // opened_at disimpan UTC; tanggalnya dibaca menurut zona waktu aplikasi.
  const menit = nowLocal().utcOffset();
  const geser = `${menit >= 0 ? '+' : '-'}${Math.abs(menit)} minutes`;
  const rows = db
    .prepare(
      `SELECT s.*, u.name AS user_name
         FROM pos_sessions s JOIN users u ON u.id = s.user_id
        WHERE date(s.opened_at, ?) BETWEEN ? AND ?
          ${semua ? '' : 'AND s.user_id = ?'}
        ORDER BY s.opened_at DESC LIMIT 500`
    )
    .all(...[geser, from, to, semua ? null : req.user.id].filter((x) => x !== null))
    .map((s) => ({ ...s, rekap: rekapSesi(s) }));

  const jumlah = (f) => r2(rows.reduce((n, s) => n + f(s), 0));
  res.json({
    from, to, rows,
    ringkas: {
      sesi: rows.length,
      transaksi: rows.reduce((n, s) => n + s.rekap.transaksi, 0),
      tunai: jumlah((s) => s.rekap.perMetode.TUNAI),
      qris: jumlah((s) => s.rekap.perMetode.QRIS),
      transfer: jumlah((s) => s.rekap.perMetode.TRANSFER),
      total: jumlah((s) => s.rekap.total),
      disetor: jumlah((s) => s.setor_amount || 0),
      selisih: jumlah((s) => s.selisih || 0),
    },
  });
}));

router.get('/sesi/:id(\\d+)', butuhIzin('penjualan.kasir'), ah((req, res) => {
  const s = ambilSesi(Number(req.params.id));
  if (s.user_id !== req.user.id && !bolehKelola(req)) throw httpError(403, 'Sesi ini milik kasir lain');
  const transaksi = db
    .prepare(
      `SELECT id, order_no, order_date, created_at, pos_method, pos_paid, pos_change, customer,
              (net_revenue - total_fees + COALESCE(shipping_non_mp, 0)) AS total, status
         FROM sales_orders WHERE pos_session_id = ? ORDER BY id DESC`
    )
    .all(s.id);
  res.json({ sesi: s, transaksi });
}));

// ==================================================================
// TRANSAKSI
// ==================================================================
const transaksiSchema = z.object({
  items: z
    .array(z.object({
      product_id: z.number().int().positive(),
      qty: z.number().positive(),
      price: z.number().nonnegative(),
    }))
    .min(1, 'keranjang masih kosong'),
  discount: z.number().nonnegative().default(0),
  method: z.enum(['TUNAI', 'QRIS', 'TRANSFER']),
  cash_code: z.string().trim().min(3).optional().nullable(),
  paid: z.number().nonnegative().optional().nullable(),
  customer: z.string().trim().max(120).optional().nullable(),
  buyer_phone: z.string().trim().max(30).optional().nullable(),
});

/**
 * POST /api/kasir/transaksi — satu penjualan di kasir.
 *
 * Wajib ada sesi terbuka: tanpa sesi, uang tunainya tidak punya laci yang
 * bisa dihitung ulang, dan selisihnya tidak pernah ketahuan.
 */
router.post('/transaksi', butuhIzin('penjualan.kasir'), ah((req, res) => {
  const body = parse(transaksiSchema, req.body);
  const sesi = sesiTerbuka(req.user.id);
  if (!sesi) throw httpError(409, 'Buka sesi kasir dulu sebelum berjualan');

  let kode;
  if (body.method === 'TUNAI') kode = sesi.cash_code;
  else if (body.method === 'QRIS') kode = rekeningQris();
  else {
    if (!body.cash_code) throw httpError(422, 'Pilih rekening tujuan transfer');
    const a = accountByCode(body.cash_code);
    if (!a.is_cash) throw httpError(422, `${a.code} bukan rekening kas/bank`);
    kode = a.code;
  }

  const bruto = r2(body.items.reduce((s, i) => s + i.qty * i.price, 0));
  const total = r2(bruto - body.discount);
  if (total < 0) throw httpError(422, 'Diskon melebihi total belanja');
  let dibayar = null;
  let kembali = null;
  if (body.method === 'TUNAI') {
    dibayar = r2(body.paid == null ? total : body.paid);
    if (dibayar + 0.004 < total) {
      throw httpError(422, `Uang diterima Rp ${dibayar.toLocaleString('id-ID')} kurang dari total Rp ${total.toLocaleString('id-ID')}`);
    }
    kembali = r2(dibayar - total);
  }

  const order = parse(sales.orderSchema, {
    order_date: todayLocal(),
    channel: 'KASIR',
    customer: body.customer || 'Pembeli Kasir',
    buyer_name: body.customer || null,
    buyer_phone: body.buyer_phone || null,
    items: body.items,
    discount: body.discount,
    fulfillment_status: 'SELESAI',
    payment_status: 'PAID',
    cash_code: kode,
    note: `Kasir ${sesi.session_no} · ${METODE[body.method]}`,
  });

  const hasil = db.transaction(() => {
    const r = sales.createOrder(order, req.user.id);
    db.prepare(
      'UPDATE sales_orders SET pos_session_id = ?, pos_method = ?, pos_paid = ?, pos_change = ? WHERE id = ?'
    ).run(sesi.id, body.method, dibayar, kembali, r.orderId);
    return r;
  }).immediate();

  res.status(201).json({
    ok: true,
    struk: dataStruk(hasil.orderId),
    message: `${hasil.orderNo} lunas — ${METODE[body.method]} Rp ${total.toLocaleString('id-ID')}` +
      (kembali ? `, kembalian Rp ${kembali.toLocaleString('id-ID')}` : ''),
  });
}));

/** Data struk satu transaksi — dipakai layar (cetak thermal) dan PDF. */
function dataStruk(orderId) {
  const o = db
    .prepare(
      `SELECT o.*, s.session_no, u.name AS kasir
         FROM sales_orders o
         LEFT JOIN pos_sessions s ON s.id = o.pos_session_id
         LEFT JOIN users u ON u.id = o.user_id
        WHERE o.id = ?`
    )
    .get(orderId);
  if (!o) throw httpError(404, 'Transaksi tidak ditemukan');
  const items = db
    .prepare(
      `SELECT i.qty, i.price, i.subtotal, p.name, p.sku, p.unit
         FROM sales_items i JOIN products p ON p.id = i.product_id
        WHERE i.order_id = ? ORDER BY i.id`
    )
    .all(orderId);
  const rek = o.cash_code ? db.prepare('SELECT name FROM accounts WHERE code = ?').get(o.cash_code) : null;
  return {
    id: o.id,
    order_no: o.order_no,
    waktu: keLokal(o.created_at ? `${o.created_at.replace(' ', 'T')}Z` : dayjs().toISOString()).format('DD/MM/YYYY HH:mm'),
    session_no: o.session_no,
    kasir: o.kasir,
    customer: o.buyer_name || null,
    items,
    subtotal: r2(o.gross_sales),
    diskon: r2(o.discount),
    total: r2(o.net_revenue - o.total_fees + (o.shipping_non_mp || 0)),
    metode: METODE[o.pos_method] || o.pos_method,
    rekening: o.pos_method === 'TRANSFER' && rek ? rek.name : null,
    dibayar: o.pos_paid,
    kembali: o.pos_change,
    toko: {
      nama: getSetting('company_name', 'Toko'),
      alamat: getSetting('company_address', ''),
      telepon: getSetting('company_phone', ''),
      catatan: getSetting('kasir_catatan_struk', 'Terima kasih atas kunjungan Anda'),
    },
  };
}

router.get('/transaksi/:id(\\d+)/struk', butuhIzin('penjualan.kasir'), ah((req, res) => {
  res.json({ struk: dataStruk(Number(req.params.id)) });
}));

/**
 * GET /api/kasir/transaksi/:id/struk.pdf — struk selebar kertas thermal 80 mm.
 *
 * Tinggi halaman mengikuti jumlah baris, supaya kertas gulungan tidak
 * menyisakan lembaran kosong panjang di bawah struk.
 */
router.get('/transaksi/:id(\\d+)/struk.pdf', butuhIzin('penjualan.kasir'), ah(async (req, res) => {
  const d = dataStruk(Number(req.params.id));
  const lebar = 226; // 80 mm
  const tinggi = 250 + d.items.length * 30 + (d.customer ? 12 : 0) + (d.diskon ? 12 : 0);
  const doc = new PDFDocument({ size: [lebar, tinggi], margin: 10 });
  const potongan = [];
  doc.on('data', (c) => potongan.push(c));
  const selesai = new Promise((r) => doc.on('end', r));
  const w = lebar - 20;
  const rp = (n) => Number(n || 0).toLocaleString('id-ID');
  const garis = () => { doc.moveDown(0.3).fontSize(7).text('-'.repeat(52), { width: w, align: 'center' }).moveDown(0.2); };
  const duaKolom = (kiri, kanan, tebal) => {
    const y = doc.y;
    doc.font(tebal ? 'Helvetica-Bold' : 'Helvetica').fontSize(tebal ? 9 : 8)
      .text(kiri, 10, y, { width: w * 0.6 })
      .text(kanan, 10 + w * 0.6, y, { width: w * 0.4, align: 'right' });
    doc.y = Math.max(doc.y, y + (tebal ? 11 : 10));
  };

  doc.font('Helvetica-Bold').fontSize(11).text(d.toko.nama, { width: w, align: 'center' });
  doc.font('Helvetica').fontSize(7);
  if (d.toko.alamat) doc.text(d.toko.alamat, { width: w, align: 'center' });
  if (d.toko.telepon) doc.text(d.toko.telepon, { width: w, align: 'center' });
  garis();
  doc.fontSize(7).text(`${d.order_no}   ${d.waktu}`, { width: w });
  doc.text(`Kasir: ${d.kasir || '-'}   ${d.session_no || ''}`, { width: w });
  if (d.customer) doc.text(`Pembeli: ${d.customer}`, { width: w });
  garis();
  for (const i of d.items) {
    doc.font('Helvetica').fontSize(8).text(i.name, 10, doc.y, { width: w });
    duaKolom(`  ${rp(i.qty)} x ${rp(i.price)}`, rp(i.subtotal));
  }
  garis();
  duaKolom('Subtotal', rp(d.subtotal));
  if (d.diskon) duaKolom('Diskon', `-${rp(d.diskon)}`);
  duaKolom('TOTAL', rp(d.total), true);
  duaKolom(`Bayar (${d.metode})`, rp(d.dibayar != null ? d.dibayar : d.total));
  if (d.kembali) duaKolom('Kembali', rp(d.kembali));
  if (d.rekening) doc.fontSize(7).text(`Ke rekening ${d.rekening}`, { width: w });
  garis();
  doc.font('Helvetica').fontSize(7).text(d.toko.catatan, { width: w, align: 'center' });
  doc.end();
  await selesai;

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="struk-${d.order_no.replace(/[^A-Za-z0-9]+/g, '-')}.pdf"`);
  res.send(Buffer.concat(potongan));
}));

module.exports = router;
