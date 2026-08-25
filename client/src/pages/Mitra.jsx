import { useEffect, useState, useCallback } from 'react';
import { Plus, Pencil, Trash2, Search, Users, Truck, Eye } from 'lucide-react';
import { api } from '../lib/api';
import { PageHeader, StatCard, Spinner, EmptyState, Modal, useToast, Field } from '../components/ui';
import { rupiah, dateID } from '../lib/format';
import { useAuth } from '../lib/auth';

const KIND_LABEL = { SUPPLIER: 'Supplier', CUSTOMER: 'Pelanggan', BOTH: 'Supplier & Pelanggan' };
const KIND_BADGE = { SUPPLIER: 'badge-amber', CUSTOMER: 'badge-blue', BOTH: 'badge-green' };

const EMPTY = {
  code: '', name: '', kind: 'CUSTOMER', phone: '', email: '',
  address: '', note: '', term_days: 0, active: true,
};

export default function Mitra() {
  const toast = useToast();
  const { canManage, isAdmin } = useAuth();
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [q, setQ] = useState('');
  const [kind, setKind] = useState('');
  const [editing, setEditing] = useState(null);
  const [detail, setDetail] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const d = await api.get('/api/partners', { q, kind });
      setRows(d.partners);
    } catch (err) {
      toast.error(err.message);
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, kind]);

  // Pencarian ditunda sesaat agar tidak memanggil API tiap ketikan
  useEffect(() => {
    const timer = setTimeout(load, 250);
    return () => clearTimeout(timer);
  }, [load]);

  async function save(e) {
    e.preventDefault();
    const payload = { ...editing, term_days: Number(editing.term_days) || 0 };
    try {
      if (editing.id) {
        await api.put(`/api/partners/${editing.id}`, payload);
        toast.success('Data mitra diperbarui');
      } else {
        await api.post('/api/partners', payload);
        toast.success('Mitra ditambahkan');
      }
      setEditing(null);
      load();
    } catch (err) {
      toast.error(err.message);
    }
  }

  async function remove(p) {
    if (!window.confirm(`Hapus "${p.name}"? Mitra yang pernah bertransaksi akan dinonaktifkan saja.`)) return;
    try {
      const res = await api.del(`/api/partners/${p.id}`);
      toast.success(res.message);
      load();
    } catch (err) {
      toast.error(err.message);
    }
  }

  const supplier = rows.filter((r) => r.kind === 'SUPPLIER' || r.kind === 'BOTH').length;
  const pelanggan = rows.filter((r) => r.kind === 'CUSTOMER' || r.kind === 'BOTH').length;
  const totalPiutang = rows.reduce((s, r) => s + (r.receivable || 0), 0);
  const totalUtang = rows.reduce((s, r) => s + (r.payable || 0), 0);

  return (
    <div>
      <PageHeader title="Supplier & Pelanggan" subtitle="Data mitra usaha beserta posisi utang dan piutangnya">
        {canManage && (
          <button className="btn-primary" onClick={() => setEditing({ ...EMPTY })}>
            <Plus size={16} /> Mitra Baru
          </button>
        )}
      </PageHeader>

      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard label="Supplier" value={supplier} icon={Truck} tone="amber" />
        <StatCard label="Pelanggan" value={pelanggan} icon={Users} tone="brand" />
        <StatCard label="Total Piutang" value={rupiah(totalPiutang)} tone="green" />
        <StatCard label="Total Utang" value={rupiah(totalUtang)} tone="red" />
      </div>

      <div className="card mb-4 flex flex-col gap-3 sm:flex-row">
        <div className="relative flex-1">
          <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
          <input
            className="input pl-9" placeholder="Cari nama, kode, atau telepon..."
            value={q} onChange={(e) => setQ(e.target.value)}
          />
        </div>
        <select className="input sm:w-56" value={kind} onChange={(e) => setKind(e.target.value)}>
          <option value="">Semua Jenis</option>
          <option value="SUPPLIER">Supplier</option>
          <option value="CUSTOMER">Pelanggan</option>
        </select>
      </div>

      {loading ? (
        <Spinner />
      ) : (
        <div className="card">
          {rows.length === 0 ? (
            <EmptyState
              message="Belum ada mitra terdaftar"
              hint="Tambahkan supplier dan pelanggan agar transaksi bisa ditelusuri per pihak"
            />
          ) : (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>Nama</th><th>Jenis</th><th>Telepon</th><th>Tempo</th>
                    <th>Piutang</th><th>Utang</th><th>Status</th>{canManage && <th></th>}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((p) => (
                    <tr key={p.id}>
                      <td>
                        <p className="font-medium text-slate-900">{p.name}</p>
                        {p.code && <p className="text-xs text-slate-400">{p.code}</p>}
                      </td>
                      <td><span className={KIND_BADGE[p.kind]}>{KIND_LABEL[p.kind]}</span></td>
                      <td className="text-sm">{p.phone || '-'}</td>
                      <td className="tabular text-xs">{p.term_days ? `${p.term_days} hari` : 'Tunai'}</td>
                      <td className="tabular text-emerald-600">{p.receivable ? rupiah(p.receivable) : '-'}</td>
                      <td className="tabular text-amber-700">{p.payable ? rupiah(p.payable) : '-'}</td>
                      <td>{p.active ? <span className="badge-green">aktif</span> : <span className="badge-slate">nonaktif</span>}</td>
                      {canManage && (
                        <td>
                          <div className="flex gap-1">
                            <button
                              className="btn-ghost !px-2 !py-1"
                              onClick={() => api.get(`/api/partners/${p.id}/ledger`).then(setDetail).catch((e) => toast.error(e.message))}
                              aria-label="Riwayat"
                            >
                              <Eye size={14} />
                            </button>
                            <button className="btn-ghost !px-2 !py-1" onClick={() => setEditing({ ...p, active: !!p.active })} aria-label="Ubah">
                              <Pencil size={14} />
                            </button>
                            {isAdmin && (
                              <button className="btn-ghost !px-2 !py-1 text-rose-600" onClick={() => remove(p)} aria-label="Hapus">
                                <Trash2 size={14} />
                              </button>
                            )}
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

      <Modal open={!!editing} onClose={() => setEditing(null)} title={editing?.id ? 'Ubah Mitra' : 'Mitra Baru'}>
        {editing && (
          <form onSubmit={save} className="grid gap-3 sm:grid-cols-2">
            <Field label="Nama *" className="sm:col-span-2">
              <input className="input" required value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} />
            </Field>
            <Field label="Kode" hint="Opsional, mis. SUP-001">
              <input className="input" value={editing.code || ''} onChange={(e) => setEditing({ ...editing, code: e.target.value })} />
            </Field>
            <Field label="Jenis *">
              <select className="input" value={editing.kind} onChange={(e) => setEditing({ ...editing, kind: e.target.value })}>
                <option value="CUSTOMER">Pelanggan</option>
                <option value="SUPPLIER">Supplier</option>
                <option value="BOTH">Supplier &amp; Pelanggan</option>
              </select>
            </Field>
            <Field label="Telepon">
              <input className="input" value={editing.phone || ''} onChange={(e) => setEditing({ ...editing, phone: e.target.value })} />
            </Field>
            <Field label="Email">
              <input type="email" className="input" value={editing.email || ''} onChange={(e) => setEditing({ ...editing, email: e.target.value })} />
            </Field>
            <Field label="Tempo Bawaan (hari)" hint="0 = tunai" className="sm:col-span-2">
              <input type="number" min="0" max="365" className="input" value={editing.term_days} onChange={(e) => setEditing({ ...editing, term_days: e.target.value })} />
            </Field>
            <Field label="Alamat" className="sm:col-span-2">
              <input className="input" value={editing.address || ''} onChange={(e) => setEditing({ ...editing, address: e.target.value })} />
            </Field>
            <Field label="Catatan" className="sm:col-span-2">
              <input className="input" value={editing.note || ''} onChange={(e) => setEditing({ ...editing, note: e.target.value })} />
            </Field>
            <label className="flex items-center gap-2 text-sm sm:col-span-2">
              <input type="checkbox" className="h-4 w-4 rounded" checked={editing.active} onChange={(e) => setEditing({ ...editing, active: e.target.checked })} />
              Mitra aktif
            </label>
            <div className="flex gap-2 sm:col-span-2">
              <button type="button" className="btn-secondary flex-1" onClick={() => setEditing(null)}>Batal</button>
              <button type="submit" className="btn-primary flex-1">Simpan</button>
            </div>
          </form>
        )}
      </Modal>

      <Modal open={!!detail} onClose={() => setDetail(null)} title={`Riwayat — ${detail?.partner.name || ''}`} wide>
        {detail && (
          <div>
            <div className="mb-3 grid grid-cols-2 gap-3">
              <StatCard label="Piutang" value={rupiah(detail.receivable)} tone="green" />
              <StatCard label="Utang" value={rupiah(detail.payable)} tone="amber" />
            </div>
            {detail.entries.length === 0 ? (
              <EmptyState message="Belum ada transaksi utang/piutang dengan mitra ini" />
            ) : (
              <div className="table-wrap">
                <table className="table">
                  <thead><tr><th>Tanggal</th><th>No. Jurnal</th><th>Keterangan</th><th>Debit</th><th>Kredit</th></tr></thead>
                  <tbody>
                    {detail.entries.map((e, i) => (
                      <tr key={i}>
                        <td className="tabular">{dateID(e.entry_date)}</td>
                        <td className="font-mono text-xs">{e.entry_no}</td>
                        <td className="max-w-[280px] truncate">{e.memo || e.description}</td>
                        <td className="tabular">{e.debit ? rupiah(e.debit) : '-'}</td>
                        <td className="tabular">{e.credit ? rupiah(e.credit) : '-'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}
      </Modal>
    </div>
  );
}
