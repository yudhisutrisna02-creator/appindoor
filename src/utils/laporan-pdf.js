'use strict';
/**
 * Pencetak laporan resmi.
 *
 * Berbeda dari unduhan biasa di tiap menu. Yang ini dibuat untuk dicetak,
 * ditandatangani, dan disimpan sebagai berkas: berkop lengkap, ukuran kertas
 * yang benar, tabel yang kepala kolomnya berulang di tiap halaman, nomor
 * halaman "N dari M", dan blok tanda tangan digital berQR di lembar terakhir.
 *
 * Nomor halaman "N dari M" menuntut seluruh halaman ditahan dulu sebelum
 * ditulis — jumlah totalnya baru diketahui setelah halaman terakhir selesai.
 * Karena itu dokumennya dibuat dengan bufferPages, lalu kaki halamannya diisi
 * belakangan pada tiap halaman.
 */
const fs = require('fs');
const path = require('path');
const PDFDocument = require('pdfkit');
const { UPLOAD_DIR } = require('./upload');
const { getSetting } = require('../db');

/**
 * Ukuran kertas.
 *
 * Folio (F4) tidak ada dalam daftar bawaan PDFKit dan ukurannya memang berbeda
 * dari Legal — 215 x 330 mm. Ditulis dalam titik agar tidak tertukar.
 */
const KERTAS = {
  A4: 'A4',
  FOLIO: [609.45, 935.43],
};

const rupiah = (n) =>
  `Rp ${Math.round(Number(n) || 0).toLocaleString('id-ID')}`;

const teksNilai = (v, kolom) => {
  if (v === null || v === undefined || v === '') return '-';
  if (kolom.money) return rupiah(v);
  if (kolom.pct) return `${Number(v).toFixed(2)}%`;
  if (typeof v === 'number') return v.toLocaleString('id-ID');
  return String(v);
};

/** Identitas perusahaan untuk kop; yang kosong tidak ikut dicetak. */
function identitas() {
  return {
    nama: getSetting('company_name', 'Perusahaan'),
    tagline: getSetting('company_tagline', ''),
    alamat: getSetting('company_address', ''),
    telepon: getSetting('company_phone', ''),
    email: getSetting('company_email', ''),
    situs: getSetting('company_website', ''),
    npwp: getSetting('company_tax_id', ''),
    logo: getSetting('company_logo', ''),
  };
}

function gambarKop(doc, id, judul, subjudul) {
  const kiri = doc.page.margins.left;
  const kanan = doc.page.width - doc.page.margins.right;
  const atas = doc.y;
  let x = kiri;

  try {
    if (id.logo) {
      const berkas = path.join(UPLOAD_DIR, path.basename(id.logo));
      if (fs.existsSync(berkas)) {
        doc.image(berkas, kiri, atas, { fit: [46, 46] });
        x = kiri + 56;
      }
    }
  } catch {
    /* logo tidak terbaca — kop tetap dicetak tanpa gambar */
  }

  doc.font('Helvetica-Bold').fontSize(15).fillColor('#0F172A')
    .text(id.nama, x, atas, { width: kanan - x });

  const baris = [id.alamat, [id.telepon, id.email].filter(Boolean).join('  •  '), id.situs]
    .filter(Boolean);
  doc.font('Helvetica').fontSize(8).fillColor('#475569');
  for (const b of baris) doc.text(b, x, doc.y, { width: kanan - x });
  if (id.npwp) doc.text(`NPWP ${id.npwp}`, x, doc.y, { width: kanan - x });

  const bawahKop = Math.max(doc.y, atas + 46);
  doc.moveTo(kiri, bawahKop + 6).lineTo(kanan, bawahKop + 6)
    .strokeColor('#0F172A').lineWidth(1.2).stroke();

  doc.y = bawahKop + 14;
  doc.font('Helvetica-Bold').fontSize(13).fillColor('#0F172A')
    .text(judul.toUpperCase(), kiri, doc.y, { width: kanan - kiri, align: 'center' });
  if (subjudul) {
    doc.font('Helvetica').fontSize(9).fillColor('#475569')
      .text(subjudul, kiri, doc.y + 1, { width: kanan - kiri, align: 'center' });
  }
  doc.fillColor('#0F172A');
  doc.y += 10;
}

