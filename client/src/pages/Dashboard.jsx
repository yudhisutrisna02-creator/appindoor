import { useEffect, useState, useCallback, useRef } from 'react';
import {
  Wallet, TrendingUp, Warehouse, Users, ShoppingCart, Scale, Truck,
  AlertTriangle, Lightbulb, Target, Clock, Timer,
  RefreshCw, Activity, CircleDollarSign, Boxes, Megaphone,
} from 'lucide-react';
import {
  ResponsiveContainer, AreaChart, Area, XAxis, YAxis, Tooltip, CartesianGrid,
  BarChart, Bar, Cell, PieChart, Pie, Legend, LineChart, Line,
} from 'recharts';
import { api } from '../lib/api';
import { PageHeader, StatCard, Spinner, DateRangeFilter, defaultRange, useToast, EmptyState } from '../components/ui';
import { rupiah, rupiahShort, pct, num, timeID, dateID, CHART_COLORS, WORK_TYPE_LABEL } from '../lib/format';

/** Selang penyegaran otomatis. Cukup sering untuk terasa hidup, cukup jarang
 *  untuk tidak membebani server bila dashboard dibiarkan terbuka seharian. */
const REFRESH_MS = 60_000;

const TINGKAT = {
  mendesak:  { warna: 'bg-rose-50 text-rose-900 ring-rose-200',      icon: AlertTriangle, label: 'Mendesak' },
  perhatian: { warna: 'bg-amber-50 text-amber-900 ring-amber-200',   icon: AlertTriangle, label: 'Perhatian' },
  peluang:   { warna: 'bg-emerald-50 text-emerald-900 ring-emerald-200', icon: Target,    label: 'Peluang' },
  info:      { warna: 'bg-slate-50 text-slate-800 ring-slate-200',   icon: Lightbulb,     label: 'Info' },
};

const STATUS_WARNA = {
  CAIR: 'badge-green', SELESAI: 'badge-blue', DIKIRIM: 'badge-blue',
  DIPROSES: 'badge-amber', RETUR: 'badge-red', BATAL: 'badge-slate',
};

