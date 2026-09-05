import { useEffect, useState, useCallback } from 'react';
import { ShoppingBasket, AlertTriangle, Clock, PackageX, Info } from 'lucide-react';
import { api } from '../lib/api';
import { PageHeader, Spinner, EmptyState, StatCard, useToast, Field, TombolEkspor } from '../components/ui';
import { rupiah, num } from '../lib/format';

const WARNA = {
  HABIS: 'badge-red',
  MENDESAK: 'badge-red',
  SEGERA: 'badge-amber',
  AMAN: 'badge-green',
  DIAM: 'badge-slate',
  TIDAK_LAKU: 'badge-slate',
};

const LABEL = {
  HABIS: 'Habis',
  MENDESAK: 'Mendesak',
  SEGERA: 'Segera',
  AMAN: 'Aman',
  DIAM: 'Diam',
  TIDAK_LAKU: 'Tidak laku',
};

/**
 * Saran pembelian.
 *
 * Yang dicari orang di halaman ini bukan "berapa stok saya" — itu sudah ada di
 * Valuasi Stok. Yang dicari adalah "minggu ini saya harus pesan apa". Karena
 * itu tampilan bawaannya langsung menyaring ke yang perlu ditindak, dan yang
 * aman disembunyikan sampai diminta.
 */
