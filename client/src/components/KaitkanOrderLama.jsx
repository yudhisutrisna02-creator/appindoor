import { useEffect, useState } from 'react';
import { Search } from 'lucide-react';
import { api } from '../lib/api';
import { Modal, Field, useToast } from './ui';
import { rupiah, num, dateID } from '../lib/format';
import { rentangBulan } from '../lib/rekening';

/**
 * Mengaitkan order lama ke rekening tokonya.
 *
 * Order yang dicatat sebelum ada kolom rekening uangnya tercatat di akun
 * bawaan lama. Setelah tokonya punya rekening, order-order itu bisa ikut
 * dikaitkan sekaligus: rekening tokonya dipasang dan jurnalnya ditulis ulang,
 * sehingga uangnya berpindah ke rekening yang sebenarnya.
 *
 * Pemeriksaannya berjalan sendiri saat jendela dibuka, karena laporan
 * pemeriksaan itulah jawaban untuk "tolong cek datanya": berapa yang bisa
 * dikaitkan, dan mana yang tidak bisa beserta sebabnya.
 */
export default function KaitkanOrderLama({ open, onClose, onSelesai }) {
  const toast = useToast();
  const [rentang, setRentang] = useState(() => rentangBulan(0));
  const [hasil, setHasil] = useState(null);
  const [memeriksa, setMemeriksa] = useState(false);
  const [menerapkan, setMenerapkan] = useState(false);

  async function periksa(r = rentang) {
    setMemeriksa(true);
    try {
      setHasil(await api.post('/api/sales/kaitkan-rekening', { ...r, terapkan: false }));
    } catch (err) {
      toast.error(err.message);
    } finally {
      setMemeriksa(false);
    }
  }

  useEffect(() => {
    if (open) periksa();
    else setHasil(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  async function terapkan() {
    setMenerapkan(true);
    try {
      const res = await api.post('/api/sales/kaitkan-rekening', { ...rentang, terapkan: true });
      toast.success(res.message);
      if (res.dilewati?.length) {
        toast.error(`${res.dilewati.length} order dilewati: ${res.dilewati[0].order_no} — ${res.dilewati[0].alasan}`);
      }
      onSelesai?.();
      await periksa();
    } catch (err) {
      toast.error(err.message);
    } finally {
      setMenerapkan(false);
    }
  }

  const r = hasil?.ringkas;

  return (
    <Modal open={open} onClose={onClose} title="Kaitkan Order Lama ke Rekening Toko" wide>
      <div className="grid gap-3">
        <p className="rounded-xl bg-slate-50 px-3 py-2 text-xs leading-relaxed text-slate-600">
          Order yang dicatat <strong>sebelum ada kolom rekening</strong> uangnya masih tercatat di
          akun bawaan lama. Order yang tokonya sudah punya rekening bisa dikaitkan sekaligus di
          sini — rekening tokonya dipasang dan jurnalnya ditulis ulang. Order yang sudah punya
          rekening tidak disentuh.
        </p>

        <div className="flex flex-wrap items-end gap-3">
          <Field label="Dari Tanggal" className="w-44">
            <input
              type="date" className="input" value={rentang.from}
              onChange={(e) => setRentang({ ...rentang, from: e.target.value })}
            />
          </Field>
          <Field label="Sampai Tanggal" className="w-44">
            <input
              type="date" className="input" value={rentang.to}
              onChange={(e) => setRentang({ ...rentang, to: e.target.value })}
            />
          </Field>
          <button type="button" className="btn-secondary" onClick={() => periksa()} disabled={memeriksa}>
            <Search size={15} /> {memeriksa ? 'Memeriksa...' : 'Periksa'}
          </button>
        </div>

        {r && (
          <>
            <div className="grid gap-2 rounded-xl bg-slate-50 p-3 text-sm sm:grid-cols-2">
              <Baris label="Bisa dikaitkan" nilai={`${num(r.bisa)} order`} warna="text-emerald-700" />
              <Baris label="Tanpa toko" nilai={`${num(r.tanpaToko)} order`} warna={r.tanpaToko ? 'text-amber-700' : ''} />
              <Baris label="Tokonya belum punya rekening" nilai={`${num(r.tokoTanpaRekening)} order`} warna={r.tokoTanpaRekening ? 'text-amber-700' : ''} />
              <Baris label="Di bulan yang sudah ditutup" nilai={`${num(r.terkunci)} order`} />
            </div>

            {r.perRekening.length > 0 && (
              <div className="table-wrap">
                <table className="table text-sm">
                  <thead>
                    <tr><th>Akan masuk ke rekening</th><th className="text-right">Order</th><th className="text-right">Uang lunas pindah</th></tr>
                  </thead>
                  <tbody>
                    {r.perRekening.map((x) => (
                      <tr key={x.rekening}>
                        <td className="text-xs">{x.rekening}</td>
                        <td className="tabular text-right">{num(x.orders)}</td>
                        <td className="tabular text-right font-medium">{rupiah(x.nilaiLunas)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {r.tokoBelumBerekening.length > 0 && (
              <p className="rounded-xl bg-amber-50 px-3 py-2 text-xs leading-relaxed text-amber-900">
                Toko ini belum punya rekening, jadi ordernya belum bisa dikaitkan:{' '}
                <strong>{r.tokoBelumBerekening.join(', ')}</strong>. Tautkan rekeningnya dulu,
                lalu periksa lagi.
              </p>
            )}

            {hasil.contoh?.tanpaToko?.length > 0 && (
              <details className="rounded-xl bg-slate-50 px-3 py-2 text-xs">
                <summary className="cursor-pointer font-semibold text-slate-700">
                  Order tanpa toko ({num(r.tanpaToko)}) — perlu dipilih lewat Ubah Pesanan
                </summary>
                <ul className="mt-2 space-y-0.5">
                  {hasil.contoh.tanpaToko.map((o) => (
                    <li key={o.id} className="flex justify-between gap-3">
                      <span>{o.order_ref || o.order_no} · {o.channel_label}</span>
                      <span className="text-slate-500">{dateID(o.order_date)}</span>
                    </li>
                  ))}
                </ul>
              </details>
            )}
          </>
        )}

        <div className="flex gap-2">
          <button type="button" className="btn-secondary flex-1" onClick={onClose}>Tutup</button>
          <button
            type="button" className="btn-primary flex-1"
            disabled={!r || !r.bisa || menerapkan}
            onClick={terapkan}
          >
            {menerapkan ? 'Mengaitkan...' : r?.bisa ? `Kaitkan ${num(r.bisa)} Order` : 'Tidak ada yang bisa dikaitkan'}
          </button>
        </div>
      </div>
    </Modal>
  );
}

function Baris({ label, nilai, warna = '' }) {
  return (
    <div className="flex justify-between gap-3">
      <span className="text-slate-500">{label}</span>
      <span className={`tabular font-medium ${warna || 'text-slate-900'}`}>{nilai}</span>
    </div>
  );
}
