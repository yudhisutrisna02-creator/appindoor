import { createContext, useContext, useEffect, useMemo, useState, useCallback } from 'react';
import { api, setToken, clearToken, getToken, setUnauthorizedHandler } from './api';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [izin, setIzin] = useState([]);
  const [loading, setLoading] = useState(true);

  const logout = useCallback(() => {
    clearToken();
    setUser(null);
    setIzin([]);
  }, []);

  /**
   * Izin diambil dari peladen, bukan disimpulkan dari nama peran di sisi
   * peramban. Peran bisa disusun ulang kapan saja, dan menyimpulkannya di layar
   * berarti tampilan bisa menjanjikan tombol yang justru ditolak peladen.
   */
  const muatIzin = useCallback(async () => {
    try {
      const d = await api.get('/api/peran/saya');
      setIzin(d.permissions || []);
    } catch {
      setIzin([]);
    }
  }, []);

  // Token kedaluwarsa di sisi server -> paksa kembali ke layar login.
  useEffect(() => {
    setUnauthorizedHandler(() => setUser(null));
  }, []);

  // Memulihkan sesi dari token yang tersimpan saat aplikasi dimuat.
  useEffect(() => {
    if (!getToken()) {
      setLoading(false);
      return;
    }
    api
      .get('/api/auth/me')
      .then(async (d) => {
        setUser(d.user);
        await muatIzin();
      })
      .catch(() => clearToken())
      .finally(() => setLoading(false));
  }, []);

  const login = useCallback(async (email, password) => {
    const data = await api.post('/api/auth/login', { email, password });
    setToken(data.token);
    setUser(data.user);
    await muatIzin();
    return data.user;
  }, [muatIzin]);

  const value = useMemo(() => {
    const punya = (...kunci) => kunci.some((k) => izin.includes(k));
    return {
      user,
      loading,
      login,
      logout,
      izin,
      /** Apakah pengguna memegang salah satu izin yang disebut. */
      punya,
      // Dua penanda lama dipertahankan agar layar yang belum beralih tetap
      // bekerja, tetapi keduanya kini bersandar pada izin, bukan nama peran.
      isAdmin: punya('sistem.peran'),
      canManage: punya('penjualan.ubah', 'gudang.produk', 'keuangan.kas', 'iklan.kelola', 'mitra.kelola'),
    };
  }, [user, loading, login, logout, izin]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth harus dipakai di dalam AuthProvider');
  return ctx;
}
