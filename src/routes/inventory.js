'use strict';
const express = require('express');
const { z } = require('zod');
const { db, nextNumber } = require('../db');
const { requireAuth, butuhIzin } = require('../middleware/auth');
const { ah, parse, httpError, dateRange } = require('../utils/http');
const { r2, ACC, postJournal, accountByCode } = require('../utils/accounting');
const { daftarkanEkspor } = require('../utils/ekspor');
const { todayLocal } = require('../utils/time');

const router = express.Router();
router.use(requireAuth);

// ==================================================================
// MASTER PRODUK
// ==================================================================
const productSchema = z.object({
  sku: z.string().trim().min(1, 'SKU wajib diisi').max(40),
  name: z.string().trim().min(1, 'nama produk wajib diisi').max(150),
  category: z.string().trim().max(60).default('Umum'),
  unit: z.string().trim().max(15).default('PCS'),
  cost: z.number().nonnegative().default(0),
  price: z.number().nonnegative().default(0),
  min_stock: z.number().nonnegative().default(0),
  supplier_id: z.number().int().positive().optional().nullable(),
  active: z.boolean().default(true),
});

/** GET /api/inventory/products — daftar produk + nilai valuasi per baris. */
/**
 * Pengambil daftar produk.
 *
 * Dipakai bersama oleh tampilan layar dan berkas unduhan, supaya penyaring
 * yang sedang aktif di layar menghasilkan berkas dengan isi yang sama persis —
 * bukan seluruh tabel yang tidak diminta.
 */
function ambilProduk(req) {
  const search = `%${(req.query.q || '').trim()}%`;
  const category = req.query.category || undefined;

  const rows = db
    .prepare(
      `SELECT p.*, s.name AS supplier_name
         FROM products p
         LEFT JOIN partners s ON s.id = p.supplier_id
        WHERE (p.sku LIKE ? OR p.name LIKE ?)
          ${category ? 'AND p.category = ?' : ''}
          ${req.query.supplier_id ? 'AND p.supplier_id = ?' : ''}
          ${req.query.includeInactive === '1' ? '' : 'AND p.active = 1'}
        ORDER BY p.name`
    )
    .all(...[search, search, category, req.query.supplier_id].filter((x) => x !== undefined));

  const products = rows.map((p) => ({
    ...p,
    stock_value: r2(p.stock * p.cost),
    margin_base: p.price ? r2(p.price - p.cost) : null,
    margin_base_pct: p.price ? r2(((p.price - p.cost) / p.price) * 100) : null,
    // Habis dan menipis dibedakan: produk yang belum pernah diberi stok minimum
    // tidak perlu ikut membanjiri daftar "perlu restock".
    out_of_stock: p.stock <= 0,
    low_stock: p.stock > 0 && p.min_stock > 0 && p.stock <= p.min_stock,
  }));

  return {
    products,
    categories: db.prepare('SELECT DISTINCT category FROM products ORDER BY category').all().map((r) => r.category),
    totalValue: r2(products.reduce((s, p) => s + p.stock_value, 0)),
  };
}

router.get('/products', ah((req, res) => res.json(ambilProduk(req))));

router.post('/products', butuhIzin('gudang.produk'), ah((req, res) => {
  const p = parse(productSchema, req.body);
  const dupe = db.prepare('SELECT id FROM products WHERE sku = ?').get(p.sku);
  if (dupe) throw httpError(409, `SKU ${p.sku} sudah dipakai produk lain`);

  const info = db
    .prepare(
      `INSERT INTO products (sku, name, category, unit, cost, price, min_stock, supplier_id, active)
       VALUES (?,?,?,?,?,?,?,?,?)`
    )
    .run(p.sku, p.name, p.category, p.unit, p.cost, p.price, p.min_stock,
      p.supplier_id || null, p.active ? 1 : 0);

  res.status(201).json({ ok: true, product: db.prepare('SELECT * FROM products WHERE id = ?').get(info.lastInsertRowid) });
}));

router.put('/products/:id', butuhIzin('gudang.produk'), ah((req, res) => {
  const p = parse(productSchema, req.body);
  const existing = db.prepare('SELECT * FROM products WHERE id = ?').get(req.params.id);
  if (!existing) throw httpError(404, 'Produk tidak ditemukan');

  const dupe = db.prepare('SELECT id FROM products WHERE sku = ? AND id <> ?').get(p.sku, existing.id);
  if (dupe) throw httpError(409, `SKU ${p.sku} sudah dipakai produk lain`);

  db.prepare(
    `UPDATE products SET sku=?, name=?, category=?, unit=?, cost=?, price=?, min_stock=?,
            supplier_id=?, active=?
      WHERE id=?`
  ).run(p.sku, p.name, p.category, p.unit, p.cost, p.price, p.min_stock,
    p.supplier_id || null, p.active ? 1 : 0, existing.id);

  res.json({ ok: true, product: db.prepare('SELECT * FROM products WHERE id = ?').get(existing.id) });
}));

