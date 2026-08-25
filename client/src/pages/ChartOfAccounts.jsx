import { useEffect, useState, useCallback } from 'react';
import { Plus, Pencil, Trash2, Lock } from 'lucide-react';
import { api } from '../lib/api';
import { PageHeader, Spinner, EmptyState, Modal, useToast, Field } from '../components/ui';
import { rupiah } from '../lib/format';
import { useAuth } from '../lib/auth';

const TYPE_LABEL = {
  ASSET: 'Aset', LIABILITY: 'Kewajiban', EQUITY: 'Ekuitas',
  REVENUE: 'Pendapatan', EXPENSE: 'Beban',
};
const TYPE_BADGE = {
  ASSET: 'badge-blue', LIABILITY: 'badge-amber', EQUITY: 'badge-slate',
  REVENUE: 'badge-green', EXPENSE: 'badge-red',
};
const CASHFLOW_LABEL = {
  OCF: 'Operasi', ICF: 'Investasi', FCF: 'Pendanaan', NONE: 'Non-kas',
};
const SUBTYPES = [
  'CASH', 'RECEIVABLE', 'INVENTORY', 'OTHER_CURRENT', 'FIXED_ASSET', 'ACC_DEPRECIATION',
  'PAYABLE', 'ACCRUED', 'TAX', 'LOAN',
  'CAPITAL', 'DRAWING', 'RETAINED',
  'SALES', 'SALES_RETURN', 'SALES_DISCOUNT', 'OTHER_INCOME',
  'COGS', 'SELLING', 'ADMIN', 'DEPRECIATION', 'FINANCE', 'OTHER',
];

const EMPTY = {
  code: '', name: '', type: 'EXPENSE', subtype: 'ADMIN',
  normal: 'D', cashflow: 'OCF', is_cash: false, active: true,
};

