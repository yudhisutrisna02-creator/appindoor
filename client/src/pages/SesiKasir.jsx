import { useEffect, useState, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { Wallet, Banknote, QrCode, Landmark, Scale, Eye, Printer, ShoppingCart } from 'lucide-react';
import { api } from '../lib/api';
import {
  PageHeader, StatCard, Spinner, EmptyState, Modal, useToast,
  DateRangeFilter, defaultRange, TombolCetak,
} from '../components/ui';
import { rupiah, num } from '../lib/format';

const waktu = (iso) => (iso ? new Date(iso).toLocaleString('id-ID', { dateStyle: 'short', timeStyle: 'short' }) : '-');

/**
 * Riwayat sesi kasir dan rekap setoran tunai harian.
 *
 * Satu baris satu shift: siapa kasirnya, modal awal, penjualan per cara bayar,
 * uang laci seharusnya vs yang dihitung, selisihnya, dan berapa yang disetor
 * ke bank. Total di atas menjadi rekap setoran untuk rentang tanggal terpilih.
 */
export default function SesiKasir() {
  const toast = useToast();
  const [range, setRange] = useState(defaultRange);
  const [data, setData] = useState(null);
  const [detail, setDetail] = useState(null);

  const load = useCallback(async () => {
    try {
      setData(await api.get('/api/kasir/sesi', range));
    } catch (err) {
      toast.error(err.message);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [range]);

  useEffect(() => { load(); }, [load]);

  async function lihat(id) {
    try {
      setDetail(await api.get(`/api/kasir/sesi/${id}`));
    } catch (err) {
      toast.error(err.message);
    }
  }

  if (!data) return <Spinner />;
  const r = data.ringkas;

  return (
    <div>
      <PageHeader title="Sesi Kasir" subtitle="Buka/tutup shift kasir dan rekap setoran tunai harian">
        <Link className="btn-primary" to="/penjualan/kasir"><ShoppingCart size={16} /> Buka Kasir</Link>
      </PageHeader>

      <DateRangeFilter range={range} onChange={setRange} />

      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard label="Penjualan kasir" value={rupiah(r.total)} sub={`${num(r.transaksi)} transaksi · ${num(r.sesi)} sesi`} icon={Wallet} tone="brand" />
        <StatCard label="Tunai" value={rupiah(r.tunai)} sub={`disetor ${rupiah(r.disetor)}`} icon={Banknote} tone="green" />
        <StatCard label="QRIS + Transfer" value={rupiah(r.qris + r.transfer)} sub={`QRIS ${rupiah(r.qris)}`} icon={QrCode} tone="amber" />
        <StatCard label="Selisih laci" value={rupiah(r.selisih)} sub={r.selisih < 0 ? 'kurang dari seharusnya' : 'lebih / pas'} icon={Scale} tone={r.selisih < 0 ? 'red' : 'green'} />
      </div>

      <div className="card">
        {data.rows.length === 0 ? (
          <EmptyState message="Belum ada sesi kasir pada rentang ini" />
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Sesi</th><th>Kasir</th><th>Buka</th><th>Tutup</th>
                  <th className="text-right">Modal</th><th className="text-right">Tunai</th>
                  <th className="text-right">QRIS</th><th className="text-right">Transfer</th>
                  <th className="text-right">Laci seharusnya</th><th className="text-right">Dihitung</th>
                  <th className="text-right">Selisih</th><th className="text-right">Disetor</th><th>Status</th><th />
                </tr>
              </thead>
              <tbody>
                {data.rows.map((s) => (
                  <tr key={s.id}>
                    <td className="font-mono text-xs">{s.session_no}</td>
                    <td className="text-sm">{s.user_name}</td>
                    <td className="text-xs">{waktu(s.opened_at)}</td>
                    <td className="text-xs">{waktu(s.closed_at)}</td>
                    <td className="tabular text-right">{rupiah(s.opening_cash)}</td>
                    <td className="tabular text-right">{rupiah(s.rekap.perMetode.TUNAI)}</td>
                    <td className="tabular text-right">{rupiah(s.rekap.perMetode.QRIS)}</td>
                    <td className="tabular text-right">{rupiah(s.rekap.perMetode.TRANSFER)}</td>
                    <td className="tabular text-right">{rupiah(s.status === 'OPEN' ? s.rekap.uangLaciSeharusnya : s.expected_cash)}</td>
                    <td className="tabular text-right">{s.counted_cash != null ? rupiah(s.counted_cash) : '-'}</td>
                    <td className={`tabular text-right font-semibold ${s.selisih < 0 ? 'text-rose-600' : s.selisih > 0 ? 'text-amber-600' : ''}`}>
                      {s.selisih != null ? rupiah(s.selisih) : '-'}
                    </td>
                    <td className="tabular text-right">{s.setor_amount ? rupiah(s.setor_amount) : '-'}</td>
                    <td>{s.status === 'OPEN' ? <span className="badge-amber">Terbuka</span> : <span className="badge-green">Ditutup</span>}</td>
                    <td>
                      <button className="btn-ghost !px-2 !py-1" aria-label="Detail" onClick={() => lihat(s.id)}><Eye size={14} /></button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <Modal open={!!detail} onClose={() => setDetail(null)} title={`Sesi ${detail?.sesi.session_no || ''}`} wide>
        {detail && (
          <div className="grid gap-3">
            <p className="text-sm text-slate-600">
              {detail.sesi.user_name} · buka {waktu(detail.sesi.opened_at)}
              {detail.sesi.closed_at && <> · tutup {waktu(detail.sesi.closed_at)}</>}
              {detail.sesi.note && <> · {detail.sesi.note}</>}
            </p>
            {detail.transaksi.length === 0 ? (
              <EmptyState message="Belum ada transaksi di sesi ini" />
            ) : (
              <div className="table-wrap">
                <table className="table text-sm">
                  <thead>
                    <tr><th>No.</th><th>Waktu</th><th>Pembeli</th><th>Cara bayar</th><th className="text-right">Total</th><th className="text-right">Kembali</th><th /></tr>
                  </thead>
                  <tbody>
                    {detail.transaksi.map((t) => (
                      <tr key={t.id}>
                        <td className="font-mono text-xs">{t.order_no}</td>
                        <td className="text-xs">{waktu(t.created_at ? `${t.created_at.replace(' ', 'T')}Z` : null)}</td>
                        <td className="text-xs">{t.customer || '-'}</td>
                        <td>
                          <span className="inline-flex items-center gap-1 text-xs">
                            {t.pos_method === 'TUNAI' ? <Banknote size={13} /> : t.pos_method === 'QRIS' ? <QrCode size={13} /> : <Landmark size={13} />}
                            {t.pos_method}
                          </span>
                        </td>
                        <td className="tabular text-right font-semibold">{rupiah(t.total)}</td>
                        <td className="tabular text-right">{t.pos_change ? rupiah(t.pos_change) : '-'}</td>
                        <td>
                          {t.status === 'POSTED'
                            ? <TombolCetak path={`/api/kasir/transaksi/${t.id}/struk.pdf`} label="" icon={Printer} kecil />
                            : <span className="badge-slate">Batal</span>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}
      </Modal>
    </div>
  );
}
