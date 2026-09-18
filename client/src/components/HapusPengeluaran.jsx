import { useState } from 'react';
import { AlertTriangle, Banknote, Search } from 'lucide-react';
import { api } from '../lib/api';
import { Field, useToast } from './ui';
import { rupiah, num, dateID } from '../lib/format';

function bulanLalu() {
  const d = new Date();
  d.setDate(1);
  d.setMonth(d.getMonth() - 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

/**
 * Menghapus seluruh catatan UANG KELUAR pada satu bulan, tanpa menyentuh
 * penjualan dan pemasukannya.
 *
 * Dipakai ketika sebuah bulan hanya dijadikan titik tolak: pengeluarannya tidak
 * ingin ikut terbawa, dan yang dipakai hanya saldo akhir bulan itu — yang diisi
 * sendiri lewat Setel Saldo di menu Rekening.
 */
export default function HapusPengeluaran() {
  const toast = useToast();
  const [bulan, setBulan] = useState(bulanLalu);
  const [hasil, setHasil] = useState(null);
  const [memeriksa, setMemeriksa] = useState(false);
  const [konfirmasi, setKonfirmasi] = useState('');
  const [menghapus, setMenghapus] = useState(false);

  async function periksa() {
    setMemeriksa(true);
    setKonfirmasi('');
    try {
      setHasil(await api.post('/api/cashflow/hapus-pengeluaran', { bulan }));
    } catch (err) {
      toast.error(err.message);
    } finally {
      setMemeriksa(false);
    }
  }

  async function hapus() {
    setMenghapus(true);
    try {
      const res = await api.post('/api/cashflow/hapus-pengeluaran', { bulan, terapkan: true, konfirmasi });
      toast.success(res.message);
      setHasil(null);
      setKonfirmasi('');
    } catch (err) {
      toast.error(err.message);
    } finally {
      setMenghapus(false);
    }
  }

  const r = hasil?.ringkas;
  const boleh = r && r.jurnal > 0 && !hasil.penghalang.length && konfirmasi === r.kataKunci;

  return (
    <div className="card mt-6 border-2 border-amber-200">
      <h2 className="mb-1 flex items-center gap-2 font-bold text-slate-900">
        <Banknote size={18} className="text-amber-600" /> Hapus Pengeluaran Satu Bulan
      </h2>
      <p className="mb-4 text-xs leading-relaxed text-slate-600">
        Menghapus <strong>semua catatan uang keluar</strong> pada satu bulan — kas keluar, biaya iklan,
        pelunasan utang, dan pindah saldo. Penjualan, pemasukan, dan stok <strong>tidak disentuh</strong>.
        Pembelian barang dan gaji dilewati karena punya dokumen sendiri. Cadangan dibuat otomatis sebelum
        penghapusan. Setelah ini, isi saldo tiap rekening lewat <strong>Rekening → Setel Saldo</strong>.
      </p>

      <div className="flex flex-wrap items-end gap-3">
        <Field label="Bulan" className="w-48">
          <input
            type="month" className="input" value={bulan}
            onChange={(e) => { setBulan(e.target.value); setHasil(null); }}
          />
        </Field>
        <button type="button" className="btn-secondary" onClick={periksa} disabled={memeriksa || !bulan}>
          <Search size={15} /> {memeriksa ? 'Memeriksa...' : 'Periksa Isinya'}
        </button>
      </div>

      {r && (
        <div className="mt-4 grid gap-3">
          <div className="rounded-xl bg-slate-50 p-3 text-sm">
            <div className="flex justify-between gap-3">
              <span className="text-slate-500">Pengeluaran yang akan dihapus</span>
              <span className="tabular font-semibold text-slate-900">
                {num(r.jurnal)} catatan · {rupiah(r.total)}
              </span>
            </div>
            <div className="mt-2 flex flex-wrap gap-1.5 text-xs">
              {r.perSumber.map((s) => (
                <span key={s.source} className="rounded-lg bg-surface px-2 py-1 ring-1 ring-slate-200">
                  {s.label}: <strong>{num(s.jumlah)}</strong> · {rupiah(s.nilai)}
                </span>
              ))}
            </div>
          </div>

          {hasil.penghalang.length > 0 && (
            <div className="rounded-xl bg-rose-50 px-3 py-2 text-xs leading-relaxed text-rose-800">
              <p className="mb-1 flex items-center gap-1.5 font-semibold"><AlertTriangle size={14} /> Belum bisa dihapus</p>
              <ul className="list-disc pl-5">{hasil.penghalang.map((p) => <li key={p}>{p}</li>)}</ul>
            </div>
          )}

          {hasil.peringatan.length > 0 && (
            <div className="rounded-xl bg-amber-50 px-3 py-2 text-xs leading-relaxed text-amber-900">
              <p className="mb-1 flex items-center gap-1.5 font-semibold"><AlertTriangle size={14} /> Perlu diketahui</p>
              <ul className="list-disc pl-5">{hasil.peringatan.map((p) => <li key={p}>{p}</li>)}</ul>
            </div>
          )}

          {hasil.contoh.length > 0 && (
            <details className="rounded-xl bg-slate-50 px-3 py-2 text-xs" open>
              <summary className="cursor-pointer font-semibold text-slate-700">
                Daftar pengeluarannya ({num(r.jurnal)})
              </summary>
              <ul className="mt-2 space-y-0.5">
                {hasil.contoh.map((x) => (
                  <li key={x.id} className="flex justify-between gap-3">
                    <span className="truncate">{dateID(x.entry_date)} · {x.label} · {x.description}</span>
                    <span className="tabular font-medium">{rupiah(x.nilai)}</span>
                  </li>
                ))}
              </ul>
            </details>
          )}

          {hasil.contohDilewati.length > 0 && (
            <details className="rounded-xl bg-slate-50 px-3 py-2 text-xs">
              <summary className="cursor-pointer font-semibold text-slate-700">
                Dilewati — betulkan lewat dokumennya ({num(r.dilewati)})
              </summary>
              <ul className="mt-2 space-y-0.5">
                {hasil.contohDilewati.map((x) => (
                  <li key={x.id} className="flex justify-between gap-3">
                    <span className="truncate">{dateID(x.entry_date)} · {x.source} · {x.description}</span>
                    <span className="tabular">{rupiah(x.nilai)}</span>
                  </li>
                ))}
              </ul>
            </details>
          )}

          {r.jurnal > 0 && !hasil.penghalang.length ? (
            <Field label={`Ketik ${r.kataKunci} untuk melanjutkan`}>
              <input
                className="input font-mono" value={konfirmasi} placeholder={r.kataKunci}
                onChange={(e) => setKonfirmasi(e.target.value)}
              />
            </Field>
          ) : (
            r.jurnal === 0 && <p className="text-sm text-slate-500">Tidak ada pengeluaran pada bulan ini.</p>
          )}

          <button
            type="button" className="btn-primary !bg-amber-600 hover:!bg-amber-700 disabled:opacity-40"
            disabled={!boleh || menghapus} onClick={hapus}
          >
            <Banknote size={16} />
            {menghapus ? 'Mencadangkan & menghapus...' : `Hapus ${num(r.jurnal)} Pengeluaran ${r.bulan}`}
          </button>
        </div>
      )}
    </div>
  );
}
