import { useEffect, useState, useCallback } from 'react';
import { ArrowDownToLine, ArrowUpFromLine, Plus, Package } from 'lucide-react';
import { api } from '../lib/api';
import { PageHeader, StatCard, Spinner, EmptyState, Modal, DateRangeFilter, defaultRange, useToast, Field } from '../components/ui';
import { rupiah, num, today } from '../lib/format';

const TYPE_BADGE = { IN: 'badge-green', OUT: 'badge-red', ADJ: 'badge-amber' };
const TYPE_LABEL = { IN: 'Masuk', OUT: 'Keluar', ADJ: 'Koreksi' };

export default function MutasiStok() {
  const toast = useToast();
  const [range, setRange] = useState(defaultRange);
  const [moveType, setMoveType] = useState('');
  const [data, setData] = useState(null);
  const [products, setProducts] = useState([]);
  const [suppliers, setSuppliers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [form, setForm] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setData(await api.get('/api/inventory/moves', { ...range, move_type: moveType }));
    } catch (err) {
      toast.error(err.message);
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [range, moveType]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    api.get('/api/inventory/products').then((d) => setProducts(d.products)).catch(() => {});
    api.get('/api/partners', { kind: 'SUPPLIER' }).then((d) => setSuppliers(d.partners)).catch(() => {});
  }, []);

  function openForm(type) {
    setForm({
      move_type: type,
      product_id: '',
      move_date: today(),
      qty: '',
      unit_cost: '',
      payment: 'CASH',
      partner_id: '',
      ref: '',
      note: '',
    });
  }

  const selected = products.find((p) => p.id === Number(form?.product_id));

  async function submit(e) {
    e.preventDefault();
    try {
      const payload = {
        product_id: Number(form.product_id),
        move_date: form.move_date,
        move_type: form.move_type,
        qty: Number(form.qty),
        payment: form.payment,
        partner_id: form.partner_id ? Number(form.partner_id) : null,
        ref: form.ref || null,
        note: form.note || null,
      };
      if (form.move_type === 'IN' && form.unit_cost !== '') payload.unit_cost = Number(form.unit_cost);

      await api.post('/api/inventory/moves', payload);
      toast.success(`Mutasi stok ${TYPE_LABEL[form.move_type].toLowerCase()} tersimpan & jurnal terbentuk`);
      setForm(null);
      load();
      api.get('/api/inventory/products').then((d) => setProducts(d.products));
    } catch (err) {
      toast.error(err.message);
    }
  }

  return (
    <div>
      <PageHeader title="Mutasi Stok" subtitle="Log stok masuk & keluar — otomatis membentuk jurnal persediaan">
        <button className="btn-primary" onClick={() => openForm('IN')}>
          <ArrowDownToLine size={16} /> Stok Masuk
        </button>
        <button className="btn-secondary" onClick={() => openForm('OUT')}>
          <ArrowUpFromLine size={16} /> Stok Keluar
        </button>
      </PageHeader>

      <DateRangeFilter range={range} onChange={setRange}>
        <div className="flex-1">
          <label className="label">Jenis Mutasi</label>
          <select className="input" value={moveType} onChange={(e) => setMoveType(e.target.value)}>
            <option value="">Semua</option>
            <option value="IN">Masuk</option>
            <option value="OUT">Keluar</option>
            <option value="ADJ">Koreksi Opname</option>
          </select>
        </div>
      </DateRangeFilter>

      {loading ? (
        <Spinner />
      ) : (
        <>
          <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
            <StatCard label="Qty Masuk" value={num(data.summary.inQty)} icon={ArrowDownToLine} tone="green" />
            <StatCard label="Nilai Masuk" value={rupiah(data.summary.inValue)} icon={ArrowDownToLine} tone="green" />
            <StatCard label="Qty Keluar" value={num(data.summary.outQty)} icon={ArrowUpFromLine} tone="red" />
            <StatCard label="Nilai Keluar" value={rupiah(data.summary.outValue)} icon={ArrowUpFromLine} tone="red" />
          </div>

          <div className="card">
            {data.rows.length === 0 ? (
              <EmptyState message="Belum ada mutasi pada rentang ini" />
            ) : (
              <div className="table-wrap">
                <table className="table">
                  <thead>
                    <tr>
                      <th>Tanggal</th><th>Jenis</th><th>Produk</th><th>Qty</th>
                      <th>HPP/Unit</th><th>Nilai</th><th>Saldo Akhir</th><th>Ref</th><th>Sumber</th><th>Petugas</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.rows.map((m) => (
                      <tr key={m.id}>
                        <td className="tabular">{m.move_date}</td>
                        <td><span className={TYPE_BADGE[m.move_type]}>{TYPE_LABEL[m.move_type]}</span></td>
                        <td>
                          <p className="font-medium text-slate-900">{m.product_name}</p>
                          <p className="text-xs text-slate-400">{m.sku}</p>
                        </td>
                        <td className={`tabular font-semibold ${m.move_type === 'OUT' ? 'text-rose-600' : 'text-emerald-600'}`}>
                          {m.move_type === 'OUT' ? '−' : '+'}{num(m.qty)} {m.unit}
                        </td>
                        <td className="tabular">{rupiah(m.unit_cost)}</td>
                        <td className="tabular">{rupiah(m.value)}</td>
                        <td className="tabular">{num(m.balance_after)}</td>
                        <td className="text-xs">{m.ref || '-'}</td>
                        <td className="text-xs text-slate-500">{m.source}</td>
                        <td className="text-xs text-slate-500">{m.user_name || '-'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </>
      )}

      <Modal open={!!form} onClose={() => setForm(null)} title={form?.move_type === 'IN' ? 'Catat Stok Masuk' : 'Catat Stok Keluar'}>
        {form && (
          <form onSubmit={submit} className="grid gap-3 sm:grid-cols-2">
            <Field label="Tanggal *">
              <input type="date" className="input" required value={form.move_date} onChange={(e) => setForm({ ...form, move_date: e.target.value })} />
            </Field>
            <Field label="No. Referensi" hint="mis. nomor nota supplier">
              <input className="input" value={form.ref} onChange={(e) => setForm({ ...form, ref: e.target.value })} />
            </Field>

            <Field label="Produk *" className="sm:col-span-2">
              <select className="input" required value={form.product_id} onChange={(e) => setForm({ ...form, product_id: e.target.value })}>
                <option value="">— pilih produk —</option>
                {products.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.sku} — {p.name} (stok {num(p.stock)} {p.unit})
                  </option>
                ))}
              </select>
            </Field>

            <Field label={`Jumlah *${selected ? ` (${selected.unit})` : ''}`}>
              <input type="number" min="0" step="any" className="input" required value={form.qty} onChange={(e) => setForm({ ...form, qty: e.target.value })} />
            </Field>

            {form.move_type === 'IN' ? (
              <Field label="Harga Beli / Unit (Rp)" hint={selected ? `HPP saat ini ${rupiah(selected.cost)} — kosongkan untuk memakai HPP lama` : 'Menentukan HPP rata-rata baru'}>
                <input type="number" min="0" step="any" className="input" value={form.unit_cost} onChange={(e) => setForm({ ...form, unit_cost: e.target.value })} />
              </Field>
            ) : (
              <Field label="HPP Terpakai">
                <input className="input bg-slate-50" readOnly value={selected ? rupiah(selected.cost) : '-'} />
              </Field>
            )}

            {form.move_type === 'IN' && (
              <Field label="Supplier" hint="Wajib bila memakai tempo, agar utang terlacak" className="sm:col-span-2">
                <select className="input" value={form.partner_id} onChange={(e) => setForm({ ...form, partner_id: e.target.value })}>
                  <option value="">— tidak dicatat —</option>
                  {suppliers.map((sp) => <option key={sp.id} value={sp.id}>{sp.name}</option>)}
                </select>
              </Field>
            )}

            {form.move_type === 'IN' && (
              <Field label="Sumber Dana" className="sm:col-span-2">
                <select className="input" value={form.payment} onChange={(e) => setForm({ ...form, payment: e.target.value })}>
                  <option value="CASH">Kas Tunai</option>
                  <option value="BANK">Bank / Transfer</option>
                  <option value="CREDIT">Utang Supplier (tempo)</option>
                </select>
              </Field>
            )}

            <Field label="Catatan" className="sm:col-span-2">
              <input className="input" value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} />
            </Field>

            {selected && form.qty && (
              <p className="rounded-xl bg-brand-50 p-3 text-xs text-brand-800 sm:col-span-2">
                <Package size={13} className="mr-1 inline" />
                Nilai mutasi:{' '}
                <strong>
                  {rupiah(Number(form.qty) * (form.move_type === 'IN' && form.unit_cost !== '' ? Number(form.unit_cost) : selected.cost))}
                </strong>
                {' • '}Saldo stok menjadi{' '}
                <strong>
                  {num(form.move_type === 'IN' ? selected.stock + Number(form.qty) : selected.stock - Number(form.qty))} {selected.unit}
                </strong>
              </p>
            )}

            <div className="flex gap-2 sm:col-span-2">
              <button type="button" className="btn-secondary flex-1" onClick={() => setForm(null)}>Batal</button>
              <button type="submit" className="btn-primary flex-1"><Plus size={16} /> Simpan Mutasi</button>
            </div>
          </form>
        )}
      </Modal>
    </div>
  );
}
