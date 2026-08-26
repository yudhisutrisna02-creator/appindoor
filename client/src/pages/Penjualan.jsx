import { useEffect, useState, useCallback, useMemo } from 'react';
import { Link } from 'react-router-dom';
import { Plus, Trash2, ShoppingCart, FileSpreadsheet, Eye, XCircle, Undo2 } from 'lucide-react';
import { api } from '../lib/api';
import { PageHeader, StatCard, Spinner, EmptyState, Modal, DateRangeFilter, defaultRange, useToast, Field } from '../components/ui';
import { rupiah, rupiahShort, num, pct, today, dateID, CHANNEL_LABEL } from '../lib/format';
import { useAuth } from '../lib/auth';

/** Preset biaya admin tipikal per marketplace — tetap dapat diubah manual. */
const ADMIN_FEE_PRESET = {
  SHOPEE: 8, TOKOPEDIA: 6.5, TIKTOK_SHOP: 8, WEBSITE: 2.9, SOCIAL_MEDIA: 0, OFFLINE_WA: 0,
};

const emptyOrder = () => ({
  order_date: today(),
  channel: 'OFFLINE_WA',
  customer: '',
  partner_id: null,
  marketplace_ref: '',
  shop_id: null,
  order_ref: '',
  courier: '',
  tracking_no: '',
  fulfillment_status: 'DIPROSES',
  payout_date: '',
  shipping_charged: 0,
  buyer_name: '',
  buyer_account: '',
  buyer_phone: '',
  buyer_address: '',
  buyer_city: '',
  lead_source: '',
  items: [{ product_id: '', qty: 1, price: '' }],
  discount: 0,
  admin_fee_pct: 0,
  handling_fee: 0,
  shipping_extra: 0,
  voucher_platform: 0,
  tax_pct: 0,
  packing_cost: 0,
  other_cost: 0,
  payment_status: 'PAID',
  note: '',
});

