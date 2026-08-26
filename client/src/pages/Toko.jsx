import { useEffect, useState, useCallback } from 'react';
import { Plus, Pencil, Trash2, Store, TrendingUp } from 'lucide-react';
import { ResponsiveContainer, BarChart, Bar, XAxis, YAxis, Tooltip, CartesianGrid, Cell } from 'recharts';
import { api } from '../lib/api';
import {
  PageHeader, StatCard, Spinner, EmptyState, Modal,
  DateRangeFilter, defaultRange, useToast, Field,
} from '../components/ui';
import { rupiah, rupiahShort, pct, CHANNEL_LABEL, CHART_COLORS } from '../lib/format';
import { useAuth } from '../lib/auth';

const EMPTY = { name: '', channel: 'SHOPEE', note: '', active: true };

/**
 * Satu perusahaan bisa punya banyak akun toko pada marketplace yang sama.
 * Halaman ini membandingkan profitabilitas antar toko — yang sering berbeda
 * jauh meski produknya sama, karena biaya iklan dan voucher tidak seragam.
 */
export default function Toko() {
  const toast = useToast();
  const { canManage, isAdmin } = useAuth();
  const [range, setRange] = useState(defaultRange);
  const [shops, setShops] = useState([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const d = await api.get('/api/shops', range);
      setShops(d.shops);
    } catch (err) {
      toast.error(err.message);
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [range]);

  useEffect(() => { load(); }, [load]);

  async function save(e) {
    e.preventDefault();
    try {
      if (editing.id) {
        await api.put(`/api/shops/${editing.id}`, editing);
        toast.success('Toko diperbarui');
      } else {
        await api.post('/api/shops', editing);
        toast.success('Toko ditambahkan');
      }
      setEditing(null);
      load();
    } catch (err) {
      toast.error(err.message);
    }
  }

  async function remove(s) {
    if (!window.confirm(`Hapus toko "${s.name}"? Toko yang pernah dipakai order akan dinonaktifkan saja.`)) return;
    try {
      const res = await api.del(`/api/shops/${s.id}`);
      toast.success(res.message);
      load();
    } catch (err) {
      toast.error(err.message);
    }
  }

  const aktif = shops.filter((s) => s.orders > 0);
  const totalLaba = shops.reduce((s, x) => s + x.net_profit, 0);
  const totalOmzet = shops.reduce((s, x) => s + x.net_revenue, 0);
  const terbaik = aktif[0];

  return (
    <div>
      <PageHeader title="Toko / Akun Marketplace" subtitle="Bandingkan profitabilitas antar akun toko Anda">
        {canManage && (
          <button className="btn-primary" onClick={() => setEditing({ ...EMPTY })}>
            <Plus size={16} /> Toko Baru
          </button>
        )}
      </PageHeader>

      <DateRangeFilter range={range} onChange={setRange} />

      {loading ? (
        <Spinner />
      ) : (
        <>
          <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
            <StatCard label="Jumlah Toko" value={shops.length} sub={`${aktif.length} ada transaksi`} icon={Store} />
            <StatCard label="Omzet Semua Toko" value={rupiahShort(totalOmzet)} />
            <StatCard label="Laba Semua Toko" value={rupiahShort(totalLaba)} tone={totalLaba >= 0 ? 'green' : 'red'} />
            <StatCard
              label="Toko Terbaik" value={terbaik ? terbaik.name : '-'}
              sub={terbaik ? `${rupiahShort(terbaik.net_profit)} • margin ${pct(terbaik.margin_pct)}` : 'belum ada transaksi'}
              icon={TrendingUp} tone="brand"
            />
          </div>

          {aktif.length > 0 && (
            <div className="card mb-4">
              <h2 className="card-title mb-3">Perbandingan Laba Antar Toko</h2>
              <ResponsiveContainer width="100%" height={Math.max(220, aktif.length * 40)}>
                <BarChart data={aktif} layout="vertical" margin={{ left: 34, right: 16 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" horizontal={false} />
                  <XAxis type="number" tick={{ fontSize: 11 }} tickFormatter={rupiahShort} />
                  <YAxis type="category" dataKey="name" tick={{ fontSize: 11 }} width={140} />
                  <Tooltip formatter={(v) => rupiah(v)} />
                  <Bar dataKey="net_profit" name="Laba Bersih" radius={[0, 6, 6, 0]}>
                    {aktif.map((d, i) => (
                      <Cell key={i} fill={d.net_profit >= 0 ? CHART_COLORS[i % CHART_COLORS.length] : '#ef4444'} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}

          <div className="card">
            {shops.length === 0 ? (
              <EmptyState
                message="Belum ada toko terdaftar"
                hint="Tambahkan tiap akun toko marketplace agar laba bisa dibandingkan per toko"
              />
            ) : (
              <div className="table-wrap">
                <table className="table">
                  <thead>
                    <tr>
                      <th>Toko</th><th>Channel</th><th>Order</th><th>Pendapatan</th>
                      <th>Biaya</th><th>Laba</th><th>Margin</th><th>AOV</th><th>Status</th>
                      {canManage && <th>Aksi</th>}
                    </tr>
                  </thead>
                  <tbody>
                    {shops.map((s) => (
                      <tr key={s.id}>
                        <td className="font-medium text-slate-900">{s.name}</td>
                        <td className="text-xs text-slate-500">{CHANNEL_LABEL[s.channel] || s.channel}</td>
                        <td className="tabular">{s.orders}</td>
                        <td className="tabular">{rupiah(s.net_revenue)}</td>
                        <td className="tabular text-amber-700">{rupiah(s.total_fees)}</td>
                        <td className={`tabular font-bold ${s.net_profit >= 0 ? 'text-emerald-600' : 'text-rose-600'}`}>
                          {rupiah(s.net_profit)}
                        </td>
                        <td className="tabular">
                          {s.orders === 0 ? <span className="text-xs text-slate-400">—</span> : (
                            <span className={s.margin_pct >= 15 ? 'badge-green' : s.margin_pct >= 0 ? 'badge-amber' : 'badge-red'}>
                              {pct(s.margin_pct)}
                            </span>
                          )}
                        </td>
                        <td className="tabular text-slate-500">{s.orders ? rupiahShort(s.avg_order_value) : '—'}</td>
                        <td>{s.active ? <span className="badge-green">aktif</span> : <span className="badge-slate">nonaktif</span>}</td>
                        {canManage && (
                          <td>
                            <div className="flex gap-1">
                              <button className="btn-ghost !px-2 !py-1" onClick={() => setEditing({ ...s, active: !!s.active })} aria-label="Ubah">
                                <Pencil size={14} />
                              </button>
                              {isAdmin && (
                                <button className="btn-ghost !px-2 !py-1 text-rose-600" onClick={() => remove(s)} aria-label="Hapus">
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
        </>
      )}

      <Modal open={!!editing} onClose={() => setEditing(null)} title={editing?.id ? 'Ubah Toko' : 'Toko Baru'}>
        {editing && (
          <form onSubmit={save} className="grid gap-3 sm:grid-cols-2">
            <Field label="Nama Toko *" hint="Sesuai nama akun di marketplace" className="sm:col-span-2">
              <input
                className="input" required value={editing.name}
                placeholder="mis. Sh Kebun Indoor"
                onChange={(e) => setEditing({ ...editing, name: e.target.value })}
              />
            </Field>
            <Field label="Channel *" className="sm:col-span-2">
              <select className="input" value={editing.channel} onChange={(e) => setEditing({ ...editing, channel: e.target.value })}>
                {Object.entries(CHANNEL_LABEL).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </select>
            </Field>
            <Field label="Catatan" className="sm:col-span-2">
              <input className="input" value={editing.note || ''} onChange={(e) => setEditing({ ...editing, note: e.target.value })} />
            </Field>
            <label className="flex items-center gap-2 text-sm sm:col-span-2">
              <input type="checkbox" className="h-4 w-4 rounded" checked={editing.active} onChange={(e) => setEditing({ ...editing, active: e.target.checked })} />
              Toko aktif
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
