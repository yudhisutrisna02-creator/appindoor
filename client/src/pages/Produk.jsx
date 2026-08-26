import { useEffect, useState, useCallback } from 'react';
import { Plus, Pencil, Trash2, Search, Package } from 'lucide-react';
import { api } from '../lib/api';
import { PageHeader, Spinner, EmptyState, Modal, useToast, Field } from '../components/ui';
import { rupiah, num, pct } from '../lib/format';
import { useAuth } from '../lib/auth';

const EMPTY = {
  sku: '', name: '', category: 'Umum', unit: 'PCS',
  cost: 0, price: 0, min_stock: 0, supplier_id: null, active: true,
};

export default function Produk() {
  const toast = useToast();
  const { canManage, isAdmin } = useAuth();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [q, setQ] = useState('');
  const [category, setCategory] = useState('');
  const [supplierId, setSupplierId] = useState('');
  const [suppliers, setSuppliers] = useState([]);
  const [editing, setEditing] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setData(await api.get('/api/inventory/products', { q, category, supplier_id: supplierId }));
    } catch (err) {
      toast.error(err.message);
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, category, supplierId]);

  useEffect(() => {
    api.get('/api/partners', { kind: 'SUPPLIER' }).then((d) => setSuppliers(d.partners)).catch(() => {});
  }, []);

  // Pencarian ditunda sesaat agar tidak memanggil API pada setiap ketikan.
  useEffect(() => {
    const timer = setTimeout(load, 250);
    return () => clearTimeout(timer);
  }, [load]);

  async function save(e) {
    e.preventDefault();
    const payload = {
      ...editing,
      cost: Number(editing.cost),
      price: Number(editing.price),
      min_stock: Number(editing.min_stock),
      supplier_id: editing.supplier_id ? Number(editing.supplier_id) : null,
    };
    try {
      if (editing.id) {
        await api.put(`/api/inventory/products/${editing.id}`, payload);
        toast.success('Produk diperbarui');
      } else {
        await api.post('/api/inventory/products', payload);
        toast.success('Produk ditambahkan');
      }
      setEditing(null);
      load();
    } catch (err) {
      toast.error(err.message);
    }
  }

  async function remove(p) {
    if (!window.confirm(`Hapus produk "${p.name}"? Produk yang pernah dipakai transaksi akan dinonaktifkan saja.`)) return;
    try {
      const res = await api.del(`/api/inventory/products/${p.id}`);
      toast.success(res.message);
      load();
    } catch (err) {
      toast.error(err.message);
    }
  }

  return (
    <div>
      <PageHeader title="Master Produk" subtitle="SKU, kategori, unit, HPP, dan harga jual base">
        {canManage && (
          <button className="btn-primary" onClick={() => setEditing({ ...EMPTY })}>
            <Plus size={16} /> Produk Baru
          </button>
        )}
      </PageHeader>

      <div className="card mb-4 flex flex-col gap-3 sm:flex-row">
        <div className="relative flex-1">
          <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
          <input
            className="input pl-9" placeholder="Cari SKU atau nama produk..."
            value={q} onChange={(e) => setQ(e.target.value)}
          />
        </div>
        <select className="input sm:w-52" value={category} onChange={(e) => setCategory(e.target.value)}>
          <option value="">Semua Kategori</option>
          {data?.categories.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
        <select className="input sm:w-52" value={supplierId} onChange={(e) => setSupplierId(e.target.value)}>
          <option value="">Semua Pemasok</option>
          {suppliers.map((sp) => <option key={sp.id} value={sp.id}>{sp.name}</option>)}
        </select>
      </div>

      {loading ? (
        <Spinner />
      ) : (
        <div className="card">
          <div className="mb-3 flex items-center justify-between text-sm">
            <span className="text-slate-500">{data.products.length} produk</span>
            <span className="font-semibold text-slate-900">Total nilai: {rupiah(data.totalValue)}</span>
          </div>

          {data.products.length === 0 ? (
            <EmptyState message="Belum ada produk" hint="Klik “Produk Baru” untuk menambahkan SKU pertama" />
          ) : (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>Produk</th><th>Pemasok</th><th>Stok</th>
                    <th>HPP</th><th>Harga Jual</th><th>Margin</th><th>Nilai</th>
                    {canManage && <th>Aksi</th>}
                  </tr>
                </thead>
                <tbody>
                  {data.products.map((p) => (
                    <tr key={p.id}>
                      {/* SKU disatukan dengan nama agar tabel muat tanpa
                          memotong kolom Aksi di layar sempit. */}
                      <td>
                        <p className="font-medium text-slate-900">{p.name}</p>
                        <p className="font-mono text-xs text-slate-400">
                          {p.sku}
                          {!p.active && <span className="badge-slate ml-2">nonaktif</span>}
                        </p>
                      </td>
                      <td className="text-xs">
                        {p.supplier_name
                          ? <span className="text-slate-600">{p.supplier_name}</span>
                          : <span className="text-slate-400">belum diisi</span>}
                      </td>
                      <td className="tabular">
                        <span
                          className={
                            p.out_of_stock ? 'font-semibold text-rose-600'
                              : p.low_stock ? 'font-semibold text-amber-600'
                              : ''
                          }
                        >
                          {num(p.stock)} {p.unit}
                        </span>
                      </td>
                      <td className="tabular">{rupiah(p.cost)}</td>
                      <td className="tabular">{rupiah(p.price)}</td>
                      <td className="tabular">
                        {/* Margin tidak bermakna selama harga jual belum diisi */}
                        {p.margin_base === null ? (
                          <span className="text-xs text-slate-400">belum ada harga jual</span>
                        ) : (
                          <span className={p.margin_base >= 0 ? 'text-emerald-600' : 'text-rose-600'}>
                            {rupiah(p.margin_base)} ({pct(p.margin_base_pct)})
                          </span>
                        )}
                      </td>
                      <td className="tabular font-semibold">{rupiah(p.stock_value)}</td>
                      {canManage && (
                        <td>
                          <div className="flex gap-1">
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

      <Modal open={!!editing} onClose={() => setEditing(null)} title={editing?.id ? 'Ubah Produk' : 'Produk Baru'}>
        {editing && (
          <form onSubmit={save} className="grid gap-3 sm:grid-cols-2">
            <Field label="SKU *">
              <input className="input" required value={editing.sku} onChange={(e) => setEditing({ ...editing, sku: e.target.value })} />
            </Field>
            <Field label="Kategori">
              <input className="input" list="kategori-list" value={editing.category} onChange={(e) => setEditing({ ...editing, category: e.target.value })} />
              <datalist id="kategori-list">
                {data?.categories.map((c) => <option key={c} value={c} />)}
              </datalist>
            </Field>
            <Field label="Nama Produk *" className="sm:col-span-2">
              <input className="input" required value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} />
            </Field>
            <Field label="Pemasok" hint="Supplier utama barang ini" className="sm:col-span-2">
              <select
                className="input"
                value={editing.supplier_id || ''}
                onChange={(e) => setEditing({ ...editing, supplier_id: e.target.value || null })}
              >
                <option value="">— belum ditentukan —</option>
                {suppliers.map((sp) => <option key={sp.id} value={sp.id}>{sp.name}</option>)}
              </select>
            </Field>

            <Field label="Unit">
              <input className="input" value={editing.unit} onChange={(e) => setEditing({ ...editing, unit: e.target.value })} placeholder="PCS / BOX / KG" />
            </Field>
            <Field label="Stok Minimum">
              <input type="number" min="0" step="any" className="input" value={editing.min_stock} onChange={(e) => setEditing({ ...editing, min_stock: e.target.value })} />
            </Field>
            <Field label="HPP per Unit (Rp)" hint={editing.id ? 'Diperbarui otomatis oleh mutasi stok masuk' : 'HPP awal'}>
              <input type="number" min="0" step="any" className="input" value={editing.cost} onChange={(e) => setEditing({ ...editing, cost: e.target.value })} />
            </Field>
            <Field label="Harga Jual Base (Rp)">
              <input type="number" min="0" step="any" className="input" value={editing.price} onChange={(e) => setEditing({ ...editing, price: e.target.value })} />
            </Field>

            <label className="flex items-center gap-2 text-sm sm:col-span-2">
              <input type="checkbox" className="h-4 w-4 rounded" checked={editing.active} onChange={(e) => setEditing({ ...editing, active: e.target.checked })} />
              Produk aktif dan dapat dijual
            </label>

            {Number(editing.price) > 0 && (
              <p className="rounded-xl bg-brand-50 p-3 text-xs text-brand-800 sm:col-span-2">
                <Package size={13} className="mr-1 inline" />
                Margin kotor base: {rupiah(Number(editing.price) - Number(editing.cost))}{' '}
                ({(((Number(editing.price) - Number(editing.cost)) / Number(editing.price)) * 100).toFixed(2)}%)
              </p>
            )}

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
