import { useEffect, useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import { api } from '../lib/api';
import { Modal, Field, useToast } from '../components/ui';
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
export default function UbahOrder({ order, shops = [], open, onClose, onSaved }) {
  const toast = useToast();
  const [form, setForm] = useState(null);
  const [saving, setSaving] = useState(false);
  const [bukaBiaya, setBukaBiaya] = useState(false);

  useEffect(() => {
    if (!order) return setForm(null);
    setForm({
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

  /** Hanya kolom yang berbeda dari nilai semula yang dikirim. */
  function perubahan() {
    const kirim = {};
    const angka = new Set([
      'discount', 'admin_fee', 'handling_fee', 'shipping_extra',
      'shipping_charged', 'voucher_platform', 'packing_cost', 'other_cost',
    ]);

    for (const [k, v] of Object.entries(form)) {
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
          {order.order_date} • {CHANNEL_LABEL[order.channel] || order.channel} •
          {' '}Pendapatan {rupiah(order.net_revenue)} • Laba {rupiah(order.net_profit)}
        </div>

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
              ['discount', 'Diskon'],
              ['admin_fee', 'Biaya Admin Marketplace'],
              ['handling_fee', 'Biaya Handling'],
              ['shipping_extra', 'Ongkir Ditanggung Penjual'],
              ['shipping_charged', 'Ongkir Ditagih ke Pembeli'],
              ['voucher_platform', 'Voucher Platform'],
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
