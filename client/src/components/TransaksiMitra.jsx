import { useEffect, useState, useCallback } from 'react';
import { Pencil, Trash2 } from 'lucide-react';
import { api } from '../lib/api';
import { Spinner, EmptyState, Modal, DateRangeFilter, defaultRange, useToast, Field, TombolEkspor } from './ui';
import { rupiah, dateID } from '../lib/format';
import { useAuth } from '../lib/auth';

/**
 * Semua transaksi utang & piutang pada rentang tanggal — pelunasan, saldo
 * awal, barang masuk kredit, penjualan belum lunas.
 *
 * Daftar per mitra di tab sebelah hanya memuat mitra yang MASIH punya saldo.
 * Pembayaran yang salah pada mitra yang saldonya nol atau minus tidak bisa
 * dijangkau dari sana; di sini semuanya muncul menurut tanggal.
 */
export default function TransaksiMitra({ onBerubah, cashAccounts = [] }) {
  const toast = useToast();
  const { punya } = useAuth();
  const bolehUbah = punya('keuangan.kas');
  const [range, setRange] = useState(defaultRange);
  const [jenis, setJenis] = useState('');
  const [q, setQ] = useState('');
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [ubah, setUbah] = useState(null);
  const [menyimpan, setMenyimpan] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setData(await api.get('/api/cashflow/transaksi-mitra', { ...range, jenis, q }));
    } catch (err) {
      toast.error(err.message);
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [range, jenis, q]);

  useEffect(() => {
    const t = setTimeout(load, 250);
    return () => clearTimeout(t);
  }, [load]);

  async function hapus(r) {
    if (!window.confirm(
      `Hapus ${r.label.toLowerCase()} ${r.entry_no} — ${r.partner_name}, ${dateID(r.entry_date)}, ${rupiah(r.nominal)}?\n\n` +
      `Sisa ${r.jenis.toLowerCase()} mitra ini berubah sebesar nominal tersebut.`
    )) return;
    try {
      const res = await api.del(`/api/cashflow/settlements/${r.journal_id}`);
      toast.success(res.message);
      load();
      onBerubah?.();
    } catch (err) {
      toast.error(err.message);
    }
  }

  async function simpan(e) {
    e.preventDefault();
    setMenyimpan(true);
    try {
      const res = await api.put(`/api/cashflow/settlements/${ubah.journal_id}`, {
        entry_date: ubah.entry_date,
        amount: Number(ubah.nominal),
        cash_code: ubah.cash_code,
        note: ubah.memo || null,
      });
      toast.success(res.message);
      setUbah(null);
      load();
      onBerubah?.();
    } catch (err) {
      toast.error(err.message);
    } finally {
      setMenyimpan(false);
    }
  }

  const params = { ...range, jenis, q };

  return (
    <div>
      <DateRangeFilter range={range} onChange={setRange}>
        <div className="w-36">
          <label className="label">Jenis</label>
          <select className="input" value={jenis} onChange={(e) => setJenis(e.target.value)}>
            <option value="">Semua</option>
            <option value="utang">Utang</option>
            <option value="piutang">Piutang</option>
          </select>
        </div>
        <div className="min-w-[180px] flex-1">
          <label className="label">Cari</label>
          <input
            className="input" placeholder="Nama mitra / no. jurnal" value={q}
            onChange={(e) => setQ(e.target.value)}
          />
        </div>
        <div className="flex items-end">
          <TombolEkspor path="/api/cashflow/transaksi-mitra" params={params} nama="transaksi-utang-piutang" />
        </div>
      </DateRangeFilter>

      <div className="card">
        {loading || !data ? (
          <Spinner />
        ) : data.rows.length === 0 ? (
          <EmptyState message="Tidak ada transaksi utang/piutang pada rentang ini" hint="Ubah tanggal atau kata pencarian" />
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Tanggal</th><th>No. Jurnal</th><th>Mitra</th><th>Transaksi</th>
                  <th>Rekening</th><th className="text-right">Nominal</th><th />
                </tr>
              </thead>
              <tbody>
                {data.rows.map((r) => (
                  <tr key={`${r.journal_id}-${r.partner_id}-${r.subtype}`}>
                    <td className="tabular">{dateID(r.entry_date)}</td>
                    <td className="font-mono text-xs">{r.entry_no}</td>
                    <td>
                      <p className="font-medium text-slate-900">{r.partner_name}</p>
                      <p className="text-xs text-slate-400">{r.jenis}</p>
                    </td>
                    <td>
                      <p className="text-sm">{r.label}</p>
                      <p className="max-w-[240px] truncate text-xs text-slate-400">{r.memo || r.description}</p>
                    </td>
                    <td className="text-xs text-slate-500">{r.rekening || '-'}</td>
                    <td className={`tabular text-right font-semibold ${r.arah === 'BERKURANG' ? 'text-emerald-700' : 'text-amber-700'}`}>
                      {r.arah === 'BERKURANG' ? '−' : '+'}{rupiah(r.nominal)}
                    </td>
                    <td>
                      {bolehUbah && (
                        <div className="flex justify-end gap-1">
                          {r.bisaUbah && (
                            <button
                              type="button" className="btn-ghost !px-2 !py-1" title="Ubah" aria-label="Ubah"
                              onClick={() => setUbah({ ...r, cash_code: r.cash_code || '' })}
                            >
                              <Pencil size={14} />
                            </button>
                          )}
                          {r.bisaHapus && (
                            <button
                              type="button" className="btn-ghost !px-2 !py-1 text-rose-600" title="Hapus" aria-label="Hapus"
                              onClick={() => hapus(r)}
                            >
                              <Trash2 size={14} />
                            </button>
                          )}
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="mt-2 text-xs text-slate-500">
              <span className="text-amber-700">+</span> utang/piutang bertambah ·{' '}
              <span className="text-emerald-700">−</span> dilunasi. Utang dari barang masuk atau pesanan
              pembelian dibetulkan lewat Mutasi Stok / Pesanan Pembelian.
            </p>
          </div>
        )}
      </div>

      <Modal open={!!ubah} onClose={() => setUbah(null)} title={`Ubah ${ubah?.entry_no || ''}`}>
        {ubah && (
          <form onSubmit={simpan} className="grid gap-3 sm:grid-cols-2">
            <div className="rounded-xl bg-slate-50 p-3 text-sm sm:col-span-2">
              <p className="font-semibold text-slate-900">{ubah.partner_name}</p>
              <p className="text-xs text-slate-500">{ubah.description}</p>
            </div>
            <Field label="Tanggal *">
              <input
                type="date" className="input" required value={ubah.entry_date}
                onChange={(e) => setUbah({ ...ubah, entry_date: e.target.value })}
              />
            </Field>
            <Field label="Nominal (Rp) *">
              <input
                type="number" min="0" step="any" className="input" required value={ubah.nominal}
                onChange={(e) => setUbah({ ...ubah, nominal: e.target.value })}
              />
            </Field>
            <Field label={ubah.subtype === 'PAYABLE' ? 'Uang diambil dari *' : 'Uang masuk ke *'} className="sm:col-span-2">
              <select
                className="input" required value={ubah.cash_code}
                onChange={(e) => setUbah({ ...ubah, cash_code: e.target.value })}
              >
                <option value="">— pilih rekening yang benar-benar dipakai —</option>
                {cashAccounts.map((k) => <option key={k.code} value={k.code}>{k.code} — {k.name}</option>)}
              </select>
            </Field>
            <Field label="Catatan" className="sm:col-span-2">
              <input
                className="input" maxLength={200} value={ubah.memo || ''}
                onChange={(e) => setUbah({ ...ubah, memo: e.target.value })}
              />
            </Field>
            <div className="flex gap-2 sm:col-span-2">
              <button type="button" className="btn-secondary flex-1" onClick={() => setUbah(null)}>Batal</button>
              <button type="submit" className="btn-primary flex-1" disabled={menyimpan}>
                {menyimpan ? 'Menyimpan...' : 'Simpan Perubahan'}
              </button>
            </div>
          </form>
        )}
      </Modal>
    </div>
  );
}
