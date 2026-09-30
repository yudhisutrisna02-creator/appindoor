'use strict';
/**
 * Faktur Penjualan (Invoice).
 *
 * Tagihan resmi ke pelanggan yang ditarik dari surat jalan: barang yang
 * ditagih adalah barang yang benar-benar dikirim, dengan harga dari order
 * penjualannya. Satu faktur boleh menggabungkan beberapa surat jalan dari order
 * yang sama; satu surat jalan hanya boleh ditagih sekali.
 *
 * Faktur tidak membukukan apa pun. Piutang dan pendapatannya sudah tercatat
 * oleh ordernya, dan pelunasannya tetap lewat jalur pembayaran order — status
 * lunas di faktur dibaca dari status bayar ordernya (Ubah Order → Lunas), sehingga tidak ada dua catatan
 * pembayaran yang bisa saling bertentangan.
 *
 * Nomor: GI/INV/YYYY/MM/XXXX.
 */
const express = require('express');
const { z } = require('zod');
const { db, nextNumber, getSetting } = require('../db');
const { requireAuth, butuhIzin } = require('../middleware/auth');
const { ah, parse, httpError, dateRange } = require('../utils/http');
const { r2 } = require('../utils/accounting');
const { dokumenPdf, rupiah } = require('../utils/exporters');
const { todayLocal, dayjs } = require('../utils/time');
const { terbilang } = require('../utils/terbilang');
const { blokTtd, KIND } = require('../utils/ttd');
const { isiDokumen } = require('../utils/dokumen');
const { tglIndo } = require('./surat-jalan');

const router = express.Router();
router.use(requireAuth);

const tanggal = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const teks = (max) => z.string().trim().max(max).optional().nullable();

/** Status bayar faktur dibaca dari ordernya. */
function statusBayar(inv) {
  if (inv.status === 'BATAL') return { kode: 'BATAL', label: 'Batal' };
  if (inv.payment_status === 'PAID') return { kode: 'LUNAS', label: 'Lunas' };
  if (inv.due_date && inv.due_date < todayLocal()) return { kode: 'JATUH_TEMPO', label: 'Lewat jatuh tempo' };
  return { kode: 'BELUM', label: 'Belum lunas' };
}

/** Harga jual per produk pada order: rata-rata tertimbang bila produknya muncul di lebih dari satu baris. */
function hargaOrder(orderId) {
  return new Map(
    db
      .prepare(
        `SELECT product_id, SUM(subtotal) AS nilai, SUM(qty) AS qty
           FROM sales_items WHERE order_id = ? GROUP BY product_id`
      )
      .all(orderId)
      .map((r) => [r.product_id, r.qty ? r2(r.nilai / r.qty) : 0])
  );
}

/** Surat jalan yang boleh ditagih: belum batal dan belum masuk faktur yang masih berlaku. */
const sjTertagih = `(d.invoice_id IS NULL OR EXISTS (SELECT 1 FROM sales_invoices x WHERE x.id = d.invoice_id AND x.status = 'BATAL'))`;

function ambilFaktur(id) {
  const inv = db
    .prepare(
      `SELECT i.*, o.order_no, o.order_date, o.channel, o.payment_status, o.cash_code, o.order_ref,
              u.name AS user_name
         FROM sales_invoices i
         JOIN sales_orders o ON o.id = i.order_id
         LEFT JOIN users u ON u.id = i.user_id
        WHERE i.id = ?`
    )
    .get(id);
  if (!inv) throw httpError(404, 'Faktur tidak ditemukan');
  const items = db.prepare('SELECT * FROM sales_invoice_items WHERE invoice_id = ? ORDER BY id').all(id);
  const suratJalan = db
    .prepare('SELECT id, do_no, do_date, status FROM delivery_orders WHERE invoice_id = ? ORDER BY do_date, id')
    .all(id);
  const bayar = statusBayar(inv);
  return { ...inv, items, suratJalan, status_bayar: bayar.kode, status_bayar_label: bayar.label };
}

