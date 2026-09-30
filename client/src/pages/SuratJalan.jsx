import { useEffect, useState, useCallback } from 'react';
import { Link } from 'react-router-dom';
import {
  Truck, ClipboardList, History, Printer, Eye, Pencil, CheckCircle2, XCircle, PackageCheck, FileText,
} from 'lucide-react';
import { api } from '../lib/api';
import {
  PageHeader, StatCard, Spinner, EmptyState, Modal, useToast, Field,
  DateRangeFilter, defaultRange, TombolCetak,
} from '../components/ui';
import { num, dateID, today } from '../lib/format';
import { useAuth } from '../lib/auth';

const WARNA_STATUS = { DIKIRIM: 'badge-blue', DITERIMA: 'badge-green', BATAL: 'badge-slate' };

/**
 * Surat Jalan (Delivery Order).
 *
 * Dibuat dari order penjualan: pilih order, isi penerima & sopir, tentukan
 * jumlah yang dikirim (boleh bertahap), lalu cetak lembar resminya — tanpa
 * harga — untuk dibawa kurir. Stok tidak berubah di sini; ordernya yang sudah
 * mengurangi stok.
 */
export default function SuratJalan() {
  const toast = useToast();
  const { punya } = useAuth();
  const boleh = punya('penjualan.suratjalan');

  const [tab, setTab] = useState('calon');
  const [cariCalon, setCariCalon] = useState('');
  const [calon, setCalon] = useState(null);
  const [daftar, setDaftar] = useState(null);
  const [range, setRange] = useState(defaultRange);
  const [q, setQ] = useState('');
  const [form, setForm] = useState(null);
  const [detail, setDetail] = useState(null);
  const [terima, setTerima] = useState(null);
  const [menyimpan, setMenyimpan] = useState(false);

  const muatCalon = useCallback(async () => {
    try {
      setCalon(await api.get('/api/surat-jalan/calon', { q: cariCalon }));
    } catch (err) {
      toast.error(err.message);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cariCalon]);

  const muatDaftar = useCallback(async () => {
    try {
      setDaftar(await api.get('/api/surat-jalan', { ...range, q }));
    } catch (err) {
      toast.error(err.message);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [range, q]);

  useEffect(() => {
    const t = setTimeout(muatCalon, 250);
    return () => clearTimeout(t);
  }, [muatCalon]);
  useEffect(() => {
    const t = setTimeout(muatDaftar, 250);
    return () => clearTimeout(t);
  }, [muatDaftar]);

  const muatUlang = () => { muatCalon(); muatDaftar(); };

  async function buatDari(orderId) {
    try {
      const d = await api.get(`/api/surat-jalan/order/${orderId}`);
      setForm({
        id: null,
        order: d.order,
        do_date: today(),
        ...d.bawaan,
        vehicle_no: '',
        driver_name: '',
        note: '',
        lines: d.barang.filter((b) => b.sisa > 0).map((b) => ({ ...b, kirim: b.sisa, catatan: '' })),
      });
    } catch (err) {
      toast.error(err.message);
    }
  }

  async function ubah(sj) {
    try {
      const d = await api.get(`/api/surat-jalan/order/${sj.order_id}`);
      const lama = new Map(sj.items.map((i) => [i.product_id, i]));
      setDetail(null);
      setForm({
        id: sj.id,
        do_no: sj.do_no,
        order: d.order,
        do_date: sj.do_date,
        recipient_name: sj.recipient_name || '',
        recipient_phone: sj.recipient_phone || '',
        address: sj.address || '',
        city: sj.city || '',
        courier: sj.courier || '',
        tracking_no: sj.tracking_no || '',
        vehicle_no: sj.vehicle_no || '',
        driver_name: sj.driver_name || '',
        note: sj.note || '',
        // Sisa dihitung tanpa surat jalan ini sendiri: jatahnya dikembalikan dulu.
        lines: d.barang.map((b) => {
          const i = lama.get(b.product_id);
          const punyaIni = i ? i.qty : 0;
          return { ...b, sisa: b.sisa + punyaIni, kirim: punyaIni, catatan: i?.note || '' };
        }).filter((b) => b.sisa > 0),
      });
    } catch (err) {
      toast.error(err.message);
    }
  }

  function setBaris(i, patch) {
    const lines = [...form.lines];
    lines[i] = { ...lines[i], ...patch };
    setForm({ ...form, lines });
  }

  async function simpan(e) {
    e.preventDefault();
    setMenyimpan(true);
    const body = {
      do_date: form.do_date,
      recipient_name: form.recipient_name,
      recipient_phone: form.recipient_phone || null,
      address: form.address,
      city: form.city || null,
      courier: form.courier || null,
      tracking_no: form.tracking_no || null,
      vehicle_no: form.vehicle_no || null,
      driver_name: form.driver_name || null,
      note: form.note || null,
      lines: form.lines.map((l) => ({ product_id: l.product_id, qty: Number(l.kirim) || 0, note: l.catatan || null })),
    };
    try {
      const res = form.id
        ? await api.put(`/api/surat-jalan/${form.id}`, body)
        : await api.post('/api/surat-jalan', { ...body, order_id: form.order.id });
      toast.success(res.message);
      setForm(null);
      muatUlang();
      setDetail(res.suratJalan);
    } catch (err) {
      toast.error(err.message);
    } finally {
      setMenyimpan(false);
    }
  }

  async function lihat(id) {
    try {
      setDetail(await api.get(`/api/surat-jalan/${id}`));
    } catch (err) {
      toast.error(err.message);
    }
  }

  async function simpanTerima(e) {
    e.preventDefault();
    try {
      const res = await api.patch(`/api/surat-jalan/${terima.id}/terima`, {
        received_date: terima.received_date, received_by: terima.received_by || null,
      });
      toast.success(res.message);
      setTerima(null);
      setDetail(null);
      muatDaftar();
    } catch (err) {
      toast.error(err.message);
    }
  }

  async function batalkan(sj) {
    if (!window.confirm(`Batalkan surat jalan ${sj.do_no}? Jatah kirimnya kembali ke order.`)) return;
    try {
      const res = await api.patch(`/api/surat-jalan/${sj.id}/batal`);
      toast.success(res.message);
      setDetail(null);
      muatUlang();
    } catch (err) {
      toast.error(err.message);
    }
  }

  if (!calon) return <Spinner />;

  const lebih = form ? form.lines.some((l) => Number(l.kirim) > l.sisa + 0.0001) : false;
  const adaIsi = form ? form.lines.some((l) => Number(l.kirim) > 0) : false;
  const r = daftar?.ringkas;

  return (
    <div>
      <PageHeader title="Surat Jalan" subtitle="Dokumen pengiriman barang untuk kurir/sopir — nomor GI/DO, tanpa harga">
        {punya('penjualan.faktur') && (
          <Link className="btn-secondary" to="/penjualan/faktur"><FileText size={16} /> Faktur Penjualan</Link>
        )}
      </PageHeader>

      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard label="Order perlu dikirim" value={num(calon.rows.length)} sub="masih ada sisa barang" icon={ClipboardList} tone="amber" />
        <StatCard label="Surat jalan" value={num(r?.total || 0)} sub="pada rentang tanggal" icon={Truck} tone="brand" />
        <StatCard label="Dalam perjalanan" value={num(r?.dikirim || 0)} sub={`${num(r?.diterima || 0)} sudah diterima`} icon={PackageCheck} tone="slate" />
        <StatCard label="Belum difakturkan" value={num(r?.belumFaktur || 0)} sub="siap ditagih" icon={FileText} tone="green" />
      </div>

      <div className="mb-4 flex gap-1.5 rounded-xl bg-surface p-1.5 shadow-sm ring-1 ring-slate-200/70">
        {[
          { key: 'calon', label: `Perlu Dikirim (${calon.rows.length})`, icon: ClipboardList },
          { key: 'daftar', label: 'Daftar Surat Jalan', icon: History },
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
        <>
          <div className="card mb-3">
            <label className="label">Cari order</label>
            <input className="input" placeholder="No. order, nama pelanggan, no. pesanan" value={cariCalon} onChange={(e) => setCariCalon(e.target.value)} />
            <p className="mt-1 text-xs text-slate-500">Menampilkan order 120 hari terakhir yang barangnya belum dikirim seluruhnya.</p>
          </div>
          {calon.rows.length === 0 ? (
            <div className="card"><EmptyState message="Tidak ada order yang menunggu pengiriman" /></div>
          ) : (
            <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
              {calon.rows.map((o) => (
                <div key={o.id} className="card flex flex-col">
                  <div className="mb-2 flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="font-mono text-xs text-slate-500">{o.order_no}</p>
                      <p className="truncate font-bold text-slate-900">{o.buyer_name || o.customer || '-'}</p>
                      <p className="text-xs text-slate-500">
                        {dateID(o.order_date)} · {o.channel_label}{o.buyer_city && ` · ${o.buyer_city}`}
                      </p>
                    </div>
                    {o.sebagian ? <span className="badge-amber">Sebagian</span> : <span className="badge-blue">Belum dikirim</span>}
                  </div>
                  <p className="mb-3 text-sm text-slate-600">
                    Sisa kirim <strong className="tabular">{num(o.sisa)}</strong> dari {num(o.dipesan)} unit
                  </p>
                  {boleh && (
                    <button className="btn-primary mt-auto w-full" onClick={() => buatDari(o.id)}>
                      <Truck size={16} /> Buat Surat Jalan
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}
        </>
      ) : (
        <>
          <DateRangeFilter range={range} onChange={setRange}>
            <div className="min-w-[200px] flex-[2]">
              <label className="label">Cari</label>
              <input className="input" placeholder="No. surat jalan, no. order, penerima, kota" value={q} onChange={(e) => setQ(e.target.value)} />
            </div>
          </DateRangeFilter>
          <div className="card">
            {!daftar ? <Spinner /> : daftar.rows.length === 0 ? (
              <EmptyState message="Belum ada surat jalan pada rentang ini" />
            ) : (
              <div className="table-wrap">
                <table className="table">
                  <thead>
                    <tr>
                      <th>No. Surat Jalan</th><th>Tanggal</th><th>No. Order</th><th>Penerima</th><th>Kota</th>
                      <th>Sopir / Ekspedisi</th><th className="text-right">Qty</th><th>Status</th><th>Faktur</th><th />
                    </tr>
                  </thead>
                  <tbody>
                    {daftar.rows.map((d) => (
                      <tr key={d.id} className={d.status === 'BATAL' ? 'opacity-60' : ''}>
                        <td className="font-mono text-xs">{d.do_no}</td>
                        <td className="tabular">{dateID(d.do_date)}</td>
                        <td className="font-mono text-xs">{d.order_no}</td>
                        <td className="text-sm">{d.recipient_name}</td>
                        <td className="text-xs">{d.city || '-'}</td>
                        <td className="text-xs">{[d.driver_name, d.courier].filter(Boolean).join(' · ') || '-'}</td>
                        <td className="tabular text-right font-semibold">{num(d.total_qty)}</td>
                        <td><span className={WARNA_STATUS[d.status]}>{d.status_label}</span></td>
                        <td className="font-mono text-xs">{d.invoice_no || '-'}</td>
                        <td>
                          <div className="flex justify-end gap-1">
                            <button className="btn-ghost !px-2 !py-1" aria-label="Detail" onClick={() => lihat(d.id)}><Eye size={14} /></button>
                            <TombolCetak path={`/api/surat-jalan/${d.id}/pdf`} label="" icon={Printer} kecil />
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

      {/* ---------- FORM SURAT JALAN ---------- */}
      <Modal open={!!form} onClose={() => setForm(null)} title={form?.id ? `Ubah ${form.do_no}` : `Buat Surat Jalan — ${form?.order.order_no || ''}`} wide>
        {form && (
          <form onSubmit={simpan} className="grid gap-3 sm:grid-cols-2">
            <Field label="Tanggal kirim *">
              <input type="date" className="input" required value={form.do_date} onChange={(e) => setForm({ ...form, do_date: e.target.value })} />
            </Field>
            <Field label="Nama penerima *">
              <input className="input" required maxLength={120} value={form.recipient_name} onChange={(e) => setForm({ ...form, recipient_name: e.target.value })} />
            </Field>
            <Field label="Alamat kirim *" className="sm:col-span-2">
              <textarea className="input" rows={2} required maxLength={400} value={form.address} onChange={(e) => setForm({ ...form, address: e.target.value })} />
            </Field>
            <Field label="Kota">
              <input className="input" maxLength={80} value={form.city} onChange={(e) => setForm({ ...form, city: e.target.value })} />
            </Field>
            <Field label="Telp/WA penerima">
              <input className="input" maxLength={40} value={form.recipient_phone} onChange={(e) => setForm({ ...form, recipient_phone: e.target.value })} />
            </Field>
            <Field label="Nama sopir / kurir">
              <input className="input" maxLength={80} value={form.driver_name} onChange={(e) => setForm({ ...form, driver_name: e.target.value })} />
            </Field>
            <Field label="No. kendaraan">
              <input className="input" maxLength={30} placeholder="mis. AA 1234 XY" value={form.vehicle_no} onChange={(e) => setForm({ ...form, vehicle_no: e.target.value })} />
            </Field>
            <Field label="Ekspedisi">
              <input className="input" maxLength={60} value={form.courier} onChange={(e) => setForm({ ...form, courier: e.target.value })} />
            </Field>
            <Field label="No. resi">
              <input className="input" maxLength={80} value={form.tracking_no} onChange={(e) => setForm({ ...form, tracking_no: e.target.value })} />
            </Field>
            <Field label="Catatan" className="sm:col-span-2">
              <input className="input" maxLength={300} value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} />
            </Field>

            <div className="table-wrap sm:col-span-2">
              <table className="table text-sm">
                <thead>
                  <tr><th>Barang</th><th className="text-right">Dipesan</th><th className="text-right">Sisa kirim</th><th>Dikirim sekarang</th><th>Keterangan</th></tr>
                </thead>
                <tbody>
                  {form.lines.map((l, i) => (
                    <tr key={l.product_id}>
                      <td>{l.product_name}<span className="block text-xs text-slate-400">{l.sku}</span></td>
                      <td className="tabular text-right">{num(l.qty)} {l.unit}</td>
                      <td className="tabular text-right font-semibold">{num(l.sisa)}</td>
                      <td className="w-28">
                        <input type="number" min="0" max={l.sisa} step="any"
                          className={`input !py-1.5 ${Number(l.kirim) > l.sisa + 0.0001 ? 'ring-2 ring-rose-400' : ''}`}
                          value={l.kirim} onChange={(e) => setBaris(i, { kirim: e.target.value })} />
                      </td>
                      <td>
                        <input className="input !py-1.5" maxLength={120} placeholder="mis. 2 karung"
                          value={l.catatan} onChange={(e) => setBaris(i, { catatan: e.target.value })} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {lebih && (
              <p className="sm:col-span-2 rounded-xl bg-rose-50 px-3 py-2 text-xs text-rose-800">
                Jumlah kirim melebihi sisa order.
              </p>
            )}
            <div className="flex gap-2 sm:col-span-2">
              <button type="button" className="btn-secondary flex-1" onClick={() => setForm(null)}>Batal</button>
              <button type="submit" className="btn-primary flex-1" disabled={menyimpan || lebih || !adaIsi}>
                <Truck size={16} /> {menyimpan ? 'Menyimpan...' : form.id ? 'Simpan Perubahan' : 'Simpan Surat Jalan'}
              </button>
            </div>
          </form>
        )}
      </Modal>

      {/* ---------- DETAIL ---------- */}
      <Modal open={!!detail} onClose={() => setDetail(null)} title={detail?.do_no || ''} wide>
        {detail && (
          <div className="grid gap-3">
            <div className="flex flex-wrap items-center gap-2 text-sm text-slate-600">
              <span className={WARNA_STATUS[detail.status]}>{detail.status_label}</span>
              {dateID(detail.do_date)} · order {detail.order_no}
              {detail.invoice_no && <> · faktur <span className="font-mono">{detail.invoice_no}</span></>}
            </div>
            <div className="grid gap-2 rounded-xl bg-slate-50 p-3 text-sm sm:grid-cols-2">
              <div>
                <p className="text-xs text-slate-500">Dikirim kepada</p>
                <p className="font-semibold">{detail.recipient_name}</p>
                <p className="text-xs">{[detail.address, detail.city].filter(Boolean).join(', ')}</p>
                {detail.recipient_phone && <p className="text-xs">{detail.recipient_phone}</p>}
              </div>
              <div>
                <p className="text-xs text-slate-500">Pengiriman</p>
                <p className="text-xs">Sopir/kurir: {detail.driver_name || '-'} {detail.vehicle_no && `(${detail.vehicle_no})`}</p>
                <p className="text-xs">Ekspedisi: {detail.courier || '-'} {detail.tracking_no && `· resi ${detail.tracking_no}`}</p>
                {detail.status === 'DITERIMA' && (
                  <p className="text-xs text-emerald-700">Diterima {dateID(detail.received_date)}{detail.received_by && ` oleh ${detail.received_by}`}</p>
                )}
              </div>
            </div>
            <div className="table-wrap">
              <table className="table text-sm">
                <thead><tr><th>Barang</th><th className="text-right">Jumlah</th><th>Keterangan</th></tr></thead>
                <tbody>
                  {detail.items.map((i) => (
                    <tr key={i.id}>
                      <td>{i.product_name}<span className="block text-xs text-slate-400">{i.sku}</span></td>
                      <td className="tabular text-right font-semibold">{num(i.qty)} {i.unit}</td>
                      <td className="text-xs">{i.note || '-'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {detail.note && <p className="text-sm text-slate-600">Catatan: {detail.note}</p>}
            <div className="flex flex-wrap gap-2">
              <TombolCetak path={`/api/surat-jalan/${detail.id}/pdf`} label="Cetak Surat Jalan" icon={Printer} />
              {boleh && detail.status !== 'BATAL' && !detail.invoice_no && (
                <button className="btn-secondary" onClick={() => ubah(detail)}><Pencil size={16} /> Ubah</button>
              )}
              {boleh && detail.status === 'DIKIRIM' && (
                <button className="btn-secondary" onClick={() => setTerima({ id: detail.id, received_date: today(), received_by: detail.recipient_name || '' })}>
                  <CheckCircle2 size={16} /> Tandai Diterima
                </button>
              )}
              {boleh && detail.status !== 'BATAL' && !detail.invoice_no && (
                <button className="btn-danger" onClick={() => batalkan(detail)}><XCircle size={16} /> Batalkan</button>
              )}
            </div>
          </div>
        )}
      </Modal>

      <Modal open={!!terima} onClose={() => setTerima(null)} title="Barang sudah diterima">
        {terima && (
          <form onSubmit={simpanTerima} className="grid gap-3">
            <Field label="Tanggal diterima">
              <input type="date" className="input" required value={terima.received_date} onChange={(e) => setTerima({ ...terima, received_date: e.target.value })} />
            </Field>
            <Field label="Diterima oleh">
              <input className="input" maxLength={120} value={terima.received_by} onChange={(e) => setTerima({ ...terima, received_by: e.target.value })} />
            </Field>
            <button type="submit" className="btn-primary"><CheckCircle2 size={16} /> Simpan</button>
          </form>
        )}
      </Modal>
    </div>
  );
}
