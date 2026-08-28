'use strict';
const fs = require('fs');
const path = require('path');
const { UPLOAD_DIR } = require('./upload');
const { getSetting } = require('../db');
const ExcelJS = require('exceljs');
const PDFDocument = require('pdfkit');

const WORK_TYPE_LABEL = {
  WFO: 'WFO (Kantor/Gudang)',
  WFH: 'WFH',
  DINAS_LUAR: 'Dinas Luar / Kunjungan',
};
const STATUS_LABEL = { ONTIME: 'Tepat Waktu', LATE: 'Terlambat', LEAVE: 'Izin/Cuti', ABSENT: 'Alpa' };

const rupiah = (n) =>
  'Rp ' + Number(n || 0).toLocaleString('id-ID', { maximumFractionDigits: 0 });

const timeOnly = (iso) =>
  iso ? new Date(iso).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit', timeZone: process.env.TZ_NAME || 'Asia/Jakarta' }) : '-';

/** Header tabel bergaya seragam untuk semua worksheet. */
function styleHeader(sheet, rowNumber = 1) {
  const row = sheet.getRow(rowNumber);
  row.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 11 };
  row.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E293B' } };
  row.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
  row.height = 24;
}

function autoBorder(sheet) {
  sheet.eachRow((row) => {
    row.eachCell((cell) => {
      cell.border = {
        top: { style: 'thin', color: { argb: 'FFE2E8F0' } },
        left: { style: 'thin', color: { argb: 'FFE2E8F0' } },
        bottom: { style: 'thin', color: { argb: 'FFE2E8F0' } },
        right: { style: 'thin', color: { argb: 'FFE2E8F0' } },
      };
    });
  });
}

// ------------------------------------------------------------------
// PRESENSI
// ------------------------------------------------------------------
async function attendanceExcel(rows, { from, to }) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'ERP System Indoor';
  const ws = wb.addWorksheet('Rekap Absensi', {
    views: [{ state: 'frozen', ySplit: 1 }],
  });

  ws.columns = [
    { header: 'Tanggal', key: 'work_date', width: 12 },
    { header: 'Nama', key: 'user_name', width: 24 },
    { header: 'Jabatan', key: 'position', width: 18 },
    { header: 'Tipe Presensi', key: 'work_type', width: 22 },
    { header: 'Check In', key: 'in', width: 10 },
    { header: 'Check Out', key: 'out', width: 10 },
    { header: 'Durasi (jam)', key: 'dur', width: 12 },
    { header: 'Status', key: 'status', width: 14 },
    { header: 'Telat (menit)', key: 'late', width: 13 },
    { header: 'Lokasi', key: 'office', width: 20 },
    { header: 'Jarak (m)', key: 'dist', width: 11 },
    { header: 'Dalam Radius', key: 'inside', width: 13 },
    { header: 'Koordinat Masuk', key: 'coord', width: 26 },
    { header: 'Akurasi (m)', key: 'acc', width: 12 },
    { header: 'Catatan', key: 'notes', width: 30 },
  ];

  for (const r of rows) {
    ws.addRow({
      work_date: r.work_date,
      user_name: r.user_name,
      position: r.position || '-',
      work_type: WORK_TYPE_LABEL[r.work_type] || r.work_type,
      in: timeOnly(r.check_in_at),
      out: timeOnly(r.check_out_at),
      dur: r.work_minutes ? Number((r.work_minutes / 60).toFixed(2)) : 0,
      status: STATUS_LABEL[r.status] || r.status,
      late: r.late_minutes,
      office: r.office_name || (r.work_type === 'WFO' ? '-' : WORK_TYPE_LABEL[r.work_type]),
      dist: r.in_distance_m ?? '-',
      inside: r.in_inside_geofence ? 'Ya' : 'Tidak',
      coord: r.in_lat != null ? `${r.in_lat}, ${r.in_lng}` : '-',
      acc: r.in_accuracy_m ? Math.round(r.in_accuracy_m) : '-',
      notes: r.notes || '',
    });
  }

  styleHeader(ws);
  autoBorder(ws);

  // Baris ringkasan
  const late = rows.filter((r) => r.status === 'LATE').length;
  ws.addRow([]);
  ws.addRow(['Periode', `${from} s/d ${to}`]);
  ws.addRow(['Total Kehadiran', rows.length]);
  ws.addRow(['Tepat Waktu', rows.filter((r) => r.status === 'ONTIME').length]);
  ws.addRow(['Terlambat', late]);
  ws.addRow(['Total Menit Terlambat', rows.reduce((s, r) => s + r.late_minutes, 0)]);

  return wb.xlsx.writeBuffer();
}

