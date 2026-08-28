import { createContext, useContext, useCallback, useEffect, useState } from 'react';

const KUNCI = 'erp-tema';
const TemaContext = createContext(null);

/**
 * Tema tampilan: terang, gelap, atau mengikuti perangkat.
 *
 * Pilihan "ikuti perangkat" dibuat sebagai keadaan tersendiri, bukan sekadar
 * nilai awal. Orang yang ponselnya berganti gelap saat malam mengharapkan
 * aplikasinya ikut berganti; kalau pilihan itu hanya dipakai sekali saat
 * pertama dibuka, ia akan terkunci pada tema yang kebetulan berlaku waktu itu.
 */
const PILIHAN = ['terang', 'gelap', 'sistem'];

function bacaPilihan() {
  try {
    const v = localStorage.getItem(KUNCI);
    return PILIHAN.includes(v) ? v : 'sistem';
  } catch {
    // Mode privat menolak penyimpanan — tampilan tetap harus jalan.
    return 'sistem';
  }
}

const sistemGelap = () =>
  typeof window !== 'undefined' &&
  window.matchMedia &&
  window.matchMedia('(prefers-color-scheme: dark)').matches;

/** Pasang atau lepas kelas gelap pada elemen html. */
function terapkan(gelap) {
  const html = document.documentElement;
  html.classList.toggle('dark', gelap);
}

export function TemaProvider({ children }) {
  const [pilihan, setPilihan] = useState(bacaPilihan);
  const [gelap, setGelap] = useState(() => (bacaPilihan() === 'sistem' ? sistemGelap() : bacaPilihan() === 'gelap'));

  useEffect(() => {
    const aktif = pilihan === 'sistem' ? sistemGelap() : pilihan === 'gelap';
    setGelap(aktif);
    terapkan(aktif);
    try {
      localStorage.setItem(KUNCI, pilihan);
    } catch {
      /* tidak bisa disimpan — pilihannya tetap berlaku sampai halaman ditutup */
    }
  }, [pilihan]);

  // Ikuti perubahan tema perangkat, tetapi hanya saat pilihannya memang "sistem".
  useEffect(() => {
    if (pilihan !== 'sistem' || !window.matchMedia) return undefined;
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const ubah = (e) => {
      setGelap(e.matches);
      terapkan(e.matches);
    };
    mq.addEventListener('change', ubah);
    return () => mq.removeEventListener('change', ubah);
  }, [pilihan]);

  /** Pindah ke lawan tema yang sedang tampil, apa pun pilihan sebelumnya. */
  const balik = useCallback(() => setPilihan(gelap ? 'terang' : 'gelap'), [gelap]);

  return (
    <TemaContext.Provider value={{ pilihan, setPilihan, gelap, balik, PILIHAN }}>
      {children}
    </TemaContext.Provider>
  );
}

export function useTema() {
  const ctx = useContext(TemaContext);
  if (!ctx) {
    return { pilihan: 'sistem', setPilihan: () => {}, gelap: false, balik: () => {}, PILIHAN };
  }
  return ctx;
}
