import { useState } from 'react';
import { AlertTriangle, Eraser, Search } from 'lucide-react';
import { api } from '../lib/api';
import { Field, useToast } from './ui';
import { rupiah, num } from '../lib/format';

/** Bulan lalu dalam bentuk YYYY-MM. */
function bulanLalu() {
  const d = new Date();
  d.setDate(1);
  d.setMonth(d.getMonth() - 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

/**
 * Mengosongkan seluruh catatan satu bulan: penjualan, barang masuk/keluar,
 * stok opname, iklan, pesanan pembelian, dan semua jurnal bulan itu.
 *
 * Dipakai sekali-sekali untuk memulai bersih dari bulan berikutnya. Karena itu
 * alurnya sengaja lambat: periksa dulu, baca akibatnya, ketik kata kuncinya.
 * Cadangan dibuat otomatis tepat sebelum penghapusan.
 */
export default function KosongkanBulan({ onSelesai }) {
  const toast = useToast();
  const [bulan, setBulan] = useState(bulanLalu);
  const [hasil, setHasil] = useState(null);
  const [memeriksa, setMemeriksa] = useState(false);
  const [konfirmasi, setKonfirmasi] = useState('');
  const [bawaSaldo, setBawaSaldo] = useState(true);
  const [menghapus, setMenghapus] = useState(false);

  async function periksa() {
    setMemeriksa(true);
    setKonfirmasi('');
    try {
      setHasil(await api.post('/api/kosongkan-bulan', { bulan }));
    } catch (err) {
      toast.error(err.message);
    } finally {
      setMemeriksa(false);
    }
  }

  async function kosongkan() {
    setMenghapus(true);
    try {
      const res = await api.post('/api/kosongkan-bulan', {
        bulan, terapkan: true, konfirmasi, bawa_saldo_mitra: bawaSaldo,
      });
      toast.success(res.message);
      setHasil(null);
      setKonfirmasi('');
      onSelesai?.();
    } catch (err) {
      toast.error(err.message);
    } finally {
      setMenghapus(false);
    }
  }

  const r = hasil?.ringkas;
  const adaIsi = r && (r.orders || r.mutasiStok || r.jurnal);
  const bolehHapus = adaIsi && !hasil.penghalang.length && konfirmasi === r.kataKunci;
  const akunPenting = (hasil?.akun || []).filter((a) => a.is_cash || ['RECEIVABLE', 'PAYABLE', 'INVENTORY'].includes(a.subtype));

  return (
    <div className="card mt-6 border-2 border-rose-200">
      <h2 className="mb-1 flex items-center gap-2 font-bold text-slate-900">
        <Eraser size={18} className="text-rose-600" /> Kosongkan Satu Bulan
      </h2>
      <p className="mb-4 text-xs leading-relaxed text-slate-600">
        Menghapus <strong>seluruh catatan</strong> satu bulan: order penjualan (beserta returnya), barang
        masuk/keluar, stok opname, iklan, pesanan pembelian, pelunasan utang/piutang, kas masuk/keluar,
        dan jurnal manual. Stok produk dikembalikan sebesar mutasi yang dihapus. Data master (produk,
        mitra, toko, rekening) dan bulan lain tidak disentuh. <strong>Cadangan dibuat otomatis</strong>{' '}
        sebelum penghapusan.
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
          <div className="grid gap-x-6 gap-y-1.5 rounded-xl bg-slate-50 p-3 text-sm sm:grid-cols-2">
            <Baris label="Order penjualan" nilai={`${num(r.orders)} order · ${rupiah(r.penjualanKotor)}`} tebal />
            <Baris label="Retur ikut terhapus" nilai={`${num(r.retur)} retur`} />
            <Baris label="Barang masuk" nilai={`${num(r.barangMasuk)} catatan`} />
            <Baris label="Barang keluar (non-penjualan)" nilai={`${num(r.barangKeluar)} catatan`} />
            <Baris label="Koreksi stok opname" nilai={`${num(r.koreksiOpname)} baris · ${num(r.opname)} dokumen`} />
            <Baris label="Iklan" nilai={`${num(r.iklan)} catatan · ${rupiah(r.nilaiIklan)}`} />
            <Baris label="Pesanan pembelian" nilai={`${num(r.pesananBeli)} pesanan`} />
            <Baris label="Jurnal terhapus" nilai={`${num(r.jurnal)} jurnal`} tebal />
          </div>

          {r.perSumber.length > 0 && (
            <div className="flex flex-wrap gap-1.5 text-xs">
              {r.perSumber.map((s) => (
                <span key={s.source} className="rounded-lg bg-surface px-2 py-1 ring-1 ring-slate-200">
                  {s.label}: <strong>{num(s.n)}</strong>
                </span>
              ))}
            </div>
          )}

          {hasil.penghalang.length > 0 && (
            <div className="rounded-xl bg-rose-50 px-3 py-2 text-xs leading-relaxed text-rose-800">
              <p className="mb-1 flex items-center gap-1.5 font-semibold"><AlertTriangle size={14} /> Belum bisa dikosongkan</p>
              <ul className="list-disc pl-5">{hasil.penghalang.map((p) => <li key={p}>{p}</li>)}</ul>
            </div>
          )}

          {hasil.peringatan.length > 0 && (
            <div className="rounded-xl bg-amber-50 px-3 py-2 text-xs leading-relaxed text-amber-900">
              <p className="mb-1 flex items-center gap-1.5 font-semibold"><AlertTriangle size={14} /> Perlu diketahui</p>
              <ul className="list-disc pl-5">{hasil.peringatan.map((p) => <li key={p}>{p}</li>)}</ul>
            </div>
          )}

          {hasil.saldoMitra.length > 0 && (
            <div className="rounded-xl bg-slate-50 p-3 text-xs">
              <label className="flex items-start gap-2">
                <input type="checkbox" className="mt-0.5" checked={bawaSaldo} onChange={(e) => setBawaSaldo(e.target.checked)} />
                <span>
                  <strong>Bawa sisa utang/piutang mitra sebagai saldo awal</strong> (disarankan). Pembayaran di
                  bulan berikutnya sering melunasi utang bulan ini; tanpa saldo awal utangnya menjadi minus.
                </span>
              </label>
              <ul className="mt-2 space-y-0.5 pl-6">
                {hasil.saldoMitra.map((s) => (
                  <li key={`${s.partner_id}-${s.account_id}`} className="flex justify-between gap-3">
                    <span>{s.jenis} {s.name}</span>
                    <span className="tabular font-medium">{rupiah(s.nilai)}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {akunPenting.length > 0 && (
            <div>
              <p className="mb-1 text-xs font-semibold text-slate-700">Saldo yang berubah</p>
              <div className="table-wrap">
                <table className="table text-sm">
                  <thead>
                    <tr>
                      <th>Akun</th>
                      <th className="text-right">Saldo awal bulan berikutnya</th>
                      <th className="text-right">Saldo hari ini</th>
                    </tr>
                  </thead>
                  <tbody>
                    {akunPenting.map((a) => (
                      <tr key={a.code}>
                        <td className="text-xs"><span className="font-mono text-slate-500">{a.code}</span> {a.name}</td>
                        <td className="tabular text-right text-xs">
                          <span className="text-slate-500">{rupiah(a.akhirSekarang)}</span> →{' '}
                          <Angka n={a.akhirSesudah} />
                        </td>
                        <td className="tabular text-right text-xs">
                          <span className="text-slate-500">{rupiah(a.sekarang)}</span> → <Angka n={a.sesudah} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="mt-1 text-xs text-slate-500">
                Sesudah dikosongkan, saldo awal tiap rekening menjadi nol — masukkan saldo sebenarnya
                lewat Kas Masuk kategori Saldo Awal, dan betulkan stok lewat Stok Opname.
              </p>
            </div>
          )}

          {hasil.stok.length > 0 && (
            <details className="rounded-xl bg-slate-50 px-3 py-2 text-xs">
              <summary className="cursor-pointer font-semibold text-slate-700">
                Stok yang berubah ({hasil.stok.length} produk)
              </summary>
              <ul className="mt-2 space-y-0.5">
                {hasil.stok.map((s) => (
                  <li key={s.id} className="flex justify-between gap-3">
                    <span>{s.sku} — {s.name}</span>
                    <span className="tabular">
                      {num(s.sekarang)} → <span className={s.sesudah < 0 ? 'font-semibold text-rose-600' : 'font-semibold'}>{num(s.sesudah)}</span> {s.unit}
                    </span>
                  </li>
                ))}
              </ul>
            </details>
          )}

          {adaIsi && !hasil.penghalang.length ? (
            <Field label={`Ketik ${r.kataKunci} untuk melanjutkan`}>
              <input
                className="input font-mono" value={konfirmasi} placeholder={r.kataKunci}
                onChange={(e) => setKonfirmasi(e.target.value)}
              />
            </Field>
          ) : !adaIsi ? (
            <p className="text-sm text-slate-500">Tidak ada catatan pada bulan ini.</p>
          ) : null}

          <button
            type="button" className="btn-primary !bg-rose-600 hover:!bg-rose-700 disabled:opacity-40"
            disabled={!bolehHapus || menghapus} onClick={kosongkan}
          >
            <Eraser size={16} /> {menghapus ? 'Mencadangkan & mengosongkan...' : `Kosongkan ${r.bulan}`}
          </button>
        </div>
      )}
    </div>
  );
}

function Baris({ label, nilai, tebal }) {
  return (
    <div className="flex justify-between gap-3">
      <span className="text-slate-500">{label}</span>
      <span className={`tabular ${tebal ? 'font-semibold text-slate-900' : 'text-slate-700'}`}>{nilai}</span>
    </div>
  );
}

function Angka({ n }) {
  return <span className={n < 0 ? 'font-semibold text-rose-600' : 'font-semibold text-slate-900'}>{rupiah(n)}</span>;
}
