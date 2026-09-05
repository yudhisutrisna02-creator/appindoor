'use strict';
/**
 * Batch produk & tanggal kadaluarsa.
 *
 * Produk hayati punya masa aktif. Stok yang hanya satu angka — 500 PACK — tidak
 * bisa menjawab pertanyaan yang paling penting: mana yang sebentar lagi
 * kedaluwarsa, dan berapa nilainya. Batch menjawab itu.
 *
 * SELURUH logika batch ditaruh di berkas ini, bukan disebar ke tiap tempat yang
 * mengubah stok. Ada sembilan titik yang menggerakkan stok di aplikasi ini
 * (penjualan, pembatalan, ubah order, retur, mutasi masuk/keluar, opname,
 * koreksi stok), dan yang paling mudah terjadi saat menambah titik kesepuluh
 * adalah lupa menyentuh batch — sehingga sisa batch diam-diam berbeda dari
 * stok produknya tanpa ada pesan galat apa pun.
 *
 * Aturan pokoknya:
 *  - Pelacakan dinyalakan PER PRODUK. Produk yang tidak dilacak sama sekali
 *    tidak tersentuh berkas ini, jadi memasang fitur ini tidak mengubah apa pun
 *    pada data yang sudah ada.
 *  - Barang keluar memakai FEFO (First Expired, First Out): yang lebih dulu
 *    kedaluwarsa keluar lebih dulu. Bukan FIFO — barang yang datang belakangan
 *    bisa saja kedaluwarsa lebih cepat.
 *  - Setiap pergerakan meninggalkan baris di batch_moves, sehingga pembatalan
 *    order bisa mengembalikan tepat ke batch asalnya, bukan menebak.
 */
const { db } = require('../db');
const { httpError } = require('./http');

const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

/** Apakah produk ini dilacak per batch. */
function dilacak(productId) {
  const p = db.prepare('SELECT lacak_batch FROM products WHERE id = ?').get(productId);
  return !!(p && p.lacak_batch);
}

function catatGerak({ batchId, productId, tanggal, qty, source, sourceId, note, userId }) {
  db.prepare(
    `INSERT INTO batch_moves (batch_id, product_id, move_date, qty, source, source_id, note, user_id)
     VALUES (?,?,?,?,?,?,?,?)`
  ).run(batchId, productId, tanggal, r2(qty), source || 'MANUAL', sourceId || null, note || null, userId || null);
}

function ubahSisa(batchId, delta) {
  db.prepare('UPDATE product_batches SET qty_sisa = ROUND(qty_sisa + ?, 2) WHERE id = ?')
    .run(r2(delta), batchId);
}

/**
 * Barang masuk ke sebuah batch. Batch dibuat bila kodenya belum ada.
 *
 * Kode batch yang sama pada produk yang sama dianggap batch yang sama —
 * pengiriman kedua dari batch produksi yang sama menambah sisanya, bukan
 * membuat baris kembar yang harus dijumlahkan sendiri oleh pembacanya.
 */
function masuk({ product_id, qty, unit_cost, tanggal, kode, kadaluarsa, produksi, catatan, source, sourceId, userId }) {
  if (!dilacak(product_id)) return null;

  const jumlah = r2(qty);
  if (jumlah <= 0) return null;

  const kodeBatch = String(kode || '').trim();
  if (!kodeBatch) {
    const p = db.prepare('SELECT name FROM products WHERE id = ?').get(product_id);
    throw httpError(
      422,
      `${p ? p.name : 'Produk ini'} dilacak per batch, jadi kode batch wajib diisi saat barang masuk. ` +
        'Tanpa kode batch, barangnya tidak bisa ditelusuri saat ada keluhan pembeli.'
    );
  }

  const ada = db
    .prepare('SELECT * FROM product_batches WHERE product_id = ? AND kode = ?')
    .get(product_id, kodeBatch);

  let batchId;
  if (ada) {
    batchId = ada.id;
    db.prepare(
      `UPDATE product_batches
          SET qty_awal = ROUND(qty_awal + ?, 2),
              qty_sisa = ROUND(qty_sisa + ?, 2),
              tanggal_kadaluarsa = COALESCE(?, tanggal_kadaluarsa),
              tanggal_produksi   = COALESCE(?, tanggal_produksi),
              unit_cost = ?
        WHERE id = ?`
    ).run(jumlah, jumlah, kadaluarsa || null, produksi || null, r2(unit_cost), batchId);
  } else {
    batchId = db
      .prepare(
        `INSERT INTO product_batches
           (product_id, kode, tanggal_produksi, tanggal_kadaluarsa, qty_awal, qty_sisa, unit_cost, catatan)
         VALUES (?,?,?,?,?,?,?,?)`
      )
      .run(product_id, kodeBatch, produksi || null, kadaluarsa || null, jumlah, jumlah, r2(unit_cost), catatan || null)
      .lastInsertRowid;
  }

  catatGerak({ batchId, productId: product_id, tanggal, qty: jumlah, source, sourceId, note: catatan, userId });
  return batchId;
}

/**
 * Barang keluar, diambil dari batch yang lebih dulu kedaluwarsa.
 *
 * Batch tanpa tanggal kadaluarsa diletakkan paling belakang: ia bisa jadi stok
 * lama yang belum sempat dilengkapi datanya, dan mengeluarkannya lebih dulu
 * akan menyembunyikan batch yang justru mendesak.
 */
