'use strict';
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
    doc.font('Helvetica-Bold').fontSize(15).text(company || 'Rekap Absensi');
    doc.font('Helvetica').fontSize(10).fillColor('#475569')
      .text(`Rekap Presensi Karyawan — Periode ${from} s/d ${to}`);
    doc.moveDown(0.8).fillColor('#0F172A');

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
    doc.font('Helvetica-Bold').fontSize(15).text(company || 'Laporan Keuangan');
    doc.font('Helvetica-Bold').fontSize(12).text(title);
    doc.font('Helvetica').fontSize(9).fillColor('#475569').text(subtitle);
    doc.moveDown(1).fillColor('#0F172A');

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

      doc.font('Helvetica-Bold').fontSize(14).text(company || 'Laporan');
      doc.font('Helvetica-Bold').fontSize(11).text(title);
      if (subtitle) doc.font('Helvetica').fontSize(9).fillColor('#475569').text(subtitle);
      doc.moveDown(0.7).fillColor('#0F172A');

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

module.exports = {
  attendanceExcel,
  attendancePdf,
  tableExcel,
  tablePdf,
  financialPdf,
  rupiah,
  WORK_TYPE_LABEL,
  STATUS_LABEL,
};
