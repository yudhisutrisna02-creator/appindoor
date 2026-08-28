import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { ShieldCheck, ShieldAlert, ShieldX, Loader2 } from 'lucide-react';
import { rupiah, dateID } from '../lib/format';

const NADA = {
  sah: {
    ikon: ShieldCheck,
    warna: 'text-emerald-600',
    latar: 'bg-emerald-50 ring-emerald-200 dark:bg-emerald-400/10',
    judul: 'Dokumen sah',
  },
  berubah: {
    ikon: ShieldAlert,
    warna: 'text-amber-600',
    latar: 'bg-amber-50 ring-amber-200 dark:bg-amber-400/10',
    judul: 'Dokumen sah, tetapi datanya sudah berubah',
  },
  dicabut: {
    ikon: ShieldX,
    warna: 'text-rose-600',
    latar: 'bg-rose-50 ring-rose-200 dark:bg-rose-400/10',
    judul: 'Tautan sudah dicabut',
  },
  hilang: {
    ikon: ShieldX,
    warna: 'text-rose-600',
    latar: 'bg-rose-50 ring-rose-200 dark:bg-rose-400/10',
    judul: 'Dokumen sumber tidak ditemukan',
  },
  tidakada: {
    ikon: ShieldX,
    warna: 'text-rose-600',
    latar: 'bg-rose-50 ring-rose-200 dark:bg-rose-400/10',
    judul: 'Dokumen tidak ditemukan',
  },
};

/**
 * Halaman pemeriksaan keaslian dokumen — dibuka tanpa login.
 *
 * Dipakai orang yang memegang kertasnya: pegawai dengan slip gajinya, supplier
 * dengan notanya. Karena itu isinya harus terbaca di layar ponsel sesaat setelah
 * QR dipindai, tanpa satu pun langkah tambahan.
 */
export default function Verifikasi() {
  const { token } = useParams();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let batal = false;
    fetch(`/api/verifikasi/${token}`)
      .then(async (res) => {
        const isi = await res.json().catch(() => ({}));
        if (batal) return;
        // 404 dan 410 tetap membawa keterangan yang berguna; keduanya bukan
        // kegagalan jaringan, jadi tidak diperlakukan sebagai galat.
        setData(res.ok ? isi : { ...isi, status: isi.status || 'tidakada' });
      })
      .catch(() => {
        if (!batal) setData({ status: 'tidakada', pesan: 'Tidak dapat menghubungi server.' });
      })
      .finally(() => { if (!batal) setLoading(false); });
    return () => { batal = true; };
  }, [token]);

  if (loading) {
    return (
      <div className="grid min-h-screen place-items-center bg-slate-50 p-4">
        <div className="flex items-center gap-2 text-sm text-slate-500">
          <Loader2 size={18} className="animate-spin" /> Memeriksa dokumen...
        </div>
      </div>
    );
  }

  const nada = NADA[data.status] || NADA.tidakada;
  const Ikon = nada.ikon;
  const d = data.dokumen;

  return (
    <div className="min-h-screen bg-slate-50 px-4 py-8">
      <div className="mx-auto w-full max-w-md">
        <p className="mb-4 text-center text-xs uppercase tracking-wide text-slate-500">
          Pemeriksaan Keaslian Dokumen
        </p>

        <div className={`rounded-2xl p-5 ring-1 ${nada.latar}`}>
          <div className="flex items-start gap-3">
            <Ikon size={26} className={`mt-0.5 shrink-0 ${nada.warna}`} />
            <div>
              <p className="font-bold text-slate-900">{nada.judul}</p>
              <p className="mt-1 text-xs leading-relaxed text-slate-700">{data.pesan}</p>
            </div>
          </div>
        </div>

        {data.penerbit && (
          <div className="mt-4 rounded-2xl bg-surface p-5 ring-1 ring-slate-200">
            <p className="text-xs text-slate-500">Diterbitkan oleh</p>
            <p className="font-semibold text-slate-900">{data.penerbit}</p>

            <dl className="mt-3 space-y-1.5 text-sm">
              <div className="flex justify-between gap-3">
                <dt className="text-slate-500">Jenis</dt>
                <dd className="font-medium text-slate-900">{data.jenis}</dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt className="text-slate-500">Nomor</dt>
                <dd className="font-mono text-xs font-medium text-slate-900">{data.nomor}</dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt className="text-slate-500">Diterbitkan</dt>
                <dd className="font-medium text-slate-900">{data.diterbitkan}</dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt className="text-slate-500">Versi</dt>
                <dd className="font-medium text-slate-900">
                  ke-{data.versi} • dicetak {data.dicetak}x
                </dd>
              </div>
            </dl>
          </div>
        )}

        {d && (
          <div className="mt-4 rounded-2xl bg-surface p-5 ring-1 ring-slate-200">
            <p className="text-xs text-slate-500">{d.judul}</p>
            <p className="font-semibold text-slate-900">{d.untuk}</p>
            {d.keterangan && <p className="text-xs text-slate-500">{d.keterangan}</p>}
            {d.tanggal && <p className="mt-0.5 text-xs text-slate-500">{dateID(d.tanggal)}</p>}

            <dl className="mt-3 space-y-1 text-sm">
              {d.baris.map(([label, nilai]) => (
                <div key={label} className="flex justify-between gap-3">
                  <dt className="text-slate-600">{label}</dt>
                  <dd className={`tabular font-medium ${nilai < 0 ? 'text-rose-600' : 'text-slate-900'}`}>
                    {rupiah(nilai)}
                  </dd>
                </div>
              ))}
            </dl>

            <div className="mt-3 flex justify-between gap-3 border-t border-slate-200 pt-2">
              <span className="font-semibold text-slate-700">{d.total[0]}</span>
              <span className="tabular text-lg font-bold text-slate-900">{rupiah(d.total[1])}</span>
            </div>

            {d.catatan && <p className="mt-2 text-xs text-slate-500">{d.catatan}</p>}
          </div>
        )}

        {data.kode && (
          <div className="mt-4 rounded-2xl bg-surface p-5 ring-1 ring-slate-200">
            <p className="text-xs text-slate-500">Kode dokumen</p>
            <p className="font-mono text-sm font-bold tracking-wide text-slate-900">{data.kode}</p>
            <p className="mt-2 text-xs leading-relaxed text-slate-500">
              Cocokkan dengan kode yang tercetak pada lembar Anda. Bila berbeda, lembar itu
              diterbitkan sebelum datanya diperbarui.
            </p>
            {data.status === 'berubah' && (
              <p className="mt-2 rounded-lg bg-amber-50 px-3 py-2 font-mono text-xs text-amber-800 dark:bg-amber-400/10">
                Kode terbaru: {data.kodeSekarang}
              </p>
            )}
          </div>
        )}

        <p className="mt-6 text-center text-xs leading-relaxed text-slate-400">
          Halaman ini menyatakan bahwa dokumen dengan nomor tersebut benar dikeluarkan oleh sistem,
          pada waktu yang tercantum, dengan isi yang sidiknya tercetak di lembarnya. Ia bukan
          pengganti tanda tangan pejabat yang berwenang.
        </p>
      </div>
    </div>
  );
}
