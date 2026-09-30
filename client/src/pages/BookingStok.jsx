import { useEffect, useState, useCallback } from 'react';
import { Plus, Factory, Truck, Pencil, XCircle, Eye, Trash2, PackageOpen, CalendarClock } from 'lucide-react';
import { api } from '../lib/api';
import {
  PageHeader, StatCard, Spinner, EmptyState, Modal, useToast, Field,
} from '../components/ui';
import { rupiah, num, dateID, today } from '../lib/format';
import { useAuth } from '../lib/auth';

const KODE_KAS_TUNAI = '1000';

const KOSONG = () => ({
  partner_id: '',
  booking_date: today(),
  valid_until: '',
  note: '',
  items: [{ product_id: '', qty: '', unit_cost: '' }],
});

const WARNA = { AKTIF: 'badge-blue', SELESAI: 'badge-green', BATAL: 'badge-slate' };

/**
 * Pre-order / booking stok ke pabrik.
 *
 * Mengunci jumlah di pabrik (mis. 1.500 kg), lalu memanggilnya sebagian demi
 * sebagian menjadi pesanan pembelian (500 kg dulu). Tab "Stok di Pabrik"
 * memantau berapa yang masih tersimpan di sana, berapa yang sedang di jalan,
 * dan berapa yang sudah di gudang.
 */
