import { useEffect, useState, useCallback } from 'react';
import { ArrowRightLeft, Trash2, Wallet } from 'lucide-react';
import { api } from '../lib/api';
import { Modal, Field, useToast, Spinner } from './ui';
import { rupiah, dateID, today } from '../lib/format';
import { useAuth } from '../lib/auth';

/**
 * Saldo BANK MP INDOOR dan penarikannya ke rekening bank.
 *
 * Semua uang order marketplace yang sudah cair menumpuk di rekening penampung.
 * Saat platform mentransfer ke bank, nominal yang diterima diketik di sini —
 * hampir tidak pernah sama dengan nilai transaksinya, dan selisihnya bisa
 * dicatat sebagai potongan. Sisa per toko membantu melihat toko mana yang
 * dananya belum ditarik.
 */
export default function TarikSaldoMp({ range }) {
  const toast = useToast();
  const { punya } = useAuth();
  const boleh = punya('keuangan.kas');
  const [data, setData] = useState(null);
  const [form, setForm] = useState(null);
  const [menyimpan, setMenyimpan] = useState(false);

  const load = useCallback(async () => {
    try {
      setData(await api.get('/api/cashflow/tarik-mp', range));
    } catch (err) {
      toast.error(err.message);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [range.from, range.to]);

  useEffect(() => { load(); }, [load]);

  function buka(t) {
    setForm({
      entry_date: today(),
      shop_id: t?.shop_id || '',
      ke: t?.rekening_tujuan || '',
      amount: t && t.sisa > 0 ? String(t.sisa) : '',
      potongan: '',
      note: '',
    });
  }

  async function simpan(e) {
    e.preventDefault();
    setMenyimpan(true);
    try {
      const res = await api.post('/api/cashflow/tarik-mp', {
        entry_date: form.entry_date,
        shop_id: form.shop_id ? Number(form.shop_id) : null,
        ke: form.ke,
        amount: Number(form.amount),
        potongan: Number(form.potongan) || 0,
        note: form.note || null,
      });
      toast.success(res.message);
      setForm(null);
      load();
    } catch (err) {
      toast.error(err.message);
    } finally {
      setMenyimpan(false);
    }
  }

  async function batalkan(r) {
    if (!window.confirm(`Batalkan tarik saldo ${r.entry_no} (${rupiah(r.nominal)})? Potongannya ikut terhapus.`)) return;
    try {
      const res = await api.del(`/api/cashflow/tarik-mp/${r.id}`);
      toast.success(res.message);
      load();
    } catch (err) {
      toast.error(err.message);
    }
  }

  if (!data) return <div className="card mb-4"><Spinner /></div>;

  const tokoPilihan = data.perToko.filter((t) => t.shop_id);

  return (
    <div className="card mb-4">
      <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="flex items-center gap-2 font-bold text-slate-900">
            <Wallet size={18} className="text-brand-600" /> Saldo {data.mp.name}
          </h2>
          <p className="text-xs text-slate-500">
            Penampung semua dana marketplace yang sudah cair. Tarik ke rekening bank dengan nominal yang
            benar-benar diterima.
          </p>
        </div>
        <div className="text-right">
          <p className={`tabular text-2xl font-bold ${data.mp.saldo < 0 ? 'text-rose-600' : 'text-slate-900'}`}>
            {rupiah(data.mp.saldo)}
          </p>
          {boleh && (
            <button type="button" className="btn-primary mt-1 !py-1.5 text-xs" onClick={() => buka(null)}>
              <ArrowRightLeft size={14} /> Tarik Saldo
            </button>
          )}
        </div>
      </div>

      {data.perToko.length > 0 && (
        <div className="table-wrap mb-3">
          <table className="table text-sm">
            <thead>
              <tr>
                <th>Toko</th>
                <th className="text-right">Dana cair masuk</th>
                <th className="text-right">Sudah ditarik</th>
                <th className="text-right">Potongan</th>
                <th className="text-right">Sisa di penampung</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {data.perToko.map((t) => (
                <tr key={t.shop_id || 0}>
                  <td className="font-medium text-slate-900">{t.shop_name}</td>
                  <td className="tabular text-right">{rupiah(t.masuk)}</td>
                  <td className="tabular text-right">{rupiah(t.ditarik)}</td>
                  <td className="tabular text-right">{rupiah(t.potongan)}</td>
                  <td className={`tabular text-right font-semibold ${t.sisa < 0 ? 'text-rose-600' : 'text-slate-900'}`}>
                    {rupiah(t.sisa)}
                  </td>
                  <td className="text-right">
                    {boleh && t.shop_id && (
                      <button type="button" className="btn-ghost !px-2 !py-1 text-xs" onClick={() => buka(t)}>
                        Tarik
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <details className="rounded-xl bg-slate-50 px-3 py-2 text-xs">
        <summary className="cursor-pointer font-semibold text-slate-700">
          Riwayat tarik saldo {dateID(data.from)} – {dateID(data.to)} ({data.rows.length} · {rupiah(data.total)}
          {data.totalPotongan > 0 && <>, potongan {rupiah(data.totalPotongan)}</>})
        </summary>
        {data.rows.length === 0 ? (
          <p className="mt-2 text-slate-500">Belum ada tarik saldo pada rentang ini.</p>
        ) : (
          <div className="table-wrap mt-2">
            <table className="table text-xs">
              <thead>
                <tr><th>Tanggal</th><th>No.</th><th>Toko</th><th>Ke rekening</th><th className="text-right">Diterima</th><th className="text-right">Potongan</th><th /></tr>
              </thead>
              <tbody>
                {data.rows.map((r) => (
                  <tr key={r.id}>
                    <td className="tabular">{dateID(r.entry_date)}</td>
                    <td className="font-mono">{r.entry_no}</td>
                    <td>{r.shop_name || '—'}</td>
                    <td>{r.ke}</td>
                    <td className="tabular text-right font-semibold">{rupiah(r.nominal)}</td>
                    <td className="tabular text-right">{r.potongan ? rupiah(r.potongan) : '-'}</td>
                    <td className="text-right">
                      {boleh && (
                        <button type="button" className="btn-ghost !px-2 !py-1 text-rose-600" aria-label="Batalkan" onClick={() => batalkan(r)}>
                          <Trash2 size={13} />
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </details>

      <Modal open={!!form} onClose={() => setForm(null)} title={`Tarik Saldo dari ${data.mp.name}`}>
        {form && (
          <form onSubmit={simpan} className="grid gap-3 sm:grid-cols-2">
            <Field label="Tanggal dana masuk bank *">
              <input type="date" className="input" required value={form.entry_date} onChange={(e) => setForm({ ...form, entry_date: e.target.value })} />
            </Field>
            <Field label="Toko" hint="Supaya sisa per toko terlacak">
              <select
                className="input" value={form.shop_id}
                onChange={(e) => {
                  const t = tokoPilihan.find((x) => String(x.shop_id) === e.target.value);
                  setForm({ ...form, shop_id: e.target.value, ke: form.ke || t?.rekening_tujuan || '' });
                }}
              >
                <option value="">— semua / tidak spesifik —</option>
                {tokoPilihan.map((t) => <option key={t.shop_id} value={t.shop_id}>{t.shop_name} (sisa {rupiah(t.sisa)})</option>)}
              </select>
            </Field>
            <Field label="Masuk ke rekening *" className="sm:col-span-2">
              <select className="input" required value={form.ke} onChange={(e) => setForm({ ...form, ke: e.target.value })}>
                <option value="">— pilih rekening bank yang menerima —</option>
                {data.rekening.map((k) => <option key={k.code} value={k.code}>{k.code} — {k.name}</option>)}
              </select>
            </Field>
            <Field label="Nominal diterima di bank (Rp) *" hint="Sesuai mutasi rekening">
              <input type="number" min="0" step="any" className="input" required value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} />
            </Field>
            <Field label="Potongan / penyesuaian (Rp)" hint="Dicatat sebagai biaya admin marketplace">
              <input type="number" min="0" step="any" className="input" placeholder="0" value={form.potongan} onChange={(e) => setForm({ ...form, potongan: e.target.value })} />
            </Field>
            <Field label="Catatan" className="sm:col-span-2">
              <input className="input" maxLength={200} value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} />
            </Field>
            <p className="rounded-xl bg-brand-50 p-3 text-xs text-brand-800 sm:col-span-2">
              {data.mp.name} berkurang <strong>{rupiah((Number(form.amount) || 0) + (Number(form.potongan) || 0))}</strong>
              {' '}→ sisa <strong>{rupiah(data.mp.saldo - (Number(form.amount) || 0) - (Number(form.potongan) || 0))}</strong>
            </p>
            <div className="flex gap-2 sm:col-span-2">
              <button type="button" className="btn-secondary flex-1" onClick={() => setForm(null)}>Batal</button>
              <button type="submit" className="btn-primary flex-1" disabled={menyimpan}>
                {menyimpan ? 'Menyimpan...' : 'Simpan Tarik Saldo'}
              </button>
            </div>
          </form>
        )}
      </Modal>
    </div>
  );
}
