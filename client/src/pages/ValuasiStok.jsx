import { useEffect, useState, useCallback } from 'react';
import { Warehouse, FileSpreadsheet, AlertTriangle, PackageX, Coins, RefreshCw } from 'lucide-react';
import { ResponsiveContainer, BarChart, Bar, XAxis, YAxis, Tooltip, CartesianGrid, Cell } from 'recharts';
import { api } from '../lib/api';
import { PageHeader, StatCard, Spinner, EmptyState, useToast, TombolEkspor } from '../components/ui';
import { rupiah, rupiahShort, num, CHART_COLORS } from '../lib/format';

export default function ValuasiStok() {
  const toast = useToast();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setData(await api.get('/api/inventory/valuation'));
    } catch (err) {
      toast.error(err.message);
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => { load(); }, [load]);

  if (loading || !data) return <Spinner />;

  return (
    <div>
      <PageHeader
        title="Valuasi Nilai Persediaan"
        subtitle={`Real-time • Nilai = Jumlah Stok × HPP • Diperbarui ${new Date(data.asOf).toLocaleString('id-ID')}`}
      >
        <button className="btn-secondary" onClick={load}><RefreshCw size={16} /> Muat Ulang</button>
        <TombolEkspor path="/api/inventory/valuation" nama="valuasi-stok" />
      </PageHeader>

      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard
          label="Total Nilai Persediaan" value={rupiah(data.totalValue)}
          sub={`${data.totalSku} SKU • ${num(data.totalQty)} unit`}
          icon={Warehouse}
        />
        <StatCard
          label="Potensi Pendapatan" value={rupiahShort(data.potentialRevenue)}
          sub="Bila seluruh stok terjual di harga base"
          icon={Coins} tone="green"
        />
        <StatCard
          label="Potensi Laba Kotor" value={rupiahShort(data.potentialMargin)}
          sub={`Margin ${data.potentialRevenue ? ((data.potentialMargin / data.potentialRevenue) * 100).toFixed(1) : 0}%`}
          icon={Coins} tone="brand"
        />
        <StatCard
          label="Perlu Restock" value={data.lowStock.length}
          sub={
            data.neverStocked
              ? `${data.outOfStock} habis • ${data.neverStocked} belum diberi stok minimum`
              : `${data.outOfStock} SKU habis total`
          }
          icon={AlertTriangle} tone={data.lowStock.length ? 'amber' : 'green'}
        />
      </div>

      <div className="mb-4 grid gap-4 lg:grid-cols-2">
        <div className="card">
          <h2 className="card-title mb-3">Nilai Persediaan per Kategori</h2>
          {data.byCategory.length === 0 ? (
            <EmptyState message="Belum ada produk" />
          ) : (
            <ResponsiveContainer width="100%" height={260}>
              <BarChart data={data.byCategory} margin={{ left: -16, right: 8 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" vertical={false} />
                <XAxis dataKey="category" tick={{ fontSize: 11 }} />
                <YAxis tick={{ fontSize: 11 }} tickFormatter={rupiahShort} width={78} />
                <Tooltip formatter={(v) => rupiah(v)} />
                <Bar dataKey="value" radius={[6, 6, 0, 0]}>
                  {data.byCategory.map((_, i) => <Cell key={i} fill={CHART_COLORS[i % CHART_COLORS.length]} />)}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          )}
        </div>

        <div className="card">
          <h2 className="card-title mb-3">Perlu Segera Restock</h2>
          {data.lowStock.length === 0 ? (
            <EmptyState
              message="Tidak ada yang perlu direstock"
              hint={
                data.neverStocked
                  ? `${data.neverStocked} produk berstok nol, tapi belum diberi ambang stok minimum. Isi kolom "Stok Minimum" di Master Produk agar ikut terpantau.`
                  : 'Semua produk masih di atas ambang minimumnya'
              }
            />
          ) : (
            <div className="table-wrap max-h-[260px] overflow-y-auto">
              <table className="table">
                <thead><tr><th>Produk</th><th>Stok</th><th>Min</th><th>Nilai</th></tr></thead>
                <tbody>
                  {data.lowStock.map((p) => (
                    <tr key={p.id}>
                      <td>
                        <p className="font-medium text-slate-900">{p.name}</p>
                        <p className="text-xs text-slate-400">{p.sku}</p>
                      </td>
                      <td className={`tabular font-semibold ${p.out_of_stock ? 'text-rose-600' : 'text-amber-600'}`}>
                        {num(p.stock)} {p.unit}
                        {p.out_of_stock && <span className="ml-1 text-xs font-normal">(habis)</span>}
                      </td>
                      <td className="tabular text-slate-500">{num(p.min_stock)}</td>
                      <td className="tabular">{rupiah(p.stock_value)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>

      <div className="card">
        <h2 className="card-title mb-3">Rincian Valuasi per SKU</h2>
        {data.rows.length === 0 ? (
          <EmptyState message="Belum ada produk terdaftar" hint="Tambahkan produk di menu Master Produk" />
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>SKU</th><th>Produk</th><th>Kategori</th><th>Stok</th>
                  <th>HPP</th><th>Harga Jual</th><th>Nilai Persediaan</th><th>Potensi Jual</th>
                </tr>
              </thead>
              <tbody>
                {data.rows.map((p) => (
                  <tr key={p.id}>
                    <td className="font-mono text-xs">{p.sku}</td>
                    <td className="font-medium text-slate-900">{p.name}</td>
                    <td className="text-xs text-slate-500">{p.category}</td>
                    <td className="tabular">{num(p.stock)} {p.unit}</td>
                    <td className="tabular">{rupiah(p.cost)}</td>
                    <td className="tabular">{rupiah(p.price)}</td>
                    <td className="tabular font-semibold text-slate-900">{rupiah(p.stock_value)}</td>
                    <td className="tabular text-emerald-600">{rupiah(p.potential_revenue)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="border-t-2 border-slate-200 bg-slate-50 font-bold">
                  <td colSpan={6} className="px-3 py-3 text-right">TOTAL</td>
                  <td className="tabular px-3 py-3">{rupiah(data.totalValue)}</td>
                  <td className="tabular px-3 py-3">{rupiah(data.potentialRevenue)}</td>
                </tr>
              </tfoot>
            </table>
          </div>
        )}
      </div>

      {data.outOfStock > 0 && (
        <p className="mt-4 flex items-center gap-2 text-xs text-slate-500">
          <PackageX size={14} /> {data.outOfStock} SKU tercatat kosong dan tidak dapat dijual sampai stok masuk.
        </p>
      )}
    </div>
  );
}
