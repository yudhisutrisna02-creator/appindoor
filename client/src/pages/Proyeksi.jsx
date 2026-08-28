import { useEffect, useState, useCallback } from 'react';
import {
  ResponsiveContainer, ComposedChart, Bar, Line, XAxis, YAxis, CartesianGrid, Tooltip, ReferenceLine,
} from 'recharts';
import { TrendingDown, Wallet, ArrowDownRight, ArrowUpRight, AlertTriangle } from 'lucide-react';
import { api } from '../lib/api';
import {
  PageHeader, StatCard, Spinner, useToast, Field, TombolEkspor,
} from '../components/ui';
import { rupiah, rupiahShort, dateID } from '../lib/format';

/**
 * Proyeksi arus kas.
 *
 * Menjawab pertanyaan yang tidak dijawab laporan mana pun: bulan depan uangnya
 * cukup atau tidak. Asumsinya ditampilkan berdampingan dengan angkanya — angka
 * proyeksi yang tidak menyebutkan asumsinya akan diperlakukan seolah kepastian.
 */
export default function Proyeksi() {
  const toast = useToast();
  const [minggu, setMinggu] = useState(12);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setData(await api.get('/api/proyeksi', { minggu }));
    } catch (err) {
      toast.error(err.message);
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [minggu]);

  useEffect(() => { load(); }, [load]);

  if (loading || !data) return <Spinner label="Menyusun proyeksi..." />;

  const r = data.ringkas;
  const grafik = data.rows.map((b) => ({
    nama: `M${b.minggu}`,
    Masuk: b.totalMasuk,
    Keluar: -b.totalKeluar,
    Saldo: b.saldoAkhir,
  }));

  return (
    <div>
      <PageHeader
        title="Proyeksi Arus Kas"
        subtitle="Perkiraan uang masuk dan keluar dari yang sudah tercatat"
      >
        <TombolEkspor path="/api/proyeksi" params={{ minggu }} nama="proyeksi-arus-kas" csv />
      </PageHeader>

      <div className="card mb-4">
        <Field label="Jangka Proyeksi" className="max-w-xs">
          <select className="input" value={minggu} onChange={(e) => setMinggu(Number(e.target.value))}>
            <option value={4}>4 minggu</option>
            <option value={8}>8 minggu</option>
            <option value={12}>12 minggu</option>
            <option value={26}>26 minggu</option>
          </select>
        </Field>
      </div>

      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard label="Kas Sekarang" value={rupiahShort(r.saldoAwal)} icon={Wallet} />
        <StatCard
          label="Perkiraan Masuk" value={rupiahShort(r.totalMasuk)}
          sub={`${data.minggu} minggu ke depan`} icon={ArrowUpRight} tone="green"
        />
        <StatCard
          label="Perkiraan Keluar" value={rupiahShort(r.totalKeluar)}
          icon={ArrowDownRight} tone="amber"
        />
        <StatCard
          label="Titik Terendah" value={rupiahShort(r.terendah.saldo)}
          sub={r.terendah.dari ? `pekan ${dateID(r.terendah.dari)}` : 'sekarang'}
          icon={TrendingDown} tone={r.terendah.saldo < 0 ? 'red' : 'brand'}
        />
      </div>

      {r.adaMinus && (
        <div className="card mb-4 border-2 border-rose-200 bg-rose-50/60 dark:bg-rose-400/10">
          <div className="flex items-start gap-2">
            <AlertTriangle size={17} className="mt-0.5 shrink-0 text-rose-600" />
            <div className="text-sm text-slate-700">
              <p className="font-semibold text-slate-900">
                Kas diperkirakan habis pada minggu ke-{r.mingguMinusPertama}
              </p>
              <p className="mt-1 text-xs leading-relaxed">
                Titik terendahnya {rupiah(r.terendah.saldo)}. Yang paling cepat menggeser angka ini
                biasanya mempercepat pencairan dan menunda pembelian yang belum mendesak.
              </p>
            </div>
          </div>
        </div>
      )}

      <div className="card mb-4">
        <h2 className="card-title mb-3">Garis Waktu</h2>
        <div className="h-72">
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart data={grafik} margin={{ top: 8, right: 8, bottom: 4, left: 4 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" vertical={false} />
              <XAxis dataKey="nama" tick={{ fontSize: 11 }} />
              <YAxis tick={{ fontSize: 11 }} tickFormatter={(v) => rupiahShort(v)} width={72} />
              <Tooltip
                formatter={(v, n) => [rupiah(Math.abs(v)), n]}
                labelFormatter={(l) => {
                  const b = data.rows[Number(String(l).slice(1)) - 1];
                  return b ? `${dateID(b.dari)} – ${dateID(b.sampai)}` : l;
                }}
              />
              <ReferenceLine y={0} stroke="#94a3b8" />
              <Bar dataKey="Masuk" fill="#10b981" radius={[3, 3, 0, 0]} />
              <Bar dataKey="Keluar" fill="#f59e0b" radius={[0, 0, 3, 3]} />
              <Line type="monotone" dataKey="Saldo" stroke="#1a5cf5" strokeWidth={2} dot={false} />
            </ComposedChart>
          </ResponsiveContainer>
        </div>
      </div>

      <div className="card mb-4">
        <h2 className="card-title mb-3">Rincian per Minggu</h2>
        <div className="overflow-x-auto">
          <table className="table">
            <thead>
              <tr>
                <th>Minggu</th>
                <th className="text-right">Masuk</th>
                <th className="text-right">Keluar</th>
                <th className="text-right">Bersih</th>
                <th className="text-right">Saldo Akhir</th>
                <th>Rincian</th>
              </tr>
            </thead>
            <tbody>
              {data.rows.map((b) => (
                <tr key={b.minggu} className={b.minus ? 'bg-rose-50/50 dark:bg-rose-400/5' : ''}>
                  <td>
                    <p className="font-medium text-slate-900">Minggu {b.minggu}</p>
                    <p className="text-xs text-slate-500">{dateID(b.dari)} – {dateID(b.sampai)}</p>
                  </td>
                  <td className="tabular text-right text-emerald-600">
                    {b.totalMasuk ? rupiah(b.totalMasuk) : '—'}
                  </td>
                  <td className="tabular text-right text-rose-600">
                    {b.totalKeluar ? rupiah(b.totalKeluar) : '—'}
                  </td>
                  <td className={`tabular text-right ${b.bersih < 0 ? 'text-rose-600' : 'text-slate-700'}`}>
                    {rupiah(b.bersih)}
                  </td>
                  <td className={`tabular text-right font-semibold ${b.minus ? 'text-rose-600' : 'text-slate-900'}`}>
                    {rupiah(b.saldoAkhir)}
                  </td>
                  <td>
                    <div className="flex flex-wrap gap-1">
                      {[...b.masuk, ...b.keluar].map((x) => (
                        <span
                          key={x.sumber}
                          className="rounded bg-slate-100 px-1.5 py-0.5 text-[11px] text-slate-600"
                        >
                          {x.sumber} {rupiahShort(x.nilai)}
                        </span>
                      ))}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <div className="card">
          <h2 className="card-title mb-3">Asumsi yang Dipakai</h2>
          <dl className="space-y-2 text-sm">
            {data.asumsi.map((a) => (
              <div key={a.label}>
                <div className="flex justify-between gap-3">
                  <dt className="text-slate-600">{a.label}</dt>
                  <dd className="text-right font-medium text-slate-900">{a.nilai}</dd>
                </div>
                <p className="text-xs text-slate-400">{a.dasar}</p>
              </div>
            ))}
          </dl>
        </div>

        <div className="card">
          <h2 className="card-title mb-3">Yang Tidak Dihitung</h2>
          <ul className="ml-4 list-disc space-y-1 text-sm text-slate-600">
            {data.tidakDihitung.map((t) => <li key={t}>{t}</li>)}
          </ul>
          <p className="mt-3 text-xs leading-relaxed text-slate-500">
            Penjualan baru sengaja tidak diperhitungkan. Memasukkannya membuat proyeksi selalu
            tampak sehat, padahal yang perlu dijawab justru sebaliknya: kalau tidak ada penjualan
            baru sama sekali, uangnya cukup sampai kapan.
          </p>
        </div>
      </div>
    </div>
  );
}
