import { useEffect, useState, useCallback } from 'react';
import { Undo2, Plus, PackageCheck } from 'lucide-react';
import { api } from '../lib/api';
import {
  PageHeader, StatCard, Spinner, EmptyState, Modal,
  DateRangeFilter, defaultRange, useToast, Field, TombolEkspor,
  KotakCari,
} from '../components/ui';
import { rupiah, num, today, dateID } from '../lib/format';

/**
 * Kondisi barang yang diretur.
 *
 * Diambil dari kenyataan di gudang, bukan dari kerapian sistem: botol kemasan
 * cair yang pecah tidak bisa diselamatkan, sedangkan kemasan aluminium foil
 * yang hanya rusak label cukup dikemas ulang dan bisa dijual kembali.
 */
const KONDISI = [
  {
    nilai: 'BAGUS',
    label: 'Bagus',
    hint: 'Kemasan utuh, langsung masuk stok jual',
  },
  {
    nilai: 'PERBAIKI',
    label: 'Perlu dikemas ulang',
    hint: 'Label atau foil rusak, isinya masih baik',
  },
  {
    nilai: 'RUSAK',
    label: 'Rusak total',
    hint: 'Botol pecah atau isi tumpah, jadi kerugian',
  },
];

const WARNA_KONDISI = {
  BAGUS: 'badge-green',
  PERBAIKI: 'badge-amber',
  RUSAK: 'badge-red',
};

const LABEL_KONDISI = {
  BAGUS: 'Masuk stok',
  PERBAIKI: 'Dikemas ulang',
  RUSAK: 'Kerugian',
};

/** Baris lama hanya punya restock; artinya diterjemahkan apa adanya. */
const kondisiDari = (r) => r.kondisi || (r.restock ? 'BAGUS' : 'RUSAK');

export default function Retur() {
  const toast = useToast();
  const [range, setRange] = useState(defaultRange);
  const [q, setQ] = useState('');
  const [data, setData] = useState(null);
  const [products, setProducts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [form, setForm] = useState(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setData(await api.get('/api/sales/returns/list', { ...range, q }));
    } catch (err) {
      toast.error(err.message);
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [range, q]);

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
      kondisi: 'BAGUS',
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
        kondisi: form.kondisi,
        reason: form.reason || null,
      });
      toast.success(`${res.message} — senilai ${rupiah(res.amount)}`);
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

      <DateRangeFilter range={range} onChange={setRange}>
        <div className="flex-[2]">
          <label className="label">Cari</label>
          <KotakCari nilai={q} onCari={setQ} placeholder="Nama produk, SKU, no. retur, alasan..." />
        </div>
      </DateRangeFilter>

      {loading || !data ? (
        <Spinner />
      ) : (
        <>
          <div className="mb-4 grid grid-cols-1 gap-3 sm:grid-cols-3">
            <StatCard label="Jumlah Retur" value={data.rows.length} icon={Undo2} tone="amber" />
            <StatCard label="Nilai Retur" value={rupiah(data.total)} icon={Undo2} tone="red" />
            <StatCard
              label="Kembali ke Stok Jual"
              value={data.rows.filter((r) => kondisiDari(r) === 'BAGUS').length}
              sub={`${data.rows.filter((r) => kondisiDari(r) === 'PERBAIKI').length} perlu dikemas ulang • ${data.rows.filter((r) => kondisiDari(r) === 'RUSAK').length} rusak total`}
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
                      <th>Harga</th><th>Nilai</th><th>Kondisi</th><th>Alasan</th>
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
                          <span className={WARNA_KONDISI[kondisiDari(r)]}>
                            {LABEL_KONDISI[kondisiDari(r)]}
                          </span>
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

            {/* Tiga kemungkinan, bukan dua. Botol pecah memang langsung jadi
                kerugian, tetapi kemasan foil yang labelnya rusak cukup dikemas
                ulang dan bisa dijual lagi — dan selama dikerjakan, barangnya
                harus tetap tercatat di suatu tempat. */}
            <Field label="Kondisi Barang *" className="sm:col-span-2">
              <div className="grid gap-2 sm:grid-cols-3">
                {KONDISI.map((k) => (
                  <label
                    key={k.nilai}
                    className={`cursor-pointer rounded-xl border p-2.5 text-left transition ${
                      form.kondisi === k.nilai
                        ? 'border-brand-500 bg-brand-50 ring-1 ring-brand-400'
                        : 'border-slate-200 hover:border-slate-300'
                    }`}
                  >
                    <span className="flex items-center gap-2">
                      <input
                        type="radio" name="kondisi" className="h-4 w-4"
                        checked={form.kondisi === k.nilai}
                        onChange={() => setForm({ ...form, kondisi: k.nilai })}
                      />
                      <span className="text-sm font-medium text-slate-800">{k.label}</span>
                    </span>
                    <span className="mt-1 block pl-6 text-[11px] leading-snug text-slate-500">
                      {k.hint}
                    </span>
                  </label>
                ))}
              </div>
            </Field>

            {dipilih && form.qty && form.price && (
              <p className="rounded-xl bg-amber-50 p-3 text-xs leading-relaxed text-amber-800 sm:col-span-2">
                Nilai retur <strong>{rupiah(Number(form.qty) * Number(form.price))}</strong> akan
                mengurangi penjualan bersih — berlaku untuk ketiga kondisi.
                {form.kondisi === 'BAGUS' && (
                  <> Stok {dipilih.name} bertambah menjadi{' '}
                  <strong>{num(dipilih.stock + Number(form.qty))} {dipilih.unit}</strong>.</>
                )}
                {form.kondisi === 'PERBAIKI' && (
                  <> Stok belum bertambah. Barangnya masuk daftar{' '}
                  <strong>Barang Perlu Perbaikan</strong> di menu Gudang, dan baru masuk stok jual
                  setelah ditandai selesai di sana.</>
                )}
                {form.kondisi === 'RUSAK' && (
                  <> Stok tidak bertambah dan nilainya dicatat sebagai{' '}
                  <strong>kerugian barang rusak</strong>.</>
                )}
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
