'use strict';
/**
 * Tanda tangan digital dokumen cetak.
 *
 * Yang dijanjikan di sini bukan tanda tangan kriptografis milik seseorang,
 * melainkan pernyataan sistem: dokumen dengan nomor ini benar dikeluarkan oleh
 * aplikasi, pada waktu ini, dengan isi yang sidiknya tercetak di lembar itu.
 * Menyebutnya lebih dari itu akan menyesatkan orang yang mengandalkannya.
 *
 * Cara memeriksanya sengaja dibuat bisa dikerjakan siapa pun yang memegang
 * kertasnya: pindai QR, halaman terbuka tanpa perlu masuk, lalu cocokkan
 * angkanya. Kalau halaman pemeriksaan menuntut login, yang memegang kertas
 * justru pihak yang tidak punya akun — supplier dan pegawai — dan fiturnya
 * tidak menolong siapa pun.
 */
const crypto = require('crypto');
const QRCode = require('qrcode');
const { db, getSetting } = require('./../db');

const KIND = {
  SLIP_GAJI: 'SLIP_GAJI',
  NOTA_SUPPLIER: 'NOTA_SUPPLIER',
};

const LABEL_KIND = {
  SLIP_GAJI: 'Slip Gaji',
  NOTA_SUPPLIER: 'Nota Pembayaran Supplier',
};

/**
 * Alamat publik aplikasi.
 *
 * Diambil dari pengaturan bila diisi, lalu dari variabel lingkungan, dan barulah
 * dari permintaan yang sedang berjalan. Urutannya begitu karena tautan yang
 * dicetak akan hidup lebih lama daripada sesi yang mencetaknya: alamat hasil
 * tebakan dari header bisa berupa alamat internal yang tidak bisa dibuka
 * siapa pun dari luar.
 */
/** Membungkus hasil beserta asal alamatnya bila diminta. */
function hasil(url, sumber, dengan) {
  const bersih = String(url).replace(/\/+$/, '');
  return dengan ? { url: bersih, sumber } : bersih;
}

function alamatPublik(req, denganSumber) {
  const dariSetting = (getSetting('app_url', '') || '').trim();
  if (dariSetting) return hasil(dariSetting, 'pengaturan', denganSumber);

  const dariEnv = (process.env.APP_URL || process.env.PUBLIC_URL || '').trim();
  if (dariEnv) return hasil(dariEnv, 'lingkungan', denganSumber);

  // Terakhir barulah ditebak dari permintaan yang sedang berjalan. Ini tetap
  // berfungsi, tetapi rapuh: dokumen yang dicetak lewat alamat lain akan membawa
  // QR yang berbeda, dan QR lama tidak ikut berubah.
  if (req) {
    const proto = req.get('x-forwarded-proto') || req.protocol || 'https';
    const host = req.get('x-forwarded-host') || req.get('host');
    if (host) return hasil(`${proto}://${host}`, 'permintaan', denganSumber);
  }
  return hasil('', 'tidakada', denganSumber);
}

/** Sidik isi dokumen. Isinya diringkas jadi teks kanonik lebih dulu. */
function sidik(isi) {
  return crypto.createHash('sha256').update(JSON.stringify(isi)).digest('hex');
}

const ambilTtd = db.prepare('SELECT * FROM document_signatures WHERE kind = ? AND ref_id = ?');

/**
 * Menerbitkan (atau memperbarui) tanda tangan sebuah dokumen.
 *
 * Token tidak pernah berganti selama dokumennya sama, supaya QR yang sudah
 * tercetak dan tersebar tetap menunjuk ke tempat yang benar. Yang berubah bila
 * isinya berbeda hanyalah sidik dan nomor versinya — itulah yang membuat kertas
 * lama bisa dikenali sebagai versi yang sudah digantikan.
 */
const terbitkan = db.transaction((kind, refId, docNo, isi, userId) => {
  const sidikBaru = sidik(isi);
  const ada = ambilTtd.get(kind, refId);

  if (!ada) {
    const token = crypto.randomBytes(24).toString('hex');
    db.prepare(
      `INSERT INTO document_signatures (kind, ref_id, doc_no, token, hash, version, cetak, issued_by)
       VALUES (?,?,?,?,?,1,1,?)`
    ).run(kind, refId, docNo, token, sidikBaru, userId || null);
    return ambilTtd.get(kind, refId);
  }

  if (ada.hash !== sidikBaru) {
    db.prepare(
      `UPDATE document_signatures
          SET hash = ?, doc_no = ?, version = version + 1, cetak = cetak + 1,
              issued_at = datetime('now'), issued_by = ?
        WHERE id = ?`
    ).run(sidikBaru, docNo, userId || null, ada.id);
  } else {
    db.prepare('UPDATE document_signatures SET cetak = cetak + 1 WHERE id = ?').run(ada.id);
  }

  return ambilTtd.get(kind, refId);
});

/** Delapan belas karakter pertama sidik, dikelompokkan agar mudah dibandingkan mata. */
const kodeSingkat = (hash) =>
  String(hash).slice(0, 18).toUpperCase().replace(/(.{6})(?=.)/g, '$1-');

const tautanVerifikasi = (basis, token) => `${basis}/verifikasi/${token}`;

/**
 * Blok tanda tangan digital untuk dipasang pada dokumen cetak.
 *
 * QR-nya berisi tautan lengkap, bukan sekadar tokennya: kamera ponsel membuka
 * tautan begitu saja, sedangkan token telanjang cuma menampilkan deretan huruf
 * yang tidak bisa diapa-apakan siapa pun.
 */
async function blokTtd({ req, kind, refId, docNo, isi, userId, label }) {
  const ttd = terbitkan(kind, refId, docNo, isi, userId);
  const basis = alamatPublik(req);
  const tautan = basis ? tautanVerifikasi(basis, ttd.token) : '';
  const perusahaan = getSetting('company_name', 'Perusahaan');

  let qr = null;
  if (tautan) {
    try {
      qr = await QRCode.toDataURL(tautan, {
        errorCorrectionLevel: 'M',
        margin: 0,
        width: 240,
        color: { dark: '#0F172A', light: '#FFFFFF' },
      });
    } catch {
      // QR gagal dibuat bukan alasan dokumennya batal dicetak; blok tanda
      // tangannya tetap terbaca, hanya tanpa gambar.
      qr = null;
    }
  }

  return {
    label,
    qr,
    tautan,
    digital: {
      oleh: `Sistem ERP ${perusahaan}`,
      nomor: ttd.doc_no,
      waktu: ttd.issued_at,
      versi: ttd.version,
      kode: kodeSingkat(ttd.hash),
    },
    ttd,
  };
}

module.exports = {
  KIND,
  LABEL_KIND,
  alamatPublik,
  sidik,
  terbitkan,
  kodeSingkat,
  tautanVerifikasi,
  blokTtd,
};
