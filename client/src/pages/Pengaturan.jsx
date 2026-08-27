import { useEffect, useState, useCallback } from 'react';
import { Plus, Pencil, Trash2, MapPin, Save, Users, Building2, Settings as SettingsIcon, KeyRound, Crosshair, ShieldCheck } from 'lucide-react';
import { api } from '../lib/api';
import UnggahGambar from '../components/UnggahGambar';
import GambarTerlindungi from '../components/GambarTerlindungi';
import PeranTab from './PeranTab';
import { useBranding } from '../lib/branding';
import { PageHeader, Spinner, EmptyState, Modal, useToast, Field, TombolEkspor } from '../components/ui';
import { useAuth } from '../lib/auth';

/** Izin minimal untuk membuka tiap tab. */
const IZIN_TAB = {
  app: ['sistem.pengaturan'],
  offices: ['sistem.kantor'],
  users: ['sistem.tim'],
  peran: ['sistem.peran', 'sistem.tim'],
};

const TABS = [
  { key: 'app', label: 'Aplikasi', icon: SettingsIcon },
  { key: 'offices', label: 'Titik Kantor', icon: Building2 },
  { key: 'users', label: 'Data Tim', icon: Users },
  { key: 'peran', label: 'Peran & Hak Akses', icon: ShieldCheck },
  { key: 'account', label: 'Akun Saya', icon: KeyRound },
];

export default function Pengaturan() {
  const { isAdmin, canManage, punya } = useAuth();
  // Tab awal dipilih dari yang benar-benar boleh dibuka. Membuka tab yang
  // ditolak peladen hanya menampilkan halaman kosong berisi pesan galat.
  const tabTersedia = TABS.filter((t) => !IZIN_TAB[t.key] || punya(...IZIN_TAB[t.key]));
  const [tab, setTab] = useState(tabTersedia[0]?.key || 'app');

  return (
    <div>
      <PageHeader title="Pengaturan" subtitle="Konfigurasi perusahaan, geofencing, dan pengguna" />

      <div className="mb-4 flex gap-1.5 overflow-x-auto rounded-xl bg-white p-1.5 shadow-sm ring-1 ring-slate-200/70">
        {TABS.filter((t) => !IZIN_TAB[t.key] || punya(...IZIN_TAB[t.key])).map((t) => (
          <button
            key={t.key} onClick={() => setTab(t.key)}
            className={`flex shrink-0 items-center gap-2 rounded-lg px-3.5 py-2 text-sm font-semibold transition ${
              tab === t.key ? 'bg-brand-600 text-white' : 'text-slate-600 hover:bg-slate-100'
            }`}
          >
            <t.icon size={16} /> {t.label}
          </button>
        ))}
      </div>

      {tab === 'app' && <AppSettings isAdmin={isAdmin} />}
      {tab === 'offices' && <Offices canManage={canManage} isAdmin={isAdmin} />}
      {tab === 'users' && <UsersTab isAdmin={isAdmin} />}
      {tab === 'peran' && <PeranTab />}
      {tab === 'account' && <MyAccount />}
    </div>
  );
}

