import { useState } from 'react';
import { NavLink, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import {
  LayoutDashboard, Fingerprint, CalendarClock, Package, ArrowLeftRight, ClipboardCheck,
  Warehouse, ShoppingCart, TrendingUp, BookOpenCheck, ListTree, FileBarChart2,
  Settings, LogOut, Menu, X, Wallet, HandCoins, Undo2, Contact, Store,
} from 'lucide-react';

import { useAuth } from './lib/auth';
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

const NAV = [
  { section: 'Ringkasan', items: [{ to: '/', label: 'Dashboard', icon: LayoutDashboard, end: true }] },
  {
    section: 'Presensi',
    items: [
      { to: '/presensi', label: 'Absen Sekarang', icon: Fingerprint },
      { to: '/presensi/rekap', label: 'Rekap Absensi', icon: CalendarClock },
    ],
  },
  {
    section: 'Gudang',
    items: [
      { to: '/gudang/valuasi', label: 'Valuasi Stok', icon: Warehouse },
      { to: '/gudang/produk', label: 'Master Produk', icon: Package },
      { to: '/gudang/mutasi', label: 'Mutasi Stok', icon: ArrowLeftRight },
      { to: '/gudang/opname', label: 'Stok Opname', icon: ClipboardCheck },
    ],
  },
  {
    section: 'Penjualan',
    items: [
      { to: '/penjualan', label: 'Order Penjualan', icon: ShoppingCart },
      { to: '/penjualan/analisis', label: 'Analisis Margin', icon: TrendingUp },
      { to: '/penjualan/retur', label: 'Retur Penjualan', icon: Undo2 },
      { to: '/penjualan/toko', label: 'Toko / Marketplace', icon: Store },
    ],
  },
  {
    section: 'Keuangan',
    items: [
      { to: '/keuangan/kas', label: 'Kas Masuk & Keluar', icon: Wallet },
      { to: '/keuangan/utang-piutang', label: 'Utang & Piutang', icon: HandCoins },
      { to: '/keuangan/laporan', label: 'Laporan Keuangan', icon: FileBarChart2 },
      { to: '/keuangan/jurnal', label: 'Buku Besar & Jurnal', icon: BookOpenCheck },
      { to: '/keuangan/coa', label: 'Chart of Accounts', icon: ListTree },
    ],
  },
  {
    section: 'Mitra',
    items: [{ to: '/mitra', label: 'Supplier & Pelanggan', icon: Contact }],
  },
  { section: 'Sistem', items: [{ to: '/pengaturan', label: 'Pengaturan', icon: Settings }] },
];

function Sidebar({ onNavigate }) {
  const { user, logout } = useAuth();

  return (
    <div className="flex h-full flex-col bg-slate-900 text-slate-300">
      <div className="flex items-center gap-2.5 px-5 py-5">
        <div className="grid h-9 w-9 place-items-center rounded-xl bg-brand-600 font-bold text-white">E</div>
        <div className="min-w-0">
          <p className="truncate text-sm font-bold text-white">ERP Kebumen</p>
          <p className="truncate text-[11px] text-slate-400">Terpadu 4 Modul</p>
        </div>
      </div>

      <nav className="flex-1 overflow-y-auto px-3 pb-4">
        {NAV.map((group) => (
          <div key={group.section} className="mb-4">
            <p className="px-3 pb-1.5 text-[10px] font-bold uppercase tracking-wider text-slate-500">
              {group.section}
            </p>
            {group.items.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                end={item.end}
                onClick={onNavigate}
                className={({ isActive }) =>
                  `mb-0.5 flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium transition ${
                    isActive ? 'bg-brand-600 text-white shadow-sm' : 'hover:bg-slate-800 hover:text-white'
                  }`
                }
              >
                <item.icon size={17} className="shrink-0" />
                <span className="truncate">{item.label}</span>
              </NavLink>
            ))}
          </div>
        ))}
      </nav>

      <div className="border-t border-slate-800 p-3">
        <div className="mb-2 px-2">
          <p className="truncate text-sm font-semibold text-white">{user?.name}</p>
          <p className="truncate text-[11px] capitalize text-slate-400">
            {user?.role} {user?.position ? `• ${user.position}` : ''}
          </p>
        </div>
        <button
          onClick={logout}
          className="flex w-full items-center gap-2 rounded-xl px-3 py-2.5 text-sm font-medium text-rose-300 transition hover:bg-rose-500/10"
        >
          <LogOut size={17} /> Keluar
        </button>
      </div>
    </div>
  );
}

function Layout({ children }) {
  const [open, setOpen] = useState(false);
  const location = useLocation();

  const currentLabel =
    NAV.flatMap((g) => g.items).find((i) => (i.end ? location.pathname === i.to : location.pathname.startsWith(i.to)))
      ?.label || 'ERP Kebumen';

  return (
    <div className="min-h-screen lg:flex">
      {/* Sidebar desktop */}
      <aside className="hidden w-64 shrink-0 lg:sticky lg:top-0 lg:block lg:h-screen">
        <Sidebar />
      </aside>

      {/* Drawer mobile */}
      {open && (
        <div className="fixed inset-0 z-50 lg:hidden">
          <div className="absolute inset-0 bg-slate-900/60" onClick={() => setOpen(false)} />
          <aside className="absolute inset-y-0 left-0 w-72 max-w-[85vw] shadow-2xl">
            <Sidebar onNavigate={() => setOpen(false)} />
          </aside>
        </div>
      )}

      <div className="min-w-0 flex-1">
        {/* Topbar mobile */}
        <header className="sticky top-0 z-40 flex items-center gap-3 border-b border-slate-200 bg-white/95 px-4 py-3 backdrop-blur lg:hidden">
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

export default function App() {
  const { user, loading } = useAuth();

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
        <Route path="/presensi" element={<Presensi />} />
        <Route path="/presensi/rekap" element={<RekapAbsensi />} />
        <Route path="/gudang/valuasi" element={<ValuasiStok />} />
        <Route path="/gudang/produk" element={<Produk />} />
        <Route path="/gudang/mutasi" element={<MutasiStok />} />
        <Route path="/gudang/opname" element={<StokOpname />} />
        <Route path="/penjualan" element={<Penjualan />} />
        <Route path="/penjualan/analisis" element={<AnalisisMargin />} />
        <Route path="/penjualan/retur" element={<Retur />} />
        <Route path="/penjualan/toko" element={<Toko />} />
        <Route path="/keuangan/kas" element={<KasMasukKeluar />} />
        <Route path="/keuangan/utang-piutang" element={<UtangPiutang />} />
        <Route path="/keuangan/laporan" element={<LaporanKeuangan />} />
        <Route path="/keuangan/jurnal" element={<Jurnal />} />
        <Route path="/keuangan/coa" element={<ChartOfAccounts />} />
        <Route path="/mitra" element={<Mitra />} />
        <Route path="/pengaturan" element={<Pengaturan />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Layout>
  );
}
