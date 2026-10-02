import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Trash2, ExternalLink, AlertTriangle } from 'lucide-react';
import { api } from '../lib/api';
import { Modal, Spinner, useToast } from './ui';
import { rupiah, dateID, num } from '../lib/format';
import AksiTransaksiMitra from './AksiTransaksiMitra';

/**
 * Hapus satu jurnal dari Buku Besar.
 *
 * Jurnal yang menyentuh utang/piutang mitra dibuka di dialog Utang & Piutang
 * (ada pilihan tandai lunas). Jurnal lain: dihapus langsung bila dokumennya
 * adalah jurnal itu sendiri, mutasi stok manual dibalik bersama stoknya, dan
 * jurnal otomatis diarahkan ke menu asalnya.
 */
export default function HapusJurnal({ target, onClose, onSelesai }) {
  const toast = useToast();
  const [info, setInfo] = useState(null);
  const [proses, setProses] = useState(false);

  useEffect(() => {
    setInfo(null);
    if (!target) return;
    api.get(`/api/utang-aksi/umum/${target.journal_id}`)
      .then(setInfo)
      .catch((err) => { toast.error(err.message); onClose(); });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target]);

  if (target && info?.mitra) {
    return (
      <AksiTransaksiMitra
        target={{ journal_id: info.journal_id, partner_id: info.mitra.partner_id, mode: 'hapus' }}
        onClose={onClose} onSelesai={onSelesai}
      />
    );
  }

  async function hapus() {
    if (!window.confirm(`Yakin hapus ${info.entry_no}? Tindakan ini tidak bisa dibatalkan.`)) return;
    setProses(true);
    try {
      const res = await api.del(`/api/utang-aksi/umum/${info.journal_id}`);
      toast.success(res.message);
      onSelesai?.();
      onClose();
    } catch (err) {
      toast.error(err.message);
    } finally {
      setProses(false);
    }
  }

  return (
    <Modal open={!!target} onClose={onClose} title={`Hapus ${info?.entry_no || 'jurnal'}`} wide>
      {!info ? <Spinner /> : (
        <div className="grid gap-3">
          <div className="rounded-xl bg-slate-50 p-3 text-sm">
            <p className="font-semibold text-slate-900">{info.label} · {rupiah(info.total)}</p>
            <p className="text-xs text-slate-500">{dateID(info.entry_date)} · <span className="font-mono">{info.entry_no}</span> · {info.description}</p>
            <table className="mt-2 w-full text-xs">
              <tbody>
                {info.baris.map((l, i) => (
                  <tr key={i}>
                    <td className="py-0.5 text-slate-600">{l.code} {l.account_name}</td>
                    <td className="tabular py-0.5 text-right">{l.debit ? rupiah(l.debit) : ''}</td>
                    <td className="tabular py-0.5 text-right">{l.credit ? rupiah(l.credit) : ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {info.hapus === 'LANGSUNG' && <p className="text-sm text-slate-600">Jurnal ini dihapus seluruhnya (semua baris di atas).</p>}
          {info.hapus === 'PINDAH' && <p className="text-sm text-slate-600">Pemindahan saldo ini dibatalkan beserta potongan biayanya, bila ada.</p>}
          {info.hapus === 'MUTASI' && info.mutasi && (
            <p className={`rounded-xl px-3 py-2 text-sm ${info.mutasi.stokKurang ? 'bg-rose-50 text-rose-800' : 'bg-amber-50 text-amber-800'}`}>
              Jurnal ini milik mutasi stok {info.mutasi.arah} {num(info.mutasi.qty)} {info.mutasi.unit} {info.mutasi.product_name}.
              Menghapusnya ikut membalik stok (sekarang {num(info.mutasi.stok)} {info.mutasi.unit}) dan HPP. Cadangan dibuat otomatis.
              {info.mutasi.stokKurang && ' Tidak bisa: barangnya sudah terjual.'}
            </p>
          )}
          {!info.hapus && (
            <p className="flex gap-2 rounded-xl bg-amber-50 px-3 py-2 text-sm text-amber-800">
              <AlertTriangle size={15} className="shrink-0" />
              <span>
                {info.alasan}
                {info.dokumen && (
                  <> <Link to={info.dokumen.tautan} className="inline-flex items-center gap-0.5 font-semibold text-brand-600 hover:underline">Buka {info.dokumen.nomor} <ExternalLink size={12} /></Link></>
                )}
              </span>
            </p>
          )}

          <div className="flex gap-2">
            <button type="button" className="btn-secondary flex-1" onClick={onClose}>Tutup</button>
            {info.hapus && (
              <button type="button" className="btn-danger flex-1" disabled={proses || info.mutasi?.stokKurang} onClick={hapus}>
                <Trash2 size={15} /> {proses ? 'Menghapus...' : `Hapus ${info.entry_no}`}
              </button>
            )}
          </div>
        </div>
      )}
    </Modal>
  );
}
