import { useEffect, useState, useCallback } from 'react';
import { ArrowDownCircle, ArrowUpCircle, Trash2, Wallet, Plus } from 'lucide-react';
import { api } from '../lib/api';
import {
  PageHeader, StatCard, Spinner, EmptyState, Modal,
  DateRangeFilter, defaultRange, useToast, Field, TombolEkspor } from '../components/ui';
import { rupiah, today, dateID } from '../lib/format';
import { useAuth } from '../lib/auth';

/**
 * Pencatatan kas harian tanpa perlu paham debit-kredit.
 * Pengguna memilih kategori dan mengisi nominal; jurnal berpasangan dibentuk
 * otomatis oleh server.
 */
export default function KasMasukKeluar() {
  const toast = useToast();
  const { canManage } = useAuth();
  const [range, setRange] = useState(defaultRange);
  const [data, setData] = useState(null);
  const [options, setOptions] = useState(null);
  const [loading, setLoading] = useState(true);
  const [form, setForm] = useState(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setData(await api.get('/api/cashflow/entries', range));
    } catch (err) {
      toast.error(err.message);
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [range]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    api.get('/api/cashflow/options').then(setOptions).catch((e) => toast.error(e.message));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function openForm(direction) {
    setForm({
      direction,
      entry_date: today(),
      category_code: '',
      cash_code: options?.cashAccounts?.[0]?.code || '',
      amount: '',
      description: '',
    });
  }

  async function submit(e) {
    e.preventDefault();
    setSaving(true);
    try {
      const res = await api.post('/api/cashflow/entries', {
        ...form,
        amount: Number(form.amount),
      });
      toast.success(res.message);
      setForm(null);
      load();
    } catch (err) {
      toast.error(err.message);
    } finally {
      setSaving(false);
    }
  }

  async function hapus(row) {
    if (!window.confirm(`Hapus catatan ${row.entry_no}? Jurnalnya ikut terhapus.`)) return;
    try {
      const res = await api.del(`/api/cashflow/entries/${row.id}`);
      toast.success(res.message);
      load();
    } catch (err) {
      toast.error(err.message);
    }
  }

  const kategori = form?.direction === 'IN' ? options?.incomeCategories : options?.expenseCategories;

  return (
    <div>
      <PageHeader
        title="Kas Masuk & Kas Keluar"
        subtitle="Catat pemasukan dan pengeluaran harian — jurnal akuntansi terbentuk otomatis"
      >
        <button className="btn-primary" onClick={() => openForm('IN')}>
          <ArrowDownCircle size={16} /> Kas Masuk
        </button>
        <button className="btn-secondary" onClick={() => openForm('OUT')}>
          <ArrowUpCircle size={16} /> Kas Keluar
        </button>
        <TombolEkspor path="/api/cashflow/entries" params={range} nama="kas-masuk-keluar" />
      </PageHeader>

      <DateRangeFilter range={range} onChange={setRange} />

      {loading || !data ? (
        <Spinner />
      ) : (
        <>
          <div className="mb-4 grid grid-cols-1 gap-3 sm:grid-cols-3">
            <StatCard label="Total Masuk" value={rupiah(data.summary.masuk)} icon={ArrowDownCircle} tone="green" />
            <StatCard label="Total Keluar" value={rupiah(data.summary.keluar)} icon={ArrowUpCircle} tone="red" />
            <StatCard
              label="Selisih Bersih" value={rupiah(data.summary.net)}
              icon={Wallet} tone={data.summary.net >= 0 ? 'brand' : 'red'}
            />
          </div>

          {/* Rincian per asal — supaya jelas bahwa daftar ini bukan hanya berisi
              catatan yang diketik di layar ini, melainkan seluruh pergerakan
              kas dari mana pun asalnya. */}
          {(data.perSumber || []).length > 0 && (
            <div className="card mb-4">
              <h2 className="card-title mb-1">Pergerakan Kas menurut Asalnya</h2>
              <p className="mb-3 text-xs text-slate-500">
                Daftar ini memuat seluruh jurnal yang menyentuh kas atau bank — termasuk belanja iklan,
                pembelian barang, dan penerimaan penjualan — sehingga totalnya cocok dengan saldo kas di Neraca.
                Baris di luar Catatan Kas diubah dari menu asalnya.
              </p>
              <div className="table-wrap">
                <table className="table">
                  <thead>
                    <tr><th>Asal</th><th>Transaksi</th><th>Masuk</th><th>Keluar</th><th>Bersih</th></tr>
                  </thead>
                  <tbody>
                    {data.perSumber.map((x) => (
                      <tr key={x.sumber}>
                        <td className="font-medium text-slate-900">{x.sumber}</td>
                        <td className="tabular">{x.baris}</td>
                        <td className="tabular text-emerald-600">{x.masuk ? rupiah(x.masuk) : '-'}</td>
                        <td className="tabular text-rose-600">{x.keluar ? rupiah(x.keluar) : '-'}</td>
                        <td className={`tabular font-semibold ${x.masuk - x.keluar >= 0 ? 'text-emerald-600' : 'text-rose-600'}`}>
                          {rupiah(x.masuk - x.keluar)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          <div className="card">
            {data.rows.length === 0 ? (
              <EmptyState
                message="Belum ada catatan kas pada rentang ini"
                hint="Klik “Kas Masuk” atau “Kas Keluar” untuk mencatat"
              />
            ) : (
              <div className="table-wrap">
                <table className="table">
                  <thead>
                    <tr>
                      <th>Tanggal</th><th>No. Jurnal</th><th>Sumber</th><th>Keterangan</th><th>Kategori</th>
                      <th>Masuk</th><th>Keluar</th><th>Dicatat</th>{canManage && <th></th>}
                    </tr>
                  </thead>
                  <tbody>
                    {data.rows.map((r) => (
                      <tr key={r.id}>
                        <td className="tabular">{dateID(r.entry_date)}</td>
                        <td className="font-mono text-xs">{r.entry_no}</td>
                        <td>
                          <span className={r.source === 'CASH' ? 'badge-blue' : 'badge-slate'}>{r.sumber}</span>
                        </td>
                        <td className="max-w-[280px] truncate font-medium text-slate-900">
                          {r.description.replace(/^Kas (Masuk|Keluar) — /, '')}
                        </td>
                        <td className="text-xs text-slate-500">{r.kategori || '-'}</td>
                        <td className="tabular font-semibold text-emerald-600">
                          {r.masuk ? rupiah(r.masuk) : '-'}
                        </td>
                        <td className="tabular font-semibold text-rose-600">
                          {r.keluar ? rupiah(r.keluar) : '-'}
                        </td>
                        <td className="text-xs text-slate-500">{r.user_name || '-'}</td>
                        {canManage && (
                          <td>
                            {/* Jurnal milik order atau belanja iklan diubah dari menu
                                asalnya; menghapusnya dari sini akan menyisakan
                                dokumennya tanpa jurnal. */}
                            {r.bisaHapus ? (
                              <button className="btn-ghost !px-2 !py-1 text-rose-600" onClick={() => hapus(r)} aria-label="Hapus">
                                <Trash2 size={14} />
                              </button>
                            ) : (
                              <span className="text-[11px] text-slate-400">dari {r.sumber}</span>
                            )}
                          </td>
                        )}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </>
      )}

      <Modal
        open={!!form}
        onClose={() => setForm(null)}
        title={form?.direction === 'IN' ? 'Catat Kas Masuk' : 'Catat Kas Keluar'}
      >
        {form && (
          <form onSubmit={submit} className="grid gap-3 sm:grid-cols-2">
            <Field label="Tanggal *">
              <input
                type="date" className="input" required
                value={form.entry_date}
                onChange={(e) => setForm({ ...form, entry_date: e.target.value })}
              />
            </Field>

            <Field label="Nominal (Rp) *">
              <input
                type="number" min="0" step="any" className="input" required
                value={form.amount}
                onChange={(e) => setForm({ ...form, amount: e.target.value })}
              />
            </Field>

            <Field
              label="Kategori *"
              hint={form.direction === 'IN' ? 'Sumber pemasukan' : 'Untuk apa uang dikeluarkan'}
              className="sm:col-span-2"
            >
              <select
                className="input" required value={form.category_code}
                onChange={(e) => setForm({ ...form, category_code: e.target.value })}
              >
                <option value="">— pilih kategori —</option>
                {(kategori || []).map((k) => (
                  <option key={k.code} value={k.code}>{k.code} — {k.name}</option>
                ))}
              </select>
            </Field>

            <Field
              label={form.direction === 'IN' ? 'Masuk ke *' : 'Diambil dari *'}
              className="sm:col-span-2"
            >
              <select
                className="input" required value={form.cash_code}
                onChange={(e) => setForm({ ...form, cash_code: e.target.value })}
              >
                {(options?.cashAccounts || []).map((k) => (
                  <option key={k.code} value={k.code}>{k.code} — {k.name}</option>
                ))}
              </select>
            </Field>

            <Field label="Keterangan *" hint="mis. Bayar listrik bulan Agustus" className="sm:col-span-2">
              <input
                className="input" required maxLength={200}
                value={form.description}
                onChange={(e) => setForm({ ...form, description: e.target.value })}
              />
            </Field>

            {form.amount > 0 && form.category_code && form.cash_code && (
              <p className="rounded-xl bg-slate-900 p-3 text-xs text-slate-200 sm:col-span-2">
                Jurnal yang akan terbentuk:
                <br />
                {form.direction === 'IN' ? (
                  <>
                    <span className="font-semibold text-emerald-400">Debit</span> {form.cash_code} sebesar {rupiah(form.amount)}
                    <br />
                    <span className="font-semibold text-amber-400">Kredit</span> {form.category_code} sebesar {rupiah(form.amount)}
                  </>
                ) : (
                  <>
                    <span className="font-semibold text-emerald-400">Debit</span> {form.category_code} sebesar {rupiah(form.amount)}
                    <br />
                    <span className="font-semibold text-amber-400">Kredit</span> {form.cash_code} sebesar {rupiah(form.amount)}
                  </>
                )}
              </p>
            )}

            <div className="flex gap-2 sm:col-span-2">
              <button type="button" className="btn-secondary flex-1" onClick={() => setForm(null)}>Batal</button>
              <button type="submit" className="btn-primary flex-1" disabled={saving}>
                <Plus size={16} /> {saving ? 'Menyimpan...' : 'Simpan'}
              </button>
            </div>
          </form>
        )}
      </Modal>
    </div>
  );
}
