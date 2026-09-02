import { useEffect, useState } from 'react';
import { AlertTriangle, Plus, Trash2 } from 'lucide-react';
import { api } from '../lib/api';
import { Modal, Field, useToast } from '../components/ui';
import BarisVarian from '../components/BarisVarian';
import { STATUS_PESANAN, CHANNEL_LABEL, rupiah } from '../lib/format';

/**
 * Formulir ubah order.
 *
 * Dipisah dari halaman daftar karena isinya panjang dan punya aturan sendiri.
 * Yang dikirim ke peladen hanya kolom yang benar-benar berubah — mengirim
 * seluruh isi order untuk satu perubahan status membuat kolom yang tidak
 * disentuh ikut ditulis ulang, dan perbedaan pembulatan kecil pun bisa
 * menggeser angka yang sebenarnya tidak diapa-apakan.
 */
export default function UbahOrder({ order, shops = [], products = [], open, onClose, onSaved }) {
  const toast = useToast();
  const [form, setForm] = useState(null);
  const [saving, setSaving] = useState(false);
  const [bukaBiaya, setBukaBiaya] = useState(false);
  // Baris pesanan tidak ikut pada daftar order — daftar hanya membawa
  // ringkasannya — jadi harus diambil tersendiri saat formulirnya dibuka.
  const [itemAwal, setItemAwal] = useState(null);
  const [memuatItem, setMemuatItem] = useState(false);
  const [katalogVarian, setKatalogVarian] = useState({});

  useEffect(() => {
    if (!order) {
      setItemAwal(null);
      return;
    }
    let batalAmbil = false;
    setMemuatItem(true);
    api
      .get(`/api/sales/${order.id}`)
      .then((d) => {
        if (batalAmbil) return;
        // Peladen mengirim items sejajar dengan order, bukan di dalamnya.
        const isi = (d.items || []).map((i) => ({
          product_id: String(i.product_id),
          // Nama dan SKU ikut dibawa dari pesanan. Daftar produk hanya memuat
          // yang aktif, jadi barang yang sudah dinonaktifkan tidak akan ada di
          // sana — tanpa salinan ini, barisnya tampak kosong dan menyimpan
          // justru menghapus produk yang sebenarnya benar.
          product_nama: i.product_name || '',
          product_sku: i.sku || '',
          qty: i.qty,
          price: i.price,
          variants: (i.variants || []).map((v) => ({
            variant_id: v.variant_id || '',
            label: v.label || '',
            qty: v.qty,
          })),
        }));
        setKatalogVarian(d.katalogVarian || {});
        setItemAwal(isi);
        setForm((f) => (f ? { ...f, items: isi.map((x) => ({ ...x })) } : f));
      })
      .catch((err) => {
        if (!batalAmbil) toast.error(`Gagal memuat detail pesanan: ${err.message}`);
      })
      .finally(() => { if (!batalAmbil) setMemuatItem(false); });
    return () => { batalAmbil = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [order]);

  useEffect(() => {
    if (!order) return setForm(null);
    setForm({
      items: [],
      order_date: order.order_date || '',
      fulfillment_status: order.fulfillment_status || 'DIPROSES',
      payment_status: order.payment_status || 'UNPAID',
      payout_date: order.payout_date || '',
      shop_id: order.shop_id || '',
      order_ref: order.order_ref || '',
      courier: order.courier || '',
      tracking_no: order.tracking_no || '',
      customer: order.customer || '',
      buyer_name: order.buyer_name || '',
      buyer_account: order.buyer_account || '',
      buyer_phone: order.buyer_phone || '',
      buyer_city: order.buyer_city || '',
      buyer_address: order.buyer_address || '',
      lead_source: order.lead_source || '',
      note: order.note || '',
      discount: order.discount ?? 0,
      admin_fee: order.admin_fee ?? 0,
      handling_fee: order.handling_fee ?? 0,
      shipping_extra: order.shipping_extra ?? 0,
      shipping_charged: order.shipping_charged ?? 0,
      voucher_platform: order.voucher_platform ?? 0,
      packing_cost: order.packing_cost ?? 0,
      other_cost: order.other_cost ?? 0,
    });
    setBukaBiaya(false);
  }, [order]);

  if (!form || !order) return null;

  const batal = form.fulfillment_status === 'BATAL';

  // Penjualan kotor dari baris yang sedang tampil; peladen tetap menghitung
  // ulang sendiri, angka ini hanya supaya perubahannya terlihat sebelum disimpan.
  const totalItem = (form.items || []).reduce(
    (s2, i) => s2 + (Number(i.qty) || 0) * (Number(i.price) || 0), 0
  );

  /** Hanya kolom yang berbeda dari nilai semula yang dikirim. */
  function perubahan() {
    const kirim = {};
    const angka = new Set([
      'discount', 'admin_fee', 'handling_fee', 'shipping_extra',
      'shipping_charged', 'voucher_platform', 'packing_cost', 'other_cost',
    ]);

    for (const [k, v] of Object.entries(form)) {
      // Baris pesanan dibandingkan tersendiri di bawah; ia larik, bukan nilai
      // tunggal, dan perbandingan biasa akan menganggapnya selalu berubah.
      if (k === 'items') continue;

      const semula = order[k];
      if (angka.has(k)) {
        const n = Number(v) || 0;
        if (Math.abs(n - (Number(semula) || 0)) > 0.004) kirim[k] = n;
        continue;
      }
      if (k === 'shop_id') {
        const n = v === '' ? null : Number(v);
        if (n !== (semula || null)) kirim[k] = n;
        continue;
      }
      const teks = v === '' ? null : v;
      const lama = semula === '' || semula === undefined ? null : semula;
      if (teks !== lama) kirim[k] = teks;
    }

    // Baris pesanan hanya ikut dikirim bila benar-benar berbeda. Mengirimnya
    // setiap kali berarti stok dikembalikan lalu dipotong lagi pada tiap
    // penyimpanan — pekerjaan berat yang tidak perlu, dan satu kesempatan
    // tambahan untuk salah setiap kali.
    const bersih = (form.items || [])
      .filter((i) => i.product_id && Number(i.qty) > 0)
      .map((i) => ({
        product_id: Number(i.product_id),
        qty: Number(i.qty),
        price: Number(i.price) || 0,
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
      }));

    if (itemAwal) {
      // Label varian ikut dibandingkan. Kalau tidak, mengganti label tanpa
      // menyentuh jumlah maupun harga akan dianggap "tidak ada yang diubah"
      // dan perubahannya hilang tanpa pesan apa pun.
      const samaVarian = (a = [], b = []) =>
        a.length === b.length &&
        a.every((v, n) =>
          String(v.variant_id || '') === String(b[n].variant_id || '') &&
          String(v.label || '').trim() === String(b[n].label || '').trim() &&
          Math.abs(Number(v.qty) - Number(b[n].qty)) < 0.0001);

      const sama =
        bersih.length === itemAwal.length &&
        bersih.every((i, n) =>
          i.product_id === Number(itemAwal[n].product_id) &&
          Math.abs(i.qty - Number(itemAwal[n].qty)) < 0.0001 &&
          Math.abs(i.price - Number(itemAwal[n].price)) < 0.004 &&
          samaVarian(i.variants || [], itemAwal[n].variants || []));
      if (!sama) kirim.items = bersih;
    }

    return kirim;
  }

  async function simpan(e) {
    e.preventDefault();
    const kirim = perubahan();

    if (!Object.keys(kirim).length) {
      toast.info('Tidak ada yang diubah');
      return onClose();
    }

    if (batal && !window.confirm(
      `Menandai ${order.order_no} sebagai Batal akan mengembalikan stoknya dan menghapus jurnalnya. Lanjutkan?`
    )) return;

    // Mengubah isi pesanan menyentuh stok dan jurnal sekaligus, jadi layak
    // ditanyakan sekali — berbeda dengan mengoreksi nomor resi.
    if (kirim.items && !window.confirm(
      `Isi pesanan ${order.order_no} berubah. Stok akan disesuaikan dan jurnalnya ditulis ulang. Lanjutkan?`
    )) return;

    setSaving(true);
    try {
      const res = await api.put(`/api/sales/${order.id}`, kirim);
      toast.success(res.message);
      onSaved();
      onClose();
    } catch (err) {
      toast.error(err.message);
    } finally {
      setSaving(false);
    }
  }

  const ubah = (k) => (e) => setForm({ ...form, [k]: e.target.value });

  return (
    <Modal open={open} onClose={onClose} title={`Ubah ${order.order_no}`} wide>
      <form onSubmit={simpan} className="grid gap-3 sm:grid-cols-2">
        <div className="sm:col-span-2 rounded-xl bg-slate-50 px-3 py-2 text-xs text-slate-600">
          {CHANNEL_LABEL[order.channel] || order.channel} •
          {' '}Pendapatan {rupiah(order.net_revenue)} • Laba {rupiah(order.net_profit)}
          {form.order_date !== order.order_date && (
            <span className="ml-1 font-semibold text-amber-700">
              • tanggal diubah dari {order.order_date}
            </span>
          )}
        </div>

        {/* Tanggal ditaruh paling awal karena inilah yang paling sering perlu
            dibetulkan: salah ketik tanggal baru ketahuan berhari-hari kemudian,
            saat laporan bulanan tidak cocok. Mengubahnya di sini memindahkan
            jurnal dan tanggal mutasi stoknya sekalian, jadi pembukuan tetap
            sejalan dengan ordernya. */}
        <Field
          label="Tanggal Order *"
          hint="Membetulkan tanggal ikut memindahkan jurnal & mutasi stoknya"
        >
          <input
            type="date" className="input" required
            value={form.order_date} onChange={ubah('order_date')}
          />
        </Field>

        <Field label="Status Pesanan *">
          <select className="input" value={form.fulfillment_status} onChange={ubah('fulfillment_status')}>
            {Object.entries(STATUS_PESANAN).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
        </Field>

        <Field
          label="Status Pembayaran *"
          hint="Belum cair dicatat sebagai piutang; lunas masuk kas atau bank"
        >
          <select className="input" value={form.payment_status} onChange={ubah('payment_status')} disabled={batal}>
            <option value="UNPAID">Dana belum cair</option>
            <option value="PAID">Lunas / sudah cair</option>
          </select>
        </Field>

        {batal && (
          <div className="sm:col-span-2 flex items-start gap-2 rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-800">
            <AlertTriangle size={15} className="mt-0.5 shrink-0" />
            <span>
              Menandai batal bukan sekadar label: stok order ini dikembalikan ke gudang dan
              jurnalnya dihapus, supaya pesanan yang tidak jadi tidak ikut terhitung sebagai
              pendapatan. Setelah dibatalkan, order tidak bisa diubah lagi.
            </span>
          </div>
        )}

        <Field label="Tanggal Cair" hint="Diisi saat dana benar-benar diterima">
          <input type="date" className="input" value={form.payout_date} onChange={ubah('payout_date')} disabled={batal} />
        </Field>
        <Field label="Toko / Akun">
          <select className="input" value={form.shop_id} onChange={ubah('shop_id')} disabled={batal}>
            <option value="">— tanpa toko —</option>
            {shops.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </Field>

        <Field label="No. Pesanan">
          <input className="input" value={form.order_ref} onChange={ubah('order_ref')} disabled={batal} />
        </Field>
        <Field label="Ekspedisi">
          <input className="input" value={form.courier} onChange={ubah('courier')} disabled={batal} />
        </Field>
        <Field label="Resi / Kode Booking" className="sm:col-span-2">
          <input className="input" value={form.tracking_no} onChange={ubah('tracking_no')} disabled={batal} />
        </Field>

        <Field label="Nama Pembeli">
          <input className="input" value={form.buyer_name} onChange={ubah('buyer_name')} disabled={batal} />
        </Field>
        <Field label="Akun Pembeli">
          <input className="input" value={form.buyer_account} onChange={ubah('buyer_account')} disabled={batal} />
        </Field>
        <Field label="No. HP">
          <input className="input" value={form.buyer_phone} onChange={ubah('buyer_phone')} disabled={batal} />
        </Field>
        <Field label="Asal Kota">
          <input className="input" value={form.buyer_city} onChange={ubah('buyer_city')} disabled={batal} />
        </Field>
        <Field label="Alamat Pembeli" className="sm:col-span-2">
          <input className="input" value={form.buyer_address} onChange={ubah('buyer_address')} disabled={batal} />
        </Field>
        {/* ---------- Detail pesanan ---------- */}
        <div className="sm:col-span-2">
          <div className="mb-2 flex items-center justify-between gap-2">
            <p className="text-sm font-semibold text-slate-900">Detail Pesanan</p>
            {!batal && (
              <button
                type="button" className="btn-secondary !px-2.5 !py-1 text-xs"
                onClick={() => setForm({
                  ...form,
                  items: [...(form.items || []), { product_id: '', qty: 1, price: '' }],
                })}
              >
                <Plus size={13} /> Tambah Barang
              </button>
            )}
          </div>

          {memuatItem ? (
            <p className="rounded-xl bg-slate-50 px-3 py-3 text-xs text-slate-500">Memuat detail pesanan...</p>
          ) : (form.items || []).length === 0 ? (
            <p className="rounded-xl bg-slate-50 px-3 py-3 text-xs text-slate-500">
              Pesanan ini belum punya baris barang.
            </p>
          ) : (
            <div className="space-y-2">
              {form.items.map((it, i) => {
                const p = products.find((x) => String(x.id) === String(it.product_id));
                const subtotal = (Number(it.qty) || 0) * (Number(it.price) || 0);
                return (
                  <div key={i} className="grid gap-2 rounded-xl bg-slate-50 p-2 sm:grid-cols-12">
                    <select
                      className="input sm:col-span-5" value={it.product_id} disabled={batal}
                      onChange={(e) => {
                        const items = [...form.items];
                        const dipilih = products.find((x) => String(x.id) === e.target.value);
                        items[i] = {
                          ...items[i],
                          product_id: e.target.value,
                          // Harga diisikan dari master hanya bila masih kosong,
                          // supaya harga khusus yang sudah diketik tidak tertimpa.
                          price: items[i].price === '' && dipilih ? dipilih.price : items[i].price,
                        };
                        setForm({ ...form, items });
                      }}
                    >
                      <option value="">— pilih barang —</option>
                      {/* Produk baris ini tetap muncul walau sudah nonaktif,
                          supaya pilihannya tidak terbaca kosong dan tidak
                          terhapus begitu formulir disimpan. */}
                      {it.product_id && !p && (
                        <option value={it.product_id}>
                          {it.product_nama || 'Produk tidak aktif'} (tidak aktif)
                        </option>
                      )}
                      {products.map((x) => (
                        <option key={x.id} value={x.id}>{x.name} (stok {x.stock})</option>
                      ))}
                    </select>

                    <input
                      type="number" min="0" step="0.01" className="input sm:col-span-2"
                      value={it.qty} placeholder="Qty" disabled={batal}
                      onChange={(e) => {
                        const items = [...form.items];
                        items[i] = { ...items[i], qty: e.target.value };
                        setForm({ ...form, items });
                      }}
                    />
                    <input
                      type="number" min="0" className="input sm:col-span-3"
                      value={it.price} placeholder="Harga satuan" disabled={batal}
                      onChange={(e) => {
                        const items = [...form.items];
                        items[i] = { ...items[i], price: e.target.value };
                        setForm({ ...form, items });
                      }}
                    />

                    <div className="flex items-center justify-between gap-2 sm:col-span-2">
                      <span className="tabular text-xs text-slate-600">{rupiah(subtotal)}</span>
                      {!batal && (
                        <button
                          type="button" className="btn-ghost !px-2 !py-1 text-rose-600"
                          onClick={() => setForm({ ...form, items: form.items.filter((_, n) => n !== i) })}
                          aria-label="Hapus barang"
                        >
                          <Trash2 size={14} />
                        </button>
                      )}
                    </div>

                    {p && (
                      <p className="text-[11px] text-slate-500 sm:col-span-12">
                        {p.sku} • HPP {rupiah(p.cost)} • laba baris {rupiah(subtotal - (Number(it.qty) || 0) * p.cost)}
                      </p>
                    )}

                    {p && p.needs_variant && (
                      <div className="sm:col-span-12">
                        <BarisVarian
                          produk={p}
                          varian={it.variants || []}
                          qtyBaris={it.qty}
                          terkunci={batal}
                          katalogAwal={katalogVarian[p.id]}
                          onUbah={(variants) => {
                            const items = [...form.items];
                            items[i] = { ...items[i], variants };
                            setForm({ ...form, items });
                          }}
                        />
                      </div>
                    )}
                  </div>
                );
              })}

              <div className="flex justify-between px-2 text-sm">
                <span className="text-slate-600">Penjualan kotor</span>
                <span className="tabular font-semibold text-slate-900">{rupiah(totalItem)}</span>
              </div>
              {Math.abs(totalItem - (order.gross_sales || 0)) > 0.5 && (
                <p className="rounded-lg bg-amber-50 px-3 py-2 text-xs leading-relaxed text-amber-800 dark:bg-amber-400/10">
                  Berubah dari {rupiah(order.gross_sales)}. Menyimpan akan menyesuaikan stok dan
                  menulis ulang jurnal order ini; biaya admin yang dihitung dari persentase ikut
                  dihitung ulang.
                </p>
              )}
            </div>
          )}
        </div>

        <Field label="Asal Leads">
          <input className="input" value={form.lead_source} onChange={ubah('lead_source')} disabled={batal} />
        </Field>
        <Field label="Catatan">
          <input className="input" value={form.note} onChange={ubah('note')} disabled={batal} />
        </Field>

        <div className="sm:col-span-2">
          <button
            type="button"
            className="btn-ghost !px-2 !py-1 text-xs"
            onClick={() => setBukaBiaya(!bukaBiaya)}
            disabled={batal}
          >
            {bukaBiaya ? 'Sembunyikan' : 'Ubah'} biaya & potongan
          </button>
        </div>

        {bukaBiaya && !batal && (
          <>
            <div className="sm:col-span-2 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800">
              Mengubah angka di bawah ini menghitung ulang laba order dan menulis ulang jurnalnya.
            </div>
            {[
              // Istilahnya sama persis dengan formulir order baru dan dengan
              // rincian pencairan marketplace; nama yang berbeda antara membuat
              // dan mengubah membuat orang ragu apakah keduanya kolom yang sama.
              ['discount', 'Diskon Penjual'],
              ['voucher_platform', 'Voucher & Subsidi'],
              ['admin_fee', 'Biaya Platform'],
              ['shipping_extra', 'Biaya Gratis Ongkir XTRA'],
              ['handling_fee', 'Biaya Layanan'],
              ['shipping_charged', 'Ongkir Ditagih ke Pembeli'],
              ['packing_cost', 'Biaya Packing'],
              ['other_cost', 'Biaya Lain'],
            ].map(([k, l]) => (
              <Field key={k} label={l}>
                <input type="number" min="0" className="input" value={form[k]} onChange={ubah(k)} />
              </Field>
            ))}
          </>
        )}

        <div className="flex gap-2 sm:col-span-2">
          <button type="button" className="btn-secondary flex-1" onClick={onClose}>Tutup</button>
          <button type="submit" className="btn-primary flex-1" disabled={saving}>
            {saving ? 'Menyimpan...' : 'Simpan Perubahan'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
