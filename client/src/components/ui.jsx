import { createContext, useContext, useCallback, useState, useEffect } from 'react';
import { AlertCircle, CheckCircle2, Info, X, Loader2, FileSpreadsheet, FileText, Printer, Search } from 'lucide-react';
import { firstOfMonth, today } from '../lib/format';
import { api } from '../lib/api';

// ------------------------------------------------------------------
// Notifikasi toast
// ------------------------------------------------------------------
const ToastContext = createContext(null);

export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([]);

  const push = useCallback((type, message) => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t, { id, type, message }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 5200);
  }, []);

  const toast = {
    success: (m) => push('success', m),
    error: (m) => push('error', m),
    info: (m) => push('info', m),
  };

  const ICONS = { success: CheckCircle2, error: AlertCircle, info: Info };
  const STYLES = {
    success: 'bg-emerald-600',
    error: 'bg-rose-600',
    info: 'bg-ink-800',
  };

  return (
    <ToastContext.Provider value={toast}>
      {children}
      <div className="pointer-events-none fixed inset-x-3 bottom-3 z-[100] flex flex-col gap-2 sm:inset-x-auto sm:right-5 sm:bottom-5 sm:w-96">
        {toasts.map((t) => {
          const Icon = ICONS[t.type];
          return (
            <div
              key={t.id}
              role="status"
              className={`pointer-events-auto flex items-start gap-2.5 rounded-xl px-4 py-3 text-sm text-white shadow-lg ${STYLES[t.type]}`}
            >
              <Icon size={18} className="mt-0.5 shrink-0" />
              <span className="flex-1 leading-snug">{t.message}</span>
              <button onClick={() => setToasts((x) => x.filter((y) => y.id !== t.id))} aria-label="Tutup">
                <X size={16} />
              </button>
            </div>
          );
        })}
      </div>
    </ToastContext.Provider>
  );
}

export const useToast = () => {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast harus dipakai di dalam ToastProvider');
  return ctx;
};

// ------------------------------------------------------------------
// Elemen tampilan umum
// ------------------------------------------------------------------
export function PageHeader({ title, subtitle, children }) {
  return (
    <div className="mb-4 flex flex-col gap-3 sm:mb-5 sm:flex-row sm:items-end sm:justify-between">
      <div>
        <h1 className="text-xl font-bold text-slate-900 sm:text-2xl">{title}</h1>
        {subtitle && <p className="mt-0.5 text-sm text-slate-500">{subtitle}</p>}
      </div>
      {children && <div className="flex flex-wrap items-center gap-2">{children}</div>}
    </div>
  );
}

export function StatCard({ label, value, sub, icon: Icon, tone = 'brand' }) {
  const tones = {
    brand: 'bg-brand-50 text-brand-700',
    green: 'bg-emerald-50 text-emerald-700',
    amber: 'bg-amber-50 text-amber-700',
    red: 'bg-rose-50 text-rose-700',
    slate: 'bg-slate-100 text-slate-700',
  };
  return (
    <div className="card">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="card-title truncate">{label}</p>
          <p className="tabular mt-1.5 text-lg font-bold text-slate-900 sm:text-xl">{value}</p>
          {/* Keterangan dibiarkan membungkus, bukan dipotong — kalimat yang
              terpenggal di tengah lebih membingungkan daripada kartu yang
              sedikit lebih tinggi. */}
          {sub && <p className="mt-0.5 text-xs leading-snug text-slate-500">{sub}</p>}
        </div>
        {Icon && (
          <div className={`shrink-0 rounded-xl p-2.5 ${tones[tone]}`}>
            <Icon size={20} />
          </div>
        )}
      </div>
    </div>
  );
}

export function Spinner({ label = 'Memuat data...' }) {
  return (
    <div className="flex items-center justify-center gap-2 py-12 text-sm text-slate-500">
      <Loader2 size={18} className="animate-spin" />
      {label}
    </div>
  );
}

