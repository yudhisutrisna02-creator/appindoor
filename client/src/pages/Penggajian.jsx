import { useEffect, useState, useCallback } from 'react';
import {
  Wallet, Plus, ArrowLeft, BookCheck, Undo2, Trash2, Pencil, AlertTriangle, Lock, Printer, FileText,
} from 'lucide-react';
import { api } from '../lib/api';
import {
  PageHeader, StatCard, Spinner, EmptyState, Modal,
  useToast, Field, TombolEkspor, TombolCetak,
} from '../components/ui';
import { rupiah, rupiahShort, dateID } from '../lib/format';
import { useAuth } from '../lib/auth';

const bulanIni = () => new Date().toLocaleDateString('sv-SE').slice(0, 7);

const NAMA_BULAN = [
  'Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni',
  'Juli', 'Agustus', 'September', 'Oktober', 'November', 'Desember',
];
const labelPeriode = (p) => {
  const [th, bl] = String(p).split('-');
  return `${NAMA_BULAN[Number(bl) - 1]} ${th}`;
};

const SUMBER = {
  BANK: 'Transfer bank',
  CASH: 'Tunai',
  CREDIT: 'Belum dibayar (jadi Utang Gaji)',
};

/**
 * Penggajian bulanan.
 *
 * Selama ini presensi berhenti sebagai catatan dan beban gaji diketik ulang dari
 * kertas. Layar ini menyambungkan keduanya: rekap kehadiran ikut membeku
 * bersama slipnya, dan postingnya membuat jurnal yang mengurangi kas.
 */
