'use strict';
/**
 * Menu Laporan.
 *
 * Berbeda dari unduhan yang sudah ada di tiap menu. Yang di menu masing-masing
 * adalah alat kerja: apa yang sedang dilihat, turun apa adanya. Yang di sini
 * adalah dokumen resmi — berkop, berukuran kertas yang benar, bernomor, dan
 * bertanda tangan digital berQR seperti slip gaji dan nota supplier.
 *
 * Datanya tidak dihitung ulang dengan rumus baru. Tiap laporan membaca sumber
 * yang sama dengan menunya, sehingga laporan yang dicetak tidak pernah
 * menyebutkan angka yang berbeda dari layar yang dilihat orang sehari-hari.
 *
 * Hak aksesnya mengikuti modulnya masing-masing: yang boleh membuka Penjualan
 * boleh mencetak Laporan Penjualan. Membuat izin tersendiri untuk laporan hanya
 * menggandakan matriks hak akses tanpa menjawab pertanyaan yang berbeda.
 */
const express = require('express');
const { db, getSetting } = require('../db');
const { requireAuth, butuhIzin } = require('../middleware/auth');
const { ah, httpError, dateRange } = require('../utils/http');
const { r2 } = require('../utils/accounting');
const { tableExcel, tableCsv } = require('../utils/exporters');
const { laporanPdf } = require('../utils/laporan-pdf');
const { blokTtd, KIND } = require('../utils/ttd');
const { isiDokumen } = require('../utils/dokumen');
const { CHANNEL_LABEL } = require('../utils/kanal');
const { todayLocal } = require('../utils/time');
const { STATUS_LABEL, WORK_TYPE_LABEL } = require('../utils/exporters');

const router = express.Router();
router.use(requireAuth);

const nol = (n) => r2(n || 0);

