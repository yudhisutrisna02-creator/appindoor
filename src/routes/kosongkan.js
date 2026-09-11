'use strict';
/**
 * Mengosongkan satu bulan pembukuan.
 *
 * Dipakai ketika data sebuah bulan sudah terlanjur bercampur — hasil impor,
 * salah harga, pembayaran salah rekening — dan pemiliknya memilih memulai
 * bersih dari bulan berikutnya: stok dibetulkan lewat stok opname, saldo tiap
 * rekening dimasukkan sebagai saldo awal.
 *
 * Yang dihapus pada bulan itu:
 *   - order penjualan (dibatalkan lewat jalur batal biasa, beserta returnya),
 *   - mutasi stok selain penjualan: barang masuk/keluar, koreksi, opname —
 *     stok produknya dikembalikan sebesar pengaruh mutasi itu,
 *   - dokumen stok opname dan pesanan pembelian bulan itu,
 *   - belanja iklan,
 *   - SEMUA jurnal bertanggal bulan itu (pelunasan utang/piutang, kas
 *     masuk/keluar, pindah saldo, jurnal manual, dst).
 *
 * Yang TIDAK disentuh: data master (produk, mitra, toko, rekening), presensi,
 * slip gaji yang belum diposting, dan seluruh catatan bulan lain.
 *
 * Seperti Hapus Periode, alurnya dua langkah — periksa, lalu terapkan dengan
 * kata kunci yang diketik ulang — dan cadangan basis data dibuat otomatis
 * tepat sebelum penghapusan, supaya kesalahan pilih bulan masih bisa dipulihkan.
 */
const express = require('express');
const { z } = require('zod');
const { db } = require('../db');
const { requireAuth, butuhIzin } = require('../middleware/auth');
const { ah, parse, httpError } = require('../utils/http');
const { r2, ACC, postJournal, deleteJournalById } = require('../utils/accounting');
const { buatCadangan } = require('../utils/cadangan');
const sales = require('./sales');

const router = express.Router();
router.use(requireAuth);
router.use(butuhIzin('sistem.cadangan'));

// Sumber jurnal yang boleh ikut terhapus. Selain ini, jurnalnya milik dokumen
// yang punya status sendiri (mis. slip gaji terposting) — menghapus jurnalnya
// saja akan membuat dokumen itu mengaku sudah dibukukan padahal tidak.
const SUMBER_DIHAPUS = new Set([
  'SALES', 'RETURN', 'STOCK', 'OPNAME', 'KOREKSI', 'ADS', 'SETTLEMENT',
  'CASH', 'TRANSFER', 'MANUAL', 'AWAL',
]);

const LABEL = {
  SALES: 'Penjualan', RETURN: 'Retur penjualan', STOCK: 'Barang masuk/keluar',
  OPNAME: 'Stok opname', KOREKSI: 'Koreksi stok', ADS: 'Biaya iklan',
  SETTLEMENT: 'Pelunasan utang/piutang', CASH: 'Kas masuk/keluar',
  TRANSFER: 'Pindah saldo', MANUAL: 'Jurnal manual', AWAL: 'Saldo awal',
};

function rentangBulan(bulan) {
  const [y, m] = bulan.split('-').map(Number);
  const akhir = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { from: `${bulan}-01`, to: `${bulan}-${String(akhir).padStart(2, '0')}` };
}

/**
 * Pengaruh satu mutasi terhadap stok, bertanda. Mutasi ADJ menyimpan qty tanpa
 * tanda, jadi arahnya diambil dari baris opname atau dari catatan koreksinya.
 */
function pengaruhMutasi(m) {
  if (m.move_type === 'IN') return r2(m.qty);
  if (m.move_type === 'OUT') return r2(-m.qty);
  if (m.source === 'OPNAME') {
    const baris = db
      .prepare('SELECT diff_qty FROM stock_opname_lines WHERE opname_id = ? AND product_id = ?')
      .get(m.source_id, m.product_id);
    if (baris && baris.diff_qty) return r2(Math.sign(baris.diff_qty) * m.qty);
  }
  const catatan = String(m.note || '');
  const koreksi = catatan.match(/Koreksi stok (-?[\d.]+) → (-?[\d.]+)/);
  if (koreksi) return r2(Number(koreksi[2]) - Number(koreksi[1]));
  if (/\bkurang\b/i.test(catatan)) return r2(-m.qty);
  if (/\blebih\b/i.test(catatan)) return r2(m.qty);
  return null;
}

