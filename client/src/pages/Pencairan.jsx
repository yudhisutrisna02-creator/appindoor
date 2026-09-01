import { useEffect, useState, useCallback, useMemo } from 'react';
import { Hourglass, HandCoins, AlertTriangle, CheckCircle2, Clock } from 'lucide-react';
import { api } from '../lib/api';
import {
  PageHeader, StatCard, Spinner, EmptyState, Modal,
  useToast, Field, DateRangeFilter, defaultRange, TombolEkspor,
  KotakCari, saringLokal,
} from '../components/ui';
import { rupiah, dateID, today } from '../lib/format';
import { useAuth } from '../lib/auth';

const NADA_EMBER = {
  '0-7': 'bg-emerald-50 text-emerald-700 ring-emerald-200 dark:bg-emerald-400/10',
  '8-14': 'bg-sky-50 text-sky-700 ring-sky-200 dark:bg-sky-400/10',
  '15-30': 'bg-amber-50 text-amber-700 ring-amber-200 dark:bg-amber-400/10',
  '>30': 'bg-rose-50 text-rose-700 ring-rose-200 dark:bg-rose-400/10',
};

/**
 * Pencairan dana marketplace.
 *
 * Uang penjualan tidak masuk ke bank pada hari pesanan dibuat. Selama ditahan,
 * jumlahnya hanya ada sebagai piutang — dan sampai sekarang tidak ada satu layar
 * pun yang menunjukkan berapa banyak, milik toko mana, dan sudah berapa lama.
 */