// ==================================================================
// DEFINISI LAPORAN
//
// Satu tempat berisi seluruhnya: izin, kolom, pengambil data, dan ringkasannya.
// Menambah laporan baru berarti menambah satu entri, bukan menyalin enam berkas
// yang kemudian berbeda diam-diam satu sama lain.
// ==================================================================
const LAPORAN = {
  presensi: {
    judul: 'Laporan Presensi Karyawan',
    izin: 'presensi.lihat',
    kertas: 'A4',
    kolom: [
      { header: 'Tanggal', key: 'work_date', width: 14 },
      { header: 'Nama', key: 'user_name', width: 26 },
      { header: 'Tipe Kerja', key: 'tipe', width: 18 },
      { header: 'Masuk', key: 'jam_masuk', width: 12 },
      { header: 'Pulang', key: 'jam_pulang', width: 12 },
      { header: 'Status', key: 'status_label', width: 16 },
      { header: 'Telat (menit)', key: 'late_minutes', width: 14, angka: true },
      { header: 'Durasi (menit)', key: 'work_minutes', width: 14, angka: true },
    ],
    ambil(req) {
      const { from, to } = dateRange(req.query);
      const jam = (iso) => (iso ? String(iso).slice(11, 16) : '-');

      const rows = db
        .prepare(
          `SELECT a.*, u.name AS user_name
             FROM attendance a JOIN users u ON u.id = a.user_id
            WHERE a.work_date BETWEEN ? AND ?
            ORDER BY a.work_date DESC, u.name`
        )
        .all(from, to)
        .map((r) => ({
          ...r,
          tipe: WORK_TYPE_LABEL[r.work_type] || r.work_type,
          status_label: STATUS_LABEL[r.status] || r.status,
          jam_masuk: jam(r.check_in_at),
          jam_pulang: jam(r.check_out_at),
        }));

      const hitung = (s) => rows.filter((r) => r.status === s).length;
      return {
        from, to, rows,
        subjudul: `Periode ${from} s/d ${to}`,
        meta: [
          ['Jumlah kehadiran', rows.length],
          ['Karyawan tercatat', new Set(rows.map((r) => r.user_id)).size],
          ['Tepat waktu', hitung('ONTIME')],
          ['Terlambat', hitung('LATE')],
          ['Izin / cuti', hitung('LEAVE')],
          ['Tanpa keterangan', hitung('ABSENT')],
        ],
        ringkasBawah: {
          work_date: 'TOTAL',
          late_minutes: rows.reduce((s, r) => s + (r.late_minutes || 0), 0),
          work_minutes: rows.reduce((s, r) => s + (r.work_minutes || 0), 0),
        },
      };
    },
  },

  persediaan: {
    judul: 'Laporan Persediaan / Gudang',
    izin: 'gudang.lihat',
    kertas: 'A4',
    kolom: [
      { header: 'SKU', key: 'sku', width: 16 },
      { header: 'Nama Barang', key: 'name', width: 40 },
      { header: 'Kategori', key: 'category', width: 18 },
      { header: 'Satuan', key: 'unit', width: 10 },
      { header: 'Stok', key: 'stock', width: 12, angka: true },
      { header: 'Stok Min.', key: 'min_stock', width: 12, angka: true },
      { header: 'HPP / Unit', key: 'cost', width: 16, money: true },
      { header: 'Nilai Persediaan', key: 'nilai', width: 18, money: true },
    ],
    ambil(req) {
      const asOf = req.query.asOf || todayLocal();
      const rows = db
        .prepare('SELECT * FROM products WHERE active = 1 ORDER BY category, name')
        .all()
        .map((p) => ({ ...p, nilai: nol(p.stock * p.cost) }));

      const total = nol(rows.reduce((s, r) => s + r.nilai, 0));
      const habis = rows.filter((r) => r.stock <= 0).length;
      const menipis = rows.filter((r) => r.stock > 0 && r.min_stock > 0 && r.stock <= r.min_stock).length;

      return {
        asOf, rows,
        subjudul: `Posisi per ${asOf}`,
        meta: [
          ['Jumlah SKU aktif', rows.length],
          ['Total nilai persediaan', total],
          ['Stok habis', habis],
          ['Stok menipis', menipis],
        ],
        ringkasBawah: { sku: 'TOTAL', nilai: total },
      };
    },
  },

  pembelian: {
    judul: 'Laporan Pembelian',
    izin: 'pembelian.lihat',
    kertas: 'A4',
    kolom: [
      { header: 'No. Pesanan', key: 'po_no', width: 20 },
      { header: 'Tanggal', key: 'order_date', width: 14 },
      { header: 'Supplier', key: 'supplier_name', width: 30 },
      { header: 'No. Faktur', key: 'invoice_no', width: 20 },
      { header: 'Status', key: 'status_label', width: 18 },
      { header: 'Jatuh Tempo', key: 'due_date', width: 14 },
      { header: 'Nilai Pesanan', key: 'total', width: 18, money: true },
      { header: 'Sudah Diterima', key: 'total_diterima', width: 18, money: true },
    ],
    ambil(req) {
      const { from, to } = dateRange(req.query);
      const STATUS = { DIPESAN: 'Dipesan', SEBAGIAN: 'Diterima sebagian', SELESAI: 'Selesai', BATAL: 'Batal' };

      const rows = db
        .prepare(
          `SELECT o.*, p.name AS supplier_name,
                  (SELECT COALESCE(SUM(i.qty * i.unit_cost), 0) FROM purchase_items i WHERE i.po_id = o.id) AS total,
                  (SELECT COALESCE(SUM(i.qty_received * i.unit_cost), 0) FROM purchase_items i WHERE i.po_id = o.id) AS total_diterima
             FROM purchase_orders o
             LEFT JOIN partners p ON p.id = o.partner_id
            WHERE o.order_date BETWEEN ? AND ?
            ORDER BY o.order_date DESC, o.id DESC`
        )
        .all(from, to)
        .map((o) => ({
          ...o,
          status_label: STATUS[o.status] || o.status,
          total: nol(o.total),
          total_diterima: nol(o.total_diterima),
        }));

      const total = nol(rows.reduce((s, r) => s + r.total, 0));
      const diterima = nol(rows.reduce((s, r) => s + r.total_diterima, 0));

      return {
        from, to, rows,
        subjudul: `Periode ${from} s/d ${to}`,
        meta: [
          ['Jumlah pesanan', rows.length],
          ['Nilai pesanan', total],
          ['Sudah diterima', diterima],
          ['Belum diterima', nol(total - diterima)],
        ],
        ringkasBawah: { po_no: 'TOTAL', total, total_diterima: diterima },
      };
    },
  },

  penjualan: {
    judul: 'Laporan Penjualan',
    izin: 'penjualan.lihat',
    kertas: 'FOLIO',
    kolom: [
      { header: 'No. Order', key: 'order_no', width: 18 },
      { header: 'Tanggal', key: 'order_date', width: 12 },
      { header: 'Toko', key: 'shop_name', width: 22 },
      { header: 'Channel', key: 'channel_label', width: 16 },
      { header: 'Pembeli', key: 'buyer_name', width: 22 },
      { header: 'No. Pesanan', key: 'order_ref', width: 20 },
      { header: 'Status', key: 'fulfillment_status', width: 12 },
      { header: 'Pendapatan', key: 'net_revenue', width: 16, money: true },
      { header: 'HPP', key: 'cogs', width: 14, money: true },
      { header: 'Biaya', key: 'total_fees', width: 14, money: true },
      { header: 'Laba Bersih', key: 'net_profit', width: 16, money: true },
    ],
    ambil(req) {
      const { from, to } = dateRange(req.query);
      const rows = db
        .prepare(
          `SELECT o.*, sh.name AS shop_name
             FROM sales_orders o
             LEFT JOIN shops sh ON sh.id = o.shop_id
            WHERE o.order_date BETWEEN ? AND ? AND o.status = 'POSTED'
            ORDER BY o.order_date DESC, o.id DESC`
        )
        .all(from, to)
        .map((o) => ({ ...o, channel_label: CHANNEL_LABEL[o.channel] || o.channel }));

      const jml = (k) => nol(rows.reduce((s, r) => s + (r[k] || 0), 0));
      const iklan = nol(
        db.prepare('SELECT COALESCE(SUM(amount),0) t FROM ad_spends WHERE spend_date BETWEEN ? AND ?')
          .get(from, to).t
      );

      return {
        from, to, rows,
        subjudul: `Periode ${from} s/d ${to}`,
        meta: [
          ['Jumlah order', rows.length],
          ['Pendapatan kotor', jml('net_revenue')],
          ['Biaya channel', jml('total_fees')],
          ['HPP', jml('cogs')],
          ['Laba bersih', jml('net_profit')],
          ['Biaya iklan', iklan],
          ['Laba setelah iklan', nol(jml('net_profit') - iklan)],
        ],
        ringkasBawah: {
          order_no: 'TOTAL',
          net_revenue: jml('net_revenue'),
          cogs: jml('cogs'),
          total_fees: jml('total_fees'),
          net_profit: jml('net_profit'),
        },
      };
    },
  },

  keuangan: {
    judul: 'Laporan Keuangan — Neraca Saldo',
    izin: 'keuangan.lihat',
    kertas: 'A4',
    kolom: [
      { header: 'Kode', key: 'code', width: 12 },
      { header: 'Nama Akun', key: 'name', width: 44 },
      { header: 'Jenis', key: 'type', width: 16 },
      { header: 'Debit', key: 'debit', width: 20, money: true },
      { header: 'Kredit', key: 'credit', width: 20, money: true },
    ],
    ambil(req) {
      const { from, to } = dateRange(req.query);
      const rows = db
        .prepare(
          `SELECT a.code, a.name, a.type, a.normal,
                  COALESCE(SUM(l.debit), 0)  AS d,
                  COALESCE(SUM(l.credit), 0) AS k
             FROM accounts a
             LEFT JOIN journal_lines l ON l.account_id = a.id
             LEFT JOIN journals j ON j.id = l.journal_id AND j.entry_date BETWEEN ? AND ?
            GROUP BY a.id
            HAVING d <> 0 OR k <> 0
            ORDER BY a.code`
        )
        .all(from, to)
        .map((a) => {
          const saldo = r2(a.d - a.k);
          return {
            ...a,
            // Saldo ditaruh pada sisi normalnya; menuliskan keduanya sekaligus
            // membuat neraca saldo tidak lagi berfungsi sebagai pemeriksaan.
            debit: saldo > 0 ? saldo : 0,
            credit: saldo < 0 ? Math.abs(saldo) : 0,
          };
        });

      const totalD = nol(rows.reduce((s, r) => s + r.debit, 0));
      const totalK = nol(rows.reduce((s, r) => s + r.credit, 0));

      return {
        from, to, rows,
        subjudul: `Periode ${from} s/d ${to}`,
        meta: [
          ['Jumlah akun bergerak', rows.length],
          ['Total debit', totalD],
          ['Total kredit', totalK],
          ['Selisih', nol(totalD - totalK)],
        ],
        ringkasBawah: { code: 'TOTAL', debit: totalD, credit: totalK },
        catatan:
          totalD === totalK
            ? 'Total debit sama dengan total kredit — pembukuan seimbang.'
            : 'PERHATIAN: total debit dan kredit tidak sama. Periksa jurnal pada periode ini.',
      };
    },
  },

  mitra: {
    judul: 'Laporan Mitra — Supplier & Pelanggan',
    izin: 'mitra.lihat',
    kertas: 'A4',
    kolom: [
      { header: 'Nama', key: 'name', width: 32 },
      { header: 'Jenis', key: 'jenis', width: 16 },
      { header: 'Telepon', key: 'phone', width: 20 },
      { header: 'Kota / Alamat', key: 'address', width: 34 },
      { header: 'Transaksi', key: 'transaksi', width: 14, angka: true },
      { header: 'Nilai Transaksi', key: 'nilai', width: 20, money: true },
      { header: 'Saldo Utang/Piutang', key: 'saldo', width: 20, money: true },
    ],
    ambil(req) {
      const { from, to } = dateRange(req.query);
      const JENIS = { SUPPLIER: 'Supplier', CUSTOMER: 'Pelanggan', BOTH: 'Supplier & Pelanggan' };

      const rows = db
        .prepare(
          `SELECT p.*,
                  (SELECT COUNT(*) FROM sales_orders o
                    WHERE o.partner_id = p.id AND o.order_date BETWEEN ? AND ?) AS jual,
                  (SELECT COALESCE(SUM(o.net_revenue), 0) FROM sales_orders o
                    WHERE o.partner_id = p.id AND o.order_date BETWEEN ? AND ?) AS nilai_jual,
                  (SELECT COUNT(*) FROM purchase_orders b
                    WHERE b.partner_id = p.id AND b.order_date BETWEEN ? AND ?) AS beli,
                  (SELECT COALESCE(SUM(l.debit - l.credit), 0)
                     FROM journal_lines l JOIN journals j ON j.id = l.journal_id
                    WHERE l.partner_id = p.id AND j.entry_date <= ?) AS saldo
             FROM partners p
            ORDER BY p.name`
        )
        .all(from, to, from, to, from, to, to)
        .map((p) => ({
          ...p,
          jenis: JENIS[p.kind] || p.kind,
          transaksi: p.jual + p.beli,
          nilai: nol(p.nilai_jual),
          saldo: nol(p.saldo),
        }));

      const piutang = nol(rows.filter((r) => r.saldo > 0).reduce((s, r) => s + r.saldo, 0));
      const utang = nol(rows.filter((r) => r.saldo < 0).reduce((s, r) => s + Math.abs(r.saldo), 0));

      return {
        from, to, rows,
        subjudul: `Periode ${from} s/d ${to}`,
        meta: [
          ['Jumlah mitra', rows.length],
          ['Mitra bertransaksi', rows.filter((r) => r.transaksi > 0).length],
          ['Total piutang', piutang],
          ['Total utang', utang],
        ],
        ringkasBawah: {
          name: 'TOTAL',
          transaksi: rows.reduce((s, r) => s + r.transaksi, 0),
          nilai: nol(rows.reduce((s, r) => s + r.nilai, 0)),
          saldo: nol(rows.reduce((s, r) => s + r.saldo, 0)),
        },
      };
    },
  },
};

