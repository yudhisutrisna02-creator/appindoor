import { useEffect, useState, useCallback } from 'react';
import { Plus, Pencil, Trash2, ShieldCheck, Lock } from 'lucide-react';
import { api } from '../lib/api';
import { Spinner, Modal, useToast, Field, TombolEkspor } from '../components/ui';
import { useAuth } from '../lib/auth';

const KOSONG = { name: '', description: '', active: true, permissions: [] };

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

      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>Peran</th><th>Keterangan</th><th>Hak Akses</th>
              <th>Pengguna</th><th>Status</th>{bolehUbah && <th></th>}
            </tr>
          </thead>
          <tbody>
            {roles.map((r) => (
              <tr key={r.id}>
                <td>
                  <div className="flex items-center gap-1.5 font-medium text-slate-900">
                    {r.slug === 'admin' && <ShieldCheck size={14} className="text-brand-600" />}
                    {r.name}
                  </div>
                  <p className="font-mono text-[11px] text-slate-400">{r.slug}</p>
                </td>
                {/* Keterangan bisa panjang; tanpa lebar tetap ia mendorong kolom
                    angka di sebelahnya sampai saling tumpang tindih. */}
                <td className="text-xs text-slate-600">
                  <p className="w-[22rem] max-w-[40vw] leading-relaxed">{r.description || '-'}</p>
                </td>
                <td className="tabular text-sm">{r.permissions.length}</td>
                <td className="tabular text-sm">{r.jumlahPengguna}</td>
                <td>{r.active ? <span className="badge-green">aktif</span> : <span className="badge-slate">nonaktif</span>}</td>
                {bolehUbah && (
                  <td>
                    <div className="flex gap-1">
                      <button
                        className="btn-ghost !px-2 !py-1"
                        onClick={() => setEditing({ ...r, description: r.description || '', active: !!r.active })}
                        aria-label={r.slug === 'admin' ? 'Lihat' : 'Ubah'}
                      >
                        {r.slug === 'admin' ? <Lock size={14} /> : <Pencil size={14} />}
                      </button>
                      {!r.is_system && (
                        <button className="btn-ghost !px-2 !py-1 text-rose-600" onClick={() => hapus(r)} aria-label="Hapus">
                          <Trash2 size={14} />
                        </button>
                      )}
                    </div>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
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
