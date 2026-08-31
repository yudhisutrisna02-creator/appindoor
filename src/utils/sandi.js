'use strict';
/**
 * Aturan kata sandi dan masa berlakunya.
 *
 * Ditaruh di satu berkas supaya aturan yang sama berlaku di mana pun kata sandi
 * ditetapkan — saat pengguna menggantinya sendiri, saat admin membuat akun
 * baru, dan saat admin mereset. Aturan yang disalin ke tiap tempat cepat atau
 * lambat akan berbeda, dan yang paling longgar di antaranya yang menentukan.
 */

/** Berapa lama kata sandi berlaku sebelum wajib diganti lagi. */
const MASA_BERLAKU_HARI = 90;

const SYARAT = [
  { uji: (s) => s.length >= 8, pesan: 'minimal 8 karakter' },
  { uji: (s) => /[a-z]/.test(s), pesan: 'ada huruf kecil' },
  { uji: (s) => /[A-Z]/.test(s), pesan: 'ada huruf besar' },
  { uji: (s) => /[0-9]/.test(s), pesan: 'ada angka' },
  { uji: (s) => /[^A-Za-z0-9]/.test(s), pesan: 'ada simbol' },
];

/** Daftar syarat untuk ditampilkan di layar, tanpa fungsinya. */
const SYARAT_TEKS = SYARAT.map((s) => s.pesan);

/**
 * Memeriksa kata sandi terhadap seluruh syarat.
 * @returns {{ok: boolean, kurang: string[]}}
 */
function periksaSandi(sandi) {
  const s = String(sandi || '');
  const kurang = SYARAT.filter((k) => !k.uji(s)).map((k) => k.pesan);
  return { ok: kurang.length === 0, kurang };
}

/** Pesan galat yang menyebut apa saja yang kurang, bukan sekadar "tidak valid". */
function pesanSandi(kurang) {
  return `Kata sandi belum memenuhi syarat: ${kurang.join(', ')}`;
}

const hariSejak = (iso) => {
  if (!iso) return Infinity;
  const t = Date.parse(String(iso).replace(' ', 'T') + (String(iso).includes('T') ? '' : 'Z'));
  if (Number.isNaN(t)) return Infinity;
  return (Date.now() - t) / 86400000;
};

/**
 * Apakah pengguna ini wajib mengganti kata sandinya sekarang.
 *
 * Tiga sebab, dan alasannya disebutkan supaya layar bisa menjelaskan kenapa —
 * "wajib ganti" tanpa alasan hanya membuat orang mengira aplikasinya rusak.
 */
function statusSandi(user) {
  if (!user) return { wajib: false };

  if (user.must_change_password) {
    return {
      wajib: true,
      alasan: 'baru',
      pesan: 'Ini masuk pertama Anda. Ganti kata sandi sementara sebelum melanjutkan.',
    };
  }

  const umur = hariSejak(user.password_changed_at);
  if (umur === Infinity) {
    return {
      wajib: true,
      alasan: 'belum-pernah',
      pesan: 'Kata sandi Anda belum pernah diganti sejak akun dibuat. Ganti dulu sebelum melanjutkan.',
    };
  }
  if (umur >= MASA_BERLAKU_HARI) {
    return {
      wajib: true,
      alasan: 'kedaluwarsa',
      pesan: `Kata sandi Anda sudah ${Math.floor(umur)} hari — melewati batas ${MASA_BERLAKU_HARI} hari. Ganti dulu sebelum melanjutkan.`,
    };
  }

  return {
    wajib: false,
    umurHari: Math.floor(umur),
    sisaHari: Math.ceil(MASA_BERLAKU_HARI - umur),
  };
}

module.exports = { MASA_BERLAKU_HARI, SYARAT_TEKS, periksaSandi, pesanSandi, statusSandi };