export default function Penjualan() {
  const toast = useToast();
  const { canManage } = useAuth();
  const [range, setRange] = useState(defaultRange);
  const [channel, setChannel] = useState('');
  const [data, setData] = useState(null);
  const [products, setProducts] = useState([]);
  const [partners, setPartners] = useState([]);
  const [shops, setShops] = useState([]);
  const [loading, setLoading] = useState(true);
  const [form, setForm] = useState(null);
  const [detail, setDetail] = useState(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setData(await api.get('/api/sales', { ...range, channel }));
    } catch (err) {
      toast.error(err.message);
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [range, channel]);

  useEffect(() => { load(); }, [load]);

  const refreshProducts = useCallback(() => {
    api.get('/api/inventory/products').then((d) => setProducts(d.products)).catch(() => {});
  }, []);
  useEffect(() => { refreshProducts(); }, [refreshProducts]);

  useEffect(() => {
    api.get('/api/partners', { kind: 'CUSTOMER' }).then((d) => setPartners(d.partners)).catch(() => {});
    api.get('/api/shops').then((d) => setShops(d.shops)).catch(() => {});
  }, []);

  // ---------- Kalkulasi margin langsung di browser (cermin logika server) ----------
  const calc = useMemo(() => {
    if (!form) return null;
    const lines = form.items.map((it) => {
      const p = products.find((x) => x.id === Number(it.product_id));
      const qty = Number(it.qty) || 0;
      const price = Number(it.price) || 0;
      return { subtotal: qty * price, subcost: qty * (p?.cost || 0) };
    });

    const gross = lines.reduce((s, l) => s + l.subtotal, 0);
    const cogs = lines.reduce((s, l) => s + l.subcost, 0);
    const discount = Number(form.discount) || 0;
    const netRevenue = gross - discount;

    const adminFee = (netRevenue * (Number(form.admin_fee_pct) || 0)) / 100;
    const taxAmount = (netRevenue * (Number(form.tax_pct) || 0)) / 100;
    const fees =
      adminFee + taxAmount +
      (Number(form.handling_fee) || 0) + (Number(form.shipping_extra) || 0) +
      (Number(form.voucher_platform) || 0) + (Number(form.packing_cost) || 0) +
      (Number(form.other_cost) || 0);

    const grossProfit = netRevenue - cogs;
    const netProfit = grossProfit - fees;

    return {
      gross, cogs, discount, netRevenue, adminFee, taxAmount, fees, grossProfit, netProfit,
      marginPct: netRevenue ? (netProfit / netRevenue) * 100 : 0,
    };
  }, [form, products]);

  function setItem(index, patch) {
    const items = [...form.items];
    items[index] = { ...items[index], ...patch };
    // Harga jual otomatis mengikuti harga base produk saat produk dipilih
    if (patch.product_id) {
      const p = products.find((x) => x.id === Number(patch.product_id));
      if (p && !items[index].price) items[index].price = p.price;
    }
    setForm({ ...form, items });
  }

  async function submit(e) {
    e.preventDefault();
    setSaving(true);
    try {
      const payload = {
        ...form,
        customer: form.customer || null,
        partner_id: form.partner_id || null,
        marketplace_ref: form.marketplace_ref || null,
        shop_id: form.shop_id ? Number(form.shop_id) : null,
        order_ref: form.order_ref || null,
        courier: form.courier || null,
        tracking_no: form.tracking_no || null,
        fulfillment_status: form.fulfillment_status,
        payout_date: form.payout_date || null,
        shipping_charged: Number(form.shipping_charged) || 0,
        buyer_name: form.buyer_name || null,
        buyer_account: form.buyer_account || null,
        buyer_phone: form.buyer_phone || null,
        buyer_address: form.buyer_address || null,
        buyer_city: form.buyer_city || null,
        lead_source: form.lead_source || null,
        note: form.note || null,
        items: form.items
          .filter((i) => i.product_id && Number(i.qty) > 0)
          .map((i) => ({ product_id: Number(i.product_id), qty: Number(i.qty), price: Number(i.price) })),
        discount: Number(form.discount) || 0,
        admin_fee_pct: Number(form.admin_fee_pct) || 0,
        handling_fee: Number(form.handling_fee) || 0,
        shipping_extra: Number(form.shipping_extra) || 0,
        voucher_platform: Number(form.voucher_platform) || 0,
        tax_pct: Number(form.tax_pct) || 0,
        packing_cost: Number(form.packing_cost) || 0,
        other_cost: Number(form.other_cost) || 0,
      };
      if (payload.items.length === 0) throw new Error('Tambahkan minimal satu item produk');

      const res = await api.post('/api/sales', payload);
      toast.success(res.message);
      setForm(null);
      load();
      refreshProducts();
    } catch (err) {
      toast.error(err.message);
    } finally {
      setSaving(false);
    }
  }

  async function cancel(order) {
    if (!window.confirm(`Batalkan order ${order.order_no}? Stok akan dikembalikan dan jurnalnya dihapus.`)) return;
    try {
      const res = await api.del(`/api/sales/${order.id}`);
      toast.success(res.message);
      load();
      refreshProducts();
    } catch (err) {
      toast.error(err.message);
    }
  }


  return (
    <div>
      <PageHeader title="Order Penjualan" subtitle="Multi-channel dengan struktur biaya & margin per transaksi">
        <button className="btn-primary" onClick={() => setForm(emptyOrder())}>
          <Plus size={16} /> Order Baru
        </button>
        <Link className="btn-secondary" to="/penjualan/retur">
          <Undo2 size={16} /> Retur
        </Link>
        <button
          className="btn-secondary"
          onClick={() => api.download('/api/sales/export/excel', { ...range, channel }, 'penjualan.xlsx').catch((e) => toast.error(e.message))}
        >
          <FileSpreadsheet size={16} /> Excel
        </button>
      </PageHeader>

      <DateRangeFilter range={range} onChange={setRange}>
        <div className="flex-1">
          <label className="label">Channel</label>
          <select className="input" value={channel} onChange={(e) => setChannel(e.target.value)}>
            <option value="">Semua Channel</option>
            {Object.entries(CHANNEL_LABEL).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
        </div>
      </DateRangeFilter>

      {loading ? (
        <Spinner />
      ) : (
        <>
          <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-5">
            <StatCard label="Jumlah Order" value={data.summary.orders} sub={`AOV ${rupiahShort(data.summary.avgOrderValue)}`} icon={ShoppingCart} />
            <StatCard label="Pendapatan Bersih" value={rupiahShort(data.summary.netRevenue)} sub={`Kotor ${rupiahShort(data.summary.grossSales)}`} />
            <StatCard label="HPP" value={rupiahShort(data.summary.cogs)} tone="slate" />
            <StatCard label="Total Biaya Channel" value={rupiahShort(data.summary.totalFees)} tone="amber" />
            <StatCard
              label="Laba Bersih" value={rupiahShort(data.summary.netProfit)}
              sub={`Margin ${pct(data.summary.marginPct)}`}
              tone={data.summary.netProfit >= 0 ? 'green' : 'red'}
            />
          </div>

          <div className="card">
            {data.rows.length === 0 ? (
              <EmptyState message="Belum ada order pada rentang ini" hint="Klik “Order Baru” untuk mencatat penjualan" />
            ) : (
              <div className="table-wrap">
                <table className="table">
                  <thead>
                    <tr>
                      <th>No. Order</th><th>Tanggal</th><th>Channel</th><th>Pelanggan</th>
                      <th>Pendapatan</th><th>HPP</th><th>Biaya</th><th>Laba Bersih</th><th>Margin</th><th>Status</th><th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.rows.map((o) => (
                      <tr key={o.id}>
                        <td className="font-mono text-xs">{o.order_no}</td>
                        <td className="tabular">{dateID(o.order_date)}</td>
                        <td className="text-xs">{CHANNEL_LABEL[o.channel]}</td>
                        <td className="text-sm">{o.customer || '-'}</td>
                        <td className="tabular">{rupiah(o.net_revenue)}</td>
                        <td className="tabular text-slate-500">{rupiah(o.cogs)}</td>
                        <td className="tabular text-amber-600">{rupiah(o.total_fees)}</td>
                        <td className={`tabular font-semibold ${o.net_profit >= 0 ? 'text-emerald-600' : 'text-rose-600'}`}>
                          {rupiah(o.net_profit)}
                        </td>
                        <td className="tabular">
                          <span className={o.margin_pct >= 15 ? 'badge-green' : o.margin_pct >= 0 ? 'badge-amber' : 'badge-red'}>
                            {pct(o.margin_pct)}
                          </span>
                        </td>
                        <td>
                          <span className={o.payment_status === 'PAID' ? 'badge-green' : 'badge-amber'}>
                            {o.payment_status === 'PAID' ? 'Lunas' : 'Belum'}
                          </span>
                        </td>
                        <td>
                          <div className="flex gap-1">
                            <button
                              className="btn-ghost !px-2 !py-1"
                              onClick={() => api.get(`/api/sales/${o.id}`).then(setDetail).catch((e) => toast.error(e.message))}
                              aria-label="Detail"
                            >
                              <Eye size={14} />
                            </button>
                            {canManage && (
                              <button className="btn-ghost !px-2 !py-1 text-rose-600" onClick={() => cancel(o)} aria-label="Batalkan">
                                <XCircle size={14} />
                              </button>
                            )}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </>
      )}

      {/* ---------- FORM ORDER ---------- */}
      <Modal open={!!form} onClose={() => setForm(null)} title="Order Penjualan Baru" wide>
        {form && (
          <form onSubmit={submit}>
            <div className="mb-4 grid gap-3 sm:grid-cols-4">
              <Field label="Tanggal *">
                <input type="date" className="input" required value={form.order_date} onChange={(e) => setForm({ ...form, order_date: e.target.value })} />
              </Field>
              <Field label="Channel *">
                <select
                  className="input" value={form.channel}
                  onChange={(e) => setForm({ ...form, channel: e.target.value, admin_fee_pct: ADMIN_FEE_PRESET[e.target.value] ?? 0 })}
                >
                  {Object.entries(CHANNEL_LABEL).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                </select>
              </Field>
              <Field label="Pelanggan" hint="Pilih terdaftar agar piutang terlacak">
                <select
                  className="input"
                  value={form.partner_id || ''}
                  onChange={(e) => {
                    const p = partners.find((x) => x.id === Number(e.target.value));
                    setForm({
                      ...form,
                      partner_id: e.target.value ? Number(e.target.value) : null,
                      customer: p ? p.name : form.customer,
                    });
                  }}
                >
                  <option value="">— umum / tidak terdaftar —</option>
                  {partners.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
              </Field>
              <Field label="Ref. Marketplace" hint="No. invoice platform">
                <input className="input" value={form.marketplace_ref} onChange={(e) => setForm({ ...form, marketplace_ref: e.target.value })} />
              </Field>
            </div>

            {/* Item */}
            <div className="mb-4">
              <div className="mb-2 flex items-center justify-between">
                <p className="label !mb-0">Item Produk</p>
                <button type="button" className="btn-ghost !py-1 text-xs" onClick={() => setForm({ ...form, items: [...form.items, { product_id: '', qty: 1, price: '' }] })}>
                  <Plus size={14} /> Tambah Item
                </button>
              </div>

              <div className="space-y-2">
                {form.items.map((it, i) => {
                  const p = products.find((x) => x.id === Number(it.product_id));
                  return (
                    <div key={i} className="grid grid-cols-12 items-end gap-2 rounded-xl bg-slate-50 p-2.5">
                      <div className="col-span-12 sm:col-span-5">
                        <label className="label">Produk</label>
                        <select className="input !py-2" value={it.product_id} onChange={(e) => setItem(i, { product_id: e.target.value })}>
                          <option value="">— pilih —</option>
                          {products.map((pr) => (
                            <option key={pr.id} value={pr.id}>{pr.sku} — {pr.name} (stok {num(pr.stock)})</option>
                          ))}
                        </select>
                      </div>
                      <div className="col-span-4 sm:col-span-2">
                        <label className="label">Qty</label>
                        <input type="number" min="0" step="any" className="input !py-2" value={it.qty} onChange={(e) => setItem(i, { qty: e.target.value })} />
                      </div>
                      <div className="col-span-5 sm:col-span-3">
                        <label className="label">Harga / Unit</label>
                        <input type="number" min="0" step="any" className="input !py-2" value={it.price} onChange={(e) => setItem(i, { price: e.target.value })} />
                      </div>
                      <div className="col-span-3 sm:col-span-2 flex items-center gap-1">
                        <div className="min-w-0 flex-1 text-xs text-slate-500">
                          {p && <>HPP<br /><span className="tabular font-semibold">{rupiah(p.cost)}</span></>}
                        </div>
                        {form.items.length > 1 && (
                          <button
                            type="button" className="btn-ghost !px-2 !py-1.5 text-rose-600"
                            onClick={() => setForm({ ...form, items: form.items.filter((_, x) => x !== i) })}
                            aria-label="Hapus item"
                          >
                            <Trash2 size={14} />
                          </button>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Struktur biaya */}
            <p className="label">Struktur Biaya Order</p>
            <div className="mb-4 grid gap-3 sm:grid-cols-4">
              <Field label="Diskon Penjual (Rp)">
                <input type="number" min="0" step="any" className="input" value={form.discount} onChange={(e) => setForm({ ...form, discount: e.target.value })} />
              </Field>
              <Field label="Biaya Admin (%)" hint={`≈ ${rupiah(calc?.adminFee || 0)}`}>
                <input type="number" min="0" max="100" step="any" className="input" value={form.admin_fee_pct} onChange={(e) => setForm({ ...form, admin_fee_pct: e.target.value })} />
              </Field>
              <Field label="Handling Fee (Rp)">
                <input type="number" min="0" step="any" className="input" value={form.handling_fee} onChange={(e) => setForm({ ...form, handling_fee: e.target.value })} />
              </Field>
              <Field label="Ongkir Extra (Rp)" hint="Ditanggung penjual">
                <input type="number" min="0" step="any" className="input" value={form.shipping_extra} onChange={(e) => setForm({ ...form, shipping_extra: e.target.value })} />
              </Field>
              <Field label="Voucher Platform (Rp)">
                <input type="number" min="0" step="any" className="input" value={form.voucher_platform} onChange={(e) => setForm({ ...form, voucher_platform: e.target.value })} />
              </Field>
              <Field label="Pajak (%)" hint={`≈ ${rupiah(calc?.taxAmount || 0)}`}>
                <input type="number" min="0" max="100" step="any" className="input" value={form.tax_pct} onChange={(e) => setForm({ ...form, tax_pct: e.target.value })} />
              </Field>
              <Field label="Biaya Packing (Rp)">
                <input type="number" min="0" step="any" className="input" value={form.packing_cost} onChange={(e) => setForm({ ...form, packing_cost: e.target.value })} />
              </Field>
              <Field label="Biaya Lain (Rp)">
                <input type="number" min="0" step="any" className="input" value={form.other_cost} onChange={(e) => setForm({ ...form, other_cost: e.target.value })} />
              </Field>
            </div>

            {/* ---- Data pesanan marketplace ---- */}
            <p className="label">Data Pesanan Marketplace</p>
            <div className="mb-4 grid gap-3 sm:grid-cols-3">
              <Field label="Toko" hint="Akun toko tempat order masuk">
                <select
                  className="input" value={form.shop_id || ''}
                  onChange={(e) => {
                    const sh = shops.find((x) => x.id === Number(e.target.value));
                    setForm({
                      ...form,
                      shop_id: e.target.value ? Number(e.target.value) : null,
                      channel: sh ? sh.channel : form.channel,
                      admin_fee_pct: sh ? (ADMIN_FEE_PRESET[sh.channel] ?? form.admin_fee_pct) : form.admin_fee_pct,
                    });
                  }}
                >
                  <option value="">— tidak dicatat —</option>
                  {shops.map((sh) => <option key={sh.id} value={sh.id}>{sh.name}</option>)}
                </select>
              </Field>
              <Field label="No. Pesanan" hint="Nomor dari marketplace">
                <input className="input" value={form.order_ref} onChange={(e) => setForm({ ...form, order_ref: e.target.value })} />
              </Field>
              <Field label="Status Pesanan">
                <select className="input" value={form.fulfillment_status} onChange={(e) => setForm({ ...form, fulfillment_status: e.target.value })}>
                  <option value="DIPROSES">Diproses</option>
                  <option value="DIKIRIM">Dikirim</option>
                  <option value="SELESAI">Selesai</option>
                  <option value="CAIR">Cair</option>
                  <option value="RETUR">Retur</option>
                  <option value="BATAL">Batal</option>
                </select>
              </Field>

              <Field label="Ekspedisi">
                <input className="input" list="ekspedisi-list" value={form.courier} onChange={(e) => setForm({ ...form, courier: e.target.value })} />
                <datalist id="ekspedisi-list">
                  {['SPXpress', 'SPXpress COD', 'JNT', 'JNT COD', 'JNT CARGO', 'JNE', 'AnterAja', 'AnterAja COD', 'POS Indonesia', 'CASH'].map((x) => <option key={x} value={x} />)}
                </datalist>
              </Field>
              <Field label="Resi / Kode Booking">
                <input className="input" value={form.tracking_no} onChange={(e) => setForm({ ...form, tracking_no: e.target.value })} />
              </Field>
              <Field label="Tanggal Cair" hint="Kosongkan bila belum cair">
                <input type="date" className="input" value={form.payout_date} onChange={(e) => setForm({ ...form, payout_date: e.target.value })} />
              </Field>
            </div>

            {/* ---- Data pembeli ---- */}
            <p className="label">Data Pembeli</p>
            <div className="mb-4 grid gap-3 sm:grid-cols-3">
              <Field label="Nama Pembeli">
                <input className="input" value={form.buyer_name} onChange={(e) => setForm({ ...form, buyer_name: e.target.value })} />
              </Field>
              <Field label="Akun Pembeli" hint="Username di marketplace">
                <input className="input" value={form.buyer_account} onChange={(e) => setForm({ ...form, buyer_account: e.target.value })} />
              </Field>
              <Field label="No. HP">
                <input className="input" value={form.buyer_phone} onChange={(e) => setForm({ ...form, buyer_phone: e.target.value })} />
              </Field>
              <Field label="Kota">
                <input className="input" value={form.buyer_city} onChange={(e) => setForm({ ...form, buyer_city: e.target.value })} />
              </Field>
              <Field label="Asal Leads" hint="mis. MP, TT, WA">
                <input className="input" value={form.lead_source} onChange={(e) => setForm({ ...form, lead_source: e.target.value })} />
              </Field>
              <Field label="Ongkir Ditagih ke Pembeli (Rp)" hint="Bukan biaya; hanya catatan">
                <input type="number" min="0" step="any" className="input" value={form.shipping_charged} onChange={(e) => setForm({ ...form, shipping_charged: e.target.value })} />
              </Field>
              <Field label="Alamat Pembeli" className="sm:col-span-3">
                <input className="input" value={form.buyer_address} onChange={(e) => setForm({ ...form, buyer_address: e.target.value })} />
              </Field>
            </div>

            <div className="mb-4 grid gap-3 sm:grid-cols-2">
              <Field label="Status Pembayaran">
                <select className="input" value={form.payment_status} onChange={(e) => setForm({ ...form, payment_status: e.target.value })}>
                  <option value="PAID">Lunas (dana diterima)</option>
                  <option value="UNPAID">Belum cair / dana ditahan platform</option>
                </select>
              </Field>
              <Field label="Catatan">
                <input className="input" value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} />
              </Field>
            </div>

            {/* Ringkasan margin real-time */}
            {calc && (
              <div className="mb-4 rounded-xl bg-slate-900 p-4 text-white">
                <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-slate-400">Kalkulasi Margin Real-Time</p>
                <div className="grid grid-cols-2 gap-x-6 gap-y-1 text-sm sm:grid-cols-3">
                  <SumRow label="Penjualan Kotor" value={calc.gross} />
                  <SumRow label="Diskon" value={-calc.discount} />
                  <SumRow label="Pendapatan Bersih" value={calc.netRevenue} bold />
                  <SumRow label="HPP" value={-calc.cogs} />
                  <SumRow label="Laba Kotor" value={calc.grossProfit} bold />
                  <SumRow label="Total Biaya Channel" value={-calc.fees} tone="amber" />
                </div>
                <div className="mt-3 flex items-center justify-between border-t border-slate-700 pt-3">
                  <span className="text-sm font-semibold">LABA BERSIH</span>
                  <span className={`tabular text-lg font-bold ${calc.netProfit >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                    {rupiah(calc.netProfit)} <span className="text-sm font-medium">({calc.marginPct.toFixed(2)}%)</span>
                  </span>
                </div>
              </div>
            )}

            <div className="flex gap-2">
              <button type="button" className="btn-secondary flex-1" onClick={() => setForm(null)}>Batal</button>
              <button type="submit" className="btn-primary flex-1" disabled={saving}>
                {saving ? 'Menyimpan...' : 'Simpan Order'}
              </button>
            </div>
          </form>
        )}
      </Modal>

      {/* ---------- DETAIL ORDER ---------- */}
      <Modal open={!!detail} onClose={() => setDetail(null)} title={`Detail ${detail?.order.order_no || ''}`} wide>
        {detail && (
          <div>
            <div className="mb-4 table-wrap">
              <table className="table">
                <thead><tr><th>Produk</th><th>Qty</th><th>Harga</th><th>HPP</th><th>Subtotal</th><th>Laba Kotor</th></tr></thead>
                <tbody>
                  {detail.items.map((i) => (
                    <tr key={i.id}>
                      <td>
                        <p className="font-medium text-slate-900">{i.product_name}</p>
                        <p className="text-xs text-slate-400">{i.sku}</p>
                      </td>
                      <td className="tabular">{num(i.qty)} {i.unit}</td>
                      <td className="tabular">{rupiah(i.price)}</td>
                      <td className="tabular text-slate-500">{rupiah(i.cost)}</td>
                      <td className="tabular">{rupiah(i.subtotal)}</td>
                      <td className="tabular text-emerald-600">{rupiah(i.subtotal - i.subcost)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <dl className="space-y-1 text-sm">
                <DetailRow label="Penjualan Kotor" value={rupiah(detail.order.gross_sales)} />
                <DetailRow label="Diskon" value={`− ${rupiah(detail.order.discount)}`} />
                <DetailRow label="Pendapatan Bersih" value={rupiah(detail.order.net_revenue)} bold />
                <DetailRow label="HPP" value={`− ${rupiah(detail.order.cogs)}`} />
                <DetailRow label="Laba Kotor" value={rupiah(detail.order.gross_profit)} bold />
              </dl>
              <dl className="space-y-1 text-sm">
                <DetailRow label="Admin Marketplace" value={`− ${rupiah(detail.order.admin_fee)}`} />
                <DetailRow label="Handling" value={`− ${rupiah(detail.order.handling_fee)}`} />
                <DetailRow label="Ongkir Extra" value={`− ${rupiah(detail.order.shipping_extra)}`} />
                <DetailRow label="Voucher Platform" value={`− ${rupiah(detail.order.voucher_platform)}`} />
                <DetailRow label="Pajak" value={`− ${rupiah(detail.order.tax_amount)}`} />
                <DetailRow label="Packing" value={`− ${rupiah(detail.order.packing_cost)}`} />
                <DetailRow label="Biaya Lain" value={`− ${rupiah(detail.order.other_cost)}`} />
                <DetailRow label="Total Biaya" value={`− ${rupiah(detail.order.total_fees)}`} bold />
              </dl>
            </div>

            <div className="mt-4 flex items-center justify-between rounded-xl bg-slate-900 px-4 py-3 text-white">
              <span className="font-semibold">LABA BERSIH</span>
              <span className={`tabular text-lg font-bold ${detail.order.net_profit >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                {rupiah(detail.order.net_profit)} ({pct(detail.order.margin_pct)})
              </span>
            </div>

            {detail.journal && (
              <p className="mt-3 text-xs text-slate-500">
                Jurnal otomatis: <span className="font-mono">{detail.journal.entry_no}</span> — {detail.journal.description}
              </p>
            )}
          </div>
        )}
      </Modal>

    </div>
  );
}

function SumRow({ label, value, bold, tone }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-slate-400">{label}</span>
      <span className={`tabular ${bold ? 'font-bold' : ''} ${tone === 'amber' ? 'text-amber-300' : ''}`}>
        {rupiah(value)}
      </span>
    </div>
  );
}

function DetailRow({ label, value, bold }) {
  return (
    <div className={`flex items-center justify-between border-b border-slate-100 py-1 ${bold ? 'font-bold text-slate-900' : 'text-slate-600'}`}>
      <dt>{label}</dt>
      <dd className="tabular">{value}</dd>
    </div>
  );
}