/**
 * Utang/piutang tiap mitra yang TERBENTUK di bulan ini (jurnal bertanggal bulan
 * ini saja — saldo dari bulan sebelumnya tidak ikut terhapus, jadi tidak perlu
 * dibawa). Inilah yang dibawa sebagai saldo awal supaya tidak ikut hilang.
 */
function saldoMitraBulan(from, to) {
  return db
    .prepare(
      `SELECT p.id AS partner_id, p.name, a.id AS account_id, a.code, a.subtype,
              COALESCE(SUM(CASE WHEN a.subtype = 'PAYABLE' THEN l.credit - l.debit
                                ELSE l.debit - l.credit END), 0) AS nilai
         FROM journal_lines l
         JOIN journals j ON j.id = l.journal_id
         JOIN accounts a ON a.id = l.account_id
         JOIN partners p ON p.id = l.partner_id
        WHERE j.posted = 1 AND j.entry_date BETWEEN ? AND ?
          AND a.subtype IN ('PAYABLE', 'RECEIVABLE')
        GROUP BY p.id, a.id
       HAVING ABS(nilai) >= 0.01
        ORDER BY nilai DESC`
    )
    .all(from, to)
    .map((r) => ({ ...r, nilai: r2(r.nilai), jenis: r.subtype === 'PAYABLE' ? 'Utang' : 'Piutang' }));
}

