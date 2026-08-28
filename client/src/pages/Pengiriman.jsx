import { useEffect, useState, useCallback, useMemo } from 'react';
import { Truck, CheckCheck, AlertTriangle, Clock } from 'lucide-react';
import { api } from '../lib/api';
import {
  PageHeader, StatCard, Spinner, EmptyState,
  DateRangeFilter, defaultRange, useToast, Field,
} from '../components/ui';
import { rupiah, rupiahShort, dateID, today, STATUS_PESANAN, WARNA_STATUS, CHANNEL_LABEL } from '../lib/format';
import { useAuth } from '../lib/auth';

/** Urutan tahap mengikuti perjalanan pesanan, bukan abjad. */
const TAHAP = ['DIPROSES', 'DIKIRIM', 'SELESAI', 'CAIR', 'RETUR'];

/** Tahap berikutnya yang lazim — dipakai sebagai usulan tombol cepat. */
const LANJUT = { DIPROSES: 'DIKIRIM', DIKIRIM: 'SELESAI', SELESAI: 'CAIR' };

/**
 * Papan pengiriman.
 *
 * Dibuat karena pekerjaan hariannya bukan membaca angka, melainkan memindahkan
 * pesanan dari satu tahap ke tahap berikutnya. Dengan ratusan pesanan per bulan,
 * membuka satu per satu untuk mengubah satu kolom menghabiskan waktu yang
 * seharusnya dipakai melayani pembeli.
 */