/* ------------------------------------------------------------------ */

/** GET /api/faktur/calon — surat jalan yang belum ditagih, dikelompokkan per order. */
router.get('/calon', ah((req, res) => {
  const rows = db
    .prepare(
      `SELECT d.id, d.do_no, d.do_date, d.status, d.recipient_name, d.city, d.order_id,
              o.order_no, o.customer, o.buyer_name,
              (SELECT COALESCE(SUM(qty), 0) FROM delivery_order_items i WHERE i.do_id = d.id) AS total_qty
         FROM delivery_orders d JOIN sales_orders o ON o.id = d.order_id
        WHERE d.status <> 'BATAL' AND o.status = 'POSTED' AND ${sjTertagih}
        ORDER BY d.do_date DESC, d.id DESC
        LIMIT 500`
    )
    .all();

  const perOrder = new Map();
  for (const r of rows) {
    if (!perOrder.has(r.order_id)) {
      perOrder.set(r.order_id, {
        order_id: r.order_id, order_no: r.order_no, customer: r.buyer_name || r.customer || r.recipient_name, suratJalan: [],
      });
    }
    perOrder.get(r.order_id).suratJalan.push({ id: r.id, do_no: r.do_no, do_date: r.do_date, status: r.status, total_qty: r2(r.total_qty) });
  }
  res.json({ rows: [...perOrder.values()] });
}));

/**
 * Menyusun isi faktur dari surat jalan terpilih — dipakai untuk pratinjau di
 * formulir dan saat menyimpan, supaya angkanya tidak punya dua penghitung.
 */
function susunFaktur(orderId, doIds) {
  const o = db
    .prepare(
      `SELECT o.*, pa.name AS partner_name, pa.phone AS partner_phone, pa.address AS partner_address, pa.term_days
         FROM sales_orders o LEFT JOIN partners pa ON pa.id = o.partner_id WHERE o.id = ?`
    )
    .get(orderId);
  if (!o) throw httpError(404, 'Order penjualan tidak ditemukan');
  if (o.status !== 'POSTED') throw httpError(422, 'Order ini sudah dibatalkan');

  const ids = [...new Set(doIds)];
  if (!ids.length) throw httpError(422, 'Pilih minimal satu surat jalan');
  const sj = db
    .prepare(`SELECT d.* FROM delivery_orders d WHERE d.id IN (${ids.map(() => '?').join(',')})`)
    .all(...ids);
  if (sj.length !== ids.length) throw httpError(404, 'Ada surat jalan yang tidak ditemukan');
  for (const d of sj) {
    if (d.order_id !== o.id) throw httpError(422, `${d.do_no} bukan milik order ${o.order_no}`);
    if (d.status === 'BATAL') throw httpError(422, `${d.do_no} sudah dibatalkan`);
    if (d.invoice_id) {
      const x = db.prepare('SELECT invoice_no, status FROM sales_invoices WHERE id = ?').get(d.invoice_id);
      if (x && x.status !== 'BATAL') throw httpError(422, `${d.do_no} sudah ditagih di faktur ${x.invoice_no}`);
    }
  }

  const harga = hargaOrder(o.id);
  const gabung = new Map();
  const baris = db
    .prepare(`SELECT * FROM delivery_order_items WHERE do_id IN (${ids.map(() => '?').join(',')}) ORDER BY do_id, id`)
    .all(...ids);
  for (const b of baris) {
    const ada = gabung.get(b.product_id);
    if (ada) ada.qty = r2(ada.qty + b.qty);
    else gabung.set(b.product_id, { product_id: b.product_id, product_name: b.product_name, sku: b.sku, unit: b.unit, qty: r2(b.qty) });
  }
  const items = [...gabung.values()].map((i) => {
    const price = harga.get(i.product_id) || 0;
    return { ...i, price, subtotal: r2(i.qty * price) };
  });
  const subtotal = r2(items.reduce((s, i) => s + i.subtotal, 0));

  // Diskon dan ongkir tingkat order dibebankan sekali, pada faktur pertama
  // ordernya. Faktur susulan untuk kiriman bertahap mulai dari nol — keduanya
  // tetap bisa diubah di formulir.
  const sudahAda = db
    .prepare("SELECT COUNT(*) AS n FROM sales_invoices WHERE order_id = ? AND status <> 'BATAL'")
    .get(o.id).n;
  const discount = sudahAda ? 0 : r2(o.discount || 0);
  const shipping = sudahAda ? 0 : r2(o.shipping_non_mp || 0);

  const tempo = o.term_days || Number(getSetting('faktur_tempo_hari', 14)) || 0;
  return {
    order: o,
    suratJalan: sj,
    items,
    bawaan: {
      customer_name: o.buyer_name || o.customer || o.partner_name || sj[0].recipient_name || '',
      customer_phone: o.buyer_phone || o.partner_phone || sj[0].recipient_phone || '',
      address: [o.buyer_address || o.partner_address || sj[0].address, o.buyer_city || sj[0].city].filter(Boolean).join(', '),
      discount,
      shipping,
      due_date: o.due_date || dayjs(todayLocal()).add(tempo, 'day').format('YYYY-MM-DD'),
    },
    subtotal,
  };
}

