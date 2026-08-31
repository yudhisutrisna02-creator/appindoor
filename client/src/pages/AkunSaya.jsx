import { useEffect, useState, useCallback } from 'react';
import { UserCircle, KeyRound, ShieldCheck, AlertTriangle, Check, X } from 'lucide-react';
import { api } from '../lib/api';
import { PageHeader, Spinner, useToast, Field } from '../components/ui';
import UnggahGambar from '../components/UnggahGambar';
import { dateID } from '../lib/format';

/** Syarat kata sandi diperiksa juga di layar supaya terlihat sambil mengetik. */
const CEK = [
  { label: 'minimal 8 karakter', uji: (s) => s.length >= 8 },
  { label: 'ada huruf kecil', uji: (s) => /[a-z]/.test(s) },
  { label: 'ada huruf besar', uji: (s) => /[A-Z]/.test(s) },
  { label: 'ada angka', uji: (s) => /[0-9]/.test(s) },
  { label: 'ada simbol', uji: (s) => /[^A-Za-z0-9]/.test(s) },
];

/**
 * Akun Saya.
 *
 * Terbuka untuk semua peran tanpa izin tambahan — setiap orang perlu bisa
 * mengurus fotonya dan kata sandinya sendiri, apa pun pekerjaannya.
 *
 * Yang bisa disentuh di sini hanya milik pengguna itu sendiri. Nama, email,
 * jabatan, dan peran sengaja hanya ditampilkan: mengubahnya berarti mengubah
 * identitas dan hak akses, dan itu urusan pengelola tim.
 */