/** Daftar laporan yang boleh dibuka pengguna ini. */
router.get('/', ah((req, res) => {
  const { izinPengguna } = require('../middleware/auth');
  const izin = izinPengguna(req.user);
  res.json({
    rows: Object.entries(LAPORAN)
      .filter(([, def]) => izin.has(def.izin))
      .map(([jenis, def]) => ({ jenis, judul: def.judul, izin: def.izin, kertas: def.kertas })),
  });
}));

function ambilDef(jenis) {
  const def = LAPORAN[jenis];
  if (!def) throw httpError(404, `Laporan ${jenis} tidak dikenal`);
  return def;
}

/** Pratinjau di layar — isinya sama persis dengan yang akan dicetak. */
router.get('/:jenis', ah((req, res) => {
  const def = ambilDef(req.params.jenis);
  const penjaga = butuhIzin(def.izin);
  penjaga(req, res, () => {
    const d = def.ambil(req);
    res.json({
      jenis: req.params.jenis,
      judul: def.judul,
      kertas: def.kertas,
      ...d,
      kolom: def.kolom,
    });
  });
}));

/**
 * Mencatat penerbitan laporan supaya QR-nya punya sesuatu untuk ditunjuk.
 *
 * Satu baris per (jenis, periode): mencetak ulang laporan yang sama tidak
 * membuat catatan baru, hanya memperbarui ringkasannya.
 */