router.delete('/products/:id', butuhIzin('gudang.produk'), ah((req, res) => {
  const used = db.prepare('SELECT COUNT(*) c FROM sales_items WHERE product_id = ?').get(req.params.id).c;
  if (used > 0) {
    // Produk yang pernah terjual tidak dihapus agar histori laporan tetap utuh
    db.prepare('UPDATE products SET active = 0 WHERE id = ?').run(req.params.id);
    return res.json({ ok: true, message: 'Produk pernah dipakai transaksi — dinonaktifkan, bukan dihapus' });
  }
  db.prepare('DELETE FROM products WHERE id = ?').run(req.params.id);
  res.json({ ok: true, message: 'Produk dihapus' });
}));

// ==================================================================
// MUTASI STOK
// ==================================================================
const moveSchema = z.object({
  product_id: z.number().int().positive(),
  move_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).default(() => todayLocal()),
  move_type: z.enum(['IN', 'OUT']),
  qty: z.number().positive('jumlah harus lebih dari 0'),
  unit_cost: z.number().nonnegative().optional(),
  // Sumber dana pembelian (khusus IN) / akun beban (khusus OUT)
  // OPENING = saldo awal persediaan saat mulai memakai sistem; lawannya
  // Modal Pemilik, bukan kas, karena barangnya memang sudah ada sebelum ini.
  payment: z.enum(['CASH', 'BANK', 'CREDIT', 'OPENING']).default('CASH'),
  // Rekening kas/bank tertentu; kosong berarti akun bawaan sesuai cara bayar.
  cash_code: z.string().trim().min(3).optional().nullable(),
  partner_id: z.number().int().positive().optional().nullable(),
  due_date: z.string().optional().nullable(),
  ref: z.string().max(60).optional().nullable(),
  note: z.string().max(300).optional().nullable(),
});

/**
 * Mencatat mutasi stok + memperbarui HPP rata-rata bergerak + jurnal otomatis.
 * Seluruh langkah dibungkus satu transaksi agar stok dan jurnal tidak pernah
 * berbeda keadaan.
 */
const applyMove = db.transaction((body, userId) => {
  const product = db.prepare('SELECT * FROM products WHERE id = ?').get(body.product_id);
  if (!product) throw httpError(404, 'Produk tidak ditemukan');

  const qty = r2(body.qty);
  let newStock;
  let unitCost;

  if (body.move_type === 'IN') {
    unitCost = body.unit_cost != null ? r2(body.unit_cost) : product.cost;
    newStock = r2(product.stock + qty);

    // HPP rata-rata bergerak (moving average)
    const oldValue = product.stock * product.cost;
    const inValue = qty * unitCost;
    const avgCost = newStock > 0 ? r2((oldValue + inValue) / newStock) : unitCost;
    db.prepare('UPDATE products SET stock = ?, cost = ? WHERE id = ?').run(newStock, avgCost, product.id);
  } else {
    unitCost = product.cost;
    if (qty > product.stock) {
      throw httpError(422, `Stok ${product.name} tidak mencukupi (tersedia ${product.stock} ${product.unit})`);
    }
    newStock = r2(product.stock - qty);
    db.prepare('UPDATE products SET stock = ? WHERE id = ?').run(newStock, product.id);
  }

  const info = db
    .prepare(
      `INSERT INTO stock_moves
         (product_id, move_date, move_type, qty, unit_cost, balance_after, ref, source, note, user_id, partner_id, due_date)
       VALUES (?,?,?,?,?,?,?,'MANUAL',?,?,?,?)`
    )
    .run(
      product.id, body.move_date, body.move_type, qty, unitCost, newStock,
      body.ref || null, body.note || null, userId,
      body.partner_id || null, body.due_date || null
    );

  // Jurnal otomatis
  const value = r2(qty * unitCost);
  if (value > 0) {
    // Rekening yang dipilih hanya berlaku untuk pembayaran yang benar-benar
    // memindahkan uang; saldo awal dan pembelian tempo punya akunnya sendiri.
    let counterAccount;
    if (body.payment === 'OPENING') counterAccount = ACC.CAPITAL;
    else if (body.payment === 'CREDIT') counterAccount = ACC.AP;
    else if (body.cash_code) {
      const akunKas = accountByCode(body.cash_code);
      if (!akunKas.is_cash) throw httpError(422, `${akunKas.code} bukan akun kas atau bank`);
      counterAccount = akunKas.code;
    } else counterAccount = body.payment === 'BANK' ? ACC.BANK : ACC.CASH;

    const lines =
      body.move_type === 'IN'
        ? [
            { code: ACC.INVENTORY, debit: value, credit: 0, memo: `Stok masuk ${product.name}` },
            {
              code: counterAccount, debit: 0, credit: value,
              memo: body.payment === 'OPENING' ? 'Saldo awal persediaan'
                : body.payment === 'CREDIT' ? 'Utang supplier'
                : 'Pembayaran pembelian',
              partner_id: body.payment === 'CREDIT' ? body.partner_id || null : null,
            },
          ]
        : [
            { code: ACC.OTHER_EXPENSE, debit: value, credit: 0, memo: `Pemakaian stok ${product.name}` },
            { code: ACC.INVENTORY, debit: 0, credit: value, memo: 'Pengurangan persediaan' },
          ];

    postJournal({
      date: body.move_date,
      description: `${body.move_type === 'IN' ? 'Stok Masuk' : 'Stok Keluar'} — ${product.name} (${qty} ${product.unit})`,
      lines,
      source: 'STOCK',
      sourceId: info.lastInsertRowid,
      userId,
    });
  }

  return db.prepare('SELECT * FROM stock_moves WHERE id = ?').get(info.lastInsertRowid);
});

