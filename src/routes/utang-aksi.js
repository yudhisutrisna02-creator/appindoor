'use strict';
/**
 * Ubah & hapus satu transaksi utang/piutang dari layar Utang & Piutang.
 *
 * Setiap baris di riwayat mitra adalah satu jurnal, tetapi asalnya berbeda-beda
 * dan tidak semuanya boleh dihapus begitu saja:
 *
 *   - Pelunasan, saldo awal, pelunasan manual, jurnal manual: dokumennya adalah
 *     jurnal itu sendiri — boleh diubah dan dihapus langsung.
 *   - Barang masuk kredit (impor/Mutasi Stok): jurnalnya berpasangan dengan
 *     stok. Menghapus jurnalnya saja membuat Persediaan di buku besar tidak lagi
 *     sama dengan stok gudang. Pilihannya:
 *       a. TANDAI LUNAS — utangnya ditutup (sudah dibayar di luar sistem, mis.
 *          sebelum saldo rekening disetel), stok tidak berubah;
 *       b. HAPUS BARANG MASUKNYA — stok, HPP, dan jurnalnya dibalik bersama.
 *   - Penjualan, pesanan pembelian, retur, dll.: dibetulkan lewat dokumennya;
 *     yang tersedia di sini hanya TANDAI LUNAS.
 *
 * "Tandai lunas" dicatat sebagai jurnal LUNAS lawan 3050 Saldo Awal Kas & Bank:
 * uangnya memang sudah keluar/masuk, dan saldo rekening yang disetel ke angka
 * nyata sudah memuatnya. Jurnal itu bisa dihapus lagi bila keliru.
 */
const express = require('express');
const { z } = require('zod');
const { db } = require('../db');
const { requireAuth, butuhIzin } = require('../middleware/auth');
const { ah, parse, httpError } = require('../utils/http');
const {
  r2, ACC, postJournal, deleteJournalById, tolakBilaTerekonsiliasi, accountByCode,
} = require('../utils/accounting');
const { buatCadangan } = require('../utils/cadangan');
const { koreksiHargaMasuk, balikkanMutasi, hitungUlangSaldo } = require('./inventory');

const router = express.Router();
router.use(requireAuth);

const LABEL = {
  SETTLEMENT: 'Pelunasan', AWAL: 'Saldo awal', LUNAS: 'Ditandai lunas', MANUAL: 'Jurnal manual',
  STOCK: 'Barang masuk', SALES: 'Penjualan', PO_HARGA: 'Selisih harga pesanan', RETURN: 'Retur penjualan',
  PURCHASE_RETURN: 'Retur pembelian', CASH: 'Kas masuk/keluar', KASIR: 'Kasir',
};
/** Jurnal yang dokumennya adalah jurnal itu sendiri. */
const LANGSUNG = new Set(['SETTLEMENT', 'AWAL', 'LUNAS', 'MANUAL']);

const tanggal = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

/** Saldo utang/piutang satu mitra pada satu akun. */
function saldoMitra(partnerId, accountId, subtype) {
  return r2(db
    .prepare(
      `SELECT COALESCE(SUM(${subtype === 'PAYABLE' ? 'l.credit - l.debit' : 'l.debit - l.credit'}), 0) s
         FROM journal_lines l JOIN journals j ON j.id = l.journal_id
        WHERE l.partner_id = ? AND l.account_id = ? AND j.posted = 1`
    )
    .get(partnerId, accountId).s);
}

/**
 * Keadaan satu jurnal mitra: dari mana asalnya, berapa nilainya bagi mitra
 * itu, dan tindakan apa yang tersedia.
 */
