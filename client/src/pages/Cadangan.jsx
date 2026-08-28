import { useEffect, useState, useCallback } from 'react';
import { DatabaseBackup, Download, Trash2, ShieldAlert, Clock, HardDrive } from 'lucide-react';
import { api } from '../lib/api';
import {
  PageHeader, StatCard, Spinner, EmptyState, useToast,
} from '../components/ui';

const waktuID = (iso) => {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleString('id-ID', { dateStyle: 'medium', timeStyle: 'short' });
};

const selisih = (iso) => {
  if (!iso) return null;
  const jam = (Date.now() - new Date(iso).getTime()) / 3600000;
  if (jam < 1) return 'kurang dari sejam lalu';
  if (jam < 24) return `${Math.floor(jam)} jam lalu`;
  return `${Math.floor(jam / 24)} hari lalu`;
};

/**
 * Pencadangan basis data.
 *
 * Seluruh isi aplikasi ada di satu berkas. Layar ini yang membuat salinannya
 * bisa diambil keluar dari server — cadangan yang hanya tersimpan di mesin yang
 * sama tidak menolong bila mesin itu yang bermasalah.
 */
export default function Cadangan() {
  const toast = useToast();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [sibuk, setSibuk] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setData(await api.get('/api/cadangan'));
    } catch (err) {
      toast.error(err.message);
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => { load(); }, [load]);

  async function buat() {
    setSibuk(true);
    try {
      const res = await api.post('/api/cadangan');
      toast.success(res.message);
      load();
    } catch (err) {
      toast.error(err.message);
    } finally {
      setSibuk(false);
    }
  }

  async function unduh(nama) {
    try {
      await api.download(`/api/cadangan/${nama}/unduh`, {}, nama);
    } catch (err) {
      toast.error(err.message);
    }
  }

  async function unduhBaru() {
    setSibuk(true);
    try {
      await api.download('/api/cadangan/unduh-sekarang', {}, 'cadangan.db');
      load();
    } catch (err) {
      toast.error(err.message);
    } finally {
      setSibuk(false);
    }
  }

  async function hapus(nama) {
    if (!window.confirm(`Hapus cadangan ${nama}? Berkasnya tidak bisa dikembalikan.`)) return;
    try {
      const res = await api.del(`/api/cadangan/${encodeURIComponent(nama)}`);
      toast.success(res.message);
      load();
    } catch (err) {
      toast.error(err.message);
    }
  }

  if (loading || !data) return <Spinner label="Memeriksa cadangan..." />;

  const r = data.ringkas;
  const i = data.info;
  const basi = !r.terbaru || (Date.now() - new Date(r.terbaru).getTime()) / 3600000 > 48;

  return (
    <div>
      <PageHeader
        title="Pencadangan"
        subtitle="Salinan seluruh isi aplikasi — penjualan, stok, jurnal, dan gaji"
      >
        <button className="btn-secondary" onClick={buat} disabled={sibuk}>
          <DatabaseBackup size={16} /> {sibuk ? 'Menyalin...' : 'Buat Cadangan'}
        </button>
        <button className="btn-primary" onClick={unduhBaru} disabled={sibuk}>
          <Download size={16} /> Buat & Unduh Sekarang
        </button>
      </PageHeader>

      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard
          label="Cadangan Tersimpan" value={r.jumlah}
          sub={`${r.otomatis} otomatis • ${r.manual} manual`} icon={DatabaseBackup}
        />
        <StatCard
          label="Cadangan Terakhir" value={selisih(r.terbaru) || 'belum ada'}
          sub={r.terbaru ? waktuID(r.terbaru) : 'belum pernah dibuat'}
          icon={Clock} tone={basi ? 'red' : 'green'}
        />
        <StatCard label="Ukuran Basis Data" value={i.ukuranTeks} icon={HardDrive} />
        <StatCard
          label="Isi" value={`${i.isi.order ?? 0} order`}
          sub={`${i.isi.produk ?? 0} produk • ${i.isi.jurnal ?? 0} jurnal • ${i.isi.pengguna ?? 0} akun`}
        />
      </div>

      {basi && (
        <div className="card mb-4 border-2 border-rose-200 bg-rose-50/60 dark:bg-rose-400/10">
          <div className="flex items-start gap-2">
            <ShieldAlert size={17} className="mt-0.5 shrink-0 text-rose-600" />
            <div className="text-sm text-slate-700">
              <p className="font-semibold text-slate-900">
                {r.terbaru ? 'Cadangan terakhir sudah lebih dari dua hari' : 'Belum ada cadangan sama sekali'}
              </p>
              <p className="mt-1 text-xs leading-relaxed">
                Cadangan otomatis dibuat sekali sehari selama aplikasi menyala. Kalau aplikasinya
                sering dimulai ulang atau baru dipasang, buat satu sekarang.
              </p>
            </div>
          </div>
        </div>
      )}

      <div className="card mb-4 border-2 border-amber-200 bg-amber-50/60 dark:bg-amber-400/10">
        <div className="flex items-start gap-2">
          <ShieldAlert size={17} className="mt-0.5 shrink-0 text-amber-600" />
          <div className="text-sm text-slate-700">
            <p className="font-semibold text-slate-900">Simpan salinannya di luar server</p>
            <p className="mt-1 text-xs leading-relaxed">
              Cadangan otomatis tersimpan di server yang sama dengan aplikasinya. Itu menolong bila
              datanya rusak, tetapi tidak menolong bila servernya yang bermasalah. Unduh satu berkas
              secara berkala dan simpan di tempat lain.
              {' '}Berkas ini berisi <strong>seluruh data perusahaan termasuk data akun</strong> —
              perlakukan seperti brankas, jangan dikirim lewat saluran terbuka.
            </p>
          </div>
        </div>
      </div>

      <div className="card mb-4">
        <h2 className="card-title mb-2">Cara Memulihkan</h2>
        <ol className="ml-4 list-decimal space-y-1 text-sm text-slate-700">
          {data.langkahPulih.map((l) => <li key={l}>{l}</li>)}
        </ol>
        <p className="mt-2 text-xs leading-relaxed text-slate-500">
          Pemulihan sengaja tidak disediakan sebagai tombol. Memulihkan berarti menimpa basis data
          yang sedang melayani, dan satu klik yang salah akan menghapus pekerjaan berhari-hari tanpa
          bisa dibatalkan.
        </p>
        <p className="mt-2 font-mono text-[11px] text-slate-500">{i.berkas}</p>
      </div>

      <div className="card">
        <h2 className="card-title mb-3">
          {data.rows.length} berkas cadangan
          <span className="ml-2 font-normal text-slate-500">
            (disimpan maksimal {i.simpanMaks} cadangan otomatis)
          </span>
        </h2>

        {data.rows.length === 0 ? (
          <EmptyState message="Belum ada cadangan" hint="Tekan Buat Cadangan untuk membuat yang pertama" />
        ) : (
          <div className="overflow-x-auto">
            <table className="table">
              <thead>
                <tr>
                  <th>Berkas</th>
                  <th>Dibuat</th>
                  <th>Jenis</th>
                  <th className="text-right">Ukuran</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {data.rows.map((c) => (
                  <tr key={c.nama}>
                    <td className="font-mono text-xs">{c.nama}</td>
                    <td className="text-sm">
                      {waktuID(c.dibuat)}
                      <span className="block text-xs text-slate-500">{selisih(c.dibuat)}</span>
                    </td>
                    <td>
                      <span className={`inline-block rounded-md px-2 py-0.5 text-xs ring-1 ${
                        c.jenis === 'otomatis'
                          ? 'bg-slate-100 text-slate-600 ring-slate-200'
                          : 'bg-brand-50 text-brand-700 ring-brand-200 dark:bg-brand-400/10'
                      }`}>
                        {c.jenis}
                      </span>
                    </td>
                    <td className="tabular text-right">{c.ukuranTeks}</td>
                    <td className="text-right">
                      <div className="flex justify-end gap-1">
                        <button className="btn-ghost !px-2 !py-1 text-xs" onClick={() => unduh(c.nama)}>
                          <Download size={13} /> Unduh
                        </button>
                        <button
                          className="btn-ghost !px-2 !py-1 text-xs text-rose-600"
                          onClick={() => hapus(c.nama)}
                        >
                          <Trash2 size={13} />
                        </button>
                      </div>
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