/** GET /api/faktur/siapkan?order_id=&do_ids=1,2 — pratinjau faktur. */
router.get('/siapkan', ah((req, res) => {
  const doIds = String(req.query.do_ids || '').split(',').map(Number).filter((n) => n > 0);
  const s = susunFaktur(Number(req.query.order_id), doIds);
  res.json({
    order: { id: s.order.id, order_no: s.order.order_no, order_date: s.order.order_date, payment_status: s.order.payment_status },
    suratJalan: s.suratJalan.map((d) => ({ id: d.id, do_no: d.do_no, do_date: d.do_date })),
    items: s.items,
    subtotal: s.subtotal,
    bawaan: s.bawaan,
  });
}));

/** GET /api/faktur?from&to&q&status — daftar faktur. */
router.get('/', ah((req, res) => {
  const { from, to } = dateRange(req.query);
  const q = String(req.query.q || '').trim();
  const where = ['i.invoice_date BETWEEN @from AND @to'];
  const p = { from, to };
  if (q) {
    where.push('(i.invoice_no LIKE @q OR o.order_no LIKE @q OR i.customer_name LIKE @q)');
    p.q = `%${q}%`;
  }
  const rows = db
    .prepare(
      `SELECT i.id, i.invoice_no, i.invoice_date, i.due_date, i.customer_name, i.total, i.status,
              o.order_no, o.payment_status,
              (SELECT GROUP_CONCAT(do_no, ', ') FROM delivery_orders d WHERE d.invoice_id = i.id) AS surat_jalan
         FROM sales_invoices i JOIN sales_orders o ON o.id = i.order_id
        WHERE ${where.join(' AND ')}
        ORDER BY i.invoice_date DESC, i.id DESC`
    )
    .all(p)
    .map((r) => {
      const b = statusBayar(r);
      return { ...r, status_bayar: b.kode, status_bayar_label: b.label };
    })
    .filter((r) => !req.query.status || r.status_bayar === req.query.status);

  const berlaku = rows.filter((r) => r.status !== 'BATAL');
  const nilai = (arr) => r2(arr.reduce((s, r) => s + r.total, 0));
  res.json({
    rows,
    ringkas: {
      jumlah: berlaku.length,
      total: nilai(berlaku),
      lunas: nilai(berlaku.filter((r) => r.status_bayar === 'LUNAS')),
      belum: nilai(berlaku.filter((r) => r.status_bayar !== 'LUNAS')),
      jatuhTempo: nilai(berlaku.filter((r) => r.status_bayar === 'JATUH_TEMPO')),
    },
  });
}));

