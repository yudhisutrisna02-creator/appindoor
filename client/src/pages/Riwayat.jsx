import { useEffect, useState, useCallback } from 'react';
import { History, Lock, Unlock, AlertTriangle, User, XCircle } from 'lucide-react';
import { api } from '../lib/api';
import {
  PageHeader, StatCard, Spinner, EmptyState, Modal,
  useToast, Field, DateRangeFilter, defaultRange, TombolEkspor,
} from '../components/ui';
import { dateID } from '../lib/format';
import { useAuth } from '../lib/auth';

const NADA_AKSI = {
  Tambah: 'bg-emerald-50 text-emerald-700 ring-emerald-200 dark:bg-emerald-400/10',
  Ubah: 'bg-sky-50 text-sky-700 ring-sky-200 dark:bg-sky-400/10',
  Hapus: 'bg-rose-50 text-rose-700 ring-rose-200 dark:bg-rose-400/10',
};

/**
 * Riwayat perubahan & tutup buku.
 *
 * Riwayat menjawab "siapa mengubah apa dan kapan" — pertanyaan yang sebelumnya
 * tidak bisa dijawab sama sekali. Tutup buku menjawab "apakah laporan bulan lalu
 * masih sama seperti saat saya membacanya".
 */
export default function Riwayat() {
  const toast = useToast();
  const { punya } = useAuth();
  const bolehRiwayat = punya('sistem.riwayat');
  const bolehTutup = punya('keuangan.tutupbuku');

  const [tab, setTab] = useState(bolehRiwayat ? 'riwayat' : 'periode');
  const [range, setRange] = useState(defaultRange);
  const [modul, setModul] = useState('');
  const [hanyaGagal, setHanyaGagal] = useState(false);
  const [data, setData] = useState(null);
  const [periode, setPeriode] = useState(null);
  const [loading, setLoading] = useState(true);
  const [kunci, setKunci] = useState(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [a, b] = await Promise.all([
        bolehRiwayat
          ? api.get('/api/riwayat', { ...range, modul, hanyaGagal: hanyaGagal ? '1' : '' })
          : Promise.resolve(null),
        api.get('/api/riwayat/periode'),
      ]);
      setData(a);
      setPeriode(b);
    } catch (err) {
      toast.error(err.message);
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [range.from, range.to, modul, hanyaGagal]);

  useEffect(() => { load(); }, [load]);

  async function tutup(e) {
    e.preventDefault();
    setSaving(true);
    try {
      const res = await api.post('/api/riwayat/periode/kunci', {
        period: kunci.period,
        note: kunci.note || null,
      });
      toast.success(res.message);
      setKunci(null);
      load();
    } catch (err) {
      toast.error(err.message);
    } finally {
      setSaving(false);
    }
  }

  async function buka(p) {
    if (!window.confirm(
      `Buka kembali tutup buku ${p.period}?\n\n` +
      'Setelah dibuka, jurnal bulan itu bisa diubah lagi dan laporan yang sudah ' +
      'terlanjur dibagikan bisa berbeda dari yang tersimpan. Pembukaan ini tercatat di riwayat.'
    )) return;
    try {
      const res = await api.del(`/api/riwayat/periode/${p.period}`);
      toast.success(res.message);
      load();
    } catch (err) {
      toast.error(err.message);
    }
  }

  if (loading) return <Spinner label="Memuat riwayat..." />;

  return (
    <div>
      <PageHeader
        title="Riwayat & Tutup Buku"
        subtitle="Siapa mengubah apa, dan bulan mana yang sudah dikunci"
      >
        {tab === 'riwayat' && bolehRiwayat && (
          <TombolEkspor path="/api/riwayat" params={{ ...range, modul }} nama="riwayat-perubahan" csv />
        )}
      </PageHeader>

      <div className="mb-4 flex gap-2">
        {bolehRiwayat && (
          <button
            className={tab === 'riwayat' ? 'btn-primary' : 'btn-secondary'}
            onClick={() => setTab('riwayat')}
          >
            <History size={16} /> Riwayat Perubahan
          </button>
        )}
        <button
          className={tab === 'periode' ? 'btn-primary' : 'btn-secondary'}
          onClick={() => setTab('periode')}
        >
          <Lock size={16} /> Tutup Buku
        </button>
      </div>

      {tab === 'riwayat' && data && (
        <>
          <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
            <StatCard label="Perubahan" value={data.ringkas.total} icon={History} />
            <StatCard
              label="Yang Gagal" value={data.ringkas.gagal}
              sub={data.ringkas.gagal > 0 ? 'ditolak sistem' : 'tidak ada'}
              icon={XCircle} tone={data.ringkas.gagal > 0 ? 'amber' : 'green'}
            />
            <StatCard label="Orang" value={data.ringkas.orang} icon={User} />
            <StatCard label="Modul Tersentuh" value={data.ringkas.modul} />
          </div>

          <DateRangeFilter range={range} onChange={setRange}>
            <div className="flex-1">
              <label className="label">Modul</label>
              <select className="input" value={modul} onChange={(e) => setModul(e.target.value)}>
                <option value="">Semua modul</option>
                {data.perModul.map((m) => (
                  <option key={m.modul} value={m.modul}>{m.modul} ({m.c})</option>
                ))}
              </select>
            </div>
          </DateRangeFilter>

          <div className="card mb-4">
            <label className="flex items-center gap-2 text-sm text-slate-700">
              <input
                type="checkbox" checked={hanyaGagal}
                onChange={(e) => setHanyaGagal(e.target.checked)}
              />
              Tampilkan hanya yang ditolak sistem
            </label>
          </div>

          <div className="card">
            {data.terpotong && (
              <p className="mb-3 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:bg-amber-400/10">
                Menampilkan {data.rows.length} dari {data.total} perubahan. Persempit rentang
                tanggalnya untuk melihat sisanya.
              </p>
            )}

            {data.rows.length === 0 ? (
              <EmptyState message="Belum ada perubahan pada periode ini" />
            ) : (
              <div className="overflow-x-auto">
                <table className="table">
                  <thead>
                    <tr>
                      <th>Waktu</th>
                      <th>Oleh</th>
                      <th>Aksi</th>
                      <th>Modul</th>
                      <th>Keterangan</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.rows.map((b) => (
                      <tr key={b.id} className={!b.berhasil ? 'bg-amber-50/40 dark:bg-amber-400/5' : ''}>
                        <td className="whitespace-nowrap text-xs text-slate-600">{b.at}</td>
                        <td className="text-sm">{b.user_name || '—'}</td>
                        <td>
                          <span className={`inline-block rounded-md px-2 py-0.5 text-xs ring-1 ${
                            NADA_AKSI[b.aksi] || 'bg-slate-100 text-slate-600 ring-slate-200'
                          }`}>
                            {b.aksi}
                          </span>
                        </td>
                        <td className="text-sm">{b.modul}</td>
                        <td>
                          <p className={`text-sm ${b.berhasil ? 'text-slate-700' : 'text-amber-700'}`}>
                            {b.ringkas || b.path}
                          </p>
                          <p className="font-mono text-[11px] text-slate-400">{b.path}</p>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            <p className="mt-3 text-xs leading-relaxed text-slate-500">
              Dicatat otomatis untuk setiap permintaan yang mengubah data — tidak perlu dipasang
              per menu, jadi menu yang dibuat kemudian ikut tercatat dengan sendirinya. Kata sandi
              dan gambar tidak ikut disimpan. Riwayat hanya bisa dibaca; tidak ada cara menghapusnya
              dari dalam aplikasi.
            </p>
          </div>
        </>
      )}

      {tab === 'periode' && periode && (
        <>
          <div className="mb-4 grid grid-cols-3 gap-3">
            <StatCard label="Bulan Berjurnal" value={periode.ringkas.total} />
            <StatCard label="Sudah Ditutup" value={periode.ringkas.terkunci} icon={Lock} tone="green" />
            <StatCard label="Masih Terbuka" value={periode.ringkas.terbuka} icon={Unlock} tone="slate" />
          </div>

          <div className="card mb-4 border-2 border-slate-200">
            <div className="flex items-start gap-2">
              <AlertTriangle size={17} className="mt-0.5 shrink-0 text-slate-500" />
              <div className="text-sm text-slate-700">
                <p className="font-semibold text-slate-900">Apa yang terjadi saat bulan ditutup</p>
                <p className="mt-1 text-xs leading-relaxed">
                  Jurnal pada bulan itu tidak bisa ditulis, diubah, maupun dihapus lagi — termasuk
                  lewat mengubah order penjualan, menerima barang, atau memposting gaji dengan
                  tanggal lama. Penjagaannya dipasang di pintu menuju buku besar, bukan di tiap
                  menu, sehingga tidak ada modul yang bisa melewatinya. Data yang tidak menyentuh
                  jurnal, seperti catatan nomor faktur, tetap bisa diubah.
                </p>
              </div>
            </div>
          </div>

          <div className="card">
            {periode.rows.length === 0 ? (
              <EmptyState message="Belum ada jurnal sama sekali" />
            ) : (
              <div className="overflow-x-auto">
                <table className="table">
                  <thead>
                    <tr>
                      <th>Bulan</th>
                      <th className="text-right">Jurnal</th>
                      <th>Rentang</th>
                      <th>Keadaan</th>
                      <th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {periode.rows.map((p) => (
                      <tr key={p.period}>
                        <td className="font-medium text-slate-900">{p.period}</td>
                        <td className="tabular text-right">{p.jurnal}</td>
                        <td className="text-xs text-slate-600">
                          {dateID(p.awal)} – {dateID(p.akhir)}
                        </td>
                        <td>
                          {p.terkunci ? (
                            <div>
                              <span className="inline-block rounded-md bg-emerald-50 px-2 py-0.5 text-xs text-emerald-700 ring-1 ring-emerald-200 dark:bg-emerald-400/10">
                                <Lock size={11} className="mr-1 inline" /> Ditutup
                              </span>
                              <p className="mt-0.5 text-[11px] text-slate-500">
                                {p.locked_at}{p.oleh ? ` • ${p.oleh}` : ''}
                              </p>
                              {p.note && <p className="text-[11px] text-slate-500">{p.note}</p>}
                            </div>
                          ) : (
                            <span className="inline-block rounded-md bg-slate-100 px-2 py-0.5 text-xs text-slate-600 ring-1 ring-slate-200">
                              {p.berjalan ? 'Sedang berjalan' : 'Terbuka'}
                            </span>
                          )}
                        </td>
                        <td className="text-right">
                          {bolehTutup && !p.berjalan && (
                            p.terkunci ? (
                              <button className="btn-ghost !px-2 !py-1 text-xs" onClick={() => buka(p)}>
                                <Unlock size={13} /> Buka
                              </button>
                            ) : (
                              <button
                                className="btn-ghost !px-2 !py-1 text-xs"
                                onClick={() => setKunci({ period: p.period, note: '' })}
                              >
                                <Lock size={13} /> Tutup
                              </button>
                            )
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </>
      )}

      <Modal open={!!kunci} onClose={() => setKunci(null)} title={`Tutup Buku ${kunci?.period || ''}`}>
        {kunci && (
          <form onSubmit={tutup} className="grid gap-3">
            <p className="rounded-xl bg-slate-50 px-3 py-2 text-sm text-slate-700">
              Setelah ditutup, jurnal bulan {kunci.period} tidak bisa diubah lagi oleh menu mana pun.
              Tutup buku bisa dibuka kembali bila memang diperlukan, dan pembukaannya ikut tercatat
              di riwayat.
            </p>
            <Field label="Catatan" hint="Mis. sudah dilaporkan ke pemilik pada 5 September">
              <input
                className="input" maxLength={300} value={kunci.note}
                onChange={(e) => setKunci({ ...kunci, note: e.target.value })}
              />
            </Field>
            <div className="flex gap-2">
              <button type="button" className="btn-secondary flex-1" onClick={() => setKunci(null)}>Batal</button>
              <button type="submit" className="btn-primary flex-1" disabled={saving}>
                {saving ? 'Menutup...' : 'Tutup Buku'}
              </button>
            </div>
          </form>
        )}
      </Modal>
    </div>
  );
}
