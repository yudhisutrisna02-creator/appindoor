import { useEffect, useState, useCallback, useMemo } from 'react';
import { ShieldCheck, ShieldAlert, ShieldX, Link2, Copy, AlertTriangle } from 'lucide-react';
import { api } from '../lib/api';
import {
  PageHeader, StatCard, Spinner, EmptyState,
  useToast, TombolEkspor,
} from '../components/ui';
import { rupiah, rupiahShort } from '../lib/format';
import { useAuth } from '../lib/auth';

const STATUS = {
  sah: { label: 'Sesuai', kelas: 'bg-emerald-50 text-emerald-700 ring-emerald-200 dark:bg-emerald-400/10', ikon: ShieldCheck },
  berubah: { label: 'Data sudah berubah', kelas: 'bg-amber-50 text-amber-700 ring-amber-200 dark:bg-amber-400/10', ikon: ShieldAlert },
  dicabut: { label: 'Tautan dicabut', kelas: 'bg-slate-100 text-slate-600 ring-slate-200', ikon: ShieldX },
  hilang: { label: 'Sumber hilang', kelas: 'bg-rose-50 text-rose-700 ring-rose-200 dark:bg-rose-400/10', ikon: ShieldX },
};

/**
 * Dokumen yang pernah dikeluarkan bertanda tangan digital.
 *
 * Tautan pemeriksaan bisa dibuka siapa pun yang memegangnya — sama seperti
 * kertasnya. Layar ini yang menyediakan tempat mencabutnya bila tautan itu
 * tersebar ke tangan yang salah, sekaligus menunjukkan dokumen apa saja yang
 * sudah beredar di luar.
 */
