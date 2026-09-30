import { useEffect, useState, useCallback } from 'react';
import { Link } from 'react-router-dom';
import {
  FileText, ClipboardList, History, Printer, Eye, XCircle, Wallet, CheckCircle2, AlertTriangle, Truck,
} from 'lucide-react';
import { api } from '../lib/api';
import {
  PageHeader, StatCard, Spinner, EmptyState, Modal, useToast, Field,
  DateRangeFilter, defaultRange, TombolCetak,
} from '../components/ui';
import { rupiah, num, dateID, today } from '../lib/format';
import { useAuth } from '../lib/auth';

const WARNA_BAYAR = { LUNAS: 'badge-green', BELUM: 'badge-amber', JATUH_TEMPO: 'badge-red', BATAL: 'badge-slate' };

/**
 * Faktur Penjualan (Invoice).
 *
 * Tagihan resmi ke pelanggan yang ditarik dari surat jalan: pilih surat jalan
 * yang belum ditagih (boleh beberapa dari order yang sama), periksa barang &
 * harganya, lalu terbitkan dan cetak. Status lunas mengikuti ordernya —
 * pelunasan tetap dicatat lewat order / Utang & Piutang seperti biasa.
 */
export default function Faktur() {
  const toast = useToast();
  const { punya } = useAuth();
  const boleh = punya('penjualan.faktur');

  const [tab, setTab] = useState('calon');
  const [calon, setCalon] = useState(null);
  const [pilih, setPilih] = useState({});
  const [daftar, setDaftar] = useState(null);
  const [range, setRange] = useState(defaultRange);
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('');
  const [form, setForm] = useState(null);
  const [detail, setDetail] = useState(null);
  const [menyimpan, setMenyimpan] = useState(false);

  const muatCalon = useCallback(async () => {
    try {
      setCalon(await api.get('/api/faktur/calon'));
    } catch (err) {
      toast.error(err.message);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const muatDaftar = useCallback(async () => {
    try {
      setDaftar(await api.get('/api/faktur', { ...range, q, status }));
    } catch (err) {
      toast.error(err.message);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [range, q, status]);

  useEffect(() => { muatCalon(); }, [muatCalon]);
  useEffect(() => {
    const t = setTimeout(muatDaftar, 250);
    return () => clearTimeout(t);
  }, [muatDaftar]);

  const terpilih = (orderId) => Object.entries(pilih[orderId] || {}).filter(([, v]) => v).map(([k]) => Number(k));

  function centang(orderId, doId, nilai) {
    setPilih({ ...pilih, [orderId]: { ...(pilih[orderId] || {}), [doId]: nilai } });
  }

  async function siapkan(grup) {
    const ids = terpilih(grup.order_id);
    const doIds = ids.length ? ids : grup.suratJalan.map((d) => d.id);
    try {
      const s = await api.get('/api/faktur/siapkan', { order_id: grup.order_id, do_ids: doIds.join(',') });
      setForm({
        ...s,
        do_ids: doIds,
        invoice_date: today(),
        due_date: s.bawaan.due_date,
        customer_name: s.bawaan.customer_name,
        customer_phone: s.bawaan.customer_phone,
        address: s.bawaan.address,
        discount: s.bawaan.discount,
        shipping: s.bawaan.shipping,
        note: '',
      });
    } catch (err) {
      toast.error(err.message);
    }
  }

  async function simpan(e) {
    e.preventDefault();
    setMenyimpan(true);
    try {
      const res = await api.post('/api/faktur', {
        order_id: form.order.id,
        do_ids: form.do_ids,
        invoice_date: form.invoice_date,
        due_date: form.due_date || null,
        customer_name: form.customer_name,
        customer_phone: form.customer_phone || null,
        address: form.address || null,
        discount: Number(form.discount) || 0,
        shipping: Number(form.shipping) || 0,
        note: form.note || null,
      });
      toast.success(res.message);
      setForm(null);
      setPilih({});
      muatCalon();
      muatDaftar();
      setDetail(res.faktur);
    } catch (err) {
      toast.error(err.message);
    } finally {
      setMenyimpan(false);
    }
  }

  async function lihat(id) {
    try {
      setDetail(await api.get(`/api/faktur/${id}`));
    } catch (err) {
      toast.error(err.message);
    }
  }

  async function batalkan(f) {
    if (!window.confirm(`Batalkan faktur ${f.invoice_no}? Surat jalannya kembali bisa ditagih.`)) return;
    try {
      const res = await api.patch(`/api/faktur/${f.id}/batal`);
      toast.success(res.message);
      setDetail(null);
      muatCalon();
      muatDaftar();
    } catch (err) {
      toast.error(err.message);
    }
  }

  if (!calon) return <Spinner />;

  const r = daftar?.ringkas;
  const totalForm = form ? form.subtotal - (Number(form.discount) || 0) + (Number(form.shipping) || 0) : 0;
  const siapTagih = calon.rows.reduce((s, g) => s + g.suratJalan.length, 0);

  return (
    <div>
      <PageHeader title="Faktur Penjualan" subtitle="Tagihan resmi ke pelanggan, ditarik dari surat jalan — nomor GI/INV">
        <Link className="btn-secondary" to="/penjualan/surat-jalan"><Truck size={16} /> Surat Jalan</Link>
      </PageHeader>

      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard label="Total faktur" value={rupiah(r?.total || 0)} sub={`${num(r?.jumlah || 0)} faktur pada rentang`} icon={FileText} tone="brand" />
        <StatCard label="Sudah lunas" value={rupiah(r?.lunas || 0)} icon={CheckCircle2} tone="green" />
        <StatCard label="Belum lunas" value={rupiah(r?.belum || 0)} sub={`lewat jatuh tempo ${rupiah(r?.jatuhTempo || 0)}`} icon={Wallet} tone="amber" />
        <StatCard label="Surat jalan siap ditagih" value={num(siapTagih)} sub={`${num(calon.rows.length)} order`} icon={AlertTriangle} tone="slate" />
      </div>

      <div className="mb-4 flex gap-1.5 rounded-xl bg-surface p-1.5 shadow-sm ring-1 ring-slate-200/70">
        {[
          { key: 'calon', label: `Siap Ditagih (${siapTagih})`, icon: ClipboardList },
          { key: 'daftar', label: 'Daftar Faktur', icon: History },
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

      {tab === 'calon' ? (
        calon.rows.length === 0 ? (
          <div className="card"><EmptyState message="Tidak ada surat jalan yang menunggu ditagih" hint="Buat surat jalan dulu di menu Surat Jalan" /></div>
        ) : (
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {calon.rows.map((g) => (
              <div key={g.order_id} className="card flex flex-col">
                <p className="font-mono text-xs text-slate-500">{g.order_no}</p>
                <p className="mb-2 truncate font-bold text-slate-900">{g.customer || '-'}</p>
                <ul className="mb-3 space-y-1 text-sm">
                  {g.suratJalan.map((d) => (
                    <li key={d.id} className="flex items-center gap-2 rounded-lg bg-slate-50 px-3 py-1.5">
                      {g.suratJalan.length > 1 && (
                        <input type="checkbox" className="h-4 w-4" checked={!!pilih[g.order_id]?.[d.id]}
                          onChange={(e) => centang(g.order_id, d.id, e.target.checked)} />
                      )}
                      <span className="font-mono text-xs">{d.do_no}</span>
                      <span className="text-xs text-slate-500">{dateID(d.do_date)}</span>
                      <span className="tabular ml-auto font-semibold">{num(d.total_qty)}</span>
                    </li>
                  ))}
                </ul>
                {g.suratJalan.length > 1 && (
                  <p className="mb-2 text-xs text-slate-500">Centang yang akan ditagih; tanpa centang = semua digabung dalam satu faktur.</p>
                )}
                {boleh && (
                  <button className="btn-primary mt-auto w-full" onClick={() => siapkan(g)}>
                    <FileText size={16} /> Buat Faktur
                  </button>
                )}
              </div>
            ))}
          </div>
        )
      ) : (
        <>
          <DateRangeFilter range={range} onChange={setRange}>
            <div className="min-w-[200px] flex-[2]">
              <label className="label">Cari</label>
              <input className="input" placeholder="No. faktur, no. order, pelanggan" value={q} onChange={(e) => setQ(e.target.value)} />
            </div>
            <div className="min-w-[150px] flex-1">
              <label className="label">Status bayar</label>
              <select className="input" value={status} onChange={(e) => setStatus(e.target.value)}>
                <option value="">Semua</option>
                <option value="BELUM">Belum lunas</option>
                <option value="JATUH_TEMPO">Lewat jatuh tempo</option>
                <option value="LUNAS">Lunas</option>
                <option value="BATAL">Batal</option>
              </select>
            </div>
          </DateRangeFilter>
          <div className="card">
            {!daftar ? <Spinner /> : daftar.rows.length === 0 ? (
              <EmptyState message="Belum ada faktur pada rentang ini" />
            ) : (
              <div className="table-wrap">
                <table className="table">
                  <thead>
                    <tr>
                      <th>No. Faktur</th><th>Tanggal</th><th>Jatuh tempo</th><th>Pelanggan</th><th>No. Order</th>
                      <th>Surat jalan</th><th className="text-right">Total</th><th>Status</th><th />
                    </tr>
                  </thead>
                  <tbody>
                    {daftar.rows.map((f) => (
                      <tr key={f.id} className={f.status === 'BATAL' ? 'opacity-60' : ''}>
                        <td className="font-mono text-xs">{f.invoice_no}</td>
                        <td className="tabular">{dateID(f.invoice_date)}</td>
                        <td className="tabular">{f.due_date ? dateID(f.due_date) : '-'}</td>
                        <td className="text-sm">{f.customer_name}</td>
                        <td className="font-mono text-xs">{f.order_no}</td>
                        <td className="font-mono text-xs">{f.surat_jalan || '-'}</td>
                        <td className="tabular text-right font-semibold">{rupiah(f.total)}</td>
                        <td><span className={WARNA_BAYAR[f.status_bayar]}>{f.status_bayar_label}</span></td>
                        <td>
                          <div className="flex justify-end gap-1">
                            <button className="btn-ghost !px-2 !py-1" aria-label="Detail" onClick={() => lihat(f.id)}><Eye size={14} /></button>
                            <TombolCetak path={`/api/faktur/${f.id}/pdf`} label="" icon={Printer} kecil />
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

      {/* ---------- FORM FAKTUR ---------- */}
      <Modal open={!!form} onClose={() => setForm(null)} title={`Buat Faktur — ${form?.order.order_no || ''}`} wide>
        {form && (
          <form onSubmit={simpan} className="grid gap-3 sm:grid-cols-2">
            <p className="sm:col-span-2 text-sm text-slate-600">
              Dari surat jalan <strong className="font-mono">{form.suratJalan.map((d) => d.do_no).join(', ')}</strong>.
              Harga mengikuti order penjualan.
            </p>
            <Field label="Tanggal faktur *">
              <input type="date" className="input" required value={form.invoice_date} onChange={(e) => setForm({ ...form, invoice_date: e.target.value })} />
            </Field>
            <Field label="Jatuh tempo">
              <input type="date" className="input" min={form.invoice_date} value={form.due_date || ''} onChange={(e) => setForm({ ...form, due_date: e.target.value })} />
            </Field>
            <Field label="Ditagihkan kepada *">
              <input className="input" required maxLength={120} value={form.customer_name} onChange={(e) => setForm({ ...form, customer_name: e.target.value })} />
            </Field>
            <Field label="Telp/WA">
              <input className="input" maxLength={40} value={form.customer_phone || ''} onChange={(e) => setForm({ ...form, customer_phone: e.target.value })} />
            </Field>
            <Field label="Alamat" className="sm:col-span-2">
              <input className="input" maxLength={400} value={form.address || ''} onChange={(e) => setForm({ ...form, address: e.target.value })} />
            </Field>

            <div className="table-wrap sm:col-span-2">
              <table className="table text-sm">
                <thead><tr><th>Barang</th><th className="text-right">Jumlah</th><th className="text-right">Harga</th><th className="text-right">Subtotal</th></tr></thead>
                <tbody>
                  {form.items.map((i) => (
                    <tr key={i.product_id}>
                      <td>{i.product_name}</td>
                      <td className="tabular text-right">{num(i.qty)} {i.unit}</td>
                      <td className="tabular text-right">{rupiah(i.price)}</td>
                      <td className="tabular text-right font-semibold">{rupiah(i.subtotal)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <Field label="Diskon (Rp)" hint="Bawaan dari order pada faktur pertama">
              <input type="number" min="0" step="any" className="input" value={form.discount} onChange={(e) => setForm({ ...form, discount: e.target.value })} />
            </Field>
            <Field label="Ongkos kirim (Rp)">
              <input type="number" min="0" step="any" className="input" value={form.shipping} onChange={(e) => setForm({ ...form, shipping: e.target.value })} />
            </Field>
            <Field label="Catatan" className="sm:col-span-2">
              <input className="input" maxLength={400} value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} />
            </Field>

            <div className="sm:col-span-2 rounded-xl bg-brand-50 px-4 py-3 text-sm">
              <div className="flex justify-between"><span>Subtotal</span><span className="tabular">{rupiah(form.subtotal)}</span></div>
              {Number(form.discount) > 0 && <div className="flex justify-between"><span>Diskon</span><span className="tabular">− {rupiah(Number(form.discount))}</span></div>}
              {Number(form.shipping) > 0 && <div className="flex justify-between"><span>Ongkos kirim</span><span className="tabular">{rupiah(Number(form.shipping))}</span></div>}
              <div className="mt-1 flex justify-between border-t border-brand-200 pt-1 text-base font-bold">
                <span>Total tagihan</span><span className="tabular">{rupiah(totalForm)}</span>
              </div>
            </div>

            <div className="flex gap-2 sm:col-span-2">
              <button type="button" className="btn-secondary flex-1" onClick={() => setForm(null)}>Batal</button>
              <button type="submit" className="btn-primary flex-1" disabled={menyimpan || totalForm < 0}>
                <FileText size={16} /> {menyimpan ? 'Menyimpan...' : 'Terbitkan Faktur'}
              </button>
            </div>
          </form>
        )}
      </Modal>

      {/* ---------- DETAIL ---------- */}
      <Modal open={!!detail} onClose={() => setDetail(null)} title={detail?.invoice_no || ''} wide>
        {detail && (
          <div className="grid gap-3">
            <div className="flex flex-wrap items-center gap-2 text-sm text-slate-600">
              <span className={WARNA_BAYAR[detail.status_bayar]}>{detail.status_bayar_label}</span>
              {dateID(detail.invoice_date)}
              {detail.due_date && <> · jatuh tempo {dateID(detail.due_date)}</>}
              {` · order ${detail.order_no}`}
            </div>
            <div className="rounded-xl bg-slate-50 p-3 text-sm">
              <p className="text-xs text-slate-500">Ditagihkan kepada</p>
              <p className="font-semibold">{detail.customer_name}</p>
              {detail.address && <p className="text-xs">{detail.address}</p>}
              {detail.customer_phone && <p className="text-xs">{detail.customer_phone}</p>}
              <p className="mt-1 text-xs text-slate-500">Surat jalan: {detail.suratJalan.map((d) => d.do_no).join(', ') || '-'}</p>
            </div>
            <div className="table-wrap">
              <table className="table text-sm">
                <thead><tr><th>Barang</th><th className="text-right">Jumlah</th><th className="text-right">Harga</th><th className="text-right">Subtotal</th></tr></thead>
                <tbody>
                  {detail.items.map((i) => (
                    <tr key={i.id}>
                      <td>{i.product_name}</td>
                      <td className="tabular text-right">{num(i.qty)} {i.unit}</td>
                      <td className="tabular text-right">{rupiah(i.price)}</td>
                      <td className="tabular text-right font-semibold">{rupiah(i.subtotal)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="ml-auto w-full max-w-xs text-sm">
              <div className="flex justify-between"><span>Subtotal</span><span className="tabular">{rupiah(detail.subtotal)}</span></div>
              {detail.discount > 0 && <div className="flex justify-between"><span>Diskon</span><span className="tabular">− {rupiah(detail.discount)}</span></div>}
              {detail.shipping > 0 && <div className="flex justify-between"><span>Ongkos kirim</span><span className="tabular">{rupiah(detail.shipping)}</span></div>}
              <div className="flex justify-between border-t pt-1 font-bold"><span>Total</span><span className="tabular">{rupiah(detail.total)}</span></div>
            </div>
            {detail.status_bayar !== 'LUNAS' && detail.status !== 'BATAL' && (
              <p className="rounded-xl bg-amber-50 px-3 py-2 text-xs text-amber-800">
                Status lunas faktur mengikuti status bayar order {detail.order_no}. Setelah uangnya masuk, buka order
                tersebut → Ubah → Status bayar: Lunas (pilih rekening penerima); faktur ikut menjadi Lunas.
              </p>
            )}
            <div className="flex flex-wrap gap-2">
              <TombolCetak path={`/api/faktur/${detail.id}/pdf`} label="Cetak Faktur" icon={Printer} />
              {boleh && detail.status !== 'BATAL' && (
                <button className="btn-danger" onClick={() => batalkan(detail)}><XCircle size={16} /> Batalkan Faktur</button>
              )}
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}
