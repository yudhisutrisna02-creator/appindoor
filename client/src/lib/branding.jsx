import { createContext, useContext, useCallback, useEffect, useState } from 'react';
import { NAMA_APP, NAMA_PERUSAHAAN, MODUL_APP } from './brand';

/**
 * Identitas perusahaan yang diambil dari peladen.
 *
 * Nama dan logo dipakai di halaman masuk — saat itu belum ada sesi — jadi
 * datanya diambil dari endpoint terbuka /api/branding, bukan dari pengaturan
 * yang butuh login. Selama belum diunggah, tampilan jatuh ke nama bawaan
 * aplikasi supaya halaman tidak pernah tampak kosong.
 */
const BrandingContext = createContext(null);

export function BrandingProvider({ children }) {
  const [identitas, setIdentitas] = useState({
    company: NAMA_PERUSAHAAN,
    tagline: MODUL_APP,
    logo: null,
    dimuat: false,
  });

  const muatUlangIdentitas = useCallback(async () => {
    try {
      const res = await fetch('/api/branding');
      if (!res.ok) throw new Error('gagal');
      const d = await res.json();
      setIdentitas({
        company: d.company || NAMA_PERUSAHAAN,
        tagline: d.tagline || MODUL_APP,
        logo: d.logo || null,
        dimuat: true,
      });
    } catch {
      // Identitas hanya mempercantik tampilan; kegagalannya tidak boleh
      // menghalangi siapa pun masuk ke aplikasi.
      setIdentitas((s) => ({ ...s, dimuat: true }));
    }
  }, []);

  useEffect(() => { muatUlangIdentitas(); }, [muatUlangIdentitas]);

  return (
    <BrandingContext.Provider value={{ ...identitas, namaApp: NAMA_APP, muatUlangIdentitas }}>
      {children}
    </BrandingContext.Provider>
  );
}

export function useBranding() {
  const ctx = useContext(BrandingContext);
  if (!ctx) {
    // Dipakai di luar penyedia — kembalikan nilai bawaan daripada melempar
    // galat, karena komponen yang memakainya hanya menampilkan nama dan logo.
    return {
      company: NAMA_PERUSAHAAN,
      tagline: MODUL_APP,
      logo: null,
      namaApp: NAMA_APP,
      dimuat: true,
      muatUlangIdentitas: async () => {},
    };
  }
  return ctx;
}

/** Logo perusahaan, atau kotak berinisial bila logonya belum diunggah. */
export function LogoPerusahaan({ ukuran = 36, className = '' }) {
  const { logo, company, namaApp } = useBranding();
  const inisial = (company || namaApp || 'E').trim().charAt(0).toUpperCase();

  if (logo) {
    return (
      <img
        src={logo}
        alt={company}
        style={{ width: ukuran, height: ukuran }}
        className={`shrink-0 rounded-xl bg-white object-contain ${className}`}
      />
    );
  }

  return (
    <div
      style={{ width: ukuran, height: ukuran, fontSize: ukuran * 0.45 }}
      className={`grid shrink-0 place-items-center rounded-xl bg-brand-600 font-bold text-white ${className}`}
    >
      {inisial}
    </div>
  );
}
