import { useState } from 'react';
import { Scale, AlertTriangle } from 'lucide-react';
import { api } from '../lib/api';
import { useToast, Field } from './ui';
import { rupiah, today } from '../lib/format';
import { useAuth } from '../lib/auth';

/**
 * Koreksi stok satu produk, langsung dari layar produk.
 *
 * Dipakai saat angka stoknya memang salah — salah ketik saat memasukkan barang,
 * atau mutasi yang terlanjur tercatat dua kali — sehingga mengarang mutasi
 * masuk/keluar untuk membetulkannya justru menambah catatan yang tidak pernah
 * terjadi.
 *
 * Angkanya tidak ditimpa diam-diam. Selisihnya dicatat sebagai koreksi pada
 * kartu stok beserta jurnalnya, sama seperti selisih stok opname — kalau tidak,
 * kartu stok tidak bisa menjelaskan dari mana angka barunya datang, dan nilai
 * Persediaan di neraca berbeda dari valuasi gudang tanpa ada tanda apa pun.
 */
export default function KoreksiStok({ produk, onSelesai }) {
  const toast = useToast();
  const { punya } = useAuth();
  const [buka, setBuka] = useState(false);
  const [stok, setStok] = useState(String(produk.stock ?? 0));
  const [tanggal, setTanggal] = useState(today());
  const [alasan, setAlasan] = useState('');
  const [kirim, setKirim] = useState(false);

  // Koreksi stok memindahkan nilai persediaan di neraca, jadi wewenangnya
  // disamakan dengan stok opname — bukan sekadar boleh mengubah data produk.
  if (!punya('gudang.opname')) return null;

  const lama = Number(produk.stock) || 0;
  const baru = Number(stok);
  const selisih = Number.isFinite(baru) ? baru - lama : 0;
  const nilaiSelisih = selisih * (Number(produk.cost) || 0);
  const siap = Number.isFinite(baru) && baru >= 0 && selisih !== 0 && alasan.trim().length > 0;

  async function simpan() {
    setKirim(true);
    try {
      const res = await api.post(`/api/inventory/products/${produk.id}/koreksi-stok`, {
        stock: baru,
        move_date: tanggal,
        note: alasan.trim(),
      });
      toast.success(res.message);
      setBuka(false);
      setAlasan('');
      if (onSelesai) onSelesai(res.product);
    } catch (err) {
      toast.error(err.message);
    } finally {
      setKirim(false);
    }
  }

  return (
    <div className="sm:col-span-2 rounded-xl bg-slate-50 px-3 py-3 ring-1 ring-slate-200 dark:bg-slate-400/10">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="text-sm">
          <span className="font-medium text-slate-900">Stok Saat Ini</span>
          <span className="ml-2 tabular font-bold text-slate-900">
            {lama} {produk.unit}
          </span>
          <span className="ml-2 text-xs text-slate-500">senilai {rupiah(lama * (produk.cost || 0))}</span>
        </div>

        {!buka && (
          <button type="button" className="btn-secondary !py-1.5 !text-xs" onClick={() => setBuka(true)}>
            <Scale size={14} /> Koreksi Stok
          </button>
        )}
      </div>

      {buka && (
        <div className="mt-3 border-t border-slate-200 pt-3">
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label="Stok Seharusnya *">
              <input
                type="number" min="0" step="any" className="input"
                value={stok} onChange={(e) => setStok(e.target.value)}
              />
            </Field>
            <Field label="Tanggal Koreksi *">
              <input
                type="date" className="input"
                value={tanggal} onChange={(e) => setTanggal(e.target.value)}
              />
            </Field>
            <Field label="Alasan *" hint="Wajib — akan tercatat di kartu stok">
              <input
                className="input" maxLength={200} placeholder="mis. salah input saat barang masuk"
                value={alasan} onChange={(e) => setAlasan(e.target.value)}
              />
            </Field>
          </div>

          {selisih !== 0 && Number.isFinite(baru) && (
            <p className={`mt-2 text-xs font-medium ${selisih > 0 ? 'text-emerald-700' : 'text-rose-700'}`}>
              {selisih > 0 ? 'Menambah' : 'Mengurangi'} {Math.abs(selisih)} {produk.unit}
              {' '}({rupiah(Math.abs(nilaiSelisih))}) — {lama} → {baru} {produk.unit}
            </p>
          )}

          <div className="mt-2 flex items-start gap-2 text-xs leading-relaxed text-slate-600">
            <AlertTriangle size={14} className="mt-0.5 shrink-0 text-amber-600" />
            <span>
              Koreksi ini tercatat di kartu stok dan pembukuan, bukan mengganti angkanya
              diam-diam. Selisih nilainya masuk akun Selisih Stok — sama seperti selisih
              stok opname.
            </span>
          </div>

          <div className="mt-3 flex gap-2">
            <button
              type="button" className="btn-secondary !py-1.5 !text-xs"
              onClick={() => { setBuka(false); setStok(String(produk.stock ?? 0)); setAlasan(''); }}
            >
              Batal
            </button>
            <button
              type="button" className="btn-primary !py-1.5 !text-xs"
              onClick={simpan} disabled={!siap || kirim}
            >
              {kirim ? 'Menyimpan...' : 'Simpan Koreksi'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
