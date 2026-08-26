import { useEffect, useState, useCallback } from 'react';
import { FileText, FileSpreadsheet, Scale, TrendingUp, Wallet, CheckCircle2, AlertTriangle } from 'lucide-react';
import { api } from '../lib/api';
import { PageHeader, StatCard, Spinner, DateRangeFilter, defaultRange, useToast } from '../components/ui';
import { rupiah, pct } from '../lib/format';

const TABS = [
  { key: 'income-statement', label: 'Laba Rugi', icon: TrendingUp },
  { key: 'balance-sheet', label: 'Neraca', icon: Scale },
  { key: 'cash-flow', label: 'Arus Kas', icon: Wallet },
  { key: 'trial-balance', label: 'Neraca Saldo', icon: CheckCircle2 },
];

export default function LaporanKeuangan() {
  const toast = useToast();
  const [tab, setTab] = useState('income-statement');
  const [range, setRange] = useState(defaultRange);
  // Data disimpan bersama nama laporan asalnya.
  //
  // Mengganti tab mengubah pilihan seketika, sementara permintaan datanya baru
  // berjalan setelah render berikutnya. Tanpa penanda ini, sekali render terjadi
  // dengan tab "Neraca" tetapi isi data masih Laba Rugi — dan halaman langsung
  // kosong karena mencari kolom yang tidak ada di sana.
  const [hasil, setHasil] = useState({ tab: null, data: null });
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = tab === 'balance-sheet' ? { asOf: range.to } : range;
      const d = await api.get(`/api/finance/reports/${tab}`, params);
      setHasil({ tab, data: d });
    } catch (err) {
      toast.error(err.message);
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, range]);

  useEffect(() => { load(); }, [load]);

  async function download(format) {
    try {
      await api.download(
        `/api/finance/reports/${tab}/export/${format}`,
        tab === 'balance-sheet' ? { asOf: range.to } : range,
        `laporan.${format === 'excel' ? 'xlsx' : 'pdf'}`
      );
      toast.success(`Laporan ${format.toUpperCase()} berhasil diunduh`);
    } catch (err) {
      toast.error(err.message);
    }
  }

  return (
    <div>
      <PageHeader title="Laporan Keuangan" subtitle="Dual-entry accounting — Laba Rugi, Neraca, Arus Kas, dan Neraca Saldo">
        <button className="btn-secondary" onClick={() => download('excel')}><FileSpreadsheet size={16} /> Excel</button>
        <button className="btn-secondary" onClick={() => download('pdf')}><FileText size={16} /> PDF</button>
      </PageHeader>

      <div className="mb-4 flex gap-1.5 overflow-x-auto rounded-xl bg-white p-1.5 shadow-sm ring-1 ring-slate-200/70">
        {TABS.map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`flex shrink-0 items-center gap-2 rounded-lg px-3.5 py-2 text-sm font-semibold transition ${
              tab === t.key ? 'bg-brand-600 text-white' : 'text-slate-600 hover:bg-slate-100'
            }`}
          >
            <t.icon size={16} /> {t.label}
          </button>
        ))}
      </div>

      <DateRangeFilter range={range} onChange={setRange}>
        {tab === 'balance-sheet' && (
          <p className="pb-2 text-xs text-slate-400 sm:w-56">
            Neraca dihitung per tanggal akhir ({range.to}).
          </p>
        )}
      </DateRangeFilter>

      {loading || hasil.tab !== tab || !hasil.data ? (
        <Spinner />
      ) : tab === 'income-statement' ? (
        <IncomeStatement rep={hasil.data} />
      ) : tab === 'balance-sheet' ? (
        <BalanceSheet rep={hasil.data} />
      ) : tab === 'cash-flow' ? (
        <CashFlow rep={hasil.data} />
      ) : (
        <TrialBalance rep={hasil.data} />
      )}
    </div>
  );
}