export default function Pengiriman() {
  const toast = useToast();
  const { punya } = useAuth();
  const bolehUbah = punya('penjualan.ubah');

  const [range, setRange] = useState(defaultRange);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [tahap, setTahap] = useState('DIPROSES');
  const [pilih, setPilih] = useState([]);
  const [tujuan, setTujuan] = useState('DIKIRIM');
  const [tglCair, setTglCair] = useState(today());
  const [lunas, setLunas] = useState(true);
  const [kirim, setKirim] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setData(await api.get('/api/sales/papan', range));
      setPilih([]);
    } catch (err) {
      toast.error(err.message);
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [range]);

  useEffect(() => { load(); }, [load]);

  // Berpindah tahap membatalkan pilihan: centang yang tertinggal dari tahap
  // sebelumnya akan ikut terkirim tanpa disadari.
  useEffect(() => {
    setPilih([]);
    setTujuan(LANJUT[tahap] || 'CAIR');
  }, [tahap]);

  const kolom = useMemo(
    () => (data ? data.kolom.find((k) => k.status === tahap) : null),
    [data, tahap]
  );

  const semuaTercentang = kolom && kolom.rows.length > 0 && pilih.length === kolom.rows.length;

  function centangSemua() {
    setPilih(semuaTercentang ? [] : kolom.rows.map((r) => r.id));
  }

  function centang(id) {
    setPilih((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));
  }

  async function terapkan() {
    if (!pilih.length) return;
    const label = STATUS_PESANAN[tujuan] || tujuan;
    if (!window.confirm(`Ubah ${pilih.length} pesanan menjadi "${label}"?`)) return;

    setKirim(true);
    try {
      const isi = { ids: pilih, fulfillment_status: tujuan };
      // Tanggal cair dan status lunas hanya masuk akal saat dananya memang cair.
      if (tujuan === 'CAIR') {
        isi.payout_date = tglCair || null;
        if (lunas) isi.payment_status = 'PAID';
      }
      const res = await api.patch('/api/sales/status-massal', isi);
      if (res.gagal && res.gagal.length) {
        toast.error(`${res.message} — ${res.gagal.slice(0, 2).map((g) => g.order_no).join(', ')}`);
      } else {
        toast.success(res.message);
      }
      load();
    } catch (err) {
      toast.error(err.message);
    } finally {
      setKirim(false);
    }
  }

  if (loading || !data) return <Spinner label="Menyiapkan papan pengiriman..." />;

  const r = data.ringkas;

  return (
    <div>
      <PageHeader
        title="Papan Pengiriman"
        subtitle="Pindahkan pesanan antar tahap tanpa membuka satu per satu"
      />

      <DateRangeFilter range={range} onChange={setRange} />

      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-3">
        <StatCard label="Total Pesanan" value={r.total} sub={`${data.from} s/d ${data.to}`} icon={Truck} />
        <StatCard
          label="Belum Selesai" value={r.belumSelesai}
          sub="masih diproses atau dikirim"
          icon={Clock} tone={r.belumSelesai > 0 ? 'amber' : 'green'}
        />
        <StatCard
          label="Dana Belum Cair" value={rupiahShort(r.nilaiBelumCair)}
          sub="nilai bersih yang belum diterima"
          tone={r.nilaiBelumCair > 0 ? 'amber' : 'green'}
        />
      </div>

      {/* ---------- TAHAP ---------- */}
      <div className="mb-4 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
        {data.kolom.map((k) => (
          <button
            key={k.status}
            onClick={() => setTahap(k.status)}
            className={`rounded-xl p-3 text-left ring-1 transition ${
              tahap === k.status
                ? 'bg-brand-600 text-white ring-brand-600'
                : 'bg-surface ring-slate-200 hover:ring-brand-300'
            }`}
          >
            <p className={`text-xs font-semibold uppercase tracking-wide ${tahap === k.status ? 'text-brand-100' : 'text-slate-500'}`}>
              {STATUS_PESANAN[k.status] || k.status}
            </p>
            <p className={`mt-1 text-xl font-bold ${tahap === k.status ? 'text-white' : 'text-slate-900'}`}>
              {k.orders}
            </p>
            <p className={`text-[11px] ${tahap === k.status ? 'text-brand-100' : 'text-slate-500'}`}>
              {rupiahShort(k.nilai)}
              {k.tertua > 0 && ` • tertua ${k.tertua} hari`}
            </p>
          </button>
        ))}
      </div>

      {/* ---------- AKSI MASSAL ---------- */}
      {bolehUbah && pilih.length > 0 && (
        <div className="card mb-4 border-2 border-brand-200 bg-brand-50/60 dark:bg-brand-400/10">
          <div className="flex flex-wrap items-end gap-3">
            <div className="flex-1 min-w-[10rem]">
              <p className="text-sm font-semibold text-slate-900">{pilih.length} pesanan dipilih</p>
              <p className="text-xs text-slate-600">
                dari tahap {STATUS_PESANAN[tahap] || tahap}
              </p>
            </div>

            <Field label="Pindahkan ke" className="w-44">
              <select className="input" value={tujuan} onChange={(e) => setTujuan(e.target.value)}>
                {TAHAP.filter((t) => t !== tahap).map((t) => (
                  <option key={t} value={t}>{STATUS_PESANAN[t] || t}</option>
                ))}
              </select>
            </Field>

            {tujuan === 'CAIR' && (
              <>
                <Field label="Tanggal Cair" className="w-40">
                  <input type="date" className="input" value={tglCair} onChange={(e) => setTglCair(e.target.value)} />
                </Field>
                <label className="mb-2.5 flex items-center gap-2 text-sm text-slate-700">
                  <input type="checkbox" className="h-4 w-4 rounded" checked={lunas} onChange={(e) => setLunas(e.target.checked)} />
                  Tandai lunas
                </label>
              </>
            )}

            <button className="btn-primary mb-0.5" onClick={terapkan} disabled={kirim}>
              <CheckCheck size={16} /> {kirim ? 'Memproses...' : 'Terapkan'}
            </button>
            <button className="btn-secondary mb-0.5" onClick={() => setPilih([])} disabled={kirim}>
              Batal Pilih
            </button>
          </div>

          {tujuan === 'CAIR' && lunas && (
            <p className="mt-2 flex items-start gap-1.5 text-xs text-slate-600">
              <AlertTriangle size={14} className="mt-0.5 shrink-0 text-amber-500" />
              Menandai lunas memindahkan nilainya dari Piutang Marketplace ke kas/bank, dan jurnal
              tiap pesanan ditulis ulang.
            </p>
          )}
        </div>
      )}

      {/* ---------- DAFTAR ---------- */}
      <div className="card">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="card-title">
            {STATUS_PESANAN[tahap] || tahap} — {kolom ? kolom.orders : 0} pesanan
          </h2>
          {bolehUbah && kolom && kolom.rows.length > 0 && (
            <button className="btn-ghost !py-1.5 text-xs" onClick={centangSemua}>
              {semuaTercentang ? 'Hapus semua centang' : 'Centang semua'}
            </button>
          )}
        </div>

        {!kolom || kolom.rows.length === 0 ? (
          <EmptyState message={`Tidak ada pesanan pada tahap ${STATUS_PESANAN[tahap] || tahap}`} />
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  {bolehUbah && <th className="w-8"></th>}
                  <th>Order</th><th>Umur</th><th>Toko</th><th>Pembeli</th>
                  <th>Ekspedisi</th><th>Resi</th><th>Nilai Bersih</th><th>Bayar</th>
                </tr>
              </thead>
              <tbody>
                {kolom.rows.map((o) => (
                  <tr key={o.id} className={pilih.includes(o.id) ? 'bg-brand-50/60 dark:bg-brand-400/10' : ''}>
                    {bolehUbah && (
                      <td>
                        <input
                          type="checkbox"
                          className="h-4 w-4 rounded"
                          checked={pilih.includes(o.id)}
                          onChange={() => centang(o.id)}
                          aria-label={`Pilih ${o.order_no}`}
                        />
                      </td>
                    )}
                    <td>
                      <p className="font-mono text-xs">{o.order_no}</p>
                      <p className="text-[11px] text-slate-500">{dateID(o.order_date)}</p>
                    </td>
                    <td className="tabular">
                      {/* Pesanan yang lama tertahan diberi warna: itu yang paling
                          perlu ditengok, bukan yang paling besar nilainya. */}
                      <span className={o.umur_hari >= 7 ? 'badge-red' : o.umur_hari >= 3 ? 'badge-amber' : 'badge-slate'}>
                        {o.umur_hari} hari
                      </span>
                    </td>
                    <td className="text-sm">
                      {o.shop_name || <span className="text-slate-400">—</span>}
                      <p className="text-[11px] text-slate-500">{CHANNEL_LABEL[o.channel] || o.channel}</p>
                    </td>
                    <td className="text-sm">
                      {o.customer || '-'}
                      {o.buyer_city && <p className="text-[11px] text-slate-500">{o.buyer_city}</p>}
                    </td>
                    <td className="text-xs">{o.courier || '-'}</td>
                    <td className="font-mono text-[11px]">{o.tracking_no || '-'}</td>
                    <td className="tabular">{rupiah(o.net_revenue - o.total_fees)}</td>
                    <td>
                      <span className={o.payment_status === 'PAID' ? 'badge-green' : 'badge-amber'}>
                        {o.payment_status === 'PAID' ? 'Lunas' : 'Belum cair'}
                      </span>
                    </td>
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
