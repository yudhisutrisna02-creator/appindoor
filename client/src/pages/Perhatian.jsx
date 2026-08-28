import { useEffect, useState, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { AlertTriangle, AlertCircle, Info, CheckCircle2, RefreshCw, ArrowRight } from 'lucide-react';
import { api } from '../lib/api';
import { PageHeader, StatCard, Spinner, useToast } from '../components/ui';

const NADA = {
  genting: {
    label: 'Genting',
    ikon: AlertTriangle,
    kartu: 'border-rose-200 bg-rose-50/60 dark:bg-rose-400/10',
    ikonWarna: 'text-rose-600',
    lencana: 'bg-rose-100 text-rose-700 ring-rose-200 dark:bg-rose-400/15',
  },
  perhatian: {
    label: 'Perlu perhatian',
    ikon: AlertCircle,
    kartu: 'border-amber-200 bg-amber-50/60 dark:bg-amber-400/10',
    ikonWarna: 'text-amber-600',
    lencana: 'bg-amber-100 text-amber-700 ring-amber-200 dark:bg-amber-400/15',
  },
  kabar: {
    label: 'Sekadar kabar',
    ikon: Info,
    kartu: 'border-slate-200 bg-slate-50',
    ikonWarna: 'text-slate-500',
    lencana: 'bg-slate-100 text-slate-600 ring-slate-200',
  },
};

/**
 * Pusat Perhatian.
 *
 * Setiap sinyal di sini sudah ada di menunya masing-masing. Yang berubah bukan
 * angkanya, melainkan siapa yang harus mencarinya: sebelumnya tujuh layar harus
 * dibuka satu per satu, dan yang paling sering terjadi bukan salah membaca
 * angkanya melainkan tidak pernah membukanya.
 */
export default function Perhatian() {
  const toast = useToast();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saring, setSaring] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setData(await api.get('/api/perhatian'));
    } catch (err) {
      toast.error(err.message);
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => { load(); }, [load]);

  if (loading || !data) return <Spinner label="Memeriksa apa yang perlu dikerjakan..." />;

  const r = data.ringkas;
  const tampil = data.rows.filter((b) => !saring || b.tingkat === saring);

  return (
    <div>
      <PageHeader
        title="Pusat Perhatian"
        subtitle="Yang perlu dikerjakan hari ini, dikumpulkan dari seluruh menu"
      >
        <button className="btn-secondary" onClick={load}>
          <RefreshCw size={16} /> Muat Ulang
        </button>
      </PageHeader>

      <div className="mb-4 grid grid-cols-3 gap-3">
        <StatCard
          label="Genting" value={r.genting}
          sub={r.genting > 0 ? 'kerjakan hari ini' : 'tidak ada'}
          icon={AlertTriangle} tone={r.genting > 0 ? 'red' : 'green'}
        />
        <StatCard
          label="Perlu Perhatian" value={r.perhatian}
          icon={AlertCircle} tone={r.perhatian > 0 ? 'amber' : 'green'}
        />
        <StatCard label="Sekadar Kabar" value={r.kabar} icon={Info} tone="slate" />
      </div>

      {data.rows.length > 0 && (
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
            {Object.entries(NADA).map(([kunci, n]) => {
              const jumlah = data.rows.filter((b) => b.tingkat === kunci).length;
              if (jumlah === 0) return null;
              return (
                <button
                  key={kunci}
                  onClick={() => setSaring(saring === kunci ? '' : kunci)}
                  className={`rounded-lg px-3 py-1.5 text-xs font-medium ring-1 ${n.lencana} ${
                    saring === kunci ? 'ring-2' : ''
                  }`}
                >
                  {n.label} ({jumlah})
                </button>
              );
            })}
          </div>
        </div>
      )}

      {data.rows.length === 0 ? (
        <div className="card">
          <div className="py-12 text-center">
            <CheckCircle2 size={40} className="mx-auto text-emerald-500" />
            <p className="mt-3 font-semibold text-slate-900">Tidak ada yang perlu dikerjakan</p>
            <p className="mt-1 text-sm text-slate-500">
              Dana tidak ada yang lama tertahan, stok aman, rekening wajar, dan cadangan mutakhir.
            </p>
          </div>
        </div>
      ) : (
        <div className="space-y-3">
          {tampil.map((b) => {
            const n = NADA[b.tingkat] || NADA.kabar;
            const Ikon = n.ikon;
            return (
              <div key={b.kunci} className={`card border-2 ${n.kartu}`}>
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="flex min-w-0 items-start gap-3">
                    <Ikon size={20} className={`mt-0.5 shrink-0 ${n.ikonWarna}`} />
                    <div className="min-w-0">
                      <p className="font-semibold text-slate-900">{b.judul}</p>
                      <p className="mt-1 text-sm leading-relaxed text-slate-600">{b.rincian}</p>
                    </div>
                  </div>
                  {b.tautan && (
                    <Link to={b.tautan} className="btn-secondary shrink-0 !px-3 !py-1.5 text-xs">
                      {b.tombol || 'Buka'} <ArrowRight size={14} />
                    </Link>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {data.gagal.length > 0 && (
        <div className="card mt-4 border-2 border-slate-200">
          <p className="text-sm font-semibold text-slate-900">Sebagian pemeriksaan gagal dibaca</p>
          <ul className="mt-1 ml-4 list-disc text-xs text-slate-600">
            {data.gagal.map((g) => <li key={g.sumber}>{g.sumber}: {g.pesan}</li>)}
          </ul>
          <p className="mt-2 text-xs text-slate-500">
            Sisanya tetap ditampilkan. Layar ini justru dibuka saat ada yang tidak beres, jadi satu
            sumber yang bermasalah tidak boleh menyembunyikan sumber lainnya.
          </p>
        </div>
      )}

      <p className="mt-4 text-xs leading-relaxed text-slate-500">
        Angka di sini tidak dihitung ulang — diambil dari fungsi yang sama dengan yang dipakai
        menunya, jadi peringatan dan menu tidak akan pernah menyebut dua angka berbeda untuk hal
        yang sama. Yang Anda lihat juga disaring menurut hak akses Anda; orang lain bisa melihat
        daftar yang berbeda.
      </p>
    </div>
  );
}