router.get('/:id(\\d+)', ah((req, res) => res.json(ambilFaktur(Number(req.params.id)))));

const fakturSchema = z.object({
  order_id: z.number().int().positive(),
  do_ids: z.array(z.number().int().positive()).min(1, 'pilih minimal satu surat jalan'),
  invoice_date: tanggal.default(() => todayLocal()),
  due_date: tanggal.optional().nullable(),
  customer_name: z.string().trim().min(1, 'nama pelanggan wajib diisi').max(120),
  customer_phone: teks(40),
  address: teks(400),
  discount: z.number().nonnegative().optional(),
  shipping: z.number().nonnegative().optional(),
  note: teks(400),
});

/** POST /api/faktur — menerbitkan faktur dari surat jalan terpilih. */
router.post('/', butuhIzin('penjualan.faktur'), ah((req, res) => {
  const body = parse(fakturSchema, req.body);

  const id = db.transaction(() => {
    const s = susunFaktur(body.order_id, body.do_ids);
    const discount = r2(body.discount ?? s.bawaan.discount);
    const shipping = r2(body.shipping ?? s.bawaan.shipping);
    if (discount > s.subtotal + shipping) throw httpError(422, 'Diskon melebihi nilai tagihan');
    const total = r2(s.subtotal - discount + shipping);
    const due = body.due_date || s.bawaan.due_date;
    if (due < body.invoice_date) throw httpError(422, 'Jatuh tempo tidak boleh sebelum tanggal faktur');

    const nomor = nextNumber('GI/INV', body.invoice_date.slice(0, 7).replace('-', '/'));
    const info = db
      .prepare(
        `INSERT INTO sales_invoices (invoice_no, invoice_date, due_date, order_id, customer_name, customer_phone,
           address, subtotal, discount, shipping, total, note, user_id)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`
      )
      .run(nomor, body.invoice_date, due, s.order.id, body.customer_name, body.customer_phone || null,
        body.address || null, s.subtotal, discount, shipping, total, body.note || null, req.user.id);
    const tulis = db.prepare(
      `INSERT INTO sales_invoice_items (invoice_id, product_id, product_name, sku, unit, qty, price, subtotal)
       VALUES (?,?,?,?,?,?,?,?)`
    );
    for (const i of s.items) tulis.run(info.lastInsertRowid, i.product_id, i.product_name, i.sku, i.unit, i.qty, i.price, i.subtotal);
    const tandai = db.prepare('UPDATE delivery_orders SET invoice_id = ? WHERE id = ?');
    for (const d of s.suratJalan) tandai.run(info.lastInsertRowid, d.id);
    return info.lastInsertRowid;
  })();

  const f = ambilFaktur(id);
  res.status(201).json({ ok: true, message: `Faktur ${f.invoice_no} diterbitkan`, faktur: f });
}));

/** PATCH /api/faktur/:id/batal — surat jalannya kembali bisa ditagih. */
router.patch('/:id(\\d+)/batal', butuhIzin('penjualan.faktur'), ah((req, res) => {
  const f = ambilFaktur(Number(req.params.id));
  if (f.status === 'BATAL') throw httpError(422, 'Faktur ini sudah dibatalkan');
  db.transaction(() => {
    db.prepare("UPDATE sales_invoices SET status = 'BATAL' WHERE id = ?").run(f.id);
    db.prepare('UPDATE delivery_orders SET invoice_id = NULL WHERE invoice_id = ?').run(f.id);
  })();
  res.json({ ok: true, message: `Faktur ${f.invoice_no} dibatalkan` });
}));

/* ------------------------------------------------------------------ */

/** Rekening tujuan pembayaran yang dicetak di faktur. */
function infoRekening(f) {
  const tetap = getSetting('faktur_rekening', '');
  if (tetap) return tetap;
  if (f.cash_code && f.cash_code !== '1000') {
    const a = db.prepare('SELECT name FROM accounts WHERE code = ? AND is_cash = 1').get(f.cash_code);
    if (a) return a.name;
  }
  return '';
}

