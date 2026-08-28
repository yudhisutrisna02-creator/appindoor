import { useState } from 'react';
import { NavLink, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import {
  LayoutDashboard, Fingerprint, CalendarClock, Package, ArrowLeftRight, ClipboardCheck,
  Warehouse, ShoppingCart, TrendingUp, BookOpenCheck, ListTree, FileBarChart2,
  Settings, LogOut, Menu, X, Wallet, HandCoins, Undo2, Contact, Store, ChevronDown, Megaphone,
  Sun, Moon, MonitorSmartphone, Truck, PackageCheck, Landmark, PackageSearch, Target, Hourglass, ShieldCheck, DatabaseBackup, BellRing, TrendingDown, History,
} from 'lucide-react';

import { useAuth } from './lib/auth';
import { NAMA_APP } from './lib/brand';
import { LogoPerusahaan, useBranding } from './lib/branding';
import { useTema } from './lib/tema';
import { Spinner } from './components/ui';

import Login from './pages/Login';
import Dashboard from './pages/Dashboard';
import Presensi from './pages/Presensi';
import RekapAbsensi from './pages/RekapAbsensi';
import Produk from './pages/Produk';
import MutasiStok from './pages/MutasiStok';
import StokOpname from './pages/StokOpname';
import ValuasiStok from './pages/ValuasiStok';
import Penjualan from './pages/Penjualan';
import AnalisisMargin from './pages/AnalisisMargin';
import Jurnal from './pages/Jurnal';
import ChartOfAccounts from './pages/ChartOfAccounts';
import LaporanKeuangan from './pages/LaporanKeuangan';
import Pengaturan from './pages/Pengaturan';
import KasMasukKeluar from './pages/KasMasukKeluar';
import UtangPiutang from './pages/UtangPiutang';
import Mitra from './pages/Mitra';
import Retur from './pages/Retur';
import Toko from './pages/Toko';
import Iklan from './pages/Iklan';
import Pengiriman from './pages/Pengiriman';
import Pembelian from './pages/Pembelian';
import Rekening from './pages/Rekening';
import TargetPencapaian from './pages/Target';
import Penggajian from './pages/Penggajian';
import Pencairan from './pages/Pencairan';
import DokumenTerbit from './pages/DokumenTerbit';
import Cadangan from './pages/Cadangan';
import Perhatian from './pages/Perhatian';
import Proyeksi from './pages/Proyeksi';
import Riwayat from './pages/Riwayat';
import Verifikasi from './pages/Verifikasi';
import KinerjaProduk from './pages/KinerjaProduk';

const NAV = [
  {
    section: 'Ringkasan',
    key: 'ringkasan',
    // Satu-satunya pintasan ke halaman depan — tidak perlu dilipat.
    collapsible: false,
    items: [
      { to: '/', label: 'Dashboard', icon: LayoutDashboard, end: true, izin: 'dashboard.lihat' },
      { to: '/perhatian', label: 'Pusat Perhatian', icon: BellRing },
    ],
  },
  {
    section: 'Presensi',
    key: 'presensi',
    items: [
      { to: '/presensi', label: 'Absen Sekarang', icon: Fingerprint, izin: 'presensi.absen' },
      { to: '/presensi/rekap', label: 'Rekap Absensi', icon: CalendarClock, izin: 'presensi.lihat' },
      { to: '/presensi/penggajian', label: 'Penggajian', icon: Wallet, izin: 'penggajian.lihat' },
    ],
  },
  {
    section: 'Gudang',
    key: 'gudang',
    items: [
      { to: '/gudang/valuasi', label: 'Valuasi Stok', icon: Warehouse, izin: 'gudang.lihat' },
      { to: '/gudang/produk', label: 'Master Produk', icon: Package, izin: 'gudang.lihat' },
      { to: '/gudang/mutasi', label: 'Mutasi Stok', icon: ArrowLeftRight, izin: 'gudang.lihat' },
      { to: '/gudang/opname', label: 'Stok Opname', icon: ClipboardCheck, izin: 'gudang.opname' },
      { to: '/gudang/kinerja', label: 'Kinerja Produk', icon: PackageSearch, izin: 'gudang.kinerja' },
    ],
  },
  {
    section: 'Pembelian',
    key: 'pembelian',
    items: [
      { to: '/pembelian', label: 'Pesanan Pembelian', icon: PackageCheck, izin: 'pembelian.lihat' },
    ],
  },
  {
    section: 'Penjualan',
    key: 'penjualan',
    items: [
      { to: '/penjualan', label: 'Order Penjualan', icon: ShoppingCart, izin: 'penjualan.lihat' },
      { to: '/penjualan/pengiriman', label: 'Papan Pengiriman', icon: Truck, izin: 'penjualan.lihat' },
      { to: '/penjualan/pencairan', label: 'Pencairan Dana', icon: Hourglass, izin: 'penjualan.lihat' },
      { to: '/penjualan/analisis', label: 'Analisis Margin', icon: TrendingUp, izin: 'penjualan.margin' },
      { to: '/penjualan/retur', label: 'Retur Penjualan', icon: Undo2, izin: 'penjualan.retur' },
      { to: '/penjualan/toko', label: 'Toko / Marketplace', icon: Store, izin: 'penjualan.lihat' },
      { to: '/penjualan/iklan', label: 'Biaya Iklan', icon: Megaphone, izin: 'iklan.lihat' },
      { to: '/penjualan/target', label: 'Target & Pencapaian', icon: Target, izin: 'target.lihat' },
    ],
  },
  {
    section: 'Keuangan',
    key: 'keuangan',
    items: [
      { to: '/keuangan/rekening', label: 'Rekening Kas & Bank', icon: Landmark, izin: 'keuangan.lihat' },
      { to: '/keuangan/kas', label: 'Kas Masuk & Keluar', icon: Wallet, izin: 'keuangan.kas' },
      { to: '/keuangan/proyeksi', label: 'Proyeksi Arus Kas', icon: TrendingDown, izin: 'keuangan.lihat' },
      { to: '/keuangan/utang-piutang', label: 'Utang & Piutang', icon: HandCoins, izin: 'keuangan.lihat' },
      { to: '/keuangan/laporan', label: 'Laporan Keuangan', icon: FileBarChart2, izin: 'keuangan.lihat' },
      { to: '/keuangan/jurnal', label: 'Buku Besar & Jurnal', icon: BookOpenCheck, izin: 'keuangan.lihat' },
      { to: '/keuangan/coa', label: 'Chart of Accounts', icon: ListTree, izin: 'keuangan.coa' },
    ],
  },
  {
    section: 'Mitra',
    key: 'mitra',
    items: [{ to: '/mitra', label: 'Supplier & Pelanggan', icon: Contact, izin: 'mitra.lihat' }],
  },
  {
    section: 'Sistem',
    key: 'sistem',
    items: [
      { to: '/pengaturan', label: 'Pengaturan', icon: Settings, izin: ['sistem.pengaturan', 'sistem.tim', 'sistem.peran', 'sistem.kantor'] },
      { to: '/sistem/dokumen', label: 'Dokumen Terbit', icon: ShieldCheck, izin: 'sistem.dokumen' },
      { to: '/sistem/cadangan', label: 'Pencadangan', icon: DatabaseBackup, izin: 'sistem.cadangan' },
      { to: '/sistem/riwayat', label: 'Riwayat & Tutup Buku', icon: History, izin: ['sistem.riwayat', 'keuangan.tutupbuku'] },
    ],
  },
];

const KUNCI_LIPATAN = 'erp-menu-terlipat';

/** Grup mana yang sedang terlipat — disimpan agar pilihan bertahan antar sesi. */
function bacaLipatan() {
  try {
    const isi = JSON.parse(localStorage.getItem(KUNCI_LIPATAN));
    return Array.isArray(isi) ? isi : [];
  } catch {
    return [];
  }
}

function simpanLipatan(daftar) {
  try {
    localStorage.setItem(KUNCI_LIPATAN, JSON.stringify(daftar));
  } catch {
    /* mode privat menolak penyimpanan — cukup abaikan, tampilan tetap jalan */
  }
}

/** Apakah salah satu menu di grup ini sedang dibuka? */
function grupSedangAktif(group, pathname) {
  return group.items.some((i) => (i.end ? pathname === i.to : pathname.startsWith(i.to)));
}

/**
 * Menu yang boleh dilihat pengguna ini.
 *
 * Grup yang seluruh isinya tersembunyi ikut hilang — menyisakan judul grup
 * kosong hanya memberi tahu bahwa ada sesuatu di sana yang tidak boleh dibuka,
 * tanpa memberi jalan apa pun untuk membukanya.
 */
function saringMenu(punya) {
  return NAV
    .map((g) => ({ ...g, items: g.items.filter((i) => !i.izin || punya(...[].concat(i.izin))) }))
    .filter((g) => g.items.length > 0);
}

function Sidebar({ onNavigate }) {
  const { user, logout, punya } = useAuth();
  const menu = saringMenu(punya);
  const identitas = useBranding();
  const location = useLocation();
  const [terlipat, setTerlipat] = useState(bacaLipatan);

  function toggle(key) {
    setTerlipat((lama) => {
      const baru = lama.includes(key) ? lama.filter((k) => k !== key) : [...lama, key];
      simpanLipatan(baru);
      return baru;
    });
  }

  return (
    <div className="di-atas-gelap flex h-full flex-col bg-ink-900 text-slate-300">
      <div className="flex items-center gap-2.5 px-5 py-5">
        <LogoPerusahaan ukuran={36} />
        <div className="min-w-0">
          <p className="truncate text-sm font-bold text-white">{NAMA_APP}</p>
          <p className="truncate text-[11px] text-slate-400">{identitas.company}</p>
        </div>
      </div>

      <nav className="flex-1 overflow-y-auto px-3 pb-4">
        {menu.map((group) => {
          const bisaDilipat = group.collapsible !== false;
          const tertutup = bisaDilipat && terlipat.includes(group.key);
          const adaYangAktif = grupSedangAktif(group, location.pathname);

          return (
            <div key={group.key} className="mb-4">
              {bisaDilipat ? (
                <button
                  type="button"
                  onClick={() => toggle(group.key)}
                  aria-expanded={!tertutup}
                  className="mb-1.5 flex w-full items-center gap-1.5 rounded-lg px-3 py-1 text-[10px] font-bold uppercase tracking-wider transition hover:bg-ink-800/70 hover:text-slate-300"
                >
                  <ChevronDown
                    size={13}
                    className={`shrink-0 transition-transform duration-200 ${tertutup ? '-rotate-90' : ''}`}
                  />
                  <span className={`truncate ${tertutup && adaYangAktif ? 'text-brand-400' : 'text-slate-500'}`}>
                    {group.section}
                  </span>
                  {/* Saat dilipat, titik ini menandai grup tempat halaman aktif berada. */}
                  {tertutup && adaYangAktif && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-brand-500" />}
                </button>
              ) : (
                <p className="px-3 pb-1.5 text-[10px] font-bold uppercase tracking-wider text-slate-500">
                  {group.section}
                </p>
              )}

              {!tertutup &&
                group.items.map((item) => (
                  <NavLink
                    key={item.to}
                    to={item.to}
                    end={item.end}
                    onClick={onNavigate}
                    className={({ isActive }) =>
                      `mb-0.5 flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium transition ${
                        isActive ? 'bg-brand-600 text-white shadow-sm' : 'hover:bg-ink-800 hover:text-white'
                      }`
                    }
                  >
                    <item.icon size={17} className="shrink-0" />
                    <span className="truncate">{item.label}</span>
                  </NavLink>
                ))}
            </div>
          );
        })}
      </nav>

      <div className="border-t border-ink-800 p-3">
        <div className="mb-2 px-2">
          <p className="truncate text-sm font-semibold text-white">{user?.name}</p>
          <p className="truncate text-[11px] capitalize text-slate-400">
            {user?.role} {user?.position ? `• ${user.position}` : ''}
          </p>
        </div>
        <PilihTema />

        <button
          onClick={logout}
          className="mt-1 flex w-full items-center gap-2 rounded-xl px-3 py-2.5 text-sm font-medium text-rose-300 transition hover:bg-rose-500/10"
        >
          <LogOut size={17} /> Keluar
        </button>
      </div>
    </div>
  );
}

/**
 * Pemilih tema.
 *
 * Tiga pilihan, bukan satu sakelar dua arah: "ikuti perangkat" perlu bisa
 * dipilih kembali. Sakelar dua arah memaksa orang memilih terang atau gelap
 * selamanya, padahal sebagian ingin aplikasinya berganti sendiri saat ponselnya
 * beralih ke mode malam.
 */
function PilihTema() {
  const { pilihan, setPilihan } = useTema();
  const opsi = [
    { nilai: 'terang', label: 'Terang', icon: Sun },
    { nilai: 'gelap', label: 'Gelap', icon: Moon },
    { nilai: 'sistem', label: 'Ikuti perangkat', icon: MonitorSmartphone },
  ];

  return (
    <div className="mb-1 rounded-xl bg-ink-800/60 p-1">
      <div className="flex gap-0.5">
        {opsi.map((o) => (
          <button
            key={o.nilai}
            type="button"
            onClick={() => setPilihan(o.nilai)}
            title={o.label}
            aria-label={`Tema ${o.label}`}
            aria-pressed={pilihan === o.nilai}
            className={`flex flex-1 items-center justify-center rounded-lg py-1.5 transition ${
              pilihan === o.nilai ? 'bg-brand-600 text-white' : 'text-slate-400 hover:text-white'
            }`}
          >
            <o.icon size={15} />
          </button>
        ))}
      </div>
    </div>
  );
}

function Layout({ children }) {
  const [open, setOpen] = useState(false);
  const location = useLocation();

  const currentLabel =
    NAV.flatMap((g) => g.items).find((i) => (i.end ? location.pathname === i.to : location.pathname.startsWith(i.to)))
      ?.label || NAMA_APP;

  return (
    <div className="min-h-screen lg:flex">
      {/* Sidebar desktop */}
      <aside className="hidden w-64 shrink-0 lg:sticky lg:top-0 lg:block lg:h-screen">
        <Sidebar />
      </aside>

      {/* Drawer mobile */}
      {open && (
        <div className="fixed inset-0 z-50 lg:hidden">
          <div className="absolute inset-0 bg-ink-900/60" onClick={() => setOpen(false)} />
          <aside className="absolute inset-y-0 left-0 w-72 max-w-[85vw] shadow-2xl">
            <Sidebar onNavigate={() => setOpen(false)} />
          </aside>
        </div>
      )}

      <div className="min-w-0 flex-1">
        {/* Topbar mobile */}
        <header className="sticky top-0 z-40 flex items-center gap-3 border-b border-slate-200 bg-surface/95 px-4 py-3 backdrop-blur lg:hidden">
          <button onClick={() => setOpen(true)} className="btn-ghost !px-2 !py-2" aria-label="Buka menu">
            {open ? <X size={20} /> : <Menu size={20} />}
          </button>
          <span className="truncate font-semibold text-slate-900">{currentLabel}</span>
        </header>

        <main className="mx-auto w-full max-w-7xl px-4 py-5 sm:px-6 sm:py-7">{children}</main>
      </div>
    </div>
  );
}

/**
 * Halaman yang tidak boleh dibuka pengguna ini.
 *
 * Menyembunyikan menu saja tidak cukup — alamatnya masih bisa diketik langsung,
 * dan halaman yang terbuka lalu penuh pesan galat dari peladen lebih
 * membingungkan daripada penolakan yang jelas.
 */
function Terlarang({ izin }) {
  return (
    <div className="grid min-h-[60vh] place-items-center px-4">
      <div className="max-w-md rounded-2xl bg-surface p-6 text-center shadow-sm ring-1 ring-slate-200">
        <h1 className="mb-1 text-lg font-bold text-slate-900">Halaman ini tidak terbuka untuk peran Anda</h1>
        <p className="text-sm text-slate-600">
          Diperlukan hak akses <span className="font-mono text-xs">{[].concat(izin).join(' atau ')}</span>.
          Hubungi admin bila Anda memang membutuhkannya.
        </p>
      </div>
    </div>
  );
}

/** Bungkus halaman dengan pemeriksaan izin. */
function Dijaga({ izin, children }) {
  const { punya } = useAuth();
  if (izin && !punya(...[].concat(izin))) return <Terlarang izin={izin} />;
  return children;
}

export default function App() {
  const { user, loading } = useAuth();
  const lokasi = useLocation();

  // Halaman pemeriksaan dokumen berada di luar gerbang login, dan diperiksa
  // sebelum apa pun yang lain. Yang memindai QR di slip gaji atau nota supplier
  // justru pihak yang tidak punya akun di sini — layar login akan menghentikan
  // mereka pada langkah pertama.
  if (lokasi.pathname.startsWith('/verifikasi/')) {
    return (
      <Routes>
        <Route path="/verifikasi/:token" element={<Verifikasi />} />
      </Routes>
    );
  }

  if (loading) {
    return (
      <div className="grid min-h-screen place-items-center">
        <Spinner label="Menyiapkan aplikasi..." />
      </div>
    );
  }

  if (!user) return <Login />;

  return (
    <Layout>
      <Routes>
        <Route path="/" element={<Dashboard />} />
        <Route path="/presensi" element={<Dijaga izin="presensi.absen"><Presensi /></Dijaga>} />
        <Route path="/presensi/rekap" element={<Dijaga izin="presensi.lihat"><RekapAbsensi /></Dijaga>} />
        <Route path="/gudang/valuasi" element={<Dijaga izin="gudang.lihat"><ValuasiStok /></Dijaga>} />
        <Route path="/gudang/produk" element={<Dijaga izin="gudang.lihat"><Produk /></Dijaga>} />
        <Route path="/gudang/mutasi" element={<Dijaga izin="gudang.lihat"><MutasiStok /></Dijaga>} />
        <Route path="/gudang/opname" element={<Dijaga izin="gudang.opname"><StokOpname /></Dijaga>} />
        <Route path="/pembelian" element={<Dijaga izin="pembelian.lihat"><Pembelian /></Dijaga>} />
        <Route path="/penjualan" element={<Dijaga izin="penjualan.lihat"><Penjualan /></Dijaga>} />
        <Route path="/penjualan/pengiriman" element={<Dijaga izin="penjualan.lihat"><Pengiriman /></Dijaga>} />
        <Route path="/penjualan/analisis" element={<Dijaga izin="penjualan.margin"><AnalisisMargin /></Dijaga>} />
        <Route path="/penjualan/retur" element={<Dijaga izin="penjualan.retur"><Retur /></Dijaga>} />
        <Route path="/penjualan/toko" element={<Dijaga izin="penjualan.lihat"><Toko /></Dijaga>} />
        <Route path="/penjualan/iklan" element={<Dijaga izin="iklan.lihat"><Iklan /></Dijaga>} />
        <Route path="/sistem/riwayat" element={<Dijaga izin={["sistem.riwayat", "keuangan.tutupbuku"]}><Riwayat /></Dijaga>} />
        <Route path="/keuangan/proyeksi" element={<Dijaga izin="keuangan.lihat"><Proyeksi /></Dijaga>} />
        <Route path="/perhatian" element={<Perhatian />} />
        <Route path="/sistem/cadangan" element={<Dijaga izin="sistem.cadangan"><Cadangan /></Dijaga>} />
        <Route path="/sistem/dokumen" element={<Dijaga izin="sistem.dokumen"><DokumenTerbit /></Dijaga>} />
        <Route path="/penjualan/pencairan" element={<Dijaga izin="penjualan.lihat"><Pencairan /></Dijaga>} />
        <Route path="/presensi/penggajian" element={<Dijaga izin="penggajian.lihat"><Penggajian /></Dijaga>} />
        <Route path="/penjualan/target" element={<Dijaga izin="target.lihat"><TargetPencapaian /></Dijaga>} />
        <Route path="/gudang/kinerja" element={<Dijaga izin="gudang.kinerja"><KinerjaProduk /></Dijaga>} />
        <Route path="/keuangan/rekening" element={<Dijaga izin="keuangan.lihat"><Rekening /></Dijaga>} />
        <Route path="/keuangan/kas" element={<Dijaga izin="keuangan.kas"><KasMasukKeluar /></Dijaga>} />
        <Route path="/keuangan/utang-piutang" element={<Dijaga izin="keuangan.lihat"><UtangPiutang /></Dijaga>} />
        <Route path="/keuangan/laporan" element={<Dijaga izin="keuangan.lihat"><LaporanKeuangan /></Dijaga>} />
        <Route path="/keuangan/jurnal" element={<Dijaga izin="keuangan.lihat"><Jurnal /></Dijaga>} />
        <Route path="/keuangan/coa" element={<Dijaga izin="keuangan.coa"><ChartOfAccounts /></Dijaga>} />
        <Route path="/mitra" element={<Dijaga izin="mitra.lihat"><Mitra /></Dijaga>} />
        <Route path="/pengaturan" element={<Dijaga izin={['sistem.pengaturan', 'sistem.tim', 'sistem.peran', 'sistem.kantor']}><Pengaturan /></Dijaga>} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Layout>
  );
}