router.post('/moves', butuhIzin('gudang.mutasi'), ah((req, res) => {
  const body = parse(moveSchema, req.body);
  res.status(201).json({ ok: true, move: applyMove(body, req.user.id) });
}));

/** GET /api/inventory/moves — kartu stok / log mutasi. */
/**
 * Batas jumlah baris yang dikembalikan.
 *
 * Angkanya dulu dipatok 1000 di dalam kueri. Saat dipakai menghitung koreksi
 * pembukuan, daftar yang terpotong itu menghasilkan angka yang tampak masuk akal
 * tetapi salah — jenis kekeliruan yang paling sulit disadari karena tidak ada
 * tanda apa pun bahwa datanya kurang.
 */
function batasBaris(nilai, bawaan = 1000, atap = 20000) {
  const n = Number(nilai);
  if (!Number.isFinite(n) || n <= 0) return bawaan;
  return Math.min(Math.floor(n), atap);
}

/** Pengambil daftar mutasi stok — dipakai layar dan berkas unduhan. */
function ambilMutasi(req) {
  const { from, to } = dateRange(req.query);
  const params = [from, to];
  let where = 'WHERE m.move_date BETWEEN ? AND ?';
  if (req.query.product_id) { where += ' AND m.product_id = ?'; params.push(Number(req.query.product_id)); }
  if (req.query.move_type) { where += ' AND m.move_type = ?'; params.push(req.query.move_type); }

  const rows = db
    .prepare(
      `SELECT m.*, p.sku, p.name AS product_name, p.unit, u.name AS user_name,
              (m.qty * m.unit_cost) AS value
         FROM stock_moves m
         JOIN products p ON p.id = m.product_id
         LEFT JOIN users u ON u.id = m.user_id
         ${where}
        ORDER BY m.move_date DESC, m.id DESC
        LIMIT ?`
    )
    .all(...params, batasBaris(req.query.limit));

  return {
    from, to, rows,
    terpotong: rows.length >= batasBaris(req.query.limit),
    summary: {
      inQty: r2(rows.filter((r) => r.move_type === 'IN').reduce((s, r) => s + r.qty, 0)),
      outQty: r2(rows.filter((r) => r.move_type === 'OUT').reduce((s, r) => s + r.qty, 0)),
      inValue: r2(rows.filter((r) => r.move_type === 'IN').reduce((s, r) => s + r.value, 0)),
      outValue: r2(rows.filter((r) => r.move_type === 'OUT').reduce((s, r) => s + r.value, 0)),
    },
  };
}

router.get('/moves', ah((req, res) => res.json(ambilMutasi(req))));

