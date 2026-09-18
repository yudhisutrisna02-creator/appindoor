import { useEffect, useState, useCallback } from 'react';
import { Plus, Pencil, Trash2, ShieldCheck, Lock, Users, KeyRound } from 'lucide-react';
import { api } from '../lib/api';
import { Spinner, Modal, useToast, Field, TombolEkspor } from '../components/ui';
import { useAuth } from '../lib/auth';

const KOSONG = { name: '', description: '', active: true, permissions: [] };

/**
 * Warna per peran.
 *
 * Bukan hiasan: yang mengatur hak akses menelusuri daftar ini berkali-kali, dan
 * warna membuat baris yang dicari ketemu sebelum namanya dibaca. Kelasnya
 * ditulis utuh — Tailwind memangkas kelas yang namanya dirangkai saat berjalan.
 */
const WARNA_PERAN = {
  admin: { garis: 'bg-brand-500', tulisan: 'text-brand-700 dark:text-brand-300', latar: 'bg-brand-50 dark:bg-brand-400/10', cincin: 'ring-brand-200 dark:ring-brand-400/30' },
  manager: { garis: 'bg-violet-500', tulisan: 'text-violet-700 dark:text-violet-300', latar: 'bg-violet-50 dark:bg-violet-400/10', cincin: 'ring-violet-200 dark:ring-violet-400/30' },
  cs_marketplace: { garis: 'bg-sky-500', tulisan: 'text-sky-700 dark:text-sky-300', latar: 'bg-sky-50 dark:bg-sky-400/10', cincin: 'ring-sky-200 dark:ring-sky-400/30' },
  gudang: { garis: 'bg-amber-500', tulisan: 'text-amber-700 dark:text-amber-300', latar: 'bg-amber-50 dark:bg-amber-400/10', cincin: 'ring-amber-200 dark:ring-amber-400/30' },
  konten: { garis: 'bg-pink-500', tulisan: 'text-pink-700 dark:text-pink-300', latar: 'bg-pink-50 dark:bg-pink-400/10', cincin: 'ring-pink-200 dark:ring-pink-400/30' },
  _lain: { garis: 'bg-emerald-500', tulisan: 'text-emerald-700 dark:text-emerald-300', latar: 'bg-emerald-50 dark:bg-emerald-400/10', cincin: 'ring-emerald-200 dark:ring-emerald-400/30' },
};
const warnaPeran = (slug) => WARNA_PERAN[slug] || WARNA_PERAN._lain;

/** Huruf awal nama peran, dipakai sebagai penanda di kartunya. */
const inisial = (nama) => String(nama || '?').trim().split(/\s+/).slice(0, 2).map((k) => k[0]).join('').toUpperCase();

/**
 * Peran & hak akses.
 *
 * Izin ditampilkan berkelompok mengikuti susunan menu, supaya yang mengaturnya
 * melihat bentuk yang sama dengan yang dilihat penggunanya nanti — daftar datar
 * berisi puluhan kunci teknis memaksa orang menebak izin mana milik menu mana.
 */