export default function Pencairan() {
  const toast = useToast();
  const { punya } = useAuth();
  const bolehTandai = punya('penjualan.ubah');

  const [asOf, setAsOf] = useState(today());
  const [q, setQ] = useState('');
  const [range, setRange] = useState(defaultRange);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [ember, setEmber] = useState('');
  const [toko, setToko] = useState('');
  const [pilih, setPilih] = useState(() => new Set());
  const [tandai, setTandai] = useState(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setData(await api.get('/api/pencairan', { asOf, from: range.from, to: range.to }));
      setPilih(new Set());
    } catch (err) {
      toast.error(err.message);
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [asOf, range.from, range.to]);

  useEffect(() => { load(); }, [load]);

  const tampil = useMemo(() => {
    if (!data) return [];
    return saringLokal(data.rows, q, (o) => [o.order_no, o.order_ref, o.shop_name, o.buyer_city, o.courier])
      .filter((o) => !ember || o.ember === ember)
      .filter((o) => !toko || String(o.shop_id) === toko)
      .sort((a, b) => b.umur_hari - a.umur_hari || b.nilai - a.nilai);
  }, [data, ember, toko, q]);

  const nilaiPilih = useMemo(
    () => (data ? data.rows.filter((o) => pilih.has(o.id)).reduce((s, o) => s + o.nilai, 0) : 0),
    [data, pilih]
  );

  function togglePilih(id) {
    setPilih((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id); else n.add(id);
      return n;
    });
  }

  const semuaTerpilih = tampil.length > 0 && tampil.every((o) => pilih.has(o.id));
  function toggleSemua() {
    setPilih((s) => {
      const n = new Set(s);
      if (semuaTerpilih) tampil.forEach((o) => n.delete(o.id));
      else tampil.forEach((o) => n.add(o.id));
      return n;
    });
  }

  async function jalankanTandai(e) {
    e.preventDefault();
    setSaving(true);
    try {
      // Sengaja memakai jalur yang sama dengan menu Order Penjualan. Kalau ada
      // dua jalur tulis untuk hal yang sama, cepat atau lambat keduanya akan
      // berbeda memperlakukan jurnal.
      const res = await api.patch('/api/sales/status-massal', {
        ids: [...pilih],
        fulfillment_status: 'CAIR',
        payment_status: 'PAID',
        payout_date: tandai.tanggal,
      });
      if (res.gagal && res.gagal.length > 0) {
        toast.error(`${res.berhasil} berhasil, ${res.gagal.length} gagal: ${res.gagal[0].pesan}`);
      } else {
        toast.success(`${res.berhasil} order ditandai cair`);
      }
      setTandai(null);
      load();
    } catch (err) {
      toast.error(err.message);
    } finally {
      setSaving(false);
    }
  }

  if (loading || !data) return <Spinner label="Menghitung dana yang ditahan..." />;

  const r = data.ringkas;
  const k = data.rekonsiliasi;

  return (
    <div>
      <PageHeader
        title="Pencairan Dana"
        subtitle="Uang penjualan yang masih ditahan marketplace, dan berapa lama sudah tertahan"
      >
        {bolehTandai && pilih.size > 0 && (
          <button className="btn-primary" onClick={() => setTandai({ tanggal: today() })}>
            <HandCoins size={16} /> Tandai Cair ({pilih.size})
          </button>
        )}
        <TombolEkspor path="/api/pencairan" params={{ asOf, from: range.from, to: range.to }} nama="dana-belum-cair" />
      </PageHeader>

      <div className="card mb-4">
        <Field label="Posisi per Tanggal" className="max-w-xs" hint="Menentukan umur dana dan saldo pembandingnya">
          <input type="date" className="input" value={asOf} onChange={(e) => setAsOf(e.target.value)} />
        </Field>
      </div>

      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard
          label="Belum Cair" value={rupiah(r.nilai)}
          sub={`${r.orders} order`} icon={Hourglass}
          tone={r.nilai > 0 ? 'amber' : 'green'}
        />
        <StatCard
          label="Umur Rata-rata" value={`${r.umurRata} hari`}
          sub={`tertua ${r.umurTertua} hari`} icon={Clock}
        />
        <StatCard
          label="Lebih dari 14 Hari" value={rupiah(r.nilaiPerluDitanya)}
          sub={r.perluDitanya > 0 ? `${r.perluDitanya} order — perlu ditanyakan` : 'tidak ada'}
          icon={AlertTriangle} tone={r.perluDitanya > 0 ? 'red' : 'green'}
        />
        <StatCard
          label="Cair Periode Ini" value={rupiah(r.cairNilai)}
          sub={`${r.cairOrders} order • rata-rata ${r.cairRataHari} hari`}
          icon={CheckCircle2} tone="brand"
        />
      </div>

      <div className="card mb-4">
        <h2 className="card-title mb-2">Cocok dengan Buku Besar</h2>
        <div className="space-y-1 text-sm">
          <div className="flex justify-between gap-3">
            <span className="text-slate-600">Nilai order yang belum cair</span>
            <span className="tabular font-medium text-slate-900">{rupiah(k.nilaiBelumCair)}</span>
          </div>
          <div className="flex justify-between gap-3">
            <span className="text-slate-600">
              Dikurangi iklan yang dibayar potong saldo ({k.iklanJumlah} catatan)
            </span>
            <span className="tabular font-medium text-rose-600">−{rupiah(k.iklanPotongSaldo)}</span>
          </div>
          <div className="flex justify-between gap-3 border-t border-slate-200 pt-1">
            <span className="font-medium text-slate-700">Seharusnya</span>
            <span className="tabular font-semibold text-slate-900">{rupiah(k.seharusnya)}</span>
          </div>
          <div className="flex justify-between gap-3">
            <span className="text-slate-600">Saldo Piutang Marketplace di buku besar</span>
            <span className="tabular font-medium text-slate-900">{rupiah(k.saldoBuku)}</span>
          </div>
        </div>
        <div className={`mt-3 rounded-xl px-3 py-2 text-xs leading-relaxed ${
          k.cocok
            ? 'bg-emerald-50 text-emerald-800 dark:bg-emerald-400/10'
            : 'bg-rose-50 text-rose-800 dark:bg-rose-400/10'
        }`}>
          {k.cocok ? (
            <>
              <strong>Cocok.</strong> Nilai order yang belum cair sama persis dengan saldo piutang di
              pembukuan setelah dikurangi iklan yang dibayar dengan potong saldo — iklan itu memang
              mengurangi dana yang akan ditransfer marketplace tanpa menyentuh satu pun pesanan.
            </>
          ) : (
            <>
              <strong>Selisih {rupiah(Math.abs(k.selisih))}.</strong> Nilai order yang belum cair
              tidak bisa dijelaskan oleh potongan saldo iklan saja.
              {k.sumberLain.length > 0 ? (
                <>
                  {' '}Ada jurnal dari sumber lain yang menyentuh akun ini:{' '}
                  {k.sumberLain.map((s) => `${s.sumber} (${rupiah(s.net)})`).join(', ')}.
                </>
              ) : (
                <> Kemungkinan ada order yang jurnalnya tidak terbentuk seperti seharusnya.</>
              )}
            </>
          )}
        </div>
      </div>

      {data.takSejalan.length > 0 && (
        <div className="card mb-4 border-2 border-amber-200 bg-amber-50/60 dark:bg-amber-400/10">
          <div className="flex items-start gap-2">
            <AlertTriangle size={17} className="mt-0.5 shrink-0 text-amber-600" />
            <div className="text-sm text-slate-700">
              <p className="font-semibold text-slate-900">
                {data.takSejalan.length} order status bayar dan tanggal cairnya tidak sejalan
              </p>
              <p className="mt-1 text-xs leading-relaxed">
                Order yang sudah lunas semestinya punya tanggal cair, dan yang belum lunas semestinya
                belum punya. Ini tidak merusak pembukuan — yang dipakai jurnal adalah status
                bayarnya — tetapi membuat laporan umur dana keliru.
              </p>
              <div className="mt-2 flex flex-wrap gap-2">
                {data.takSejalan.slice(0, 8).map((o) => (
                  <span key={o.id} className="rounded-lg bg-surface px-2 py-1 text-xs ring-1 ring-amber-200">
                    {o.order_ref || o.order_no} — {o.payment_status}
                    {o.payout_date ? ` / cair ${dateID(o.payout_date)}` : ' / tanpa tanggal cair'}
                  </span>
                ))}
                {data.takSejalan.length > 8 && (
                  <span className="px-2 py-1 text-xs text-slate-500">
                    dan {data.takSejalan.length - 8} lainnya
                  </span>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      <div className="card mb-4">
        <h2 className="card-title mb-3">Umur Dana yang Ditahan</h2>
        <div className="flex flex-wrap gap-2">
          <button
            className={`rounded-lg px-3 py-1.5 text-xs font-medium ring-1 ${
              ember ? 'bg-surface text-slate-600 ring-slate-200' : 'bg-slate-900 text-white ring-slate-900'
            }`}
            onClick={() => setEmber('')}
          >
            Semua ({data.rows.length})
          </button>
          {data.perEmber.filter((e) => e.orders > 0).map((e) => (
            <button
              key={e.kunci}
              onClick={() => setEmber(ember === e.kunci ? '' : e.kunci)}
              className={`rounded-lg px-3 py-1.5 text-xs font-medium ring-1 ${NADA_EMBER[e.kunci]} ${
                ember === e.kunci ? 'ring-2' : ''
              }`}
            >
              {e.label} — {e.orders} order · {rupiah(e.nilai)}
            </button>
          ))}
        </div>
        <p className="mt-2 text-xs text-slate-500">
          Marketplace umumnya mencairkan dalam 7–14 hari setelah barang diterima. Yang melewati itu
          belum tentu bermasalah, tetapi layak ditanyakan.
        </p>
      </div>

      <div className="card mb-4">
        <h2 className="card-title mb-3">Per Toko</h2>
        {data.perToko.length === 0 ? (
          <EmptyState message="Tidak ada dana yang tertahan" />
        ) : (
          <div className="overflow-x-auto">
            <table className="table">
              <thead>
                <tr>
                  <th>Toko</th>
                  <th className="text-center">Order</th>
                  <th className="text-right">Akan Diterima</th>
                  <th className="text-center">Tertua</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {data.perToko.map((t) => (
                  <tr key={t.shop_id ?? 'lepas'}>
                    <td>
                      <p className="font-medium text-slate-900">{t.nama}</p>
                      <p className="text-xs text-slate-500">{t.channelLabel}</p>
                    </td>
                    <td className="tabular text-center">{t.orders}</td>
                    <td className="tabular text-right font-semibold">{rupiah(t.nilai)}</td>
                    <td className={`tabular text-center ${t.perluDitanya ? 'font-semibold text-amber-600' : ''}`}>
                      {t.umur_tertua} hari
                    </td>
                    <td className="text-right">
                      <button
                        className="btn-ghost !px-2 !py-1 text-xs"
                        onClick={() => setToko(toko === String(t.shop_id) ? '' : String(t.shop_id))}
                      >
                        {toko === String(t.shop_id) ? 'Tampilkan semua' : 'Lihat order'}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="card">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <h2 className="card-title">
            {tampil.length} order belum cair
            {pilih.size > 0 && ` — ${pilih.size} dipilih (${rupiah(nilaiPilih)})`}
          </h2>
          {(ember || toko) && (
            <button className="btn-ghost text-xs" onClick={() => { setEmber(''); setToko(''); }}>
              Hapus saringan
            </button>
          )}
        </div>

        {tampil.length === 0 ? (
          <EmptyState message="Tidak ada order yang cocok" />
        ) : (
          <div className="overflow-x-auto">
            <table className="table">
              <thead>
                <tr>
                  {bolehTandai && (
                    <th className="w-8">
                      <input type="checkbox" checked={semuaTerpilih} onChange={toggleSemua} />
                    </th>
                  )}
                  <th>Order</th>
                  <th>Toko</th>
                  <th>Status</th>
                  <th className="text-center">Umur</th>
                  <th className="text-right">Pendapatan</th>
                  <th className="text-right">Potongan</th>
                  <th className="text-right">Akan Diterima</th>
                </tr>
              </thead>
              <tbody>
                {tampil.map((o) => (
                  <tr key={o.id}>
                    {bolehTandai && (
                      <td>
                        <input type="checkbox" checked={pilih.has(o.id)} onChange={() => togglePilih(o.id)} />
                      </td>
                    )}
                    <td>
                      <p className="font-medium text-slate-900">{o.order_ref || o.order_no}</p>
                      <p className="text-xs text-slate-500">{dateID(o.order_date)} • {o.buyer_city || '—'}</p>
                    </td>
                    <td className="text-xs text-slate-600">{o.shop_name || '—'}</td>
                    <td className="text-xs text-slate-600">{o.fulfillment_status}</td>
                    <td className="text-center">
                      <span className={`inline-block rounded-md px-2 py-0.5 text-xs ring-1 ${NADA_EMBER[o.ember]}`}>
                        {o.umur_hari} hari
                      </span>
                    </td>
                    <td className="tabular text-right">{rupiah(o.net_revenue)}</td>
                    <td className="tabular text-right text-rose-600">−{rupiah(o.total_fees)}</td>
                    <td className="tabular text-right font-semibold">{rupiah(o.nilai)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <p className="mt-3 text-xs leading-relaxed text-slate-500">
          &quot;Akan diterima&quot; adalah pendapatan dikurangi seluruh potongan marketplace — bukan
          harga jual. Menandai cair memakai jalur yang sama dengan menu Order Penjualan, sehingga
          jurnalnya ikut berpindah dari Piutang Marketplace ke bank.
        </p>
      </div>

      <div className="card mt-4">
        <h2 className="card-title mb-2">Ringkasan Pencairan per Periode</h2>
        <DateRangeFilter range={range} onChange={setRange}>
        <div className="flex-[2]">
          <label className="label">Cari</label>
          <KotakCari nilai={q} onCari={setQ} placeholder="No. pesanan, no. order, toko, kota..." />
        </div>
      </DateRangeFilter>
        <p className="mt-2 text-sm text-slate-700">
          Pada {dateID(data.from)} – {dateID(data.to)}, <strong>{r.cairOrders} order</strong> cair
          senilai <strong>{rupiah(r.cairNilai)}</strong>, rata-rata{' '}
          <strong>{r.cairRataHari} hari</strong> sejak pesanan dibuat.
        </p>
      </div>

      <Modal open={!!tandai} onClose={() => setTandai(null)} title={`Tandai ${pilih.size} Order Cair`}>
        {tandai && (
          <form onSubmit={jalankanTandai} className="grid gap-3">
            <div className="rounded-xl bg-slate-50 px-3 py-2 text-sm text-slate-700">
              Total yang akan tercatat masuk: <strong>{rupiah(nilaiPilih)}</strong>
            </div>
            <Field label="Tanggal Cair *" hint="Tanggal uangnya benar-benar masuk ke rekening">
              <input type="date" className="input" required value={tandai.tanggal}
                onChange={(e) => setTandai({ ...tandai, tanggal: e.target.value })} />
            </Field>
            <p className="rounded-xl bg-slate-50 px-3 py-2 text-xs text-slate-600">
              Status pesanan menjadi CAIR dan pembayaran menjadi lunas. Jurnal tiap order ditulis
              ulang: Piutang Marketplace berkurang, bank bertambah. Bila ada yang gagal, sisanya
              tetap diproses dan yang gagal dilaporkan.
            </p>
            <div className="flex gap-2">
              <button type="button" className="btn-secondary flex-1" onClick={() => setTandai(null)}>Batal</button>
              <button type="submit" className="btn-primary flex-1" disabled={saving}>
                {saving ? 'Memproses...' : 'Tandai Cair'}
              </button>
            </div>
          </form>
        )}
      </Modal>
    </div>
  );
}
