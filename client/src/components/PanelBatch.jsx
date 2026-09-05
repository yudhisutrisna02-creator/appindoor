import { useEffect, useState, useCallback } from 'react';
import { CalendarClock, Pencil, Check, X, AlertTriangle } from 'lucide-react';
import { api } from '../lib/api';
import { useToast } from './ui';
import { rupiah, dateID } from '../lib/format';

/** Sisa hari menuju kadaluarsa, atau null bila tanggalnya belum diisi. */
function sisaHari(tanggal) {
  if (!tanggal) return null;
  const beda = new Date(tanggal).getTime() - new Date().setHours(0, 0, 0, 0);
  return Math.ceil(beda / 86400000);
}

function warnaSisa(hari) {
  if (hari === null) return 'text-slate-500';
  if (hari < 0) return 'text-rose-700 font-semibold';
  if (hari <= 30) return 'text-rose-600 font-medium';
  if (hari <= 90) return 'text-amber-600 font-medium';
  return 'text-slate-600';
}

function labelSisa(hari) {
  if (hari === null) return 'tanggal belum diisi';
  if (hari < 0) return `kedaluwarsa ${Math.abs(hari)} hari lalu`;
  if (hari === 0) return 'kedaluwarsa hari ini';
  return `${hari} hari lagi`;
}

/**
 * Daftar batch sebuah produk beserta sisa dan tanggal kadaluarsanya.
 *
 * Jumlah batch sengaja TIDAK bisa diketik di sini. Jumlah dibentuk oleh
 * pergerakan barang — barang masuk, terjual, dikembalikan — dan mengetiknya
 * langsung akan membuat sisa batch berbeda dari stok produknya tanpa ada mutasi
 * yang menjelaskan. Yang bisa dilengkapi hanya keterangannya, dan itulah yang
 * memang sering menyusul belakangan: tanggal kadaluarsa baru terbaca saat
 * kardusnya dibuka.
 */
export default function PanelBatch({ produk }) {
  const toast = useToast();
  const [data, setData] = useState(null);
  const [ubah, setUbah] = useState(null);

  const load = useCallback(async () => {
    if (!produk?.id) return;
    try {
      setData(await api.get(`/api/inventory/products/${produk.id}/batch`));
    } catch (err) {
      toast.error(err.message);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [produk?.id]);

  useEffect(() => { load(); }, [load]);

  async function simpan() {
    try {
      const res = await api.put(`/api/inventory/batch/${ubah.id}`, {
        kode: ubah.kode,
        tanggal_kadaluarsa: ubah.tanggal_kadaluarsa || null,
        tanggal_produksi: ubah.tanggal_produksi || null,
        catatan: ubah.catatan || null,
      });
      toast.success(`Batch ${res.batch.kode} diperbarui`);
      setUbah(null);
      load();
    } catch (err) {
      toast.error(err.message);
    }
  }

  if (!data) return null;

  return (
    <div className="sm:col-span-2">
      <div className="mb-2 flex items-center justify-between">
        <h3 className="flex items-center gap-2 text-sm font-semibold text-slate-900">
          <CalendarClock size={15} /> Batch & Kadaluarsa
        </h3>
        <span className="text-xs text-slate-500">
          sisa batch {data.sisaBatch} dari stok {data.produk?.stock}
        </span>
      </div>

      {!data.cocok && (
        <div className="mb-2 flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
          <AlertTriangle size={14} className="mt-0.5 shrink-0" />
          <span>
            Sisa batch tidak sama dengan stok produk. Biasanya karena ada barang masuk
            sebelum pelacakan batch dinyalakan. Betulkan lewat Koreksi Stok di atas,
            atau catat barang masuk beserta kode batch-nya.
          </span>
        </div>
      )}

      {data.rows.length === 0 ? (
        <p className="rounded-xl bg-slate-50 px-3 py-2 text-xs text-slate-500">
          Belum ada batch. Batch terbentuk sendiri saat barang masuk dicatat beserta
          kode batch-nya di menu Mutasi Stok.
        </p>
      ) : (
        <div className="table-wrap max-h-64 overflow-y-auto">
          <table className="table text-xs">
            <thead>
              <tr>
                <th>Kode Batch</th>
                <th>Kadaluarsa</th>
                <th className="text-right">Sisa</th>
                <th className="text-right">Nilai</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {data.rows.map((b) => {
                const hari = sisaHari(b.tanggal_kadaluarsa);
                const sedang = ubah && ubah.id === b.id;
                return (
                  <tr key={b.id} className={b.qty_sisa <= 0 ? 'opacity-50' : ''}>
                    <td>
                      {sedang ? (
                        <input
                          className="input !py-1 !text-xs" value={ubah.kode}
                          onChange={(e) => setUbah({ ...ubah, kode: e.target.value })}
                        />
                      ) : (
                        <span className="font-medium">{b.kode}</span>
                      )}
                    </td>
                    <td>
                      {sedang ? (
                        <input
                          type="date" className="input !py-1 !text-xs"
                          value={ubah.tanggal_kadaluarsa || ''}
                          onChange={(e) => setUbah({ ...ubah, tanggal_kadaluarsa: e.target.value })}
                        />
                      ) : (
                        <>
                          <span className="block">
                            {b.tanggal_kadaluarsa ? dateID(b.tanggal_kadaluarsa) : '—'}
                          </span>
                          <span className={`block text-[11px] ${warnaSisa(hari)}`}>
                            {labelSisa(hari)}
                          </span>
                        </>
                      )}
                    </td>
                    <td className="tabular text-right">{b.qty_sisa}</td>
                    <td className="tabular text-right">{rupiah(b.qty_sisa * b.unit_cost)}</td>
                    <td className="text-right">
                      {sedang ? (
                        <span className="flex justify-end gap-1">
                          <button
                            type="button" onClick={simpan}
                            className="rounded p-1 text-emerald-600 hover:bg-emerald-50"
                            aria-label="Simpan batch"
                          >
                            <Check size={14} />
                          </button>
                          <button
                            type="button" onClick={() => setUbah(null)}
                            className="rounded p-1 text-slate-400 hover:bg-slate-100"
                            aria-label="Batal"
                          >
                            <X size={14} />
                          </button>
                        </span>
                      ) : (
                        <button
                          type="button" onClick={() => setUbah({ ...b })}
                          className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-brand-600"
                          aria-label={`Ubah batch ${b.kode}`}
                        >
                          <Pencil size={14} />
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <p className="mt-2 text-[11px] leading-relaxed text-slate-500">
        Jumlah batch tidak bisa diketik di sini — ia terbentuk dari pergerakan barang.
        Yang bisa dilengkapi hanya kode dan tanggalnya, karena tanggal kadaluarsa
        sering baru terbaca setelah kardusnya dibuka.
      </p>
    </div>
  );
}