/**
 * Tabel dengan kepala kolom yang berulang di tiap halaman.
 *
 * Tanpa pengulangan itu, halaman kedua dan seterusnya hanya berisi deretan
 * angka tanpa keterangan kolom — tidak terbaca oleh siapa pun yang memegang
 * lembar itu sendirian.
 */
function gambarTabel(doc, kolom, rows, { ringkasBawah } = {}) {
  const kiri = doc.page.margins.left;
  const ruang = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const bobot = kolom.reduce((s, c) => s + (c.width || 16), 0);
  const lebar = kolom.map((c) => ((c.width || 16) / bobot) * ruang);
  // Kaki halaman digambar DI BAWAH margin bawah, jadi ruang di atasnya tidak
  // perlu dicadangkan lagi. Mencadangkannya dua kali membuang sekitar tiga
  // baris pada tiap halaman tanpa alasan.
  const batasBawah = () => doc.page.height - doc.page.margins.bottom - 6;

  const tinggiBaris = 15;

  /**
   * Menggambar satu baris pada ketinggian yang DITETAPKAN di muka.
   *
   * Ketinggiannya diambil sekali sebelum kolomnya digambar. Membaca doc.y di
   * dalam perulangan kolom akan membuat tiap kolom memakai nilai yang baru saja
   * digeser oleh kolom sebelumnya — barisnya menurun miring, satu baris memakan
   * hampir satu halaman, dan tabelnya tidak terbaca sama sekali.
   */
  const gambarBaris = (isiKolom, { font, ukuran, warnaTeks, latar, tinggi }) => {
    const y = doc.y;
    if (latar) doc.rect(kiri, y, ruang, tinggi).fill(latar);

    let x = kiri;
    doc.font(font).fontSize(ukuran).fillColor(warnaTeks);
    kolom.forEach((c, i) => {
      doc.text(isiKolom[i], x + 3, y + (tinggi - ukuran) / 2, {
        width: lebar[i] - 6,
        align: c.money || c.pct || c.angka ? 'right' : 'left',
        ellipsis: true,
        lineBreak: false,
      });
      x += lebar[i];
    });

    doc.fillColor('#0F172A');
    doc.y = y + tinggi;
  };

  const kepala = () =>
    gambarBaris(kolom.map((c) => c.header), {
      font: 'Helvetica-Bold', ukuran: 7.5, warnaTeks: '#FFFFFF',
      latar: '#1E293B', tinggi: tinggiBaris + 3,
    });

  kepala();

  rows.forEach((r, n) => {
    if (doc.y + tinggiBaris > batasBawah()) {
      doc.addPage();
      kepala();
    }
    gambarBaris(kolom.map((c) => teksNilai(r[c.key], c)), {
      font: 'Helvetica', ukuran: 7.5, warnaTeks: '#0F172A',
      latar: n % 2 === 1 ? '#F1F5F9' : null, tinggi: tinggiBaris,
    });
  });

  if (ringkasBawah) {
    if (doc.y + tinggiBaris + 4 > batasBawah()) doc.addPage();
    gambarBaris(
      kolom.map((c) => (ringkasBawah[c.key] === undefined ? '' : teksNilai(ringkasBawah[c.key], c))),
      { font: 'Helvetica-Bold', ukuran: 8, warnaTeks: '#0F172A', latar: '#E2E8F0', tinggi: tinggiBaris + 3 }
    );
  }
}