function keluar({ product_id, qty, tanggal, source, sourceId, note, userId }) {
  if (!dilacak(product_id)) return [];

  let sisa = r2(qty);
  if (sisa <= 0) return [];

  const batch = db
    .prepare(
      `SELECT * FROM product_batches
        WHERE product_id = ? AND qty_sisa > 0
        ORDER BY CASE WHEN tanggal_kadaluarsa IS NULL THEN 1 ELSE 0 END,
                 tanggal_kadaluarsa ASC, id ASC`
    )
    .all(product_id);

  const tersedia = r2(batch.reduce((s, b) => s + b.qty_sisa, 0));
  if (tersedia + 0.004 < sisa) {
    const p = db.prepare('SELECT name, unit FROM products WHERE id = ?').get(product_id);
    throw httpError(
      422,
      `Batch ${p ? p.name : ''} hanya tersisa ${tersedia} ${p ? p.unit : ''}, ` +
        `sedangkan yang diminta ${qty}. Catat dulu barang masuk beserta kode batch-nya.`
    );
  }

  const dipakai = [];
  for (const b of batch) {
    if (sisa <= 0.004) break;
    const ambil = r2(Math.min(b.qty_sisa, sisa));
    ubahSisa(b.id, -ambil);
    catatGerak({
      batchId: b.id, productId: product_id, tanggal, qty: -ambil, source, sourceId, note, userId,
    });
    dipakai.push({ batch_id: b.id, kode: b.kode, qty: ambil, kadaluarsa: b.tanggal_kadaluarsa });
    sisa = r2(sisa - ambil);
  }
  return dipakai;
}

/**
 * Mengembalikan seluruh pergerakan batch milik satu dokumen.
 *
 * Dipakai saat order dibatalkan atau diubah. Dikembalikan ke batch ASALNYA
 * lewat catatan batch_moves, bukan ke batch yang kebetulan paling dekat
 * kedaluwarsanya — kalau menebak, barang bisa "pindah" batch hanya karena
 * ordernya disunting, dan penelusurannya jadi salah.
 */
function kembalikan({ source, sourceId, tanggal, userId }) {
  const gerak = db
    .prepare('SELECT * FROM batch_moves WHERE source = ? AND source_id = ?')
    .all(source, sourceId);

  for (const g of gerak) {
    ubahSisa(g.batch_id, -g.qty);
    catatGerak({
      batchId: g.batch_id, productId: g.product_id, tanggal: tanggal || g.move_date,
      qty: -g.qty, source: `${source}-BATAL`, sourceId, note: 'Pengembalian batch', userId,
    });
  }

  // Baris aslinya ditandai sudah dibatalkan supaya pembatalan kedua tidak
  // mengembalikan barang yang sama dua kali.
  db.prepare("UPDATE batch_moves SET source = ? WHERE source = ? AND source_id = ?")
    .run(`${source}-SELESAI`, source, sourceId);

  return gerak.length;
}

/**
 * Menyamakan sisa batch dengan stok produk setelah penyesuaian.
 *
 * Opname dan koreksi stok mengubah angka stok tanpa lewat jalur masuk/keluar
 * biasa. Kalau batch tidak ikut disesuaikan, sisanya menjadi lebih besar
 * daripada stok yang sebenarnya ada — dan laporan kadaluarsa memperingatkan
 * barang yang sudah tidak ada.
 */
function sesuaikan({ product_id, selisih, tanggal, source, sourceId, note, userId, kode }) {
  if (!dilacak(product_id)) return null;

  const beda = r2(selisih);
  if (beda === 0) return null;

  if (beda < 0) {
    return keluar({ product_id, qty: -beda, tanggal, source, sourceId, note, userId });
  }

  // Kelebihan masuk ke batch yang ditunjuk, atau ke batch penyesuaian bila
  // tidak disebutkan — barang yang tiba-tiba ada tetap perlu tempat berpijak.
  const p = db.prepare('SELECT cost FROM products WHERE id = ?').get(product_id);
  return masuk({
    product_id, qty: beda, unit_cost: p ? p.cost : 0, tanggal,
    kode: kode || `PENYESUAIAN-${String(tanggal || '').slice(0, 7)}`,
    catatan: note, source, sourceId, userId,
  });
}

/**
 * Menyalakan pelacakan batch untuk sebuah produk.
 *
 * Stok yang sudah ada dimasukkan sebagai satu batch pembuka tanpa tanggal
 * kadaluarsa. Tanpa itu, sisa batch akan nol sementara stoknya ratusan, dan
 * penjualan pertama langsung ditolak karena batch dianggap kosong.
 */
function nyalakanPelacakan({ product_id, tanggal, userId }) {
  const p = db.prepare('SELECT * FROM products WHERE id = ?').get(product_id);
  if (!p) throw httpError(404, 'Produk tidak ditemukan');
  if (p.lacak_batch) return null;

  db.prepare('UPDATE products SET lacak_batch = 1 WHERE id = ?').run(product_id);

  if (r2(p.stock) <= 0) return null;

  return masuk({
    product_id, qty: p.stock, unit_cost: p.cost, tanggal,
    kode: 'AWAL',
    catatan: 'Stok yang sudah ada saat pelacakan batch dinyalakan — lengkapi tanggal kadaluarsanya',
    source: 'AWAL', sourceId: product_id, userId,
  });
}

/** Sisa seluruh batch sebuah produk. Dipakai memeriksa kecocokan dengan stok. */
function sisaBatch(productId) {
  const r = db
    .prepare('SELECT COALESCE(SUM(qty_sisa), 0) AS sisa FROM product_batches WHERE product_id = ?')
    .get(productId);
  return r2(r.sisa);
}

module.exports = {
  dilacak, masuk, keluar, kembalikan, sesuaikan, nyalakanPelacakan, sisaBatch,
};