export default function AkunSaya({ wajibGanti = false, onSelesai }) {
  const toast = useToast();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [foto, setFoto] = useState(null);
  const [phone, setPhone] = useState('');
  const [simpanProfil, setSimpanProfil] = useState(false);

  const [lama, setLama] = useState('');
  const [baru, setBaru] = useState('');
  const [ulang, setUlang] = useState('');
  const [simpanSandi, setSimpanSandi] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const d = await api.get('/api/auth/akun');
      setData(d);
      setFoto(d.user.photo || null);
      setPhone(d.user.phone || '');
    } catch (err) {
      toast.error(err.message);
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => { load(); }, [load]);

  async function kirimProfil(e) {
    e.preventDefault();
    setSimpanProfil(true);
    try {
      const res = await api.put('/api/auth/akun', { phone: phone || null, photo: foto });
      toast.success(res.message);
      load();
    } catch (err) {
      toast.error(err.message);
    } finally {
      setSimpanProfil(false);
    }
  }

  async function kirimSandi(e) {
    e.preventDefault();
    if (baru !== ulang) return toast.error('Ketikan ulang kata sandi belum sama');

    setSimpanSandi(true);
    try {
      const res = await api.post('/api/auth/ganti-sandi', {
        currentPassword: lama, newPassword: baru,
      });
      toast.success(res.message);
      setLama(''); setBaru(''); setUlang('');
      await load();
      // Setelah kewajiban terpenuhi, aplikasi bisa dibuka seperti biasa.
      if (wajibGanti && onSelesai) onSelesai();
    } catch (err) {
      toast.error(err.message);
    } finally {
      setSimpanSandi(false);
    }
  }

  if (loading || !data) return <Spinner label="Memuat akun..." />;

  const u = data.user;
  const s = data.sandi;
  const kurang = CEK.filter((c) => !c.uji(baru));
  const sandiSiap = baru.length > 0 && kurang.length === 0 && baru === ulang && lama.length > 0;

  return (
    <div className={wajibGanti ? 'mx-auto max-w-3xl px-4 py-8' : ''}>
      <PageHeader
        title="Akun Saya"
        subtitle={`${u.name} • ${u.peran_nama || u.role}${u.position ? ` • ${u.position}` : ''}`}
      />

      {s.wajib && (
        <div className="card mb-4 border-2 border-rose-200 bg-rose-50/60 dark:bg-rose-400/10">
          <div className="flex items-start gap-2">
            <AlertTriangle size={18} className="mt-0.5 shrink-0 text-rose-600" />
            <div className="text-sm text-slate-700">
              <p className="font-semibold text-slate-900">Kata sandi wajib diganti</p>
              <p className="mt-1 text-xs leading-relaxed">{s.pesan}</p>
              <p className="mt-1 text-xs leading-relaxed">
                Menu lain terkunci sampai kata sandi baru tersimpan.
              </p>
            </div>
          </div>
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        {/* ---------- Profil ---------- */}
        <form onSubmit={kirimProfil} className="card">
          <h2 className="card-title mb-3 flex items-center gap-2">
            <UserCircle size={16} /> Profil
          </h2>

          <div className="mb-3">
            <label className="label">Foto Diri</label>
            <UnggahGambar nilai={foto} onChange={setFoto} bentuk="bulat" label="" />
            {!foto && (
              <p className="mt-1 text-xs text-rose-600">
                Foto wajib diisi — dipakai pada presensi dan data tim.
              </p>
            )}
          </div>

          <Field label="Nomor HP" hint="Dipakai bila ada yang perlu menghubungi Anda">
            <input
              className="input" value={phone} maxLength={30}
              onChange={(e) => setPhone(e.target.value)}
            />
          </Field>

          <dl className="mt-3 space-y-1 rounded-xl bg-slate-50 px-3 py-2 text-sm">
            {[
              ['Nama', u.name],
              ['Email', u.email],
              ['Peran', u.peran_nama || u.role],
              ['Jabatan', u.position],
              ['Bagian', u.department],
              ['NIK', u.nik],
              ['Bergabung', u.join_date ? dateID(u.join_date) : null],
            ].filter(([, v]) => v).map(([k, v]) => (
              <div key={k} className="flex justify-between gap-3">
                <dt className="text-slate-500">{k}</dt>
                <dd className="font-medium text-slate-800">{v}</dd>
              </div>
            ))}
          </dl>
          <p className="mt-2 text-xs leading-relaxed text-slate-500">
            Nama, email, peran, dan jabatan hanya bisa diubah pengelola tim — mengubahnya berarti
            mengubah identitas dan hak akses.
          </p>

          <button type="submit" className="btn-primary mt-3 w-full" disabled={simpanProfil}>
            {simpanProfil ? 'Menyimpan...' : 'Simpan Profil'}
          </button>
        </form>

        {/* ---------- Kata sandi ---------- */}
        <form onSubmit={kirimSandi} className="card">
          <h2 className="card-title mb-3 flex items-center gap-2">
            <KeyRound size={16} /> Ganti Kata Sandi
          </h2>

          <div className="grid gap-3">
            <Field label="Kata Sandi Saat Ini *">
              <input
                type="password" className="input" required autoComplete="current-password"
                value={lama} onChange={(e) => setLama(e.target.value)}
              />
            </Field>
            <Field label="Kata Sandi Baru *">
              <input
                type="password" className="input" required autoComplete="new-password"
                value={baru} onChange={(e) => setBaru(e.target.value)}
              />
            </Field>
            <Field label="Ketik Ulang Kata Sandi Baru *">
              <input
                type="password" className="input" required autoComplete="new-password"
                value={ulang} onChange={(e) => setUlang(e.target.value)}
              />
            </Field>
          </div>

          {/* Syaratnya ditunjukkan sambil mengetik, bukan baru saat ditolak —
              menebak-nebak apa yang kurang adalah cara tercepat membuat orang
              memilih kata sandi yang buruk tetapi lolos. */}
          <ul className="mt-3 space-y-1">
            {CEK.map((c) => {
              const lolos = baru.length > 0 && c.uji(baru);
              return (
                <li key={c.label} className={`flex items-center gap-2 text-xs ${
                  lolos ? 'text-emerald-700' : 'text-slate-500'
                }`}>
                  {lolos ? <Check size={13} /> : <X size={13} className="text-slate-300" />}
                  {c.label}
                </li>
              );
            })}
            <li className={`flex items-center gap-2 text-xs ${
              ulang.length > 0 && baru === ulang ? 'text-emerald-700' : 'text-slate-500'
            }`}>
              {ulang.length > 0 && baru === ulang
                ? <Check size={13} /> : <X size={13} className="text-slate-300" />}
              ketikan ulang sama
            </li>
          </ul>

          <button type="submit" className="btn-primary mt-3 w-full" disabled={simpanSandi || !sandiSiap}>
            {simpanSandi ? 'Menyimpan...' : 'Ganti Kata Sandi'}
          </button>

          <div className="mt-3 flex items-start gap-2 rounded-xl bg-slate-50 px-3 py-2 text-xs text-slate-600">
            <ShieldCheck size={14} className="mt-0.5 shrink-0 text-slate-500" />
            <span>
              Kata sandi berlaku {data.masaBerlakuHari} hari.
              {!s.wajib && s.sisaHari !== undefined && (
                <> Terakhir diganti {s.umurHari} hari lalu — wajib diganti lagi dalam {s.sisaHari} hari.</>
              )}
            </span>
          </div>
        </form>
      </div>
    </div>
  );
}
