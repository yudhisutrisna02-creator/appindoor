import { useEffect, useState, useCallback } from 'react';
import { Users, Repeat, MoonStar, MapPin, Info, Truck, Settings2, X } from 'lucide-react';
import { api } from '../lib/api';
import { PageHeader, Spinner, EmptyState, StatCard, useToast, Field, Modal, TombolEkspor } from '../components/ui';
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
  const [hubForm, setHubForm] = useState(null);
  const [hubBaru, setHubBaru] = useState('');
  const [simpanHub, setSimpanHub] = useState(false);

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

  async function simpanKataHub() {
    setSimpanHub(true);
    try {
      const res = await api.put('/api/pelanggan/hub', { kata: hubForm });
      toast.success(res.message);
      setHubForm(null);
      setHubBaru('');
      load();
    } catch (err) {
      toast.error(err.message);
    } finally {
      setSimpanHub(false);
    }
  }

  function tambahKata() {
    const k = hubBaru.trim();
    if (k.length < 2) return toast.error('Kata penanda minimal 2 huruf');
    if (hubForm.some((x) => x.toLowerCase() === k.toLowerCase())) return toast.error(`"${k}" sudah ada`);
    setHubForm([...hubForm, k]);
    setHubBaru('');
  }

  if (loading && !data) return <Spinner label="Menghitung analisis pelanggan..." />;

  const r = data?.ringkas;
  const hub = data?.hubInternal;
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

      {hub && (
        <div className="card mb-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="flex items-start gap-2.5">
              <Truck size={17} className="mt-0.5 shrink-0 text-slate-500" />
              <div>
                <h2 className="card-title mb-1">Titik Kirim Internal — Tidak Dihitung Pelanggan</h2>
                <p className="text-xs leading-relaxed text-slate-600">
                  {hub.jumlah > 0 ? (
                    <>
                      <strong>{num(hub.jumlah)} nama</strong> dengan{' '}
                      <strong>{num(hub.orders)} order</strong> senilai{' '}
                      <strong>{rupiah(hub.omzet)}</strong> dikecualikan dari seluruh angka di
                      halaman ini. Ini hub sortir marketplace, bukan orang yang membeli — satu hub
                      bisa muncul ratusan kali dan membuat angka pelanggan berulang tampak jauh
                      lebih besar daripada kenyataannya.
                    </>
                  ) : (
                    <>Tidak ada nama pembeli yang cocok dengan penanda titik kirim internal saat ini.</>
                  )}
                </p>
                <p className="mt-1.5 text-xs text-slate-500">
                  Penanda:{' '}
                  {hub.kata.length
                    ? hub.kata.map((k) => (
                        <span key={k} className="mr-1 rounded bg-slate-100 px-1.5 py-0.5 font-mono text-[11px]">{k}</span>
                      ))
                    : <em>tidak ada</em>}
                </p>
              </div>
            </div>
            <button type="button" className="btn-secondary shrink-0"
              onClick={() => { setHubForm([...hub.kata]); setHubBaru(''); }}>
              <Settings2 size={15} /> Atur Penanda
            </button>
          </div>

          {hub.daftar.length > 0 && (
            <div className="table-wrap mt-3 max-h-56 overflow-y-auto">
              <table className="table text-sm">
                <thead>
                  <tr>
                    <th>Nama yang Dikecualikan</th>
                    <th>Wilayah</th>
                    <th className="text-right">Order</th>
                    <th className="text-right">Omzet</th>
                  </tr>
                </thead>
                <tbody>
                  {hub.daftar.map((x) => (
                    <tr key={x.kunci}>
                      <td className="font-medium">{x.nama}</td>
                      <td className="text-xs text-slate-500">{x.kota || '—'}</td>
                      <td className="tabular text-right">{num(x.orders)}</td>
                      <td className="tabular text-right font-medium">{rupiah(x.omzet)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

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

      <Modal open={!!hubForm} onClose={() => setHubForm(null)} title="Penanda Titik Kirim Internal">
        {hubForm && (
          <div className="grid gap-3">
            <p className="text-xs leading-relaxed text-slate-600">
              Nama pembeli yang memuat salah satu kata di bawah ini dianggap titik kirim
              marketplace, bukan pelanggan. Dicocokkan sebagai <strong>kata utuh</strong> dan tidak
              membedakan huruf besar-kecil — jadi <span className="font-mono">RDC</span> mengenai
              &ldquo;Semarang RDC - Pengiriman SPX&rdquo; tetapi tidak mengenai &ldquo;Firdaus&rdquo;.
            </p>

            <div className="flex flex-wrap gap-1.5">
              {hubForm.length ? hubForm.map((k) => (
                <span key={k} className="flex items-center gap-1 rounded-lg bg-slate-100 py-1 pl-2.5 pr-1 text-sm">
                  <span className="font-mono text-xs">{k}</span>
                  <button type="button" aria-label={`Hapus ${k}`}
                    className="rounded p-0.5 text-slate-400 hover:bg-rose-50 hover:text-rose-600"
                    onClick={() => setHubForm(hubForm.filter((x) => x !== k))}>
                    <X size={13} />
                  </button>
                </span>
              )) : (
                <p className="text-sm text-slate-500">
                  Kosong — seluruh nama akan dihitung sebagai pelanggan.
                </p>
              )}
            </div>

            <Field label="Tambah Penanda" hint="minimal 2 huruf, mis. RDC / SPX / SORTIR">
              <div className="flex gap-2">
                <input className="input flex-1" maxLength={40} value={hubBaru}
                  onChange={(e) => setHubBaru(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); tambahKata(); } }} />
                <button type="button" className="btn-secondary" onClick={tambahKata}>Tambah</button>
              </div>
            </Field>

            <div className="flex gap-2">
              <button type="button" className="btn-secondary flex-1" onClick={() => setHubForm(null)}>
                Batal
              </button>
              <button type="button" className="btn-primary flex-1" disabled={simpanHub}
                onClick={simpanKataHub}>
                {simpanHub ? 'Menyimpan...' : 'Simpan'}
              </button>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}
