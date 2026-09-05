'use strict';
/**
 * Perubahan order penjualan yang sudah tersimpan.
 *
 * Status pesanan dan status pembayaran berubah terus dalam pekerjaan sehari-hari
 * — diproses, dikirim, selesai, cair — dan tiap perubahan itu tidak boleh
 * berhenti di layar saja. Status pembayaran menentukan ke akun mana uang
 * penjualan dicatat: sudah lunas masuk kas atau bank, belum cair menjadi
 * piutang. Karena itu setiap perubahan yang menyentuh uang selalu diikuti
 * penulisan ulang jurnalnya, di dalam transaksi yang sama.
 *
 * Dipisah dari sales.js karena berkas itu sudah panjang, dan alur "ubah" punya
 * aturan sendiri yang layak dibaca utuh dalam satu tempat.
 */
const { z } = require('zod');
const { db } = require('../db');
const { httpError } = require('../utils/http');
const { r2, postJournal, deleteJournalsBySource, buildSalesJournalLines } = require('../utils/accounting');
const { CHANNELS, CHANNEL_LABEL } = require('../utils/kanal');
const BATCH = require('../utils/batch');

const STATUS_PESANAN = require('../utils/status-pesanan').SEMUA;

const tanggal = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

/**
 * Semua kolom boleh diubah dan semuanya bersifat pilihan — yang tidak dikirim
 * dibiarkan apa adanya, sehingga mengubah satu status tidak menuntut pengiriman
 * ulang seluruh isi order.
 */
const ubahSchema = z.object({
  order_date: tanggal.optional(),
  channel: z.enum(CHANNELS).optional(),
  customer: z.string().max(120).optional().nullable(),
  partner_id: z.number().int().positive().optional().nullable(),
  due_date: tanggal.optional().nullable(),
  marketplace_ref: z.string().max(80).optional().nullable(),

  items: z
    .array(
      z.object({
        product_id: z.number().int().positive(),
        qty: z.number().positive(),
        price: z.number().nonnegative(),
        // Label varian untuk produk yang dijual tanpa label; diperiksa oleh
        // resolveItems supaya aturannya sama persis dengan saat order dibuat.
        variants: z
          .array(z.object({
            // Varian dipilih dari katalog produk induknya; labelnya boleh
            // dikosongkan bila pembeli tidak minta label sendiri.
            variant_id: z.number().int().positive().optional().nullable(),
            label: z.string().trim().max(120).optional().nullable(),
            qty: z.number().positive(),
          }))
          .optional(),
      })
    )
    .min(1, 'minimal satu item produk')
    .optional(),

  discount: z.number().nonnegative().optional(),
  admin_fee_pct: z.number().min(0).max(100).optional(),
  admin_fee: z.number().nonnegative().optional(),
  handling_fee: z.number().nonnegative().optional(),
  shipping_extra: z.number().nonnegative().optional(),
  voucher_platform: z.number().nonnegative().optional(),
  tax_pct: z.number().min(0).max(100).optional(),
  tax_amount: z.number().nonnegative().optional(),
  packing_cost: z.number().nonnegative().optional(),
  other_cost: z.number().nonnegative().optional(),
  shipping_non_mp: z.number().nonnegative().optional(),

  shop_id: z.number().int().positive().optional().nullable(),
  order_ref: z.string().trim().max(80).optional().nullable(),
  courier: z.string().trim().max(50).optional().nullable(),
  tracking_no: z.string().trim().max(80).optional().nullable(),
  fulfillment_status: z.enum(STATUS_PESANAN).optional(),
  payout_date: tanggal.optional().nullable(),
  shipping_charged: z.number().nonnegative().optional(),
  buyer_name: z.string().trim().max(120).optional().nullable(),
  buyer_account: z.string().trim().max(120).optional().nullable(),
  buyer_phone: z.string().trim().max(30).optional().nullable(),
  buyer_address: z.string().trim().max(300).optional().nullable(),
  buyer_city: z.string().trim().max(80).optional().nullable(),
  lead_source: z.string().trim().max(50).optional().nullable(),

  payment_status: z.enum(['PAID', 'UNPAID']).optional(),
  note: z.string().max(300).optional().nullable(),
});