// ==================================================================
// VALUASI STOK REAL-TIME
// ==================================================================
/** GET /api/inventory/valuation — nilai persediaan = Σ (stok × HPP). */
/** Pengambil valuasi stok — dipakai layar dan berkas unduhan. */
function ambilValuasi() {
  const rows = db
    .prepare(
      // Nama pemasok ikut dibawa supaya halaman valuasi bisa menjawab
      // "barang senilai sekian ini dipasok siapa" tanpa pindah menu.
      `SELECT p.id, p.sku, p.name, p.category, p.unit, p.stock, p.cost, p.price, p.min_stock,
              mp.name AS supplier_name,
              (p.stock * p.cost)  AS stock_value,
              (p.stock * p.price) AS potential_revenue
         FROM products p
         LEFT JOIN partners mp ON mp.id = p.supplier_id
        WHERE p.active = 1
        ORDER BY (p.stock * p.cost) DESC`
    )
    .all();

  const byCategory = {};
  for (const r of rows) {
    byCategory[r.category] = byCategory[r.category] || { category: r.category, qty: 0, value: 0, skus: 0 };
    byCategory[r.category].qty = r2(byCategory[r.category].qty + r.stock);
    byCategory[r.category].value = r2(byCategory[r.category].value + r.stock_value);
    byCategory[r.category].skus += 1;
  }

  const totalValue = r2(rows.reduce((s, r) => s + r.stock_value, 0));
  const potentialRevenue = r2(rows.reduce((s, r) => s + r.potential_revenue, 0));

  return {
    asOf: new Date().toISOString(),
    totalSku: rows.length,
    totalQty: r2(rows.reduce((s, r) => s + r.stock, 0)),
    totalValue,
    potentialRevenue,
    potentialMargin: r2(potentialRevenue - totalValue),
    // Perlu ditindak = stok menipis tapi belum habis, plus barang habis yang
    // memang punya ambang minimum. Produk yang tidak pernah distok tidak ikut.
    lowStock: rows
      .filter((r) => r.min_stock > 0 && r.stock <= r.min_stock)
      .map((r) => ({ ...r, stock_value: r2(r.stock_value), out_of_stock: r.stock <= 0 })),
    outOfStock: rows.filter((r) => r.stock <= 0).length,
    neverStocked: rows.filter((r) => r.stock <= 0 && r.min_stock <= 0).length,
    byCategory: Object.values(byCategory).sort((a, b) => b.value - a.value),
    rows: rows.map((r) => ({ ...r, stock_value: r2(r.stock_value), potential_revenue: r2(r.potential_revenue) })),
  };
}

router.get('/valuation', ah((req, res) => res.json(ambilValuasi())));

// ------------------------------------------------------------------
// Unduhan — satu definisi kolom menghasilkan Excel dan PDF sekaligus
// ------------------------------------------------------------------

daftarkanEkspor(router, {
  path: '/products',
  judul: 'Master Produk',
  kolom: [
    { header: 'SKU', key: 'sku', width: 16 },
    { header: 'Nama Produk', key: 'name', width: 34 },
    { header: 'Kategori', key: 'category', width: 16 },
    { header: 'Satuan', key: 'unit', width: 9 },
    { header: 'Pemasok', key: 'supplier_name', width: 22 },
    { header: 'Stok', key: 'stock', width: 9 },
    { header: 'Stok Minimum', key: 'min_stock', width: 12 },
    { header: 'HPP / Satuan', key: 'cost', width: 14, money: true },
    { header: 'Harga Jual', key: 'price', width: 14, money: true },
    { header: 'Nilai Persediaan', key: 'stock_value', width: 16, money: true },
  ],
  ambil: (req) => {
    const d = ambilProduk(req);
    return {
      rows: d.products,
      subtitle: req.query.q ? `Pencarian: ${req.query.q}` : 'Seluruh produk aktif',
      meta: [
        ['Jumlah produk', d.products.length],
        ['Total nilai persediaan', d.totalValue],
      ],
    };
  },
});

