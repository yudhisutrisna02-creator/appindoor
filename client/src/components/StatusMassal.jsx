import { useState } from 'react';
import { AlertTriangle, ListChecks, Loader2 } from 'lucide-react';
import { api } from '../lib/api';
import { Modal, Field, useToast } from './ui';
import { STATUS_PESANAN, WARNA_STATUS, today } from '../lib/format';
import { useAuth } from '../lib/auth';

/** Tahap yang dananya sudah diterima — pilihan tanggal cair ikut muncul. */
const TAHAP_CAIR = ['CAIR', 'KILAT_CAIR'];

/** Tahap yang barangnya masih berjalan: dananya belum boleh dianggap diterima. */
const TAHAP_BERJALAN = ['DIPROSES', 'DIKIRIM', 'KILAT', 'SELESAI'];

/**
 * Tebakan status pembayaran yang masuk akal untuk tahap yang dipilih.
 *
 * Kejadian yang sering: pesanan terlanjur ditandai Cair padahal masih diproses.
 * Mengembalikannya ke Diproses tanpa membatalkan tanda lunas meninggalkan uang
 * di rekening untuk dana yang belum pernah masuk — jadi tebakannya "belum cair"
 * dan tanggal cairnya dikosongkan.
 */
const bayarUntuk = (status) => (TAHAP_CAIR.includes(status) ? 'PAID' : 'UNPAID');

/**
 * Mengubah status banyak pesanan sekaligus.
 *
 * Tim memindahkan puluhan pesanan per hari dari Diproses ke Dikirim lalu Cair;
 * membuka satu per satu bukan pekerjaan yang masuk akal. Perubahannya tetap
 * lewat jalur ubah pesanan biasa di peladen, jadi jurnal dan piutangnya
 * diperlakukan sama persis dengan mengubahnya satu-satu.
 *
 * "Batal" ikut tersedia karena itulah yang paling sering perlu dibereskan
 * massal, tetapi dijaga tersendiri: hanya pemegang izin pembatalan, dan kata
 * kuncinya diketik ulang — membatalkan mengembalikan stok dan menghapus jurnal.
 */
