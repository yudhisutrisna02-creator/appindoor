import { useEffect, useState, useCallback } from 'react';
import { Users, Repeat, MoonStar, MapPin, Info } from 'lucide-react';
import { api } from '../lib/api';
import { PageHeader, Spinner, EmptyState, StatCard, useToast, Field, TombolEkspor } from '../components/ui';
import { rupiah, num, pct, dateID, CHANNEL_LABEL } from '../lib/format';

const WARNA = {
  BERULANG: 'badge-green',
  BARU: 'badge-blue',
  TIDUR: 'badge-amber',
  HILANG: 'badge-red',
};

const LABEL = {
  BERULANG: 'Berulang',
  BARU: 'Baru',
  TIDUR: 'Tidur',
  HILANG: 'Hilang',
};

/**
 * Analisis pelanggan.
 *
 * Tampilan bawaannya adalah pelanggan yang TIDUR — pernah beli lalu berhenti.
 * Merekalah satu-satunya kelompok di halaman ini yang bisa langsung ditindak
 * hari itu juga, dan mereka tidak muncul di laporan penjualan mana pun karena
 * justru tidak sedang bertransaksi.
 */
export default function Pelanggan() {
  const toast = useToast();
  const [param, setParam] = useState({ aktif: 60, hilang: 180 });
  const [saring, setSaring] = useState('TIDUR');
  const [cari, setCari] = useState('');
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);

  const kueri = `aktif=${param.aktif}&hilang=${param.hilang}`;

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setData(await api.get(`/api/pelanggan?${kueri}`));
    } catch (err) {
      toast.error(err.message);
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kueri]);

  useEffect(() => { load(); }, [load]);

  if (loading && !data) return <Spinner label="Menghitung analisis pelanggan..." />;

  const r = data?.ringkas;
  const q = cari.trim().toLowerCase();
  const baris = (data?.rows || []).filter((x) => {
    if (saring === 'BERULANG' && !x.berulang) return false;
    if (['BARU', 'TIDUR', 'HILANG'].includes(saring) && x.status !== saring) return false;
    if (q && !`${x.nama} ${x.kota || ''}`.toLowerCase().includes(q)) return false;
    return true;
  });

  return (
    <div>
      <PageHeader
        title="Analisis Pelanggan"
        subtitle="Siapa yang membeli berulang, dan siapa yang berhenti membeli"
      >
        <TombolEkspor path={`/api/pelanggan?${kueri}`} nama="analisis-pelanggan" />
      </PageHeader>

      <div className="mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          label="Pelanggan Teridentifikasi" value={num(r?.pelanggan || 0)}
          sub={`rata-rata ${num(r?.rataOrderPerPelanggan || 0, 2)} order per orang`}
          icon={Users}
        />
        <StatCard
          label="Pernah Beli Berulang" value={`${num(r?.berulang.pelanggan || 0)} orang`}
          sub={`${pct(r?.berulang.persen || 0)} dari seluruh pelanggan • ${rupiah(r?.berulang.omzet || 0)}`}
          icon={Repeat} tone="green"
        />
        <StatCard
          label="Tidur — Perlu Disapa" value={`${num(r?.tidur.pelanggan || 0)} orang`}
          sub={`${r?.tidur.berulang || 0} di antaranya pelanggan berulang • ${rupiah(r?.tidur.omzet || 0)}`}
          icon={MoonStar} tone={r?.tidur.pelanggan ? 'amber' : 'slate'}
        />
        <StatCard
          label="Nilai Rata-rata Pelanggan" value={rupiah(r?.nilaiRataPelanggan || 0)}
          sub={`sepanjang riwayatnya • total ${rupiah(r?.omzetTotal || 0)}`}
          icon={Users} tone="brand"
        />
      </div>

      <div className="card mb-4 flex items-start gap-2.5">
        <Info size={17} className="mt-0.5 shrink-0 text-amber-600" />
        <p className="text-xs leading-relaxed text-slate-600">
          Pembeli dikenali dari <strong>namanya</strong>, karena nomor HP hampir tidak pernah
          terisi pada order marketplace. Artinya orang yang sama dengan nama tertulis berbeda
          (&ldquo;Budi S&rdquo; dan &ldquo;Budi Santoso&rdquo;) terhitung dua orang, dan dua orang
          bernama sama terhitung satu. Angkanya <strong>petunjuk arah, bukan hitungan mutlak</strong>.
          {r?.tanpaIdentitas > 0 && (
            <> Ada <strong>{num(r.tanpaIdentitas)} order</strong> tanpa nama pembeli sama sekali,
            jadi tidak ikut terhitung.</>
          )}
        </p>
      </div>

      <div className="mb-4 flex flex-wrap items-end gap-3">
        <Field label="Tampilkan" className="w-56">
          <select className="input" value={saring} onChange={(e) => setSaring(e.target.value)}>
            <option value="TIDUR">Tidur — perlu disapa</option>
            <option value="BERULANG">Pelanggan berulang</option>
            <option value="BARU">Baru / aktif</option>
            <option value="HILANG">Sudah lama hilang</option>
            <option value="SEMUA">Semua pelanggan</option>
          </select>
        </Field>
        <Field label="Masih Aktif Bila Beli Dalam" className="w-44">
          <select className="input" value={param.aktif}
            onChange={(e) => setParam({ ...param, aktif: Number(e.target.value) })}>
            <option value={30}>30 hari</option>
            <option value={60}>60 hari</option>
            <option value={90}>90 hari</option>
          </select>
        </Field>
        <Field label="Dianggap Hilang Di Atas" className="w-44">
          <select className="input" value={param.hilang}
            onChange={(e) => setParam({ ...param, hilang: Number(e.target.value) })}>
            <option value={120}>120 hari</option>
            <option value={180}>180 hari</option>
            <option value={365}>365 hari</option>
          </select>
        </Field>
        <Field label="Cari Nama / Wilayah" className="flex-1 min-w-56">
          <input className="input" placeholder="ketik nama atau kota"
            value={cari} onChange={(e) => setCari(e.target.value)} />
        </Field>
      </div>

      <div className="card mb-4">
        <h2 className="card-title mb-3">
          {saring === 'TIDUR' ? 'Pelanggan yang Berhenti Membeli' : 'Daftar Pelanggan'}
          <span className="ml-2 text-xs font-normal text-slate-500">{num(baris.length)} orang</span>
        </h2>

        {!baris.length ? (
          <EmptyState
            title={saring === 'TIDUR' ? 'Tidak ada pelanggan yang tidur' : 'Tidak ada pelanggan pada tampilan ini'}
            subtitle={saring === 'TIDUR'
              ? 'Semua pelanggan yang pernah membeli masih aktif pada rentang ini.'
              : 'Coba ubah penyaring atau kata pencariannya.'}
          />
        ) : (
          <div className="table-wrap max-h-[32rem] overflow-y-auto">
            <table className="table">
              <thead>
                <tr>
                  <th>Nama Pembeli</th>
                  <th>Wilayah</th>
                  <th>Kanal</th>
                  <th className="text-right">Order</th>
                  <th className="text-right">Total Omzet</th>
                  <th className="text-right">Rata/Order</th>
                  <th className="text-right">Terakhir Beli</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {baris.slice(0, 400).map((x) => (
                  <tr key={x.kunci}>
                    <td className="font-medium">{x.nama || '—'}</td>
                    <td className="text-xs text-slate-500">{x.kota || '—'}</td>
                    <td className="text-xs text-slate-500">{CHANNEL_LABEL[x.channel] || x.channel}</td>
                    <td className="tabular text-right">{num(x.orders)}</td>
                    <td className="tabular text-right font-medium">{rupiah(x.omzet)}</td>
                    <td className="tabular text-right text-slate-500">{rupiah(x.rataOrder)}</td>
                    <td className="tabular whitespace-nowrap text-right">
                      <span className="block">{dateID(x.terakhir)}</span>
                      <span className={`block text-[11px] ${
                        x.hariSejakTerakhir > param.hilang ? 'text-rose-600'
                          : x.hariSejakTerakhir > param.aktif ? 'text-amber-600' : 'text-slate-400'
                      }`}>
                        {num(x.hariSejakTerakhir)} hari lalu
                      </span>
                    </td>
                    <td><span className={WARNA[x.status]}>{LABEL[x.status]}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
            {baris.length > 400 && (
              <p className="px-3 py-2 text-xs text-slate-500">
                Menampilkan 400 teratas dari {num(baris.length)} — unduh berkasnya untuk daftar lengkap.
              </p>
            )}
          </div>
        )}
      </div>

      <div className="card">
        <h2 className="card-title mb-1 flex items-center gap-2">
          <MapPin size={16} /> Sebaran Wilayah
        </h2>
        <p className="mb-3 text-xs text-slate-500">
          Ditampilkan apa adanya sesuai yang diketik tim — sebagian provinsi, sebagian kota.
          Tidak digabungkan sendiri, karena menebak wilayah berarti mengarang data yang tidak pernah dimasukkan.
        </p>
        <div className="table-wrap max-h-80 overflow-y-auto">
          <table className="table text-sm">
            <thead>
              <tr>
                <th>Wilayah</th>
                <th className="text-right">Pelanggan</th>
                <th className="text-right">Berulang</th>
                <th className="text-right">Order</th>
                <th className="text-right">Omzet</th>
              </tr>
            </thead>
            <tbody>
              {(data?.wilayah || []).slice(0, 40).map((w) => (
                <tr key={w.wilayah}>
                  <td className="font-medium">{w.wilayah}</td>
                  <td className="tabular text-right">{num(w.pelanggan)}</td>
                  <td className="tabular text-right text-emerald-700">{num(w.berulang)}</td>
                  <td className="tabular text-right">{num(w.orders)}</td>
                  <td className="tabular text-right font-medium">{rupiah(w.omzet)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