function periksa(bulan) {
  const { from, to } = rentangBulan(bulan);
  const penghalang = [];

  if (db.prepare('SELECT 1 FROM period_locks WHERE period = ?').get(bulan)) {
    penghalang.push(`Bulan ${bulan} sudah ditutup buku — buka dulu tutup bukunya di Riwayat`);
  }

  // 1. Order penjualan (beserta retur dan jurnalnya) — lewat jalur Hapus Periode.
  const c = sales.calonBersihkan(from, to);
  if (c.returMacet.length) {
    penghalang.push(
      `${c.returMacet.length} retur tidak bisa dibalik (${c.returMacet.map((r) => r.return_no).slice(0, 5).join(', ')}) ` +
        '— barangnya sudah selesai dikemas ulang atau returnya di bulan tertutup'
    );
  }
  const idOrder = new Set(c.orders.map((o) => o.id));

  // 2. Mutasi stok selain penjualan & retur (keduanya ikut order-nya).
  const mutasi = db
    .prepare(
      `SELECT m.*, p.sku, p.name AS product_name, p.unit
         FROM stock_moves m JOIN products p ON p.id = m.product_id
        WHERE m.move_date BETWEEN ? AND ?
        ORDER BY m.move_date, m.id`
    )
    .all(from, to);
  const mutasiLain = [];
  for (const m of mutasi) {
    if (m.source === 'SALES') {
      if (!idOrder.has(m.source_id)) {
        penghalang.push(`Mutasi penjualan ${m.ref || m.id} tidak terhubung ke order bulan ini`);
      }
      continue;
    }
    if (m.source === 'RETURN') {
      const r = db.prepare('SELECT order_id FROM sales_returns WHERE id = ?').get(m.source_id);
      if (!r || !idOrder.has(r.order_id)) {
        penghalang.push(`Retur ${m.ref || m.id} bulan ini milik order bulan lain — batalkan returnya dulu`);
      }
      continue;
    }
    const pengaruh = pengaruhMutasi(m);
    if (pengaruh === null) {
      penghalang.push(`Arah mutasi ${m.ref || m.id} (${m.product_name}) tidak bisa ditentukan`);
      continue;
    }
    mutasiLain.push({ ...m, pengaruh });
  }
  const batchLain = db
    .prepare(
      `SELECT COUNT(*) n FROM batch_moves
        WHERE move_date BETWEEN ? AND ? AND source NOT IN ('SALES', 'RETURN')`
    )
    .get(from, to).n;
  if (batchLain) {
    penghalang.push(`${batchLain} pergerakan batch di luar penjualan — betulkan lewat menu batch dulu`);
  }

  // 3. Dokumen yang ikut dihapus.
  const opname = db.prepare('SELECT * FROM stock_opnames WHERE opname_date BETWEEN ? AND ?').all(from, to);
  const iklan = db.prepare('SELECT * FROM ad_spends WHERE spend_date BETWEEN ? AND ?').all(from, to);
  const po = db.prepare('SELECT * FROM purchase_orders WHERE order_date BETWEEN ? AND ?').all(from, to);
  for (const p of po) {
    const luar = db
      .prepare('SELECT COUNT(*) n FROM stock_moves WHERE ref = ? AND move_date NOT BETWEEN ? AND ?')
      .get(p.po_no, from, to).n;
    if (luar) penghalang.push(`${p.po_no} punya penerimaan barang di bulan lain — betulkan pesanannya dulu`);
  }
  const returPO = db
    .prepare(
      `SELECT COUNT(*) n FROM purchase_returns
        WHERE po_id IN (SELECT id FROM purchase_orders WHERE order_date BETWEEN ? AND ?)`
    )
    .get(from, to).n;
  if (returPO) penghalang.push('Ada retur pembelian dari pesanan bulan ini — hapus dulu returnya');

  // 4. Seluruh jurnal yang akan hilang: yang bertanggal bulan ini, ditambah
  //    jurnal retur (bisa bertanggal bulan berikutnya) milik order bulan ini.
  const jurnalBulan = db
    .prepare('SELECT id, entry_no, entry_date, source, source_id FROM journals WHERE entry_date BETWEEN ? AND ?')
    .all(from, to);
  const asing = jurnalBulan.filter((j) => !SUMBER_DIHAPUS.has(j.source));
  if (asing.length) {
    const jenis = [...new Set(asing.map((j) => j.source))].join(', ');
    penghalang.push(
      `${asing.length} jurnal dari modul ${jenis} milik dokumen yang punya status sendiri — batalkan lewat modulnya dulu`
    );
  }
  const idRetur = c.retur.map((r) => r.id);
  const jurnalReturLuar = idRetur.length
    ? db
        .prepare(
          `SELECT id, entry_no, entry_date, source, source_id FROM journals
            WHERE source = 'RETURN' AND source_id IN (${idRetur.map(() => '?').join(',')})
              AND entry_date NOT BETWEEN ? AND ?`
        )
        .all(...idRetur, from, to)
    : [];
  const semuaJurnal = [...jurnalBulan, ...jurnalReturLuar];
  const bulanLuar = [...new Set(jurnalReturLuar.map((j) => j.entry_date.slice(0, 7)))];
  for (const b of bulanLuar) {
    if (db.prepare('SELECT 1 FROM period_locks WHERE period = ?').get(b)) {
      penghalang.push(`Retur order bulan ini tercatat di bulan ${b} yang sudah ditutup buku`);
    }
  }

  const perSumber = {};
  for (const j of semuaJurnal) perSumber[j.source] = (perSumber[j.source] || 0) + 1;

  // Pengaruh pada saldo akun. Dua angka per akun: saldo awal bulan berikutnya
  // (akhir bulan ini) dan saldo hari ini — keduanya sebelum → sesudah.
  let akun = [];
  let piutangTertahan = 0;
  if (semuaJurnal.length) {
    db.exec('CREATE TEMP TABLE IF NOT EXISTS _kosongkan_ids (id INTEGER PRIMARY KEY)');
    db.exec('DELETE FROM _kosongkan_ids');
    const masuk = db.prepare('INSERT INTO _kosongkan_ids (id) VALUES (?)');
    db.transaction(() => { for (const j of semuaJurnal) masuk.run(j.id); })();
    akun = db
      .prepare(
        `SELECT a.code, a.name, a.is_cash, a.subtype, a.normal,
                COALESCE(SUM(l.debit - l.credit), 0) AS hilang,
                COALESCE(SUM(CASE WHEN j.entry_date <= ? THEN l.debit - l.credit ELSE 0 END), 0) AS hilang_akhir,
                (SELECT COALESCE(SUM(l2.debit - l2.credit), 0)
                   FROM journal_lines l2 JOIN journals j2 ON j2.id = l2.journal_id
                  WHERE l2.account_id = a.id AND j2.posted = 1) AS saldo,
                (SELECT COALESCE(SUM(l2.debit - l2.credit), 0)
                   FROM journal_lines l2 JOIN journals j2 ON j2.id = l2.journal_id
                  WHERE l2.account_id = a.id AND j2.posted = 1 AND j2.entry_date <= ?) AS saldo_akhir
           FROM journal_lines l
           JOIN _kosongkan_ids k ON k.id = l.journal_id
           JOIN journals j ON j.id = l.journal_id
           JOIN accounts a ON a.id = l.account_id
          GROUP BY a.id ORDER BY a.code`
      )
      .all(to, to)
      .map((a) => {
        const tanda = a.normal === 'D' ? 1 : -1;
        return {
          code: a.code, name: a.name, is_cash: a.is_cash, subtype: a.subtype,
          akhirSekarang: r2(tanda * a.saldo_akhir),
          akhirSesudah: r2(tanda * (a.saldo_akhir - a.hilang_akhir)),
          sekarang: r2(tanda * a.saldo),
          sesudah: r2(tanda * (a.saldo - a.hilang)),
        };
      })
      .filter((a) => Math.abs(a.sekarang - a.sesudah) >= 0.01 || Math.abs(a.akhirSekarang - a.akhirSesudah) >= 0.01);

    // Dana marketplace dari order bulan ini yang BELUM cair. Setelah ordernya
    // hilang, uang itu tidak punya catatan apa pun ketika nanti masuk rekening.
    piutangTertahan = r2(
      db
        .prepare(
          `SELECT COALESCE(SUM(l.debit - l.credit), 0) s
             FROM journal_lines l
             JOIN _kosongkan_ids k ON k.id = l.journal_id
             JOIN journals j ON j.id = l.journal_id
             JOIN accounts a ON a.id = l.account_id
            WHERE j.source = 'SALES' AND a.subtype = 'RECEIVABLE' AND l.partner_id IS NULL`
        )
        .get().s
    );
    db.exec('DELETE FROM _kosongkan_ids');
  }

  // Sisa utang/piutang tiap mitra per akhir bulan ini. Pembayaran di bulan
  // berikutnya sering melunasi utang bulan ini; tanpa saldo awal, utangnya
  // menjadi minus begitu bulan ini dikosongkan.
  const saldoMitra = saldoMitraBulan(from, to);

  // Stok per produk sesudahnya: order dibatalkan mengembalikan barangnya,
  // mutasi lain dibalik sebesar pengaruhnya.
  const ubahStok = new Map();
  const tambah = (id, qty) => ubahStok.set(id, r2((ubahStok.get(id) || 0) + qty));
  for (const s of c.stok) tambah(s.id, s.qty);
  for (const m of mutasiLain) tambah(m.product_id, -m.pengaruh);
  const retur = db
    .prepare(
      `SELECT r.product_id, r.qty, r.kondisi, r.restock FROM sales_returns r
        WHERE r.id IN (${idRetur.length ? idRetur.map(() => '?').join(',') : 'NULL'})`
    )
    .all(...idRetur);
  for (const r of retur) {
    if ((r.kondisi || (r.restock ? 'BAGUS' : 'RUSAK')) === 'BAGUS') tambah(r.product_id, -r.qty);
  }
  const stok = [...ubahStok.entries()]
    .filter(([, q]) => Math.abs(q) >= 0.001)
    .map(([id, q]) => {
      const p = db.prepare('SELECT id, sku, name, unit, stock FROM products WHERE id = ?').get(id);
      return { ...p, sekarang: r2(p.stock), sesudah: r2(p.stock + q), berubah: q };
    })
    .sort((a, b) => a.sesudah - b.sesudah);

  const ringkas = {
    bulan, from, to,
    orders: c.orders.length,
    penjualanKotor: r2(c.orders.reduce((s, o) => s + (o.gross_sales || 0), 0)),
    retur: c.retur.length,
    returBulanLain: c.retur.filter((r) => String(r.return_date).slice(0, 7) !== bulan).length,
    mutasiStok: mutasiLain.length,
    barangMasuk: mutasiLain.filter((m) => m.move_type === 'IN').length,
    barangKeluar: mutasiLain.filter((m) => m.move_type === 'OUT').length,
    koreksiOpname: mutasiLain.filter((m) => m.move_type === 'ADJ').length,
    opname: opname.length,
    iklan: iklan.length,
    nilaiIklan: r2(iklan.reduce((s, x) => s + (x.amount || 0), 0)),
    pesananBeli: po.length,
    jurnal: semuaJurnal.length,
    perSumber: Object.entries(perSumber)
      .map(([source, n]) => ({ source, label: LABEL[source] || source, n }))
      .sort((a, b) => b.n - a.n),
    produkMinus: stok.filter((s) => s.sesudah < 0).length,
    piutangTertahan,
    kataKunci: `KOSONGKAN ${bulan}`,
  };

  // Bukan penghalang, tetapi harus diketahui sebelum tombolnya ditekan.
  const rp = (n) => `Rp ${r2(n).toLocaleString('id-ID')}`;
  const peringatan = [];
  if (piutangTertahan > 0.01) {
    peringatan.push(
      `${rp(piutangTertahan)} dana marketplace dari order bulan ini belum cair. Setelah ordernya dihapus, ` +
        'uang itu tidak tercatat otomatis saat masuk rekening — catat lewat Kas Masuk bila sudah cair.'
    );
  }
  if (ringkas.returBulanLain) {
    peringatan.push(
      `${ringkas.returBulanLain} retur bertanggal bulan lain ikut terhapus karena ordernya dari bulan ini.`
    );
  }
  if (ringkas.produkMinus) {
    peringatan.push(`${ringkas.produkMinus} produk stoknya menjadi minus — betulkan lewat stok opname.`);
  }

  return {
    ringkas, penghalang: [...new Set(penghalang)], peringatan, akun, stok, saldoMitra,
    returBulanLain: c.retur.filter((r) => String(r.return_date).slice(0, 7) !== bulan),
    _rencana: { orders: c.orders, mutasiLain, opname, iklan, po, jurnalBulan, saldoMitra, to, bulan },
  };
}

