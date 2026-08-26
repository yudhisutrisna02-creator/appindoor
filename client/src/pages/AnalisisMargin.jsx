import { useEffect, useState, useCallback } from 'react';
import { TrendingUp, Percent, Receipt, Trophy } from 'lucide-react';
import {
  ResponsiveContainer, BarChart, Bar, XAxis, YAxis, Tooltip, CartesianGrid, Cell,
  LineChart, Line, Legend,
} from 'recharts';
import { api } from '../lib/api';
import { PageHeader, StatCard, Spinner, EmptyState, DateRangeFilter, defaultRange, useToast, TombolEkspor } from '../components/ui';
import { rupiah, rupiahShort, num, pct, CHANNEL_LABEL, CHART_COLORS } from '../lib/format';

const FEE_KEYS = [
  ['admin_fee', 'Admin Marketplace'],
  ['handling_fee', 'Handling'],
  ['shipping_extra', 'Ongkir Extra'],
  ['voucher_platform', 'Voucher Platform'],
  ['tax_amount', 'Pajak'],
  ['packing_cost', 'Packing'],
  ['other_cost', 'Lain-lain'],
];

export default function AnalisisMargin() {
  const toast = useToast();
  const [range, setRange] = useState(defaultRange);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setData(await api.get('/api/sales/analytics', range));
    } catch (err) {
      toast.error(err.message);
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [range]);

  useEffect(() => { load(); }, [load]);

  if (loading || !data) {
    return (
      <div>
        <PageHeader title="Analisis Margin" subtitle="Profitabilitas per channel dan per produk" />
        <Spinner />
      </div>
    );
  }

  const best = data.byChannel[0];
  const chartData = data.byChannel.map((c) => ({ ...c, name: c.label }));

  return (
    <div>
      <PageHeader title="Analisis Margin" subtitle="Profitabilitas per channel penjualan dan per produk">
        <TombolEkspor path="/api/sales/analytics" params={range} nama="analisis-margin" />
      </PageHeader>
      <DateRangeFilter range={range} onChange={setRange} />

      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard label="Pendapatan Bersih" value={rupiahShort(data.totals.net_revenue || 0)} sub={`${data.totals.orders || 0} order`} icon={Receipt} />
        <StatCard label="Laba Bersih" value={rupiahShort(data.totals.net_profit || 0)} sub={`Margin ${pct(data.totals.margin_pct || 0)}`} icon={TrendingUp} tone={(data.totals.net_profit || 0) >= 0 ? 'green' : 'red'} />
        <StatCard
          label="Beban Channel" value={rupiahShort(data.totals.total_fees || 0)}
          sub={data.totals.net_revenue ? `${((data.totals.total_fees / data.totals.net_revenue) * 100).toFixed(1)}% dari pendapatan` : '-'}
          icon={Percent} tone="amber"
        />
        <StatCard
          label="Channel Terbaik" value={best ? best.label : '-'}
          sub={best ? `Laba ${rupiahShort(best.net_profit)} • ${pct(best.margin_pct)}` : 'Belum ada data'}
          icon={Trophy} tone="brand"
        />
      </div>

      {data.byChannel.length === 0 ? (
        <div className="card"><EmptyState message="Belum ada transaksi pada periode ini" /></div>
      ) : (
        <>
          <div className="mb-4 grid gap-4 lg:grid-cols-2">
            <div className="card">
              <h2 className="card-title mb-3">Pendapatan vs Laba per Channel</h2>
              <ResponsiveContainer width="100%" height={280}>
                <BarChart data={chartData} margin={{ left: -14, right: 8 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" vertical={false} />
                  <XAxis dataKey="name" tick={{ fontSize: 10 }} interval={0} angle={-15} textAnchor="end" height={54} />
                  <YAxis tick={{ fontSize: 11 }} tickFormatter={rupiahShort} width={76} />
                  <Tooltip formatter={(v) => rupiah(v)} />
                  <Legend wrapperStyle={{ fontSize: 11 }} />
                  <Bar name="Pendapatan Bersih" dataKey="net_revenue" fill="#93c5fd" radius={[5, 5, 0, 0]} />
                  <Bar name="Laba Bersih" dataKey="net_profit" radius={[5, 5, 0, 0]}>
                    {chartData.map((d, i) => <Cell key={i} fill={d.net_profit >= 0 ? '#10b981' : '#ef4444'} />)}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>

            <div className="card">
              <h2 className="card-title mb-3">Tren Harian Pendapatan & Laba</h2>
              <ResponsiveContainer width="100%" height={280}>
                <LineChart data={data.daily} margin={{ left: -14, right: 8 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" vertical={false} />
                  <XAxis dataKey="order_date" tick={{ fontSize: 11 }} tickFormatter={(d) => d.slice(8)} />
                  <YAxis tick={{ fontSize: 11 }} tickFormatter={rupiahShort} width={76} />
                  <Tooltip formatter={(v) => rupiah(v)} />
                  <Legend wrapperStyle={{ fontSize: 11 }} />
                  <Line name="Pendapatan" type="monotone" dataKey="net_revenue" stroke="#1a5cf5" strokeWidth={2} dot={false} />
                  <Line name="Laba Bersih" type="monotone" dataKey="net_profit" stroke="#10b981" strokeWidth={2} dot={false} />
                </LineChart>
              </ResponsiveContainer>
            </div>
          </div>

          {/* Rincian biaya per channel */}
          <div className="card mb-4">
            <h2 className="card-title mb-3">Struktur Biaya & Margin per Channel</h2>
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>Channel</th><th>Order</th><th>Pendapatan Bersih</th><th>HPP</th>
                    {FEE_KEYS.map(([k, l]) => <th key={k}>{l}</th>)}
                    <th>Total Biaya</th><th>Laba Bersih</th><th>Margin</th><th>Rasio Biaya</th>
                  </tr>
                </thead>
                <tbody>
                  {data.byChannel.map((c) => (
                    <tr key={c.channel}>
                      <td className="font-medium text-slate-900">{c.label}</td>
                      <td className="tabular">{c.orders}</td>
                      <td className="tabular">{rupiah(c.net_revenue)}</td>
                      <td className="tabular text-slate-500">{rupiah(c.cogs)}</td>
                      {FEE_KEYS.map(([k]) => <td key={k} className="tabular text-amber-700">{rupiah(c[k])}</td>)}
                      <td className="tabular font-semibold text-amber-700">{rupiah(c.total_fees)}</td>
                      <td className={`tabular font-bold ${c.net_profit >= 0 ? 'text-emerald-600' : 'text-rose-600'}`}>
                        {rupiah(c.net_profit)}
                      </td>
                      <td className="tabular">
                        <span className={c.margin_pct >= 15 ? 'badge-green' : c.margin_pct >= 0 ? 'badge-amber' : 'badge-red'}>
                          {pct(c.margin_pct)}
                        </span>
                      </td>
                      <td className="tabular text-slate-500">{pct(c.fee_ratio_pct)}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="border-t-2 border-slate-200 bg-slate-50 font-bold">
                    <td className="px-3 py-3">TOTAL</td>
                    <td className="tabular px-3 py-3">{data.totals.orders}</td>
                    <td className="tabular px-3 py-3">{rupiah(data.totals.net_revenue)}</td>
                    <td className="tabular px-3 py-3">{rupiah(data.totals.cogs)}</td>
                    <td className="px-3 py-3" colSpan={FEE_KEYS.length} />
                    <td className="tabular px-3 py-3">{rupiah(data.totals.total_fees)}</td>
                    <td className="tabular px-3 py-3">{rupiah(data.totals.net_profit)}</td>
                    <td className="tabular px-3 py-3">{pct(data.totals.margin_pct)}</td>
                    <td />
                  </tr>
                </tfoot>
              </table>
            </div>
          </div>

          {/* Produk terlaris */}
          <div className="card">
            <h2 className="card-title mb-3">Produk Penyumbang Laba Terbesar</h2>
            {data.byProduct.length === 0 ? (
              <EmptyState message="Belum ada item terjual" />
            ) : (
              <div className="table-wrap">
                <table className="table">
                  <thead>
                    <tr><th>#</th><th>Produk</th><th>Qty Terjual</th><th>Pendapatan</th><th>HPP</th><th>Laba Kotor</th><th>Margin</th></tr>
                  </thead>
                  <tbody>
                    {data.byProduct.map((p, i) => (
                      <tr key={p.id}>
                        <td className="tabular text-slate-400">{i + 1}</td>
                        <td>
                          <p className="font-medium text-slate-900">{p.name}</p>
                          <p className="text-xs text-slate-400">{p.sku}</p>
                        </td>
                        <td className="tabular">{num(p.qty)} {p.unit}</td>
                        <td className="tabular">{rupiah(p.revenue)}</td>
                        <td className="tabular text-slate-500">{rupiah(p.cost)}</td>
                        <td className="tabular font-semibold text-emerald-600">{rupiah(p.gross_profit)}</td>
                        <td className="tabular">
                          <span className={p.margin_pct >= 25 ? 'badge-green' : p.margin_pct >= 10 ? 'badge-amber' : 'badge-red'}>
                            {pct(p.margin_pct)}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