daftarkanEkspor(router, {
  path: '/moves',
  judul: 'Mutasi Stok',
  kolom: [
    { header: 'Tanggal', key: 'move_date', width: 12 },
    { header: 'Jenis', key: 'move_type', width: 8 },
    { header: 'SKU', key: 'sku', width: 15 },
    { header: 'Produk', key: 'product_name', width: 32 },
    { header: 'Satuan', key: 'unit', width: 9 },
    { header: 'Jumlah', key: 'qty', width: 10 },
    { header: 'HPP / Satuan', key: 'unit_cost', width: 14, money: true },
    { header: 'Nilai', key: 'value', width: 15, money: true },
    { header: 'Saldo Sesudah', key: 'balance_after', width: 12 },
    { header: 'Referensi', key: 'ref', width: 18 },
    { header: 'Dicatat Oleh', key: 'user_name', width: 18 },
  ],
  ambil: (req) => {
    const d = ambilMutasi(req);
    return {
      rows: d.rows,
      subtitle: `Periode ${d.from} s/d ${d.to}`,
      meta: [
        ['Unit masuk', d.summary.inQty],
        ['Unit keluar', d.summary.outQty],
        ['Nilai barang masuk', d.summary.inValue],
        ['Nilai barang keluar', d.summary.outValue],
      ],
    };
  },
});

daftarkanEkspor(router, {
  path: '/valuation',
  judul: 'Valuasi Stok',
  kolom: [
    { header: 'SKU', key: 'sku', width: 16 },
    { header: 'Nama Produk', key: 'name', width: 34 },
    { header: 'Kategori', key: 'category', width: 16 },
    { header: 'Satuan', key: 'unit', width: 9 },
    { header: 'Pemasok', key: 'supplier_name', width: 22 },
    { header: 'Stok', key: 'stock', width: 9 },
    { header: 'HPP / Satuan', key: 'cost', width: 14, money: true },
    { header: 'Harga Jual', key: 'price', width: 14, money: true },
    { header: 'Nilai Persediaan', key: 'stock_value', width: 16, money: true },
    { header: 'Potensi Pendapatan', key: 'potential_revenue', width: 18, money: true },
  ],
  ambil: () => {
    const d = ambilValuasi();
    return {
      rows: d.rows,
      subtitle: `Posisi ${new Date().toLocaleDateString('id-ID')}`,
      meta: [
        ['Jumlah SKU', d.totalSku],
        ['Total unit', d.totalQty],
        ['Total nilai persediaan', d.totalValue],
        ['Potensi pendapatan', d.potentialRevenue],
      ],
    };
  },
});

daftarkanEkspor(router, {
  path: '/opname',
  judul: 'Riwayat Stok Opname',
  kolom: [
    { header: 'Nomor', key: 'opname_no', width: 20 },
    { header: 'Tanggal', key: 'opname_date', width: 12 },
    { header: 'Status', key: 'status', width: 12 },
    { header: 'Jumlah Produk', key: 'line_count', width: 13 },
    { header: 'Nilai Selisih', key: 'total_diff_value', width: 16, money: true },
    { header: 'Catatan', key: 'note', width: 40 },
    { header: 'Dicatat Oleh', key: 'user_name', width: 18 },
  ],
  ambil: () => {
    const rows = ambilOpname();
    return {
      rows,
      subtitle: 'Seluruh riwayat penyesuaian stok',
      meta: [
        ['Jumlah opname', rows.length],
        ['Total nilai selisih', r2(rows.reduce((s, r) => s + (r.total_diff_value || 0), 0))],
      ],
    };
  },
});


// ==================================================================
// STOK OPNAME
// ==================================================================
const opnameSchema = z.object({
  opname_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).default(() => todayLocal()),
  note: z.string().max(300).optional().nullable(),
  lines: z
    .array(
      z.object({
        product_id: z.number().int().positive(),
        physical_qty: z.number().nonnegative(),
        note: z.string().max(200).optional().nullable(),
      })
    )
    .min(1, 'minimal satu baris produk'),
});

/** GET /api/inventory/opname/sheet — lembar kerja opname berisi stok sistem terkini. */
router.get('/opname/sheet', ah((req, res) => {
  const rows = db
    .prepare('SELECT id, sku, name, category, unit, stock AS system_qty, cost FROM products WHERE active = 1 ORDER BY category, name')
    .all();
  res.json({ date: todayLocal(), rows });
}));

/**
 * POST /api/inventory/opname — merekam & langsung memposting rekonsiliasi.
 * Selisih fisik vs sistem menghasilkan mutasi ADJ dan jurnal Selisih Stok.
 */