/**
 * Menggambar kop halaman: logo perusahaan bila ada, lalu nama dan judul.
 *
 * Logo dibaca dari berkas saat pencetakan, bukan disimpan di memori, karena
 * berkas ini jarang dipakai dan gambarnya bisa diganti kapan saja. Kegagalan
 * membaca gambar tidak menggagalkan laporan — kop hanya kehilangan logonya.
 */
function pdfKop(doc, { perusahaan, judul, subjudul }) {
  const kiri = doc.page.margins.left;
  let x = kiri;

  try {
    const nama = getSetting('company_logo', '');
    if (nama) {
      const berkas = path.join(UPLOAD_DIR, path.basename(nama));
      if (fs.existsSync(berkas)) {
        doc.image(berkas, kiri, doc.y, { fit: [38, 38] });
        x = kiri + 48;
      }
    }
  } catch {
    /* logo tidak terbaca — kop tetap dicetak tanpa gambar */
  }

  const atas = doc.y;
  doc.font('Helvetica-Bold').fontSize(14).text(perusahaan || 'Laporan', x, atas);
  if (judul) doc.font('Helvetica-Bold').fontSize(11).text(judul, x, doc.y);
  if (subjudul) doc.font('Helvetica').fontSize(9).fillColor('#475569').text(subjudul, x, doc.y);

  doc.fillColor('#0F172A');
  doc.y = Math.max(doc.y, atas + 40);
  doc.moveDown(0.5);
}

/** Membungkus PDFKit menjadi Promise<Buffer>. */
function renderPdf(build, options = {}) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 32, ...options });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    try {
      build(doc);
      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

/** Menggambar tabel sederhana dengan lebar kolom tetap. */
function pdfTable(doc, headers, widths, rows, startY) {
  let y = startY;
  const rowHeight = 18;
  const left = doc.page.margins.left;

  const drawRow = (cells, bold) => {
    if (y > doc.page.height - 60) {
      doc.addPage();
      y = doc.page.margins.top;
    }
    let x = left;
    doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(8);
    if (bold) {
      doc.rect(left, y - 3, widths.reduce((a, b) => a + b, 0), rowHeight).fill('#1E293B');
      doc.fillColor('#FFFFFF');
    } else {
      doc.fillColor('#0F172A');
    }
    cells.forEach((cell, i) => {
      doc.text(String(cell ?? ''), x + 4, y + 2, { width: widths[i] - 8, height: rowHeight, ellipsis: true });
      x += widths[i];
    });
    doc.fillColor('#0F172A');
    y += rowHeight;
  };

  drawRow(headers, true);
  rows.forEach((r) => drawRow(r, false));
  return y;
}

async function attendancePdf(rows, { from, to, company }) {
  return renderPdf((doc) => {
    pdfKop(doc, {
      perusahaan: company || 'Rekap Absensi',
      judul: 'Rekap Presensi Karyawan',
      subjudul: `Periode ${from} s/d ${to}`,
    });

    const headers = ['Tanggal', 'Nama', 'Tipe', 'In', 'Out', 'Status', 'Telat', 'Jarak(m)'];
    const widths = [58, 110, 90, 40, 40, 68, 40, 85];
    const data = rows.map((r) => [
      r.work_date,
      r.user_name,
      WORK_TYPE_LABEL[r.work_type] || r.work_type,
      timeOnly(r.check_in_at),
      timeOnly(r.check_out_at),
      STATUS_LABEL[r.status] || r.status,
      r.late_minutes || 0,
      r.in_distance_m ?? '-',
    ]);

    const endY = pdfTable(doc, headers, widths, data, doc.y);

    doc.y = endY + 14;
    doc.font('Helvetica-Bold').fontSize(9)
      .text(`Total ${rows.length} kehadiran • Tepat waktu ${rows.filter((r) => r.status === 'ONTIME').length} • Terlambat ${rows.filter((r) => r.status === 'LATE').length}`);
  }, { layout: 'portrait' });
}

// ------------------------------------------------------------------
// GENERIK: tabel apa pun -> Excel
// ------------------------------------------------------------------
/**
 * @param {string} sheetName
 * @param {Array<{header:string,key:string,width?:number,money?:boolean}>} columns
 * @param {Array<object>} rows
 * @param {Array<[string,any]>} [meta] baris ringkasan di bawah tabel
 */
async function tableExcel(sheetName, columns, rows, meta = []) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'ERP System Indoor';
  const ws = wb.addWorksheet(sheetName.slice(0, 30), { views: [{ state: 'frozen', ySplit: 1 }] });

  ws.columns = columns.map((c) => ({ header: c.header, key: c.key, width: c.width || 16 }));
  rows.forEach((r) => ws.addRow(r));

  columns.forEach((c, i) => {
    if (c.money) ws.getColumn(i + 1).numFmt = '#,##0';
    if (c.pct) ws.getColumn(i + 1).numFmt = '0.00"%"';
  });

  styleHeader(ws);
  autoBorder(ws);

  if (meta.length) {
    ws.addRow([]);
    meta.forEach(([label, value]) => {
      const row = ws.addRow([label, value]);
      row.getCell(1).font = { bold: true };
    });
  }
  return wb.xlsx.writeBuffer();
}