// ------------------------------------------------------------------
function Line({ label, value, bold, indent, tone, big }) {
  return (
    <div
      className={`flex items-center justify-between gap-4 py-2 ${
        bold ? 'border-t border-slate-200 font-bold text-slate-900' : 'text-slate-600'
      } ${big ? 'text-base' : 'text-sm'}`}
    >
      <span className={indent ? 'pl-4' : ''}>{label}</span>
      <span
        className={`tabular ${
          tone === 'green' ? 'text-emerald-600' : tone === 'red' ? 'text-rose-600' : ''
        }`}
      >
        {typeof value === 'number' ? rupiah(value) : value}
      </span>
    </div>
  );
}

function Section({ title }) {
  return <p className="mt-4 mb-1 text-xs font-bold uppercase tracking-wider text-slate-400">{title}</p>;
}

function IncomeStatement({ rep }) {
  return (
    <>
      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard label="Penjualan Bersih" value={rupiah(rep.netSales)} sub={`Kotor ${rupiah(rep.grossSales)}`} />
        <StatCard label="Laba Kotor" value={rupiah(rep.grossProfit)} sub={`Margin ${pct(rep.grossMarginPct)}`} tone="brand" />
        <StatCard label="Beban Operasional" value={rupiah(rep.opex)} tone="amber" />
        <StatCard label="Laba Bersih" value={rupiah(rep.netProfit)} sub={`Margin ${pct(rep.netMarginPct)}`} tone={rep.netProfit >= 0 ? 'green' : 'red'} />
      </div>

      <div className="card mx-auto max-w-3xl">
        <h2 className="mb-1 text-center text-lg font-bold text-slate-900">LAPORAN LABA RUGI</h2>
        <p className="mb-4 text-center text-xs text-slate-500">Periode {rep.period.from} s/d {rep.period.to}</p>

        <Section title="Pendapatan" />
        <Line label="Penjualan Kotor" value={rep.grossSales} indent />
        <Line label="Retur Penjualan" value={-rep.salesReturn} indent tone="red" />
        <Line label="Diskon Penjualan" value={-rep.salesDiscount} indent tone="red" />
        <Line label="Penjualan Bersih" value={rep.netSales} bold />

        <Section title="Harga Pokok" />
        <Line label="Harga Pokok Penjualan (HPP)" value={-rep.cogs} indent tone="red" />
        <Line label="LABA KOTOR" value={rep.grossProfit} bold big />

        <Section title="Beban Operasional" />
        {rep.sellingRows.map((r) => <Line key={r.code} label={`${r.code} · ${r.name}`} value={-r.amount} indent tone="red" />)}
        {rep.adminRows.map((r) => <Line key={r.code} label={`${r.code} · ${r.name}`} value={-r.amount} indent tone="red" />)}
        {rep.opex === 0 && <Line label="Belum ada beban operasional tercatat" value="" indent />}
        <Line label="Total Beban Operasional" value={-rep.opex} bold />
        <Line label="LABA USAHA" value={rep.operatingProfit} bold big />

        {(rep.otherIncome > 0 || rep.otherExpenseRows.length > 0) && (
          <>
            <Section title="Pendapatan & Beban Lain" />
            {/* Dirinci per akun, bukan satu angka gabungan: selisih stok opname
                yang menguntungkan perlu terlihat sumbernya agar bisa ditelusuri. */}
            {(rep.otherIncomeRows || []).map((r) => (
              <Line key={r.code} label={`${r.code} · ${r.name}`} value={r.amount} indent tone="green" />
            ))}
            {rep.otherExpenseRows.map((r) => <Line key={r.code} label={`${r.code} · ${r.name}`} value={-r.amount} indent tone="red" />)}
          </>
        )}

        <div className="mt-4 flex items-center justify-between rounded-xl bg-slate-900 px-4 py-3.5 text-white">
          <span className="font-bold">LABA BERSIH</span>
          <span className={`tabular text-lg font-bold ${rep.netProfit >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
            {rupiah(rep.netProfit)} <span className="text-sm">({pct(rep.netMarginPct)})</span>
          </span>
        </div>
      </div>
    </>
  );
}

function BalanceSheet({ rep }) {
  return (
    <>
      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard label="Total Aset" value={rupiah(rep.assets.total)} />
        <StatCard label="Total Kewajiban" value={rupiah(rep.liabilities.total)} tone="amber" />
        <StatCard label="Total Ekuitas" value={rupiah(rep.equity.total)} tone="brand" />
        <StatCard
          label="Keseimbangan"
          value={rep.balanced ? 'Seimbang' : 'Tidak Seimbang'}
          sub={rep.balanced ? 'Aset = Kewajiban + Ekuitas' : 'Periksa jurnal manual'}
          icon={rep.balanced ? CheckCircle2 : AlertTriangle}
          tone={rep.balanced ? 'green' : 'red'}
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <div className="card">
          <h2 className="mb-3 text-center font-bold text-slate-900">ASET</h2>
          <Section title="Aset Lancar" />
          {[...rep.assets.current.cash, ...rep.assets.current.receivable, ...rep.assets.current.inventory, ...rep.assets.current.other]
            .map((r) => <Line key={r.code} label={`${r.code} · ${r.name}`} value={r.amount} indent />)}
          <Line label="Total Aset Lancar" value={rep.assets.current.total} bold />

          <Section title="Aset Tetap" />
          {rep.assets.fixed.items.map((r) => <Line key={r.code} label={`${r.code} · ${r.name}`} value={r.amount} indent />)}
          <Line label="Akumulasi Penyusutan" value={-rep.assets.fixed.accumulatedDepreciation} indent tone="red" />
          <Line label="Total Aset Tetap (Neto)" value={rep.assets.fixed.net} bold />

          <div className="mt-3 flex items-center justify-between rounded-xl bg-brand-600 px-4 py-3 font-bold text-white">
            <span>TOTAL ASET</span>
            <span className="tabular">{rupiah(rep.assets.total)}</span>
          </div>
        </div>

        <div className="card">
          <h2 className="mb-3 text-center font-bold text-slate-900">KEWAJIBAN & EKUITAS</h2>
          <Section title="Kewajiban" />
          {[...rep.liabilities.current, ...rep.liabilities.longTerm].map((r) => (
            <Line key={r.code} label={`${r.code} · ${r.name}`} value={r.amount} indent />
          ))}
          {rep.liabilities.total === 0 && <Line label="Tidak ada kewajiban tercatat" value="" indent />}
          <Line label="Total Kewajiban" value={rep.liabilities.total} bold />

          <Section title="Ekuitas" />
          <Line label="Modal Pemilik" value={rep.equity.capital} indent />
          <Line label="Prive (Penarikan)" value={-rep.equity.drawing} indent tone="red" />
          <Line label="Laba Ditahan" value={rep.equity.retained} indent />
          <Line label="Laba Berjalan" value={rep.equity.currentEarnings} indent tone={rep.equity.currentEarnings >= 0 ? 'green' : 'red'} />
          <Line label="Total Ekuitas" value={rep.equity.total} bold />

          <div className="mt-3 flex items-center justify-between rounded-xl bg-slate-900 px-4 py-3 font-bold text-white">
            <span>TOTAL KEWAJIBAN + EKUITAS</span>
            <span className="tabular">{rupiah(rep.totalLiabilitiesAndEquity)}</span>
          </div>
        </div>
      </div>
    </>
  );
}

function CashFlow({ rep }) {
  const blocks = [
    { title: 'ARUS KAS DARI AKTIVITAS OPERASI (OCF)', block: rep.operating, hint: 'Penjualan, pembelian stok, biaya operasional' },
    { title: 'ARUS KAS DARI AKTIVITAS INVESTASI (ICF)', block: rep.investing, hint: 'Pembelian/penjualan aset tetap' },
    { title: 'ARUS KAS DARI AKTIVITAS PENDANAAN (FCF)', block: rep.financing, hint: 'Setoran modal, prive, pinjaman' },
  ];

  return (
    <>
      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard label="Operasi (OCF)" value={rupiah(rep.operating.total)} tone={rep.operating.total >= 0 ? 'green' : 'red'} />
        <StatCard label="Investasi (ICF)" value={rupiah(rep.investing.total)} tone={rep.investing.total >= 0 ? 'green' : 'red'} />
        <StatCard label="Pendanaan (FCF)" value={rupiah(rep.financing.total)} tone={rep.financing.total >= 0 ? 'green' : 'red'} />
        <StatCard label="Kas Akhir" value={rupiah(rep.closingCash)} sub={`Awal ${rupiah(rep.openingCash)}`} tone="brand" />
      </div>

      <div className="card mx-auto max-w-3xl">
        <h2 className="mb-1 text-center text-lg font-bold text-slate-900">LAPORAN ARUS KAS</h2>
        <p className="mb-4 text-center text-xs text-slate-500">Periode {rep.period.from} s/d {rep.period.to}</p>

        {blocks.map(({ title, block, hint }) => (
          <div key={title} className="mb-4">
            <p className="text-xs font-bold uppercase tracking-wider text-slate-500">{title}</p>
            <p className="mb-1 text-[11px] text-slate-400">{hint}</p>
            {block.items.length === 0 ? (
              <Line label="Tidak ada mutasi kas" value="" indent />
            ) : (
              block.items.map((i) => (
                <Line key={i.label} label={i.label} value={i.amount} indent tone={i.amount >= 0 ? 'green' : 'red'} />
              ))
            )}
            <Line label={`Total ${title.match(/\((\w+)\)/)?.[1] || ''}`} value={block.total} bold />
          </div>
        ))}

        <Line label="KENAIKAN (PENURUNAN) KAS BERSIH" value={rep.netChange} bold big />
        <Line label="Kas Awal Periode" value={rep.openingCash} indent />
        <div className="mt-3 flex items-center justify-between rounded-xl bg-slate-900 px-4 py-3.5 font-bold text-white">
          <span>KAS AKHIR PERIODE</span>
          <span className="tabular text-lg">{rupiah(rep.closingCash)}</span>
        </div>
      </div>
    </>
  );
}

function TrialBalance({ rep }) {
  return (
    <div className="card">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-bold text-slate-900">Neraca Saldo (Trial Balance)</h2>
        <span className={rep.balanced ? 'badge-green' : 'badge-red'}>
          {rep.balanced ? 'Debit = Kredit ✓' : 'TIDAK SEIMBANG'}
        </span>
      </div>

      <div className="table-wrap">
        <table className="table">
          <thead><tr><th>Kode</th><th>Nama Akun</th><th>Tipe</th><th>Debit</th><th>Kredit</th><th>Saldo</th></tr></thead>
          <tbody>
            {rep.rows.map((r) => (
              <tr key={r.id}>
                <td className="font-mono text-xs">{r.code}</td>
                <td className="font-medium text-slate-900">{r.name}</td>
                <td className="text-xs text-slate-500">{r.type}</td>
                <td className="tabular">{rupiah(r.debit)}</td>
                <td className="tabular">{rupiah(r.credit)}</td>
                <td className="tabular font-semibold">{rupiah(r.balance)}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="border-t-2 border-slate-200 bg-slate-50 font-bold">
              <td colSpan={3} className="px-3 py-3 text-right">TOTAL</td>
              <td className="tabular px-3 py-3">{rupiah(rep.totalDebit)}</td>
              <td className="tabular px-3 py-3">{rupiah(rep.totalCredit)}</td>
              <td />
            </tr>
          </tfoot>
        </table>
      </div>
    </div>
  );
}