const NAMA_BULAN = ['Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni', 'Juli',
  'Agustus', 'September', 'Oktober', 'November', 'Desember'];

/** Membawa utang/piutang mitra yang terbentuk di bulan ini sebagai saldo awal. */
function bawaSaldoMitra(rencana, userId, mitraDibawa) {
  const [y, m, d] = rencana.to.split('-');
  const per = `${Number(d)} ${NAMA_BULAN[Number(m) - 1]} ${y}`;
  let n = 0;
  for (const s of rencana.saldoMitra) {
    // Mitra yang tidak dicentang: utangnya ikut hilang bersama bulan itu.
    if (mitraDibawa && !mitraDibawa.includes(s.partner_id)) continue;
    const nilai = Math.abs(s.nilai);
    const utang = s.subtype === 'PAYABLE';
    // Utang: Modal (D) lawan Utang mitra (K). Piutang: Piutang mitra (D) lawan Modal (K).
    // Nilai minus (lebih bayar) membalik arahnya.
    const mitraDiKredit = utang ? s.nilai > 0 : s.nilai < 0;
    const barisMitra = {
      account_id: s.account_id, partner_id: s.partner_id,
      debit: mitraDiKredit ? 0 : nilai, credit: mitraDiKredit ? nilai : 0,
      memo: `Saldo awal ${s.jenis.toLowerCase()} per ${per}`,
    };
    const barisModal = {
      code: ACC.CAPITAL,
      debit: mitraDiKredit ? nilai : 0, credit: mitraDiKredit ? 0 : nilai,
      memo: `Saldo awal ${s.jenis.toLowerCase()} ${s.name}`,
    };
    postJournal({
      date: rencana.to,
      description: `Saldo awal ${s.jenis.toLowerCase()} — ${s.name} per ${per}`,
      lines: mitraDiKredit ? [barisModal, barisMitra] : [barisMitra, barisModal],
      source: 'AWAL',
      sourceId: s.partner_id,
      userId,
    });
    n += 1;
  }
  return n;
}