export default function Dashboard() {
  const toast = useToast();
  const [range, setRange] = useState(defaultRange);
  const [tab, setTab] = useState('penjualan');
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [terakhir, setTerakhir] = useState(null);
  const pertamaKali = useRef(true);

  const load = useCallback(async (diam = false) => {
    if (!diam) setLoading(true);
    try {
      setData(await api.get('/api/dashboard', range));
      setTerakhir(new Date());
    } catch (err) {
      // Kegagalan saat penyegaran otomatis tidak perlu mengganggu layar
      if (!diam) toast.error(err.message);
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [range]);

  useEffect(() => { load(); }, [load]);

  // Penyegaran otomatis; pemanggilan pertama sudah ditangani efek di atas
  useEffect(() => {
    if (pertamaKali.current) { pertamaKali.current = false; }
    const timer = setInterval(() => load(true), REFRESH_MS);
    return () => clearInterval(timer);
  }, [load]);

  if (loading || !data) return <Spinner label="Menyiapkan dashboard..." />;

  const { penjualan, presensi, stok, keuangan, temuan } = data;
  const selisihHarian = penjualan.hariIni.netRevenue - penjualan.kemarin.netRevenue;

  return (
    <div>
      <PageHeader
        title={data.company}
        subtitle={`Pantauan langsung • ${dateID(data.period.today)}`}
      >
        <span className="flex items-center gap-1.5 text-xs text-slate-500">
          <Activity size={13} className="text-emerald-500" />
          Diperbarui {terakhir ? timeID(terakhir) : '-'}
        </span>
        <button className="btn-secondary" onClick={() => load()}>
          <RefreshCw size={16} /> Muat Ulang
        </button>
      </PageHeader>

      {/* ---------- REALTIME HARI INI ---------- */}
      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-5">
        <StatCard
          label="Penjualan Hari Ini" value={rupiahShort(penjualan.hariIni.netRevenue)}
          sub={`${penjualan.hariIni.orders} order • ${
            selisihHarian >= 0 ? '+' : ''
          }${rupiahShort(selisihHarian)} vs kemarin`}
          icon={ShoppingCart} tone={selisihHarian >= 0 ? 'green' : 'amber'}
        />
        <StatCard
          label="Laba Hari Ini" value={rupiahShort(penjualan.hariIni.netProfit)}
          sub={`Margin ${pct(penjualan.hariIni.marginPct)}`}
          icon={TrendingUp} tone={penjualan.hariIni.netProfit >= 0 ? 'green' : 'red'}
        />
        <StatCard
          label="Laba Setelah Iklan" value={rupiahShort(penjualan.iklan.labaHariIniSetelahIklan)}
          sub={`Iklan hari ini ${rupiahShort(penjualan.iklan.hariIni)}`}
          icon={Megaphone}
          tone={penjualan.iklan.labaHariIniSetelahIklan >= 0 ? 'green' : 'red'}
        />
        <StatCard
          label="Hadir Hari Ini" value={`${presensi.hariIni.hadir}/${presensi.karyawanAktif}`}
          sub={`${presensi.hariIni.telat} telat • ${presensi.hariIni.belumAbsen} belum absen`}
          icon={Users} tone={presensi.hariIni.telat > 0 ? 'amber' : 'green'}
        />
        <StatCard
          label="Nilai Stok" value={rupiahShort(stok.totalValue)}
          sub={`${stok.skuCount} SKU • ${stok.outOfStockCount} habis`}
          icon={Warehouse} tone={stok.outOfStockCount > 0 ? 'amber' : 'brand'}
        />
      </div>

      {/* ---------- ANALISIS OTOMATIS ---------- */}
      {temuan.length > 0 && (
        <div className="card mb-4">
          <div className="mb-3 flex items-center gap-2">
            <Lightbulb size={17} className="text-amber-500" />
            <h2 className="font-semibold text-slate-900">Analisis Otomatis</h2>
            <span className="text-xs text-slate-400">
              {temuan.length} temuan dari data Anda
            </span>
          </div>

          <div className="grid gap-2.5 lg:grid-cols-2">
            {temuan.map((t, i) => {
              const g = TINGKAT[t.tingkat] || TINGKAT.info;
              return (
                <div key={i} className={`rounded-xl p-3.5 ring-1 ${g.warna}`}>
                  <div className="mb-1 flex items-start gap-2">
                    <g.icon size={16} className="mt-0.5 shrink-0" />
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-semibold leading-snug">{t.judul}</p>
                      <p className="mt-1 text-xs leading-relaxed opacity-90">{t.pesan}</p>
                      <p className="mt-2 text-xs font-medium leading-relaxed">
                        → {t.aksi}
                      </p>
                      <p className="mt-1.5 text-[11px] italic opacity-70">
                        Dasar hitung: {t.dasar}
                      </p>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      <DateRangeFilter range={range} onChange={setRange} />

      {/* ---------- TAB ---------- */}
      <div className="mb-4 flex gap-1.5 overflow-x-auto rounded-xl bg-white p-1.5 shadow-sm ring-1 ring-slate-200/70">
        {[
          { key: 'penjualan', label: 'Penjualan', icon: ShoppingCart },
          { key: 'presensi', label: 'Presensi', icon: Users },
          { key: 'stok', label: 'Stok', icon: Boxes },
          { key: 'keuangan', label: 'Keuangan', icon: CircleDollarSign },
        ].map((t) => (
          <button
            key={t.key} onClick={() => setTab(t.key)}
            className={`flex shrink-0 items-center gap-2 rounded-lg px-3.5 py-2 text-sm font-semibold transition ${
              tab === t.key ? 'bg-brand-600 text-white' : 'text-slate-600 hover:bg-slate-100'
            }`}
          >
            <t.icon size={16} /> {t.label}
          </button>
        ))}
      </div>

      {tab === 'penjualan' && <TabPenjualan p={penjualan} />}
      {tab === 'presensi' && <TabPresensi p={presensi} />}
      {tab === 'stok' && <TabStok s={stok} />}
      {tab === 'keuangan' && <TabKeuangan k={keuangan} />}
    </div>
  );
}

// ==================================================================
function TabPenjualan({ p }) {
  const channelData = p.byChannel.map((c) => ({ ...c, name: c.label }));
  const tokoData = p.toko.map((t) => ({ ...t, name: t.name }));

  return (
    <div className="grid gap-4">
      {/* Urutannya mengikuti perjalanan uang: dari yang tercatat di nota,
          dipotong marketplace, dipotong HPP, lalu dipotong iklan. */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-3">
        <StatCard label="Pendapatan Kotor" value={rupiahShort(p.periode.netRevenue)} sub={`${p.periode.orders} order • sebelum potongan`} />
        <StatCard label="Biaya Channel" value={rupiahShort(p.periode.totalFees)} sub="admin, voucher, ongkir, packing" tone="amber" />
        <StatCard label="Pendapatan Bersih" value={rupiahShort(p.periode.netReceived)} sub="yang benar-benar diterima" />
      </div>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard label="HPP" value={rupiahShort(p.periode.cogs)} tone="slate" />
        <StatCard label="Laba Bersih" value={rupiahShort(p.periode.netProfit)} sub={`Margin ${pct(p.periode.marginPct)}`} tone={p.periode.netProfit >= 0 ? 'green' : 'red'} />
        <StatCard
          label="Biaya Iklan" value={rupiahShort(p.iklan.periode)}
          sub={p.iklan.roas != null ? `ROAS ${p.iklan.roas.toFixed(2)}× • ${pct(p.iklan.rasioPct)} dari penjualan` : 'belum ada catatan iklan'}
          icon={Megaphone} tone="amber"
        />
        <StatCard
          label="Laba Setelah Iklan" value={rupiahShort(p.iklan.labaSetelahIklan)}
          sub={`Sebelum iklan ${rupiahShort(p.periode.netProfit)}`}
          tone={p.iklan.labaSetelahIklan >= 0 ? 'green' : 'red'}
        />
      </div>

      <div className="grid grid-cols-1 gap-3">
        <StatCard
          label="Dana Belum Cair" value={rupiahShort(p.danaTertahan.nilai)}
          sub={`${p.danaTertahan.orders} order menunggu pencairan`}
          icon={Timer} tone={p.danaTertahan.nilai > 0 ? 'amber' : 'green'}
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <div className="card lg:col-span-2">
          <h2 className="card-title mb-3">Tren Harian — Pendapatan & Laba</h2>
          {p.dailyTrend.length === 0 ? <EmptyState message="Belum ada transaksi pada periode ini" /> : (
            <ResponsiveContainer width="100%" height={280}>
              <AreaChart data={p.dailyTrend} margin={{ left: -16, right: 8, top: 8 }}>
                <defs>
                  <linearGradient id="dRev" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#1a5cf5" stopOpacity={0.35} />
                    <stop offset="95%" stopColor="#1a5cf5" stopOpacity={0} />
                  </linearGradient>
                  <linearGradient id="dProf" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#10b981" stopOpacity={0.35} />
                    <stop offset="95%" stopColor="#10b981" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" vertical={false} />
                <XAxis dataKey="date" tick={{ fontSize: 11 }} tickFormatter={(d) => d.slice(8)} />
                <YAxis tick={{ fontSize: 11 }} tickFormatter={rupiahShort} width={76} />
                <Tooltip formatter={(v, n) => [rupiah(v), n === 'revenue' ? 'Pendapatan' : 'Laba Bersih']} />
                <Area type="monotone" dataKey="revenue" stroke="#1a5cf5" fill="url(#dRev)" strokeWidth={2} />
                <Area type="monotone" dataKey="profit" stroke="#10b981" fill="url(#dProf)" strokeWidth={2} />
              </AreaChart>
            </ResponsiveContainer>
          )}
        </div>

        <div className="card">
          <h2 className="card-title mb-3">Status Pencairan</h2>
          {p.statusPencairan.length === 0 ? <EmptyState message="Belum ada data" /> : (
            <>
              <ResponsiveContainer width="100%" height={200}>
                <PieChart>
                  <Pie data={p.statusPencairan} dataKey="orders" nameKey="status" innerRadius={48} outerRadius={76} paddingAngle={2}>
                    {p.statusPencairan.map((_, i) => <Cell key={i} fill={CHART_COLORS[i % CHART_COLORS.length]} />)}
                  </Pie>
                  <Tooltip formatter={(v, n, o) => [`${v} order — ${rupiah(o.payload.nilai)}`, o.payload.status]} />
                </PieChart>
              </ResponsiveContainer>
              <dl className="mt-1 space-y-1 text-xs">
                {p.statusPencairan.map((s) => (
                  <div key={s.status} className="flex justify-between">
                    <dt className="text-slate-500">{s.status}</dt>
                    <dd className="tabular font-medium">{s.orders} • {rupiahShort(s.nilai)}</dd>
                  </div>
                ))}
              </dl>
            </>
          )}
        </div>
      </div>

      {/* Performa per toko — inti bisnis marketplace multi-akun */}
      <div className="card">
        <h2 className="card-title mb-3">Performa per Toko</h2>
        {tokoData.length === 0 ? (
          <EmptyState message="Belum ada order yang ditandai tokonya" hint="Pilih toko saat mencatat order agar perbandingan ini terisi" />
        ) : (
          <>
            <ResponsiveContainer width="100%" height={Math.max(200, tokoData.length * 38)}>
              <BarChart data={tokoData} layout="vertical" margin={{ left: 34, right: 16 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" horizontal={false} />
                <XAxis type="number" tick={{ fontSize: 11 }} tickFormatter={rupiahShort} />
                <YAxis type="category" dataKey="name" tick={{ fontSize: 11 }} width={130} />
                <Tooltip formatter={(v) => rupiah(v)} />
                <Bar dataKey="net_profit" name="Laba Bersih" radius={[0, 6, 6, 0]}>
                  {tokoData.map((d, i) => <Cell key={i} fill={d.net_profit >= 0 ? CHART_COLORS[i % CHART_COLORS.length] : '#ef4444'} />)}
                </Bar>
              </BarChart>
            </ResponsiveContainer>

            <div className="table-wrap mt-3">
              <table className="table">
                <thead><tr><th>Toko</th><th>Order</th><th>Pendapatan</th><th>Biaya</th><th>Laba</th><th>Margin</th><th>Rasio Biaya</th></tr></thead>
                <tbody>
                  {p.toko.map((t) => (
                    <tr key={t.id}>
                      <td className="font-medium text-slate-900">{t.name}</td>
                      <td className="tabular">{t.orders}</td>
                      <td className="tabular">{rupiah(t.net_revenue)}</td>
                      <td className="tabular text-amber-700">{rupiah(t.total_fees)}</td>
                      <td className={`tabular font-bold ${t.net_profit >= 0 ? 'text-emerald-600' : 'text-rose-600'}`}>{rupiah(t.net_profit)}</td>
                      <td className="tabular"><span className={t.margin_pct >= 15 ? 'badge-green' : t.margin_pct >= 0 ? 'badge-amber' : 'badge-red'}>{pct(t.margin_pct)}</span></td>
                      <td className="tabular text-slate-500">{pct(t.fee_ratio_pct)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <div className="card">
          <h2 className="card-title mb-3">Laba per Channel</h2>
          {channelData.length === 0 ? <EmptyState message="Belum ada data" /> : (
            <ResponsiveContainer width="100%" height={240}>
              <BarChart data={channelData} margin={{ left: -16, right: 8 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" vertical={false} />
                <XAxis dataKey="name" tick={{ fontSize: 10 }} interval={0} angle={-15} textAnchor="end" height={54} />
                <YAxis tick={{ fontSize: 11 }} tickFormatter={rupiahShort} width={76} />
                <Tooltip formatter={(v) => rupiah(v)} />
                <Bar dataKey="net_profit" name="Laba" radius={[5, 5, 0, 0]}>
                  {channelData.map((d, i) => <Cell key={i} fill={d.net_profit >= 0 ? CHART_COLORS[i % CHART_COLORS.length] : '#ef4444'} />)}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          )}
        </div>

        <div className="card">
          <h2 className="card-title mb-3">Kota Penyumbang Omzet</h2>
          {p.kota.length === 0 ? <EmptyState message="Belum ada data kota" hint="Isi kolom Kota Pembeli saat mencatat order" /> : (
            <div className="table-wrap max-h-[260px] overflow-y-auto">
              <table className="table">
                <thead><tr><th>Kota</th><th>Order</th><th>Pendapatan</th><th>Laba</th></tr></thead>
                <tbody>
                  {p.kota.map((k) => (
                    <tr key={k.kota}>
                      <td className="font-medium text-slate-900">{k.kota}</td>
                      <td className="tabular">{k.orders}</td>
                      <td className="tabular">{rupiah(k.net_revenue)}</td>
                      <td className="tabular text-emerald-600">{rupiah(k.net_profit)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <div className="card">
          <h2 className="card-title mb-3">Order Terbaru</h2>
          {p.orderTerbaru.length === 0 ? <EmptyState message="Belum ada order" /> : (
            <div className="table-wrap">
              <table className="table">
                <thead><tr><th>Order</th><th>Toko / Channel</th><th>Pembeli</th><th>Status</th><th>Laba</th></tr></thead>
                <tbody>
                  {p.orderTerbaru.map((o) => (
                    <tr key={o.order_no}>
                      <td>
                        <p className="font-mono text-xs">{o.order_no}</p>
                        <p className="text-xs text-slate-400">{dateID(o.order_date)}</p>
                      </td>
                      <td className="text-xs">{o.shop_name || o.label}</td>
                      <td className="text-xs">
                        {o.buyer_name || '-'}
                        {o.buyer_city && <span className="block text-slate-400">{o.buyer_city}</span>}
                      </td>
                      <td><span className={STATUS_WARNA[o.fulfillment_status] || 'badge-slate'}>{o.fulfillment_status}</span></td>
                      <td className={`tabular font-semibold ${o.net_profit >= 0 ? 'text-emerald-600' : 'text-rose-600'}`}>{rupiah(o.net_profit)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <div className="card">
          <h2 className="card-title mb-3">Ekspedisi & Ongkir</h2>
          <div className="mb-3 grid grid-cols-2 gap-3">
            <StatCard label="Ongkir Ditagih Pembeli" value={rupiah(p.ongkir.ditagih)} tone="green" />
            <StatCard label="Ongkir Ditanggung" value={rupiah(p.ongkir.ditanggung)} tone="red" icon={Truck} />
          </div>
          {p.ekspedisi.length === 0 ? <EmptyState message="Belum ada data ekspedisi" /> : (
            <div className="table-wrap max-h-[180px] overflow-y-auto">
              <table className="table">
                <thead><tr><th>Ekspedisi</th><th>Order</th><th>Beban Ongkir</th></tr></thead>
                <tbody>
                  {p.ekspedisi.map((e) => (
                    <tr key={e.ekspedisi}>
                      <td className="font-medium text-slate-900">{e.ekspedisi}</td>
                      <td className="tabular">{e.orders}</td>
                      <td className="tabular text-amber-700">{rupiah(e.beban)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>

      <div className="card">
        <h2 className="card-title mb-3">Produk Penyumbang Laba Terbesar</h2>
        {p.produkTeratas.length === 0 ? <EmptyState message="Belum ada penjualan" /> : (
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>#</th><th>Produk</th><th>Terjual</th><th>Pendapatan</th><th>Laba Kotor</th></tr></thead>
              <tbody>
                {p.produkTeratas.map((x, i) => (
                  <tr key={x.sku}>
                    <td className="tabular text-slate-400">{i + 1}</td>
                    <td>
                      <p className="font-medium text-slate-900">{x.name}</p>
                      <p className="font-mono text-xs text-slate-400">{x.sku}</p>
                    </td>
                    <td className="tabular">{num(x.qty)} {x.unit}</td>
                    <td className="tabular">{rupiah(x.revenue)}</td>
                    <td className="tabular font-semibold text-emerald-600">{rupiah(x.profit)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

// ==================================================================
function TabPresensi({ p }) {
  const sebaran = [
    { name: 'WFO', value: p.hariIni.wfo },
    { name: 'WFH', value: p.hariIni.wfh },
    { name: 'Dinas Luar', value: p.hariIni.dinas },
  ].filter((x) => x.value > 0);

  return (
    <div className="grid gap-4">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard label="Hadir" value={`${p.hariIni.hadir}/${p.karyawanAktif}`} sub={`${p.hariIni.sudahPulang} sudah pulang`} icon={Users} tone="green" />
        <StatCard label="Terlambat" value={p.hariIni.telat} icon={Clock} tone={p.hariIni.telat ? 'red' : 'green'} />
        <StatCard label="Izin / Cuti" value={p.hariIni.izin} icon={Clock} tone="amber" />
        <StatCard label="Belum Absen" value={p.hariIni.belumAbsen} icon={AlertTriangle} tone={p.hariIni.belumAbsen ? 'amber' : 'green'} />
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <div className="card lg:col-span-2">
          <h2 className="card-title mb-3">Tren Kehadiran</h2>
          {p.tren.length === 0 ? <EmptyState message="Belum ada data presensi" /> : (
            <ResponsiveContainer width="100%" height={250}>
              <LineChart data={p.tren} margin={{ left: -20, right: 8 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" vertical={false} />
                <XAxis dataKey="date" tick={{ fontSize: 11 }} tickFormatter={(d) => d.slice(8)} />
                <YAxis tick={{ fontSize: 11 }} allowDecimals={false} width={40} />
                <Tooltip />
                <Legend wrapperStyle={{ fontSize: 11 }} />
                <Line name="Hadir" type="monotone" dataKey="hadir" stroke="#10b981" strokeWidth={2} dot={false} />
                <Line name="Terlambat" type="monotone" dataKey="telat" stroke="#ef4444" strokeWidth={2} dot={false} />
              </LineChart>
            </ResponsiveContainer>
          )}
        </div>

        <div className="card">
          <h2 className="card-title mb-3">Sebaran Kerja Hari Ini</h2>
          {sebaran.length === 0 ? <EmptyState message="Belum ada yang absen hari ini" /> : (
            <ResponsiveContainer width="100%" height={230}>
              <PieChart>
                <Pie data={sebaran} dataKey="value" nameKey="name" innerRadius={48} outerRadius={78} paddingAngle={2}>
                  {sebaran.map((_, i) => <Cell key={i} fill={CHART_COLORS[i % CHART_COLORS.length]} />)}
                </Pie>
                <Tooltip />
                <Legend wrapperStyle={{ fontSize: 11 }} />
              </PieChart>
            </ResponsiveContainer>
          )}
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <div className="card">
          <h2 className="card-title mb-3">Absensi Hari Ini</h2>
          {p.terbaru.length === 0 ? <EmptyState message="Belum ada yang absen hari ini" /> : (
            <div className="table-wrap">
              <table className="table">
                <thead><tr><th>Nama</th><th>Tipe</th><th>Masuk</th><th>Pulang</th><th>Status</th><th>Lokasi</th></tr></thead>
                <tbody>
                  {p.terbaru.map((a, i) => (
                    <tr key={i}>
                      <td>
                        <p className="font-medium text-slate-900">{a.name}</p>
                        <p className="text-xs text-slate-400">{a.position || '-'}</p>
                      </td>
                      <td className="text-xs">{WORK_TYPE_LABEL[a.work_type]}</td>
                      <td className="tabular">{timeID(a.check_in_at)}</td>
                      <td className="tabular">{timeID(a.check_out_at)}</td>
                      <td>
                        <span className={a.status === 'LATE' ? 'badge-red' : a.status === 'LEAVE' ? 'badge-amber' : 'badge-green'}>
                          {a.status === 'LATE' ? `Telat ${a.late_minutes}m` : a.status === 'LEAVE' ? 'Izin' : 'Tepat'}
                        </span>
                      </td>
                      <td className="text-xs">
                        {a.work_type === 'WFO'
                          ? <span className={a.in_inside_geofence ? 'text-emerald-600' : 'text-amber-600'}>{a.office_name || '-'} ({a.in_distance_m} m)</span>
                          : <span className="text-slate-500">{WORK_TYPE_LABEL[a.work_type]}</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <div className="card">
          <h2 className="card-title mb-3">Paling Sering Terlambat</h2>
          {p.seringTerlambat.length === 0 ? (
            <EmptyState message="Tidak ada yang sering terlambat" hint="Bagus — kedisiplinan terjaga pada periode ini" />
          ) : (
            <div className="table-wrap">
              <table className="table">
                <thead><tr><th>Nama</th><th>Telat</th><th>Hadir</th><th>Total Menit</th></tr></thead>
                <tbody>
                  {p.seringTerlambat.map((s) => (
                    <tr key={s.name}>
                      <td className="font-medium text-slate-900">{s.name}</td>
                      <td className="tabular font-semibold text-rose-600">{s.telat}×</td>
                      <td className="tabular">{s.hadir}</td>
                      <td className="tabular">{s.total_menit} m</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ==================================================================
function TabStok({ s }) {
  return (
    <div className="grid gap-4">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard label="Nilai Persediaan" value={rupiah(s.totalValue)} sub={`${s.skuCount} SKU • ${num(s.totalQty)} unit`} icon={Warehouse} />
        <StatCard label="Potensi Pendapatan" value={rupiahShort(s.potentialRevenue)} sub="bila semua terjual di harga base" tone="green" />
        <StatCard label="Perlu Restock" value={s.lowStockCount} sub={`${s.outOfStockCount} habis total`} icon={AlertTriangle} tone={s.lowStockCount ? 'amber' : 'green'} />
        <StatCard label="Akan Habis" value={s.akanHabis.length} sub="dalam 14 hari, berdasar laju jual" icon={Timer} tone={s.akanHabis.length ? 'red' : 'green'} />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <div className="card">
          <h2 className="card-title mb-3">Akan Habis — Berdasar Laju Penjualan</h2>
          {s.akanHabis.length === 0 ? (
            <EmptyState message="Tidak ada produk yang akan habis" hint="Dihitung dari rata-rata penjualan 30 hari terakhir" />
          ) : (
            <div className="table-wrap max-h-[300px] overflow-y-auto">
              <table className="table">
                <thead><tr><th>Produk</th><th>Stok</th><th>Laju/Hari</th><th>Habis Dalam</th></tr></thead>
                <tbody>
                  {s.akanHabis.map((p) => (
                    <tr key={p.id}>
                      <td>
                        <p className="font-medium text-slate-900">{p.name}</p>
                        <p className="font-mono text-xs text-slate-400">{p.sku}</p>
                      </td>
                      <td className="tabular">{num(p.stock)} {p.unit}</td>
                      <td className="tabular text-slate-500">{num(p.lajuHarian, 1)}</td>
                      <td className={`tabular font-bold ${p.sisaHari <= 7 ? 'text-rose-600' : 'text-amber-600'}`}>
                        {p.sisaHari} hari
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <div className="card">
          <h2 className="card-title mb-3">Modal Mengendap — Tidak Laku 60 Hari</h2>
          {s.stokMati.length === 0 ? (
            <EmptyState message="Tidak ada stok yang mengendap" hint="Semua produk bernilai masih berputar" />
          ) : (
            <div className="table-wrap max-h-[300px] overflow-y-auto">
              <table className="table">
                <thead><tr><th>Produk</th><th>Stok</th><th>Nilai</th><th>Terakhir Laku</th></tr></thead>
                <tbody>
                  {s.stokMati.map((p) => (
                    <tr key={p.id}>
                      <td>
                        <p className="font-medium text-slate-900">{p.name}</p>
                        <p className="font-mono text-xs text-slate-400">{p.sku}</p>
                      </td>
                      <td className="tabular">{num(p.stock)} {p.unit}</td>
                      <td className="tabular font-semibold text-amber-700">{rupiah(p.nilai)}</td>
                      <td className="text-xs text-slate-500">
                        {p.terakhir_terjual ? dateID(p.terakhir_terjual) : 'belum pernah'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <div className="card">
          <h2 className="card-title mb-3">Nilai Persediaan per Kategori</h2>
          {s.nilaiPerKategori.length === 0 ? <EmptyState message="Belum ada produk" /> : (
            <ResponsiveContainer width="100%" height={240}>
              <BarChart data={s.nilaiPerKategori} margin={{ left: -16, right: 8 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" vertical={false} />
                <XAxis dataKey="category" tick={{ fontSize: 11 }} />
                <YAxis tick={{ fontSize: 11 }} tickFormatter={rupiahShort} width={76} />
                <Tooltip formatter={(v) => rupiah(v)} />
                <Bar dataKey="value" radius={[6, 6, 0, 0]}>
                  {s.nilaiPerKategori.map((_, i) => <Cell key={i} fill={CHART_COLORS[i % CHART_COLORS.length]} />)}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          )}
        </div>

        <div className="card">
          <h2 className="card-title mb-3">Mutasi Stok Terbaru</h2>
          {s.mutasiTerbaru.length === 0 ? <EmptyState message="Belum ada mutasi" /> : (
            <div className="table-wrap max-h-[260px] overflow-y-auto">
              <table className="table">
                <thead><tr><th>Tanggal</th><th>Produk</th><th>Qty</th><th>Saldo</th></tr></thead>
                <tbody>
                  {s.mutasiTerbaru.map((m, i) => (
                    <tr key={i}>
                      <td className="tabular text-xs">{dateID(m.move_date)}</td>
                      <td>
                        <p className="font-medium text-slate-900">{m.product_name}</p>
                        <p className="font-mono text-xs text-slate-400">{m.sku}</p>
                      </td>
                      <td className={`tabular font-semibold ${m.move_type === 'OUT' ? 'text-rose-600' : 'text-emerald-600'}`}>
                        {m.move_type === 'OUT' ? '−' : '+'}{num(m.qty)}
                      </td>
                      <td className="tabular">{num(m.balance_after)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ==================================================================
function TabKeuangan({ k }) {
  const arusKas = [
    { name: 'Operasi', value: k.ocf },
    { name: 'Investasi', value: k.icf },
    { name: 'Pendanaan', value: k.fcf },
  ];

  return (
    <div className="grid gap-4">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard label="Saldo Kas" value={rupiah(k.closingCash)} sub={`Perubahan ${k.netCashChange >= 0 ? '+' : ''}${rupiahShort(k.netCashChange)}`} icon={Wallet} tone={k.closingCash >= 0 ? 'brand' : 'red'} />
        <StatCard label="Piutang" value={rupiah(k.receivable)} icon={Timer} tone="amber" />
        <StatCard label="Total Aset" value={rupiahShort(k.totalAssets)} sub={k.balanced ? 'Neraca seimbang ✓' : 'Tidak seimbang'} icon={Scale} tone={k.balanced ? 'green' : 'red'} />
        <StatCard label="Laba Bersih" value={rupiahShort(k.netProfit)} sub={`Margin ${pct(k.netMarginPct)}`} icon={TrendingUp} tone={k.netProfit >= 0 ? 'green' : 'red'} />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <div className="card">
          <h2 className="card-title mb-3">Arus Kas (OCF / ICF / FCF)</h2>
          <ResponsiveContainer width="100%" height={240}>
            <BarChart data={arusKas} margin={{ left: -16, right: 8 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" vertical={false} />
              <XAxis dataKey="name" tick={{ fontSize: 11 }} />
              <YAxis tick={{ fontSize: 11 }} tickFormatter={rupiahShort} width={76} />
              <Tooltip formatter={(v) => rupiah(v)} />
              <Bar dataKey="value" radius={[6, 6, 0, 0]}>
                {arusKas.map((d, i) => <Cell key={i} fill={d.value >= 0 ? '#10b981' : '#ef4444'} />)}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>

        <div className="card">
          <h2 className="card-title mb-3">Ringkasan Laba Rugi</h2>
          <dl className="space-y-2 text-sm">
            {[
              ['Penjualan Bersih', k.netSales, false],
              ['Laba Kotor', k.grossProfit, true],
              ['Beban Operasional', -k.opex, false],
              ['Laba Bersih', k.netProfit, true],
            ].map(([label, nilai, tebal]) => (
              <div key={label} className={`flex justify-between border-b border-slate-100 py-1.5 ${tebal ? 'font-bold text-slate-900' : 'text-slate-600'}`}>
                <dt>{label}</dt>
                <dd className="tabular">{rupiah(nilai)}</dd>
              </div>
            ))}
          </dl>
          <div className="mt-3 grid grid-cols-3 gap-2 text-center text-xs">
            {[
              ['Kas', k.cash], ['Persediaan', k.inventoryValue], ['Ekuitas', k.totalEquity],
            ].map(([l, v]) => (
              <div key={l} className="rounded-xl bg-slate-50 p-2.5">
                <p className="text-slate-500">{l}</p>
                <p className="tabular mt-0.5 font-bold text-slate-900">{rupiahShort(v)}</p>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