export default function ChartOfAccounts() {
  const toast = useToast();
  const { canManage, isAdmin } = useAuth();
  const [accounts, setAccounts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(null);
  const [typeFilter, setTypeFilter] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const d = await api.get('/api/finance/accounts');
      setAccounts(d.accounts);
    } catch (err) {
      toast.error(err.message);
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => { load(); }, [load]);

  async function save(e) {
    e.preventDefault();
    try {
      if (editing.id) {
        await api.put(`/api/finance/accounts/${editing.id}`, editing);
        toast.success('Akun diperbarui');
      } else {
        await api.post('/api/finance/accounts', editing);
        toast.success('Akun ditambahkan');
      }
      setEditing(null);
      load();
    } catch (err) {
      toast.error(err.message);
    }
  }

  async function remove(a) {
    if (!window.confirm(`Hapus akun ${a.code} — ${a.name}?`)) return;
    try {
      const res = await api.del(`/api/finance/accounts/${a.id}`);
      toast.success(res.message);
      load();
    } catch (err) {
      toast.error(err.message);
    }
  }

  const filtered = typeFilter ? accounts.filter((a) => a.type === typeFilter) : accounts;

  return (
    <div>
      <PageHeader title="Chart of Accounts" subtitle="Kerangka akun yang menopang seluruh pencatatan dual-entry">
        {canManage && (
          <button className="btn-primary" onClick={() => setEditing({ ...EMPTY })}>
            <Plus size={16} /> Akun Baru
          </button>
        )}
      </PageHeader>

      <div className="card mb-4 flex flex-wrap gap-1.5">
        <button
          onClick={() => setTypeFilter('')}
          className={`rounded-lg px-3 py-1.5 text-xs font-semibold ${!typeFilter ? 'bg-brand-600 text-white' : 'bg-slate-100 text-slate-600'}`}
        >
          Semua ({accounts.length})
        </button>
        {Object.entries(TYPE_LABEL).map(([v, l]) => (
          <button
            key={v} onClick={() => setTypeFilter(v)}
            className={`rounded-lg px-3 py-1.5 text-xs font-semibold ${typeFilter === v ? 'bg-brand-600 text-white' : 'bg-slate-100 text-slate-600'}`}
          >
            {l} ({accounts.filter((a) => a.type === v).length})
          </button>
        ))}
      </div>

      {loading ? (
        <Spinner />
      ) : (
        <div className="card">
          {filtered.length === 0 ? (
            <EmptyState message="Tidak ada akun pada filter ini" />
          ) : (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>Kode</th><th>Nama Akun</th><th>Tipe</th><th>Sub-klasifikasi</th>
                    <th>Saldo Normal</th><th>Arus Kas</th><th>Saldo Berjalan</th><th>Status</th>
                    {canManage && <th></th>}
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((a) => (
                    <tr key={a.id}>
                      <td className="font-mono text-xs font-semibold">{a.code}</td>
                      <td className="font-medium text-slate-900">
                        {a.name}
                        {a.is_cash === 1 && <span className="badge-green ml-2">kas</span>}
                      </td>
                      <td><span className={TYPE_BADGE[a.type]}>{TYPE_LABEL[a.type]}</span></td>
                      <td className="text-xs text-slate-500">{a.subtype}</td>
                      <td className="text-xs">{a.normal === 'D' ? 'Debit' : 'Kredit'}</td>
                      <td className="text-xs text-slate-500">{CASHFLOW_LABEL[a.cashflow]}</td>
                      <td className="tabular font-semibold">{rupiah(a.balance)}</td>
                      <td>
                        {a.active ? <span className="badge-green">aktif</span> : <span className="badge-slate">nonaktif</span>}
                      </td>
                      {canManage && (
                        <td>
                          <div className="flex gap-1">
                            <button
                              className="btn-ghost !px-2 !py-1"
                              onClick={() => setEditing({ ...a, is_cash: !!a.is_cash, active: !!a.active })}
                              aria-label="Ubah"
                            >
                              <Pencil size={14} />
                            </button>
                            {isAdmin && (a.is_system ? (
                              <span className="grid h-7 w-7 place-items-center text-slate-300" title="Akun sistem">
                                <Lock size={13} />
                              </span>
                            ) : (
                              <button className="btn-ghost !px-2 !py-1 text-rose-600" onClick={() => remove(a)} aria-label="Hapus">
                                <Trash2 size={14} />
                              </button>
                            ))}
                          </div>
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      <Modal open={!!editing} onClose={() => setEditing(null)} title={editing?.id ? 'Ubah Akun' : 'Akun Baru'}>
        {editing && (
          <form onSubmit={save} className="grid gap-3 sm:grid-cols-2">
            <Field label="Kode Akun *" hint="3–6 digit angka, mis. 6150">
              <input className="input" required pattern="\d{3,6}" value={editing.code} onChange={(e) => setEditing({ ...editing, code: e.target.value })} disabled={!!editing.is_system} />
            </Field>
            <Field label="Nama Akun *">
              <input className="input" required value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} />
            </Field>
            <Field label="Tipe *">
              <select className="input" value={editing.type} onChange={(e) => setEditing({ ...editing, type: e.target.value })}>
                {Object.entries(TYPE_LABEL).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </select>
            </Field>
            <Field label="Sub-klasifikasi *" hint="Menentukan posisi akun di laporan">
              <select className="input" value={editing.subtype} onChange={(e) => setEditing({ ...editing, subtype: e.target.value })}>
                {SUBTYPES.map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
            </Field>
            <Field label="Saldo Normal *">
              <select className="input" value={editing.normal} onChange={(e) => setEditing({ ...editing, normal: e.target.value })}>
                <option value="D">Debit</option>
                <option value="K">Kredit</option>
              </select>
            </Field>
            <Field label="Klasifikasi Arus Kas *" hint="Dipakai laporan OCF/ICF/FCF">
              <select className="input" value={editing.cashflow} onChange={(e) => setEditing({ ...editing, cashflow: e.target.value })}>
                {Object.entries(CASHFLOW_LABEL).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </select>
            </Field>

            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" className="h-4 w-4 rounded" checked={editing.is_cash} onChange={(e) => setEditing({ ...editing, is_cash: e.target.checked })} />
              Akun kas & setara kas
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" className="h-4 w-4 rounded" checked={editing.active} onChange={(e) => setEditing({ ...editing, active: e.target.checked })} />
              Akun aktif
            </label>

            <div className="flex gap-2 sm:col-span-2">
              <button type="button" className="btn-secondary flex-1" onClick={() => setEditing(null)}>Batal</button>
              <button type="submit" className="btn-primary flex-1">Simpan</button>
            </div>
          </form>
        )}
      </Modal>
    </div>
  );
}
