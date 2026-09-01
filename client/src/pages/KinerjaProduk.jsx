import { useEffect, useMemo, useState } from 'react';
import { PackageSearch, AlertTriangle, Boxes, Snowflake } from 'lucide-react';
import { api } from '../lib/api';
import {
  PageHeader, StatCard, Spinner, EmptyState,
  useToast, DateRangeFilter, defaultRange, TombolEkspor,
} from '../components/ui';
import { rupiah, dateID } from '../lib/format';

/** Warna golongan — merah untuk yang perlu dikerjakan, biru untuk yang wajar. */
const NADA = {
  habis: 'bg-rose-50 text-rose-700 ring-rose-200 dark:bg-rose-400/10',
  menipis: 'bg-amber-50 text-amber-700 ring-amber-200 dark:bg-amber-400/10',
  sehat: 'bg-emerald-50 text-emerald-700 ring-emerald-200 dark:bg-emerald-400/10',
  diam: 'bg-slate-100 text-slate-600 ring-slate-200',
  mati: 'bg-slate-200 text-slate-700 ring-slate-300',
  'belum-terjual': 'bg-slate-100 text-slate-500 ring-slate-200',
  kosong: 'bg-slate-100 text-slate-500 ring-slate-200',
};

const URUTAN = [
  { key: 'pendapatan', label: 'Pendapatan terbesar' },
  { key: 'qty', label: 'Paling banyak terjual' },
  { key: 'laba_kotor', label: 'Laba kotor terbesar', laba: true },
  { key: 'margin_pct', label: 'Margin tertinggi', laba: true },
  { key: 'nilai_stok', label: 'Nilai stok terbesar' },
  { key: 'modal_tertahan', label: 'Modal paling lama menganggur' },
  { key: 'cover_hari', label: 'Paling cepat habis', naik: true },
];

/**
 * Kinerja produk.
 *
 * Menggabungkan apa yang laku dengan apa yang masih ada di rak. Selama kedua
 * angka itu dibaca di layar terpisah, produk laris yang stoknya habis tidak
 * pernah terlihat — pesanan yang batal karena barang kosong tidak tercatat
 * di mana pun.
 */