const catatTerbit = db.transaction((jenis, def, d) => {
  const dari = d.from || d.asOf || null;
  const sampai = d.to || d.asOf || null;
  const ringkas = JSON.stringify(d.meta || []);

  const ada = db
    .prepare('SELECT id FROM laporan_terbit WHERE jenis = ? AND dari IS ? AND sampai IS ?')
    .get(jenis, dari, sampai);

  if (ada) {
    db.prepare('UPDATE laporan_terbit SET ringkas = ?, baris = ?, judul = ? WHERE id = ?')
      .run(ringkas, d.rows.length, def.judul, ada.id);
    return ada.id;
  }

  return db
    .prepare('INSERT INTO laporan_terbit (jenis, judul, dari, sampai, ringkas, baris) VALUES (?,?,?,?,?,?)')
    .run(jenis, def.judul, dari, sampai, ringkas, d.rows.length).lastInsertRowid;
});

const nomorLaporan = (jenis, d) =>
  `LAP/${jenis.toUpperCase()}/${(d.from || d.asOf || todayLocal()).replace(/-/g, '')}`;

const namaBerkas = (jenis, d, ext) =>
  `laporan-${jenis}-${(d.from || d.asOf || todayLocal())}.${ext}`;

router.get('/:jenis/export/:bentuk', ah(async (req, res) => {
  const { jenis, bentuk } = req.params;
  const def = ambilDef(jenis);

  await new Promise((resolve, reject) => {
    butuhIzin(def.izin)(req, res, (err) => (err ? reject(err) : resolve()));
  });

  const d = def.ambil(req);

  if (bentuk === 'excel') {
    const buffer = await tableExcel(def.judul, def.kolom, d.rows, d.meta);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${namaBerkas(jenis, d, 'xlsx')}"`);
    return res.send(Buffer.from(buffer));
  }

  if (bentuk === 'csv') {
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${namaBerkas(jenis, d, 'csv')}"`);
    return res.send(tableCsv(def.kolom, d.rows));
  }

  if (bentuk !== 'pdf') throw httpError(404, `Bentuk ${bentuk} tidak dikenal`);

  // Hanya PDF yang ditandatangani: itu lembar yang dicetak dan diberikan ke
  // orang. Excel dan CSV adalah bahan kerja yang memang untuk diolah lagi.
  const refId = catatTerbit(jenis, def, d);
  const ttd = await blokTtd({
    req,
    kind: KIND.LAPORAN,
    refId,
    docNo: nomorLaporan(jenis, d),
    isi: isiDokumen({ kind: KIND.LAPORAN, ref_id: refId }).kanonik,
    userId: req.user && req.user.id,
    label: 'Diterbitkan oleh',
  });

  const buffer = await laporanPdf({
    judul: def.judul,
    subjudul: d.subjudul,
    kolom: def.kolom,
    rows: d.rows,
    meta: d.meta,
    ringkasBawah: d.ringkasBawah,
    catatan: d.catatan,
    kertas: req.query.kertas || def.kertas,
    arah: req.query.arah,
    ttd,
    penanggung: getSetting('company_owner', ''),
    dicetakOleh: req.user ? req.user.name || req.user.email : null,
  });

  res.setHeader('Content-Type', 'application/pdf');
  // inline agar bisa langsung dibuka dan dicetak dari peramban.
  res.setHeader('Content-Disposition', `inline; filename="${namaBerkas(jenis, d, 'pdf')}"`);
  return res.send(buffer);
}));

module.exports = router;