function dokumenFaktur(f, ttd) {
  const rekening = infoRekening(f);
  const lunas = f.status_bayar === 'LUNAS';
  return {
    resmi: true,
    judul: 'FAKTUR PENJUALAN',
    subjudul: 'Invoice',
    nomor: `No. ${f.invoice_no}`,
    meta: [
      ['Tanggal', tglIndo(f.invoice_date)],
      ['Jatuh tempo', tglIndo(f.due_date)],
      ['No. Order', f.order_no],
      ...(f.suratJalan.length ? [['Surat Jalan', f.suratJalan.map((d) => d.do_no).join(', ')]] : []),
      ['Status', f.status === 'BATAL' ? 'DIBATALKAN' : lunas ? 'LUNAS' : 'BELUM LUNAS'],
    ],
    pihak: [
      {
        judul: 'DITAGIHKAN KEPADA',
        nama: f.customer_name,
        baris: [f.address, f.customer_phone ? `Telp/WA: ${f.customer_phone}` : null],
      },
      {
        judul: 'PEMBAYARAN KE',
        nama: rekening || getSetting('company_name', 'Perusahaan'),
        baris: [rekening ? `a.n. ${getSetting('company_name', 'Perusahaan')}` : null, `Cantumkan nomor ${f.invoice_no} pada berita transfer`],
      },
    ],
    kolom: [
      { header: 'No', key: 'no', width: 5 },
      { header: 'Nama Barang', key: 'product_name', width: 40 },
      { header: 'Jumlah', key: 'jumlah', width: 13 },
      { header: 'Harga Satuan', key: 'price', width: 17, money: true },
      { header: 'Subtotal', key: 'subtotal', width: 18, money: true },
    ],
    rows: f.items.map((i, k) => ({ ...i, no: k + 1, jumlah: `${r2(i.qty)} ${i.unit || ''}`.trim() })),
    ringkas: [
      ['Subtotal', f.subtotal],
      ...(f.discount ? [['Diskon', `- ${rupiah(f.discount)}`]] : []),
      ...(f.shipping ? [['Ongkos kirim', f.shipping]] : []),
      ['TOTAL TAGIHAN', f.total, true],
    ],
    terbilang: terbilang(f.total),
    catatan: [
      f.note ? `Catatan: ${f.note}` : null,
      getSetting('faktur_catatan', ''),
      f.status === 'BATAL' ? 'FAKTUR INI TELAH DIBATALKAN DAN TIDAK BERLAKU.' : null,
      lunas ? 'Tagihan ini telah dibayar lunas. Terima kasih.' : null,
    ].filter(Boolean).join('\n'),
    tandaTangan: [
      { label: 'Penerima / Pelanggan', nama: f.customer_name || '' },
      ttd || { label: 'Hormat kami', nama: getSetting('company_name', '') },
    ],
  };
}

router.get('/:id(\\d+)/pdf', ah(async (req, res) => {
  const f = ambilFaktur(Number(req.params.id));
  let ttd = null;
  if (f.status !== 'BATAL') {
    ttd = await blokTtd({
      req,
      kind: KIND.FAKTUR,
      refId: f.id,
      docNo: f.invoice_no,
      isi: isiDokumen({ kind: KIND.FAKTUR, ref_id: f.id }).kanonik,
      userId: req.user && req.user.id,
      label: 'Hormat kami',
    });
  }
  const buffer = await dokumenPdf(dokumenFaktur(f, ttd), { perusahaan: getSetting('company_name', 'Perusahaan') });
  const nama = `faktur-${f.invoice_no.toLowerCase().replace(/[^a-z0-9]+/g, '-')}.pdf`;
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="${nama}"`);
  res.send(buffer);
}));

module.exports = router;