const createOpname = db.transaction((body, userId) => {
  const period = body.opname_date.slice(0, 7);
  const opnameNo = nextNumber('OPN', period);

  const header = db
    .prepare(
      `INSERT INTO stock_opnames (opname_no, opname_date, note, status, user_id, posted_at)
       VALUES (?,?,?, 'POSTED', ?, datetime('now'))`
    )
    .run(opnameNo, body.opname_date, body.note || null, userId);

  const opnameId = header.lastInsertRowid;
  const insertLine = db.prepare(
    `INSERT INTO stock_opname_lines
       (opname_id, product_id, system_qty, physical_qty, diff_qty, unit_cost, diff_value, note)
     VALUES (?,?,?,?,?,?,?,?)`
  );

  let totalDiffValue = 0;
  const adjustments = [];

  for (const line of body.lines) {
    const product = db.prepare('SELECT * FROM products WHERE id = ?').get(line.product_id);
    if (!product) throw httpError(404, `Produk id ${line.product_id} tidak ditemukan`);

    const systemQty = r2(product.stock);
    const physicalQty = r2(line.physical_qty);
    const diffQty = r2(physicalQty - systemQty);
    const diffValue = r2(diffQty * product.cost);

    insertLine.run(opnameId, product.id, systemQty, physicalQty, diffQty, product.cost, diffValue, line.note || null);
    totalDiffValue = r2(totalDiffValue + diffValue);

    if (diffQty !== 0) {
      db.prepare('UPDATE products SET stock = ? WHERE id = ?').run(physicalQty, product.id);
      db.prepare(
        `INSERT INTO stock_moves
           (product_id, move_date, move_type, qty, unit_cost, balance_after, ref, source, source_id, note, user_id)
         VALUES (?,?,'ADJ',?,?,?,?,'OPNAME',?,?,?)`
      ).run(
        product.id, body.opname_date, Math.abs(diffQty), product.cost, physicalQty,
        opnameNo, opnameId,
        `Koreksi opname: ${diffQty > 0 ? 'lebih' : 'kurang'} ${Math.abs(diffQty)} ${product.unit}`,
        userId
      );
      adjustments.push({ product: product.name, diffQty, diffValue });
    }
  }

  db.prepare('UPDATE stock_opnames SET total_diff_value = ? WHERE id = ?').run(totalDiffValue, opnameId);

  // Jurnal selisih: surplus menambah persediaan, defisit membebankan kerugian.
  if (Math.abs(totalDiffValue) > 0.004) {
    const value = Math.abs(totalDiffValue);
    const lines =
      totalDiffValue > 0
        ? [
            { code: ACC.INVENTORY, debit: value, credit: 0, memo: 'Surplus stok opname' },
            { code: ACC.STOCK_VARIANCE, debit: 0, credit: value, memo: 'Koreksi selisih lebih' },
          ]
        : [
            { code: ACC.STOCK_VARIANCE, debit: value, credit: 0, memo: 'Kerugian selisih stok' },
            { code: ACC.INVENTORY, debit: 0, credit: value, memo: 'Defisit stok opname' },
          ];

    postJournal({
      date: body.opname_date,
      description: `Penyesuaian Stok Opname ${opnameNo}`,
      lines,
      source: 'OPNAME',
      sourceId: opnameId,
      userId,
    });
  }

  return { id: opnameId, opname_no: opnameNo, total_diff_value: totalDiffValue, adjustments };
});

router.post('/opname', butuhIzin('gudang.produk'), ah((req, res) => {
  const body = parse(opnameSchema, req.body);
  res.status(201).json({ ok: true, ...createOpname(body, req.user.id) });
}));

/** Pengambil riwayat opname — dipakai layar dan berkas unduhan. */
function ambilOpname() {
  return db
    .prepare(
      `SELECT o.*, u.name AS user_name,
              (SELECT COUNT(*) FROM stock_opname_lines l WHERE l.opname_id = o.id) AS line_count
         FROM stock_opnames o LEFT JOIN users u ON u.id = o.user_id
        ORDER BY o.opname_date DESC, o.id DESC LIMIT 200`
    )
    .all();
}

router.get('/opname', ah((req, res) => res.json({ rows: ambilOpname() })));

router.get('/opname/:id', ah((req, res) => {
  const header = db.prepare('SELECT * FROM stock_opnames WHERE id = ?').get(req.params.id);
  if (!header) throw httpError(404, 'Dokumen opname tidak ditemukan');

  const lines = db
    .prepare(
      `SELECT l.*, p.sku, p.name AS product_name, p.unit
         FROM stock_opname_lines l JOIN products p ON p.id = l.product_id
        WHERE l.opname_id = ? ORDER BY p.name`
    )
    .all(header.id);

  res.json({ header, lines });
}));

// applyMove diekspor agar modul pembelian memakai jalur yang sama saat barang
// diterima — stok, HPP rata-rata, dan jurnalnya tidak boleh punya versi kedua.
module.exports = router;
module.exports.applyMove = applyMove;
