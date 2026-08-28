'use strict';
/**
 * Daftar dokumen yang pernah dikeluarkan bertanda tangan digital.
 *
 * Ada dua alasan layar ini perlu ada. Pertama, tautan pemeriksaan bisa dibuka
 * siapa pun yang memegangnya — jadi harus ada tempat untuk mencabutnya bila
 * tautannya tersebar ke tangan yang salah. Kedua, tanpa daftar ini tidak ada
 * yang tahu dokumen apa saja yang sudah beredar di luar, siapa yang
 * mengeluarkannya, dan berapa kali.
 */
const express = require('express');
const { db, getSetting } = require('../db');
const { requireAuth, butuhIzin } = require('../middleware/auth');
const { ah, httpError } = require('../utils/http');
const { LABEL_KIND, kodeSingkat, alamatPublik, tautanVerifikasi, sidik } = require('../utils/ttd');
const { isiDokumen } = require('../utils/dokumen');
const { daftarkanEkspor } = require('../utils/ekspor');

const router = express.Router();
router.use(requireAuth);

/** Semua tanda tangan beserta keadaan dokumennya sekarang. */
function ambilDaftar(req) {
  const { url: basis, sumber } = alamatPublik(req, true);

  const rows = db
    .prepare(
      `SELECT t.*, u.name AS penerbit_nama
         FROM document_signatures t
         LEFT JOIN users u ON u.id = t.issued_by
        ORDER BY t.issued_at DESC, t.id DESC`
    )
    .all()
    .map((t) => {
      const isi = isiDokumen(t);
      const sekarang = isi ? sidik(isi.kanonik) : null;

      return {
        id: t.id,
        kind: t.kind,
        jenis: LABEL_KIND[t.kind] || t.kind,
        ref_id: t.ref_id,
        nomor: t.doc_no,
        versi: t.version,
        cetak: t.cetak,
        diterbitkan: t.issued_at,
        penerbit: t.penerbit_nama || null,
        dicabut: t.revoked_at,
        kode: kodeSingkat(t.hash),
        tautan: basis ? tautanVerifikasi(basis, t.token) : null,
        untuk: isi ? isi.tampil.untuk : null,
        nilai: isi ? isi.tampil.total[1] : null,
        // Tiga keadaan yang berbeda dan tidak boleh disamakan: masih sesuai,
        // sudah berubah sejak dicetak, atau dokumennya sudah tidak ada.
        status: t.revoked_at
          ? 'dicabut'
          : !isi
            ? 'hilang'
            : sekarang === t.hash
              ? 'sah'
              : 'berubah',
      };
    });

  return {
    rows,
    basis,
    ringkas: {
      total: rows.length,
      sah: rows.filter((r) => r.status === 'sah').length,
      berubah: rows.filter((r) => r.status === 'berubah').length,
      dicabut: rows.filter((r) => r.status === 'dicabut').length,
      hilang: rows.filter((r) => r.status === 'hilang').length,
      cetak: rows.reduce((s, r) => s + r.cetak, 0),
    },
    // Tautan tidak bisa dibuat tanpa alamat publik; lebih baik dikatakan
    // daripada mencetak QR yang mengarah ke tempat yang tidak ada.
    alamatSumber: sumber,
    // Ditebak dari permintaan berarti belum ditetapkan; itu yang rapuh, bukan
    // ketiadaan alamat sama sekali.
    alamatBelumDiatur: sumber === 'permintaan' || sumber === 'tidakada',
  };
}

router.get('/', butuhIzin('sistem.dokumen'), ah((req, res) => res.json(ambilDaftar(req))));

/**
 * Mencabut tautan pemeriksaan.
 *
 * Dokumennya sendiri tidak dihapus dan angkanya tidak disentuh — yang berhenti
 * berlaku hanya tautannya. Kertas yang sudah tercetak tetap ada di tangan
 * orang, dan itu memang di luar jangkauan aplikasi mana pun.
 */
router.patch('/:id(\\d+)/cabut', butuhIzin('sistem.dokumen'), ah((req, res) => {
  const t = db.prepare('SELECT * FROM document_signatures WHERE id = ?').get(Number(req.params.id));
  if (!t) throw httpError(404, 'Dokumen tidak ditemukan');
  if (t.revoked_at) throw httpError(422, 'Tautan dokumen ini sudah dicabut');

  db.prepare("UPDATE document_signatures SET revoked_at = datetime('now') WHERE id = ?").run(t.id);
  res.json({ ok: true, message: `Tautan ${t.doc_no} dicabut` });
}));

router.patch('/:id(\\d+)/aktifkan', butuhIzin('sistem.dokumen'), ah((req, res) => {
  const t = db.prepare('SELECT * FROM document_signatures WHERE id = ?').get(Number(req.params.id));
  if (!t) throw httpError(404, 'Dokumen tidak ditemukan');
  if (!t.revoked_at) throw httpError(422, 'Tautan dokumen ini masih aktif');

  // Token yang sama dipakai kembali, supaya QR yang sudah tercetak berlaku lagi.
  db.prepare('UPDATE document_signatures SET revoked_at = NULL WHERE id = ?').run(t.id);
  res.json({ ok: true, message: `Tautan ${t.doc_no} diaktifkan kembali` });
}));

const STATUS_LABEL = {
  sah: 'Sesuai',
  berubah: 'Data sudah berubah',
  dicabut: 'Tautan dicabut',
  hilang: 'Dokumen sumber hilang',
};

daftarkanEkspor(router, {
  path: '/',
  judul: 'Dokumen Terbit',
  kolom: [
    { header: 'Nomor', key: 'nomor', width: 24 },
    { header: 'Jenis', key: 'jenis', width: 24 },
    { header: 'Untuk', key: 'untuk', width: 26 },
    { header: 'Nilai', key: 'nilai', width: 16, money: true },
    { header: 'Versi', key: 'versi', width: 8 },
    { header: 'Dicetak', key: 'cetak', width: 9 },
    { header: 'Diterbitkan', key: 'diterbitkan', width: 20 },
    { header: 'Oleh', key: 'penerbit', width: 20 },
    { header: 'Kode', key: 'kode', width: 24 },
    { header: 'Status', key: 'status_label', width: 22 },
  ],
  ambil: (req) => {
    const d = ambilDaftar(req);
    return {
      rows: d.rows.map((r) => ({ ...r, status_label: STATUS_LABEL[r.status] || r.status })),
      subtitle: `${d.ringkas.total} dokumen, ${d.ringkas.cetak} kali dicetak`,
      meta: [
        ['Sesuai', d.ringkas.sah],
        ['Data sudah berubah', d.ringkas.berubah],
        ['Tautan dicabut', d.ringkas.dicabut],
        ['Perusahaan', getSetting('company_name', 'Perusahaan')],
      ],
    };
  },
});

module.exports = router;
