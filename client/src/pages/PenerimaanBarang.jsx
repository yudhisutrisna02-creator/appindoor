import { useEffect, useState, useCallback } from 'react';
import { PackageCheck, ClipboardList, History, Printer, Eye, AlertTriangle } from 'lucide-react';
import { api } from '../lib/api';
import {
  PageHeader, StatCard, Spinner, EmptyState, Modal, useToast, Field,
  DateRangeFilter, defaultRange, TombolCetak,
} from '../components/ui';
import { num, dateID, today } from '../lib/format';
import { useAuth } from '../lib/auth';

/**
 * Penerimaan barang dari pabrik (GRN).
 *
 * Tim gudang mencocokkan barang yang datang dengan pesanannya: berapa yang
 * diterima baik, berapa yang ditolak, dan surat jalan supplier mana yang
 * menyertainya. Menyimpannya memotong sisa pesanan, menambah stok, dan
 * meninggalkan dokumen GRN bernomor untuk dicetak dan ditandatangani.
 */
export default function PenerimaanBarang() {
  const toast = useToast();
  const { punya, user } = useAuth();
  const boleh = punya('pembelian.kelola');

  const [tab, setTab] = useState('menunggu');
  const [menunggu, setMenunggu] = useState(null);
  const [riwayat, setRiwayat] = useState(null);
  const [range, setRange] = useState(defaultRange);
  const [q, setQ] = useState('');
  const [form, setForm] = useState(null);
  const [detail, setDetail] = useState(null);
  const [menyimpan, setMenyimpan] = useState(false);

  const muatMenunggu = useCallback(async () => {
    try {
      setMenunggu(await api.get('/api/grn/menunggu'));
    } catch (err) {
      toast.error(err.message);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const muatRiwayat = useCallback(async () => {
    try {
      setRiwayat(await api.get('/api/grn', { ...range, q }));
    } catch (err) {
      toast.error(err.message);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [range, q]);

  useEffect(() => { muatMenunggu(); }, [muatMenunggu]);
  useEffect(() => {
    const t = setTimeout(muatRiwayat, 250);
    return () => clearTimeout(t);
  }, [muatRiwayat]);

  function bukaTerima(po) {
    setForm({
      po,
      receive_date: today(),
      delivery_note_no: '',
      received_by: user?.name || '',
      note: '',
      // Bawaan: seluruh sisa datang dalam keadaan baik — yang paling sering
      // terjadi. Tim gudang tinggal mengurangi bila ada yang kurang atau rusak.
      lines: po.items
        .filter((i) => i.sisa > 0)
        .map((i) => ({ ...i, qty: i.sisa, qty_rejected: '', note: '' })),
    });
  }

  function setBaris(i, patch) {
    const lines = [...form.lines];
    lines[i] = { ...lines[i], ...patch };
    setForm({ ...form, lines });
  }

  async function simpan(e) {
    e.preventDefault();
    setMenyimpan(true);
    try {
      const res = await api.post('/api/grn', {
        po_id: form.po.id,
        receive_date: form.receive_date,
        delivery_note_no: form.delivery_note_no || null,
        received_by: form.received_by || null,
        note: form.note || null,
        lines: form.lines.map((l) => ({
          item_id: l.item_id,
          qty: Number(l.qty) || 0,
          qty_rejected: Number(l.qty_rejected) || 0,
          note: l.note || null,
        })),
      });
      toast.success(res.message);
      setForm(null);
      muatMenunggu();
      muatRiwayat();
      setDetail(res.grn);
    } catch (err) {
      toast.error(err.message);
    } finally {
      setMenyimpan(false);
    }
  }

  async function lihat(id) {
    try {
      setDetail((await api.get(`/api/grn/${id}`)).grn);
    } catch (err) {
      toast.error(err.message);
    }
  }

  if (!menunggu) return <Spinner />;

  const lebih = form ? form.lines.some((l) => Number(l.qty) > l.sisa + 0.0001) : false;
  const adaIsi = form ? form.lines.some((l) => Number(l.qty) > 0 || Number(l.qty_rejected) > 0) : false;

  return (
    <div>
      <PageHeader title="Penerimaan Barang (GRN)" subtitle="Verifikasi barang datang dari pabrik — memotong pesanan & menambah stok gudang" />

      <div className="mb-4 grid grid-cols-1 gap-3 sm:grid-cols-3">
        <StatCard label="Pesanan ditunggu" value={num(menunggu.rows.length)} sub="belum diterima seluruhnya" icon={ClipboardList} tone="brand" />
        <StatCard label="Unit belum datang" value={num(menunggu.rows.reduce((s, r) => s + r.sisa, 0))} sub="dari semua pesanan" icon={PackageCheck} tone="amber" />
        <StatCard label="Terlambat" value={num(menunggu.rows.filter((r) => r.expected_date && r.telat_hari > 0).length)} sub="lewat perkiraan tiba" icon={AlertTriangle} tone="red" />
      </div>

      <div className="mb-4 flex gap-1.5 rounded-xl bg-surface p-1.5 shadow-sm ring-1 ring-slate-200/70">
        {[
          { key: 'menunggu', label: `Menunggu Kedatangan (${menunggu.rows.length})`, icon: ClipboardList },
          { key: 'riwayat', label: 'Riwayat GRN', icon: History },
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

      {tab === 'menunggu' ? (
        menunggu.rows.length === 0 ? (
          <div className="card"><EmptyState message="Tidak ada barang yang sedang ditunggu" hint="Semua pesanan pembelian sudah diterima" /></div>
        ) : (
          <div className="grid gap-3 lg:grid-cols-2">
            {menunggu.rows.map((po) => (
              <div key={po.id} className="card">
                <div className="mb-2 flex items-start justify-between gap-3">
                  <div>
                    <p className="font-mono text-xs text-slate-500">{po.po_no}</p>
                    <p className="font-bold text-slate-900">{po.supplier_name}</p>
                    <p className="text-xs text-slate-500">
                      Dipesan {dateID(po.order_date)}
                      {po.expected_date && (
                        <> · perkiraan tiba{' '}
                          <span className={po.telat_hari > 0 ? 'font-semibold text-rose-600' : ''}>
                            {dateID(po.expected_date)}{po.telat_hari > 0 && ` (telat ${po.telat_hari} hari)`}
                          </span>
                        </>
                      )}
                    </p>
                  </div>
                  <span className={po.status === 'SEBAGIAN' ? 'badge-amber' : 'badge-blue'}>{po.status_label}</span>
                </div>
                <ul className="mb-3 space-y-1 text-sm">
                  {po.items.filter((i) => i.sisa > 0).map((i) => (
                    <li key={i.item_id} className="flex justify-between gap-3 rounded-lg bg-slate-50 px-3 py-1.5">
                      <span className="truncate">{i.product_name}</span>
                      <span className="tabular shrink-0 font-semibold">{num(i.sisa)} {i.unit}</span>
                    </li>
                  ))}
                </ul>
                {boleh && (
                  <button className="btn-primary w-full" onClick={() => bukaTerima(po)}>
                    <PackageCheck size={16} /> Terima Barang
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
              <input className="input" placeholder="No. GRN, no. PO, supplier, surat jalan" value={q} onChange={(e) => setQ(e.target.value)} />
            </div>
          </DateRangeFilter>
          <div className="card">
            {!riwayat ? <Spinner /> : riwayat.rows.length === 0 ? (
              <EmptyState message="Belum ada penerimaan pada rentang ini" />
            ) : (
              <div className="table-wrap">
                <table className="table">
                  <thead>
                    <tr>
                      <th>No. GRN</th><th>Tanggal</th><th>No. PO</th><th>Supplier</th><th>Surat jalan</th>
                      <th className="text-right">Diterima</th><th className="text-right">Ditolak</th><th>Penerima</th><th />
                    </tr>
                  </thead>
                  <tbody>
                    {riwayat.rows.map((g) => (
                      <tr key={g.id}>
                        <td className="font-mono text-xs">{g.grn_no}</td>
                        <td className="tabular">{dateID(g.receive_date)}</td>
                        <td className="font-mono text-xs">{g.po_no}</td>
                        <td className="text-sm">{g.supplier_name}</td>
                        <td className="text-xs">{g.delivery_note_no || '-'}</td>
                        <td className="tabular text-right font-semibold text-emerald-700">{num(g.total_diterima)}</td>
                        <td className="tabular text-right">{g.total_ditolak > 0 ? <span className="text-rose-600">{num(g.total_ditolak)}</span> : '-'}</td>
                        <td className="text-xs">{g.received_by || g.user_name || '-'}</td>
                        <td>
                          <div className="flex justify-end gap-1">
                            <button className="btn-ghost !px-2 !py-1" aria-label="Detail" onClick={() => lihat(g.id)}><Eye size={14} /></button>
                            <TombolCetak path={`/api/grn/${g.id}/pdf`} label="" icon={Printer} kecil />
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

      {/* ---------- FORM GRN ---------- */}
      <Modal open={!!form} onClose={() => setForm(null)} title={`Terima Barang — ${form?.po.po_no || ''}`} wide>
        {form && (
          <form onSubmit={simpan} className="grid gap-3 sm:grid-cols-2">
            <p className="sm:col-span-2 text-sm text-slate-600">
              Dari <strong>{form.po.supplier_name}</strong>. Isi jumlah yang <strong>diterima baik</strong> dan yang{' '}
              <strong>ditolak</strong> (rusak/salah kirim). Barang ditolak tidak masuk stok dan tetap tercatat
              sebagai sisa pesanan.
            </p>
            <Field label="Tanggal terima *">
              <input type="date" className="input" required value={form.receive_date} onChange={(e) => setForm({ ...form, receive_date: e.target.value })} />
            </Field>
            <Field label="No. surat jalan supplier">
              <input className="input" maxLength={60} value={form.delivery_note_no} onChange={(e) => setForm({ ...form, delivery_note_no: e.target.value })} />
            </Field>
            <Field label="Diterima oleh">
              <input className="input" maxLength={80} value={form.received_by} onChange={(e) => setForm({ ...form, received_by: e.target.value })} />
            </Field>
            <Field label="Catatan">
              <input className="input" maxLength={300} value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} />
            </Field>

            <div className="table-wrap sm:col-span-2">
              <table className="table text-sm">
                <thead>
                  <tr><th>Barang</th><th className="text-right">Sisa pesanan</th><th>Diterima baik</th><th>Ditolak</th><th>Keterangan</th></tr>
                </thead>
                <tbody>
                  {form.lines.map((l, i) => (
                    <tr key={l.item_id}>
                      <td>{l.product_name}<span className="block text-xs text-slate-400">{l.sku}</span></td>
                      <td className="tabular text-right font-semibold">{num(l.sisa)} {l.unit}</td>
                      <td className="w-28">
                        <input type="number" min="0" max={l.sisa} step="any"
                          className={`input !py-1.5 ${Number(l.qty) > l.sisa + 0.0001 ? 'ring-2 ring-rose-400' : ''}`}
                          value={l.qty} onChange={(e) => setBaris(i, { qty: e.target.value })} />
                      </td>
                      <td className="w-24">
                        <input type="number" min="0" step="any" className="input !py-1.5" placeholder="0"
                          value={l.qty_rejected} onChange={(e) => setBaris(i, { qty_rejected: e.target.value })} />
                      </td>
                      <td>
                        <input className="input !py-1.5" maxLength={200} placeholder="mis. kemasan sobek"
                          value={l.note} onChange={(e) => setBaris(i, { note: e.target.value })} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {lebih && (
              <p className="sm:col-span-2 rounded-xl bg-rose-50 px-3 py-2 text-xs text-rose-800">
                Jumlah diterima melebihi sisa pesanan. Kelebihan kiriman dicatat terpisah lewat Mutasi Stok supaya ketahuan.
              </p>
            )}
            <div className="flex gap-2 sm:col-span-2">
              <button type="button" className="btn-secondary flex-1" onClick={() => setForm(null)}>Batal</button>
              <button type="submit" className="btn-primary flex-1" disabled={menyimpan || lebih || !adaIsi}>
                <PackageCheck size={16} /> {menyimpan ? 'Menyimpan...' : 'Simpan Penerimaan'}
              </button>
            </div>
          </form>
        )}
      </Modal>

      {/* ---------- DETAIL GRN ---------- */}
      <Modal open={!!detail} onClose={() => setDetail(null)} title={detail?.grn_no || ''} wide>
        {detail && (
          <div className="grid gap-3">
            <p className="text-sm text-slate-600">
              {dateID(detail.receive_date)} · {detail.po_no} · {detail.supplier_name}
              {detail.delivery_note_no && <> · surat jalan {detail.delivery_note_no}</>}
              {detail.received_by && <> · diterima {detail.received_by}</>}
            </p>
            <div className="table-wrap">
              <table className="table text-sm">
                <thead>
                  <tr><th>Barang</th><th className="text-right">Dipesan</th><th className="text-right">Diterima</th><th className="text-right">Ditolak</th><th>Keterangan</th></tr>
                </thead>
                <tbody>
                  {detail.items.map((i) => (
                    <tr key={i.id}>
                      <td>{i.product_name}</td>
                      <td className="tabular text-right">{num(i.qty_ordered)} {i.unit}</td>
                      <td className="tabular text-right font-semibold text-emerald-700">{num(i.qty_received)}</td>
                      <td className="tabular text-right">{i.qty_rejected > 0 ? <span className="text-rose-600">{num(i.qty_rejected)}</span> : '-'}</td>
                      <td className="text-xs">{i.note || '-'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <TombolCetak path={`/api/grn/${detail.id}/pdf`} label="Cetak Bukti Penerimaan" icon={Printer} />
          </div>
        )}
      </Modal>
    </div>
  );
}
