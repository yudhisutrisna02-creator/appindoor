import { useEffect, useState, useCallback } from 'react';
import { Plus, PackageCheck, Truck, XCircle, Trash2, Clock } from 'lucide-react';
import { api } from '../lib/api';
import {
  PageHeader, StatCard, Spinner, EmptyState, Modal,
  DateRangeFilter, defaultRange, useToast, Field, TombolEkspor,
} from '../components/ui';
import { rupiah, rupiahShort, dateID, today } from '../lib/format';
import { useAuth } from '../lib/auth';

const KOSONG = () => ({
  order_date: today(),
  expected_date: '',
  partner_id: '',
  payment: 'CREDIT',
  note: '',
  items: [{ product_id: '', qty: 1, unit_cost: '' }],
});

const WARNA_STATUS = {
  DIPESAN: 'badge-amber',
  SEBAGIAN: 'badge-blue',
  SELESAI: 'badge-green',
  BATAL: 'badge-slate',
};

/**
 * Pesanan pembelian.
 *
 * Mutasi stok hanya tahu apa yang sudah datang. Layar ini menjawab yang tidak
 * terjawab olehnya: barang apa yang sudah dipesan tetapi belum tiba, sudah
 * berapa lama menunggu, dan berapa nilainya.
 */
export default function Pembelian() {
  const toast = useToast();
  const { punya } = useAuth();
  const bolehKelola = punya('pembelian.kelola');

  const [range, setRange] = useState(defaultRange);
  const [status, setStatus] = useState('');
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [suppliers, setSuppliers] = useState([]);
  const [products, setProducts] = useState([]);
  const [form, setForm] = useState(null);
  const [terima, setTerima] = useState(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setData(await api.get('/api/pembelian', { ...range, status }));
    } catch (err) {
      toast.error(err.message);
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [range, status]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    api.get('/api/partners', { kind: 'SUPPLIER' }).then((d) => setSuppliers(d.partners)).catch(() => {});
    api.get('/api/inventory/products', { limit: 2000 }).then((d) => setProducts(d.products)).catch(() => {});
  }, []);

  function setItem(i, patch) {
    const items = [...form.items];
    items[i] = { ...items[i], ...patch };
    // Harga beli diisikan dari HPP produk agar tidak perlu diketik ulang untuk
    // barang yang harganya memang tetap.
    if (patch.product_id) {
      const p = products.find((x) => x.id === Number(patch.product_id));
      if (p && !items[i].unit_cost) items[i].unit_cost = p.cost;
    }
    setForm({ ...form, items });
  }

  async function simpan(e) {
    e.preventDefault();
    setSaving(true);
    try {
      const isi = {
        order_date: form.order_date,
        expected_date: form.expected_date || null,
        partner_id: Number(form.partner_id),
        payment: form.payment,
        note: form.note || null,
        items: form.items
          .filter((i) => i.product_id && Number(i.qty) > 0)
          .map((i) => ({
            product_id: Number(i.product_id),
            qty: Number(i.qty),
            unit_cost: Number(i.unit_cost) || 0,
          })),
      };
      if (!isi.items.length) throw new Error('Tambahkan minimal satu barang');
      if (!isi.partner_id) throw new Error('Pilih supplier terlebih dahulu');

      const res = await api.post('/api/pembelian', isi);
      toast.success(res.message);
      setForm(null);
      load();
    } catch (err) {
      toast.error(err.message);
    } finally {
      setSaving(false);
    }
  }

  async function bukaTerima(po) {
    try {
      const d = await api.get(`/api/pembelian/${po.id}`);
      setTerima({
        ...d.po,
        receive_date: today(),
        // Bawaan: terima seluruh sisanya. Yang paling sering terjadi adalah
        // barang datang lengkap; mengetik ulang jumlahnya cuma menambah kerja.
        lines: d.po.items.map((i) => ({ item_id: i.id, qty: i.qty_sisa, maks: i.qty_sisa, nama: i.product_name, unit: i.unit })),
      });
    } catch (err) {
      toast.error(err.message);
    }
  }

  async function simpanTerima(e) {
    e.preventDefault();
    setSaving(true);
    try {
      const lines = terima.lines
        .filter((l) => Number(l.qty) > 0)
        .map((l) => ({ item_id: l.item_id, qty: Number(l.qty) }));
      if (!lines.length) throw new Error('Isi jumlah barang yang diterima');

      const res = await api.post(`/api/pembelian/${terima.id}/terima`, {
        receive_date: terima.receive_date,
        lines,
      });
      toast.success(res.message);
      setTerima(null);
      load();
    } catch (err) {
      toast.error(err.message);
    } finally {
      setSaving(false);
    }
  }

  async function batal(po) {
    if (!window.confirm(`Batalkan pesanan ${po.po_no}?`)) return;
    try {
      const res = await api.patch(`/api/pembelian/${po.id}/batal`);
      toast.success(res.message);
      load();
    } catch (err) {
      toast.error(err.message);
    }
  }

  if (loading || !data) return <Spinner label="Menyiapkan pesanan pembelian..." />;

  const r = data.ringkas;
  const totalForm = form
    ? form.items.reduce((s, i) => s + (Number(i.qty) || 0) * (Number(i.unit_cost) || 0), 0)
    : 0;

  return (
    <div>
      <PageHeader title="Pesanan Pembelian" subtitle="Barang yang sudah dipesan ke supplier dan belum tiba">
        {bolehKelola && (
          <button className="btn-primary" onClick={() => setForm(KOSONG())}>
            <Plus size={16} /> Pesanan Baru
          </button>
        )}
        <TombolEkspor path="/api/pembelian" params={{ ...range, status }} nama="pesanan-pembelian" />
      </PageHeader>

      <DateRangeFilter range={range} onChange={setRange}>
        <div className="flex-1">
          <label className="label">Status</label>
          <select className="input" value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">Semua status</option>
            <option value="DIPESAN">Dipesan</option>
            <option value="SEBAGIAN">Diterima sebagian</option>
            <option value="SELESAI">Selesai</option>
            <option value="BATAL">Batal</option>
          </select>
        </div>
      </DateRangeFilter>

      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard label="Jumlah Pesanan" value={r.total} icon={PackageCheck} />
        <StatCard
          label="Masih Ditunggu" value={r.menunggu}
          sub="belum diterima seluruhnya"
          icon={Truck} tone={r.menunggu > 0 ? 'amber' : 'green'}
        />
        <StatCard
          label="Nilai yang Ditunggu" value={rupiahShort(r.nilaiMenunggu)}
          sub="barang dipesan, belum tiba"
          tone={r.nilaiMenunggu > 0 ? 'amber' : 'green'}
        />
        <StatCard
          label="Menunggu Terlama" value={r.terlamaHari ? `${r.terlamaHari} hari` : '—'}
          sub="tanyakan ini lebih dulu ke supplier"
          icon={Clock} tone={r.terlamaHari >= 14 ? 'red' : r.terlamaHari >= 7 ? 'amber' : 'brand'}
        />
      </div>

      <div className="card">
        {data.rows.length === 0 ? (
          <EmptyState
            message="Belum ada pesanan pembelian pada periode ini"
            hint="Catat pesanan agar barang yang sedang ditunggu terlihat sebelum stoknya habis"
          />
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>No. PO</th><th>Tanggal</th><th>Supplier</th><th>Status</th>
                  <th>Barang</th><th>Nilai</th><th>Diterima</th><th>Sisa</th><th>Umur</th>
                  {bolehKelola && <th></th>}
                </tr>
              </thead>
              <tbody>
                {data.rows.map((po) => (
                  <tr key={po.id}>
                    <td className="font-mono text-xs">{po.po_no}</td>
                    <td className="tabular">
                      {dateID(po.order_date)}
                      {po.expected_date && (
                        <p className="text-[11px] text-slate-500">tiba ± {dateID(po.expected_date)}</p>
                      )}
                    </td>
                    <td className="text-sm">{po.supplier_name || '-'}</td>
                    <td><span className={WARNA_STATUS[po.status] || 'badge-slate'}>{po.status_label}</span></td>
                    <td className="tabular text-sm">{po.jumlah_barang}</td>
                    <td className="tabular">{rupiah(po.total)}</td>
                    <td className="tabular text-slate-500">{rupiah(po.total_diterima)}</td>
                    <td className={`tabular font-semibold ${po.sisa > 0 ? 'text-amber-700' : 'text-slate-400'}`}>
                      {po.sisa > 0 ? rupiah(po.sisa) : '—'}
                    </td>
                    <td className="tabular">
                      {po.status === 'DIPESAN' || po.status === 'SEBAGIAN' ? (
                        <span className={po.umur_hari >= 14 ? 'badge-red' : po.umur_hari >= 7 ? 'badge-amber' : 'badge-slate'}>
                          {po.umur_hari} hari
                        </span>
                      ) : (
                        <span className="text-slate-400">—</span>
                      )}
                    </td>
                    {bolehKelola && (
                      <td>
                        <div className="flex gap-1">
                          {(po.status === 'DIPESAN' || po.status === 'SEBAGIAN') && (
                            <button className="btn-ghost !px-2 !py-1 text-emerald-600" onClick={() => bukaTerima(po)} aria-label="Terima barang">
                              <PackageCheck size={15} />
                            </button>
                          )}
                          {po.status === 'DIPESAN' && (
                            <button className="btn-ghost !px-2 !py-1 text-rose-600" onClick={() => batal(po)} aria-label="Batalkan">
                              <XCircle size={15} />
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

      {/* ---------- PESANAN BARU ---------- */}
      <Modal open={!!form} onClose={() => setForm(null)} title="Pesanan Pembelian Baru" wide>
        {form && (
          <form onSubmit={simpan} className="grid gap-3 sm:grid-cols-2">
            <Field label="Supplier *" className="sm:col-span-2">
              <select className="input" required value={form.partner_id} onChange={(e) => setForm({ ...form, partner_id: e.target.value })}>
                <option value="">— pilih supplier —</option>
                {suppliers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
            </Field>
            <Field label="Tanggal Pesan *">
              <input type="date" className="input" required value={form.order_date} onChange={(e) => setForm({ ...form, order_date: e.target.value })} />
            </Field>
            <Field label="Perkiraan Tiba" hint="Dipakai menghitung keterlambatan">
              <input type="date" className="input" value={form.expected_date} onChange={(e) => setForm({ ...form, expected_date: e.target.value })} />
            </Field>
            <Field label="Cara Bayar *" hint="Menentukan akun lawan saat barang diterima">
              <select className="input" value={form.payment} onChange={(e) => setForm({ ...form, payment: e.target.value })}>
                <option value="CREDIT">Tempo (utang supplier)</option>
                <option value="BANK">Transfer bank</option>
                <option value="CASH">Tunai</option>
              </select>
            </Field>
            <Field label="Catatan">
              <input className="input" value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} />
            </Field>

            <div className="sm:col-span-2">
              <div className="mb-2 flex items-center justify-between">
                <label className="label !mb-0">Barang yang Dipesan *</label>
                <button
                  type="button" className="btn-ghost !py-1 text-xs"
                  onClick={() => setForm({ ...form, items: [...form.items, { product_id: '', qty: 1, unit_cost: '' }] })}
                >
                  <Plus size={14} /> Tambah baris
                </button>
              </div>

              <div className="space-y-2">
                {form.items.map((it, i) => (
                  <div key={i} className="grid grid-cols-12 gap-2">
                    <select
                      className="input col-span-6" value={it.product_id}
                      onChange={(e) => setItem(i, { product_id: e.target.value })}
                    >
                      <option value="">— pilih barang —</option>
                      {products.map((p) => <option key={p.id} value={p.id}>{p.sku} — {p.name}</option>)}
                    </select>
                    <input
                      type="number" min="0" step="any" className="input col-span-2" placeholder="Qty"
                      value={it.qty} onChange={(e) => setItem(i, { qty: e.target.value })}
                    />
                    <input
                      type="number" min="0" className="input col-span-3" placeholder="Harga beli"
                      value={it.unit_cost} onChange={(e) => setItem(i, { unit_cost: e.target.value })}
                    />
                    <button
                      type="button" className="btn-ghost col-span-1 !px-2 text-rose-600"
                      onClick={() => setForm({ ...form, items: form.items.filter((_, x) => x !== i) })}
                      aria-label="Hapus baris"
                    >
                      <Trash2 size={15} />
                    </button>
                  </div>
                ))}
              </div>

              <div className="mt-3 flex items-center justify-between rounded-xl bg-slate-50 px-3 py-2.5">
                <span className="text-sm font-semibold text-slate-700">Total Pesanan</span>
                <span className="tabular text-base font-bold text-slate-900">{rupiah(totalForm)}</span>
              </div>
            </div>

            <div className="flex gap-2 sm:col-span-2">
              <button type="button" className="btn-secondary flex-1" onClick={() => setForm(null)}>Batal</button>
              <button type="submit" className="btn-primary flex-1" disabled={saving}>
                {saving ? 'Menyimpan...' : 'Simpan Pesanan'}
              </button>
            </div>
          </form>
        )}
      </Modal>

      {/* ---------- TERIMA BARANG ---------- */}
      <Modal open={!!terima} onClose={() => setTerima(null)} title={`Terima Barang — ${terima?.po_no || ''}`} wide>
        {terima && (
          <form onSubmit={simpanTerima} className="grid gap-3">
            <div className="rounded-xl bg-slate-50 px-3 py-2 text-xs text-slate-600">
              {terima.supplier_name} • dipesan {dateID(terima.order_date)} •
              {' '}nilai {rupiah(terima.total)} • {terima.status_label}
            </div>

            <Field label="Tanggal Terima *">
              <input
                type="date" className="input" required value={terima.receive_date}
                onChange={(e) => setTerima({ ...terima, receive_date: e.target.value })}
              />
            </Field>

            <div>
              <label className="label">Jumlah yang Diterima</label>
              <div className="space-y-2">
                {terima.lines.map((l, i) => (
                  <div key={l.item_id} className="grid grid-cols-12 items-center gap-2">
                    <span className="col-span-7 text-sm text-slate-700">
                      {l.nama}
                      <span className="ml-2 text-xs text-slate-500">sisa {l.maks} {l.unit}</span>
                    </span>
                    <input
                      type="number" min="0" max={l.maks} step="any" className="input col-span-4"
                      value={l.qty}
                      onChange={(e) => {
                        const lines = [...terima.lines];
                        lines[i] = { ...lines[i], qty: e.target.value };
                        setTerima({ ...terima, lines });
                      }}
                    />
                    <span className="col-span-1 text-xs text-slate-500">{l.unit}</span>
                  </div>
                ))}
              </div>
              <p className="mt-2 text-[11px] text-slate-500">
                Isi lebih kecil dari sisa bila barang datang bertahap. Menerima barang menambah stok,
                memperbarui HPP rata-rata, dan membentuk jurnalnya.
              </p>
            </div>

            <div className="flex gap-2">
              <button type="button" className="btn-secondary flex-1" onClick={() => setTerima(null)}>Batal</button>
              <button type="submit" className="btn-primary flex-1" disabled={saving}>
                {saving ? 'Memproses...' : 'Terima Barang'}
              </button>
            </div>
          </form>
        )}
      </Modal>
    </div>
  );
}