function ambil(id, partnerId) {
  const j = db.prepare('SELECT * FROM journals WHERE id = ?').get(id);
  if (!j) throw httpError(404, 'Transaksi tidak ditemukan');
  const baris = db
    .prepare(
      `SELECT l.*, a.subtype, a.is_cash, a.code, a.name AS account_name FROM journal_lines l
         JOIN accounts a ON a.id = l.account_id WHERE l.journal_id = ? ORDER BY l.id`
    )
    .all(j.id);
  const milikMitra = baris.filter((l) => l.partner_id && ['PAYABLE', 'RECEIVABLE'].includes(l.subtype)
    && (!partnerId || l.partner_id === Number(partnerId)));
  if (!milikMitra.length) throw httpError(422, `${j.entry_no} bukan transaksi utang/piutang`);
  const m = milikMitra[0];
  const utang = m.subtype === 'PAYABLE';
  const bertambah = r2(milikMitra.reduce((s, l) => s + (utang ? l.credit - l.debit : l.debit - l.credit), 0));
  const partner = db.prepare('SELECT id, name FROM partners WHERE id = ?').get(m.partner_id);

  // Dokumen asal
  let dokumen = null;
  let mutasi = null;
  if (j.source === 'STOCK') {
    mutasi = db.prepare('SELECT m.*, p.name AS product_name, p.unit, p.stock, p.lacak_batch FROM stock_moves m JOIN products p ON p.id = m.product_id WHERE m.id = ?').get(j.source_id);
    if (mutasi && String(mutasi.ref || '').startsWith('PO/')) {
      const po = db.prepare('SELECT id, po_no FROM purchase_orders WHERE po_no = ?').get(mutasi.ref);
      if (po) dokumen = { jenis: 'PO', id: po.id, nomor: po.po_no, tautan: '/pembelian' };
    }
    if (mutasi && !dokumen) dokumen = { jenis: 'MUTASI', id: mutasi.id, nomor: `${mutasi.product_name} · ${r2(mutasi.qty)} ${mutasi.unit}`, tautan: '/gudang/mutasi' };
  } else if (j.source === 'SALES') {
    const o = db.prepare('SELECT id, order_no FROM sales_orders WHERE id = ?').get(j.source_id);
    if (o) dokumen = { jenis: 'ORDER', id: o.id, nomor: o.order_no, tautan: '/penjualan' };
  } else if (j.source === 'PO_HARGA') {
    const po = db.prepare('SELECT po.id, po.po_no FROM purchase_items i JOIN purchase_orders po ON po.id = i.po_id WHERE i.id = ?').get(j.source_id);
    if (po) dokumen = { jenis: 'PO', id: po.id, nomor: po.po_no, tautan: '/pembelian' };
  }

  const sudahLunas = db
    .prepare("SELECT id, entry_no, entry_date FROM journals WHERE source = 'LUNAS' AND source_id = ?")
    .all(j.id);
  const sisa = saldoMitra(m.partner_id, m.account_id, m.subtype);

  // Tindakan yang tersedia
  const duaBaris = baris.length === 2;
  let ubah = null;
  if (j.source === 'SETTLEMENT') ubah = 'PELUNASAN';
  else if (LANGSUNG.has(j.source) && duaBaris) ubah = 'NOMINAL';
  else if (j.source === 'STOCK' && mutasi && dokumen?.jenis === 'MUTASI' && mutasi.move_type === 'IN') ubah = 'HARGA_MASUK';

  let hapus = null;
  let alasan = null;
  if (LANGSUNG.has(j.source)) hapus = 'LANGSUNG';
  else if (j.source === 'STOCK' && dokumen?.jenis === 'MUTASI') hapus = 'BARANG_MASUK';
  else if (dokumen?.jenis === 'PO') alasan = `Berasal dari pesanan ${dokumen.nomor} — hapus/ubah lewat menu Pesanan Pembelian.`;
  else if (dokumen?.jenis === 'ORDER') alasan = `Berasal dari order ${dokumen.nomor} — ubah/batalkan lewat menu Order Penjualan.`;
  else alasan = `Berasal dari ${LABEL[j.source] || j.source} — betulkan lewat dokumen asalnya.`;

  const kunci = db.prepare('SELECT 1 FROM period_locks WHERE period = ?').get(j.entry_date.slice(0, 7));
  const rekon = db
    .prepare('SELECT COUNT(*) n FROM bank_statement_lines WHERE journal_line_id IN (SELECT id FROM journal_lines WHERE journal_id = ?)')
    .get(j.id).n;

  return {
    j, baris, m, utang, partner, mutasi, dokumen, sisa,
    info: {
      journal_id: j.id,
      entry_no: j.entry_no,
      entry_date: j.entry_date,
      description: j.description,
      source: j.source,
      label: LABEL[j.source] || j.source,
      partner,
      jenis: utang ? 'Utang' : 'Piutang',
      nominal: Math.abs(bertambah),
      arah: bertambah >= 0 ? 'BERTAMBAH' : 'BERKURANG',
      memo: m.memo || null,
      cash_code: (baris.find((l) => l.is_cash) || {}).code || null,
      sisaMitra: sisa,
      dokumen,
      mutasi: mutasi ? { id: mutasi.id, qty: r2(mutasi.qty), unit: mutasi.unit, product_name: mutasi.product_name, stok: r2(mutasi.stock), unit_cost: r2(mutasi.unit_cost) } : null,
      ubah,
      hapus,
      alasan,
      // Tandai lunas hanya untuk transaksi yang MENAMBAH utang/piutang.
      bolehLunasi: bertambah > 0.004 && sisa > 0.004 && !['SETTLEMENT', 'LUNAS'].includes(j.source),
      sudahLunas,
      terkunci: !!kunci,
      terekonsiliasi: rekon > 0,
    },
  };
}

