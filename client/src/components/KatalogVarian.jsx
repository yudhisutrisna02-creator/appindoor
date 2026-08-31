import { useEffect, useState, useCallback } from 'react';
import { Plus, Trash2, Pencil, Check, X } from 'lucide-react';
import { api } from '../lib/api';
import { useToast } from './ui';

/**
 * Pengelola katalog varian satu produk.
 *
 * Varian BUKAN produk: ia tidak punya stok, HPP, maupun harga sendiri — hanya
 * pilihan nama di bawah satu produk induk. Karena itu ia dikelola di sini,
 * menempel pada produknya, bukan sebagai daftar produk tersendiri.
 *
 * Hanya muncul untuk produk yang ditandai dijual tanpa label; untuk produk
 * biasa, katalog varian tidak pernah dipakai sehingga menampilkannya hanya
 * menambah kebingungan.
 */
export default function KatalogVarian({ productId, bolehUbah = true }) {
  const toast = useToast();
  const [rows, setRows] = useState(null);
  const [baru, setBaru] = useState('');
  const [ubah, setUbah] = useState(null);
  const [sibuk, setSibuk] = useState(false);

  const load = useCallback(async () => {
    if (!productId) return setRows([]);
    try {
      const d = await api.get(`/api/inventory/products/${productId}/variants`);
      setRows(d.rows);
    } catch (err) {
      toast.error(err.message);
      setRows([]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [productId]);

  useEffect(() => { load(); }, [load]);

  async function tambah(e) {
    e.preventDefault();
    if (!baru.trim()) return;
    setSibuk(true);
    try {
      await api.post(`/api/inventory/products/${productId}/variants`, { nama: baru.trim() });
      setBaru('');
      load();
    } catch (err) {
      toast.error(err.message);
    } finally {
      setSibuk(false);
    }
  }

  async function simpanUbah() {
    setSibuk(true);
    try {
      await api.put(`/api/inventory/variants/${ubah.id}`, {
        nama: ubah.nama.trim(), active: !!ubah.active,
      });
      setUbah(null);
      load();
    } catch (err) {
      toast.error(err.message);
    } finally {
      setSibuk(false);
    }
  }

  async function hapus(v) {
    if (!window.confirm(`Hapus varian ${v.nama}?`)) return;
    try {
      const res = await api.del(`/api/inventory/variants/${v.id}`);
      toast.success(res.message);
      load();
    } catch (err) {
      toast.error(err.message);
    }
  }

  async function togglePakai(v) {
    try {
      await api.put(`/api/inventory/variants/${v.id}`, { nama: v.nama, active: !v.active });
      load();
    } catch (err) {
      toast.error(err.message);
    }
  }

  if (!productId) {
    return (
      <p className="rounded-xl bg-slate-50 px-3 py-2 text-xs text-slate-600">
        Simpan produknya dulu, baru daftar variannya bisa diisi.
      </p>
    );
  }

  if (rows === null) {
    return <p className="rounded-xl bg-slate-50 px-3 py-2 text-xs text-slate-500">Memuat varian...</p>;
  }

  const aktif = rows.filter((r) => r.active).length;

  return (
    <div className="rounded-xl bg-slate-50 p-3">
      <div className="mb-2 flex items-center justify-between gap-2">
        <p className="text-sm font-medium text-slate-900">
          Katalog Varian
          <span className="ml-2 text-xs font-normal text-slate-500">
            {aktif} aktif dari {rows.length}
          </span>
        </p>
      </div>

      {rows.length === 0 ? (
        <p className="mb-2 text-xs text-slate-500">
          Belum ada varian. Tambahkan di bawah — varian inilah yang muncul sebagai pilihan saat
          produk ini dipesan.
        </p>
      ) : (
        <ul className="mb-2 max-h-56 space-y-1 overflow-y-auto">
          {rows.map((v) => (
            <li key={v.id} className="flex items-center gap-2 rounded-lg bg-surface px-2 py-1 text-sm">
              {ubah && ubah.id === v.id ? (
                <>
                  <input
                    className="input !py-1 flex-1" value={ubah.nama} maxLength={120}
                    onChange={(e) => setUbah({ ...ubah, nama: e.target.value })}
                  />
                  <button type="button" className="btn-ghost !px-2 !py-1 text-emerald-600"
                    onClick={simpanUbah} disabled={sibuk} aria-label="Simpan">
                    <Check size={14} />
                  </button>
                  <button type="button" className="btn-ghost !px-2 !py-1"
                    onClick={() => setUbah(null)} aria-label="Batal">
                    <X size={14} />
                  </button>
                </>
              ) : (
                <>
                  <span className={`flex-1 ${v.active ? 'text-slate-800' : 'text-slate-400 line-through'}`}>
                    {v.nama}
                  </span>
                  {bolehUbah && (
                    <>
                      <button
                        type="button" className="btn-ghost !px-2 !py-1 text-xs"
                        onClick={() => togglePakai(v)}
                      >
                        {v.active ? 'Nonaktifkan' : 'Aktifkan'}
                      </button>
                      <button type="button" className="btn-ghost !px-2 !py-1"
                        onClick={() => setUbah({ id: v.id, nama: v.nama, active: v.active })}
                        aria-label="Ubah nama">
                        <Pencil size={13} />
                      </button>
                      <button type="button" className="btn-ghost !px-2 !py-1 text-rose-600"
                        onClick={() => hapus(v)} aria-label="Hapus">
                        <Trash2 size={13} />
                      </button>
                    </>
                  )}
                </>
              )}
            </li>
          ))}
        </ul>
      )}

      {bolehUbah && (
        <div className="flex gap-2">
          <input
            className="input !py-1.5 flex-1" placeholder="Nama varian baru, mis. GPN- Mangga"
            value={baru} maxLength={120}
            onChange={(e) => setBaru(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); tambah(e); } }}
          />
          <button type="button" className="btn-secondary !px-3 !py-1.5 text-sm"
            onClick={tambah} disabled={sibuk || !baru.trim()}>
            <Plus size={14} /> Tambah
          </button>
        </div>
      )}

      <p className="mt-2 text-xs leading-relaxed text-slate-500">
        Varian tidak punya stok sendiri — stoknya tetap milik produk ini. Varian yang sudah pernah
        dipakai pesanan tidak bisa dihapus, hanya dinonaktifkan, supaya pesanan lama tetap
        menyebutkan varian yang memang dikirim.
      </p>
    </div>
  );
}
