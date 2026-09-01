import { useState } from 'react';
import { NAMA_APP, MODUL_APP } from '../lib/brand';
import { LogoPerusahaan, useBranding } from '../lib/branding';
import { LogIn, Loader2, Eye, EyeOff } from 'lucide-react';
import { useAuth } from '../lib/auth';
import { useToast } from '../components/ui';
import LatarMasuk from '../components/LatarMasuk';

export default function Login() {
  const identitas = useBranding();
  const { login } = useAuth();
  const toast = useToast();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e) {
    e.preventDefault();
    setBusy(true);
    try {
      const user = await login(email, password);
      toast.success(`Selamat datang, ${user.name}`);
    } catch (err) {
      toast.error(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="relative grid min-h-screen place-items-center overflow-hidden px-4 py-10">
      <LatarMasuk gambar={identitas.latar || []} />

      <div className="relative w-full max-w-md">
        <div className="mb-6 text-center">
          <div className="mx-auto mb-3 w-fit rounded-2xl shadow-lg">
            <LogoPerusahaan ukuran={72} className="!rounded-2xl" />
          </div>
          <h1 className="text-2xl font-bold text-white drop-shadow-md">
            {identitas.company || NAMA_APP}
          </h1>
          <p className="mt-1 text-sm text-slate-200 drop-shadow">
            {identitas.tagline || MODUL_APP}
          </p>
        </div>

        <form onSubmit={onSubmit} className="rounded-2xl bg-surface/95 p-6 shadow-2xl backdrop-blur-md">
          <div className="mb-4">
            <label className="label" htmlFor="email">Email</label>
            <input
              id="email" type="email" className="input" required autoComplete="username"
              placeholder="nama@perusahaan.com"
              value={email} onChange={(e) => setEmail(e.target.value)}
            />
          </div>

          <div className="mb-5">
            <label className="label" htmlFor="password">Password</label>
            <div className="relative">
              <input
                id="password" type={show ? 'text' : 'password'} className="input pr-11" required
                autoComplete="current-password" placeholder="••••••••"
                value={password} onChange={(e) => setPassword(e.target.value)}
              />
              <button
                type="button" onClick={() => setShow((s) => !s)}
                className="absolute inset-y-0 right-0 grid w-11 place-items-center text-slate-400 hover:text-slate-600"
                aria-label={show ? 'Sembunyikan password' : 'Tampilkan password'}
              >
                {show ? <EyeOff size={17} /> : <Eye size={17} />}
              </button>
            </div>
          </div>

          <button type="submit" className="btn-primary w-full" disabled={busy}>
            {busy ? <Loader2 size={17} className="animate-spin" /> : <LogIn size={17} />}
            {busy ? 'Memproses...' : 'Masuk'}
          </button>
        </form>

        <p className="mt-5 text-center text-xs text-slate-200 drop-shadow">
          Silahkan Hubungi Tim Manajer Jika Anda Belom Memiliki Akun
        </p>
      </div>
    </div>
  );
}