export function EmptyState({ message = 'Belum ada data', hint }) {
  return (
    <div className="py-12 text-center">
      <p className="text-sm font-medium text-slate-500">{message}</p>
      {hint && <p className="mt-1 text-xs text-slate-400">{hint}</p>}
    </div>
  );
}

export function Modal({ open, onClose, title, children, wide = false }) {
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKey);
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = '';
    };
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-ink-900/50 p-0 sm:items-center sm:p-4">
      <div
        className={`max-h-[92vh] w-full overflow-y-auto rounded-t-2xl bg-surface p-5 shadow-xl sm:rounded-2xl ${
          wide ? 'sm:max-w-3xl' : 'sm:max-w-lg'
        }`}
      >
        <div className="mb-4 flex items-center justify-between gap-4">
          <h2 className="text-lg font-bold text-slate-900">{title}</h2>
          <button onClick={onClose} className="btn-ghost !px-2 !py-2" aria-label="Tutup">
            <X size={18} />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

/** Filter rentang tanggal yang dipakai hampir semua halaman laporan. */
export function DateRangeFilter({ range, onChange, children }) {
  return (
    <div className="card mb-4 flex flex-col gap-3 sm:flex-row sm:items-end">
      <div className="flex-1">
        <label className="label" htmlFor="range-from">Dari Tanggal</label>
        <input
          id="range-from" type="date" className="input"
          value={range.from}
          onChange={(e) => onChange({ ...range, from: e.target.value })}
        />
      </div>
      <div className="flex-1">
        <label className="label" htmlFor="range-to">Sampai Tanggal</label>
        <input
          id="range-to" type="date" className="input"
          value={range.to}
          onChange={(e) => onChange({ ...range, to: e.target.value })}
        />
      </div>
      {children}
    </div>
  );
}

export const defaultRange = () => ({ from: firstOfMonth(), to: today() });

export function Field({ label, children, hint, className = '' }) {
  return (
    <div className={className}>
      <label className="label">{label}</label>
      {children}
      {hint && <p className="mt-1 text-xs text-slate-400">{hint}</p>}
    </div>
  );
}

/**
 * Kotak pencarian.
 *
 * Dibuat satu komponen supaya seluruh menu berperilaku sama: penundaan yang
 * sama sebelum mencari, tombol hapus di tempat yang sama, dan keterangan yang
 * sama tentang kolom apa saja yang dicari. Pengguna tidak perlu belajar ulang
 * tiap pindah halaman.
 *
 * `onCari` dipanggil setelah pengetikan berhenti sejenak. Tanpa jeda itu,
 * pencarian di sisi peladen akan mengirim satu permintaan per huruf.
 */