export default function PeranTab() {
  const toast = useToast();
  const { punya } = useAuth();
  const bolehUbah = punya('sistem.peran');

  const [roles, setRoles] = useState([]);
  const [katalog, setKatalog] = useState([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const d = await api.get('/api/peran');
      setRoles(d.roles);
      setKatalog(d.katalog);
    } catch (err) {
      toast.error(err.message);
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => { load(); }, [load]);

  async function simpan(e) {
    e.preventDefault();
    try {
      const isi = {
        name: editing.name,
        description: editing.description || null,
        active: editing.active,
        permissions: editing.permissions,
      };
      const res = editing.id
        ? await api.put(`/api/peran/${editing.id}`, isi)
        : await api.post('/api/peran', isi);
      toast.success(res.message);
      setEditing(null);
      load();
    } catch (err) {
      toast.error(err.message);
    }
  }

  async function hapus(r) {
    if (!window.confirm(`Hapus peran ${r.name}?`)) return;
    try {
      const res = await api.del(`/api/peran/${r.id}`);
      toast.success(res.message);
      load();
    } catch (err) {
      toast.error(err.message);
    }
  }

  function toggleIzin(kunci) {
    const ada = editing.permissions.includes(kunci);
    setEditing({
      ...editing,
      permissions: ada
        ? editing.permissions.filter((k) => k !== kunci)
        : [...editing.permissions, kunci],
    });
  }

  function toggleModul(modul) {
    const kunci = modul.izin.map((i) => i.kunci);
    const semua = kunci.every((k) => editing.permissions.includes(k));
    setEditing({
      ...editing,
      permissions: semua
        ? editing.permissions.filter((k) => !kunci.includes(k))
        : [...new Set([...editing.permissions, ...kunci])],
    });
  }

  if (loading) return <Spinner />;

  const adminTerkunci = editing?.slug === 'admin';

  return (
    <div className="card">
      <div className="mb-3 flex items-center justify-between">
        <div>
          <h2 className="card-title">Peran & Hak Akses</h2>
          <p className="mt-0.5 text-xs text-slate-500">
            Tentukan halaman dan aktivitas apa saja yang boleh diakses tiap peran
          </p>
        </div>
        <div className="flex gap-2">
          <TombolEkspor path="/api/peran" nama="peran-hak-akses" kecil />
          {bolehUbah && (
            <button className="btn-primary !py-2" onClick={() => setEditing({ ...KOSONG })}>
              <Plus size={16} /> Peran Baru
            </button>
          )}
        </div>
      </div>

      {/* Kartu, bukan tabel: keterangan tiap peran berupa kalimat penuh, dan di
          dalam tabel ia menimpa kolom angka di sebelahnya. Kartu juga memberi
          tempat bagi warna penanda peran yang membuat daftar ini mudah disapu
          mata. */}
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {roles.map((r) => {
          const w = warnaPeran(r.slug);
          return (
            <div
              key={r.id}
              className="relative flex flex-col overflow-hidden rounded-2xl bg-surface p-4 pl-5 shadow-sm ring-1 ring-slate-200/70 transition hover:-translate-y-0.5 hover:shadow-md"
            >
              <span className={`absolute inset-y-0 left-0 w-1.5 ${w.garis}`} />

              <div className="flex items-start gap-3">
                <span className={`grid h-10 w-10 shrink-0 place-items-center rounded-xl text-sm font-bold ring-1 ${w.latar} ${w.tulisan} ${w.cincin}`}>
                  {r.slug === 'admin' ? <ShieldCheck size={18} /> : inisial(r.name)}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-start justify-between gap-2">
                    <h3 className="truncate font-bold text-slate-900">{r.name}</h3>
                    {r.active
                      ? <span className="badge-green shrink-0">aktif</span>
                      : <span className="badge-slate shrink-0">nonaktif</span>}
                  </div>
                  <p className={`truncate font-mono text-[11px] ${w.tulisan}`}>{r.slug}</p>
                </div>
              </div>

              <p className="mt-3 line-clamp-3 text-xs leading-relaxed text-slate-600" title={r.description || ''}>
                {r.description || 'Belum ada keterangan.'}
              </p>

              <div className="mt-3 flex items-center justify-between gap-2 border-t border-slate-100 pt-3">
                <div className="flex flex-wrap gap-1.5 text-xs">
                  <span className={`inline-flex items-center gap-1 rounded-lg px-2 py-1 font-semibold ring-1 ${w.latar} ${w.tulisan} ${w.cincin}`}>
                    <KeyRound size={13} /> {r.permissions.length} hak akses
                  </span>
                  <span className="inline-flex items-center gap-1 rounded-lg bg-slate-100 px-2 py-1 font-semibold text-slate-600">
                    <Users size={13} /> {r.jumlahPengguna} pengguna
                  </span>
                </div>

                {bolehUbah && (
                  <div className="flex shrink-0 gap-1">
                    <button
                      className="btn-ghost !px-2 !py-1"
                      onClick={() => setEditing({ ...r, description: r.description || '', active: !!r.active })}
                      aria-label={r.slug === 'admin' ? `Lihat hak akses ${r.name}` : `Ubah peran ${r.name}`}
                      title={r.slug === 'admin' ? 'Hak akses admin terkunci' : 'Ubah peran'}
                    >
                      {r.slug === 'admin' ? <Lock size={14} /> : <Pencil size={14} />}
                    </button>
                    {!r.is_system && (
                      <button
                        className="btn-ghost !px-2 !py-1 text-rose-600"
                        onClick={() => hapus(r)}
                        aria-label={`Hapus peran ${r.name}`} title="Hapus peran"
                      >
                        <Trash2 size={14} />
                      </button>
                    )}
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>

      <Modal
        open={!!editing}
        onClose={() => setEditing(null)}
        title={editing?.id ? `Hak Akses — ${editing.name}` : 'Peran Baru'}
        wide
      >
        {editing && (
          <form onSubmit={simpan} className="grid gap-3">
            {adminTerkunci && (
              <div className="rounded-xl border border-brand-200 bg-brand-50 px-3 py-2 text-xs text-brand-900">
                Peran Admin selalu memegang akses penuh dan tidak dapat dibatasi. Ia jalan keluar terakhir
                bila peran lain salah disusun — kalau izinnya ikut bisa dicabut, tidak ada lagi yang bisa
                memperbaikinya dari dalam aplikasi.
              </div>
            )}

            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Nama Peran *">
                <input className="input" required disabled={adminTerkunci} value={editing.name}
                  onChange={(e) => setEditing({ ...editing, name: e.target.value })} />
              </Field>
              <Field label="Keterangan">
                <input className="input" disabled={adminTerkunci} value={editing.description}
                  onChange={(e) => setEditing({ ...editing, description: e.target.value })} />
              </Field>
            </div>

            <div className="max-h-[45vh] overflow-y-auto rounded-xl border border-slate-200">
              {katalog.map((m) => {
                const kunci = m.izin.map((i) => i.kunci);
                const semua = kunci.every((k) => editing.permissions.includes(k));
                const sebagian = !semua && kunci.some((k) => editing.permissions.includes(k));
                return (
                  <div key={m.modul} className="border-b border-slate-100 last:border-0">
                    <button
                      type="button"
                      disabled={adminTerkunci}
                      onClick={() => toggleModul(m)}
                      className="flex w-full items-center justify-between bg-slate-50 px-3 py-2 text-left text-sm font-semibold text-slate-800 disabled:opacity-60"
                    >
                      <span>{m.label}</span>
                      <span className={`text-[11px] font-medium ${semua ? 'text-emerald-600' : sebagian ? 'text-amber-600' : 'text-slate-400'}`}>
                        {semua ? 'semua' : sebagian ? 'sebagian' : 'tidak ada'}
                      </span>
                    </button>
                    <div className="divide-y divide-slate-50">
                      {m.izin.map((i) => (
                        <label
                          key={i.kunci}
                          className="flex cursor-pointer items-center justify-between gap-3 px-3 py-2 text-sm hover:bg-slate-50"
                        >
                          <span className="text-slate-700">
                            {i.label}
                            <span className="ml-2 font-mono text-[10px] text-slate-400">{i.kunci}</span>
                          </span>
                          <input
                            type="checkbox"
                            className="h-4 w-4 shrink-0 rounded"
                            disabled={adminTerkunci}
                            checked={editing.permissions.includes(i.kunci)}
                            onChange={() => toggleIzin(i.kunci)}
                          />
                        </label>
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>

            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" className="h-4 w-4 rounded" disabled={adminTerkunci}
                checked={editing.active} onChange={(e) => setEditing({ ...editing, active: e.target.checked })} />
              Peran aktif
            </label>

            <div className="flex gap-2">
              <button type="button" className="btn-secondary flex-1" onClick={() => setEditing(null)}>
                {adminTerkunci ? 'Tutup' : 'Batal'}
              </button>
              {!adminTerkunci && (
                <button type="submit" className="btn-primary flex-1">
                  Simpan ({editing.permissions.length} hak akses)
                </button>
              )}
            </div>
          </form>
        )}
      </Modal>
    </div>
  );
}