router.get('/jurnal/:id(\\d+)', ah((req, res) => res.json(ambil(Number(req.params.id), req.query.partner_id).info)));

/* ---------------- Tandai lunas ---------------- */
const lunasSchema = z.object({
  partner_id: z.number().int().positive().optional(),
  tanggal: tanggal,
  nominal: z.number().positive(),
  catatan: z.string().trim().max(200).optional().nullable(),
});

router.post('/jurnal/:id(\\d+)/lunasi', butuhIzin('keuangan.kas'), ah((req, res) => {
  const body = parse(lunasSchema, req.body);
  const a = ambil(Number(req.params.id), body.partner_id);
  if (!a.info.bolehLunasi) throw httpError(422, 'Transaksi ini tidak menambah utang/piutang yang masih terbuka');
  const batas = r2(Math.min(a.info.nominal, a.sisa));
  const nilai = r2(body.nominal);
  if (nilai > batas + 0.004) {
    throw httpError(422, `Nominal melebihi yang bisa ditutup (Rp ${batas.toLocaleString('id-ID')} — sisa ${a.info.jenis.toLowerCase()} ${a.partner.name})`);
  }
  const memo = body.catatan || `Sudah ${a.utang ? 'dibayar' : 'diterima'} di luar sistem — ${a.j.entry_no}`;
  const lawan = accountByCode(ACC.OPENING_CASH);
  const lines = a.utang
    ? [
        { account_id: a.m.account_id, debit: nilai, credit: 0, memo, partner_id: a.m.partner_id },
        { account_id: lawan.id, debit: 0, credit: nilai, memo },
      ]
    : [
        { account_id: lawan.id, debit: nilai, credit: 0, memo },
        { account_id: a.m.account_id, debit: 0, credit: nilai, memo, partner_id: a.m.partner_id },
      ];
  const j = postJournal({
    date: body.tanggal,
    description: `Tandai lunas ${a.info.jenis.toLowerCase()} ${a.partner.name} — ${a.j.entry_no}`,
    lines,
    source: 'LUNAS',
    sourceId: a.j.id,
    userId: req.user.id,
  });
  res.status(201).json({
    ok: true,
    journal: j,
    message: `${a.j.entry_no} ditandai lunas Rp ${nilai.toLocaleString('id-ID')} (${j.entry_no}) — stok dan saldo rekening tidak berubah`,
  });
}));

/* ---------------- Ubah ---------------- */
const ubahSchema = z.object({
  partner_id: z.number().int().positive().optional(),
  tanggal: tanggal,
  nominal: z.number().positive(),
  catatan: z.string().trim().max(200).optional().nullable(),
});

