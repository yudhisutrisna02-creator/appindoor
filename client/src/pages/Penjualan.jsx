import { useEffect, useState, useCallback, useMemo } from 'react';
import { Link } from 'react-router-dom';
import { Plus, Trash2, ShoppingCart, FileSpreadsheet, Eye, XCircle, Undo2, Pencil, Megaphone } from 'lucide-react';
import { api } from '../lib/api';
import { PageHeader, StatCard, Spinner, EmptyState, Modal, DateRangeFilter, defaultRange, useToast, Field, TombolEkspor, KotakCari } from '../components/ui';
import UbahOrder from './UbahOrder';
import BarisVarian from '../components/BarisVarian';
import { rupiah, num, pct, today, dateID, CHANNEL_LABEL, STATUS_PESANAN, WARNA_STATUS, kelasChannel } from '../lib/format';
import { useAuth } from '../lib/auth';

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
  admin_fee: 0,
  handling_fee: 0,
  shipping_extra: 0,
  voucher_platform: 0,
  tax_pct: 0,
  packing_cost: 0,
  other_cost: 0,
  shipping_non_mp: 0,
  payment_status: 'PAID',
  note: '',
});

export default function Penjualan() {
  const toast = useToast();
  const { canManage } = useAuth();
  const [range, setRange] = useState(defaultRange);
  const [channel, setChannel] = useState('');
  const [q, setQ] = useState('');
  // Kolom keuangan disembunyikan secara bawaan; angkanya tetap ada, hanya tidak
  // ikut memenuhi layar saat yang dicari adalah satu pesanan.
  const [tampilUang, setTampilUang] = useState(false);
  const [data, setData] = useState(null);
  const [products, setProducts] = useState([]);
  const [partners, setPartners] = useState([]);
  const [shops, setShops] = useState([]);
  const [loading, setLoading] = useState(true);
  const [form, setForm] = useState(null);
  const [detail, setDetail] = useState(null);
  const [ubah, setUbah] = useState(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setData(await api.get('/api/sales', { ...range, channel, q }));
    } catch (err) {
      toast.error(err.message);
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [range, channel, q]);

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

    const adminFee = Number(form.admin_fee) || 0;
    const taxAmount = (netRevenue * (Number(form.tax_pct) || 0)) / 100;
    const fees =
      adminFee + taxAmount +
      (Number(form.handling_fee) || 0) + (Number(form.shipping_extra) || 0) +
      (Number(form.voucher_platform) || 0) + (Number(form.packing_cost) || 0) +
      (Number(form.other_cost) || 0);

    const grossProfit = netRevenue - cogs;
    const netProfit = grossProfit - fees;

    // Ongkir non-marketplace tidak masuk omzet maupun laba: uangnya diteruskan
    // ke ekspedisi, bukan hasil menjual barang. Ia hanya menambah uang yang
    // masuk rekening.
    const ongkirNonMp = Number(form.shipping_non_mp) || 0;

    return {
      gross, cogs, discount, netRevenue, adminFee, taxAmount, fees, grossProfit, netProfit,
      ongkirNonMp,
      // Yang benar-benar masuk rekening: omzet dikurangi potongan, ditambah
      // ongkir yang ikut ditransfer pembeli.
      netReceived: netRevenue - fees + ongkirNonMp,
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
          .map((i) => ({
            product_id: Number(i.product_id),
            qty: Number(i.qty),
            price: Number(i.price),
            ...(i.variants && i.variants.length
              ? {
                  variants: i.variants
                    .filter((v) => v.variant_id || String(v.label || '').trim())
                    .map((v) => ({
                      variant_id: v.variant_id ? Number(v.variant_id) : null,
                      label: String(v.label || '').trim() || null,
                      qty: Number(v.qty) || 0,
                    })),
                }
              : {}),
          })),
        discount: Number(form.discount) || 0,
        admin_fee: Number(form.admin_fee) || 0,
        handling_fee: Number(form.handling_fee) || 0,
        shipping_extra: Number(form.shipping_extra) || 0,
        voucher_platform: Number(form.voucher_platform) || 0,
        tax_pct: Number(form.tax_pct) || 0,
        packing_cost: Number(form.packing_cost) || 0,
        other_cost: Number(form.other_cost) || 0,
        shipping_non_mp: Number(form.shipping_non_mp) || 0,
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
          <TombolEkspor path="/api/sales" params={{ ...range, channel, q }} nama="order-penjualan" />
      </PageHeader>

      <DateRangeFilter range={range} onChange={setRange}>
        <div className="flex-1">
          <label className="label">Channel</label>
          <select className="input" value={channel} onChange={(e) => setChannel(e.target.value)}>
            <option value="">Semua Channel</option>
            {Object.entries(CHANNEL_LABEL).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
        </div>
        <div className="flex-[2]">
          <label className="label">Cari</label>
          <KotakCari
            nilai={q} onCari={setQ}
            placeholder="No. order, no. pesanan, resi, nama pembeli, toko..."
          />
        </div>
      </DateRangeFilter>

      {q && (
        <p className="mb-4 rounded-lg bg-brand-50 px-3 py-2 text-xs text-brand-800 dark:bg-brand-400/10">
          Mencari <strong>{q}</strong> pada seluruh order dalam rentang tanggal ini — bukan hanya
          yang sedang tampil di layar.
        </p>
      )}

      {loading ? (
        <Spinner />
      ) : (
        <>
          {/* Delapan kartu disusun mengikuti alur uangnya, bukan urutan
              kepentingan: dari yang masuk, dipotong biaya channel, dikurangi
              HPP, sampai yang tersisa setelah iklan. Dibaca kiri ke kanan,
              tiap kartu adalah hasil pengurangan kartu sebelumnya. */}
          <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
            <StatCard
              label="Jumlah Order" value={num(data.summary.orders)}
              sub={`AOV ${rupiah(data.summary.avgOrderValue)}`}
              icon={ShoppingCart} latar="biru"
            />
            <StatCard
              label="Pendapatan Kotor" value={rupiah(data.summary.netRevenue)}
              sub={`Penjualan ${rupiah(data.summary.grossSales)} − diskon`}
              latar="langit"
            />
            <StatCard
              label="Biaya Channel" value={rupiah(data.summary.totalFees)}
              sub="Admin, ongkir, voucher, packing"
              latar="amber"
            />
            <StatCard
              label="Pendapatan Bersih" value={rupiah(data.summary.netReceived)}
              sub="Yang benar-benar diterima"
              latar="toska"
            />

            <StatCard
              label="HPP" value={rupiah(data.summary.cogs)}
              sub="Harga pokok barang terjual"
              latar="ungu"
            />
            <StatCard
              label="Laba Bersih" value={rupiah(data.summary.netProfit)}
              sub={`Margin ${pct(data.summary.marginPct)} — sebelum iklan`}
              latar={data.summary.netProfit >= 0 ? 'hijau' : 'merah'}
            />
            <StatCard
              label="Biaya Iklan"
              value={data.iklan.berlaku ? rupiah(data.summary.iklan) : '—'}
              sub={
                data.iklan.berlaku
                  ? `${data.iklan.catatan} catatan belanja iklan`
                  : `Tidak dihitung saat ${data.iklan.alasan}`
              }
              icon={Megaphone} latar="jingga"
            />
            <StatCard
              label="Laba Setelah Iklan"
              value={data.iklan.berlaku ? rupiah(data.summary.labaSetelahIklan) : '—'}
              sub={
                data.iklan.berlaku
                  ? (data.summary.roas ? `ROAS ${data.summary.roas}×` : 'belum ada belanja iklan')
                  : 'perlu tanpa penyaring'
              }
              latar={
                !data.iklan.berlaku ? 'abu'
                  : data.summary.labaSetelahIklan >= 0 ? 'hijau' : 'merah'
              }
            />
          </div>

          {!data.iklan.berlaku && (
            <p className="mb-4 rounded-lg bg-slate-50 px-3 py-2 text-xs leading-relaxed text-slate-600">
              Biaya iklan tidak ikut menyempit mengikuti penyaring ini. Satu kampanye menarik banyak
              pesanan sekaligus, jadi belanjanya tidak bisa dibagi ke satu pesanan tertentu —
              menampilkannya apa adanya akan membuat “laba setelah iklan” jadi angka minus yang
              sepenuhnya karangan. Hapus pencarian dan penyaring status untuk melihatnya kembali.
            </p>
          )}

          <div className="card">
            {/* Ringkasan di atas selalu menghitung seluruh periode; tabel di
                bawah dibatasi agar halaman tetap ringan. Bedanya disebutkan
                supaya daftar yang terpotong tidak dikira sudah lengkap. */}
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
              <p className="text-sm text-slate-600">
                {data.rows.length} order ditampilkan
                {q && ` untuk pencarian “${q}”`}
              </p>
              <label className="flex items-center gap-2 text-xs text-slate-600">
                <input
                  type="checkbox" checked={tampilUang}
                  onChange={(e) => setTampilUang(e.target.checked)}
                />
                Tampilkan kolom keuangan
              </label>
            </div>

            {data.terpotong && (
              <p className="mb-3 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800">
                Menampilkan {data.rows.length} order terbaru dari {data.totalRows} order pada periode ini.
                Angka ringkasan di atas dan berkas unduhan tetap mencakup seluruhnya.
              </p>
            )}
            {data.rows.length === 0 ? (
              <EmptyState message="Belum ada order pada rentang ini" hint="Klik “Order Baru” untuk mencatat penjualan" />
            ) : (
              <div className="table-wrap">
                <table className="table">
                  <thead>
                    {/* Kolom utama adalah yang dipakai mencari dan mencocokkan
                        satu pesanan dengan marketplace. Angka keuangannya
                        disembunyikan secara bawaan — bukan dibuang — karena
                        tiga belas kolom sekaligus membuat yang penting justru
                        tenggelam. */}
                    <tr>
                      <th>No. Order</th><th>Tanggal</th><th>Toko</th><th>Nama Pembeli</th>
                      <th>No. Pesanan</th><th>Resi / Kode Booking</th>
                      <th>Pesanan</th><th>Bayar</th>
                      {tampilUang && (
                        <>
                          <th className="text-right">Pendapatan</th>
                          <th className="text-right">HPP</th>
                          <th className="text-right">Biaya</th>
                          <th className="text-right">Laba Bersih</th>
                          <th className="text-right">Margin</th>
                        </>
                      )}
                      <th>Detail Pesanan</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.rows.map((o) => (
                      <tr key={o.id}>
                        <td className="font-mono text-xs">{o.order_no}</td>
                        <td className="tabular whitespace-nowrap">{dateID(o.order_date)}</td>
                        <td className="text-sm">
                          {o.shop_name || '-'}
                          {/* Lencana channel diberi warna mereknya sendiri supaya
                              satu baris bisa dikenali tanpa membaca tulisannya. */}
                          <span className={`${kelasChannel(o.channel)} mt-0.5`}>
                            {CHANNEL_LABEL[o.channel] || o.channel}
                          </span>
                        </td>
                        <td className="text-sm">{o.buyer_name || o.customer || '-'}</td>
                        <td className="font-mono text-xs">{o.order_ref || '-'}</td>
                        <td className="font-mono text-xs">
                          {o.tracking_no || '-'}
                          {o.courier && <span className="block text-[11px] text-slate-500">{o.courier}</span>}
                        </td>
                        <td>
                          <span className={WARNA_STATUS[o.fulfillment_status] || 'badge-slate'}>
                            {STATUS_PESANAN[o.fulfillment_status] || o.fulfillment_status || '-'}
                          </span>
                        </td>
                        <td>
                          <span className={o.payment_status === 'PAID' ? 'badge-green' : 'badge-amber'}>
                            {o.payment_status === 'PAID' ? 'Lunas' : 'Belum cair'}
                          </span>
                        </td>
                        {tampilUang && (
                          <>
                            <td className="tabular text-right">{rupiah(o.net_revenue)}</td>
                            <td className="tabular text-right text-slate-500">{rupiah(o.cogs)}</td>
                            <td className="tabular text-right text-amber-600">{rupiah(o.total_fees)}</td>
                            <td className={`tabular text-right font-semibold ${o.net_profit >= 0 ? 'text-emerald-600' : 'text-rose-600'}`}>
                              {rupiah(o.net_profit)}
                            </td>
                            <td className="tabular text-right">
                              <span className={o.margin_pct >= 15 ? 'badge-green' : o.margin_pct >= 0 ? 'badge-amber' : 'badge-red'}>
                                {pct(o.margin_pct)}
                              </span>
                            </td>
                          </>
                        )}
                        <td>
                          <div className="flex gap-1">
                            <button
                              className="btn-ghost !px-2 !py-1"
                              onClick={() => api.get(`/api/sales/${o.id}`).then(setDetail).catch((e) => toast.error(e.message))}
                              aria-label="Detail"
                            >
                              <Eye size={14} />
                            </button>
                            {canManage && o.status !== 'CANCELLED' && (
                              <button className="btn-ghost !px-2 !py-1" onClick={() => setUbah(o)} aria-label="Ubah">
                                <Pencil size={14} />
                              </button>
                            )}
                            {canManage && o.status !== 'CANCELLED' && (
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
                  onChange={(e) => setForm({ ...form, channel: e.target.value })}
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

                      {/* Produk yang dijual tanpa label baru diberi label
                          pesanan pembeli. Labelnya keterangan pada baris ini,
                          bukan produk tersendiri — stoknya tetap berkurang dari
                          produk induk yang dipilih di atas. */}
                      {p && p.needs_variant && (
                        <BarisVarian
                          produk={p}
                          varian={it.variants || []}
                          qtyBaris={it.qty}
                          onUbah={(variants) => setItem(i, { variants })}
                        />
                      )}
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Struktur biaya */}
            <p className="label">Struktur Biaya Order</p>
            <div className="mb-4 grid gap-3 sm:grid-cols-4">
              {/* Nama dan urutannya mengikuti rincian yang dikeluarkan
                  marketplace, supaya angka dari laporan pencairan bisa
                  disalin baris demi baris tanpa menerjemahkan istilah dulu.
                  Semuanya rupiah kecuali pajak — potongan marketplace memang
                  sudah berupa nominal jadi di rincian itu. */}
              <Field label="Diskon Penjual (Rp)">
                <input type="number" min="0" step="any" className="input" value={form.discount} onChange={(e) => setForm({ ...form, discount: e.target.value })} />
              </Field>
              <Field label="Voucher & Subsidi (Rp)">
                <input type="number" min="0" step="any" className="input" value={form.voucher_platform} onChange={(e) => setForm({ ...form, voucher_platform: e.target.value })} />
              </Field>
              <Field label="Biaya Platform (Rp)">
                <input type="number" min="0" step="any" className="input" value={form.admin_fee} onChange={(e) => setForm({ ...form, admin_fee: e.target.value })} />
              </Field>
              <Field label="Biaya Gratis Ongkir XTRA (Rp)">
                <input type="number" min="0" step="any" className="input" value={form.shipping_extra} onChange={(e) => setForm({ ...form, shipping_extra: e.target.value })} />
              </Field>
              <Field label="Biaya Layanan (Rp)">
                <input type="number" min="0" step="any" className="input" value={form.handling_fee} onChange={(e) => setForm({ ...form, handling_fee: e.target.value })} />
              </Field>
              <Field label="Pajak (%)" hint={`≈ ${rupiah(calc?.taxAmount || 0)}`}>
                <input type="number" min="0" max="100" step="any" className="input" value={form.tax_pct} onChange={(e) => setForm({ ...form, tax_pct: e.target.value })} />
              </Field>
              <Field label="Biaya Packing (Rp)">
                <input type="number" min="0" step="any" className="input" value={form.packing_cost} onChange={(e) => setForm({ ...form, packing_cost: e.target.value })} />
              </Field>
              <Field
                label="Biaya Kirim Non MP (Rp)"
                hint="Ongkir yang ditagih pembeli di luar marketplace — ikut masuk rekening, MENAMBAH penerimaan"
              >
                <input type="number" min="0" step="any" className="input" value={form.shipping_non_mp} onChange={(e) => setForm({ ...form, shipping_non_mp: e.target.value })} />
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
                  {/* Diambil dari satu daftar bersama, bukan ditulis ulang di sini —
                      pilihan yang tertinggal saat tahap baru ditambahkan berarti tim
                      tidak bisa memilihnya sama sekali. */}
                  {Object.entries(STATUS_PESANAN).map(([nilai, label]) => (
                    <option key={nilai} value={nilai}>{label}</option>
                  ))}
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
              <div className="di-atas-gelap mb-4 rounded-xl bg-ink-900 p-4 text-white">
                <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-slate-400">Kalkulasi Margin Real-Time</p>
                <div className="grid grid-cols-2 gap-x-6 gap-y-1 text-sm sm:grid-cols-3">
                  <SumRow label="Penjualan Kotor" value={calc.gross} />
                  <SumRow label="Diskon" value={-calc.discount} />
                  <SumRow label="Pendapatan Kotor" value={calc.netRevenue} bold />
                  <SumRow label="Total Biaya Channel" value={-calc.fees} tone="amber" />
                  <SumRow label="Pendapatan Bersih" value={calc.netReceived} bold />
                  <SumRow label="HPP" value={-calc.cogs} />
                </div>
                <div className="mt-3 flex items-center justify-between border-t border-ink-700 pt-3">
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
      <UbahOrder
        order={ubah}
        shops={shops}
        products={products}
        open={!!ubah}
        onClose={() => setUbah(null)}
        onSaved={() => { load(); refreshProducts(); }}
      />

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
                <DetailRow label="Pendapatan Kotor" value={rupiah(detail.order.net_revenue)} bold />
                <DetailRow label="Total Biaya Channel" value={`− ${rupiah(detail.order.total_fees)}`} />
                <DetailRow
                  label="Pendapatan Bersih"
                  value={rupiah(detail.order.net_revenue - detail.order.total_fees)}
                  bold
                />
                <DetailRow label="HPP" value={`− ${rupiah(detail.order.cogs)}`} />
              </dl>
              <dl className="space-y-1 text-sm">
                <DetailRow label="Voucher & Subsidi" value={`− ${rupiah(detail.order.voucher_platform)}`} />
                <DetailRow label="Biaya Platform" value={`− ${rupiah(detail.order.admin_fee)}`} />
                <DetailRow label="Biaya Gratis Ongkir XTRA" value={`− ${rupiah(detail.order.shipping_extra)}`} />
                <DetailRow label="Biaya Layanan" value={`− ${rupiah(detail.order.handling_fee)}`} />
                <DetailRow label="Pajak" value={`− ${rupiah(detail.order.tax_amount)}`} />
                <DetailRow label="Packing" value={`− ${rupiah(detail.order.packing_cost)}`} />
                <DetailRow label="Biaya Lain" value={`− ${rupiah(detail.order.other_cost)}`} />
                {detail.order.shipping_non_mp > 0 && (
                  <DetailRow
                    label="Biaya Kirim Non MP"
                    value={`+ ${rupiah(detail.order.shipping_non_mp)}`}
                  />
                )}
                <DetailRow label="Total Biaya" value={`− ${rupiah(detail.order.total_fees)}`} bold />
              </dl>
            </div>

            <div className="di-atas-gelap mt-4 flex items-center justify-between rounded-xl bg-ink-900 px-4 py-3 text-white">
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
