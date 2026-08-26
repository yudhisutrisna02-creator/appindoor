import { useEffect, useState, useCallback } from 'react';
import { Undo2, Plus, PackageCheck } from 'lucide-react';
import { api } from '../lib/api';
import {
  PageHeader, StatCard, Spinner, EmptyState, Modal,
  DateRangeFilter, defaultRange, useToast, Field, TombolEkspor } from '../components/ui';
import { rupiah, num, today, dateID } from '../lib/format';

export default function Retur() {
  const toast = useToast();
  const [range, setRange] = useState(defaultRange);
  const [data, setData] = useState(null);
  const [products, setProducts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [form, setForm] = useState(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setData(await api.get('/api/sales/returns/list', range));
    } catch (err) {
      toast.error(err.message);
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [range]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    api.get('/api/inventory/products').then((d) => setProducts(d.products)).catch(() => {});
  }, []);

  function openForm() {
    setForm({
      return_date: today(),
      order_id: '',
      product_id: '',
      qty: 1,
      price: '',
      restock: true,
      reason: '',
    });
  }

  async function submit(e) {
    e.preventDefault();
    setSaving(true);
    try {
      const res = await api.post('/api/sales/returns', {
        return_date: form.return_date,
        order_id: form.order_id ? Number(form.order_id) : null,
        product_id: Number(form.product_id),
        qty: Number(form.qty),
        price: Number(form.price),
        restock: form.restock,
        reason: form.reason || null,
      });
      toast.success(`Retur ${res.return_no} tercatat senilai ${rupiah(res.amount)}`);
      setForm(null);
      load();
      api.get('/api/inventory/products').then((d) => setProducts(d.products));
    } catch (err) {
      toast.error(err.message);
    } finally {
      setSaving(false);
    }
  }

  const dipilih = products.find((p) => p.id === Number(form?.product_id));

  return (
    <div>
      <PageHeader
        title="Retur Penjualan"
        subtitle="Barang yang dikembalikan pelanggan — mengurangi penjualan bersih di Laba Rugi"
      >
        <button className="btn-primary" onClick={openForm}>
          <Plus size={16} /> Catat Retur
        </button>
        <TombolEkspor path="/api/sales/returns/list" params={range} nama="retur-penjualan" />
      </PageHeader>

      <DateRangeFilter range={range} onChange={setRange} />

      {loading || !data ? (
        <Spinner />
      ) : (
        <>
          <div className="mb-4 grid grid-cols-1 gap-3 sm:grid-cols-3">
            <StatCard label="Jumlah Retur" value={data.rows.length} icon={Undo2} tone="amber" />
            <StatCard label="Nilai Retur" value={rupiah(data.total)} icon={Undo2} tone="red" />
            <StatCard
              label="Kembali ke Gudang"
              value={data.rows.filter((r) => r.restock).length}
              sub={`${data.rows.filter((r) => !r.restock).length} tidak dikembalikan (rusak)`}
              icon={PackageCheck} tone="green"
            />
          </div>

          <div className="card">
            {data.rows.length === 0 ? (
              <EmptyState
                message="Belum ada retur pada rentang ini"
                hint="Bagus — artinya tidak ada barang yang dikembalikan pelanggan"
              />
            ) : (
              <div className="table-wrap">
                <table className="table">
                  <thead>
                    <tr>
                      <th>No. Retur</th><th>Tanggal</th><th>Produk</th><th>Qty</th>
                      <th>Harga</th><th>Nilai</th><th>Masuk Gudang</th><th>Alasan</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.rows.map((r) => (
                      <tr key={r.id}>
                        <td className="font-mono text-xs">{r.return_no}</td>
                        <td className="tabular">{dateID(r.return_date)}</td>
                        <td>
                          <p className="font-medium text-slate-900">{r.product_name}</p>
                          <p className="text-xs text-slate-400">{r.sku}</p>
                        </td>
                        <td className="tabular">{num(r.qty)}</td>
                        <td className="tabular">{rupiah(r.price)}</td>
                        <td className="tabular font-semibold text-rose-600">{rupiah(r.amount)}</td>
                        <td>
                          {r.restock
                            ? <span className="badge-green">Ya</span>
                            : <span className="badge-slate">Tidak</span>}
                        </td>
                        <td className="max-w-[200px] truncate text-xs text-slate-500">{r.reason || '-'}</td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr className="border-t-2 border-slate-200 bg-slate-50 font-bold">
                      <td colSpan={5} className="px-3 py-3 text-right">TOTAL</td>
                      <td className="tabular px-3 py-3">{rupiah(data.total)}</td>
                      <td colSpan={2} />
                    </tr>
                  </tfoot>
                </table>
              </div>
            )}
          </div>
        </>
      )}

      <Modal open={!!form} onClose={() => setForm(null)} title="Catat Retur Penjualan">
        {form && (
          <form onSubmit={submit} className="grid gap-3 sm:grid-cols-2">
            <Field label="Tanggal Retur *">
              <input
                type="date" className="input" required value={form.return_date}
                onChange={(e) => setForm({ ...form, return_date: e.target.value })}
              />
            </Field>
            <Field label="ID Order Terkait" hint="Opsional">
              <input
                type="number" className="input" value={form.order_id}
                onChange={(e) => setForm({ ...form, order_id: e.target.value })}
              />
            </Field>

            <Field label="Produk *" className="sm:col-span-2">
              <select
                className="input" required value={form.product_id}
                onChange={(e) => {
                  const p = products.find((x) => x.id === Number(e.target.value));
                  setForm({ ...form, product_id: e.target.value, price: form.price || p?.price || '' });
                }}
              >
                <option value="">— pilih produk —</option>
                {products.map((p) => (
                  <option key={p.id} value={p.id}>{p.sku} — {p.name}</option>
                ))}
              </select>
            </Field>

            <Field label="Qty Retur *">
              <input
                type="number" min="0" step="any" className="input" required value={form.qty}
                onChange={(e) => setForm({ ...form, qty: e.target.value })}
              />
            </Field>
            <Field label="Harga Jual / Unit *">
              <input
                type="number" min="0" step="any" className="input" required value={form.price}
                onChange={(e) => setForm({ ...form, price: e.target.value })}
              />
            </Field>

            <Field label="Alasan Retur" className="sm:col-span-2">
              <input
                className="input" maxLength={300} value={form.reason}
                placeholder="mis. kemasan rusak saat pengiriman"
                onChange={(e) => setForm({ ...form, reason: e.target.value })}
              />
            </Field>

            <label className="flex items-center gap-2 text-sm sm:col-span-2">
              <input
                type="checkbox" className="h-4 w-4 rounded" checked={form.restock}
                onChange={(e) => setForm({ ...form, restock: e.target.checked })}
              />
              Barang kembali ke gudang (stok bertambah &amp; HPP dibalik)
            </label>

            {dipilih && form.qty && form.price && (
              <p className="rounded-xl bg-amber-50 p-3 text-xs text-amber-800 sm:col-span-2">
                Nilai retur <strong>{rupiah(Number(form.qty) * Number(form.price))}</strong> akan
                mengurangi penjualan bersih.
                {form.restock && <> Stok {dipilih.name} bertambah menjadi <strong>{num(dipilih.stock + Number(form.qty))} {dipilih.unit}</strong>.</>}
              </p>
            )}

            <div className="flex gap-2 sm:col-span-2">
              <button type="button" className="btn-secondary flex-1" onClick={() => setForm(null)}>Batal</button>
              <button type="submit" className="btn-primary flex-1" disabled={saving}>
                {saving ? 'Menyimpan...' : 'Simpan Retur'}
              </button>
            </div>
          </form>
        )}
      </Modal>
    </div>
  );
}
