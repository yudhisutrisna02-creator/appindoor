import { useEffect, useState, useCallback } from 'react';
import {
  Wallet, TrendingUp, Warehouse, Users, AlertTriangle, ShoppingCart,
  ArrowUpRight, ArrowDownRight, Scale,
} from 'lucide-react';
import {
  ResponsiveContainer, AreaChart, Area, XAxis, YAxis, Tooltip, CartesianGrid,
  BarChart, Bar, Cell, PieChart, Pie, Legend,
} from 'recharts';
import { api } from '../lib/api';
import { PageHeader, StatCard, Spinner, DateRangeFilter, defaultRange, useToast, EmptyState } from '../components/ui';
import { rupiah, rupiahShort, pct, num, CHANNEL_LABEL, CHART_COLORS } from '../lib/format';

export default function Dashboard() {
  const toast = useToast();
  const [range, setRange] = useState(defaultRange);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setData(await api.get('/api/dashboard', range));
    } catch (err) {
      toast.error(err.message);
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [range]);

  useEffect(() => { load(); }, [load]);

  if (loading || !data) return <Spinner />;

  const { attendance, inventory, sales, finance, alerts } = data;

  const channelData = sales.byChannel.map((c) => ({
    name: CHANNEL_LABEL[c.channel] || c.channel,
    profit: c.net_profit,
    revenue: c.net_revenue,
    margin: c.margin_pct,
  }));

  const cashflowData = [
    { name: 'Operasi', value: finance.ocf },
    { name: 'Investasi', value: finance.icf },
    { name: 'Pendanaan', value: finance.fcf },
  ];

  return (
    <div>
      <PageHeader title={data.company} subtitle={`Ringkasan periode ${range.from} s/d ${range.to}`} />

      <DateRangeFilter range={range} onChange={setRange} />

      {alerts.length > 0 && (
        <div className="mb-4 space-y-2">
          {alerts.map((a, i) => (
            <div
              key={i}
              className={`flex items-start gap-2.5 rounded-xl px-4 py-3 text-sm ${
                a.level === 'danger' ? 'bg-rose-50 text-rose-800' : 'bg-amber-50 text-amber-800'
              }`}
            >
              <AlertTriangle size={17} className="mt-0.5 shrink-0" />
              <span>{a.message}</span>
            </div>
          ))}
        </div>
      )}

      {/* KPI utama */}
      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard
          label="Pendapatan Bersih" value={rupiahShort(sales.netRevenue)}
          sub={`${sales.orders} order • AOV ${rupiahShort(sales.orders ? sales.netRevenue / sales.orders : 0)}`}
          icon={ShoppingCart}
        />
        <StatCard
          label="Laba Bersih Penjualan" value={rupiahShort(sales.netProfit)}
          sub={`Margin ${pct(sales.marginPct)}`}
          icon={TrendingUp} tone={sales.netProfit >= 0 ? 'green' : 'red'}
        />
        <StatCard
          label="Nilai Persediaan" value={rupiahShort(inventory.totalValue)}
          sub={`${inventory.skuCount} SKU • ${num(inventory.totalQty)} unit`}
          icon={Warehouse} tone="amber"
        />
        <StatCard
          label="Saldo Kas" value={rupiahShort(finance.closingCash)}
          sub={`Perubahan ${finance.netCashChange >= 0 ? '+' : ''}${rupiahShort(finance.netCashChange)}`}
          icon={Wallet} tone={finance.closingCash >= 0 ? 'brand' : 'red'}
        />
      </div>

      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard
          label="Hadir Hari Ini" value={`${attendance.today.present}/${attendance.activeEmployees}`}
          sub={`Terlambat ${attendance.today.late} • Belum absen ${attendance.today.absent}`}
          icon={Users} tone={attendance.today.late > 0 ? 'amber' : 'green'}
        />
        <StatCard
          label="Sebaran Kerja"
          value={`${attendance.today.wfo} WFO`}
          sub={`${attendance.today.wfh} WFH • ${attendance.today.dinas} Dinas Luar`}
          icon={Users} tone="slate"
        />
        <StatCard
          label="Laba Kotor (Akuntansi)" value={rupiahShort(finance.grossProfit)}
          sub={`HPP terserap • Opex ${rupiahShort(finance.opex)}`}
          icon={ArrowUpRight} tone="brand"
        />
        <StatCard
          label="Posisi Neraca" value={rupiahShort(finance.totalAssets)}
          sub={finance.balanced ? 'Aset = Kewajiban + Ekuitas ✓' : 'Tidak seimbang — cek jurnal'}
          icon={Scale} tone={finance.balanced ? 'green' : 'red'}
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        {/* Tren harian */}
        <div className="card lg:col-span-2">
          <h2 className="card-title mb-3">Tren Pendapatan & Laba Harian</h2>
          {sales.dailyTrend.length === 0 ? (
            <EmptyState message="Belum ada transaksi penjualan pada periode ini" />
          ) : (
            <ResponsiveContainer width="100%" height={280}>
              <AreaChart data={sales.dailyTrend} margin={{ left: -18, right: 8, top: 8 }}>
                <defs>
                  <linearGradient id="gRev" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#1a5cf5" stopOpacity={0.35} />
                    <stop offset="95%" stopColor="#1a5cf5" stopOpacity={0} />
                  </linearGradient>
                  <linearGradient id="gProfit" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#10b981" stopOpacity={0.35} />
                    <stop offset="95%" stopColor="#10b981" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" vertical={false} />
                <XAxis dataKey="date" tick={{ fontSize: 11 }} tickFormatter={(d) => d.slice(8)} />
                <YAxis tick={{ fontSize: 11 }} tickFormatter={rupiahShort} width={78} />
                <Tooltip formatter={(v, n) => [rupiah(v), n === 'revenue' ? 'Pendapatan' : 'Laba Bersih']} />
                <Area type="monotone" dataKey="revenue" stroke="#1a5cf5" fill="url(#gRev)" strokeWidth={2} />
                <Area type="monotone" dataKey="profit" stroke="#10b981" fill="url(#gProfit)" strokeWidth={2} />
              </AreaChart>
            </ResponsiveContainer>
          )}
        </div>

        {/* Arus kas */}
        <div className="card">
          <h2 className="card-title mb-3">Arus Kas (OCF / ICF / FCF)</h2>
          <ResponsiveContainer width="100%" height={220}>
            <BarChart data={cashflowData} margin={{ left: -18, right: 8, top: 8 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" vertical={false} />
              <XAxis dataKey="name" tick={{ fontSize: 11 }} />
              <YAxis tick={{ fontSize: 11 }} tickFormatter={rupiahShort} width={78} />
              <Tooltip formatter={(v) => rupiah(v)} />
              <Bar dataKey="value" radius={[6, 6, 0, 0]}>
                {cashflowData.map((d, i) => (
                  <Cell key={i} fill={d.value >= 0 ? '#10b981' : '#ef4444'} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
          <dl className="mt-2 space-y-1 text-xs">
            <Row label="Kas awal" value={rupiah(finance.closingCash - finance.netCashChange)} />
            <Row label="Perubahan bersih" value={rupiah(finance.netCashChange)} tone={finance.netCashChange >= 0 ? 'up' : 'down'} />
            <Row label="Kas akhir" value={rupiah(finance.closingCash)} bold />
          </dl>
        </div>

        {/* Profit per channel */}
        <div className="card lg:col-span-2">
          <h2 className="card-title mb-3">Laba Bersih per Channel Penjualan</h2>
          {channelData.length === 0 ? (
            <EmptyState message="Belum ada order pada periode ini" />
          ) : (
            <ResponsiveContainer width="100%" height={260}>
              <BarChart data={channelData} layout="vertical" margin={{ left: 34, right: 16 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" horizontal={false} />
                <XAxis type="number" tick={{ fontSize: 11 }} tickFormatter={rupiahShort} />
                <YAxis type="category" dataKey="name" tick={{ fontSize: 11 }} width={110} />
                <Tooltip formatter={(v, n) => [rupiah(v), n === 'profit' ? 'Laba Bersih' : 'Pendapatan']} />
                <Bar dataKey="profit" radius={[0, 6, 6, 0]}>
                  {channelData.map((d, i) => (
                    <Cell key={i} fill={d.profit >= 0 ? CHART_COLORS[i % CHART_COLORS.length] : '#ef4444'} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          )}
        </div>

        {/* Komposisi pendapatan */}
        <div className="card">
          <h2 className="card-title mb-3">Komposisi Pendapatan</h2>
          {channelData.length === 0 ? (
            <EmptyState message="Belum ada data" />
          ) : (
            <ResponsiveContainer width="100%" height={260}>
              <PieChart>
                <Pie
                  data={channelData} dataKey="revenue" nameKey="name"
                  innerRadius={52} outerRadius={82} paddingAngle={2}
                >
                  {channelData.map((_, i) => (
                    <Cell key={i} fill={CHART_COLORS[i % CHART_COLORS.length]} />
                  ))}
                </Pie>
                <Tooltip formatter={(v) => rupiah(v)} />
                <Legend wrapperStyle={{ fontSize: 11 }} />
              </PieChart>
            </ResponsiveContainer>
          )}
        </div>
      </div>
    </div>
  );
}

function Row({ label, value, bold, tone }) {
  const Icon = tone === 'up' ? ArrowUpRight : tone === 'down' ? ArrowDownRight : null;
  return (
    <div className="flex items-center justify-between">
      <dt className="text-slate-500">{label}</dt>
      <dd className={`tabular flex items-center gap-1 ${bold ? 'font-bold text-slate-900' : 'text-slate-700'} ${
        tone === 'up' ? 'text-emerald-600' : tone === 'down' ? 'text-rose-600' : ''
      }`}>
        {Icon && <Icon size={13} />}
        {value}
      </dd>
    </div>
  );
}