export default function KinerjaProduk() {
  const toast = useToast();
  const [range, setRange] = useState(defaultRange);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [cari, setCari] = useState('');
  const [pilihGolongan, setPilihGolongan] = useState('');
  const [urut, setUrut] = useState('pendapatan');

  useEffect(() => {
    let batal = false;
    setLoading(true);
    api
      .get('/api/kinerja/produk', range)
      .then((d) => { if (!batal) setData(d); })
      .catch((err) => { if (!batal) toast.error(err.message); })
      .finally(() => { if (!batal) setLoading(false); });
    return () => { batal = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [range.from, range.to]);

  const tampil = useMemo(() => {
    if (!data) return [];
    const kata = cari.trim().toLowerCase();
    const opsi = URUTAN.find((u) => u.key === urut) || URUTAN[0];
    return data.rows
      .filter((r) => (!pilihGolongan || r.golongan === pilihGolongan))
      .filter((r) => !kata || r.name.toLowerCase().includes(kata) || r.sku.toLowerCase().includes(kata))
      .slice()
      .sort((a, b) => {
        const x = a[opsi.key];
        const y = b[opsi.key];
        // Produk tanpa laju penjualan tidak punya sisa hari; ia tidak "paling
        // cepat habis", jadi disimpan di bawah alih-alih dianggap nol.
        if (x === null || x === undefined) return 1;
        if (y === null || y === undefined) return -1;
        return opsi.naik ? x - y : y - x;
      });
  }, [data, cari, pilihGolongan, urut]);

  if (loading || !data) return <Spinner label="Menghitung kinerja produk..." />;

  const r = data.ringkas;
  const adaLaba = !data.tanpaLaba;
  const pilihanUrut = URUTAN.filter((u) => adaLaba || !u.laba);

  return (
    <div>
      <PageHeader
        title="Kinerja Produk"
        subtitle="Apa yang laku, apa yang menumpuk, dan apa yang perlu segera dipesan"
      >
        <TombolEkspor path="/api/kinerja/produk" params={range} nama="kinerja-produk" />
      </PageHeader>

      <DateRangeFilter range={range} onChange={setRange} />

      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard
          label="Produk Terjual"
          value={`${r.terjual} / ${r.produk}`}
          sub={`dalam ${data.hariPeriode} hari`}
          icon={PackageSearch}
        />
        <StatCard label="Nilai Persediaan" value={rupiah(r.nilaiStok)} icon={Boxes} />
        <StatCard
          label="Perlu Restok" value={r.perluRestok}
          sub={r.habis > 0 ? `${r.habis} sudah habis` : 'belum ada yang habis'}
          icon={AlertTriangle} tone={r.perluRestok > 0 ? 'red' : 'green'}
        />
        <StatCard
          label="Modal Menganggur" value={rupiah(r.modalTertahan)}
          sub={`${r.diam} produk diam`} icon={Snowflake}
          tone={r.modalTertahan > 0 ? 'amber' : 'brand'}
        />
      </div>

      <div className="card mb-4">
        <h2 className="card-title mb-3">Sebaran Produk</h2>
        <div className="flex flex-wrap gap-2">
          <button
            className={`rounded-lg px-3 py-1.5 text-xs font-medium ring-1 ${
              pilihGolongan ? 'bg-surface text-slate-600 ring-slate-200' : 'bg-slate-900 text-white ring-slate-900'
            }`}
            onClick={() => setPilihGolongan('')}
          >
            Semua ({data.rows.length})
          </button>
          {data.perGolongan.map((g) => (
            <button
              key={g.golongan}
              onClick={() => setPilihGolongan(pilihGolongan === g.golongan ? '' : g.golongan)}
              className={`rounded-lg px-3 py-1.5 text-xs font-medium ring-1 ${NADA[g.golongan]} ${
                pilihGolongan === g.golongan ? 'ring-2' : ''
              }`}
              title={`Nilai stok ${rupiah(g.nilai_stok)}`}
            >
              {g.label} ({g.produk})
            </button>
          ))}
        </div>
      </div>

      <div className="card">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <h2 className="card-title">
            {tampil.length} produk
            {pilihGolongan && ` — ${data.labelGolongan[pilihGolongan]}`}
          </h2>
          <div className="flex flex-wrap gap-2">
            <input
              className="input !w-56" placeholder="Cari nama atau SKU..."
              value={cari} onChange={(e) => setCari(e.target.value)}
            />
            <select className="input !w-56" value={urut} onChange={(e) => setUrut(e.target.value)}>
              {pilihanUrut.map((u) => <option key={u.key} value={u.key}>{u.label}</option>)}
            </select>
          </div>
        </div>

        {tampil.length === 0 ? (
          <EmptyState message="Tidak ada produk yang cocok" />
        ) : (
          <div className="overflow-x-auto">
            <table className="table">
              <thead>
                <tr>
                  <th>Produk</th>
                  <th className="text-right">Stok</th>
                  <th className="text-right">Nilai Stok</th>
                  <th className="text-right">Terjual</th>
                  <th className="text-right">Pendapatan</th>
                  {adaLaba && <th className="text-right">Laba Kotor</th>}
                  {adaLaba && <th className="text-right">Margin</th>}
                  <th className="text-right">Cukup</th>
                  <th>Terakhir Terjual</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {tampil.map((p) => (
                  <tr key={p.id}>
                    <td>
                      <p className="font-medium text-slate-900">{p.name}</p>
                      <p className="font-mono text-xs text-slate-500">{p.sku} • {p.category}</p>
                    </td>
                    <td className={`tabular text-right ${p.stok <= 0 ? 'font-semibold text-rose-600' : ''}`}>
                      {p.stok} {p.unit}
                    </td>
                    <td className="tabular text-right">{rupiah(p.nilai_stok)}</td>
                    <td className="tabular text-right">
                      {p.qty || '—'}
                      {p.qty > 0 && <span className="block text-xs text-slate-500">{p.orders} order</span>}
                    </td>
                    <td className="tabular text-right">{p.pendapatan ? rupiah(p.pendapatan) : '—'}</td>
                    {adaLaba && (
                      <td className={`tabular text-right ${p.laba_kotor < 0 ? 'text-rose-600' : ''}`}>
                        {p.pendapatan ? rupiah(p.laba_kotor) : '—'}
                      </td>
                    )}
                    {adaLaba && (
                      <td className="tabular text-right">{p.pendapatan ? `${p.margin_pct}%` : '—'}</td>
                    )}
                    <td className="tabular text-right">
                      {p.cover_hari === null ? '—' : (
                        <span className={p.cover_hari <= data.ambang.menipis ? 'font-semibold text-amber-600' : ''}>
                          {p.cover_hari} hari
                        </span>
                      )}
                    </td>
                    <td className="text-xs text-slate-600">
                      {p.terakhir_terjual ? (
                        <>
                          {dateID(p.terakhir_terjual)}
                          <span className="block text-slate-400">{p.diam_hari} hari lalu</span>
                        </>
                      ) : 'belum pernah'}
                    </td>
                    <td>
                      <span className={`inline-block rounded-md px-2 py-0.5 text-xs ring-1 ${NADA[p.golongan]}`}>
                        {data.labelGolongan[p.golongan]}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <p className="mt-3 text-xs leading-relaxed text-slate-500">
          &quot;Cukup&quot; adalah perkiraan sisa hari bila penjualan berjalan seperti periode ini.
          Barang disebut diam bila tidak terjual lebih dari {data.ambang.mati} hari — dihitung dari
          seluruh riwayat, bukan hanya periode yang sedang dilihat, supaya produk musiman tidak
          langsung dianggap mati setiap awal bulan.
        </p>
      </div>
    </div>
  );
}
