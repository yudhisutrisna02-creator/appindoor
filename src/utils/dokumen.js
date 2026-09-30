'use strict';
/**
 * Penyusun isi dokumen yang bisa diperiksa keasliannya.
 *
 * Ditaruh terpisah dari rutenya karena dipakai dua arah: saat dokumen
 * diterbitkan (untuk menghitung sidiknya) dan saat dokumen diperiksa (untuk
 * membandingkannya). Kalau keduanya menyusun sendiri-sendiri, satu perubahan
 * kecil di salah satunya akan membuat setiap dokumen dilaporkan berubah padahal
 * tidak ada yang berubah.
 */
const { db } = require('../db');
const { r2 } = require('./accounting');
const { KIND, LABEL_KIND } = require('./ttd');

/**
 * Isi ringkas dokumen untuk ditampilkan dan dibandingkan.
 *
 * Bentuknya harus sama persis dengan yang dipakai saat menerbitkan sidik,
 * kalau tidak setiap dokumen akan selalu dilaporkan berubah. Karena itu
 * penyusunnya dipanggil dari sini juga, bukan disalin ulang.
 */
function isiDokumen(ttd) {
  if (ttd.kind === KIND.SLIP_GAJI) {
    const r = db
      .prepare(
        `SELECT i.*, u.name, u.position, u.department, p.period, p.pay_date, p.payment, p.status
           FROM payroll_items i
           JOIN payrolls p ON p.id = i.payroll_id
           JOIN users u    ON u.id = i.employee_id
          WHERE i.id = ?`
      )
      .get(ttd.ref_id);
    if (!r) return null;

    return {
      kanonik: {
        kind: KIND.SLIP_GAJI,
        period: r.period,
        employee: r.name,
        base: r2(r.base),
        allowance: r2(r.allowance),
        overtime: r2(r.overtime),
        bonus: r2(r.bonus),
        deduction: r2(r.deduction),
        net: r2(r.net),
      },
      tampil: {
        jenis: LABEL_KIND.SLIP_GAJI,
        judul: `Slip Gaji ${r.period}`,
        untuk: r.name,
        keterangan: [r.position, r.department].filter(Boolean).join(' — ') || null,
        tanggal: r.pay_date,
        baris: [
          ['Gaji pokok', r2(r.base)],
          ['Tunjangan', r2(r.allowance)],
          ['Lembur', r2(r.overtime)],
          ['Bonus', r2(r.bonus)],
          ['Potongan', r2(-r.deduction)],
        ].filter(([, n]) => n !== 0),
        total: ['Gaji bersih', r2(r.net)],
        catatan: r.status === 'POSTED'
          ? 'Sudah dibukukan pada sistem.'
          : 'Daftar gajinya masih berstatus draft saat lembar ini diterbitkan.',
      },
    };
  }

  if (ttd.kind === KIND.NOTA_SUPPLIER) {
    const po = db
      .prepare(
        `SELECT o.*, p.name AS supplier_name
           FROM purchase_orders o
           LEFT JOIN partners p ON p.id = o.partner_id
          WHERE o.id = ?`
      )
      .get(ttd.ref_id);
    if (!po) return null;

    const items = db
      .prepare(
        `SELECT i.qty, i.unit_cost, i.qty_received, pr.name AS product_name, pr.unit
           FROM purchase_items i JOIN products pr ON pr.id = i.product_id
          WHERE i.po_id = ? ORDER BY i.id`
      )
      .all(po.id);

    const total = r2(items.reduce((s, i) => s + i.qty * i.unit_cost, 0));

    return {
      kanonik: {
        kind: KIND.NOTA_SUPPLIER,
        po_no: po.po_no,
        invoice_no: po.invoice_no || null,
        order_date: po.order_date,
        supplier: po.supplier_name || null,
        total,
        items: items.map((i) => [i.product_name, r2(i.qty), r2(i.unit_cost)]),
      },
      tampil: {
        jenis: LABEL_KIND.NOTA_SUPPLIER,
        judul: po.invoice_no ? `Faktur ${po.invoice_no}` : `Pesanan ${po.po_no}`,
        untuk: po.supplier_name || 'Supplier belum dipilih',
        keterangan: `No. pesanan ${po.po_no}`,
        tanggal: po.order_date,
        baris: items.map((i) => [
          `${i.product_name} — ${r2(i.qty)} ${i.unit}`,
          r2(i.qty * i.unit_cost),
        ]),
        total: [po.paid_date ? 'Total dibayar' : 'Total tagihan', total],
        catatan: po.paid_date
          ? `Ditandai lunas pada ${po.paid_date}.`
          : 'Belum ditandai lunas pada sistem.',
      },
    };
  }

  if (ttd.kind === KIND.LAPORAN) {
    const l = db.prepare('SELECT * FROM laporan_terbit WHERE id = ?').get(ttd.ref_id);
    if (!l) return null;

    let ringkas = [];
    try {
      ringkas = JSON.parse(l.ringkas || '[]');
    } catch {
      ringkas = [];
    }

    // Laporan adalah potret satu periode. Yang diperiksa bukan hasil hitung
    // ulang seluruh periodenya, melainkan apakah lembar yang dipegang sama
    // dengan angka yang tercatat saat lembar itu dikeluarkan.
    return {
      kanonik: {
        kind: KIND.LAPORAN,
        jenis: l.jenis,
        dari: l.dari,
        sampai: l.sampai,
        baris: l.baris,
        ringkas,
      },
      tampil: {
        jenis: LABEL_KIND.LAPORAN,
        judul: l.judul,
        untuk: l.judul,
        keterangan: l.dari && l.sampai ? `Periode ${l.dari} s/d ${l.sampai}` : null,
        tanggal: l.sampai || l.dari || null,
        baris: ringkas.filter(([, nilai]) => typeof nilai === 'number'),
        total: ['Jumlah baris data', l.baris],
        catatan:
          'Angka di atas adalah yang tercatat saat laporan ini dikeluarkan. ' +
          'Data setelahnya bisa saja bertambah atau diperbaiki.',
      },
    };
  }

  if (ttd.kind === KIND.FAKTUR) {
    const inv = db
      .prepare(
        `SELECT i.*, o.order_no, o.payment_status
           FROM sales_invoices i JOIN sales_orders o ON o.id = i.order_id
          WHERE i.id = ?`
      )
      .get(ttd.ref_id);
    if (!inv) return null;
    const items = db
      .prepare('SELECT product_name, unit, qty, price, subtotal FROM sales_invoice_items WHERE invoice_id = ? ORDER BY id')
      .all(inv.id);

    // Status bayar sengaja tidak ikut disidik: pelunasan setelah faktur dicetak
    // tidak mengubah isi tagihannya. Pembatalan justru ikut, karena faktur yang
    // batal tidak boleh lagi dinyatakan sesuai.
    return {
      kanonik: {
        kind: KIND.FAKTUR,
        invoice_no: inv.invoice_no,
        invoice_date: inv.invoice_date,
        due_date: inv.due_date,
        customer: inv.customer_name,
        subtotal: r2(inv.subtotal),
        discount: r2(inv.discount),
        shipping: r2(inv.shipping),
        total: r2(inv.total),
        batal: inv.status === 'BATAL',
        items: items.map((i) => [i.product_name, r2(i.qty), r2(i.price)]),
      },
      tampil: {
        jenis: LABEL_KIND.FAKTUR,
        judul: `Faktur ${inv.invoice_no}`,
        untuk: inv.customer_name || '-',
        keterangan: `No. order ${inv.order_no}${inv.due_date ? ` · jatuh tempo ${inv.due_date}` : ''}`,
        tanggal: inv.invoice_date,
        baris: [
          ...items.map((i) => [`${i.product_name} — ${r2(i.qty)} ${i.unit || ''}`.trim(), r2(i.subtotal)]),
          ...(inv.discount ? [['Diskon', r2(-inv.discount)]] : []),
          ...(inv.shipping ? [['Ongkos kirim', r2(inv.shipping)]] : []),
        ],
        total: ['Total tagihan', r2(inv.total)],
        catatan: inv.status === 'BATAL'
          ? 'Faktur ini sudah DIBATALKAN dan tidak berlaku.'
          : inv.payment_status === 'PAID'
            ? 'Tagihan ini tercatat sudah dibayar lunas.'
            : 'Tagihan ini tercatat belum dibayar.',
      },
    };
  }

  return null;
}


module.exports = { isiDokumen };
