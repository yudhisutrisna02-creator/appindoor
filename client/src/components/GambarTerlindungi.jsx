import { useEffect, useState } from 'react';
import { getToken } from '../lib/api';

/**
 * Gambar dari folder unggahan yang hanya boleh dilihat setelah masuk.
 *
 * Tag <img> biasa tidak bisa membawa header Authorization, sedangkan berkasnya
 * dilindungi — foto selfie presensi dan foto anggota tim bukan sesuatu yang
 * pantas terbuka untuk siapa saja yang menebak nama berkasnya. Karena itu
 * gambarnya diambil lewat fetch, lalu ditampilkan sebagai blob URL.
 *
 * Alamat blob dilepas kembali saat komponen dilepas, supaya daftar panjang
 * berisi banyak foto tidak menumpuk di memori peramban.
 */
export default function GambarTerlindungi({ berkas, alt = '', className = '', fallback = null }) {
  const [src, setSrc] = useState(null);
  const [gagal, setGagal] = useState(false);

  useEffect(() => {
    if (!berkas) {
      setSrc(null);
      return undefined;
    }

    let alamat;
    let batal = false;
    setGagal(false);

    fetch(`/api/uploads/${berkas}`, { headers: { Authorization: `Bearer ${getToken()}` } })
      .then((r) => (r.ok ? r.blob() : Promise.reject(new Error('gagal'))))
      .then((blob) => {
        if (batal) return;
        alamat = URL.createObjectURL(blob);
        setSrc(alamat);
      })
      .catch(() => !batal && setGagal(true));

    return () => {
      batal = true;
      if (alamat) URL.revokeObjectURL(alamat);
    };
  }, [berkas]);

  if (!berkas || gagal) return fallback;
  if (!src) return <div className={`animate-pulse bg-slate-100 ${className}`} />;

  return <img src={src} alt={alt} className={className} />;
}
