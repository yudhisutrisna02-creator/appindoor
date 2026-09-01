import { useEffect, useState } from 'react';

/** Jeda tiap gambar (ms). Cukup lama untuk dinikmati, tidak sampai mengganggu. */
const JEDA = 7000;

/**
 * Latar bergerak untuk halaman masuk.
 *
 * Gambarnya diunggah lewat Pengaturan, jadi pemandangan yang tampil adalah
 * kebun dan sawah milik perusahaan sendiri, bukan foto bawaan aplikasi.
 *
 * Selama belum ada yang diunggah — dan saat gambarnya gagal dimuat — yang
 * tampil adalah pemandangan buatan CSS di bawah. Halaman masuk adalah hal
 * pertama yang dilihat orang setiap pagi; ia tidak boleh pernah tampak rusak
 * atau kosong hanya karena sebuah berkas hilang.
 */
export default function LatarMasuk({ gambar = [] }) {
  const [siap, setSiap] = useState([]);
  const [aktif, setAktif] = useState(0);

  // Gambar hanya dipakai setelah benar-benar berhasil dimuat. Memasangnya
  // lebih awal membuat layar berkedip putih di jaringan yang lambat — persis
  // di saat orang sedang mengetik kata sandinya.
  useEffect(() => {
    let batal = false;
    setSiap([]);
    setAktif(0);

    for (const src of gambar) {
      const img = new Image();
      img.onload = () => {
        if (!batal) setSiap((s) => (s.includes(src) ? s : [...s, src]));
      };
      img.src = src;
    }
    return () => { batal = true; };
  }, [gambar.join('|')]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (siap.length < 2) return undefined;
    const t = setInterval(() => setAktif((i) => (i + 1) % siap.length), JEDA);
    return () => clearInterval(t);
  }, [siap.length]);

  const adaFoto = siap.length > 0;

  return (
    <div className="pointer-events-none absolute inset-0 overflow-hidden" aria-hidden="true">
      <PemandanganBawaan />

      {siap.map((src, i) => (
        <div
          key={src}
          className="absolute inset-0 bg-cover bg-center transition-opacity duration-[2500ms] ease-in-out"
          style={{
            backgroundImage: `url(${src})`,
            opacity: i === aktif ? 1 : 0,
            // Gerakan lambat menghidupkan foto diam tanpa menarik perhatian
            // dari formulir yang sedang diisi.
            animation: i === aktif ? 'latarMasukGerak 18s ease-out forwards' : 'none',
          }}
        />
      ))}

      {/* Peneduh: apa pun fotonya — sawah terang atau tanah gelap — tulisan di
          atasnya harus tetap terbaca.

          Pemandangan bawaan sudah gelap dan hijau dengan sendirinya, jadi ia
          hanya perlu peneduh tipis. Menimpanya dengan peneduh setebal foto
          justru mematikan warnanya sampai halaman tampak kelabu. */}
      {/* Warnanya ditulis sebagai rgba utuh, bukan `to-[#04160f]/88`. Tailwind
          tidak selalu membentuk kelas untuk penanda kepekatan pada warna bebas,
          dan yang gagal itu diam-diam menjadi bening — peneduhnya hilang
          sebelah tanpa pesan galat apa pun. */}
      <div
        className={`absolute inset-0 transition-opacity duration-1000 ${
          adaFoto
            ? 'bg-[linear-gradient(to_bottom_right,rgba(6,32,23,0.86),rgba(6,40,29,0.62),rgba(4,22,15,0.90))]'
            : 'bg-[linear-gradient(to_bottom_right,rgba(6,32,23,0.35),rgba(6,40,29,0.10),rgba(4,22,15,0.48))]'
        }`}
      />
    </div>
  );
}

/**
 * Pemandangan bawaan: lapisan hijau bertumpuk yang mengingatkan pada sawah
 * berundak dan langit pagi. Seluruhnya CSS — tidak ada berkas yang perlu
 * diunduh, jadi halaman masuk tetap ringan dan tidak pernah kosong.
 */
function PemandanganBawaan() {
  return (
    <div className="absolute inset-0 bg-gradient-to-b from-[#0b3b2e] via-[#12563f] to-[#0a2f24]">
      <div
        className="absolute inset-0 opacity-70"
        style={{
          backgroundImage: [
            'radial-gradient(70% 55% at 20% 15%, rgba(134,239,172,0.30), transparent 60%)',
            'radial-gradient(60% 50% at 85% 25%, rgba(56,189,148,0.28), transparent 62%)',
            'radial-gradient(85% 60% at 50% 105%, rgba(6,44,32,0.85), transparent 65%)',
          ].join(','),
          animation: 'latarMasukNafas 24s ease-in-out infinite alternate',
        }}
      />
      {/* Guratan mendatar seperti petak sawah berundak. */}
      <div
        className="absolute inset-x-0 bottom-0 h-3/5 opacity-25"
        style={{
          backgroundImage:
            'repeating-linear-gradient(178deg, rgba(255,255,255,0.14) 0 2px, transparent 2px 34px)',
          maskImage: 'linear-gradient(to top, black, transparent)',
          WebkitMaskImage: 'linear-gradient(to top, black, transparent)',
        }}
      />
    </div>
  );
}