router.put('/jurnal/:id(\\d+)', butuhIzin('keuangan.kas'), ah((req, res) => {
  const body = parse(ubahSchema, req.body);
  const a = ambil(Number(req.params.id), body.partner_id);
  tolakBilaTerekonsiliasi(a.j);
  const nilai = r2(body.nominal);

  if (a.info.ubah === 'NOMINAL') {
    // Jurnal dua baris: kedua sisinya diganti nominal baru, akunnya tetap.
    const hasil = db.transaction(() => {
      deleteJournalById(a.j.id);
      return postJournal({
        date: body.tanggal,
        description: a.j.description,
        lines: a.baris.map((l) => ({
          account_id: l.account_id,
          debit: l.debit > 0 ? nilai : 0,
          credit: l.credit > 0 ? nilai : 0,
          memo: l.partner_id && body.catatan ? body.catatan : l.memo,
          partner_id: l.partner_id || null,
        })),
        source: a.j.source,
        sourceId: a.j.source_id,
        userId: req.user.id,
        entryNo: a.j.entry_date.slice(0, 7) === body.tanggal.slice(0, 7) ? a.j.entry_no : null,
      });
    })();
    return res.json({ ok: true, message: `${hasil.entry_no} diperbarui menjadi Rp ${nilai.toLocaleString('id-ID')}` });
  }

  if (a.info.ubah === 'HARGA_MASUK') {
    // Nominal utang barang masuk = qty × harga; yang dibetulkan harganya,
    // lewat jalur yang sama dengan tombol Harga di Mutasi Stok (HPP ikut).
    if (body.tanggal !== a.j.entry_date) {
      throw httpError(422, 'Tanggal barang masuk diubah lewat menu Mutasi Stok; di sini hanya nominalnya');
    }
    const hasil = koreksiHargaMasuk(a.mutasi.id, {
      unit_cost: r2(nilai / a.mutasi.qty),
      biaya_tambahan: 0,
      alasan: body.catatan || `Nominal utang dibetulkan dari Utang & Piutang (${a.j.entry_no})`,
    }, req.user.id);
    return res.json({ ok: true, ...hasil, message: `Nominal barang masuk ${a.j.entry_no} dibetulkan menjadi Rp ${nilai.toLocaleString('id-ID')} — HPP ikut disesuaikan` });
  }

  if (a.info.ubah === 'PELUNASAN') {
    throw httpError(422, 'Pelunasan diubah lewat /api/cashflow/settlements/:id');
  }
  throw httpError(422, a.info.alasan || 'Transaksi ini tidak bisa diubah dari sini');
}));

/* ---------------- Hapus ---------------- */
router.delete('/jurnal/:id(\\d+)', butuhIzin('keuangan.kas'), ah(async (req, res) => {
  const a = ambil(Number(req.params.id), req.query.partner_id);
  if (!a.info.hapus) throw httpError(422, a.info.alasan);
  tolakBilaTerekonsiliasi(a.j);

  if (a.info.hapus === 'LANGSUNG') {
    db.transaction(() => {
      // Tanda lunas yang menunjuk jurnal ini ikut hilang — tanpa induknya ia
      // menutup utang yang tidak pernah ada.
      for (const l of a.info.sudahLunas) deleteJournalById(l.id);
      deleteJournalById(a.j.id);
    })();
    return res.json({ ok: true, message: `${a.j.entry_no} dihapus — ${a.j.description}` });
  }

  // Barang masuk: stok, HPP, dan jurnalnya dibalik bersama.
  if (!req.izin.has('gudang.produk') && !req.izin.has('sistem.peran')) {
    throw httpError(403, 'Menghapus barang masuk membutuhkan izin gudang.produk');
  }
  const mv = a.mutasi;
  if (mv.lacak_batch) throw httpError(422, `${mv.product_name} dilacak per batch — kurangi lewat Stok Opname, lalu tandai utangnya lunas`);
  if (mv.move_type !== 'IN') throw httpError(422, 'Hanya barang masuk yang bisa dihapus dari sini');
  if (mv.stock + 0.0001 < mv.qty) {
    throw httpError(
      422,
      `Stok ${mv.product_name} tinggal ${r2(mv.stock)} ${mv.unit}, tidak cukup untuk membatalkan barang masuk ${r2(mv.qty)} ${mv.unit} — ` +
        'barangnya sudah terjual. Pakai "Tandai sudah lunas" bila utangnya memang sudah dibayar.'
    );
  }
  const cadangan = await buatCadangan('manual');
  db.transaction(() => {
    for (const l of a.info.sudahLunas) deleteJournalById(l.id);
    balikkanMutasi(mv);
    hitungUlangSaldo(mv.product_id);
  })();
  res.json({
    ok: true,
    cadangan: cadangan.nama,
    message: `Barang masuk ${r2(mv.qty)} ${mv.unit} ${mv.product_name} (${a.j.entry_no}) dihapus — stok, HPP, dan utangnya dibalik. Cadangan: ${cadangan.nama}`,
  });
}));

module.exports = router;