// ------------------------------------------------------------------
// LAPORAN KEUANGAN -> PDF
// ------------------------------------------------------------------
/**
 * @param {string} title
 * @param {string} subtitle
 * @param {Array<{label:string, value:number|null, bold?:boolean, indent?:boolean, divider?:boolean}>} lines
 */
async function financialPdf(title, subtitle, lines, company) {
  return renderPdf((doc) => {
    pdfKop(doc, { perusahaan: company || 'Laporan Keuangan', judul: title, subjudul: subtitle });
    doc.moveDown(0.4);

    const left = doc.page.margins.left;
    const right = doc.page.width - doc.page.margins.right;

    for (const line of lines) {
      if (doc.y > doc.page.height - 70) doc.addPage();

      if (line.divider) {
        doc.moveTo(left, doc.y + 2).lineTo(right, doc.y + 2).strokeColor('#CBD5E1').stroke();
        doc.moveDown(0.4);
        continue;
      }
      const y = doc.y;
      doc.font(line.bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(line.bold ? 10 : 9);
      doc.text(line.label, left + (line.indent ? 16 : 0), y, { width: 300 });
      if (line.value !== null && line.value !== undefined) {
        doc.text(rupiah(line.value), left + 300, y, { width: right - left - 300, align: 'right' });
      }
      doc.moveDown(0.35);
    }
  });
}

// ------------------------------------------------------------------
// GENERIK: tabel apa pun -> PDF
// ------------------------------------------------------------------
/**
 * Pasangan PDF untuk tableExcel, memakai definisi kolom yang sama persis.
 *
 * Satu definisi kolom dipakai kedua format supaya isi berkas Excel dan PDF
 * tidak bisa berbeda diam-diam — kalau satu kolom ditambahkan, keduanya ikut.
 *
 * @param {string} title judul di kepala halaman
 * @param {string} subtitle keterangan periode atau penyaring yang sedang aktif
 * @param {Array<{header:string,key:string,width?:number,money?:boolean,pct?:boolean}>} columns
 * @param {Array<object>} rows
 * @param {Array<[string,any]>} [meta] baris ringkasan di bawah tabel
 */
async function tablePdf(title, subtitle, columns, rows, meta = [], company) {
  // Kolom lebar-nol pada Excel tidak berarti apa-apa di PDF, jadi lebarnya
  // dibagi menurut proporsi lebar kolom Excel terhadap ruang cetak yang ada.
  const totalBobot = columns.reduce((s, c) => s + (c.width || 16), 0);

  return renderPdf(
    (doc) => {
      const ruang = doc.page.width - doc.page.margins.left - doc.page.margins.right;
      const widths = columns.map((c) => ((c.width || 16) / totalBobot) * ruang);

      pdfKop(doc, { perusahaan: company, judul: title, subjudul: subtitle });

      const isi = rows.map((r) =>
        columns.map((c) => {
          const v = r[c.key];
          if (v === null || v === undefined || v === '') return '-';
          if (c.money) return rupiah(v);
          if (c.pct) return `${Number(v).toFixed(2)}%`;
          return v;
        })
      );

      const akhir = pdfTable(doc, columns.map((c) => c.header), widths, isi, doc.y);

      doc.y = akhir + 12;
      doc.font('Helvetica').fontSize(8).fillColor('#475569').text(`${rows.length} baris`);
      if (meta.length) {
        doc.moveDown(0.3).fillColor('#0F172A');
        for (const [label, value] of meta) {
          if (doc.y > doc.page.height - 60) doc.addPage();
          doc.font('Helvetica-Bold').fontSize(9)
            .text(`${label}: ${typeof value === 'number' ? rupiah(value) : value}`);
        }
      }
    },
    // Tabel lebar lebih terbaca melintang; tabel sempit tetap tegak.
    { layout: columns.length > 6 ? 'landscape' : 'portrait' }
  );
}


/**
 * Berkas CSV dari definisi kolom yang sama dengan Excel dan PDF.
 *
 * Pemisahnya titik koma, bukan koma: Excel berbahasa Indonesia membaca koma
 * sebagai pemisah desimal, sehingga berkas berpemisah koma akan terbuka
 * berantakan di komputer yang justru paling sering memakainya. Tanda BOM di
 * depan membuat huruf beraksen dan rupiah terbaca benar.
 */
function tableCsv(columns, rows) {
  const sel = (v) => {
    if (v === null || v === undefined) return '';
    const s = String(v);
    return /[";\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };

  const baris = [columns.map((c) => sel(c.header)).join(';')];
  for (const r of rows) {
    baris.push(
      columns
        .map((c) => {
          const v = r[c.key];
          if (v === null || v === undefined || v === '') return '';
          // Angka ditulis apa adanya dengan koma desimal supaya bisa langsung
          // dihitung di Excel, bukan sebagai teks berformat rupiah.
          if (typeof v === 'number') return sel(String(v).replace('.', ','));
          return sel(v);
        })
        .join(';')
    );
  }
  return Buffer.from('\ufeff' + baris.join('\r\n'), 'utf8');
}

/**
 * Dokumen cetak seperti slip gaji dan nota — bukan tabel laporan.
 *
 * Bedanya dengan tablePdf: yang dicetak di sini adalah lembar per lembar untuk
 * diberikan kepada orang, bukan daftar untuk dibaca sendiri. Karena itu tiap
 * dokumen memulai halaman baru, nomornya ditonjolkan, dan ada ruang tanda
 * tangan di bawahnya.
 *
 * Satu berkas bisa memuat banyak dokumen sekaligus — mencetak 12 slip gaji
 * sebagai 12 unduhan terpisah adalah pekerjaan yang tidak perlu ada.
 */
function dokumenPdf(dokumen, { perusahaan } = {}) {
  const daftar = Array.isArray(dokumen) ? dokumen : [dokumen];

  return renderPdf((doc) => {
    const kiri = doc.page.margins.left;
    const ruang = doc.page.width - doc.page.margins.left - doc.page.margins.right;

    daftar.forEach((d, i) => {
      if (i > 0) doc.addPage();

      pdfKop(doc, { perusahaan, judul: d.judul, subjudul: d.subjudul });

      // Nomor dokumen dan keterangan pokoknya, berdampingan.
      const atas = doc.y;
      if (d.nomor) {
        doc.font('Helvetica-Bold').fontSize(10).fillColor('#0F172A')
          .text(d.nomor, kiri, atas, { width: ruang / 2 });
      }
      if (d.meta && d.meta.length) {
        let y = atas;
        for (const [label, nilai] of d.meta) {
          doc.font('Helvetica').fontSize(9).fillColor('#475569')
            .text(`${label}: `, kiri + ruang / 2, y, { width: ruang / 2, continued: true })
            .font('Helvetica-Bold').fillColor('#0F172A').text(String(nilai ?? '-'));
          y = doc.y;
        }
        doc.y = Math.max(doc.y, y);
      }
      doc.fillColor('#0F172A').moveDown(0.6);

      // Pihak-pihak: kepada siapa, dari siapa.
      if (d.pihak && d.pihak.length) {
        const mulai = doc.y;
        const lebar = ruang / d.pihak.length;
        let bawah = mulai;
        d.pihak.forEach((p, k) => {
          const x = kiri + k * lebar;
          doc.font('Helvetica').fontSize(8).fillColor('#64748B')
            .text(p.judul, x, mulai, { width: lebar - 10 });
          doc.font('Helvetica-Bold').fontSize(10).fillColor('#0F172A')
            .text(p.nama || '-', x, doc.y, { width: lebar - 10 });
          for (const b of p.baris || []) {
            if (!b) continue;
            doc.font('Helvetica').fontSize(8).fillColor('#475569')
              .text(b, x, doc.y, { width: lebar - 10 });
          }
          bawah = Math.max(bawah, doc.y);
        });
        doc.y = bawah;
        doc.fillColor('#0F172A').moveDown(0.8);
      }

      if (d.kolom && d.rows) {
        const bobot = d.kolom.reduce((s, c) => s + (c.width || 16), 0);
        const widths = d.kolom.map((c) => ((c.width || 16) / bobot) * ruang);
        const isi = d.rows.map((r) =>
          d.kolom.map((c) => {
            const v = r[c.key];
            if (v === null || v === undefined || v === '') return '-';
            if (c.money) return rupiah(v);
            return String(v);
          })
        );
        doc.y = pdfTable(doc, d.kolom.map((c) => c.header), widths, isi, doc.y) + 10;
      }

      // Ringkasan angka, rata kanan seperti nota pada umumnya.
      if (d.ringkas && d.ringkas.length) {
        const lebarKa = 230;
        const x = kiri + ruang - lebarKa;
        for (const [label, nilai, tebal] of d.ringkas) {
          if (doc.y > doc.page.height - 120) doc.addPage();
          const y = doc.y;
          doc.font(tebal ? 'Helvetica-Bold' : 'Helvetica').fontSize(tebal ? 11 : 9)
            .fillColor('#0F172A')
            .text(label, x, y, { width: lebarKa * 0.55 })
            .text(typeof nilai === 'number' ? rupiah(nilai) : String(nilai ?? '-'),
              x + lebarKa * 0.55, y, { width: lebarKa * 0.45, align: 'right' });
          doc.y = Math.max(doc.y, y) + (tebal ? 4 : 1);
        }
        doc.moveDown(0.5);
      }

      if (d.catatan) {
        if (doc.y > doc.page.height - 120) doc.addPage();
        doc.font('Helvetica').fontSize(8).fillColor('#475569')
          .text(d.catatan, kiri, doc.y, { width: ruang });
        doc.fillColor('#0F172A').moveDown(0.5);
      }

      // Ruang tanda tangan. Ditempatkan di bawah halaman bila masih muat,
      // supaya lembarnya terlihat seperti dokumen dan bukan potongan laporan.
      if (d.tandaTangan && d.tandaTangan.length) {
        const perlu = 90;
        if (doc.y > doc.page.height - perlu - 30) doc.addPage();
        const y = Math.max(doc.y + 16, doc.page.height - perlu - 20);
        const lebar = ruang / d.tandaTangan.length;
        d.tandaTangan.forEach((t, k) => {
          const x = kiri + k * lebar;
          doc.font('Helvetica').fontSize(8).fillColor('#475569')
            .text(t.label, x, y, { width: lebar - 20, align: 'center' });
          doc.moveTo(x + 20, y + 52).lineTo(x + lebar - 40, y + 52)
            .strokeColor('#94A3B8').lineWidth(0.7).stroke();
          doc.font('Helvetica-Bold').fontSize(9).fillColor('#0F172A')
            .text(t.nama || '(...................)', x, y + 56, { width: lebar - 20, align: 'center' });
        });
      }
    });
  });
}

module.exports = {
  attendanceExcel,
  attendancePdf,
  tableExcel,
  tablePdf,
  tableCsv,
  dokumenPdf,
  financialPdf,
  rupiah,
  WORK_TYPE_LABEL,
  STATUS_LABEL,
};