export default function Penggajian() {
  const toast = useToast();
  const { punya } = useAuth();
  const bolehKelola = punya('penggajian.kelola');
  const bolehPosting = punya('penggajian.posting');

  const [daftar, setDaftar] = useState(null);
  const [buka, setBuka] = useState(null);      // detail daftar gaji
  const [loading, setLoading] = useState(true);
  const [form, setForm] = useState(null);      // daftar gaji baru
  const [baris, setBaris] = useState(null);    // baris yang sedang diubah
  const [saving, setSaving] = useState(false);

  const muatDaftar = useCallback(async () => {
    setLoading(true);
    try {
      setDaftar(await api.get('/api/penggajian'));
    } catch (err) {
      toast.error(err.message);
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => { muatDaftar(); }, [muatDaftar]);

  async function bukaDetail(id) {
    setLoading(true);
    try {
      setBuka(await api.get(`/api/penggajian/${id}`));
    } catch (err) {
      toast.error(err.message);
    } finally {
      setLoading(false);
    }
  }

  async function susun(e) {
    e.preventDefault();
    setSaving(true);
    try {
      const res = await api.post('/api/penggajian', {
        period: form.period,
        pay_date: form.pay_date || undefined,
        payment: form.payment,
        note: form.note || null,
      });
      toast.success(res.message);
      setForm(null);
      setBuka(res.payroll);
      muatDaftar();
    } catch (err) {
      toast.error(err.message);
    } finally {
      setSaving(false);
    }
  }

  async function simpanBaris(e) {
    e.preventDefault();
    setSaving(true);
    try {
      const res = await api.put(`/api/penggajian/${buka.id}/baris/${baris.id}`, {
        base: Number(baris.base) || 0,
        allowance: Number(baris.allowance) || 0,
        overtime: Number(baris.overtime) || 0,
        bonus: Number(baris.bonus) || 0,
        deduction: Number(baris.deduction) || 0,
        note: baris.note || null,
      });
      toast.success(res.message);
      setBuka(res.payroll);
      setBaris(null);
    } catch (err) {
      toast.error(err.message);
    } finally {
      setSaving(false);
    }
  }

  async function posting() {
    if (!window.confirm(
      `Posting gaji ${labelPeriode(buka.period)} sebesar ${rupiah(buka.total.net)}? ` +
      'Jurnalnya akan mengurangi kas dan daftarnya terkunci.'
    )) return;
    try {
      const res = await api.post(`/api/penggajian/${buka.id}/posting`);
      toast.success(res.message);
      setBuka(res.payroll);
      muatDaftar();
    } catch (err) {
      toast.error(err.message);
    }
  }

  async function batalPosting() {
    if (!window.confirm('Batalkan posting? Jurnalnya dihapus dan daftar kembali menjadi draft.')) return;
    try {
      const res = await api.post(`/api/penggajian/${buka.id}/batal-posting`);
      toast.success(res.message);
      setBuka(res.payroll);
      muatDaftar();
    } catch (err) {
      toast.error(err.message);
    }
  }

  async function hapusDaftar(p) {
    if (!window.confirm(`Hapus daftar gaji ${labelPeriode(p.period)}?`)) return;
    try {
      const res = await api.del(`/api/penggajian/${p.id}`);
      toast.success(res.message);
      setBuka(null);
      muatDaftar();
    } catch (err) {
      toast.error(err.message);
    }
  }

  if (loading && !buka && !daftar) return <Spinner label="Memuat penggajian..." />;

  // ---------- Detail satu daftar gaji ----------
  if (buka) {
    const t = buka.total;
    const belumDigaji = buka.rows.filter((r) => r.net <= 0).length;

    return (
      <div>
        <PageHeader
          title={`Gaji ${labelPeriode(buka.period)}`}
          subtitle={`Dibayar ${dateID(buka.pay_date)} • ${SUMBER[buka.payment]} • ${buka.rows.length} pegawai`}
        >
          <button className="btn-secondary" onClick={() => { setBuka(null); muatDaftar(); }}>
            <ArrowLeft size={16} /> Daftar
          </button>
          {buka.terkunci
            ? bolehPosting && (
              <button className="btn-secondary" onClick={batalPosting}>
                <Undo2 size={16} /> Batalkan Posting
              </button>
            )
            : bolehPosting && (
              <button className="btn-primary" onClick={posting}>
                <BookCheck size={16} /> Posting ke Pembukuan
              </button>
            )}
          <TombolCetak
            path={`/api/penggajian/${buka.id}/slip/pdf`}
            label="Cetak Semua Slip" icon={Printer}
          />
          <TombolEkspor path={`/api/penggajian/${buka.id}`} nama={`gaji-${buka.period}`} csv />
        </PageHeader>

        <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
          <StatCard label="Gaji Pokok" value={rupiahShort(t.base)} />
          <StatCard label="Tunjangan + Lembur + Bonus" value={rupiahShort(t.allowance + t.overtime + t.bonus)} />
          <StatCard label="Potongan" value={rupiahShort(t.deduction)} tone={t.deduction > 0 ? 'amber' : 'slate'} />
          <StatCard
            label="Total Dibayarkan" value={rupiahShort(t.net)} icon={Wallet}
            sub={buka.terkunci ? 'sudah masuk pembukuan' : 'belum diposting'}
            tone={buka.terkunci ? 'green' : 'brand'}
          />
        </div>

        {buka.terkunci && (
          <div className="card mb-4 border-2 border-emerald-200 bg-emerald-50/60 dark:bg-emerald-400/10">
            <div className="flex items-start gap-2">
              <Lock size={17} className="mt-0.5 shrink-0 text-emerald-600" />
              <div className="text-sm text-slate-700">
                <p className="font-semibold text-slate-900">Sudah diposting ke pembukuan</p>
                <p className="mt-1 text-xs leading-relaxed">
                  Beban Gaji &amp; Tunjangan bertambah {rupiah(t.net)}, dan{' '}
                  {buka.payment === 'CREDIT' ? 'Utang Gaji' : 'kas'} berkurang sebesar yang sama.
                  {buka.jurnal.length > 0 && ` Jurnal ${buka.jurnal.map((j) => j.entry_no).join(', ')}.`}
                  {' '}Batalkan postingnya dulu bila angkanya perlu diubah.
                </p>
              </div>
            </div>
          </div>
        )}

        {!buka.terkunci && belumDigaji > 0 && (
          <div className="card mb-4 border-2 border-amber-200 bg-amber-50/60 dark:bg-amber-400/10">
            <div className="flex items-start gap-2">
              <AlertTriangle size={17} className="mt-0.5 shrink-0 text-amber-600" />
              <div className="text-sm text-slate-700">
                <p className="font-semibold text-slate-900">{belumDigaji} orang bergaji nol</p>
                <p className="mt-1 text-xs leading-relaxed">
                  Gaji pokoknya belum diisi. Isi lewat tombol Ubah di barisnya, atau lewat
                  Sistem → Data Tim supaya bulan berikutnya terisi sendiri.
                </p>
              </div>
            </div>
          </div>
        )}

        <div className="card">
          <h2 className="card-title mb-3">Rincian per Pegawai</h2>
          <div className="overflow-x-auto">
            <table className="table">
              <thead>
                <tr>
                  <th>Pegawai</th>
                  <th className="text-center">Hadir</th>
                  <th className="text-center">Telat</th>
                  <th className="text-center">Izin</th>
                  <th className="text-center">Alpa</th>
                  <th className="text-right">Gaji Pokok</th>
                  <th className="text-right">Tunjangan</th>
                  <th className="text-right">Lembur+Bonus</th>
                  <th className="text-right">Potongan</th>
                  <th className="text-right">Gaji Bersih</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {buka.rows.map((r) => (
                  <tr key={r.id}>
                    <td>
                      <p className="font-medium text-slate-900">{r.name}</p>
                      <p className="text-xs text-slate-500">
                        {[r.position, r.bank_name && `${r.bank_name} ${r.bank_account || ''}`.trim()]
                          .filter(Boolean).join(' • ') || 'data bank belum diisi'}
                      </p>
                    </td>
                    <td className="tabular text-center">{r.hadir}</td>
                    <td className={`tabular text-center ${r.telat > 0 ? 'text-amber-600' : 'text-slate-400'}`}>{r.telat}</td>
                    <td className="tabular text-center text-slate-500">{r.izin}</td>
                    <td className={`tabular text-center ${r.alpa > 0 ? 'font-semibold text-rose-600' : 'text-slate-400'}`}>{r.alpa}</td>
                    <td className="tabular text-right">{rupiah(r.base)}</td>
                    <td className="tabular text-right">{rupiah(r.allowance)}</td>
                    <td className="tabular text-right">{rupiah(r.overtime + r.bonus)}</td>
                    <td className={`tabular text-right ${r.deduction > 0 ? 'text-rose-600' : ''}`}>
                      {r.deduction > 0 ? `−${rupiah(r.deduction)}` : '—'}
                      {r.alpa > 0 && r.deduction === 0 && (
                        <span className="block text-xs text-amber-600">saran {rupiahShort(r.potongan_saran)}</span>
                      )}
                    </td>
                    <td className={`tabular text-right font-semibold ${r.net <= 0 ? 'text-rose-600' : 'text-slate-900'}`}>
                      {rupiah(r.net)}
                    </td>
                    <td className="text-right">
                      <div className="flex justify-end gap-1">
                        <TombolCetak
                          path={`/api/penggajian/${buka.id}/slip/${r.id}/pdf`}
                          label="Slip" icon={FileText} kecil
                        />
                        {!buka.terkunci && bolehKelola && (
                          <button className="btn-ghost !px-2 !py-1 text-xs" onClick={() => setBaris({ ...r })}>
                            <Pencil size={13} />
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <p className="mt-3 text-xs leading-relaxed text-slate-500">
            Hadir, telat, izin, dan alpa diambil dari menu Presensi untuk bulan ini dan dibekukan
            bersama slipnya. Potongan karena alpa hanya <em>disarankan</em>, tidak pernah dipotong
            sendiri — alasan seseorang tidak masuk tidak seluruhnya ada di dalam aplikasi. Saran
            dihitung dari gaji pokok dibagi {buka.hari_kerja} hari kerja bulan ini.
          </p>
        </div>

        <Modal open={!!baris} onClose={() => setBaris(null)} title={`Gaji ${baris ? baris.name : ''}`}>
          {baris && (
            <form onSubmit={simpanBaris} className="grid gap-3">
              <div className="rounded-xl bg-slate-50 px-3 py-2 text-xs text-slate-600">
                Hadir {baris.hadir} • Telat {baris.telat} • Izin {baris.izin} • Alpa {baris.alpa}
                {baris.alpa > 0 && (
                  <>
                    <br />
                    Saran potongan {rupiah(baris.potongan_saran)} ({baris.alpa} hari ×{' '}
                    {rupiah(baris.nilai_per_hari)})
                    <button
                      type="button" className="ml-2 underline"
                      onClick={() => setBaris({ ...baris, deduction: baris.potongan_saran })}
                    >
                      pakai saran
                    </button>
                  </>
                )}
              </div>
              <Field label="Gaji Pokok">
                <input type="number" min="0" step="1000" className="input" value={baris.base}
                  onChange={(e) => setBaris({ ...baris, base: e.target.value })} />
              </Field>
              <Field label="Tunjangan">
                <input type="number" min="0" step="1000" className="input" value={baris.allowance}
                  onChange={(e) => setBaris({ ...baris, allowance: e.target.value })} />
              </Field>
              <Field label="Lembur">
                <input type="number" min="0" step="1000" className="input" value={baris.overtime}
                  onChange={(e) => setBaris({ ...baris, overtime: e.target.value })} />
              </Field>
              <Field label="Bonus">
                <input type="number" min="0" step="1000" className="input" value={baris.bonus}
                  onChange={(e) => setBaris({ ...baris, bonus: e.target.value })} />
              </Field>
              <Field label="Potongan">
                <input type="number" min="0" step="1000" className="input" value={baris.deduction}
                  onChange={(e) => setBaris({ ...baris, deduction: e.target.value })} />
              </Field>
              <Field label="Catatan">
                <input className="input" maxLength={200} value={baris.note || ''}
                  onChange={(e) => setBaris({ ...baris, note: e.target.value })} />
              </Field>
              <div className="flex gap-2">
                <button type="button" className="btn-secondary flex-1" onClick={() => setBaris(null)}>Batal</button>
                <button type="submit" className="btn-primary flex-1" disabled={saving}>
                  {saving ? 'Menyimpan...' : 'Simpan'}
                </button>
              </div>
            </form>
          )}
        </Modal>
      </div>
    );
  }

  // ---------- Daftar seluruh periode ----------
  const r = daftar ? daftar.ringkas : { daftar: 0, draft: 0, totalTerbayar: 0 };

  return (
    <div>
      <PageHeader title="Penggajian" subtitle="Gaji bulanan, terhubung ke presensi dan pembukuan">
        {bolehKelola && (
          <button
            className="btn-primary"
            onClick={() => setForm({ period: bulanIni(), pay_date: '', payment: 'BANK', note: '' })}
          >
            <Plus size={16} /> Susun Daftar Gaji
          </button>
        )}
      </PageHeader>

      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-3">
        <StatCard label="Periode Tercatat" value={r.daftar} icon={Wallet} />
        <StatCard label="Masih Draft" value={r.draft} tone={r.draft > 0 ? 'amber' : 'green'}
          sub={r.draft > 0 ? 'belum masuk pembukuan' : 'semua sudah diposting'} />
        <StatCard label="Total Sudah Dibayarkan" value={rupiahShort(r.totalTerbayar)} tone="brand" />
      </div>

      <div className="card">
        {!daftar || daftar.rows.length === 0 ? (
          <EmptyState
            message="Belum ada daftar gaji"
            hint="Susun daftar gaji bulanan — gaji pokok tiap orang diambil dari Sistem → Data Tim"
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="table">
              <thead>
                <tr>
                  <th>Periode</th>
                  <th>Tanggal Bayar</th>
                  <th>Sumber Dana</th>
                  <th className="text-center">Pegawai</th>
                  <th className="text-right">Total</th>
                  <th>Status</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {daftar.rows.map((p) => (
                  <tr key={p.id}>
                    <td className="font-medium text-slate-900">{labelPeriode(p.period)}</td>
                    <td>{dateID(p.pay_date)}</td>
                    <td className="text-xs text-slate-600">{SUMBER[p.payment]}</td>
                    <td className="tabular text-center">{p.pegawai}</td>
                    <td className="tabular text-right font-semibold">{rupiah(p.total)}</td>
                    <td>
                      <span className={`inline-block rounded-md px-2 py-0.5 text-xs ring-1 ${
                        p.status === 'POSTED'
                          ? 'bg-emerald-50 text-emerald-700 ring-emerald-200 dark:bg-emerald-400/10'
                          : 'bg-amber-50 text-amber-700 ring-amber-200 dark:bg-amber-400/10'
                      }`}>
                        {p.status === 'POSTED' ? 'Diposting' : 'Draft'}
                      </span>
                    </td>
                    <td className="text-right">
                      <button className="btn-ghost !px-2 !py-1 text-xs" onClick={() => bukaDetail(p.id)}>
                        Buka
                      </button>
                      {bolehKelola && p.status === 'DRAFT' && (
                        <button className="btn-ghost !px-2 !py-1 text-xs text-rose-600" onClick={() => hapusDaftar(p)}>
                          <Trash2 size={13} />
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <Modal open={!!form} onClose={() => setForm(null)} title="Susun Daftar Gaji">
        {form && (
          <form onSubmit={susun} className="grid gap-3">
            <Field label="Periode *" hint="Seluruh pegawai aktif ikut, beserta rekap presensinya">
              <input type="month" className="input" required value={form.period}
                onChange={(e) => setForm({ ...form, period: e.target.value })} />
            </Field>
            <Field label="Tanggal Bayar" hint="Kosongkan untuk tanggal 25 pada bulan itu">
              <input type="date" className="input" value={form.pay_date}
                onChange={(e) => setForm({ ...form, pay_date: e.target.value })} />
            </Field>
            <Field label="Sumber Dana">
              <select className="input" value={form.payment}
                onChange={(e) => setForm({ ...form, payment: e.target.value })}>
                {Object.entries(SUMBER).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
              </select>
            </Field>
            <Field label="Catatan">
              <input className="input" maxLength={300} value={form.note}
                onChange={(e) => setForm({ ...form, note: e.target.value })} />
            </Field>
            <p className="rounded-xl bg-slate-50 px-3 py-2 text-xs text-slate-600">
              Daftar dibuat sebagai draft dan belum menyentuh pembukuan sama sekali. Angkanya masih
              bisa diubah per orang; jurnalnya baru terbentuk saat diposting.
            </p>
            <div className="flex gap-2">
              <button type="button" className="btn-secondary flex-1" onClick={() => setForm(null)}>Batal</button>
              <button type="submit" className="btn-primary flex-1" disabled={saving}>
                {saving ? 'Menyusun...' : 'Susun'}
              </button>
            </div>
          </form>
        )}
      </Modal>
    </div>
  );
}
