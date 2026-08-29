import { useEffect, useState, useCallback } from 'react';
import { Plus, Pencil, Trash2, Megaphone, TrendingUp, Wallet } from 'lucide-react';
import {
  ResponsiveContainer, BarChart, Bar, XAxis, YAxis, Tooltip, CartesianGrid, Cell,
} from 'recharts';
import { api } from '../lib/api';
import {
  PageHeader, StatCard, Spinner, EmptyState, Modal,
  DateRangeFilter, defaultRange, useToast, Field, TombolEkspor,
  KotakCari, saringLokal,
} from '../components/ui';
import { rupiah, rupiahShort, pct, dateID, today, CHANNEL_LABEL } from '../lib/format';
import { useAuth } from '../lib/auth';

const KOSONG = {
  spend_date: today(),
  shop_id: '',
  channel: 'SHOPEE',
  platform: '',
  amount: '',
  payment: 'BANK',
  cash_code: '',
  note: '',
};

/** Sumber dana dalam bahasa layar. */
const LABEL_DANA = {
  BANK: 'Bank',
  CASH: 'Kas',
  SALDO: 'Saldo marketplace',
  CREDIT: 'Belum dibayar',
};

/** Platform iklan yang lazim dipakai; tetap bisa diisi bebas. */
const PLATFORM = ['Shopee Ads', 'TikTok Ads', 'Meta Ads', 'Google Ads', 'Lazada Ads', 'Tokopedia Ads'];

