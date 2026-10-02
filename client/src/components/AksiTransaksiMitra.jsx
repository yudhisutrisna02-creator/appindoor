import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Pencil, Trash2, CheckCircle2, AlertTriangle, ExternalLink, PackageX } from 'lucide-react';
import { api } from '../lib/api';
import { Modal, Spinner, Field, useToast } from './ui';
import { rupiah, dateID, num } from '../lib/format';

/**
 * Ubah / hapus satu transaksi utang-piutang.
 *
 * Asal transaksinya menentukan apa yang aman dilakukan: pelunasan & saldo awal
 * bisa diubah/dihapus langsung; utang dari barang masuk bisa "ditandai lunas"
 * (sudah dibayar di luar sistem — stok tetap) atau barang masuknya dihapus
 * sekalian (stok & jurnal dibalik); penjualan dan pesanan pembelian dibetulkan
 * lewat dokumennya, atau ditandai lunas.
 */
export default function AksiTransaksiMitra({ target, onClose, onSelesai, cashAccounts = [] }) {
  const toast = useToast();
  const [info, setInfo] = useState(null);
  const [mode, setMode] = useState(target?.mode || 'ubah');
  const [form, setForm] = useState(null);
  const [pilihan, setPilihan] = useState('LUNAS');
  const [proses, setProses] = useState(false);

  useEffect(() => {
    if (!target) { setInfo(null); return; }
    setMode(target.mode);
    setInfo(null);
    api.get(`/api/utang-aksi/jurnal/${target.journal_id}`, { partner_id: target.partner_id })
      .then((d) => {
        setInfo(d);
        setForm({
          tanggal: d.entry_date,
          nominal: d.nominal,
          cash_code: d.cash_code || '',
          catatan: d.memo || '',
          lunasTanggal: d.entry_date,
          lunasNominal: Math.min(d.nominal, d.sisaMitra),
        });
        setPilihan(d.bolehLunasi ? 'LUNAS' : 'HAPUS');
      })
      .catch((err) => { toast.error(err.message); onClose(); });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target]);

  async function jalankan(fn) {
    setProses(true);
    try {
      const res = await fn();
      toast.success(res.message);
      onSelesai?.();
      onClose();
    } catch (err) {
      toast.error(err.message);
    } finally {
      setProses(false);
    }
  }

  const simpanUbah = (e) => {
    e.preventDefault();
    if (info.ubah === 'PELUNASAN') {
      return jalankan(() => api.put(`/api/cashflow/settlements/${info.journal_id}`, {
        entry_date: form.tanggal, amount: Number(form.nominal), cash_code: form.cash_code, note: form.catatan || null,
      }));
    }
    return jalankan(() => api.put(`/api/utang-aksi/jurnal/${info.journal_id}`, {
      partner_id: info.partner.id, tanggal: form.tanggal, nominal: Number(form.nominal), catatan: form.catatan || null,
    }));
  };

  const lunasi = () => jalankan(() => api.post(`/api/utang-aksi/jurnal/${info.journal_id}/lunasi`, {
    partner_id: info.partner.id, tanggal: form.lunasTanggal, nominal: Number(form.lunasNominal), catatan: form.catatan && info.source !== 'STOCK' ? form.catatan : null,
  }));

  const hapus = () => {
    if (!window.confirm(`Yakin hapus ${info.entry_no}? Tindakan ini tidak bisa dibatalkan.`)) return;
    jalankan(() => api.del(`/api/utang-aksi/jurnal/${info.journal_id}?partner_id=${info.partner.id}`));
  };

  const stokKurang = info?.mutasi && info.mutasi.stok + 0.0001 < info.mutasi.qty;

  const formLunas = info && (
    <div className="grid gap-3 sm:grid-cols-2">
      <Field label="Tanggal dilunasi">
        <input type="date" className="input" value={form.lunasTanggal} onChange={(e) => setForm({ ...form, lunasTanggal: e.target.value })} />
      </Field>
      <Field label="Nominal ditutup (Rp)" hint={`Maks. ${rupiah(Math.min(info.nominal, info.sisaMitra))}`}>
        <input type="number" min="0" step="any" className="input" value={form.lunasNominal} onChange={(e) => setForm({ ...form, lunasNominal: e.target.value })} />
      </Field>
    </div>
  );

  return (
    <Modal open={!!target} onClose={onClose} title={mode === 'ubah' ? `Ubah ${info?.entry_no || ''}` : `Hapus ${info?.entry_no || ''}`} wide>
      {!info || !form ? <Spinner /> : (
        <div className="grid gap-3">
          {/* Ringkasan transaksi */}
          <div className="rounded-xl bg-slate-50 p-3 text-sm">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="font-semibold text-slate-900">{info.partner.name} · {info.label}</p>
              <p className={`tabular font-bold ${info.arah === 'BERKURANG' ? 'text-emerald-700' : 'text-amber-700'}`}>
                {info.arah === 'BERKURANG' ? '−' : '+'}{rupiah(info.nominal)}
              </p>
            </div>
            <p className="text-xs text-slate-500">{dateID(info.entry_date)} · <span className="font-mono">{info.entry_no}</span> · {info.description}</p>
            {info.dokumen && (
              <p className="mt-1 text-xs">
                Dokumen asal: <strong>{info.dokumen.nomor}</strong>{' '}
                <Link to={info.dokumen.tautan} className="inline-flex items-center gap-0.5 text-brand-600 hover:underline">buka <ExternalLink size={11} /></Link>
              </p>
            )}
            <p className="mt-1 text-xs text-slate-500">Sisa {info.jenis.toLowerCase()} {info.partner.name} saat ini: <strong>{rupiah(info.sisaMitra)}</strong></p>
            {info.sudahLunas.length > 0 && (
              <p className="mt-1 text-xs text-emerald-700">Sudah ditandai lunas: {info.sudahLunas.map((l) => l.entry_no).join(', ')}</p>
            )}
          </div>

          {(info.terkunci || info.terekonsiliasi) && (
            <p className="flex gap-2 rounded-xl bg-rose-50 px-3 py-2 text-xs text-rose-800">
              <AlertTriangle size={14} className="shrink-0" />
              {info.terkunci ? 'Bulan transaksi ini sudah tutup buku — buka kembali tutup bukunya dulu.' : 'Transaksi ini sudah dicocokkan di Rekonsiliasi Bank — lepaskan pasangannya dulu.'}
            </p>
          )}

          <div className="flex gap-1.5 rounded-xl bg-slate-100 p-1">
            {[['ubah', 'Ubah', Pencil], ['hapus', 'Hapus / Lunasi', Trash2]].map(([k, l, Ik]) => (
              <button key={k} type="button" onClick={() => setMode(k)}
                className={`flex flex-1 items-center justify-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-semibold ${mode === k ? 'bg-white shadow-sm text-slate-900' : 'text-slate-500'}`}>
                <Ik size={14} /> {l}
              </button>
            ))}
          </div>

          {/* ---------- UBAH ---------- */}
          {mode === 'ubah' && (
            info.ubah ? (
              <form onSubmit={simpanUbah} className="grid gap-3 sm:grid-cols-2">
                <Field label="Tanggal">
                  <input type="date" className="input" required value={form.tanggal} disabled={info.ubah === 'HARGA_MASUK'}
                    onChange={(e) => setForm({ ...form, tanggal: e.target.value })} />
                </Field>
                <Field label="Nominal (Rp)" hint={info.ubah === 'HARGA_MASUK' && info.mutasi
                  ? `${num(info.mutasi.qty)} ${info.mutasi.unit} × ${rupiah((Number(form.nominal) || 0) / info.mutasi.qty)} — HPP ikut disesuaikan`
                  : null}>
                  <input type="number" min="0" step="any" className="input" required value={form.nominal}
                    onChange={(e) => setForm({ ...form, nominal: e.target.value })} />
                </Field>
                {info.ubah === 'PELUNASAN' && (
                  <Field label={info.jenis === 'Utang' ? 'Uang diambil dari' : 'Uang masuk ke'} className="sm:col-span-2">
                    <select className="input" required value={form.cash_code} onChange={(e) => setForm({ ...form, cash_code: e.target.value })}>
                      <option value="">— pilih rekening —</option>
                      {cashAccounts.map((k) => <option key={k.code} value={k.code}>{k.code} — {k.name}</option>)}
                    </select>
                  </Field>
                )}
                <Field label={info.ubah === 'HARGA_MASUK' ? 'Alasan perubahan' : 'Catatan'} className="sm:col-span-2">
                  <input className="input" maxLength={200} value={form.catatan} onChange={(e) => setForm({ ...form, catatan: e.target.value })} />
                </Field>
                <div className="flex gap-2 sm:col-span-2">
                  <button type="button" className="btn-secondary flex-1" onClick={onClose}>Batal</button>
                  <button type="submit" className="btn-primary flex-1" disabled={proses}><Pencil size={15} /> {proses ? 'Menyimpan...' : 'Simpan Perubahan'}</button>
                </div>
              </form>
            ) : (
              <p className="rounded-xl bg-amber-50 px-3 py-2 text-sm text-amber-800">
                {info.alasan} {info.bolehLunasi && 'Bila sudah dibayar, pakai tab "Hapus / Lunasi" → Tandai sudah lunas.'}
              </p>
            )
          )}

          {/* ---------- HAPUS / LUNASI ---------- */}
          {mode === 'hapus' && (
            <div className="grid gap-2">
              {info.hapus === 'LANGSUNG' && (
                <>
                  <p className="text-sm text-slate-600">
                    Jurnal ini dihapus dan sisa {info.jenis.toLowerCase()} {info.partner.name} berubah sebesar {rupiah(info.nominal)}.
                    {info.sudahLunas.length > 0 && ' Tanda lunas yang menunjuk transaksi ini ikut terhapus.'}
                  </p>
                  <button type="button" className="btn-danger" disabled={proses} onClick={hapus}>
                    <Trash2 size={15} /> {proses ? 'Menghapus...' : `Hapus ${info.entry_no}`}
                  </button>
                </>
              )}

              {info.hapus !== 'LANGSUNG' && (
                <>
                  {info.bolehLunasi && (
                    <label className={`grid cursor-pointer gap-2 rounded-xl border p-3 text-sm ${pilihan === 'LUNAS' ? 'border-brand-500 bg-brand-50' : 'border-slate-200'}`}>
                      <span className="flex gap-2">
                        <input type="radio" checked={pilihan === 'LUNAS'} onChange={() => setPilihan('LUNAS')} />
                        <span>
                          <strong>Tandai sudah lunas</strong> (sudah {info.jenis === 'Utang' ? 'dibayar' : 'diterima'} di luar sistem)
                          <span className="block text-xs text-slate-500">
                            {info.jenis} ini ditutup lawan Saldo Awal Kas &amp; Bank. Stok barang dan saldo rekening tidak berubah —
                            cocok untuk data impor Agustus yang sebenarnya sudah dibayar. Bisa dihapus lagi bila keliru.
                          </span>
                        </span>
                      </span>
                      {pilihan === 'LUNAS' && formLunas}
                    </label>
                  )}

                  {info.hapus === 'BARANG_MASUK' && (
                    <label className={`flex cursor-pointer gap-2 rounded-xl border p-3 text-sm ${pilihan === 'HAPUS' ? 'border-rose-400 bg-rose-50' : 'border-slate-200'} ${stokKurang ? 'opacity-50' : ''}`}>
                      <input type="radio" checked={pilihan === 'HAPUS'} disabled={stokKurang} onChange={() => setPilihan('HAPUS')} />
                      <span>
                        <strong>Hapus barang masuknya</strong> ({num(info.mutasi.qty)} {info.mutasi.unit} {info.mutasi.product_name})
                        <span className="block text-xs text-slate-500">
                          Untuk barang yang sebenarnya tidak pernah datang / salah input. Stok dikurangi {num(info.mutasi.qty)} {info.mutasi.unit}{' '}
                          (stok sekarang {num(info.mutasi.stok)}), HPP dan utangnya dibalik. Cadangan dibuat otomatis.
                          {stokKurang && ' Tidak bisa: barangnya sudah terjual.'}
                        </span>
                      </span>
                    </label>
                  )}

                  {!info.hapus && (
                    <p className="rounded-xl bg-amber-50 px-3 py-2 text-xs text-amber-800">{info.alasan}</p>
                  )}

                  {(info.bolehLunasi || info.hapus === 'BARANG_MASUK') ? (
                    pilihan === 'LUNAS' && info.bolehLunasi ? (
                      <button type="button" className="btn-primary" disabled={proses} onClick={lunasi}>
                        <CheckCircle2 size={15} /> {proses ? 'Menyimpan...' : `Tandai Lunas ${rupiah(Number(form.lunasNominal) || 0)}`}
                      </button>
                    ) : (
                      <button type="button" className="btn-danger" disabled={proses || stokKurang} onClick={hapus}>
                        <PackageX size={15} /> {proses ? 'Menghapus...' : 'Hapus Barang Masuk'}
                      </button>
                    )
                  ) : (
                    !info.hapus && <p className="text-xs text-slate-500">{info.jenis} ini sudah tidak bersisa, jadi tidak ada yang perlu ditandai lunas.</p>
                  )}
                </>
              )}
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}