/** Blok keterangan ringkas sebelum tabel — dua kolom agar hemat tempat. */
function gambarMeta(doc, meta) {
  if (!meta || meta.length === 0) return;
  const kiri = doc.page.margins.left;
  const ruang = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const kolomLebar = ruang / 2;
  const atas = doc.y;
  let bawah = atas;

  // Keterangan yang jelas-jelas nilai uang diberi "Rp"; tanpa itu angka jutaan
  // pada kop laporan terbaca sebagai jumlah unit.
  const uang = /nilai|total|laba|piutang|utang|biaya|pendapatan|hpp|debit|kredit|selisih|persediaan/i;

  meta.forEach(([label, nilai], i) => {
    const x = kiri + (i % 2) * kolomLebar;
    const y = atas + Math.floor(i / 2) * 12;
    const teks = typeof nilai === 'number'
      ? (uang.test(label) ? rupiah(nilai) : nilai.toLocaleString('id-ID'))
      : String(nilai ?? '-');

    doc.font('Helvetica').fontSize(8).fillColor('#475569')
      .text(`${label}: `, x, y, { width: kolomLebar - 8, continued: true })
      .font('Helvetica-Bold').fillColor('#0F172A')
      .text(teks);
    bawah = Math.max(bawah, y + 12);
  });

  doc.y = bawah + 8;
  doc.fillColor('#0F172A');
}

/** Blok tanda tangan digital di lembar terakhir. */
function gambarTtd(doc, ttd, penanggung) {
  const kiri = doc.page.margins.left;
  const ruang = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const perlu = 132;

  // Sama seperti tabelnya: yang tersedia adalah sampai batas margin, bukan
  // batas margin dikurangi lagi. Kelebihan cadangan tadi membuat blok tanda
  // tangan terlempar ke halaman sendiri padahal ruangnya masih cukup.
  if (doc.y + perlu > doc.page.height - doc.page.margins.bottom - 6) doc.addPage();

  const y = doc.y + 12;
  const lebar = ruang / 2;

  // Kiri: yang menyetujui, tetap tanda tangan tangan.
  doc.font('Helvetica').fontSize(8).fillColor('#475569')
    .text('Mengetahui / Menyetujui', kiri, y, { width: lebar - 20, align: 'center' });
  doc.moveTo(kiri + 30, y + 62).lineTo(kiri + lebar - 50, y + 62)
    .strokeColor('#94A3B8').lineWidth(0.7).stroke();
  doc.font('Helvetica-Bold').fontSize(9).fillColor('#0F172A')
    .text(penanggung || '(...................)', kiri, y + 66, { width: lebar - 20, align: 'center' });

  // Kanan: diterbitkan sistem, dengan QR pemeriksaan.
  const xk = kiri + lebar;
  doc.font('Helvetica').fontSize(8).fillColor('#475569')
    .text('Diterbitkan oleh', xk, y, { width: lebar - 20, align: 'center' });

  if (ttd && ttd.qr) {
    const sisi = 54;
    doc.image(ttd.qr, xk + (lebar - 20 - sisi) / 2 + 10, y + 12, { fit: [sisi, sisi] });
    let b = y + 12 + sisi + 3;
    const tulis = (t, font, uk, warna) => {
      doc.font(font).fontSize(uk).fillColor(warna)
        .text(t, xk + 10, b, { width: lebar - 40, align: 'center' });
      b = doc.y;
    };
    tulis('Ditandatangani secara digital oleh', 'Helvetica', 6.5, '#64748B');
    tulis(ttd.digital.oleh, 'Helvetica-Bold', 7.5, '#0F172A');
    tulis(`${ttd.digital.nomor} • ${ttd.digital.waktu}`, 'Helvetica', 6, '#475569');
    tulis(`Kode ${ttd.digital.kode}`, 'Helvetica-Bold', 6.5, '#0F172A');
    tulis('Pindai QR untuk memeriksa keaslian', 'Helvetica', 6, '#64748B');
  } else {
    doc.font('Helvetica-Bold').fontSize(9).fillColor('#0F172A')
      .text('Sistem ERP', xk, y + 30, { width: lebar - 20, align: 'center' });
  }

  doc.fillColor('#0F172A');
}

