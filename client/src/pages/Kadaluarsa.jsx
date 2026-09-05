import { useEffect, useState, useCallback } from 'react';
import { CalendarClock, AlertTriangle, CircleHelp, ShieldCheck } from 'lucide-react';
import { api } from '../lib/api';
import { PageHeader, Spinner, EmptyState, StatCard, useToast, Field, TombolEkspor } from '../components/ui';
import { rupiah, dateID, num } from '../lib/format';

const WARNA = {
  KEDALUWARSA: 'badge-red',
  MENDEKATI: 'badge-amber',
  TANPA_TANGGAL: 'badge-slate',
  AMAN: 'badge-green',
};

const LABEL = {
  KEDALUWARSA: 'Kedaluwarsa',
  MENDEKATI: 'Mendekati',
  TANPA_TANGGAL: 'Belum ada tanggal',
  AMAN: 'Aman',
};

/**
 * Pemantauan batch menjelang kadaluarsa.
 *
 * Diurutkan dari yang paling mendesak, bukan per produk. Yang dicari orang di
 * halaman ini adalah "apa yang harus saya kerjakan minggu ini" — dan itu
 * pertanyaan tentang waktu, bukan tentang barang.
 */
export default function Kadaluarsa() {
  const toast = useToast();
  const [hari, setHari] = useState(90);
  const [saring, setSaring] = useState('SEMUA');
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setData(await api.get(`/api/inventory/kadaluarsa?hari=${hari}`));
    } catch (err) {
      toast.error(err.message);
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hari]);

  useEffect(() => { load(); }, [load]);

  if (loading && !data) return <Spinner label="Memuat data kadaluarsa..." />;

  const r = data?.ringkas;
  const baris = (data?.rows || []).filter((b) => saring === 'SEMUA' || b.status === saring);

  return (
    <div>
      <PageHeader
        title="Batch & Kadaluarsa"
        subtitle="Barang yang perlu didahulukan sebelum masa aktifnya habis"
      >
        <TombolEkspor path={`/api/inventory/kadaluarsa?hari=${hari}`} nama="batch-kadaluarsa" />
      </PageHeader>

      <div className="mb-4 flex flex-wrap items-end gap-3">
        <Field label="Ambang Peringatan" hint="Batch dianggap mendesak bila tersisa kurang dari ini" className="w-52">
          <select className="input" value={hari} onChange={(e) => setHari(Number(e.target.value))}>
            <option value={30}>30 hari</option>
            <option value={60}>60 hari</option>
            <option value={90}>90 hari</option>
            <option value={180}>180 hari</option>
          </select>
        </Field>
        <Field label="Tampilkan" className="w-52">
          <select className="input" value={saring} onChange={(e) => setSaring(e.target.value)}>
            <option value="SEMUA">Semua batch</option>
            <option value="KEDALUWARSA">Sudah kedaluwarsa</option>
            <option value="MENDEKATI">Mendekati kadaluarsa</option>
            <option value="TANPA_TANGGAL">Belum ada tanggal</option>
            <option value="AMAN">Masih aman</option>
          </select>
        </Field>
      </div>

      <div className="mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          label="Sudah Kedaluwarsa" value={rupiah(r?.kedaluwarsa.nilai || 0)}
          sub={`${r?.kedaluwarsa.batch || 0} batch — tidak boleh dijual`}
          icon={AlertTriangle} tone={r?.kedaluwarsa.batch ? 'red' : 'slate'}
        />
        <StatCard
          label={`Mendekati (${data?.ambangHari} hari)`} value={rupiah(r?.mendekati.nilai || 0)}
          sub={`${r?.mendekati.batch || 0} batch — dahulukan menjualnya`}
          icon={CalendarClock} tone={r?.mendekati.batch ? 'amber' : 'slate'}
        />
        <StatCard
          label="Belum Ada Tanggal" value={rupiah(r?.tanpaTanggal.nilai || 0)}
          sub={`${r?.tanpaTanggal.batch || 0} batch — lengkapi datanya`}
          icon={CircleHelp} tone="slate"
        />
        <StatCard
          label="Masih Aman" value={rupiah(r?.aman.nilai || 0)}
          sub={`${r?.aman.batch || 0} batch`}
          icon={ShieldCheck} tone="green"
        />
      </div>

      <div className="card">
        {!baris.length ? (
          <EmptyState
            title="Tidak ada batch pada tampilan ini"
            subtitle="Batch terbentuk saat barang masuk dicatat beserta kode batch-nya, pada produk yang pelacakan batch-nya dinyalakan."
          />
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>SKU</th>
                  <th>Produk</th>
                  <th>Kode Batch</th>
                  <th>Kadaluarsa</th>
                  <th className="text-right">Sisa Hari</th>
                  <th className="text-right">Sisa</th>
                  <th className="text-right">Nilai</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {baris.map((b) => (
                  <tr key={b.id}>
                    <td className="tabular whitespace-nowrap">{b.sku}</td>
                    <td>{b.product_name}</td>
                    <td className="font-medium">{b.kode}</td>
                    <td className="tabular whitespace-nowrap">
                      {b.tanggal_kadaluarsa ? dateID(b.tanggal_kadaluarsa) : '—'}
                    </td>
                    <td className={`tabular text-right ${
                      b.sisa_hari === null ? 'text-slate-400'
                        : b.sisa_hari < 0 ? 'font-semibold text-rose-700'
                          : b.sisa_hari <= 30 ? 'font-medium text-rose-600'
                            : b.sisa_hari <= data.ambangHari ? 'font-medium text-amber-600' : ''
                    }`}>
                      {b.sisa_hari === null ? '—' : num(b.sisa_hari)}
                    </td>
                    <td className="tabular text-right">{num(b.qty_sisa)} {b.unit}</td>
                    <td className="tabular text-right font-medium">{rupiah(b.nilai)}</td>
                    <td><span className={WARNA[b.status]}>{LABEL[b.status]}</span></td>
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
