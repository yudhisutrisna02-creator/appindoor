import { useEffect, useState, useCallback, useMemo } from 'react';
import { Undo2, Plus, PackageCheck, Pencil } from 'lucide-react';
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

/** Hari terakhir sebuah bulan YYYY-MM. */
function akhirBulan(bulan) {
  const [th, bl] = String(bulan).split('-').map(Number);
  const hari = new Date(th, bl, 0).getDate();
  return `${bulan}-${String(hari).padStart(2, '0')}`;
}

/** Satu baris keterangan pada kartu ringkas order. */
function Baris({ label, nilai, tebal }) {
  return (
    <div className="flex justify-between gap-3">
      <span className="text-slate-500">{label}</span>
      <span className={tebal ? 'tabular font-semibold text-slate-900' : 'text-slate-700'}>
        {nilai}
      </span>
    </div>
  );
}

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
  const [orders, setOrders] = useState([]);
  const [memuatOrder, setMemuatOrder] = useState(false);
  const [orderDetail, setOrderDetail] = useState(null);

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
    setOrderDetail(null);
    setForm({
      id: null,
      return_no: null,
      return_date: today(),
      sumber: 'ORDER',
      bulan: today().slice(0, 7),
      cariOrder: '',
      order_id: '',
      product_id: '',
      qty: 1,
      price: '',
      kondisi: 'BAGUS',
      reason: '',
    });
  }

  /**
   * Membuka retur yang sudah tersimpan.
   *
   * Sengaja dibuka sebagai "isi manual" walau ordernya diketahui: produk dan
   * harganya sudah tercatat pada returnya sendiri, dan memuat ulang daftar
   * order hanya untuk menampilkan nama yang sama hanya memperlambat tanpa
   * menambah apa pun.
   */
  function openUbah(r) {
    setOrderDetail(null);
    setForm({
      id: r.id,
      return_no: r.return_no,
      return_date: r.return_date,
      sumber: 'MANUAL',
      bulan: String(r.return_date).slice(0, 7),
      cariOrder: '',
      order_id: r.order_id || '',
      product_id: String(r.product_id),
      qty: r.qty,
      price: r.price,
      kondisi: kondisiDari(r),
      reason: r.reason || '',
      asal: {
        order_ref: r.order_ref, order_no: r.order_no,
        tracking_no: r.tracking_no, buyer_name: r.buyer_name,
      },
    });
  }

  async function pilihOrder(id) {
    setForm((f) => ({ ...f, order_id: id, product_id: '', price: '', qty: 1 }));
    setOrderDetail(null);
    if (!id) return;
    try {
      setOrderDetail(await api.get(`/api/sales/${id}`));
    } catch (err) {
      toast.error(err.message);
    }
  }

  function pilihProduk(id) {
    const baris = pilihanProduk.find((p) => String(p.id) === String(id));
    setForm((f) => ({
      ...f,
      product_id: id,
      // Harga diambil dari harga yang benar-benar dibayar pembeli pada order
      // itu, bukan harga katalog hari ini — harga katalog bisa sudah berubah,
      // dan yang dikembalikan adalah uang yang dulu diterima.
      price: baris && baris.harga_order != null ? baris.harga_order : (baris?.price ?? f.price),
      qty: baris && baris.sisa_retur != null ? Math.min(Number(f.qty) || 1, baris.sisa_retur) : f.qty,
    }));
  }

  async function submit(e) {
    e.preventDefault();
    setSaving(true);
    try {
      const isi = {
        return_date: form.return_date,
        order_id: form.order_id ? Number(form.order_id) : null,
        product_id: Number(form.product_id),
        qty: Number(form.qty),
        price: Number(form.price),
        kondisi: form.kondisi,
        reason: form.reason || null,
      };
      const res = form.id
        ? await api.put(`/api/sales/returns/${form.id}`, isi)
        : await api.post('/api/sales/returns', isi);
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

  // Daftar order pada bulan yang dipilih. Dimuat ulang saat bulan atau kata
  // pencariannya berubah, disaring di peladen supaya mengenai seluruh order
  // bulan itu — bukan hanya yang kebetulan termuat lebih dulu.
  const bulanOrder = form?.sumber === 'ORDER' ? form.bulan : null;
  const cariOrder = form?.sumber === 'ORDER' ? form.cariOrder : '';

  useEffect(() => {
    if (!bulanOrder) { setOrders([]); return undefined; }
    let batal = false;
    const jeda = setTimeout(() => {
      setMemuatOrder(true);
      api.get('/api/sales', {
        from: `${bulanOrder}-01`, to: akhirBulan(bulanOrder),
        q: cariOrder.trim().length >= 2 ? cariOrder.trim() : undefined,
        limit: 300,
      })
        .then((d) => { if (!batal) setOrders(d.rows || []); })
        .catch(() => { if (!batal) setOrders([]); })
        .finally(() => { if (!batal) setMemuatOrder(false); });
    }, 300);
    return () => { batal = true; clearTimeout(jeda); };
  }, [bulanOrder, cariOrder]);

  /**
   * Produk yang boleh dipilih.
   *
   * Bila returnya berasal dari sebuah order, pilihannya HANYA barang yang
   * memang ada di order itu — beserta jumlah yang dibeli dan sisa yang masih
   * boleh diretur. Membiarkan seluruh katalog terbuka membuat orang bisa
   * meretur barang yang tidak pernah dikirim ke pembeli itu.
   */
  const pilihanProduk = useMemo(() => {
    if (form?.sumber !== 'ORDER' || !orderDetail) return products;
    const perProduk = new Map();
    for (const it of orderDetail.items || []) {
      const k = it.product_id;
      const a = perProduk.get(k) || { qty: 0, harga: it.price, nama: it.product_name, sku: it.sku, unit: it.unit };
      a.qty += it.qty;
      perProduk.set(k, a);
    }
    return [...perProduk.entries()].map(([id, a]) => ({
      id,
      sku: a.sku,
      name: a.nama,
      unit: a.unit,
      qty_order: a.qty,
      harga_order: a.harga,
      // Yang sudah pernah diretur dari order ini tidak boleh diretur lagi.
      // Angkanya datang dari peladen, bukan dihitung dari daftar di layar yang
      // bisa terpotong rentang tanggal.
      sisa_retur: Math.max(0, a.qty - ((orderDetail.retur || {})[id] || 0)),
    }));
  }, [form?.sumber, orderDetail, products]);

  const barisOrder = pilihanProduk.find(
    (p) => String(p.id) === String(form?.product_id) && p.sisa_retur != null
  );
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
                      <th>No. Retur</th><th>Tanggal</th><th>Order / Resi</th>
                      <th>Produk</th><th>Qty</th>
                      <th>Harga</th><th>Nilai</th><th>Kondisi</th><th>Alasan</th><th />
                    </tr>
                  </thead>
                  <tbody>
                    {data.rows.map((r) => (
                      <tr key={r.id}>
                        <td className="font-mono text-xs">{r.return_no}</td>
                        <td className="tabular">{dateID(r.return_date)}</td>
                        <td className="text-xs">
                          {r.order_id ? (
                            <>
                              <span className="block font-medium text-slate-700">
                                {r.order_ref || r.order_no}
                              </span>
                              <span className="block text-slate-400">
                                {r.tracking_no || 'resi belum ada'}
                              </span>
                            </>
                          ) : (
                            <span className="text-slate-400">tanpa order</span>
                          )}
                        </td>
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
                        <td className="text-right">
                          <button
                            type="button" onClick={() => openUbah(r)}
                            className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700"
                            aria-label={`Ubah retur ${r.return_no}`}
                          >
                            <Pencil size={15} />
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr className="border-t-2 border-slate-200 bg-slate-50 font-bold">
                      <td colSpan={6} className="px-3 py-3 text-right">TOTAL</td>
                      <td className="tabular px-3 py-3">{rupiah(data.total)}</td>
                      <td colSpan={3} />
                    </tr>
                  </tfoot>
                </table>
              </div>
            )}
          </div>
        </>
      )}

      <Modal open={!!form} onClose={() => setForm(null)} title={form?.id ? `Ubah Retur — ${form.return_no}` : "Catat Retur Penjualan"} wide>
        {form && (
          <form onSubmit={submit} className="grid gap-3 sm:grid-cols-2">
            <Field label="Tanggal Retur *">
              <input
                type="date" className="input" required value={form.return_date}
                onChange={(e) => setForm({ ...form, return_date: e.target.value })}
              />
            </Field>
            <Field label="Ambil Dari" hint="Order asal mengisi produk, harga, dan resinya sendiri">
              <select
                className="input" value={form.sumber}
                onChange={(e) => setForm({
                  ...form, sumber: e.target.value,
                  order_id: '', product_id: '', qty: 1, price: '',
                })}
              >
                <option value="ORDER">Order penjualan</option>
                <option value="MANUAL">Tanpa order (isi manual)</option>
              </select>
            </Field>

            {form.sumber === 'ORDER' && (
              <>
                <Field label="Bulan Order *" className="sm:col-span-1">
                  <input
                    type="month" className="input" value={form.bulan}
                    onChange={(e) => setForm({ ...form, bulan: e.target.value, order_id: '', product_id: '', price: '' })}
                  />
                </Field>
                <Field label="Cari Order" hint="No. pesanan, no. resi, nama pembeli, atau toko">
                  <input
                    className="input" placeholder="mis. SPX-123 atau JP1234567890"
                    value={form.cariOrder}
                    onChange={(e) => setForm({ ...form, cariOrder: e.target.value })}
                  />
                </Field>

                <Field
                  label="Order Penjualan *"
                  className="sm:col-span-2"
                  hint={memuatOrder ? 'Memuat...' : `${orders.length} order pada bulan ini`}
                >
                  <select
                    className="input" required value={form.order_id}
                    onChange={(e) => pilihOrder(e.target.value)}
                  >
                    <option value="">— pilih order —</option>
                    {orders.map((o) => (
                      <option key={o.id} value={o.id}>
                        {dateID(o.order_date)} · {o.order_ref || o.order_no}
                        {o.tracking_no ? ` · resi ${o.tracking_no}` : ' · resi belum ada'}
                        {o.buyer_name ? ` · ${o.buyer_name}` : ''}
                      </option>
                    ))}
                  </select>
                </Field>

                {orderDetail && (
                  <div className="sm:col-span-2 grid gap-x-6 gap-y-1 rounded-xl bg-slate-50 p-3 text-xs sm:grid-cols-2">
                    <Baris label="No. Pesanan" nilai={orderDetail.order.order_ref || orderDetail.order.order_no} />
                    <Baris
                      label="No. Resi"
                      nilai={orderDetail.order.tracking_no || '— belum ada —'}
                      tebal={!!orderDetail.order.tracking_no}
                    />
                    <Baris label="Ekspedisi" nilai={orderDetail.order.courier || '—'} />
                    <Baris label="Pembeli" nilai={orderDetail.order.buyer_name || orderDetail.order.customer || '—'} />
                  </div>
                )}
              </>
            )}

            <Field
              label="Produk *"
              className="sm:col-span-2"
              hint={form.sumber === 'ORDER' && !form.order_id ? 'Pilih ordernya dulu' : undefined}
            >
              <select
                className="input" required value={form.product_id}
                disabled={form.sumber === 'ORDER' && !form.order_id}
                onChange={(e) => pilihProduk(e.target.value)}
              >
                <option value="">— pilih produk —</option>
                {pilihanProduk.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.sku} — {p.name}
                    {p.qty_order != null ? ` (dibeli ${num(p.qty_order)}, sisa bisa diretur ${num(p.sisa_retur)})` : ''}
                  </option>
                ))}
              </select>
            </Field>

            <Field
              label="Qty Retur *"
              hint={barisOrder ? `Maksimal ${num(barisOrder.sisa_retur)} ${barisOrder.unit || ''}` : undefined}
            >
              <input
                type="number" min="0" step="any" className="input" required value={form.qty}
                max={barisOrder ? barisOrder.sisa_retur : undefined}
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
                {saving ? 'Menyimpan...' : form.id ? 'Simpan Perubahan' : 'Simpan Retur'}
              </button>
            </div>
          </form>
        )}
      </Modal>
    </div>
  );
}
