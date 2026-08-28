import { useEffect, useState, useCallback } from 'react';
import { Plus, Trash2, Eye, BookOpenCheck, FileSpreadsheet, Scale } from 'lucide-react';
import { api } from '../lib/api';
import { PageHeader, Spinner, EmptyState, Modal, DateRangeFilter, defaultRange, useToast, Field, StatCard, TombolEkspor } from '../components/ui';
import { rupiah, today, dateID } from '../lib/format';
import { useAuth } from '../lib/auth';

const emptyEntry = () => ({
  entry_date: today(),
  description: '',
  lines: [
    { account_id: '', debit: '', credit: '', memo: '' },
    { account_id: '', debit: '', credit: '', memo: '' },
  ],
});

export default function Jurnal() {
  const toast = useToast();
  const { canManage, isAdmin } = useAuth();
  const [tab, setTab] = useState('journals');
  const [range, setRange] = useState(defaultRange);
  const [rows, setRows] = useState([]);
  const [accounts, setAccounts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [form, setForm] = useState(null);
  const [detail, setDetail] = useState(null);

  // Buku besar
  const [accountId, setAccountId] = useState('');
  const [ledger, setLedger] = useState(null);

  const loadJournals = useCallback(async () => {
    setLoading(true);
    try {
      const d = await api.get('/api/finance/journals', range);
      setRows(d.rows);
    } catch (err) {
      toast.error(err.message);
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [range]);

  useEffect(() => { if (tab === 'journals') loadJournals(); }, [tab, loadJournals]);

  useEffect(() => {
    api.get('/api/finance/accounts').then((d) => setAccounts(d.accounts)).catch(() => {});
  }, []);

  const loadLedger = useCallback(async () => {
    if (!accountId) return setLedger(null);
    try {
      setLedger(await api.get(`/api/finance/reports/ledger/${accountId}`, range));
    } catch (err) {
      toast.error(err.message);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accountId, range]);

  useEffect(() => { if (tab === 'ledger') loadLedger(); }, [tab, loadLedger]);

  // ---------- Jurnal manual ----------
  const totalDebit = form?.lines.reduce((s, l) => s + (Number(l.debit) || 0), 0) || 0;
  const totalCredit = form?.lines.reduce((s, l) => s + (Number(l.credit) || 0), 0) || 0;
  const balanced = Math.abs(totalDebit - totalCredit) < 0.01 && totalDebit > 0;

  function setLine(i, patch) {
    const lines = [...form.lines];
    lines[i] = { ...lines[i], ...patch };
    // Satu baris hanya boleh debit ATAU kredit
    if (patch.debit) lines[i].credit = '';
    if (patch.credit) lines[i].debit = '';
    setForm({ ...form, lines });
  }

  async function submit(e) {
    e.preventDefault();
    if (!balanced) return toast.error('Total debit harus sama dengan total kredit dan lebih dari nol');
    try {
      const res = await api.post('/api/finance/journals', {
        entry_date: form.entry_date,
        description: form.description,
        lines: form.lines
          .filter((l) => l.account_id && (Number(l.debit) > 0 || Number(l.credit) > 0))
          .map((l) => ({
            account_id: Number(l.account_id),
            debit: Number(l.debit) || 0,
            credit: Number(l.credit) || 0,
            memo: l.memo || null,
          })),
      });
      toast.success(res.message);
      setForm(null);
      loadJournals();
    } catch (err) {
      toast.error(err.message);
    }
  }

  async function removeJournal(j) {
    if (!window.confirm(`Hapus jurnal ${j.entry_no}?`)) return;
    try {
      const res = await api.del(`/api/finance/journals/${j.id}`);
      toast.success(res.message);
      loadJournals();
    } catch (err) {
      toast.error(err.message);
    }
  }

  return (
    <div>
      <PageHeader title="Buku Besar & Jurnal" subtitle="Setiap transaksi dicatat berpasangan — Debit = Kredit">
        {canManage && tab === 'journals' && (
          <button className="btn-primary" onClick={() => setForm(emptyEntry())}>
            <Plus size={16} /> Jurnal Manual
          </button>
        )}
        {tab === 'ledger' && ledger && (
          <button
            className="btn-secondary"
            onClick={() => api.download(`/api/finance/ledger/${accountId}/export/excel`, range, 'buku-besar.xlsx').catch((e) => toast.error(e.message))}
          >
            <FileSpreadsheet size={16} /> Excel
          </button>
        )}
        <TombolEkspor path="/api/finance/journals" params={range} nama="buku-besar-jurnal" />
      </PageHeader>

      <div className="mb-4 flex gap-1.5 rounded-xl bg-surface p-1.5 shadow-sm ring-1 ring-slate-200/70">
        {[
          { key: 'journals', label: 'Jurnal Umum', icon: BookOpenCheck },
          { key: 'ledger', label: 'Buku Besar per Akun', icon: Scale },
        ].map((t) => (
          <button
            key={t.key} onClick={() => setTab(t.key)}
            className={`flex flex-1 items-center justify-center gap-2 rounded-lg px-3 py-2 text-sm font-semibold transition ${
              tab === t.key ? 'bg-brand-600 text-white' : 'text-slate-600 hover:bg-slate-100'
            }`}
          >
            <t.icon size={16} /> {t.label}
          </button>
        ))}
      </div>

      <DateRangeFilter range={range} onChange={setRange}>
        {tab === 'ledger' && (
          <div className="flex-[2]">
            <label className="label">Akun</label>
            <select className="input" value={accountId} onChange={(e) => setAccountId(e.target.value)}>
              <option value="">— pilih akun —</option>
              {accounts.map((a) => <option key={a.id} value={a.id}>{a.code} — {a.name}</option>)}
            </select>
          </div>
        )}
      </DateRangeFilter>

      {tab === 'journals' ? (
        loading ? (
          <Spinner />
        ) : (
          <div className="card">
            {rows.length === 0 ? (
              <EmptyState message="Belum ada jurnal pada rentang ini" hint="Transaksi penjualan & stok membuat jurnal otomatis" />
            ) : (
              <div className="table-wrap">
                <table className="table">
                  <thead>
                    <tr><th>No. Jurnal</th><th>Tanggal</th><th>Keterangan</th><th>Sumber</th><th>Debit</th><th>Kredit</th><th>Dibuat</th><th></th></tr>
                  </thead>
                  <tbody>
                    {rows.map((j) => (
                      <tr key={j.id}>
                        <td className="font-mono text-xs">{j.entry_no}</td>
                        <td className="tabular">{dateID(j.entry_date)}</td>
                        <td className="max-w-[280px] truncate font-medium text-slate-900">{j.description}</td>
                        <td><span className={j.source === 'MANUAL' ? 'badge-slate' : 'badge-blue'}>{j.source}</span></td>
                        <td className="tabular">{rupiah(j.total_debit)}</td>
                        <td className="tabular">{rupiah(j.total_credit)}</td>
                        <td className="text-xs text-slate-500">{j.user_name || '-'}</td>
                        <td>
                          <div className="flex gap-1">
                            <button
                              className="btn-ghost !px-2 !py-1"
                              onClick={() => api.get(`/api/finance/journals/${j.id}`).then(setDetail).catch((e) => toast.error(e.message))}
                              aria-label="Detail"
                            >
                              <Eye size={14} />
                            </button>
                            {isAdmin && j.source === 'MANUAL' && (
                              <button className="btn-ghost !px-2 !py-1 text-rose-600" onClick={() => removeJournal(j)} aria-label="Hapus">
                                <Trash2 size={14} />
                              </button>
                            )}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )
      ) : !ledger ? (
        <div className="card"><EmptyState message="Pilih akun untuk melihat buku besarnya" /></div>
      ) : (
        <>
          <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
            <StatCard label="Saldo Awal" value={rupiah(ledger.opening)} />
            <StatCard label="Total Debit" value={rupiah(ledger.totalDebit)} tone="brand" />
            <StatCard label="Total Kredit" value={rupiah(ledger.totalCredit)} tone="amber" />
            <StatCard label="Saldo Akhir" value={rupiah(ledger.closing)} tone="green" />
          </div>

          <div className="card">
            <h2 className="mb-3 font-bold text-slate-900">
              {ledger.account.code} — {ledger.account.name}
              <span className="ml-2 text-xs font-normal text-slate-500">
                (saldo normal {ledger.account.normal === 'D' ? 'Debit' : 'Kredit'})
              </span>
            </h2>
            {ledger.entries.length === 0 ? (
              <EmptyState message="Tidak ada mutasi pada rentang ini" />
            ) : (
              <div className="table-wrap">
                <table className="table">
                  <thead><tr><th>Tanggal</th><th>No. Jurnal</th><th>Keterangan</th><th>Debit</th><th>Kredit</th><th>Saldo</th></tr></thead>
                  <tbody>
                    <tr className="bg-slate-50">
                      <td colSpan={5} className="px-3 py-2 font-semibold">Saldo Awal</td>
                      <td className="tabular px-3 py-2 font-semibold">{rupiah(ledger.opening)}</td>
                    </tr>
                    {ledger.entries.map((e, i) => (
                      <tr key={i}>
                        <td className="tabular">{dateID(e.entry_date)}</td>
                        <td className="font-mono text-xs">{e.entry_no}</td>
                        <td className="max-w-[300px] truncate">{e.memo || e.description}</td>
                        <td className="tabular">{e.debit ? rupiah(e.debit) : '-'}</td>
                        <td className="tabular">{e.credit ? rupiah(e.credit) : '-'}</td>
                        <td className="tabular font-semibold">{rupiah(e.balance)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </>
      )}

      {/* ---------- FORM JURNAL MANUAL ---------- */}
      <Modal open={!!form} onClose={() => setForm(null)} title="Jurnal Manual" wide>
        {form && (
          <form onSubmit={submit}>
            <div className="mb-4 grid gap-3 sm:grid-cols-3">
              <Field label="Tanggal *">
                <input type="date" className="input" required value={form.entry_date} onChange={(e) => setForm({ ...form, entry_date: e.target.value })} />
              </Field>
              <Field label="Keterangan *" className="sm:col-span-2">
                <input className="input" required placeholder="mis. Pembayaran sewa gudang bulan Agustus" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
              </Field>
            </div>

            <div className="mb-2 flex items-center justify-between">
              <p className="label !mb-0">Baris Jurnal</p>
              <button
                type="button" className="btn-ghost !py-1 text-xs"
                onClick={() => setForm({ ...form, lines: [...form.lines, { account_id: '', debit: '', credit: '', memo: '' }] })}
              >
                <Plus size={14} /> Tambah Baris
              </button>
            </div>

            <div className="mb-3 space-y-2">
              {form.lines.map((l, i) => (
                <div key={i} className="grid grid-cols-12 items-end gap-2 rounded-xl bg-slate-50 p-2.5">
                  <div className="col-span-12 sm:col-span-5">
                    <label className="label">Akun</label>
                    <select className="input !py-2" value={l.account_id} onChange={(e) => setLine(i, { account_id: e.target.value })}>
                      <option value="">— pilih akun —</option>
                      {accounts.filter((a) => a.active).map((a) => (
                        <option key={a.id} value={a.id}>{a.code} — {a.name}</option>
                      ))}
                    </select>
                  </div>
                  <div className="col-span-5 sm:col-span-3">
                    <label className="label">Debit</label>
                    <input type="number" min="0" step="any" className="input !py-2" value={l.debit} onChange={(e) => setLine(i, { debit: e.target.value })} />
                  </div>
                  <div className="col-span-5 sm:col-span-3">
                    <label className="label">Kredit</label>
                    <input type="number" min="0" step="any" className="input !py-2" value={l.credit} onChange={(e) => setLine(i, { credit: e.target.value })} />
                  </div>
                  <div className="col-span-2 sm:col-span-1">
                    {form.lines.length > 2 && (
                      <button
                        type="button" className="btn-ghost !px-2 !py-2 text-rose-600"
                        onClick={() => setForm({ ...form, lines: form.lines.filter((_, x) => x !== i) })}
                        aria-label="Hapus baris"
                      >
                        <Trash2 size={14} />
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>

            <div className={`mb-4 flex items-center justify-between rounded-xl px-4 py-3 text-sm font-semibold ${
              balanced ? 'bg-emerald-50 text-emerald-800' : 'bg-amber-50 text-amber-800'
            }`}>
              <span>{balanced ? 'Jurnal seimbang ✓' : 'Debit dan Kredit belum sama'}</span>
              <span className="tabular">
                D {rupiah(totalDebit)} &nbsp;|&nbsp; K {rupiah(totalCredit)}
                {!balanced && ` (selisih ${rupiah(Math.abs(totalDebit - totalCredit))})`}
              </span>
            </div>

            <div className="flex gap-2">
              <button type="button" className="btn-secondary flex-1" onClick={() => setForm(null)}>Batal</button>
              <button type="submit" className="btn-primary flex-1" disabled={!balanced}>Posting Jurnal</button>
            </div>
          </form>
        )}
      </Modal>

      {/* ---------- DETAIL JURNAL ---------- */}
      <Modal open={!!detail} onClose={() => setDetail(null)} title={detail?.journal.entry_no || ''} wide>
        {detail && (
          <div>
            <p className="mb-3 text-sm text-slate-600">
              <span className="font-semibold">{dateID(detail.journal.entry_date)}</span> — {detail.journal.description}
            </p>
            <div className="table-wrap">
              <table className="table">
                <thead><tr><th>Kode</th><th>Akun</th><th>Memo</th><th>Debit</th><th>Kredit</th></tr></thead>
                <tbody>
                  {detail.lines.map((l) => (
                    <tr key={l.id}>
                      <td className="font-mono text-xs">{l.code}</td>
                      <td className="font-medium text-slate-900">{l.account_name}</td>
                      <td className="text-xs text-slate-500">{l.memo || '-'}</td>
                      <td className="tabular">{l.debit ? rupiah(l.debit) : '-'}</td>
                      <td className="tabular">{l.credit ? rupiah(l.credit) : '-'}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="border-t-2 border-slate-200 bg-slate-50 font-bold">
                    <td colSpan={3} className="px-3 py-2.5 text-right">TOTAL</td>
                    <td className="tabular px-3 py-2.5">{rupiah(detail.lines.reduce((s, l) => s + l.debit, 0))}</td>
                    <td className="tabular px-3 py-2.5">{rupiah(detail.lines.reduce((s, l) => s + l.credit, 0))}</td>
                  </tr>
                </tfoot>
              </table>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}
