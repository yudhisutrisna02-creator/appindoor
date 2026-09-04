import { useEffect, useState, useCallback } from 'react';
import { ArrowRightLeft, Trash2, Info } from 'lucide-react';
import { api } from '../lib/api';
import { PageHeader, Spinner, EmptyState, StatCard, useToast, Field } from '../components/ui';
import { rupiah, dateID, today, firstOfMonth } from '../lib/format';
import { useAuth } from '../lib/auth';

/**
 * Pindah Saldo antar rekening sendiri.
 *
 * Menarik tunai dari bank, menyetor tunai, atau memindahkan antar bank bukan
 * pemasukan dan bukan pengeluaran — uangnya tidak bertambah dan tidak berkurang,
 * hanya berpindah tempat. Dicatat sebagai dua entri terpisah di Kas Masuk dan
 * Kas Keluar, total pemasukan dan pengeluaran bulan itu tampak membengkak
 * padahal tidak ada uang yang benar-benar mengalir keluar masuk.
 */
export default function PindahSaldo() {
  const toast = useToast();
  const { punya } = useAuth();
  const bolehCatat = punya('keuangan.kas');

  const [range, setRange] = useState({ from: firstOfMonth(), to: today() });
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [kirim, setKirim] = useState(false);

  const KOSONG = { entry_date: today(), from_code: '', to_code: '', amount: '', note: '' };
  const [form, setForm] = useState(KOSONG);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const d = await api.get(`/api/cashflow/pindah?from=${range.from}&to=${range.to}`);
      setData(d);
    } catch (err) {
      toast.error(err.message);
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [range.from, range.to]);

  useEffect(() => { load(); }, [load]);

  async function simpan(e) {
    e.preventDefault();
    const nilai = Number(form.amount) || 0;
    if (nilai <= 0) return toast.error('Nominal harus lebih dari nol');
    if (form.from_code === form.to_code) {
      return toast.error('Rekening asal dan tujuan tidak boleh sama');
    }

    setKirim(true);
    try {
      const res = await api.post('/api/cashflow/pindah', {
        entry_date: form.entry_date,
        from_code: form.from_code,
        to_code: form.to_code,
        amount: nilai,
        note: form.note || null,
      });
      toast.success(res.message);
      setForm({ ...KOSONG, entry_date: form.entry_date });
      load();
    } catch (err) {
      toast.error(err.message);
    } finally {
      setKirim(false);
    }
  }

  async function hapus(r) {
    if (!window.confirm(
      `Batalkan pemindahan ${r.entry_no} sebesar ${rupiah(r.nilai)}?\n\n` +
      'Saldo kedua rekening kembali seperti sebelum dipindahkan.'
    )) return;

    try {
      const res = await api.del(`/api/cashflow/pindah/${r.id}`);
      toast.success(res.message);
      load();
    } catch (err) {
      toast.error(err.message);
    }
  }

  if (loading && !data) return <Spinner label="Memuat pemindahan saldo..." />;

  const rekening = data?.rekening || [];

  return (
    <div>
      <PageHeader
        title="Pindah Saldo"
        subtitle="Memindahkan uang antar rekening sendiri — bank ke kas tunai, kas ke bank, atau antar bank"
      />

      <div className="mb-4 flex flex-wrap items-end gap-3">
        <Field label="Dari Tanggal" className="w-44">
          <input
            type="date" className="input" value={range.from}
            onChange={(e) => setRange({ ...range, from: e.target.value })}
          />
        </Field>
        <Field label="Sampai Tanggal" className="w-44">
          <input
            type="date" className="input" value={range.to}
            onChange={(e) => setRange({ ...range, to: e.target.value })}
          />
        </Field>
      </div>

      <div className="mb-4 grid gap-3 sm:grid-cols-2">
        <StatCard
          label="Dipindahkan Periode Ini" value={rupiah(data?.total || 0)}
          sub={`${data?.rows?.length || 0} kali pemindahan`} icon={ArrowRightLeft}
        />
        <div className="card flex items-start gap-2.5">
          <Info size={17} className="mt-0.5 shrink-0 text-brand-600" />
          <p className="text-xs leading-relaxed text-slate-600">
            Pemindahan saldo <strong>tidak menambah pemasukan dan tidak menambah
            pengeluaran</strong>. Uangnya hanya berpindah tempat, jadi laba dan
            arus kas bersih tidak berubah sama sekali — hanya saldo tiap
            rekening yang bergeser.
          </p>
        </div>
      </div>

      {bolehCatat && (
        <form onSubmit={simpan} className="card mb-4">
          <h2 className="card-title mb-3 flex items-center gap-2">
            <ArrowRightLeft size={16} /> Catat Pemindahan
          </h2>

          <div className="grid gap-3 sm:grid-cols-5">
            <Field label="Tanggal *">
              <input
                type="date" className="input" required value={form.entry_date}
                onChange={(e) => setForm({ ...form, entry_date: e.target.value })}
              />
            </Field>

            <Field label="Dari Rekening *">
              <select
                className="input" required value={form.from_code}
                onChange={(e) => setForm({ ...form, from_code: e.target.value })}
              >
                <option value="">— pilih —</option>
                {rekening.map((r) => (
                  <option key={r.code} value={r.code}>{r.code} · {r.name}</option>
                ))}
              </select>
            </Field>

            <Field label="Ke Rekening *">
              <select
                className="input" required value={form.to_code}
                onChange={(e) => setForm({ ...form, to_code: e.target.value })}
              >
                <option value="">— pilih —</option>
                {rekening
                  .filter((r) => r.code !== form.from_code)
                  .map((r) => (
                    <option key={r.code} value={r.code}>{r.code} · {r.name}</option>
                  ))}
              </select>
            </Field>

            <Field label="Nominal *">
              <input
                type="number" min="1" step="any" className="input" required
                placeholder="0" value={form.amount}
                onChange={(e) => setForm({ ...form, amount: e.target.value })}
              />
            </Field>

            <Field label="Keterangan" hint="mis. tarik tunai untuk operasional">
              <input
                className="input" maxLength={200} value={form.note}
                onChange={(e) => setForm({ ...form, note: e.target.value })}
              />
            </Field>
          </div>

          <button type="submit" className="btn-primary mt-3" disabled={kirim}>
            <ArrowRightLeft size={16} /> {kirim ? 'Menyimpan...' : 'Pindahkan Saldo'}
          </button>
        </form>
      )}

      <div className="card">
        <h2 className="card-title mb-3">Riwayat Pemindahan</h2>

        {!data?.rows?.length ? (
          <EmptyState
            title="Belum ada pemindahan saldo"
            subtitle="Pemindahan yang dicatat pada rentang tanggal ini akan tampil di sini."
          />
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>No. Jurnal</th>
                  <th>Tanggal</th>
                  <th>Dari</th>
                  <th>Ke</th>
                  <th className="text-right">Nominal</th>
                  <th>Keterangan</th>
                  {bolehCatat && <th />}
                </tr>
              </thead>
              <tbody>
                {data.rows.map((r) => (
                  <tr key={r.id}>
                    <td className="tabular whitespace-nowrap font-medium">{r.entry_no}</td>
                    <td className="tabular whitespace-nowrap">{dateID(r.date)}</td>
                    <td>{r.dari || '-'}</td>
                    <td>{r.ke || '-'}</td>
                    <td className="tabular text-right font-semibold">{rupiah(r.nilai)}</td>
                    <td className="text-xs text-slate-500">
                      {(r.description || '').replace(/^Pindah Saldo — /, '')}
                    </td>
                    {bolehCatat && (
                      <td className="text-right">
                        <button
                          type="button" onClick={() => hapus(r)}
                          className="rounded-lg p-1.5 text-slate-400 hover:bg-rose-50 hover:text-rose-600"
                          aria-label={`Batalkan ${r.entry_no}`}
                        >
                          <Trash2 size={15} />
                        </button>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