export default function DokumenTerbit() {
  const toast = useToast();
  const { punya } = useAuth();
  const bolehKelola = punya('sistem.dokumen');

  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saring, setSaring] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setData(await api.get('/api/dokumen'));
    } catch (err) {
      toast.error(err.message);
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => { load(); }, [load]);

  const tampil = useMemo(
    () => (data ? data.rows.filter((r) => !saring || r.status === saring) : []),
    [data, saring]
  );

  async function ubahTautan(r, aksi) {
    const kalimat = aksi === 'cabut'
      ? `Cabut tautan ${r.nomor}? QR yang sudah tercetak tidak akan bisa dibuka lagi.`
      : `Aktifkan kembali tautan ${r.nomor}? QR yang sudah tercetak akan berlaku lagi.`;
    if (!window.confirm(kalimat)) return;
    try {
      const res = await api.patch(`/api/dokumen/${r.id}/${aksi === 'cabut' ? 'cabut' : 'aktifkan'}`);
      toast.success(res.message);
      load();
    } catch (err) {
      toast.error(err.message);
    }
  }

  async function salin(tautan) {
    try {
      await navigator.clipboard.writeText(tautan);
      toast.success('Tautan disalin');
    } catch {
      // Peramban lama atau halaman tanpa izin papan klip.
      toast.info(tautan);
    }
  }

  if (loading || !data) return <Spinner label="Memuat dokumen terbit..." />;

  const r = data.ringkas;

  return (
    <div>
      <PageHeader
        title="Dokumen Terbit"
        subtitle="Slip gaji dan nota yang sudah dikeluarkan bertanda tangan digital"
      >
        <TombolEkspor path="/api/dokumen" nama="dokumen-terbit" csv />
      </PageHeader>

      {data.alamatBelumDiatur && (
        <div className="card mb-4 border-2 border-amber-200 bg-amber-50/60 dark:bg-amber-400/10">
          <div className="flex items-start gap-2">
            <AlertTriangle size={17} className="mt-0.5 shrink-0 text-amber-600" />
            <div className="text-sm text-slate-700">
              <p className="font-semibold text-slate-900">Alamat publik belum diatur</p>
              <p className="mt-1 text-xs leading-relaxed">
                QR pada dokumen dibuat dari alamat aplikasi yang sedang dipakai. Selama alamat
                tetapnya belum diisi di Pengaturan, dokumen yang dicetak dari alamat berbeda akan
                membawa QR yang berbeda pula.
              </p>
            </div>
          </div>
        </div>
      )}

      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard label="Dokumen Terbit" value={r.total} sub={`${r.cetak} kali dicetak`} icon={Link2} />
        <StatCard label="Sesuai" value={r.sah} tone="green" icon={ShieldCheck} />
        <StatCard
          label="Data Sudah Berubah" value={r.berubah}
          sub={r.berubah > 0 ? 'kertas lama tidak lagi cocok' : 'semua masih cocok'}
          tone={r.berubah > 0 ? 'amber' : 'slate'} icon={ShieldAlert}
        />
        <StatCard label="Tautan Dicabut" value={r.dicabut} tone="slate" icon={ShieldX} />
      </div>

      <div className="card mb-4">
        <div className="flex flex-wrap gap-2">
          <button
            className={`rounded-lg px-3 py-1.5 text-xs font-medium ring-1 ${
              saring ? 'bg-surface text-slate-600 ring-slate-200' : 'bg-slate-900 text-white ring-slate-900'
            }`}
            onClick={() => setSaring('')}
          >
            Semua ({data.rows.length})
          </button>
          {Object.entries(STATUS).map(([kunci, s]) => {
            const n = data.rows.filter((x) => x.status === kunci).length;
            if (n === 0) return null;
            return (
              <button
                key={kunci}
                onClick={() => setSaring(saring === kunci ? '' : kunci)}
                className={`rounded-lg px-3 py-1.5 text-xs font-medium ring-1 ${s.kelas} ${
                  saring === kunci ? 'ring-2' : ''
                }`}
              >
                {s.label} ({n})
              </button>
            );
          })}
        </div>
      </div>

      <div className="card">
        {tampil.length === 0 ? (
          <EmptyState
            message="Belum ada dokumen yang dikeluarkan"
            hint="Tanda tangan digital terbit sendiri saat slip gaji atau nota supplier dicetak"
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="table">
              <thead>
                <tr>
                  <th>Dokumen</th>
                  <th>Untuk</th>
                  <th className="text-right">Nilai</th>
                  <th className="text-center">Versi</th>
                  <th>Diterbitkan</th>
                  <th>Kode</th>
                  <th>Status</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {tampil.map((row) => {
                  const s = STATUS[row.status] || STATUS.hilang;
                  return (
                    <tr key={row.id}>
                      <td>
                        <p className="font-mono text-xs font-medium text-slate-900">{row.nomor}</p>
                        <p className="text-xs text-slate-500">{row.jenis}</p>
                      </td>
                      <td className="text-sm">{row.untuk || '—'}</td>
                      <td className="tabular text-right">
                        {row.nilai === null ? '—' : rupiah(row.nilai)}
                      </td>
                      <td className="tabular text-center">
                        ke-{row.versi}
                        <span className="block text-xs text-slate-500">{row.cetak}x cetak</span>
                      </td>
                      <td className="text-xs text-slate-600">
                        {row.diterbitkan}
                        {row.penerbit && <span className="block text-slate-400">{row.penerbit}</span>}
                      </td>
                      <td className="font-mono text-[11px] text-slate-600">{row.kode}</td>
                      <td>
                        <span className={`inline-block rounded-md px-2 py-0.5 text-xs ring-1 ${s.kelas}`}>
                          {s.label}
                        </span>
                      </td>
                      <td className="text-right">
                        <div className="flex justify-end gap-1">
                          {row.tautan && !row.dicabut && (
                            <button
                              className="btn-ghost !px-2 !py-1 text-xs"
                              onClick={() => salin(row.tautan)}
                              aria-label="Salin tautan"
                            >
                              <Copy size={13} />
                            </button>
                          )}
                          {bolehKelola && (
                            <button
                              className={`btn-ghost !px-2 !py-1 text-xs ${row.dicabut ? '' : 'text-rose-600'}`}
                              onClick={() => ubahTautan(row, row.dicabut ? 'aktifkan' : 'cabut')}
                            >
                              {row.dicabut ? 'Aktifkan' : 'Cabut'}
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        <p className="mt-3 text-xs leading-relaxed text-slate-500">
          Siapa pun yang memegang tautannya bisa membuka isi dokumen itu — sama seperti siapa pun
          yang memegang kertasnya. Tokennya acak dan tidak bisa ditebak dari dokumen lain, dan
          tautan yang tersebar ke tangan yang salah bisa dicabut dari sini. Mencabut tidak menghapus
          dokumennya dan tidak menyentuh angkanya; yang berhenti berlaku hanya tautannya.
          Total nilai dokumen yang beredar saat ini {rupiahShort(
            data.rows.reduce((a, x) => a + (x.nilai || 0), 0)
          )}.
        </p>
      </div>
    </div>
  );
}
