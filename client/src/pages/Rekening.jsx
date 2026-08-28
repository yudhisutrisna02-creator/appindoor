import { useEffect, useState, useCallback } from 'react';
import { Landmark, AlertTriangle, Plus, Pencil } from 'lucide-react';
import { api } from '../lib/api';
import {
  PageHeader, StatCard, Spinner, EmptyState, Modal,
  useToast, Field, TombolEkspor,
} from '../components/ui';
import { rupiah, rupiahShort, dateID, today } from '../lib/format';
import { useAuth } from '../lib/auth';

const KOSONG = { code: '', name: '', is_cash: true, active: true };

/**
 * Rekening kas & bank.
 *
 * Selama seluruh uang menumpuk di satu akun, catatan aplikasi tidak bisa
 * dicocokkan dengan mutasi bank yang sebenarnya — yang cocok hanya jumlah
 * keseluruhannya, dan itu tidak menolong siapa pun yang sedang mencari selisih.
 * Layar ini memisahkannya per rekening, lengkap dengan asal tiap pergerakan.
 */
export default function Rekening() {
  const toast = useToast();
  const { punya } = useAuth();
  const bolehUbah = punya('keuangan.coa');

  const [asOf, setAsOf] = useState(today());
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [form, setForm] = useState(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setData(await api.get('/api/cashflow/rekening', { asOf }));
    } catch (err) {
      toast.error(err.message);
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [asOf]);

  useEffect(() => { load(); }, [load]);

  async function simpan(e) {
    e.preventDefault();
    setSaving(true);
    try {
      const isi = {
        code: form.code,
        name: form.name,
        type: 'ASSET',
        subtype: 'CASH',
        normal: 'D',
        cashflow: 'OCF',
        is_cash: true,
        active: form.active,
      };
      const res = form.id
        ? await api.put(`/api/finance/accounts/${form.id}`, isi)
        : await api.post('/api/finance/accounts', isi);
      toast.success(res.ok ? `Rekening ${form.name} disimpan` : 'Tersimpan');
      setForm(null);
      load();
    } catch (err) {
      toast.error(err.message);
    } finally {
      setSaving(false);
    }
  }

  if (loading || !data) return <Spinner label="Menghitung saldo rekening..." />;

  const r = data.ringkas;

  return (
    <div>
      <PageHeader title="Rekening Kas & Bank" subtitle="Saldo tiap rekening berikut asal pergerakannya">
        {bolehUbah && (
          <button className="btn-primary" onClick={() => setForm({ ...KOSONG })}>
            <Plus size={16} /> Rekening Baru
          </button>
        )}
        <TombolEkspor path="/api/cashflow/rekening" params={{ asOf }} nama="rekening-kas-bank" />
      </PageHeader>

      <div className="card mb-4">
        <Field label="Saldo per Tanggal" className="max-w-xs">
          <input type="date" className="input" value={asOf} onChange={(e) => setAsOf(e.target.value)} />
        </Field>
      </div>

      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-3">
        <StatCard label="Jumlah Rekening" value={r.jumlahRekening} icon={Landmark} />
        <StatCard
          label="Total Saldo" value={rupiahShort(r.total)}
          sub={`per ${dateID(data.asOf)}`}
          tone={r.total >= 0 ? 'brand' : 'red'}
        />
        <StatCard
          label="Rekening Minus" value={r.minus}
          sub={r.minus > 0 ? 'perlu ditelusuri' : 'semua wajar'}
          icon={AlertTriangle} tone={r.minus > 0 ? 'red' : 'green'}
        />
      </div>

      {r.minus > 0 && (
        <div className="card mb-4 border-2 border-rose-200 bg-rose-50/60 dark:bg-rose-400/10">
          <div className="flex items-start gap-2">
            <AlertTriangle size={17} className="mt-0.5 shrink-0 text-rose-600" />
            <div className="text-sm text-slate-700">
              <p className="font-semibold text-slate-900">Ada rekening bersaldo minus</p>
              <p className="mt-1 text-xs leading-relaxed">
                Kas atau bank tidak mungkin minus secara fisik. Umumnya karena pengeluaran sudah
                tercatat sementara pemasukannya belum, atau beberapa rekening yang sebenarnya berbeda
                masih digabung ke satu akun. Rincian per asal di tiap baris menunjukkan dari mana
                pergerakannya datang.
              </p>
            </div>
          </div>
        </div>
      )}

      <div className="card">
        {data.rows.length === 0 ? (
          <EmptyState message="Belum ada rekening kas atau bank" />
        ) : (
          <div className="space-y-3">
            {data.rows.map((a) => (
              <div
                key={a.id}
                className={`rounded-xl p-4 ring-1 ${
                  a.minus ? 'bg-rose-50/50 ring-rose-200 dark:bg-rose-400/5' : 'bg-slate-50 ring-slate-200'
                }`}
              >
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <p className="font-semibold text-slate-900">
                      <span className="font-mono text-xs text-slate-500">{a.code}</span> {a.name}
                    </p>
                    <p className="text-xs text-slate-500">
                      {a.mutasi} mutasi
                      {a.terakhir && ` • terakhir ${dateID(a.terakhir)}`}
                    </p>
                  </div>
                  <div className="text-right">
                    <p className={`tabular text-lg font-bold ${a.minus ? 'text-rose-600' : 'text-slate-900'}`}>
                      {rupiah(a.saldo)}
                    </p>
                    {bolehUbah && (
                      <button
                        className="btn-ghost !px-2 !py-1 text-xs"
                        onClick={() => setForm({ id: a.id, code: a.code, name: a.name, active: true })}
                      >
                        <Pencil size={13} /> Ubah
                      </button>
                    )}
                  </div>
                </div>

                {a.perSumber.length > 0 && (
                  <div className="mt-3 flex flex-wrap gap-2">
                    {a.perSumber.map((s) => (
                      <div key={s.sumber} className="rounded-lg bg-surface px-2.5 py-1.5 text-xs ring-1 ring-slate-200">
                        <span className="font-medium text-slate-700">{s.sumber}</span>
                        {s.masuk > 0 && <span className="ml-2 text-emerald-600">+{rupiahShort(s.masuk)}</span>}
                        {s.keluar > 0 && <span className="ml-2 text-rose-600">−{rupiahShort(s.keluar)}</span>}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      <Modal open={!!form} onClose={() => setForm(null)} title={form?.id ? 'Ubah Rekening' : 'Rekening Baru'}>
        {form && (
          <form onSubmit={simpan} className="grid gap-3">
            <Field label="Kode Akun *" hint="3–6 digit, mis. 1011 untuk rekening bank kedua">
              <input
                className="input" required pattern="\d{3,6}" value={form.code}
                onChange={(e) => setForm({ ...form, code: e.target.value })}
              />
            </Field>
            <Field label="Nama Rekening *" hint="Tulis seperti yang Anda kenali, mis. BCA Aji">
              <input className="input" required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
            </Field>
            <p className="rounded-xl bg-slate-50 px-3 py-2 text-xs text-slate-600">
              Rekening baru langsung bisa dipilih saat mencatat kas, biaya iklan, dan pembelian.
              Catatan lama tetap menunjuk rekening yang dipakai saat itu — tidak ada yang berubah
              surut.
            </p>
            <div className="flex gap-2">
              <button type="button" className="btn-secondary flex-1" onClick={() => setForm(null)}>Batal</button>
              <button type="submit" className="btn-primary flex-1" disabled={saving}>
                {saving ? 'Menyimpan...' : 'Simpan'}
              </button>
            </div>
          </form>
        )}
      </Modal>
    </div>
  );
}