export default function StatusMassal({ terpilih, onSelesai, onBatalPilih }) {
  const toast = useToast();
  const { punya } = useAuth();
  const bolehBatal = punya('penjualan.batal');

  const [form, setForm] = useState(null);
  const [menyimpan, setMenyimpan] = useState(false);

  const jumlah = terpilih.length;
  const membatalkan = form?.status === 'BATAL';
  const kataKunci = `BATAL ${jumlah}`;
  const siap = form && form.status
    && (!membatalkan || form.konfirmasi === kataKunci);

  async function simpan(e) {
    e.preventDefault();
    setMenyimpan(true);
    try {
      const res = await api.patch('/api/sales/status-massal', {
        ids: terpilih,
        fulfillment_status: form.status,
        ...(form.ubahBayar ? { payment_status: form.payment_status } : {}),
        // Tanggal cair mengikuti status bayarnya: diisi saat dananya diterima,
        // dikosongkan saat pesanan dikembalikan ke tahap berjalan.
        ...(TAHAP_CAIR.includes(form.status) && form.payout_date
          ? { payout_date: form.payout_date }
          : {}),
        ...(form.ubahBayar && form.payment_status === 'UNPAID' ? { payout_date: null } : {}),
        ...(membatalkan ? { konfirmasi: form.konfirmasi } : {}),
      });
      if (res.gagal && res.gagal.length) {
        toast.error(`${res.message}. Gagal pertama: ${res.gagal[0].order_no} — ${res.gagal[0].pesan}`);
      } else {
        toast.success(res.message);
      }
      setForm(null);
      onSelesai?.();
    } catch (err) {
      toast.error(err.message);
    } finally {
      setMenyimpan(false);
    }
  }

  if (!jumlah) return null;

  return (
    <>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3 rounded-xl bg-brand-50 px-4 py-3 text-sm ring-1 ring-brand-200 dark:bg-brand-400/10">
        <span className="font-semibold text-brand-800">
          {jumlah} order terpilih
        </span>
        <div className="flex flex-wrap gap-2">
          <button type="button" className="btn-ghost !py-1.5 text-xs" onClick={onBatalPilih}>
            Bersihkan pilihan
          </button>
          <button
            type="button" className="btn-primary !py-1.5 text-xs"
            onClick={() => setForm({
              status: '', payment_status: 'PAID', ubahBayar: false, payout_date: today(), konfirmasi: '',
            })}
          >
            <ListChecks size={15} /> Ubah Status ({jumlah})
          </button>
        </div>
      </div>

      <Modal open={!!form} onClose={() => setForm(null)} title={`Ubah Status ${jumlah} Order`}>
        {form && (
          <form onSubmit={simpan} className="grid gap-3">
            <Field label="Status pesanan baru *" hint="Berlaku untuk semua order yang dicentang">
              <select
                className="input" required value={form.status}
                onChange={(e) => {
                  const status = e.target.value;
                  setForm({
                    ...form,
                    status,
                    konfirmasi: '',
                    // Mengembalikan pesanan ke tahap berjalan hampir selalu
                    // berarti dananya belum jadi diterima, jadi pilihannya
                    // disiapkan — tetap boleh dilepas bila memang tidak perlu.
                    ubahBayar: TAHAP_BERJALAN.includes(status),
                    payment_status: bayarUntuk(status),
                  });
                }}
              >
                <option value="">— pilih status —</option>
                {Object.entries(STATUS_PESANAN)
                  .filter(([v]) => v !== 'BATAL' || bolehBatal)
                  .map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </select>
            </Field>

            {form.status && (
              <p className="text-xs text-slate-500">
                Menjadi <span className={WARNA_STATUS[form.status] || 'badge-slate'}>{STATUS_PESANAN[form.status]}</span>
              </p>
            )}

            {TAHAP_CAIR.includes(form.status) && (
              <Field label="Tanggal cair" hint="Dikosongkan berarti tanggalnya tidak diubah">
                <input
                  type="date" className="input" value={form.payout_date}
                  onChange={(e) => setForm({ ...form, payout_date: e.target.value })}
                />
              </Field>
            )}

            {!membatalkan && (
              <div className="rounded-xl bg-slate-50 p-3 text-xs">
                <label className="flex items-start gap-2">
                  <input
                    type="checkbox" className="mt-0.5" checked={form.ubahBayar}
                    onChange={(e) => setForm({ ...form, ubahBayar: e.target.checked })}
                  />
                  <span>Sekalian ubah status pembayarannya</span>
                </label>
                {form.ubahBayar && (
                  <>
                    <select
                      className="input mt-2" value={form.payment_status}
                      onChange={(e) => setForm({ ...form, payment_status: e.target.value })}
                    >
                      <option value="PAID">Lunas / dana sudah cair</option>
                      <option value="UNPAID">Belum cair</option>
                    </select>
                    {form.payment_status === 'UNPAID' && (
                      <p className="mt-2 leading-relaxed text-slate-600">
                        Tanggal cairnya ikut dikosongkan, dan dana yang tadinya tercatat masuk rekening
                        kembali menjadi piutang. Ini yang dipakai bila pesanan terlanjur ditandai cair
                        padahal masih diproses.
                      </p>
                    )}
                  </>
                )}
              </div>
            )}

            {membatalkan && (
              <>
                <div className="rounded-xl bg-rose-50 px-3 py-2 text-xs leading-relaxed text-rose-800">
                  <p className="mb-1 flex items-center gap-1.5 font-semibold">
                    <AlertTriangle size={14} /> Membatalkan bukan sekadar mengganti label
                  </p>
                  Stok {jumlah} order ini dikembalikan ke gudang, jurnalnya dihapus, dan returnya ikut
                  dibalik. Order hilang dari daftar dan laporan; jejaknya tetap ada di Riwayat.
                </div>
                <Field label={`Ketik ${kataKunci} untuk melanjutkan`}>
                  <input
                    className="input font-mono" value={form.konfirmasi} placeholder={kataKunci}
                    onChange={(e) => setForm({ ...form, konfirmasi: e.target.value })}
                  />
                </Field>
              </>
            )}

            <div className="flex gap-2">
              <button type="button" className="btn-secondary flex-1" onClick={() => setForm(null)}>Batal</button>
              <button
                type="submit"
                className={`btn-primary flex-1 ${membatalkan ? '!bg-rose-600 hover:!bg-rose-700' : ''}`}
                disabled={!siap || menyimpan}
              >
                {menyimpan ? <Loader2 size={16} className="animate-spin" /> : <ListChecks size={16} />}
                {menyimpan ? 'Menyimpan...' : membatalkan ? `Batalkan ${jumlah} Order` : `Ubah ${jumlah} Order`}
              </button>
            </div>
          </form>
        )}
      </Modal>
    </>
  );
}
