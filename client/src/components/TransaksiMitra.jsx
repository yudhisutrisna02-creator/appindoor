import { useEffect, useState, useCallback } from 'react';
import { Pencil, Trash2 } from 'lucide-react';
import { api } from '../lib/api';
import { Spinner, EmptyState, DateRangeFilter, defaultRange, useToast, TombolEkspor } from './ui';
import AksiTransaksiMitra from './AksiTransaksiMitra';
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
  const [aksi, setAksi] = useState(null);

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
                          <button
                            type="button" className="btn-ghost !px-2 !py-1" title="Ubah" aria-label={`Ubah ${r.entry_no}`}
                            onClick={() => setAksi({ journal_id: r.journal_id, partner_id: r.partner_id, mode: 'ubah' })}
                          >
                            <Pencil size={14} />
                          </button>
                          <button
                            type="button" className="btn-ghost !px-2 !py-1 text-rose-600" title="Hapus / tandai lunas" aria-label={`Hapus ${r.entry_no}`}
                            onClick={() => setAksi({ journal_id: r.journal_id, partner_id: r.partner_id, mode: 'hapus' })}
                          >
                            <Trash2 size={14} />
                          </button>
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="mt-2 text-xs text-slate-500">
              <span className="text-amber-700">+</span> utang/piutang bertambah ·{' '}
              <span className="text-emerald-700">−</span> dilunasi. Ikon hapus pada utang barang masuk menawarkan "Tandai sudah lunas"
              (stok tetap) atau hapus barang masuknya.
            </p>
          </div>
        )}
      </div>

      <AksiTransaksiMitra
        target={aksi} onClose={() => setAksi(null)} cashAccounts={cashAccounts}
        onSelesai={() => { load(); onBerubah?.(); }}
      />
    </div>
  );
}
