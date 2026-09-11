import { useEffect, useState, useCallback } from 'react';
import { Plus, Pencil, Trash2, Store, TrendingUp, Link2, History } from 'lucide-react';
import { ResponsiveContainer, BarChart, Bar, XAxis, YAxis, Tooltip, CartesianGrid, Cell } from 'recharts';
import { api } from '../lib/api';
import {
  PageHeader, StatCard, Spinner, EmptyState, Modal,
  DateRangeFilter, defaultRange, useToast, Field, TombolEkspor,
  KotakCari, saringLokal,
} from '../components/ui';
import { rupiah, pct, CHANNEL_LABEL, CHART_COLORS } from '../lib/format';
import { useAuth } from '../lib/auth';
import KaitkanOrderLama from '../components/KaitkanOrderLama';

const EMPTY = { name: '', channel: 'SHOPEE', note: '', cash_code: '', rekening_utama: false, active: true };

/**
 * Satu perusahaan bisa punya banyak akun toko pada marketplace yang sama.
 * Halaman ini membandingkan profitabilitas antar toko — yang sering berbeda
 * jauh meski produknya sama, karena biaya iklan dan voucher tidak seragam.
 */
export default function Toko() {
  const toast = useToast();
  const { canManage, isAdmin } = useAuth();
  const [range, setRange] = useState(defaultRange);
  const [q, setQ] = useState('');
  const [shops, setShops] = useState([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(null);
  const [rekening, setRekening] = useState([]);
  const [taut, setTaut] = useState(null);
  const [hasilTaut, setHasilTaut] = useState(null);
  const [menyimpanTaut, setMenyimpanTaut] = useState(false);
  const [orderLama, setOrderLama] = useState(false);

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

  useEffect(() => {
    api.get('/api/cashflow/options').then((d) => setRekening(d.cashAccounts || [])).catch(() => {});
  }, []);

  async function simpanTaut(e) {
    e.preventDefault();
    const baris = taut.teks.split('\n').map((s) => s.trim()).filter((s) => s.length >= 3);
    if (!baris.length) return toast.error('Isi minimal satu baris');

    setMenyimpanTaut(true);
    try {
      const res = await api.post('/api/shops/tautkan-rekening', { baris });
      toast.success(res.message);
      setHasilTaut(res);
      setTaut(null);
      load();
    } catch (err) {
      toast.error(err.message);
    } finally {
      setMenyimpanTaut(false);
    }
  }

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
          <button className="btn-secondary" onClick={() => setOrderLama(true)}>
            <History size={16} /> Kaitkan Order Lama
          </button>
        )}
        {canManage && (
          <button className="btn-secondary" onClick={() => setTaut({ teks: '' })}>
            <Link2 size={16} /> Tautkan Rekening
          </button>
        )}
        {canManage && (
          <button className="btn-primary" onClick={() => setEditing({ ...EMPTY })}>
            <Plus size={16} /> Toko Baru
          </button>
        )}
        <TombolEkspor path="/api/shops" params={range} nama="toko-marketplace" />
      </PageHeader>

      <DateRangeFilter range={range} onChange={setRange}>
        <div className="flex-[2]">
          <label className="label">Cari</label>
          <KotakCari nilai={q} onCari={setQ} placeholder="Nama toko atau channel..." />
        </div>
      </DateRangeFilter>

      {loading ? (
        <Spinner />
      ) : (
        <>
          <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
            <StatCard label="Jumlah Toko" value={shops.length} sub={`${aktif.length} ada transaksi`} icon={Store} />
            <StatCard label="Omzet Semua Toko" value={rupiah(totalOmzet)} />
            <StatCard label="Laba Semua Toko" value={rupiah(totalLaba)} tone={totalLaba >= 0 ? 'green' : 'red'} />
            <StatCard
              label="Toko Terbaik" value={terbaik ? terbaik.name : '-'}
              sub={terbaik ? `${rupiah(terbaik.net_profit)} • margin ${pct(terbaik.margin_pct)}` : 'belum ada transaksi'}
              icon={TrendingUp} tone="brand"
            />
          </div>

          {aktif.length > 0 && (
            <div className="card mb-4">
              <h2 className="card-title mb-3">Perbandingan Laba Antar Toko</h2>
              <ResponsiveContainer width="100%" height={Math.max(220, aktif.length * 40)}>
                <BarChart data={aktif} layout="vertical" margin={{ left: 34, right: 16 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" horizontal={false} />
                  <XAxis type="number" tick={{ fontSize: 11 }} tickFormatter={rupiah} />
                  <YAxis type="category" dataKey="name" tick={{ fontSize: 11 }} width={140} />
                  <Tooltip formatter={(v) => rupiah(v)} />
                  <Bar dataKey="net_profit" name="Laba Bersih" radius={[0, 6, 6, 0]}>
                    {saringLokal(aktif, q, (d) => [d.name, d.channel, d.channelLabel, d.label]).map((d, i) => (
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
                    {saringLokal(shops, q, (s) => [s.name, s.channel, s.note]).map((s) => (
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
                        <td className="tabular text-slate-500">{s.orders ? rupiah(s.avg_order_value) : '—'}</td>
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

      <KaitkanOrderLama open={orderLama} onClose={() => setOrderLama(false)} onSelesai={load} />

      <Modal open={!!taut} onClose={() => setTaut(null)} title="Tautkan Toko ke Rekening" wide>
        {taut && (
          <form onSubmit={simpanTaut} className="grid gap-3">
            <p className="rounded-xl bg-slate-50 px-3 py-2 text-xs leading-relaxed text-slate-600">
              Tempel daftarnya apa adanya, <strong>satu baris satu toko</strong>. Pemisahnya boleh
              kata <span className="font-mono">pakai</span> atau tanda{' '}
              <span className="font-mono">=</span>. Rekeningnya dicari lewat <strong>angka</strong>{' '}
              pada tulisannya, jadi penulisan nama yang berbeda tetap dikenali.
            </p>

            <Field label="Daftar Tautan *" hint="mis. Sh Ratu Tanam pakai BCA ROSIDAH (423-116-0331)">
              <textarea
                className="input min-h-48 font-mono text-sm" required
                placeholder={'Sh Ratu Tanam  pakai BCA ROSIDAH (423-116-0331)\nSh PIPIT BERKAH = BCA FITRI APRIYATI 423-046-6641'}
                value={taut.teks}
                onChange={(e) => setTaut({ ...taut, teks: e.target.value })}
              />
            </Field>

            <p className="rounded-xl bg-amber-50 px-3 py-2 text-xs leading-relaxed text-amber-900">
              Bila satu rekening dipakai beberapa toko, <strong>yang disebut lebih dulu</strong> di
              daftar ini menjadi toko utamanya — itulah yang terpilih otomatis saat rekening tersebut
              dipilih di formulir order. Toko beda kanal tidak terpengaruh: kanalnya sudah cukup
              membedakan.
            </p>

            <div className="flex gap-2">
              <button type="button" className="btn-secondary flex-1" onClick={() => setTaut(null)}>
                Batal
              </button>
              <button type="submit" className="btn-primary flex-1" disabled={menyimpanTaut}>
                {menyimpanTaut ? 'Menautkan...' : 'Tautkan'}
              </button>
            </div>
          </form>
        )}
      </Modal>

      <Modal open={!!hasilTaut} onClose={() => setHasilTaut(null)} title="Hasil Penautan" wide>
        {hasilTaut && (
          <div className="grid gap-3 text-sm">
            {hasilTaut.berhasil.length > 0 && (
              <div>
                <p className="mb-1 font-semibold text-emerald-700">
                  {hasilTaut.berhasil.length} toko ditautkan
                </p>
                <ul className="space-y-0.5">
                  {hasilTaut.berhasil.map((b) => (
                    <li key={b.toko} className="text-slate-700">
                      {b.toko} → <span className="text-xs text-slate-500">{b.rekening}</span>
                      {b.utama && <span className="badge-green ml-2">toko utama</span>}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {hasilTaut.gagal.length > 0 && (
              <div>
                <p className="mb-1 font-semibold text-rose-700">
                  {hasilTaut.gagal.length} baris tidak dikenali
                </p>
                <ul className="space-y-0.5">
                  {hasilTaut.gagal.map((g) => (
                    <li key={g.baris} className="text-slate-600">
                      <span className="font-mono text-xs">{g.baris}</span>
                      <span className="block text-xs text-rose-600">{g.alasan}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            <button type="button" className="btn-primary" onClick={() => setHasilTaut(null)}>
              Tutup
            </button>
          </div>
        )}
      </Modal>

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
            <Field
              label="Rekening Penerima"
              hint="Rekening tujuan pencairan toko ini — terisi sendiri saat mencatat order"
              className="sm:col-span-2"
            >
              <select
                className="input" value={editing.cash_code || ''}
                onChange={(e) => setEditing({ ...editing, cash_code: e.target.value })}
              >
                <option value="">— belum ditentukan —</option>
                {rekening.map((k) => <option key={k.code} value={k.code}>{k.code} — {k.name}</option>)}
              </select>
            </Field>
            {editing.cash_code && (
              <label className="flex items-start gap-2 text-sm sm:col-span-2">
                <input
                  type="checkbox" className="mt-0.5 h-4 w-4 rounded"
                  checked={!!editing.rekening_utama}
                  onChange={(e) => setEditing({ ...editing, rekening_utama: e.target.checked })}
                />
                <span>
                  Toko utama untuk rekening ini
                  <span className="block text-xs text-slate-500">
                    Dipakai bila satu rekening dipakai beberapa toko pada kanal yang sama —
                    toko inilah yang terpilih otomatis saat rekeningnya dipilih di formulir order.
                  </span>
                </span>
              </label>
            )}
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