const jalankan = db.transaction((rencana, opsi) => {
  // Order lebih dulu: pembatalan mengembalikan stoknya, dan pembalikan retur
  // memeriksa bahwa barang yang dulu kembali masih ada.
  for (const o of rencana.orders) sales.cancelOrder(o.id);

  for (const m of rencana.mutasiLain) {
    const p = db.prepare('SELECT stock FROM products WHERE id = ?').get(m.product_id);
    db.prepare('UPDATE products SET stock = ? WHERE id = ?').run(r2(p.stock - m.pengaruh), m.product_id);
    db.prepare('DELETE FROM stock_moves WHERE id = ?').run(m.id);
  }

  for (const o of rencana.opname) {
    db.prepare('DELETE FROM stock_opname_lines WHERE opname_id = ?').run(o.id);
    db.prepare('DELETE FROM stock_opnames WHERE id = ?').run(o.id);
  }
  for (const x of rencana.iklan) db.prepare('DELETE FROM ad_spends WHERE id = ?').run(x.id);
  for (const p of rencana.po) {
    db.prepare('DELETE FROM purchase_items WHERE po_id = ?').run(p.id);
    db.prepare('DELETE FROM purchase_orders WHERE id = ?').run(p.id);
  }

  // Sisa jurnal bulan itu — yang milik order sudah terhapus oleh pembatalan.
  let jurnal = 0;
  for (const j of rencana.jurnalBulan) {
    if (db.prepare('SELECT 1 FROM journals WHERE id = ?').get(j.id)) {
      deleteJournalById(j.id);
      jurnal += 1;
    }
  }

  const saldoAwal = opsi.bawaSaldoMitra ? bawaSaldoMitra(rencana, opsi.userId, opsi.mitraDibawa) : 0;
  return { jurnal, saldoAwal };
});