export default function BookingStok() {
  const toast = useToast();
  const { punya } = useAuth();
  const boleh = punya('pembelian.kelola');

  const [tab, setTab] = useState('pabrik');
  const [pabrik, setPabrik] = useState(null);
  const [daftar, setDaftar] = useState(null);
  const [loading, setLoading] = useState(true);
  const [suppliers, setSuppliers] = useState([]);
  const [products, setProducts] = useState([]);
  const [rekening, setRekening] = useState([]);
  const [kodeMp, setKodeMp] = useState(null);

  const [form, setForm] = useState(null);
  const [panggil, setPanggil] = useState(null);
  const [detail, setDetail] = useState(null);
  const [menyimpan, setMenyimpan] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [a, b] = await Promise.all([api.get('/api/booking/stok-pabrik'), api.get('/api/booking')]);
      setPabrik(a);
      setDaftar(b);
    } catch (err) {
      toast.error(err.message);
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    api.get('/api/partners', { kind: 'SUPPLIER' }).then((d) => setSuppliers(d.partners)).catch(() => {});
    api.get('/api/inventory/products').then((d) => setProducts(d.products)).catch(() => {});
    api.get('/api/cashflow/options').then((d) => {
      setRekening(d.cashAccounts || []);
      setKodeMp(d.rekeningMp ? d.rekeningMp.code : null);
    }).catch(() => {});
  }, []);

  // ---------- booking baru / ubah ----------
  function setItem(i, patch) {
    const items = [...form.items];
    items[i] = { ...items[i], ...patch };
    setForm({ ...form, items });
  }

  async function bukaUbah(b) {
    try {
      const d = await api.get(`/api/booking/${b.id}`);
      setForm({
        id: d.booking.id,
        booking_no: d.booking.booking_no,
        partner_id: String(d.booking.partner_id),
        booking_date: d.booking.booking_date,
        valid_until: d.booking.valid_until || '',
        note: d.booking.note || '',
        items: d.booking.items.map((i) => ({
          id: i.id, product_id: String(i.product_id), qty: i.qty, unit_cost: i.unit_cost, qty_called: i.qty_called,
        })),
      });
    } catch (err) {
      toast.error(err.message);
    }
  }

  async function simpan(e) {
    e.preventDefault();
    setMenyimpan(true);
    try {
      const isi = {
        partner_id: Number(form.partner_id),
        booking_date: form.booking_date,
        valid_until: form.valid_until || null,
        note: form.note || null,
        items: form.items
          .filter((i) => i.product_id && Number(i.qty) > 0)
          .map((i) => ({
            ...(i.id ? { id: i.id } : {}),
            product_id: Number(i.product_id),
            qty: Number(i.qty),
            unit_cost: Number(i.unit_cost) || 0,
          })),
      };
      const res = form.id ? await api.put(`/api/booking/${form.id}`, isi) : await api.post('/api/booking', isi);
      toast.success(res.message);
      setForm(null);
      load();
    } catch (err) {
      toast.error(err.message);
    } finally {
      setMenyimpan(false);
    }
  }

  // ---------- panggil kirim ----------
  async function bukaPanggil(b) {
    try {
      const d = await api.get(`/api/booking/${b.id}`);
      setPanggil({
        booking: d.booking,
        order_date: today(),
        expected_date: '',
        payment: 'CREDIT',
        cash_code: '',
        invoice_no: '',
        note: '',
        lines: d.booking.items
          .filter((i) => i.sisa_pabrik > 0)
          .map((i) => ({ ...i, qty: '', unit_cost: i.unit_cost })),
      });
    } catch (err) {
      toast.error(err.message);
    }
  }

  async function simpanPanggil(e) {
    e.preventDefault();
    setMenyimpan(true);
    try {
      const res = await api.post(`/api/booking/${panggil.booking.id}/panggil`, {
        order_date: panggil.order_date,
        expected_date: panggil.expected_date || null,
        payment: panggil.payment,
        cash_code: panggil.payment === 'CREDIT' ? null : panggil.cash_code || null,
        invoice_no: panggil.invoice_no || null,
        note: panggil.note || null,
        lines: panggil.lines.map((l) => ({
          booking_item_id: l.id, qty: Number(l.qty) || 0, unit_cost: Number(l.unit_cost) || 0,
        })),
      });
      toast.success(res.message);
      setPanggil(null);
      load();
    } catch (err) {
      toast.error(err.message);
    } finally {
      setMenyimpan(false);
    }
  }

  async function batal(b) {
    if (!window.confirm(
      `Batalkan booking ${b.booking_no}? Sisa ${num(b.sisa_pabrik)} di pabrik tidak lagi ditunggu. ` +
      'Pesanan yang sudah dipanggil darinya tetap berjalan.'
    )) return;
    try {
      const res = await api.patch(`/api/booking/${b.id}/batal`);
      toast.success(res.message);
      load();
    } catch (err) {
      toast.error(err.message);
    }
  }

  async function lihat(b) {
    try {
      setDetail((await api.get(`/api/booking/${b.id}`)).booking);
    } catch (err) {
      toast.error(err.message);
    }
  }

  if (loading && !pabrik) return <Spinner />;

  const nilaiPanggil = panggil
    ? panggil.lines.reduce((s, l) => s + (Number(l.qty) || 0) * (Number(l.unit_cost) || 0), 0)
    : 0;

  return (
    <div>
      <PageHeader
        title="Pre-Order / Booking Stok"
        subtitle="Kunci stok di pabrik, panggil kirim sebagian, pantau sisanya"
      >
        {boleh && (
          <button className="btn-primary" onClick={() => setForm(KOSONG())}>
            <Plus size={16} /> Booking Baru
          </button>
        )}
      </PageHeader>

      <div className="mb-4 grid grid-cols-1 gap-3 sm:grid-cols-3">
        <StatCard label="Barang tersimpan di pabrik" value={num(pabrik.ringkas.barang)} sub="jenis barang" icon={Factory} tone="brand" />
        <StatCard label="Sisa di pabrik" value={num(pabrik.ringkas.sisa_pabrik)} sub="belum dipanggil" icon={PackageOpen} tone="amber" />
        <StatCard label="Dalam perjalanan" value={num(pabrik.ringkas.dalam_perjalanan)} sub="sudah dipanggil, belum diterima" icon={Truck} tone="green" />
      </div>

      <div className="mb-4 flex gap-1.5 rounded-xl bg-surface p-1.5 shadow-sm ring-1 ring-slate-200/70">
        {[
          { key: 'pabrik', label: 'Stok di Pabrik', icon: Factory },
          { key: 'daftar', label: `Daftar Booking (${daftar.rows.length})`, icon: CalendarClock },
        ].map((t) => (
          <button
            key={t.key} onClick={() => setTab(t.key)}
            className={`flex flex-1 items-center justify-center gap-2 rounded-lg px-3 py-2 text-sm font-semibold transition ${
              tab === t.key ? 'bg-brand-600 text-white shadow-sm shadow-brand-600/30' : 'text-slate-600 hover:bg-slate-100'
            }`}
          >
            <t.icon size={16} /> {t.label}
          </button>
        ))}
      </div>

      {tab === 'pabrik' ? (
        <div className="card">
          {pabrik.rows.length === 0 ? (
            <EmptyState message="Belum ada stok yang tersimpan di pabrik" hint="Buat booking untuk mengunci stok di supplier" />
          ) : (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>Barang</th><th>Supplier / Pabrik</th>
                    <th className="text-right">Dibooking</th>
                    <th className="text-right">Sudah dipanggil</th>
                    <th className="text-right">Sisa di pabrik</th>
                    <th className="text-right">Dalam perjalanan</th>
                    <th className="text-right">Stok gudang</th>
                    <th className="text-right">Total tersedia</th>
                    <th>Berlaku s/d</th>
                  </tr>
                </thead>
                <tbody>
                  {pabrik.rows.map((r) => (
                    <tr key={`${r.product_id}-${r.partner_id}`}>
                      <td>
                        <p className="font-medium text-slate-900">{r.product_name}</p>
                        <p className="text-xs text-slate-400">{r.sku}</p>
                      </td>
                      <td className="text-sm">{r.supplier_name}</td>
                      <td className="tabular text-right">{num(r.dibooking)} {r.unit}</td>
                      <td className="tabular text-right">{num(r.dipanggil)}</td>
                      <td className="tabular text-right font-bold text-amber-700">{num(r.sisa_pabrik)} {r.unit}</td>
                      <td className="tabular text-right text-emerald-700">{num(r.dalam_perjalanan)}</td>
                      <td className="tabular text-right">{num(r.stok_gudang)}</td>
                      <td className="tabular text-right font-semibold">{num(r.total_tersedia)} {r.unit}</td>
                      <td className="text-xs">
                        {r.berlaku_sampai
                          ? <span className={r.kadaluarsa ? 'badge-red' : 'text-slate-600'}>{dateID(r.berlaku_sampai)}</span>
                          : '-'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="mt-2 text-xs text-slate-500">
                <strong>Total tersedia</strong> = stok di gudang + dalam perjalanan + sisa di pabrik — angka yang bisa
                diandalkan untuk berjualan sebelum memesan ulang.
              </p>
            </div>
          )}
        </div>
      ) : (
        <div className="card">
          {daftar.rows.length === 0 ? (
            <EmptyState message="Belum ada booking" />
          ) : (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>No. Booking</th><th>Tanggal</th><th>Supplier</th>
                    <th className="text-right">Dibooking</th><th>Terpakai</th>
                    <th className="text-right">Sisa di pabrik</th><th className="text-right">Nilai</th>
                    <th>Status</th><th />
                  </tr>
                </thead>
                <tbody>
                  {daftar.rows.map((b) => (
                    <tr key={b.id}>
                      <td className="font-mono text-xs">{b.booking_no}</td>
                      <td className="tabular text-xs">
                        {dateID(b.booking_date)}
                        {b.valid_until && (
                          <span className={`block ${b.kadaluarsa ? 'text-rose-600' : 'text-slate-400'}`}>
                            s/d {dateID(b.valid_until)}
                          </span>
                        )}
                      </td>
                      <td className="text-sm">{b.supplier_name}</td>
                      <td className="tabular text-right">{num(b.qty)}</td>
                      <td className="min-w-[120px]">
                        <div className="h-2 overflow-hidden rounded-full bg-slate-100">
                          <div className="h-full rounded-full bg-brand-500" style={{ width: `${Math.min(100, b.persen)}%` }} />
                        </div>
                        <span className="text-[11px] text-slate-500">{b.persen}% dipanggil</span>
                      </td>
                      <td className="tabular text-right font-semibold text-amber-700">{num(b.sisa_pabrik)}</td>
                      <td className="tabular text-right">{rupiah(b.total)}</td>
                      <td><span className={WARNA[b.status]}>{b.status_label}</span></td>
                      <td>
                        <div className="flex justify-end gap-1">
                          {boleh && b.status === 'AKTIF' && (
                            <button className="btn-primary !px-2.5 !py-1 text-xs" onClick={() => bukaPanggil(b)}>
                              <Truck size={13} /> Panggil Kirim
                            </button>
                          )}
                          <button className="btn-ghost !px-2 !py-1" title="Detail" aria-label="Detail" onClick={() => lihat(b)}>
                            <Eye size={14} />
                          </button>
                          {boleh && b.status !== 'BATAL' && (
                            <button className="btn-ghost !px-2 !py-1" title="Ubah" aria-label="Ubah" onClick={() => bukaUbah(b)}>
                              <Pencil size={14} />
                            </button>
                          )}
                          {boleh && b.status === 'AKTIF' && (
                            <button className="btn-ghost !px-2 !py-1 text-rose-600" title="Batalkan" aria-label="Batalkan" onClick={() => batal(b)}>
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
      )}

      {/* ---------- FORM BOOKING ---------- */}
      <Modal open={!!form} onClose={() => setForm(null)} title={form?.id ? `Ubah Booking — ${form.booking_no}` : 'Booking Stok Baru'} wide>
        {form && (
          <form onSubmit={simpan} className="grid gap-3 sm:grid-cols-2">
            <p className="sm:col-span-2 rounded-xl bg-slate-50 px-3 py-2 text-xs leading-relaxed text-slate-600">
              Booking <strong>tidak menambah stok dan tidak membentuk utang</strong> — barangnya masih di pabrik.
              Stok dan utang baru terbentuk saat barang dipanggil kirim lalu diterima di gudang.
            </p>
            <Field label="Supplier / Pabrik *" className="sm:col-span-2">
              <select className="input" required value={form.partner_id} onChange={(e) => setForm({ ...form, partner_id: e.target.value })}>
                <option value="">— pilih supplier —</option>
                {suppliers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
            </Field>
            <Field label="Tanggal booking *">
              <input type="date" className="input" required value={form.booking_date} onChange={(e) => setForm({ ...form, booking_date: e.target.value })} />
            </Field>
            <Field label="Berlaku sampai" hint="Batas waktu stok dikunci di pabrik">
              <input type="date" className="input" value={form.valid_until} onChange={(e) => setForm({ ...form, valid_until: e.target.value })} />
            </Field>
            <Field label="Catatan" className="sm:col-span-2">
              <input className="input" maxLength={300} value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} />
            </Field>

            <div className="sm:col-span-2">
              <div className="mb-2 flex items-center justify-between">
                <p className="label !mb-0">Barang yang dibooking *</p>
                <button type="button" className="btn-ghost !py-1 text-xs"
                  onClick={() => setForm({ ...form, items: [...form.items, { product_id: '', qty: '', unit_cost: '' }] })}>
                  <Plus size={14} /> Tambah baris
                </button>
              </div>
              <div className="space-y-2">
                {form.items.map((it, i) => {
                  const terpakai = Number(it.qty_called) > 0;
                  return (
                    <div key={it.id || `baru-${i}`}>
                      <div className="grid grid-cols-12 gap-2">
                        <select className="input col-span-6" required value={it.product_id} disabled={terpakai}
                          onChange={(e) => setItem(i, { product_id: e.target.value })}>
                          <option value="">— pilih barang —</option>
                          {products.map((p) => <option key={p.id} value={p.id}>{p.sku} — {p.name}</option>)}
                        </select>
                        <input type="number" min={terpakai ? it.qty_called : 0} step="any" className="input col-span-2" placeholder="Qty" required
                          value={it.qty} onChange={(e) => setItem(i, { qty: e.target.value })} />
                        <input type="number" min="0" step="any" className="input col-span-3" placeholder="Harga booking"
                          value={it.unit_cost} onChange={(e) => setItem(i, { unit_cost: e.target.value })} />
                        <button type="button" className="btn-ghost col-span-1 !px-2 text-rose-600 disabled:opacity-30" disabled={terpakai}
                          aria-label="Hapus baris" onClick={() => setForm({ ...form, items: form.items.filter((_, x) => x !== i) })}>
                          <Trash2 size={15} />
                        </button>
                      </div>
                      {terpakai && (
                        <p className="mt-1 text-[11px] text-amber-700">
                          {num(it.qty_called)} sudah dipanggil — barang terkunci, jumlah tidak bisa di bawah itu
                        </p>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>

            <div className="flex gap-2 sm:col-span-2">
              <button type="button" className="btn-secondary flex-1" onClick={() => setForm(null)}>Batal</button>
              <button type="submit" className="btn-primary flex-1" disabled={menyimpan}>
                {menyimpan ? 'Menyimpan...' : form.id ? 'Simpan Perubahan' : 'Simpan Booking'}
              </button>
            </div>
          </form>
        )}
      </Modal>

      {/* ---------- PANGGIL KIRIM ---------- */}
      <Modal open={!!panggil} onClose={() => setPanggil(null)} title={`Panggil Kirim — ${panggil?.booking.booking_no || ''}`} wide>
        {panggil && (
          <form onSubmit={simpanPanggil} className="grid gap-3 sm:grid-cols-2">
            <p className="sm:col-span-2 rounded-xl bg-brand-50 px-3 py-2 text-xs leading-relaxed text-brand-800">
              Barang yang dipanggil menjadi <strong>Pesanan Pembelian</strong> ke {panggil.booking.supplier_name}.
              Sisa di pabrik langsung berkurang; stok gudang bertambah saat barangnya diterima di menu
              Penerimaan Barang.
            </p>
            <Field label="Tanggal pesan *">
              <input type="date" className="input" required value={panggil.order_date} onChange={(e) => setPanggil({ ...panggil, order_date: e.target.value })} />
            </Field>
            <Field label="Perkiraan tiba">
              <input type="date" className="input" value={panggil.expected_date} onChange={(e) => setPanggil({ ...panggil, expected_date: e.target.value })} />
            </Field>
            <Field label="Cara bayar *">
              <select className="input" value={panggil.payment}
                onChange={(e) => setPanggil({ ...panggil, payment: e.target.value, cash_code: e.target.value === 'CASH' ? KODE_KAS_TUNAI : '' })}>
                <option value="CREDIT">Tempo (utang supplier)</option>
                <option value="BANK">Transfer bank</option>
                <option value="CASH">Tunai</option>
              </select>
            </Field>
            {panggil.payment !== 'CREDIT' ? (
              <Field label={panggil.payment === 'BANK' ? 'Transfer dari rekening *' : 'Dibayar dari *'}>
                <select className="input" required value={panggil.cash_code} onChange={(e) => setPanggil({ ...panggil, cash_code: e.target.value })}>
                  <option value="">— pilih rekening —</option>
                  {rekening
                    .filter((k) => k.code !== kodeMp)
                    .filter((k) => panggil.payment !== 'BANK' || k.code !== KODE_KAS_TUNAI)
                    .map((k) => <option key={k.code} value={k.code}>{k.code} — {k.name}</option>)}
                </select>
              </Field>
            ) : (
              <Field label="No. faktur supplier">
                <input className="input" maxLength={60} value={panggil.invoice_no} onChange={(e) => setPanggil({ ...panggil, invoice_no: e.target.value })} />
              </Field>
            )}

            <div className="sm:col-span-2">
              <p className="label">Jumlah yang dipanggil</p>
              <div className="table-wrap">
                <table className="table text-sm">
                  <thead>
                    <tr><th>Barang</th><th className="text-right">Sisa di pabrik</th><th>Panggil</th><th>Harga nota</th></tr>
                  </thead>
                  <tbody>
                    {panggil.lines.map((l, i) => (
                      <tr key={l.id}>
                        <td>{l.product_name}<span className="block text-xs text-slate-400">{l.sku}</span></td>
                        <td className="tabular text-right font-semibold text-amber-700">{num(l.sisa_pabrik)} {l.unit}</td>
                        <td className="w-32">
                          <input type="number" min="0" max={l.sisa_pabrik} step="any" className="input !py-1.5" placeholder="0"
                            value={l.qty}
                            onChange={(e) => {
                              const lines = [...panggil.lines];
                              lines[i] = { ...l, qty: e.target.value };
                              setPanggil({ ...panggil, lines });
                            }} />
                        </td>
                        <td className="w-36">
                          <input type="number" min="0" step="any" className="input !py-1.5"
                            value={l.unit_cost}
                            onChange={(e) => {
                              const lines = [...panggil.lines];
                              lines[i] = { ...l, unit_cost: e.target.value };
                              setPanggil({ ...panggil, lines });
                            }} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
            <Field label="Catatan" className="sm:col-span-2">
              <input className="input" maxLength={300} value={panggil.note} placeholder={`Dipanggil dari booking ${panggil.booking.booking_no}`}
                onChange={(e) => setPanggil({ ...panggil, note: e.target.value })} />
            </Field>
            <div className="flex items-center justify-between rounded-xl bg-slate-50 px-3 py-2.5 sm:col-span-2">
              <span className="text-sm font-semibold text-slate-700">Nilai pesanan</span>
              <span className="tabular text-base font-bold text-slate-900">{rupiah(nilaiPanggil)}</span>
            </div>
            <div className="flex gap-2 sm:col-span-2">
              <button type="button" className="btn-secondary flex-1" onClick={() => setPanggil(null)}>Batal</button>
              <button type="submit" className="btn-primary flex-1" disabled={menyimpan || !panggil.lines.some((l) => Number(l.qty) > 0)}>
                <Truck size={16} /> {menyimpan ? 'Membuat pesanan...' : 'Buat Pesanan Pembelian'}
              </button>
            </div>
          </form>
        )}
      </Modal>

      {/* ---------- DETAIL ---------- */}
      <Modal open={!!detail} onClose={() => setDetail(null)} title={`Booking ${detail?.booking_no || ''}`} wide>
        {detail && (
          <div className="grid gap-3">
            <p className="text-sm text-slate-600">
              {detail.supplier_name} · {dateID(detail.booking_date)}
              {detail.valid_until && <> · berlaku s/d {dateID(detail.valid_until)}</>}
              {' · '}<span className={WARNA[detail.status]}>{detail.status_label}</span>
            </p>
            <div className="table-wrap">
              <table className="table text-sm">
                <thead>
                  <tr><th>Barang</th><th className="text-right">Dibooking</th><th className="text-right">Dipanggil</th>
                    <th className="text-right">Diterima</th><th className="text-right">Sisa di pabrik</th><th className="text-right">Harga</th></tr>
                </thead>
                <tbody>
                  {detail.items.map((i) => (
                    <tr key={i.id}>
                      <td>{i.product_name}</td>
                      <td className="tabular text-right">{num(i.qty)} {i.unit}</td>
                      <td className="tabular text-right">{num(i.qty_called)}</td>
                      <td className="tabular text-right">{num(i.qty_received)}</td>
                      <td className="tabular text-right font-semibold text-amber-700">{num(i.sisa_pabrik)}</td>
                      <td className="tabular text-right">{rupiah(i.unit_cost)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div>
              <p className="label">Pesanan yang dipanggil dari booking ini</p>
              {detail.pesanan.length === 0 ? (
                <p className="text-sm text-slate-500">Belum ada.</p>
              ) : (
                <ul className="space-y-1 text-sm">
                  {detail.pesanan.map((po) => (
                    <li key={po.id} className="flex justify-between gap-3 rounded-lg bg-slate-50 px-3 py-1.5">
                      <span className="font-mono text-xs">{po.po_no} · {dateID(po.order_date)}</span>
                      <span className="text-xs">{num(po.qty)} · {po.status_label}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}
