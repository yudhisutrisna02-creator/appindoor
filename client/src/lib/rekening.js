/**
 * Toko mana yang dimaksud saat sebuah rekening dipilih.
 *
 * Dipakai formulir order baru DAN formulir ubah order. Ditulis sekali di sini
 * supaya keduanya tidak pernah menebak dengan cara berbeda — dua aturan untuk
 * hal yang sama cepat atau lambat akan saling bertentangan.
 *
 * Satu rekening memang sering dipakai beberapa toko, dan itu tidak selalu
 * membingungkan. Urutan penyaringnya:
 *
 *   1. Kalau tokonya beda kanal — satu Shopee, satu TikTok, satu Lazada —
 *      kanal yang sedang dipilih sudah cukup membedakan.
 *   2. Kalau masih lebih dari satu, dipakai toko yang ditandai utama untuk
 *      rekening itu.
 *   3. Kalau tetap tidak jelas, TIDAK ditebak. Menebak berarti mencatat order
 *      ke toko yang keliru, dan itu baru ketahuan saat laba per toko dibaca
 *      berbulan-bulan kemudian.
 */
export function tokoUntukRekening(shops, kode, kanal) {
  if (!kode) return null;
  const semua = shops.filter((s) => s.cash_code === kode);
  if (semua.length === 1) return semua[0];

  const seKanal = semua.filter((s) => s.channel === kanal);
  if (seKanal.length === 1) return seKanal[0];

  const dasar = seKanal.length ? seKanal : semua;
  const utama = dasar.filter((s) => s.rekening_utama);
  return utama.length === 1 ? utama[0] : null;
}

/** Hari pertama bulan berjalan dan bulan sebelumnya, dalam bentuk YYYY-MM-DD. */
export function rentangBulan(geser = 0) {
  const d = new Date();
  const awal = new Date(d.getFullYear(), d.getMonth() + geser, 1);
  const akhir = new Date(d.getFullYear(), d.getMonth() + geser + 1, 0);
  const f = (x) => `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;
  return { from: f(awal), to: f(akhir) };
}