export function KotakCari({ nilai, onCari, placeholder = 'Cari...', jeda = 350, className = '' }) {
  const [teks, setTeks] = useState(nilai || '');

  // Nilai dari luar (mis. saringan direset halaman) harus menang atas isi kotak.
  useEffect(() => { setTeks(nilai || ''); }, [nilai]);

  useEffect(() => {
    if ((nilai || '') === teks) return undefined;
    const t = setTimeout(() => onCari(teks), jeda);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [teks, jeda]);

  return (
    <div className={`relative ${className}`}>
      <Search size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
      <input
        className="input !pl-9 !pr-8"
        value={teks}
        placeholder={placeholder}
        onChange={(e) => setTeks(e.target.value)}
        onKeyDown={(e) => {
          // Enter mencari seketika tanpa menunggu jeda; Escape mengosongkan.
          if (e.key === 'Enter') onCari(teks);
          if (e.key === 'Escape') { setTeks(''); onCari(''); }
        }}
      />
      {teks && (
        <button
          type="button"
          onClick={() => { setTeks(''); onCari(''); }}
          className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600"
          aria-label="Hapus pencarian"
        >
          <X size={14} />
        </button>
      )}
    </div>
  );
}

/** Penyaring di sisi layar untuk daftar yang sudah termuat seluruhnya. */
export function saringLokal(rows, kata, ambil) {
  const k = String(kata || '').trim().toLowerCase();
  if (k.length < 1) return rows;
  return rows.filter((r) =>
    ambil(r).some((v) => v !== null && v !== undefined && String(v).toLowerCase().includes(k))
  );
}

const EKSTENSI = { excel: 'xlsx', pdf: 'pdf', csv: 'csv' };

/**
 * Sepasang tombol unduhan Excel dan PDF.
 *
 * Dibuat satu komponen supaya setiap menu mendapat perilaku yang sama —
 * termasuk keadaan sedang mengunduh dan pesan galat yang seragam. Penyaring
 * yang sedang aktif di layar ikut dikirim sebagai parameter, jadi berkas yang
 * turun berisi persis apa yang sedang dilihat pengguna, bukan seluruh tabel.
 */
export function TombolEkspor({ path, params = {}, nama = 'laporan', kecil = false, csv = false }) {
  const toast = useToast();
  const [sibuk, setSibuk] = useState(null);

  async function unduh(bentuk) {
    setSibuk(bentuk);
    try {
      await api.download(`${path}/export/${bentuk}`, params, `${nama}.${EKSTENSI[bentuk]}`);
    } catch (err) {
      toast.error(err.message);
    } finally {
      setSibuk(null);
    }
  }

  const kelas = `btn-secondary ${kecil ? '!px-2.5 !py-1.5 text-xs' : ''}`;

  return (
    <div className="flex gap-2">
      <button className={kelas} onClick={() => unduh('excel')} disabled={sibuk !== null}>
        <FileSpreadsheet size={kecil ? 14 : 16} />
        {sibuk === 'excel' ? 'Menyiapkan...' : 'Excel'}
      </button>
      {csv && (
        <button className={kelas} onClick={() => unduh('csv')} disabled={sibuk !== null}>
          <FileSpreadsheet size={kecil ? 14 : 16} />
          {sibuk === 'csv' ? 'Menyiapkan...' : 'CSV'}
        </button>
      )}
      <button className={kelas} onClick={() => unduh('pdf')} disabled={sibuk !== null}>
        <FileText size={kecil ? 14 : 16} />
        {sibuk === 'pdf' ? 'Menyiapkan...' : 'PDF'}
      </button>
    </div>
  );
}

/**
 * Membuka berkas PDF dari peladen di jendela baru dan langsung memanggil dialog
 * cetak.
 *
 * Tidak bisa sekadar menautkan alamatnya: unduhan membawa token lewat header,
 * yang tidak ikut terbawa bila jendela baru membuka URL biasa. Jadi berkasnya
 * diambil dulu sebagai blob, baru jendelanya menunjuk ke blob itu.
 */
export function TombolCetak({ path, params = {}, label = 'Cetak', kecil = false, icon: Icon }) {
  const toast = useToast();
  const [sibuk, setSibuk] = useState(false);

  async function cetak() {
    setSibuk(true);
    try {
      const url = await api.blobUrl(path, params);
      const jendela = window.open(url, '_blank');
      if (!jendela) {
        // Pemblokir pop-up menahan jendelanya. Berkasnya tetap perlu sampai ke
        // pengguna, jadi jatuhkan ke unduhan biasa daripada gagal diam-diam.
        const a = document.createElement('a');
        a.href = url;
        a.download = 'cetak.pdf';
        document.body.appendChild(a);
        a.click();
        a.remove();
        toast.info('Pop-up diblokir — berkasnya diunduh');
      } else {
        jendela.addEventListener('load', () => jendela.print(), { once: true });
      }
      // Blob dilepas setelah jendelanya sempat memuat isinya.
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    } catch (err) {
      toast.error(err.message);
    } finally {
      setSibuk(false);
    }
  }

  return (
    <button
      className={`btn-secondary ${kecil ? '!px-2.5 !py-1.5 text-xs' : ''}`}
      onClick={cetak} disabled={sibuk}
    >
      {Icon ? <Icon size={kecil ? 14 : 16} /> : <Printer size={kecil ? 14 : 16} />}
      {sibuk ? 'Menyiapkan...' : label}
    </button>
  );
}
