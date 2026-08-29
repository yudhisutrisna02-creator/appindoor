import { Plus, Trash2, AlertTriangle } from 'lucide-react';
import { num } from '../lib/format';

/**
 * Label varian pada satu baris pesanan.
 *
 * Dipakai untuk produk yang dijual tanpa label dan baru diberi label pesanan
 * pembeli. Satu baris bisa dikirim dengan beberapa label sekaligus — misalnya
 * 10 berlabel A dan 5 berlabel B dari produk yang sama.
 *
 * Labelnya TIDAK menjadi produk tersendiri: stok tetap berkurang dari produk
 * induknya. Menjadikan tiap label sebagai SKU baru akan memecah stok, HPP, dan
 * riwayat penjualan barang yang sebenarnya sama.
 *
 * Dipakai bersama oleh formulir order baru dan formulir ubah order supaya
 * aturannya tidak punya dua versi yang bisa berbeda.
 */
export default function BarisVarian({ produk, varian = [], qtyBaris, onUbah, terkunci = false }) {
  const daftar = varian.length ? varian : [];
  const total = daftar.reduce((s, v) => s + (Number(v.qty) || 0), 0);
  const qty = Number(qtyBaris) || 0;
  const selisih = qty - total;

  const ubahBaris = (i, patch) =>
    onUbah(daftar.map((v, n) => (n === i ? { ...v, ...patch } : v)));

  const tambah = () =>
    onUbah([
      ...daftar,
      // Baris pertama langsung diisikan seluruh jumlahnya: yang paling sering
      // terjadi adalah satu label untuk seluruh baris, dan mengetiknya lagi
      // hanya menambah pekerjaan.
      { label: '', qty: daftar.length === 0 && qty > 0 ? qty : '' },
    ]);

  return (
    <div className="col-span-12 rounded-xl bg-amber-50/70 p-2.5 ring-1 ring-amber-200 dark:bg-amber-400/10">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs font-semibold text-amber-900">
          Label Varian — {produk.name} dijual tanpa label
        </p>
        {!terkunci && (
          <button type="button" className="btn-secondary !px-2 !py-1 text-xs" onClick={tambah}>
            <Plus size={13} /> Tambah Label
          </button>
        )}
      </div>

      {daftar.length === 0 ? (
        <p className="text-xs text-amber-800">
          Belum ada label. Tambahkan minimal satu — pesanan tidak bisa disimpan tanpa itu.
        </p>
      ) : (
        <div className="space-y-2">
          {daftar.map((v, i) => (
            <div key={i} className="flex items-center gap-2">
              <input
                className="input !py-1.5 flex-1" placeholder="Tulis label varian, mis. Tani Makmur"
                value={v.label} maxLength={120} disabled={terkunci}
                onChange={(e) => ubahBaris(i, { label: e.target.value })}
              />
              <input
                type="number" min="0" step="any" className="input !py-1.5 w-24"
                placeholder="Qty" value={v.qty} disabled={terkunci}
                onChange={(e) => ubahBaris(i, { qty: e.target.value })}
              />
              {!terkunci && (
                <button
                  type="button" className="btn-ghost !px-2 !py-1 text-rose-600"
                  onClick={() => onUbah(daftar.filter((_, n) => n !== i))}
                  aria-label="Hapus label"
                >
                  <Trash2 size={13} />
                </button>
              )}
            </div>
          ))}

          {/* Jumlah label wajib sama dengan jumlah barisnya. Kalau tidak,
              lembar pengiriman menyebut jumlah yang berbeda dari yang dipotong
              dari stok — selisih yang baru ketahuan setelah barang dikirim. */}
          <div className="flex items-center justify-between gap-2 text-xs">
            <span className="text-amber-900">
              Total label {num(total)} dari {num(qty)} pesanan
            </span>
            {Math.abs(selisih) > 0.004 && (
              <span className="flex items-center gap-1 font-semibold text-rose-700">
                <AlertTriangle size={12} />
                {selisih > 0 ? `kurang ${num(selisih)}` : `lebih ${num(-selisih)}`}
              </span>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