export default function Iklan() {
  const toast = useToast();
  const { canManage } = useAuth();
  const [range, setRange] = useState(defaultRange);
  const [q, setQ] = useState('');
  const [data, setData] = useState(null);
  const [shops, setShops] = useState([]);
  const [rekening, setRekening] = useState([]);
  const [loading, setLoading] = useState(true);
  const [form, setForm] = useState(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setData(await api.get('/api/iklan', range));
    } catch (err) {
      toast.error(err.message);
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [range]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    api.get('/api/shops').then((d) => setShops(d.shops)).catch(() => {});
    api.get('/api/cashflow/options').then((d) => setRekening(d.cashAccounts)).catch(() => {});
  }, []);

  async function simpan(e) {
    e.preventDefault();
    setSaving(true);
    try {
      const isi = {
        spend_date: form.spend_date,
        shop_id: form.shop_id ? Number(form.shop_id) : null,
        channel: form.channel,
        platform: form.platform || null,
        amount: Number(form.amount) || 0,
        payment: form.payment,
        // Rekening hanya dikirim untuk pembayaran yang benar-benar memindahkan
        // uang; utang dan potongan saldo punya akunnya sendiri.
        cash_code: ['CASH', 'BANK'].includes(form.payment) ? form.cash_code || null : null,
        note: form.note || null,
      };
      const res = form.id
        ? await api.put(`/api/iklan/${form.id}`, isi)
        : await api.post('/api/iklan', isi);
      toast.success(res.message);
      setForm(null);
      load();
    } catch (err) {
      toast.error(err.message);
    } finally {
      setSaving(false);
    }
  }

  async function hapus(b) {
    if (!window.confirm(`Hapus biaya iklan ${dateID(b.spend_date)} sebesar ${rupiah(b.amount)}? Jurnalnya ikut dihapus.`)) return;
    try {
      const res = await api.del(`/api/iklan/${b.id}`);
      toast.success(res.message);
      load();
    } catch (err) {
      toast.error(err.message);
    }
  }

  /** Toko dipilih → channel mengikuti, karena satu toko hanya hidup di satu kanal. */
  function pilihToko(id) {
    const t = shops.find((s) => s.id === Number(id));
    setForm({ ...form, shop_id: id, channel: t ? t.channel : form.channel });
  }

  const r = data?.ringkas;

  return (
    <div>
      <PageHeader
        title="Biaya Iklan & Pemasaran"
        subtitle="Belanja iklan per akun toko, dibandingkan dengan penjualan yang dihasilkannya"
      >
        {canManage && (
          <button className="btn-primary" onClick={() => setForm({ ...KOSONG })}>
            <Plus size={16} /> Catat Iklan
          </button>
        )}
        <TombolEkspor path="/api/iklan" params={range} nama="biaya-iklan" />
      </PageHeader>

      <DateRangeFilter range={range} onChange={setRange}>
        <div className="flex-[2]">
          <label className="label">Cari</label>
          <KotakCari nilai={q} onCari={setQ} placeholder="Toko, platform, catatan..." />
        </div>
      </DateRangeFilter>

      {loading || !data ? (
        <Spinner />
      ) : (
        <>
          <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-5">
            <StatCard
              label="Belanja Iklan" value={rupiahShort(r.totalIklan)}
              sub={`${r.jumlahCatatan} catatan`} icon={Megaphone} tone="amber"
            />
            <StatCard
              label="Pendapatan Kotor" value={rupiahShort(r.pendapatanKotor)}
              sub="Sebelum potongan marketplace"
            />
            <StatCard
              label="Pendapatan Bersih" value={rupiahShort(r.pendapatanBersih)}
              sub="Yang benar-benar diterima" icon={Wallet}
            />
            <StatCard
              label="Laba Setelah Iklan" value={rupiahShort(r.labaSetelahIklan)}
              sub={`Sebelum iklan ${rupiahShort(r.labaSebelumIklan)}`}
              tone={r.labaSetelahIklan >= 0 ? 'green' : 'red'}
            />
            <StatCard
              label="ROAS" value={r.roas != null ? `${r.roas.toFixed(2)}×` : '—'}
              sub={r.rasioIklanPct != null ? `Iklan ${pct(r.rasioIklanPct)} dari penjualan` : 'belum ada penjualan'}
              icon={TrendingUp} tone="brand"
            />
          </div>

          <div className="mb-4 rounded-xl bg-slate-50 px-4 py-3 text-xs text-slate-600 ring-1 ring-slate-200">
            <span className="font-semibold text-slate-800">ROAS</span> = tiap Rp 1 iklan menghasilkan berapa rupiah
            penjualan kotor. <span className="font-semibold text-slate-800">Laba setelah iklan</span> = laba bersih
            seluruh order pada periode ini dikurangi belanja iklan. Iklan tidak dibebankan ke pesanan tertentu karena
            satu kampanye menarik banyak pesanan sekaligus — dan sebagian tidak menghasilkan pesanan sama sekali.
          </div>

          {data.perToko.length > 0 && (
            <div className="card mb-4">
              <h2 className="card-title mb-3">Belanja Iklan per Toko</h2>
              <ResponsiveContainer width="100%" height={Math.max(200, data.perToko.length * 38)}>
                <BarChart data={data.perToko} layout="vertical" margin={{ left: 30, right: 16 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" horizontal={false} />
                  <XAxis type="number" tick={{ fontSize: 11 }} tickFormatter={rupiahShort} />
                  <YAxis type="category" dataKey="shop_name" tick={{ fontSize: 11 }} width={140} />
                  <Tooltip formatter={(v) => rupiah(v)} />
                  <Bar dataKey="iklan" name="Belanja Iklan" radius={[0, 6, 6, 0]}>
                    {data.perToko.map((t, i) => (
                      <Cell key={i} fill={t.labaSetelahIklan >= 0 ? '#f59e0b' : '#ef4444'} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}

          <div className="card mb-4">
            <h2 className="card-title mb-3">Hasil Iklan per Toko</h2>
            {data.perToko.length === 0 ? (
              <EmptyState message="Belum ada belanja iklan pada periode ini" />
            ) : (
              <div className="table-wrap">
                <table className="table">
                  <thead>
                    <tr>
                      <th>Toko</th><th>Channel</th><th>Iklan</th><th>Order</th>
                      <th>Pendapatan Kotor</th><th>Laba Sebelum Iklan</th>
                      <th>Laba Setelah Iklan</th><th>ROAS</th><th>Rasio Iklan</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.perToko.map((t) => (
                      <tr key={t.shop_id || 'tanpa'}>
                        <td className="font-medium text-slate-900">{t.shop_name}</td>
                        <td className="text-xs text-slate-500">{t.channel_label}</td>
                        <td className="tabular text-amber-700">{rupiah(t.iklan)}</td>
                        <td className="tabular">{t.orders}</td>
                        <td className="tabular">{rupiah(t.pendapatanKotor)}</td>
                        <td className="tabular text-slate-500">{rupiah(t.labaSebelumIklan)}</td>
                        <td className={`tabular font-bold ${t.labaSetelahIklan >= 0 ? 'text-emerald-600' : 'text-rose-600'}`}>
                          {rupiah(t.labaSetelahIklan)}
                        </td>
                        <td className="tabular">
                          {t.roas == null ? <span className="text-slate-400">—</span> : (
                            <span className={t.roas >= 4 ? 'badge-green' : t.roas >= 2 ? 'badge-amber' : 'badge-red'}>
                              {t.roas.toFixed(2)}×
                            </span>
                          )}
                        </td>
                        <td className="tabular text-slate-500">
                          {t.rasioIklanPct == null ? '—' : pct(t.rasioIklanPct)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {data.perPlatform.length > 0 && (
            <div className="card mb-4">
              <h2 className="card-title mb-3">Belanja per Platform Iklan</h2>
              <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                {data.perPlatform.map((p) => (
                  <div key={p.platform} className="flex items-center justify-between rounded-xl bg-slate-50 px-3 py-2">
                    <span className="text-sm text-slate-700">{p.platform}</span>
                    <span className="tabular text-sm font-semibold text-slate-900">{rupiah(p.iklan)}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="card">
            <h2 className="card-title mb-3">Catatan Belanja Iklan</h2>
            {data.rows.length === 0 ? (
              <EmptyState
                message="Belum ada catatan iklan"
                hint="Catat belanja iklan tiap toko agar laba bersihnya terlihat apa adanya"
              />
            ) : (
              <div className="table-wrap">
                <table className="table">
                  <thead>
                    <tr>
                      <th>Tanggal</th><th>Toko</th><th>Channel</th><th>Platform</th>
                      <th>Nilai</th><th>Sumber Dana</th><th>Catatan</th>
                      {canManage && <th></th>}
                    </tr>
                  </thead>
                  <tbody>
                    {saringLokal(data.rows, q, (b) => [b.shop_name, b.platform, b.note, b.channel]).map((b) => (
                      <tr key={b.id}>
                        <td className="tabular">{dateID(b.spend_date)}</td>
                        <td className="text-sm">{b.shop_name || <span className="text-slate-400">tanpa toko</span>}</td>
                        <td className="text-xs text-slate-500">{b.channel_label}</td>
                        <td className="text-sm">{b.platform || '-'}</td>
                        <td className="tabular font-semibold text-amber-700">{rupiah(b.amount)}</td>
                        <td className="text-xs">{LABEL_DANA[b.payment] || b.payment}</td>
                        <td className="text-xs text-slate-500">{b.note || '-'}</td>
                        {canManage && (
                          <td>
                            <div className="flex gap-1">
                              <button
                                className="btn-ghost !px-2 !py-1"
                                onClick={() => setForm({ ...b, shop_id: b.shop_id || '', platform: b.platform || '', cash_code: b.cash_code || '', note: b.note || '' })}
                                aria-label="Ubah"
                              >
                                <Pencil size={14} />
                              </button>
                              <button className="btn-ghost !px-2 !py-1 text-rose-600" onClick={() => hapus(b)} aria-label="Hapus">
                                <Trash2 size={14} />
                              </button>
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

      <Modal open={!!form} onClose={() => setForm(null)} title={form?.id ? 'Ubah Biaya Iklan' : 'Catat Biaya Iklan'}>
        {form && (
          <form onSubmit={simpan} className="grid gap-3 sm:grid-cols-2">
            <Field label="Tanggal *">
              <input type="date" className="input" required value={form.spend_date}
                onChange={(e) => setForm({ ...form, spend_date: e.target.value })} />
            </Field>
            <Field label="Nilai Belanja *">
              <input type="number" min="1" className="input" required value={form.amount}
                onChange={(e) => setForm({ ...form, amount: e.target.value })} />
            </Field>
            <Field label="Toko / Akun" hint="Kosongkan bila iklannya tidak khusus satu toko">
              <select className="input" value={form.shop_id} onChange={(e) => pilihToko(e.target.value)}>
                <option value="">— tanpa toko —</option>
                {shops.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
            </Field>
            <Field label="Channel *">
              <select className="input" value={form.channel} onChange={(e) => setForm({ ...form, channel: e.target.value })}>
                {Object.entries(CHANNEL_LABEL).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </select>
            </Field>
            <Field label="Platform Iklan">
              <input className="input" list="daftar-platform" value={form.platform}
                onChange={(e) => setForm({ ...form, platform: e.target.value })} />
              <datalist id="daftar-platform">
                {PLATFORM.map((p) => <option key={p} value={p} />)}
              </datalist>
            </Field>
            <Field label="Sumber Dana *">
              <select className="input" value={form.payment} onChange={(e) => setForm({ ...form, payment: e.target.value })}>
                <option value="BANK">Bank</option>
                <option value="CASH">Kas tunai</option>
                <option value="SALDO">Saldo marketplace (potong dana belum cair)</option>
                <option value="CREDIT">Belum dibayar (utang)</option>
              </select>
            </Field>
            {['CASH', 'BANK'].includes(form.payment) && (
              <Field label="Rekening" hint="Kosongkan untuk memakai rekening bawaan">
                <select className="input" value={form.cash_code} onChange={(e) => setForm({ ...form, cash_code: e.target.value })}>
                  <option value="">— rekening bawaan —</option>
                  {rekening.map((k) => <option key={k.code} value={k.code}>{k.code} — {k.name}</option>)}
                </select>
              </Field>
            )}
            <Field label="Catatan" className="sm:col-span-2">
              <input className="input" placeholder="mis. kampanye flash sale 8.8" value={form.note}
                onChange={(e) => setForm({ ...form, note: e.target.value })} />
            </Field>
            <div className="flex gap-2 sm:col-span-2">
              <button type="button" className="btn-secondary flex-1" onClick={() => setForm(null)}>Batal</button>
              <button type="submit" className="btn-primary flex-1" disabled={saving}>
                {saving ? 'Menyimpan...' : 'Simpan'}
              </button>
            </div>
          </form>
        )}
      </Modal>
    </div>
  );
}
