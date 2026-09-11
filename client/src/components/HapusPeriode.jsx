import { useState } from 'react';
import { AlertTriangle, Search } from 'lucide-react';
import { api } from '../lib/api';
import { Modal, Field, useToast } from './ui';
import { rupiah, num, dateID } from '../lib/format';
import { rentangBulan } from '../lib/rekening';

/**
 * Menghapus seluruh order pada satu rentang tanggal.
 *
 * Alurnya sengaja dua langkah: PERIKSA dulu, baru HAPUS. Tombol yang bisa
 * membatalkan ratusan order sekaligus tidak boleh bekerja sebelum orangnya
 * melihat akibatnya — dan tiga akibatnya mudah terlewat: stok bertambah
 * kembali, saldo rekening turun sebesar uang order yang dulu masuk, dan laba
 * rugi bulan itu kehilangan pendapatannya.
 *
 * Order tidak dibuang dari basis data. Ia dibatalkan lewat jalur yang sama
 * dengan tombol batal biasa, sehingga hilang dari seluruh daftar dan laporan
 * tetapi jejaknya tetap ada di Riwayat.
 */
export default function HapusPeriode({ open, onClose, onSelesai }) {
  const toast = useToast();
  const [rentang, setRentang] = useState(() => rentangBulan(-1));
  const [hasil, setHasil] = useState(null);
  const [memeriksa, setMemeriksa] = useState(false);
  const [konfirmasi, setKonfirmasi] = useState('');
  const [menghapus, setMenghapus] = useState(false);

  function tutup() {
    setHasil(null);
    setKonfirmasi('');
    onClose();
  }

  async function periksa() {
    setMemeriksa(true);
    setKonfirmasi('');
    try {
      setHasil(await api.post('/api/sales/bersihkan-periode', { ...rentang, terapkan: false }));
    } catch (err) {
      toast.error(err.message);
    } finally {
      setMemeriksa(false);
    }
  }

  async function hapus() {
    setMenghapus(true);
    try {
      const res = await api.post('/api/sales/bersihkan-periode', {
        ...rentang, terapkan: true, konfirmasi,
      });
      toast.success(res.message);
      tutup();
      onSelesai?.();
    } catch (err) {
      toast.error(err.message);
    } finally {
      setMenghapus(false);
    }
  }

  const r = hasil?.ringkas;
  const bolehHapus = r && r.orders > 0 && !hasil.penghalang.length && konfirmasi === r.kataKunci;
  const akunKas = (hasil?.akun || []).filter((a) => a.is_cash || a.code === '1110');

  return (
    <Modal open={open} onClose={tutup} title="Hapus Order Satu Periode" wide>
      <div className="grid gap-3">
        <p className="rounded-xl bg-slate-50 px-3 py-2 text-xs leading-relaxed text-slate-600">
          Seluruh order pada rentang tanggal ini dibatalkan: <strong>hilang dari semua daftar,
          dashboard, dan laporan</strong>, stoknya dikembalikan, returnya ikut dibalik, dan
          jurnalnya dihapus. Jejaknya tetap tercatat di Riwayat. Periksa dulu akibatnya — tombol
          hapus baru aktif setelah itu.
        </p>

        <div className="flex flex-wrap items-end gap-3">
          <Field label="Dari Tanggal" className="w-44">
            <input
              type="date" className="input" value={rentang.from}
              onChange={(e) => { setRentang({ ...rentang, from: e.target.value }); setHasil(null); }}
            />
          </Field>
          <Field label="Sampai Tanggal" className="w-44">
            <input
              type="date" className="input" value={rentang.to}
              onChange={(e) => { setRentang({ ...rentang, to: e.target.value }); setHasil(null); }}
            />
          </Field>
          <button type="button" className="btn-secondary" onClick={periksa} disabled={memeriksa}>
            <Search size={15} /> {memeriksa ? 'Memeriksa...' : 'Periksa Akibatnya'}
          </button>
        </div>

        {r && (
          <>
            <div className="grid gap-2 rounded-xl bg-slate-50 p-3 text-sm sm:grid-cols-2">
              <Baris label="Order yang dihapus" nilai={`${num(r.orders)} order`} tebal />
              <Baris label="Penjualan kotor" nilai={rupiah(r.penjualanKotor)} />
              <Baris label="Retur ikut dibalik" nilai={`${num(r.retur)} retur`} />
              <Baris label="Barang kembali ke stok" nilai={`${num(r.unitKembali)} unit`} />
            </div>

            {hasil.penghalang.length > 0 && (
              <div className="rounded-xl bg-rose-50 px-3 py-2 text-xs leading-relaxed text-rose-800">
                <p className="mb-1 flex items-center gap-1.5 font-semibold">
                  <AlertTriangle size={14} /> Belum bisa dihapus
                </p>
                <ul className="list-disc pl-5">
                  {hasil.penghalang.map((p) => <li key={p}>{p}</li>)}
                </ul>
              </div>
            )}

            {hasil.peringatan?.length > 0 && (
              <div className="rounded-xl bg-amber-50 px-3 py-2 text-xs leading-relaxed text-amber-900">
                <p className="mb-1 flex items-center gap-1.5 font-semibold">
                  <AlertTriangle size={14} /> Saldo ini akan menjadi minus
                </p>
                <ul className="list-disc pl-5">
                  {hasil.peringatan.map((p) => <li key={p}>{p}</li>)}
                </ul>
                <p className="mt-1.5">
                  Pemasukan periode ini ikut terhapus, tetapi pengeluarannya — bayar supplier, iklan
                  yang dipotong saldo marketplace — tetap tercatat. Saldo minus ini baru beres setelah
                  saldo awal rekening dimasukkan sesudahnya.
                </p>
              </div>
            )}

            {akunKas.length > 0 && (
              <div>
                <p className="mb-1 text-xs font-semibold text-slate-700">Saldo yang ikut berubah</p>
                <p className="mb-2 text-xs text-slate-500">
                  Uang dari order-order ini ikut keluar dari pembukuan. Kolom kanan adalah saldo pada
                  akhir periode sesudah dihapus — itulah yang nanti tampil sebagai saldo awal bulan
                  berikutnya.
                </p>
                <div className="table-wrap">
                  <table className="table text-sm">
                    <thead>
                      <tr>
                        <th>Rekening</th>
                        <th className="text-right">Berubah</th>
                        <th className="text-right">Saldo akhir: sekarang → sesudah</th>
                      </tr>
                    </thead>
                    <tbody>
                      {akunKas.map((a) => (
                        <tr key={a.code}>
                          <td className="text-xs">
                            <span className="font-mono text-slate-500">{a.code}</span> {a.name}
                          </td>
                          <td className={`tabular text-right font-medium ${a.perubahan < 0 ? 'text-rose-600' : 'text-emerald-700'}`}>
                            {a.perubahan > 0 ? '+' : ''}{rupiah(a.perubahan)}
                          </td>
                          <td className="tabular text-right text-xs">
                            <span className="text-slate-500">{rupiah(a.saldoSebelum)}</span>
                            {' → '}
                            <span className={a.saldoSesudah < 0 ? 'font-semibold text-rose-600' : 'font-semibold text-slate-900'}>
                              {rupiah(a.saldoSesudah)}
                            </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {hasil.stok.length > 0 && (
              <details className="rounded-xl bg-slate-50 px-3 py-2 text-xs">
                <summary className="cursor-pointer font-semibold text-slate-700">
                  Stok yang bertambah kembali ({hasil.stok.length} produk)
                </summary>
                <ul className="mt-2 space-y-0.5">
                  {hasil.stok.map((x) => (
                    <li key={x.id} className="flex justify-between gap-3">
                      <span>{x.sku} — {x.name}</span>
                      <span className="tabular font-medium">+{num(x.qty)} {x.unit}</span>
                    </li>
                  ))}
                </ul>
              </details>
            )}

            {r.orders > 0 && !hasil.penghalang.length && (
              <Field
                label={`Ketik ${r.kataKunci} untuk melanjutkan`}
                hint={`Menghapus ${num(r.orders)} order ${dateID(r.from)} s/d ${dateID(r.to)}`}
              >
                <input
                  className="input font-mono" value={konfirmasi}
                  placeholder={r.kataKunci}
                  onChange={(e) => setKonfirmasi(e.target.value)}
                />
              </Field>
            )}

            {r.orders === 0 && (
              <p className="text-sm text-slate-500">Tidak ada order pada rentang tanggal ini.</p>
            )}
          </>
        )}

        <div className="flex gap-2">
          <button type="button" className="btn-secondary flex-1" onClick={tutup}>Batal</button>
          <button
            type="button" className="btn-primary flex-1 !bg-rose-600 hover:!bg-rose-700 disabled:opacity-40"
            disabled={!bolehHapus || menghapus}
            onClick={hapus}
          >
            {menghapus ? 'Menghapus...' : r ? `Hapus ${num(r.orders)} Order` : 'Hapus'}
          </button>
        </div>
      </div>
    </Modal>
  );
}

function Baris({ label, nilai, tebal }) {
  return (
    <div className="flex justify-between gap-3">
      <span className="text-slate-500">{label}</span>
      <span className={`tabular ${tebal ? 'font-semibold text-slate-900' : 'text-slate-700'}`}>{nilai}</span>
    </div>
  );
}