/** Kolom yang hanya keterangan — mengubahnya tidak menyentuh angka mana pun. */
const KOLOM_KETERANGAN = [
  'customer', 'marketplace_ref', 'shop_id', 'order_ref', 'courier', 'tracking_no',
  'fulfillment_status', 'payout_date', 'buyer_name', 'buyer_account', 'buyer_phone',
  'buyer_address', 'buyer_city', 'lead_source', 'note', 'partner_id', 'due_date',
  'shipping_charged',
];

/** Kolom yang ikut menentukan perhitungan laba dan isi jurnal. */
const KOLOM_UANG = [
  'discount', 'admin_fee_pct', 'admin_fee', 'handling_fee', 'shipping_extra',
  'voucher_platform', 'tax_pct', 'tax_amount', 'packing_cost', 'other_cost',
  'shipping_non_mp',
];

/**
 * Bangun fungsi pengubah order.
 *
 * Bagian-bagian yang sudah ada di sales.js — penyusun item, penghitung biaya,
 * dan pembatal order — dioper masuk daripada disalin, supaya order yang diubah
 * dan order yang baru dibuat tidak pernah dihitung dengan cara berbeda.
 */
function buatPengubah({ resolveItems, computeOrder, cancelOrder }) {
  return db.transaction((orderId, badan, userId) => {
    const lama = db.prepare('SELECT * FROM sales_orders WHERE id = ?').get(orderId);
    if (!lama) throw httpError(404, 'Order tidak ditemukan');
    if (lama.status === 'CANCELLED') {
      throw httpError(409, 'Order sudah dibatalkan dan tidak bisa diubah lagi');
    }

    // Menandai pesanan "Batal" berarti barangnya tidak jadi keluar. Kalau hanya
    // labelnya yang berubah, order batal tetap terhitung sebagai pendapatan dan
    // stoknya tetap berkurang — persis keadaan yang membuat laporan tidak bisa
    // dipercaya. Jadi label itu menjalankan pembatalan yang sebenarnya.
    if (badan.fulfillment_status === 'BATAL') {
      const nomor = cancelOrder(orderId);
      db.prepare("UPDATE sales_orders SET fulfillment_status = 'BATAL' WHERE id = ?").run(orderId);
      return { orderId, orderNo: nomor, dibatalkan: true };
    }

    // ---------- item ----------
    let items;
    if (badan.items) {
      // Kembalikan dulu stok lama, baru hitung yang baru — kalau tidak, order
      // yang hanya menambah satu unit akan ditolak karena dianggap meminta
      // seluruh jumlah baru di atas stok yang sudah terpotong olehnya sendiri.
      const itemLama = db.prepare('SELECT * FROM sales_items WHERE order_id = ?').all(orderId);
      for (const it of itemLama) {
        const p = db.prepare('SELECT stock FROM products WHERE id = ?').get(it.product_id);
        db.prepare('UPDATE products SET stock = ? WHERE id = ?').run(r2(p.stock + it.qty), it.product_id);
      }
      // Batch dikembalikan bersama stoknya, lalu dipotong ulang di bawah
      // mengikuti isi pesanan yang baru.
      BATCH.kembalikan({ source: 'SALES', sourceId: orderId, tanggal: lama.order_date });

      db.prepare('DELETE FROM sales_items WHERE order_id = ?').run(orderId);
      db.prepare("DELETE FROM stock_moves WHERE source = 'SALES' AND source_id = ?").run(orderId);

      items = resolveItems(badan.items);
    } else {
      items = db
        .prepare('SELECT i.*, p.stock FROM sales_items i JOIN products p ON p.id = i.product_id WHERE i.order_id = ?')
        .all(orderId)
        .map((i) => ({
          product_id: i.product_id,
          qty: i.qty,
          price: i.price,
          cost: i.cost,
          subtotal: i.subtotal,
          subcost: i.subcost,
        }));
    }

    // ---------- gabungkan nilai lama dengan yang dikirim ----------
    const gabung = { ...lama };
    for (const k of [...KOLOM_KETERANGAN, ...KOLOM_UANG, 'order_date', 'channel', 'payment_status']) {
      if (badan[k] !== undefined) gabung[k] = badan[k];
    }

    // Biaya admin dan pajak punya dua bentuk: nilai tetap dan persentase.
    // Nilai yang dikirim langsung selalu menang. Bila hanya itemnya yang
    // berubah sementara tarifnya tetap, nilainya dihitung ulang dari tarif —
    // kalau tidak, biaya admin akan tertinggal pada angka pesanan yang lama.
    const hitung = computeOrder(
      {
        discount: gabung.discount,
        admin_fee_pct: gabung.admin_fee_pct,
        admin_fee:
          badan.admin_fee !== undefined
            ? badan.admin_fee
            : badan.items && gabung.admin_fee_pct > 0
              ? undefined
              : gabung.admin_fee,
        handling_fee: gabung.handling_fee,
        shipping_extra: gabung.shipping_extra,
        voucher_platform: gabung.voucher_platform,
        tax_pct: gabung.tax_pct,
        tax_amount:
          badan.tax_amount !== undefined
            ? badan.tax_amount
            : badan.items && gabung.tax_pct > 0
              ? undefined
              : gabung.tax_amount,
        packing_cost: gabung.packing_cost,
        other_cost: gabung.other_cost,
        shipping_non_mp: gabung.shipping_non_mp,
      },
      items
    );

    // ---------- tulis ulang item & mutasi bila itemnya berganti ----------
    if (badan.items) {
      const insertItem = db.prepare(
        `INSERT INTO sales_items (order_id, product_id, qty, price, cost, subtotal, subcost)
         VALUES (?,?,?,?,?,?,?)`
      );
      const insertMove = db.prepare(
        `INSERT INTO stock_moves
           (product_id, move_date, move_type, qty, unit_cost, balance_after, ref, source, source_id, note, user_id)
         VALUES (?,?,'OUT',?,?,?,?, 'SALES', ?, ?, ?)`
      );
      const insertVarian = db.prepare(
        'INSERT INTO sales_item_variants (item_id, variant_id, variant_nama, label, qty) VALUES (?,?,?,?,?)'
      );
      const sisaStok = new Map();
      for (const it of items) {
        const hasilItem = insertItem.run(
          orderId, it.product_id, it.qty, it.price, it.cost, it.subtotal, it.subcost
        );
        // Baris lama sudah dihapus di atas; variannya ikut terbawa oleh ON
        // DELETE CASCADE, jadi yang tersisa hanya menulis ulang yang baru.
        for (const v of it.varian || []) insertVarian.run(hasilItem.lastInsertRowid, v.variant_id, v.variant_nama, v.label, v.qty);
        const sebelum = sisaStok.has(it.product_id) ? sisaStok.get(it.product_id) : it.product.stock;
        const baru = r2(sebelum - it.qty);
        sisaStok.set(it.product_id, baru);
        db.prepare('UPDATE products SET stock = ? WHERE id = ?').run(baru, it.product_id);
        BATCH.keluar({
          product_id: it.product_id, qty: it.qty, tanggal: gabung.order_date,
          source: 'SALES', sourceId: orderId, note: `Order ${lama.order_no} (diubah)`, userId,
        });
        insertMove.run(
          it.product_id, gabung.order_date, it.qty, it.cost, baru, lama.order_no, orderId,
          `Penjualan ${CHANNEL_LABEL[gabung.channel] || gabung.channel} (diubah)`, userId
        );
      }
    }

    // Bila yang dibetulkan hanya tanggalnya, mutasi stoknya tidak ditulis ulang
    // di atas — tanggalnya perlu diikutkan di sini. Kalau tertinggal, kartu
    // stok menunjukkan barang keluar pada hari yang salah, dan valuasi per
    // tanggal meleset di sekitar pergantian bulan: persis keadaan yang membuat
    // orang membetulkan tanggalnya sejak awal.
    if (!badan.items && gabung.order_date !== lama.order_date) {
      db.prepare(
        "UPDATE stock_moves SET move_date = ? WHERE source = 'SALES' AND source_id = ?"
      ).run(gabung.order_date, orderId);
    }

    // ---------- kepala order ----------
    db.prepare(
      `UPDATE sales_orders SET
         order_date = ?, channel = ?, customer = ?, marketplace_ref = ?,
         gross_sales = ?, discount = ?, cogs = ?,
         admin_fee_pct = ?, admin_fee = ?, handling_fee = ?, shipping_extra = ?, voucher_platform = ?,
         tax_pct = ?, tax_amount = ?, packing_cost = ?, other_cost = ?,
         net_revenue = ?, total_fees = ?, gross_profit = ?, net_profit = ?, margin_pct = ?,
         payment_status = ?, note = ?, partner_id = ?, due_date = ?,
         shop_id = ?, order_ref = ?, courier = ?, tracking_no = ?, fulfillment_status = ?,
         payout_date = ?, shipping_charged = ?, buyer_name = ?, buyer_account = ?,
         buyer_phone = ?, buyer_address = ?, buyer_city = ?, lead_source = ?,
         shipping_non_mp = ?
       WHERE id = ?`
    ).run(
      gabung.order_date, gabung.channel, gabung.customer || null, gabung.marketplace_ref || null,
      hitung.gross_sales, hitung.discount, hitung.cogs,
      gabung.admin_fee_pct, hitung.admin_fee, r2(gabung.handling_fee), r2(gabung.shipping_extra),
      r2(gabung.voucher_platform),
      gabung.tax_pct, hitung.tax_amount, r2(gabung.packing_cost), r2(gabung.other_cost),
      hitung.net_revenue, hitung.total_fees, hitung.gross_profit, hitung.net_profit, hitung.margin_pct,
      gabung.payment_status, gabung.note || null, gabung.partner_id || null, gabung.due_date || null,
      gabung.shop_id || null, gabung.order_ref || null, gabung.courier || null,
      gabung.tracking_no || null, gabung.fulfillment_status, gabung.payout_date || null,
      r2(gabung.shipping_charged), gabung.buyer_name || null, gabung.buyer_account || null,
      gabung.buyer_phone || null, gabung.buyer_address || null, gabung.buyer_city || null,
      gabung.lead_source || null, hitung.shipping_non_mp,
      orderId
    );

    // ---------- jurnal ----------
    // Ditulis ulang seluruhnya, bukan ditambal. Perubahan status pembayaran
    // memindahkan sisi debit dari kas ke piutang atau sebaliknya, dan menambal
    // selisihnya menyisakan dua baris yang saling meniadakan tanpa menjelaskan
    // apa pun kepada yang membacanya nanti.
    deleteJournalsBySource('SALES', orderId);
    const jurnal = postJournal({
      date: gabung.order_date,
      description: `Penjualan ${lama.order_no} — ${CHANNEL_LABEL[gabung.channel] || gabung.channel}`,
      lines: buildSalesJournalLines({ ...gabung, ...hitung }),
      source: 'SALES',
      sourceId: orderId,
      userId,
    });

    return { orderId, orderNo: lama.order_no, hitung, jurnal, dibatalkan: false };
  });
}

module.exports = { ubahSchema, buatPengubah, STATUS_PESANAN };