// ------------------------------------------------------------------
function AppSettings({ isAdmin }) {
  const toast = useToast();
  const { muatUlangIdentitas } = useBranding();
  const [settings, setSettings] = useState(null);
  const [saving, setSaving] = useState(false);
  // null = belum dimuat; string = data URL atau alamat gambar; '' = tidak ada logo
  const [logo, setLogo] = useState('');
  const [logoBaru, setLogoBaru] = useState(false);

  useEffect(() => {
    api.get('/api/admin/settings').then((d) => setSettings(d.settings)).catch((e) => toast.error(e.message));
    api.get('/api/branding').then((d) => setLogo(d.logo || '')).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function save(e) {
    e.preventDefault();
    setSaving(true);
    try {
      await api.put('/api/admin/settings', settings);
      // Logo hanya dikirim bila memang diganti — mengirim alamat gambar yang
      // lama akan diabaikan peladen, tetapi menghapusnya secara tidak sengaja
      // saat pengguna hanya mengubah nomor telepon jelas bukan yang diinginkan.
      if (logoBaru) {
        await api.put('/api/branding/logo', { logo: logo || null });
        setLogoBaru(false);
      }
      await muatUlangIdentitas();
      toast.success('Pengaturan disimpan');
    } catch (err) {
      toast.error(err.message);
    } finally {
      setSaving(false);
    }
  }

  if (!settings) return <Spinner />;
  const set = (k) => (e) => setSettings({ ...settings, [k]: e.target.value });

  return (
    <form onSubmit={save} className="card grid max-w-3xl gap-4 sm:grid-cols-2">
      <div className="sm:col-span-2">
        <h2 className="card-title mb-3">Identitas Perusahaan</h2>
        <UnggahGambar
          label="Logo Perusahaan"
          nilai={logo || null}
          onChange={(v) => { setLogo(v || ''); setLogoBaru(true); }}
          hint="Tampil di halaman masuk, sidebar, dan kop laporan. PNG berlatar tembus pandang paling rapi."
        />
      </div>

      <Field label="Nama Perusahaan" className="sm:col-span-2">
        <input className="input" value={settings.company_name || ''} onChange={set('company_name')} disabled={!isAdmin} />
      </Field>
      <Field label="Tagline" hint="Satu baris di bawah nama" className="sm:col-span-2">
        <input className="input" value={settings.company_tagline || ''} onChange={set('company_tagline')} disabled={!isAdmin} />
      </Field>
      <Field label="Alamat" className="sm:col-span-2">
        <input className="input" value={settings.company_address || ''} onChange={set('company_address')} disabled={!isAdmin} />
      </Field>
      <Field label="Telepon">
        <input className="input" value={settings.company_phone || ''} onChange={set('company_phone')} disabled={!isAdmin} />
      </Field>
      <Field label="Email">
        <input className="input" value={settings.company_email || ''} onChange={set('company_email')} disabled={!isAdmin} />
      </Field>
      <Field label="NPWP">
        <input className="input" value={settings.company_tax_id || ''} onChange={set('company_tax_id')} disabled={!isAdmin} />
      </Field>
      <Field label="Website">
        <input className="input" value={settings.company_website || ''} onChange={set('company_website')} disabled={!isAdmin} />
      </Field>

      <div className="sm:col-span-2 mt-2 border-t border-slate-200 pt-4">
        <h2 className="card-title">Jam Kerja & Presensi</h2>
      </div>
      <Field label="Jam Masuk (HH:mm)" hint="Dasar kalkulasi keterlambatan">
        <input className="input" placeholder="08:00" value={settings.work_start || ''} onChange={set('work_start')} disabled={!isAdmin} />
      </Field>
      <Field label="Jam Pulang (HH:mm)">
        <input className="input" placeholder="17:00" value={settings.work_end || ''} onChange={set('work_end')} disabled={!isAdmin} />
      </Field>
      <Field label="Toleransi Terlambat (menit)" hint="Di atas ini presensi ditandai TERLAMBAT">
        <input type="number" min="0" className="input" value={settings.late_tolerance_minutes || ''} onChange={set('late_tolerance_minutes')} disabled={!isAdmin} />
      </Field>
      <Field label="Akurasi GPS Maksimal (meter)" hint="0 = nonaktifkan pemeriksaan akurasi">
        <input type="number" min="0" className="input" value={settings.max_gps_accuracy_m || ''} onChange={set('max_gps_accuracy_m')} disabled={!isAdmin} />
      </Field>
      <Field label="Zona Waktu" hint="mis. Asia/Jakarta">
        <input className="input" value={settings.timezone || ''} onChange={set('timezone')} disabled={!isAdmin} />
      </Field>
      <Field label="Mata Uang">
        <input className="input" value={settings.currency || ''} onChange={set('currency')} disabled={!isAdmin} />
      </Field>

      {isAdmin && (
        <div className="sm:col-span-2">
          <button type="submit" className="btn-primary" disabled={saving}>
            <Save size={16} /> {saving ? 'Menyimpan...' : 'Simpan Pengaturan'}
          </button>
        </div>
      )}
    </form>
  );
}

// ------------------------------------------------------------------
const EMPTY_OFFICE = { name: '', address: '', lat: '', lng: '', radius_m: 150, active: true };

function Offices({ canManage, isAdmin }) {
  const toast = useToast();
  const [offices, setOffices] = useState([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const d = await api.get('/api/admin/offices');
      setOffices(d.offices);
    } catch (err) {
      toast.error(err.message);
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => { load(); }, [load]);

  /** Mengisi koordinat dari GPS perangkat yang sedang dipakai. */
  function useMyLocation() {
    if (!navigator.geolocation) return toast.error('Browser tidak mendukung Geolocation');
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setEditing((prev) => ({
          ...prev,
          lat: pos.coords.latitude.toFixed(6),
          lng: pos.coords.longitude.toFixed(6),
        }));
        toast.success(`Koordinat terisi (akurasi ±${Math.round(pos.coords.accuracy)} m)`);
      },
      (err) => toast.error(`Gagal mengambil lokasi: ${err.message}`),
      { enableHighAccuracy: true, timeout: 15000 }
    );
  }

  async function save(e) {
    e.preventDefault();
    const payload = {
      ...editing,
      lat: Number(editing.lat),
      lng: Number(editing.lng),
      radius_m: Number(editing.radius_m),
    };
    try {
      if (editing.id) {
        await api.put(`/api/admin/offices/${editing.id}`, payload);
        toast.success('Titik kantor diperbarui');
      } else {
        await api.post('/api/admin/offices', payload);
        toast.success('Titik kantor ditambahkan');
      }
      setEditing(null);
      load();
    } catch (err) {
      toast.error(err.message);
    }
  }

  async function remove(o) {
    if (!window.confirm(`Hapus titik "${o.name}"?`)) return;
    try {
      await api.del(`/api/admin/offices/${o.id}`);
      toast.success('Titik kantor dihapus');
      load();
    } catch (err) {
      toast.error(err.message);
    }
  }

  if (loading) return <Spinner />;

  return (
    <div className="card">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="card-title">Titik Geofence WFO</h2>
        {canManage && (
          <button className="btn-primary !py-2" onClick={() => setEditing({ ...EMPTY_OFFICE })}>
            <Plus size={16} /> Tambah Titik
          </button>
        )}
      </div>

      {offices.length === 0 ? (
        <EmptyState message="Belum ada titik kantor" hint="Presensi WFO memerlukan minimal satu titik" />
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th>Nama</th><th>Alamat</th><th>Koordinat</th><th>Radius</th><th>Status</th>{canManage && <th></th>}</tr></thead>
            <tbody>
              {offices.map((o) => (
                <tr key={o.id}>
                  <td className="font-medium text-slate-900">{o.name}</td>
                  <td className="max-w-[240px] truncate text-xs text-slate-500">{o.address || '-'}</td>
                  <td className="tabular text-xs">
                    <a className="text-brand-600 underline" href={`https://www.google.com/maps?q=${o.lat},${o.lng}`} target="_blank" rel="noreferrer">
                      {o.lat.toFixed(6)}, {o.lng.toFixed(6)}
                    </a>
                  </td>
                  <td className="tabular">{o.radius_m} m</td>
                  <td>{o.active ? <span className="badge-green">aktif</span> : <span className="badge-slate">nonaktif</span>}</td>
                  {canManage && (
                    <td>
                      <div className="flex gap-1">
                        <button className="btn-ghost !px-2 !py-1" onClick={() => setEditing({ ...o, active: !!o.active })} aria-label="Ubah">
                          <Pencil size={14} />
                        </button>
                        {isAdmin && (
                          <button className="btn-ghost !px-2 !py-1 text-rose-600" onClick={() => remove(o)} aria-label="Hapus">
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
      )}

      <Modal open={!!editing} onClose={() => setEditing(null)} title={editing?.id ? 'Ubah Titik Kantor' : 'Titik Kantor Baru'}>
        {editing && (
          <form onSubmit={save} className="grid gap-3 sm:grid-cols-2">
            <Field label="Nama Lokasi *" className="sm:col-span-2">
              <input className="input" required placeholder="Kantor Pusat / Gudang Gombong" value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} />
            </Field>
            <Field label="Alamat" className="sm:col-span-2">
              <input className="input" value={editing.address || ''} onChange={(e) => setEditing({ ...editing, address: e.target.value })} />
            </Field>
            <Field label="Lintang (Latitude) *">
              <input type="number" step="any" className="input" required value={editing.lat} onChange={(e) => setEditing({ ...editing, lat: e.target.value })} />
            </Field>
            <Field label="Bujur (Longitude) *">
              <input type="number" step="any" className="input" required value={editing.lng} onChange={(e) => setEditing({ ...editing, lng: e.target.value })} />
            </Field>
            <div className="sm:col-span-2">
              <button type="button" className="btn-secondary w-full" onClick={useMyLocation}>
                <Crosshair size={16} /> Isi dari Lokasi Saya Sekarang
              </button>
            </div>
            <Field label="Radius Geofence (meter) *" hint="Presensi WFO ditolak di luar radius ini" className="sm:col-span-2">
              <input type="number" min="20" max="5000" className="input" required value={editing.radius_m} onChange={(e) => setEditing({ ...editing, radius_m: e.target.value })} />
            </Field>
            <label className="flex items-center gap-2 text-sm sm:col-span-2">
              <input type="checkbox" className="h-4 w-4 rounded" checked={editing.active} onChange={(e) => setEditing({ ...editing, active: e.target.checked })} />
              Titik aktif untuk validasi presensi
            </label>
            <p className="rounded-xl bg-brand-50 p-3 text-xs text-brand-800 sm:col-span-2">
              <MapPin size={13} className="mr-1 inline" />
              Tip: buka Google Maps, klik-kanan lokasi kantor, lalu salin koordinatnya ke kolom di atas.
            </p>
            <div className="flex gap-2 sm:col-span-2">
              <button type="button" className="btn-secondary flex-1" onClick={() => setEditing(null)}>Batal</button>
              <button type="submit" className="btn-primary flex-1">Simpan</button>
            </div>
          </form>
        )}
      </Modal>
    </div>
  );
}

// ------------------------------------------------------------------
const EMPTY_USER = {
  name: '', email: '', password: '', role: 'staff', position: '', phone: '', active: true,
  photo: null, nik: '', department: '', employment_status: '', join_date: '', birth_date: '',
  gender: '', address: '', emergency_name: '', emergency_phone: '',
  bank_name: '', bank_account: '', note: '',
};

const STATUS_KERJA = {
  TETAP: 'Karyawan Tetap',
  KONTRAK: 'Kontrak',
  MAGANG: 'Magang',
  HARIAN: 'Harian',
  MITRA: 'Mitra / Freelance',
};

/**
 * Kolom yang menentukan sebuah profil dianggap lengkap.
 * Sengaja hanya yang benar-benar dipakai: nomor induk untuk penggajian,
 * bagian untuk pembagian tugas, tanggal masuk untuk masa kerja, dan telepon
 * untuk dihubungi.
 */
const KOLOM_WAJIB_LENGKAP = ['nik', 'department', 'join_date', 'phone'];

const profilLengkap = (u) => KOLOM_WAJIB_LENGKAP.every((k) => u[k]);

function UsersTab({ isAdmin }) {
  const toast = useToast();
  const [users, setUsers] = useState([]);
  const [daftarPeran, setDaftarPeran] = useState([]);
  const [ringkas, setRingkas] = useState(null);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const d = await api.get('/api/admin/users');
      setUsers(d.users);
      setRingkas(d.ringkas || null);
    } catch (err) {
      toast.error(err.message);
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    api.get('/api/peran').then((d) => setDaftarPeran(d.roles)).catch(() => {});
  }, []);

  async function save(e) {
    e.preventDefault();
    const payload = { ...editing };
    if (!payload.password) delete payload.password;
    // Hanya dipakai untuk menampilkan gambar di layar, bukan kolom di peladen.
    delete payload.photoPratinjau;
    delete payload.created_at;
    try {
      if (editing.id) {
        await api.put(`/api/admin/users/${editing.id}`, payload);
        toast.success('Pengguna diperbarui');
      } else {
        await api.post('/api/admin/users', payload);
        toast.success('Pengguna ditambahkan');
      }
      setEditing(null);
      load();
    } catch (err) {
      toast.error(err.message);
    }
  }

  async function deactivate(u) {
    if (!window.confirm(`Nonaktifkan akun ${u.name}? Riwayat presensi & transaksinya tetap tersimpan.`)) return;
    try {
      const res = await api.del(`/api/admin/users/${u.id}`);
      toast.success(res.message);
      load();
    } catch (err) {
      toast.error(err.message);
    }
  }

  if (loading) return <Spinner />;

  return (
    <div className="card">
      <div className="mb-3 flex items-center justify-between">
        <div>
          <h2 className="card-title">Data Tim</h2>
          {ringkas && (
            <p className="mt-0.5 text-xs text-slate-500">
              {ringkas.aktif} aktif dari {ringkas.total} orang • {ringkas.berfoto} berfoto •{' '}
              <span className={ringkas.lengkap === ringkas.total ? 'text-emerald-600' : 'text-amber-600'}>
                {ringkas.lengkap} profil lengkap
              </span>
            </p>
          )}
        </div>
        <div className="flex gap-2">
          <TombolEkspor path="/api/admin/users" nama="data-tim" kecil />
          {isAdmin && (
            <button className="btn-primary !py-2" onClick={() => setEditing({ ...EMPTY_USER })}>
              <Plus size={16} /> Anggota Baru
            </button>
          )}
        </div>
      </div>

      <div className="table-wrap">
        <table className="table">
          <thead><tr><th></th><th>Nama</th><th>Bagian</th><th>Peran</th><th>Jabatan</th><th>Telepon</th><th>Status Kerja</th><th>Profil</th><th>Akun</th>{isAdmin && <th></th>}</tr></thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.id}>
                <td>
                  <GambarTerlindungi
                    berkas={u.photo}
                    alt={u.name}
                    className="h-9 w-9 rounded-full object-cover"
                    fallback={
                      <div className="grid h-9 w-9 place-items-center rounded-full bg-slate-100 text-xs font-bold text-slate-400">
                        {u.name.trim().charAt(0).toUpperCase()}
                      </div>
                    }
                  />
                </td>
                <td>
                  <p className="font-medium text-slate-900">{u.name}</p>
                  <p className="text-xs text-slate-500">{u.email}</p>
                </td>
                <td className="text-sm">{u.department || <span className="text-slate-400">belum diisi</span>}</td>
                <td>
                  <span className={u.role_slug === 'admin' ? 'badge-blue' : u.role_slug === 'manager' ? 'badge-amber' : 'badge-slate'}>
                    {u.role_name || u.role}
                  </span>
                </td>
                <td className="text-sm">{u.position || '-'}</td>
                <td className="text-sm">{u.phone || '-'}</td>
                <td className="text-xs">{STATUS_KERJA[u.employment_status] || <span className="text-slate-400">-</span>}</td>
                <td>
                  {profilLengkap(u)
                    ? <span className="badge-green">lengkap</span>
                    : <span className="badge-amber">perlu dilengkapi</span>}
                </td>
                <td>{u.active ? <span className="badge-green">aktif</span> : <span className="badge-slate">nonaktif</span>}</td>
                {isAdmin && (
                  <td>
                    <div className="flex gap-1">
                      <button className="btn-ghost !px-2 !py-1" onClick={() => setEditing({ ...u, password: '', active: !!u.active, photoPratinjau: undefined, role_id: u.role_id || '' })} aria-label="Ubah">
                        <Pencil size={14} />
                      </button>
                      <button className="btn-ghost !px-2 !py-1 text-rose-600" onClick={() => deactivate(u)} aria-label="Nonaktifkan">
                        <Trash2 size={14} />
                      </button>
                    </div>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <Modal open={!!editing} onClose={() => setEditing(null)} title={editing?.id ? 'Ubah Pengguna' : 'Pengguna Baru'}>
        {editing && (
          <form onSubmit={save} className="grid gap-3 sm:grid-cols-2">
            <Field label="Nama Lengkap *" className="sm:col-span-2">
              <input className="input" required value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} />
            </Field>
            <Field label="Email *" className="sm:col-span-2">
              <input type="email" className="input" required value={editing.email} onChange={(e) => setEditing({ ...editing, email: e.target.value })} />
            </Field>
            <Field
              label={editing.id ? 'Password Baru' : 'Password *'}
              hint={editing.id ? 'Kosongkan bila tidak diubah' : 'Minimal 8 karakter'}
              className="sm:col-span-2"
            >
              <input
                type="password" className="input" minLength={editing.id ? 0 : 8}
                required={!editing.id} autoComplete="new-password"
                value={editing.password} onChange={(e) => setEditing({ ...editing, password: e.target.value })}
              />
            </Field>
            <Field label="Peran *" hint="Menentukan menu dan aktivitas yang boleh diakses">
              <select
                className="input"
                value={editing.role_id || ''}
                onChange={(e) => {
                  const id = e.target.value ? Number(e.target.value) : null;
                  const p = daftarPeran.find((x) => x.id === id);
                  // Kolom role lama ikut disesuaikan agar akun tetap masuk akal
                  // bila suatu saat dibaca tanpa melalui tabel peran.
                  const lama = p && p.slug === 'admin' ? 'admin' : p && p.slug === 'manager' ? 'manager' : 'staff';
                  setEditing({ ...editing, role_id: id, role: lama });
                }}
              >
                <option value="">— pilih peran —</option>
                {daftarPeran.filter((p) => p.active).map((p) => (
                  <option key={p.id} value={p.id}>{p.name}</option>
                ))}
              </select>
            </Field>
            <Field label="Jabatan">
              <input className="input" value={editing.position || ''} onChange={(e) => setEditing({ ...editing, position: e.target.value })} />
            </Field>
            <Field label="Telepon" className="sm:col-span-2">
              <input className="input" value={editing.phone || ''} onChange={(e) => setEditing({ ...editing, phone: e.target.value })} />
            </Field>
            <div className="sm:col-span-2 mt-1 border-t border-slate-200 pt-3">
              <h3 className="mb-3 text-sm font-bold text-slate-800">Data Kepegawaian</h3>
              <div className="flex items-start gap-4">
                {/* Foto yang sudah tersimpan ditampilkan terpisah karena berkasnya
                    dilindungi dan tidak bisa dipasang langsung sebagai src. */}
                {editing.photo && editing.photoPratinjau === undefined && (
                  <GambarTerlindungi
                    berkas={editing.photo}
                    alt={editing.name}
                    className="h-20 w-20 rounded-full border border-slate-200 object-cover"
                  />
                )}
                <UnggahGambar
                  label="Foto"
                  bentuk="bulat"
                  ukuranMaks={400}
                  nilai={editing.photoPratinjau || null}
                  onChange={(v) => setEditing({ ...editing, photo: v, photoPratinjau: v })}
                  hint={editing.photo && editing.photoPratinjau === undefined
                    ? 'Foto saat ini di sebelah kiri — pilih gambar untuk menggantinya'
                    : 'Tampil di daftar tim dan rekap presensi'}
                />
              </div>
            </div>

            <Field label="Nomor Induk (NIK)">
              <input className="input" value={editing.nik || ''} onChange={(e) => setEditing({ ...editing, nik: e.target.value })} />
            </Field>
            <Field label="Bagian / Divisi">
              <input className="input" placeholder="Gudang, Penjualan, Keuangan" value={editing.department || ''} onChange={(e) => setEditing({ ...editing, department: e.target.value })} />
            </Field>
            <Field label="Status Kerja">
              <select className="input" value={editing.employment_status || ''} onChange={(e) => setEditing({ ...editing, employment_status: e.target.value })}>
                <option value="">— belum diisi —</option>
                {Object.entries(STATUS_KERJA).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </select>
            </Field>
            <Field label="Tanggal Masuk">
              <input type="date" className="input" value={editing.join_date || ''} onChange={(e) => setEditing({ ...editing, join_date: e.target.value })} />
            </Field>
            <Field label="Tanggal Lahir">
              <input type="date" className="input" value={editing.birth_date || ''} onChange={(e) => setEditing({ ...editing, birth_date: e.target.value })} />
            </Field>
            <Field label="Jenis Kelamin">
              <select className="input" value={editing.gender || ''} onChange={(e) => setEditing({ ...editing, gender: e.target.value })}>
                <option value="">— belum diisi —</option>
                <option value="L">Laki-laki</option>
                <option value="P">Perempuan</option>
              </select>
            </Field>
            <Field label="Alamat" className="sm:col-span-2">
              <input className="input" value={editing.address || ''} onChange={(e) => setEditing({ ...editing, address: e.target.value })} />
            </Field>
            <Field label="Kontak Darurat" hint="Nama orang yang dihubungi bila terjadi sesuatu">
              <input className="input" value={editing.emergency_name || ''} onChange={(e) => setEditing({ ...editing, emergency_name: e.target.value })} />
            </Field>
            <Field label="Telepon Kontak Darurat">
              <input className="input" value={editing.emergency_phone || ''} onChange={(e) => setEditing({ ...editing, emergency_phone: e.target.value })} />
            </Field>
            <Field label="Nama Bank" hint="Untuk pembayaran gaji">
              <input className="input" value={editing.bank_name || ''} onChange={(e) => setEditing({ ...editing, bank_name: e.target.value })} />
            </Field>
            <Field label="Nomor Rekening">
              <input className="input" value={editing.bank_account || ''} onChange={(e) => setEditing({ ...editing, bank_account: e.target.value })} />
            </Field>
            <Field label="Catatan" className="sm:col-span-2">
              <input className="input" value={editing.note || ''} onChange={(e) => setEditing({ ...editing, note: e.target.value })} />
            </Field>

            <label className="flex items-center gap-2 text-sm sm:col-span-2">
              <input type="checkbox" className="h-4 w-4 rounded" checked={editing.active} onChange={(e) => setEditing({ ...editing, active: e.target.checked })} />
              Akun aktif dan dapat login
            </label>
            <div className="flex gap-2 sm:col-span-2">
              <button type="button" className="btn-secondary flex-1" onClick={() => setEditing(null)}>Batal</button>
              <button type="submit" className="btn-primary flex-1">Simpan</button>
            </div>
          </form>
        )}
      </Modal>
    </div>
  );
}

// ------------------------------------------------------------------
function MyAccount() {
  const toast = useToast();
  const { user } = useAuth();
  const [form, setForm] = useState({ currentPassword: '', newPassword: '', confirm: '' });
  const [saving, setSaving] = useState(false);

  async function save(e) {
    e.preventDefault();
    if (form.newPassword !== form.confirm) return toast.error('Konfirmasi password tidak cocok');
    setSaving(true);
    try {
      const res = await api.post('/api/auth/change-password', {
        currentPassword: form.currentPassword,
        newPassword: form.newPassword,
      });
      toast.success(res.message);
      setForm({ currentPassword: '', newPassword: '', confirm: '' });
    } catch (err) {
      toast.error(err.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="grid max-w-3xl gap-4 sm:grid-cols-2">
      <div className="card">
        <h2 className="card-title mb-3">Profil</h2>
        <dl className="space-y-2 text-sm">
          <div className="flex justify-between"><dt className="text-slate-500">Nama</dt><dd className="font-medium">{user.name}</dd></div>
          <div className="flex justify-between"><dt className="text-slate-500">Email</dt><dd className="font-medium">{user.email}</dd></div>
          <div className="flex justify-between"><dt className="text-slate-500">Peran</dt><dd className="font-medium capitalize">{user.role}</dd></div>
          <div className="flex justify-between"><dt className="text-slate-500">Jabatan</dt><dd className="font-medium">{user.position || '-'}</dd></div>
        </dl>
      </div>

      <form onSubmit={save} className="card">
        <h2 className="card-title mb-3">Ganti Password</h2>
        <Field label="Password Saat Ini *" className="mb-3">
          <input type="password" className="input" required autoComplete="current-password" value={form.currentPassword} onChange={(e) => setForm({ ...form, currentPassword: e.target.value })} />
        </Field>
        <Field label="Password Baru *" hint="Minimal 8 karakter" className="mb-3">
          <input type="password" className="input" required minLength={8} autoComplete="new-password" value={form.newPassword} onChange={(e) => setForm({ ...form, newPassword: e.target.value })} />
        </Field>
        <Field label="Konfirmasi Password Baru *" className="mb-4">
          <input type="password" className="input" required minLength={8} autoComplete="new-password" value={form.confirm} onChange={(e) => setForm({ ...form, confirm: e.target.value })} />
        </Field>
        <button type="submit" className="btn-primary w-full" disabled={saving}>
          <KeyRound size={16} /> {saving ? 'Menyimpan...' : 'Perbarui Password'}
        </button>
      </form>
    </div>
  );
}
