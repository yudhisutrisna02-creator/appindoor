import { useEffect, useState } from 'react';
import { ClipboardCheck, Save, Eye, AlertTriangle } from 'lucide-react';
import { api } from '../lib/api';
import { PageHeader, Spinner, EmptyState, Modal, useToast, Field, StatCard, TombolEkspor } from '../components/ui';
import { rupiah, num, today, dateID } from '../lib/format';
import { useAuth } from '../lib/auth';

export default function StokOpname() {
  const toast = useToast();
  const { canManage } = useAuth();
  const [history, setHistory] = useState([]);
  const [loading, setLoading] = useState(true);
  const [sheet, setSheet] = useState(null);
  const [detail, setDetail] = useState(null);
  const [saving, setSaving] = useState(false);

  async function loadHistory() {
    setLoading(true);
    try {
      const d = await api.get('/api/inventory/opname');
      setHistory(d.rows);
    } catch (err) {
      toast.error(err.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { loadHistory(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);

  async function openSheet() {
    try {
      const d = await api.get('/api/inventory/opname/sheet');
      setSheet({
        opname_date: today(),
        note: '',
        // physical dibiarkan kosong agar petugas mengisi hasil hitung fisik
        rows: d.rows.map((r) => ({ ...r, physical: '' })),
      });
    } catch (err) {
      toast.error(err.message);
    }
  }

  /** Baris dengan input fisik terisi — hanya ini yang dikirim ke server. */
  const filled = sheet?.rows.filter((r) => r.physical !== '' && r.physical !== null) || [];
  const diffs = filled
    .map((r) => ({ ...r, diff: Number(r.physical) - r.system_qty }))
    .filter((r) => r.diff !== 0);
  const totalDiffValue = diffs.reduce((s, r) => s + r.diff * r.cost, 0);

  async function submit() {
    if (filled.length === 0) return toast.error('Isi minimal satu jumlah fisik');
    if (!window.confirm(
      `Posting opname untuk ${filled.length} produk?\n` +
      `${diffs.length} selisih terdeteksi senilai ${rupiah(totalDiffValue)}.\n` +
      'Stok sistem akan disesuaikan dan jurnal penyesuaian dibuat.'
    )) return;

    setSaving(true);
    try {
      const res = await api.post('/api/inventory/opname', {
        opname_date: sheet.opname_date,
        note: sheet.note || null,
        lines: filled.map((r) => ({ product_id: r.id, physical_qty: Number(r.physical) })),
      });
      toast.success(`Opname ${res.opname_no} diposting — selisih ${rupiah(res.total_diff_value)}`);
      setSheet(null);
      loadHistory();
    } catch (err) {
      toast.error(err.message);
    } finally {
      setSaving(false);
    }
  }

  async function openDetail(id) {
    try {
      setDetail(await api.get(`/api/inventory/opname/${id}`));
    } catch (err) {
      toast.error(err.message);
    }
  }

  return (
    <div>
      <PageHeader title="Stok Opname" subtitle="Rekonsiliasi stok fisik terhadap catatan sistem">
        {canManage && (
          <button className="btn-primary" onClick={openSheet}>
            <ClipboardCheck size={16} /> Mulai Opname
          </button>
        )}
        <TombolEkspor path="/api/inventory/opname" nama="stok-opname" />
      </PageHeader>

      {loading ? (
        <Spinner />
      ) : (
        <div className="card">
          <h2 className="card-title mb-3">Riwayat Opname</h2>
          {history.length === 0 ? (
            <EmptyState message="Belum pernah melakukan stok opname" hint="Klik “Mulai Opname” untuk rekonsiliasi pertama" />
          ) : (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr><th>No. Opname</th><th>Tanggal</th><th>Produk Dicek</th><th>Nilai Selisih</th><th>Status</th><th>Petugas</th><th>Catatan</th><th></th></tr>
                </thead>
                <tbody>
                  {history.map((o) => (
                    <tr key={o.id}>
                      <td className="font-mono text-xs">{o.opname_no}</td>
                      <td className="tabular">{dateID(o.opname_date)}</td>
                      <td className="tabular">{o.line_count}</td>
                      <td className={`tabular font-semibold ${o.total_diff_value < 0 ? 'text-rose-600' : o.total_diff_value > 0 ? 'text-emerald-600' : ''}`}>
                        {rupiah(o.total_diff_value)}
                      </td>
                      <td><span className="badge-green">{o.status}</span></td>
                      <td className="text-xs text-slate-500">{o.user_name || '-'}</td>
                      <td className="max-w-[200px] truncate text-xs text-slate-500">{o.note || '-'}</td>
                      <td>
                        <button className="btn-ghost !px-2 !py-1 text-xs" onClick={() => openDetail(o.id)}>
                          <Eye size={14} /> Detail
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* ---------- LEMBAR OPNAME ---------- */}
      <Modal open={!!sheet} onClose={() => setSheet(null)} title="Lembar Stok Opname" wide>
        {sheet && (
          <div>
            <div className="mb-4 grid gap-3 sm:grid-cols-2">
              <Field label="Tanggal Opname *">
                <input type="date" className="input" value={sheet.opname_date} onChange={(e) => setSheet({ ...sheet, opname_date: e.target.value })} />
              </Field>
              <Field label="Catatan">
                <input className="input" placeholder="mis. opname akhir bulan gudang utama" value={sheet.note} onChange={(e) => setSheet({ ...sheet, note: e.target.value })} />
              </Field>
            </div>

            <div className="mb-4 grid grid-cols-3 gap-3">
              <StatCard label="Produk Terisi" value={filled.length} />
              <StatCard label="Selisih Ditemukan" value={diffs.length} tone={diffs.length ? 'amber' : 'green'} />
              <StatCard label="Nilai Selisih" value={rupiah(totalDiffValue)} tone={totalDiffValue < 0 ? 'red' : 'green'} />
            </div>

            <div className="table-wrap max-h-[46vh] overflow-y-auto">
              <table className="table">
                <thead>
                  <tr><th>Produk</th><th>Stok Sistem</th><th>Stok Fisik</th><th>Selisih</th><th>Nilai Selisih</th></tr>
                </thead>
                <tbody>
                  {sheet.rows.map((r, i) => {
                    const hasValue = r.physical !== '';
                    const diff = hasValue ? Number(r.physical) - r.system_qty : 0;
                    return (
                      <tr key={r.id}>
                        <td>
                          <p className="font-medium text-slate-900">{r.name}</p>
                          <p className="text-xs text-slate-400">{r.sku} • {r.category}</p>
                        </td>
                        <td className="tabular">{num(r.system_qty)} {r.unit}</td>
                        <td>
                          <input
                            type="number" min="0" step="any"
                            className="input !w-28 !py-1.5"
                            placeholder="—"
                            value={r.physical}
                            onChange={(e) => {
                              const rows = [...sheet.rows];
                              rows[i] = { ...r, physical: e.target.value };
                              setSheet({ ...sheet, rows });
                            }}
                          />
                        </td>
                        <td className={`tabular font-semibold ${diff < 0 ? 'text-rose-600' : diff > 0 ? 'text-emerald-600' : 'text-slate-400'}`}>
                          {hasValue ? `${diff > 0 ? '+' : ''}${num(diff)}` : '—'}
                        </td>
                        <td className="tabular">{hasValue && diff !== 0 ? rupiah(diff * r.cost) : '—'}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {diffs.length > 0 && (
              <p className="mt-3 flex items-start gap-2 rounded-xl bg-amber-50 p-3 text-xs text-amber-800">
                <AlertTriangle size={15} className="mt-0.5 shrink-0" />
                Memposting opname akan menimpa stok sistem dengan angka fisik, membuat mutasi koreksi,
                dan membentuk jurnal Selisih Stok senilai {rupiah(Math.abs(totalDiffValue))}.
              </p>
            )}

            <div className="mt-4 flex gap-2">
              <button className="btn-secondary flex-1" onClick={() => setSheet(null)}>Batal</button>
              <button className="btn-primary flex-1" onClick={submit} disabled={saving || filled.length === 0}>
                <Save size={16} /> {saving ? 'Memposting...' : 'Posting Opname'}
              </button>
            </div>
          </div>
        )}
      </Modal>

      {/* ---------- DETAIL RIWAYAT ---------- */}
      <Modal open={!!detail} onClose={() => setDetail(null)} title={`Detail ${detail?.header.opname_no || ''}`} wide>
        {detail && (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr><th>Produk</th><th>Sistem</th><th>Fisik</th><th>Selisih</th><th>HPP</th><th>Nilai Selisih</th></tr>
              </thead>
              <tbody>
                {detail.lines.map((l) => (
                  <tr key={l.id}>
                    <td>
                      <p className="font-medium text-slate-900">{l.product_name}</p>
                      <p className="text-xs text-slate-400">{l.sku}</p>
                    </td>
                    <td className="tabular">{num(l.system_qty)}</td>
                    <td className="tabular">{num(l.physical_qty)}</td>
                    <td className={`tabular font-semibold ${l.diff_qty < 0 ? 'text-rose-600' : l.diff_qty > 0 ? 'text-emerald-600' : 'text-slate-400'}`}>
                      {l.diff_qty > 0 ? '+' : ''}{num(l.diff_qty)}
                    </td>
                    <td className="tabular">{rupiah(l.unit_cost)}</td>
                    <td className="tabular">{rupiah(l.diff_value)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Modal>
    </div>
  );
}