/** Kaki halaman pada seluruh halaman, diisi setelah jumlahnya diketahui. */
function isiKakiHalaman(doc, { nomorDokumen, dicetakOleh, waktu }) {
  const jangkauan = doc.bufferedPageRange();
  for (let i = 0; i < jangkauan.count; i += 1) {
    doc.switchToPage(jangkauan.start + i);

    const kiri = doc.page.margins.left;
    const kanan = doc.page.width - doc.page.margins.right;
    const y = doc.page.height - doc.page.margins.bottom + 8;

    // Kaki halaman sengaja ditulis DI BAWAH batas margin. PDFKit menganggap
    // tulisan yang melewati batas itu sebagai isi yang meluber dan menambah
    // halaman baru untuknya — satu halaman kaki kosong untuk tiap halaman
    // laporan. Batasnya dinolkan sementara supaya penambahan itu tidak terjadi.
    const bawahAsli = doc.page.margins.bottom;
    doc.page.margins.bottom = 0;

    doc.moveTo(kiri, y - 6).lineTo(kanan, y - 6)
      .strokeColor('#CBD5E1').lineWidth(0.5).stroke();

    doc.font('Helvetica').fontSize(6.5).fillColor('#64748B');
    doc.text(
      `${nomorDokumen} • dicetak ${waktu}${dicetakOleh ? ` oleh ${dicetakOleh}` : ''}`,
      kiri, y, { width: (kanan - kiri) * 0.7, lineBreak: false }
    );
    doc.text(
      `Halaman ${i + 1} dari ${jangkauan.count}`,
      kiri + (kanan - kiri) * 0.7, y, { width: (kanan - kiri) * 0.3, align: 'right', lineBreak: false }
    );

    doc.page.margins.bottom = bawahAsli;
  }
}

/**
 * Mencetak satu laporan resmi.
 *
 * @param {object} p
 * @param {string} p.judul        judul besar di bawah kop
 * @param {string} [p.subjudul]   periode atau keterangan
 * @param {Array}  p.kolom        definisi kolom tabel
 * @param {Array}  p.rows         isi tabel
 * @param {object} [p.ringkasBawah] baris total di kaki tabel
 * @param {Array}  [p.meta]       pasangan [label, nilai] di atas tabel
 * @param {object} [p.ttd]        blok tanda tangan dari utils/ttd
 * @param {'A4'|'FOLIO'} [p.kertas]
 * @param {'portrait'|'landscape'} [p.arah]
 */
function laporanPdf(p) {
  const id = identitas();
  const kertas = KERTAS[String(p.kertas || 'A4').toUpperCase()] || KERTAS.A4;

  // Tabel berkolom banyak dicetak melintang; dipaksa tegak, isinya menyusut
  // sampai tidak terbaca.
  const arah = p.arah || (p.kolom.length > 7 ? 'landscape' : 'portrait');

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: kertas,
      layout: arah,
      margins: { top: 36, bottom: 44, left: 36, right: 36 },
      bufferPages: true,
      info: { Title: p.judul, Author: id.nama },
    });

    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    try {
      gambarKop(doc, id, p.judul, p.subjudul);
      gambarMeta(doc, p.meta);
      gambarTabel(doc, p.kolom, p.rows, { ringkasBawah: p.ringkasBawah });

      if (p.catatan) {
        doc.y += 8;
        doc.font('Helvetica').fontSize(7.5).fillColor('#475569')
          .text(p.catatan, doc.page.margins.left, doc.y, {
            width: doc.page.width - doc.page.margins.left - doc.page.margins.right,
          });
        doc.fillColor('#0F172A');
      }

      gambarTtd(doc, p.ttd, p.penanggung);
      isiKakiHalaman(doc, {
        nomorDokumen: (p.ttd && p.ttd.digital.nomor) || p.judul,
        dicetakOleh: p.dicetakOleh,
        waktu: p.waktu || new Date().toISOString().slice(0, 16).replace('T', ' '),
      });

      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

module.exports = { laporanPdf, KERTAS };
