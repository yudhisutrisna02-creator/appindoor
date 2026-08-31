import { useEffect, useState } from 'react';
import { Plus, Trash2, AlertTriangle } from 'lucide-react';
import { api } from '../lib/api';
import { num } from '../lib/format';

/**
 * Varian pada satu baris pesanan.
 *
 * Dipakai untuk produk yang dijual tanpa label. Tiap baris di sini menjawab dua
 * hal yang berbeda:
 *
 *  1. VARIAN PRODUK — dipilih dari katalog milik produk induknya, misalnya
 *     "GPN- Mangga" di bawah GREEN POWER NUTRALINDO. Ini menentukan barang apa
 *     yang sebenarnya dikirim.
 *  2. LABEL — ditulis bebas, nama merek yang diminta pembeli. Boleh dikosongkan
 *     bila pembeli tidak minta label sendiri.
 *
 * Keduanya BUKAN produk tersendiri: stok tetap berkurang dari produk induknya.
 * Menjadikan tiap varian sebagai SKU baru akan memecah stok, HPP, dan riwayat
 * penjualan barang yang sebenarnya sama.
 *
 * Dipakai bersama oleh formulir order baru dan formulir ubah order supaya
 * aturannya tidak punya dua versi yang bisa berbeda.
 */
export default function BarisVarian({
  produk, varian = [], qtyBaris, onUbah, terkunci = false, katalogAwal,
}) {
  const [katalog, setKatalog] = useState(katalogAwal || null);

  useEffect(() => {
    if (katalogAwal) return setKatalog(katalogAwal);
    if (!produk || !produk.id) return undefined;

    let batal = false;
    api
      .get(`/api/inventory/products/${produk.id}/variants`)
      .then((d) => { if (!batal) setKatalog(d.rows || []); })
      // Katalog yang gagal dimuat tidak boleh mengunci pesanan: labelnya masih
      // bisa ditulis manual, dan pesanan tetap bisa disimpan.
      .catch(() => { if (!batal) setKatalog([]); });
    return () => { batal = true; };
  }, [produk, katalogAwal]);

  const daftar = varian;
  const total = daftar.reduce((s, v) => s + (Number(v.qty) || 0), 0);
  const qty = Number(qtyBaris) || 0;
  const selisih = qty - total;

  // Varian yang sudah tidak aktif tetap ditampilkan bila memang sedang terpakai
  // pada baris ini — kalau tidak, membuka pesanan lama akan mengosongkan
  // pilihannya dan menyimpan justru menghapus keterangan yang benar.
  const terpakai = new Set(daftar.map((v) => Number(v.variant_id)).filter(Boolean));
  const pilihan = (katalog || []).filter((k) => k.active || terpakai.has(k.id));

  const ubahBaris = (i, patch) =>
    onUbah(daftar.map((v, n) => (n === i ? { ...v, ...patch } : v)));

  const tambah = () =>
    onUbah([
      ...daftar,
      // Baris pertama langsung diisikan seluruh jumlahnya: yang paling sering
      // terjadi adalah satu varian untuk seluruh baris.
      { variant_id: '', label: '', qty: daftar.length === 0 && qty > 0 ? qty : '' },
    ]);

  return (
    <div className="col-span-12 rounded-xl bg-amber-50/70 p-2.5 ring-1 ring-amber-200 dark:bg-amber-400/10">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs font-semibold text-amber-900">
          Varian &amp; Label — {produk.name} dijual tanpa label
        </p>
        {!terkunci && (
          <button type="button" className="btn-secondary !px-2 !py-1 text-xs" onClick={tambah}>
            <Plus size={13} /> Tambah Varian
          </button>
        )}
      </div>

      {katalog === null ? (
        <p className="text-xs text-amber-800">Memuat pilihan varian...</p>
      ) : daftar.length === 0 ? (
        <p className="text-xs text-amber-800">
          Belum ada varian dipilih. Tambahkan minimal satu — pesanan tidak bisa disimpan tanpa itu.
        </p>
      ) : (
        <div className="space-y-2">
          {/* Kepala kolom hanya di layar lebar; di ponsel isiannya sudah
              berlabel sendiri lewat placeholder. */}
          <div className="hidden gap-2 px-1 text-[11px] font-medium text-amber-900 sm:flex">
            <span className="flex-1">Varian Produk</span>
            <span className="flex-1">Label (opsional)</span>
            <span className="w-24">Qty</span>
            <span className="w-8" />
          </div>

          {daftar.map((v, i) => (
            <div key={i} className="flex flex-col gap-2 sm:flex-row sm:items-center">
              <select
                className="input !py-1.5 sm:flex-1"
                value={v.variant_id || ''} disabled={terkunci}
                onChange={(e) => ubahBaris(i, { variant_id: e.target.value })}
              >
                <option value="">— pilih varian produk —</option>
                {pilihan.map((k) => (
                  <option key={k.id} value={k.id}>
                    {k.nama}{k.active ? '' : ' (nonaktif)'}
                  </option>
                ))}
              </select>

              <input
                className="input !py-1.5 sm:flex-1"
                placeholder="Label pembeli, mis. Tani Makmur"
                value={v.label || ''} maxLength={120} disabled={terkunci}
                onChange={(e) => ubahBaris(i, { label: e.target.value })}
              />

              <div className="flex items-center gap-2">
                <input
                  type="number" min="0" step="any" className="input !py-1.5 w-24"
                  placeholder="Qty" value={v.qty} disabled={terkunci}
                  onChange={(e) => ubahBaris(i, { qty: e.target.value })}
                />
                {!terkunci && (
                  <button
                    type="button" className="btn-ghost !px-2 !py-1 text-rose-600"
                    onClick={() => onUbah(daftar.filter((_, n) => n !== i))}
                    aria-label="Hapus varian"
                  >
                    <Trash2 size={13} />
                  </button>
                )}
              </div>
            </div>
          ))}

          {/* Jumlah varian wajib sama dengan jumlah barisnya. Kalau tidak,
              lembar pengiriman menyebut jumlah yang berbeda dari yang dipotong
              dari stok — selisih yang baru ketahuan setelah barang dikirim. */}
          <div className="flex items-center justify-between gap-2 text-xs">
            <span className="text-amber-900">
              Total varian {num(total)} dari {num(qty)} pesanan
            </span>
            {Math.abs(selisih) > 0.004 && (
              <span className="flex items-center gap-1 font-semibold text-rose-700">
                <AlertTriangle size={12} />
                {selisih > 0 ? `kurang ${num(selisih)}` : `lebih ${num(-selisih)}`}
              </span>
            )}
          </div>

          {pilihan.length === 0 && (
            <p className="text-xs text-amber-800">
              Katalog varian produk ini masih kosong. Isi dulu di Master Produk, atau tulis
              labelnya manual.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