export default function SaranBeli() {
  const toast = useToast();
  const [param, setParam] = useState({ hari: 60, penyangga: 14, cakupan: 45 });
  const [saring, setSaring] = useState('PERLU');
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);

  const kueri = `hari=${param.hari}&penyangga=${param.penyangga}&cakupan=${param.cakupan}`;

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setData(await api.get(`/api/saran-beli?${kueri}`));
    } catch (err) {
      toast.error(err.message);
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kueri]);

  useEffect(() => { load(); }, [load]);

  if (loading && !data) return <Spinner label="Menghitung saran pembelian..." />;

  const r = data?.ringkas;
  const semua = data?.rows || [];
  const baris = semua.filter((x) => {
    if (saring === 'PERLU') return x.saranQty > 0;
    if (saring === 'DIAM') return x.status === 'DIAM';
    if (saring === 'SEMUA') return true;
    return x.status === saring;
  });

  return (
    <div>
      <PageHeader
        title="Saran Pembelian"
        subtitle="Beli apa, berapa, kapan — dihitung dari kecepatan jual dan lama kirim supplier"
      >
        <TombolEkspor path={`/api/saran-beli?${kueri}`} nama="saran-pembelian" />
      </PageHeader>

      <div className="mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          label="Perlu Dipesan" value={rupiah(r?.totalSaran || 0)}
          sub={`${r?.produkDisarankan || 0} produk`}
          icon={ShoppingBasket} tone={r?.produkDisarankan ? 'amber' : 'green'}
        />
        <StatCard
          label="Stok Habis" value={`${r?.habis.produk || 0} produk`}
          sub={r?.habis.produk ? `perlu ${rupiah(r.habis.nilai)}` : 'tidak ada yang habis'}
          icon={AlertTriangle} tone={r?.habis.produk ? 'red' : 'slate'}
        />
        <StatCard
          label="Mendesak" value={`${r?.mendesak.produk || 0} produk`}
          sub="habis sebelum barang pengganti datang"
          icon={Clock} tone={r?.mendesak.produk ? 'red' : 'slate'}
        />
        <StatCard
          label="Modal Mengendap" value={rupiah(r?.diam.nilai || 0)}
          sub={`${r?.diam.produk || 0} produk tanpa penjualan — jangan dibeli lagi`}
          icon={PackageX} tone={r?.diam.produk ? 'amber' : 'slate'}
        />
      </div>

      <div className="card mb-4 flex items-start gap-2.5">
        <Info size={17} className="mt-0.5 shrink-0 text-brand-600" />
        <p className="text-xs leading-relaxed text-slate-600">
          Dihitung dari penjualan <strong>{data?.parameter.dari} s/d {data?.parameter.sampai}</strong>.
          Barang yang <strong>sudah dipesan tapi belum datang</strong> ikut diperhitungkan, jadi
          sarannya tidak menyuruh memesan dua kali. Produk tanpa penjualan sama sekali
          <strong> tidak pernah disarankan dibeli</strong> — ia justru dilaporkan sebagai modal yang mengendap.
        </p>
      </div>

      <div className="mb-4 flex flex-wrap items-end gap-3">
        <Field label="Tampilkan" className="w-52">
          <select className="input" value={saring} onChange={(e) => setSaring(e.target.value)}>
            <option value="PERLU">Yang perlu dipesan</option>
            <option value="HABIS">Stok habis</option>
            <option value="MENDESAK">Mendesak</option>
            <option value="SEGERA">Segera</option>
            <option value="DIAM">Modal mengendap</option>
            <option value="SEMUA">Semua produk</option>
          </select>
        </Field>
        <Field label="Pengamatan Penjualan" hint="Makin panjang, makin tenang terhadap lonjakan sesaat" className="w-44">
          <select className="input" value={param.hari}
            onChange={(e) => setParam({ ...param, hari: Number(e.target.value) })}>
            <option value={30}>30 hari</option>
            <option value={60}>60 hari</option>
            <option value={90}>90 hari</option>
            <option value={180}>180 hari</option>
          </select>
        </Field>
        <Field label="Penyangga" hint="Cadangan hari untuk jaga-jaga" className="w-40">
          <select className="input" value={param.penyangga}
            onChange={(e) => setParam({ ...param, penyangga: Number(e.target.value) })}>
            <option value={0}>Tanpa penyangga</option>
            <option value={7}>7 hari</option>
            <option value={14}>14 hari</option>
            <option value={30}>30 hari</option>
          </select>
        </Field>
        <Field label="Cakupan Sekali Beli" hint="Berapa hari ke depan yang ingin ditutupi" className="w-44">
          <select className="input" value={param.cakupan}
            onChange={(e) => setParam({ ...param, cakupan: Number(e.target.value) })}>
            <option value={15}>15 hari</option>
            <option value={30}>30 hari</option>
            <option value={45}>45 hari</option>
            <option value={90}>90 hari</option>
          </select>
        </Field>
      </div>

      <div className="card">
        {!baris.length ? (
          <EmptyState
            title={saring === 'PERLU' ? 'Tidak ada yang perlu dipesan' : 'Tidak ada produk pada tampilan ini'}
            subtitle={saring === 'PERLU'
              ? 'Semua produk yang laku masih punya stok cukup sampai barang pengganti datang.'
              : 'Coba ubah penyaringnya.'}
          />
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>SKU</th>
                  <th>Produk</th>
                  <th>Supplier</th>
                  <th className="text-right">Stok</th>
                  <th className="text-right">Di Jalan</th>
                  <th className="text-right">Jual/Hari</th>
                  <th className="text-right">Sisa Hari</th>
                  <th className="text-right">Kirim</th>
                  <th className="text-right">Saran Beli</th>
                  <th className="text-right">Nilai</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {baris.map((x) => (
                  <tr key={x.id}>
                    <td className="tabular whitespace-nowrap">{x.sku}</td>
                    <td>{x.name}</td>
                    <td className="text-xs text-slate-500">{x.supplier_name || '—'}</td>
                    <td className="tabular text-right">{num(x.stok)} {x.unit}</td>
                    <td className="tabular text-right text-slate-500">
                      {x.diJalan > 0 ? num(x.diJalan) : '—'}
                    </td>
                    <td className="tabular text-right">{num(x.perHari, 2)}</td>
                    <td className={`tabular text-right ${
                      x.hariTersisa === null ? 'text-slate-400'
                        : x.hariTersisa <= x.leadTime ? 'font-semibold text-rose-700'
                          : x.hariTersisa <= x.leadTime + param.penyangga ? 'font-medium text-amber-600' : ''
                    }`}>
                      {x.hariTersisa === null ? '—' : `${num(x.hariTersisa)} hr`}
                    </td>
                    <td className="tabular text-right text-xs text-slate-500">
                      {num(x.leadTime)} hr
                      {!x.leadDariRiwayat && <span className="ml-0.5 text-slate-400">*</span>}
                    </td>
                    <td className="tabular text-right font-bold text-slate-900">
                      {x.saranQty > 0 ? `${num(x.saranQty)} ${x.unit}` : '—'}
                    </td>
                    <td className="tabular text-right font-medium">
                      {x.saranQty > 0 ? rupiah(x.nilaiSaran)
                        : x.status === 'DIAM' ? <span className="text-slate-400">{rupiah(x.nilaiDiam)} diam</span>
                          : '—'}
                    </td>
                    <td><span className={WARNA[x.status]}>{LABEL[x.status]}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <p className="mt-3 text-[11px] text-slate-500">
          * Lama kirim memakai rata-rata seluruh supplier karena supplier ini belum punya
          riwayat penerimaan sendiri. Angkanya menajam sendiri seiring pembelian tercatat.
        </p>
      </div>
    </div>
  );
}