const schema = z.object({
  bulan: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'format bulan YYYY-MM'),
  terapkan: z.boolean().default(false),
  konfirmasi: z.string().trim().optional(),
  // Bawaan: utang/piutang mitra yang terbentuk bulan ini dibawa sebagai saldo
  // awal, supaya pembayaran di bulan berikutnya tetap punya utang yang dilunasi.
  bawa_saldo_mitra: z.boolean().default(true),
  // Pilihan per mitra. Kosong/tidak dikirim = semua mitra dibawa.
  mitra_dibawa: z.array(z.number().int().positive()).optional(),
});

router.post('/', ah(async (req, res) => {
  const body = parse(schema, req.body);
  const hasil = periksa(body.bulan);
  const { _rencana: rencana, ...tampil } = hasil;

  if (!body.terapkan) {
    return res.json({ ok: true, dicoba: true, ...tampil, stok: tampil.stok.slice(0, 200) });
  }

  if (hasil.penghalang.length) throw httpError(409, hasil.penghalang.join('. '));
  if (!hasil.ringkas.jurnal && !hasil.ringkas.mutasiStok && !hasil.ringkas.orders) {
    throw httpError(422, `Tidak ada catatan pada bulan ${body.bulan}`);
  }
  if (body.konfirmasi !== hasil.ringkas.kataKunci) {
    throw httpError(422, `Ketik "${hasil.ringkas.kataKunci}" persis untuk melanjutkan`);
  }

  // Cadangan dulu. Kalau cadangan gagal, penghapusan tidak dijalankan.
  const cadangan = await buatCadangan('manual');

  const hasilJalan = jalankan(rencana, { bawaSaldoMitra: body.bawa_saldo_mitra, mitraDibawa: body.mitra_dibawa, userId: req.user.id });
  const r = hasil.ringkas;
  res.json({
    ok: true,
    ringkas: r,
    cadangan: cadangan.nama,
    saldoAwalMitra: hasilJalan.saldoAwal,
    message:
      `Bulan ${body.bulan} dikosongkan: ${r.orders} order, ${r.mutasiStok} mutasi stok, ` +
      `${r.opname} stok opname, ${r.iklan} iklan, ${r.pesananBeli} pesanan pembelian, ` +
      `dan ${r.jurnal} jurnal` +
      (hasilJalan.saldoAwal ? `; ${hasilJalan.saldoAwal} saldo awal utang/piutang mitra dibawa` : '') +
      `. Cadangan sebelum penghapusan: ${cadangan.nama}`,
  });
}));

module.exports = router;
