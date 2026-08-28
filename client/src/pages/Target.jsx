import { useEffect, useState, useCallback } from 'react';
import { Target as TargetIcon, TrendingUp, Copy, Pencil, Trash2, AlertTriangle } from 'lucide-react';
import { api } from '../lib/api';
import {
  PageHeader, StatCard, Spinner, EmptyState, Modal,
  useToast, Field, TombolEkspor,
} from '../components/ui';
import { rupiah, rupiahShort, num } from '../lib/format';
import { useAuth } from '../lib/auth';

const bulanIni = () => new Date().toLocaleDateString('sv-SE').slice(0, 7);

const NAMA_BULAN = [
  'Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni',
  'Juli', 'Agustus', 'September', 'Oktober', 'November', 'Desember',
];

const labelPeriode = (p) => {
  const [th, bl] = p.split('-');
  return `${NAMA_BULAN[Number(bl) - 1]} ${th}`;
};

const KOSONG = { shop_id: null, omzet: 0, laba: 0, orders: 0, budget_iklan: 0, note: '' };

/** Warna batang kemajuan — merah bila tertinggal jauh, hijau bila sudah tercapai. */
function nadaCapai(pct, lewatBatas = false) {
  if (lewatBatas) return 'bg-rose-500';
  if (pct === null) return 'bg-slate-300';
  if (pct >= 100) return 'bg-emerald-500';
  if (pct >= 70) return 'bg-amber-500';
  return 'bg-rose-400';
}

function Batang({ pct, lewatBatas }) {
  const lebar = pct === null ? 0 : Math.min(100, Math.max(0, pct));
  return (
    <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-slate-200">
      <div className={`h-full rounded-full ${nadaCapai(pct, lewatBatas)}`} style={{ width: `${lebar}%` }} />
    </div>
  );
}

/** Satu ukuran: target, kenyataan, dan seberapa jauh jaraknya. */
function Ukuran({ label, target, nyata, pct, uang = true, lewatBatas = false, catatan }) {
  const tulis = (n) => (uang ? rupiah(n) : num(n));
  return (
    <div>
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-xs font-medium text-slate-500">{label}</span>
        <span className={`tabular text-xs ${pct === null ? 'text-slate-400' : lewatBatas ? 'font-semibold text-rose-600' : 'text-slate-500'}`}>
          {pct === null ? 'belum ditarget' : `${pct}%`}
        </span>
      </div>
      <p className="tabular mt-0.5 text-sm font-semibold text-slate-900">{tulis(nyata)}</p>
      {target > 0 && <p className="tabular text-xs text-slate-500">dari {tulis(target)}</p>}
      <Batang pct={pct} lewatBatas={lewatBatas} />
      {catatan && <p className="mt-1 text-xs text-slate-500">{catatan}</p>}
    </div>
  );
}

/**
 * Target & pencapaian bulanan.
 *
 * Yang disimpan hanya targetnya. Pencapaiannya dihitung ulang dari order
 * penjualan dan belanja iklan setiap kali dibuka, supaya tidak pernah ada dua
 * versi angka yang sama.
 */
export default function Target() {
  const toast = useToast();
  const { punya } = useAuth();
  const bolehKelola = punya('target.kelola');

  const [period, setPeriod] = useState(bulanIni);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [form, setForm] = useState(null);
  const [salin, setSalin] = useState(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setData(await api.get('/api/target', { period }));
    } catch (err) {
      toast.error(err.message);
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [period]);

  useEffect(() => { load(); }, [load]);

  async function simpan(e) {
    e.preventDefault();
    setSaving(true);
    try {
      const res = await api.post('/api/target', {
        period,
        shop_id: form.shop_id || null,
        omzet: Number(form.omzet) || 0,
        laba: Number(form.laba) || 0,
        orders: Number(form.orders) || 0,
        budget_iklan: Number(form.budget_iklan) || 0,
        note: form.note || null,
      });
      toast.success(res.message);
      setForm(null);
      load();
    } catch (err) {
      toast.error(err.message);
    } finally {
      setSaving(false);
    }
  }

  async function jalankanSalin(e) {
    e.preventDefault();
    setSaving(true);
    try {
      const res = await api.post('/api/target/salin', {
        dari: salin.dari,
        ke: period,
        naikPersen: Number(salin.naikPersen) || 0,
        timpa: !!salin.timpa,
      });
      toast.success(res.message);
      setSalin(null);
      load();
    } catch (err) {
      toast.error(err.message);
    } finally {
      setSaving(false);
    }
  }

  async function hapus(baris) {
    if (!window.confirm(`Hapus target ${baris.nama} untuk ${labelPeriode(period)}?`)) return;
    try {
      const res = await api.del(`/api/target/${baris.target_id}`);
      toast.success(res.message);
      load();
    } catch (err) {
      toast.error(err.message);
    }
  }

  const buka = (baris) =>
    setForm(
      baris && baris.punyaTarget
        ? {
            shop_id: baris.kunci === 0 || baris.kunci === 'lepas' ? null : baris.kunci,
            omzet: baris.target.omzet,
            laba: baris.target.laba,
            orders: baris.target.orders,
            budget_iklan: baris.target.budget_iklan,
            note: baris.target.note || '',
            nama: baris.nama,
          }
        : {
            ...KOSONG,
            shop_id: baris && baris.kunci !== 0 && baris.kunci !== 'lepas' ? baris.kunci : null,
            nama: baris ? baris.nama : 'Seluruh Perusahaan',
          }
    );

  if (loading || !data) return <Spinner label="Menghitung pencapaian..." />;

  const p = data.perusahaan;
  const sisaHari = Math.max(0, data.hari.total - data.hari.lewat);

  return (
    <div>
      <PageHeader title="Target & Pencapaian" subtitle="Sasaran bulanan diadu dengan penjualan dan iklan yang benar-benar tercatat">
        {bolehKelola && (
          <>
            <button className="btn-secondary" onClick={() => setSalin({ dari: '', naikPersen: 0, timpa: false })}>
              <Copy size={16} /> Salin Bulan Lain
            </button>
            <button className="btn-primary" onClick={() => buka(null)}>
              <TargetIcon size={16} /> Target Perusahaan
            </button>
          </>
        )}
        <TombolEkspor path="/api/target" params={{ period }} nama={`target-${period}`} />
      </PageHeader>

      <div className="card mb-4">
        <Field label="Bulan" className="max-w-xs">
          <input type="month" className="input" value={period} onChange={(e) => setPeriod(e.target.value)} />
        </Field>
        <p className="mt-2 text-xs text-slate-500">
          {data.hari.berjalan
            ? `Hari ke-${data.hari.lewat} dari ${data.hari.total} — tersisa ${sisaHari} hari.`
            : `Bulan ${labelPeriode(period)} sudah lengkap ${data.hari.total} hari.`}
        </p>
      </div>

      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard
          label="Omzet" value={rupiahShort(p.realisasi.omzet)}
          sub={p.target.omzet > 0 ? `${p.capai.omzet}% dari ${rupiahShort(p.target.omzet)}` : 'target belum ditetapkan'}
          icon={TrendingUp}
          tone={p.capai.omzet === null ? 'slate' : p.capai.omzet >= 100 ? 'green' : p.capai.omzet >= 70 ? 'amber' : 'red'}
        />
        <StatCard
          label="Laba Setelah Iklan" value={rupiahShort(p.realisasi.laba)}
          sub={p.target.laba > 0 ? `${p.capai.laba}% dari ${rupiahShort(p.target.laba)}` : 'target belum ditetapkan'}
          tone={p.capai.laba === null ? 'slate' : p.capai.laba >= 100 ? 'green' : p.capai.laba >= 70 ? 'amber' : 'red'}
        />
        <StatCard
          label="Order" value={num(p.realisasi.orders)}
          sub={p.target.orders > 0 ? `${p.capai.orders}% dari ${num(p.target.orders)}` : 'target belum ditetapkan'}
        />
        <StatCard
          label="Belanja Iklan" value={rupiahShort(p.realisasi.iklan)}
          sub={p.target.budget_iklan > 0
            ? `${p.capai.iklan}% dari batas ${rupiahShort(p.target.budget_iklan)}`
            : 'batas belum ditetapkan'}
          icon={p.iklanLewatBatas ? AlertTriangle : undefined}
          tone={p.iklanLewatBatas ? 'red' : 'brand'}
        />
      </div>

      {data.hari.berjalan && p.proyeksi.omzet !== null && p.target.omzet > 0 && (
        <div className="card mb-4">
          <h2 className="card-title mb-2">Perkiraan Akhir Bulan</h2>
          <p className="text-sm leading-relaxed text-slate-700">
            Bila laju {data.hari.lewat} hari terakhir diteruskan, bulan ini ditutup di{' '}
            <span className="font-semibold text-slate-900">{rupiah(p.proyeksi.omzet)}</span> omzet
            {' '}dan{' '}
            <span className="font-semibold text-slate-900">{rupiah(p.proyeksi.laba)}</span> laba setelah iklan.
            {p.proyeksi.omzet >= p.target.omzet ? (
              <span className="text-emerald-700"> Target omzet akan terlampaui.</span>
            ) : (
              <>
                {' '}Target omzet masih kurang{' '}
                <span className="font-semibold text-rose-600">{rupiah(p.kurang.omzet)}</span>
                {sisaHari > 0 && p.perHari.omzet !== null && (
                  <> — perlu {rupiah(p.perHari.omzet)} per hari selama {sisaHari} hari tersisa.</>
                )}
              </>
            )}
          </p>
          <p className="mt-2 text-xs text-slate-500">
            Ini perkiraan lurus, bukan ramalan: tanggal gajian, kampanye marketplace, dan hari besar
            tidak diperhitungkan.
          </p>
        </div>
      )}

      {p.punyaTarget && p.selisihDenganToko !== null && Math.abs(p.selisihDenganToko) > 0.5 && (
        <div className="card mb-4 border-2 border-amber-200 bg-amber-50/60 dark:bg-amber-400/10">
          <div className="flex items-start gap-2">
            <AlertTriangle size={17} className="mt-0.5 shrink-0 text-amber-600" />
            <div className="text-sm text-slate-700">
              <p className="font-semibold text-slate-900">Target perusahaan dan jumlah target toko berbeda</p>
              <p className="mt-1 text-xs leading-relaxed">
                Target perusahaan {rupiah(p.target.omzet)}, sedangkan jumlah target seluruh toko{' '}
                {rupiah(p.targetTokoDijumlah.omzet)} —{' '}
                {p.selisihDenganToko > 0
                  ? `ada ${rupiah(p.selisihDenganToko)} yang belum dibagikan ke toko mana pun.`
                  : `${rupiah(Math.abs(p.selisihDenganToko))} lebih besar daripada target perusahaan.`}
                {' '}Keduanya boleh berbeda, tetapi selisihnya sebaiknya disengaja.
              </p>
            </div>
          </div>
        </div>
      )}

      <div className="card">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <h2 className="card-title">Per Toko</h2>
          {!p.punyaTarget && bolehKelola && (
            <span className="text-xs text-slate-500">
              Target perusahaan belum ditetapkan untuk {labelPeriode(period)}.
            </span>
          )}
        </div>

        {data.rows.length === 0 ? (
          <EmptyState message="Belum ada toko terdaftar" hint="Tambahkan toko di menu Penjualan → Toko / Marketplace" />
        ) : (
          <div className="space-y-3">
            {data.rows.map((r) => (
              <div
                key={r.kunci}
                className={`rounded-xl p-4 ring-1 ${
                  r.iklanLewatBatas ? 'bg-rose-50/50 ring-rose-200 dark:bg-rose-400/5' : 'bg-slate-50 ring-slate-200'
                }`}
              >
                <div className="mb-3 flex flex-wrap items-start justify-between gap-2">
                  <div>
                    <p className="font-semibold text-slate-900">{r.nama}</p>
                    <p className="text-xs text-slate-500">
                      {r.channelLabel}
                      {!r.punyaTarget && ' • belum ditarget'}
                    </p>
                  </div>
                  {bolehKelola && r.kunci !== 'lepas' && (
                    <div className="flex gap-1">
                      <button className="btn-ghost !px-2 !py-1 text-xs" onClick={() => buka(r)}>
                        <Pencil size={13} /> {r.punyaTarget ? 'Ubah' : 'Tetapkan'}
                      </button>
                      {r.punyaTarget && (
                        <button className="btn-ghost !px-2 !py-1 text-xs text-rose-600" onClick={() => hapus(r)}>
                          <Trash2 size={13} />
                        </button>
                      )}
                    </div>
                  )}
                </div>

                <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                  <Ukuran label="Omzet" target={r.target.omzet} nyata={r.realisasi.omzet} pct={r.capai.omzet} />
                  <Ukuran label="Laba setelah iklan" target={r.target.laba} nyata={r.realisasi.laba} pct={r.capai.laba} />
                  <Ukuran label="Order" target={r.target.orders} nyata={r.realisasi.orders} pct={r.capai.orders} uang={false} />
                  <Ukuran
                    label="Belanja iklan" target={r.target.budget_iklan} nyata={r.realisasi.iklan}
                    pct={r.capai.iklan} lewatBatas={r.iklanLewatBatas}
                    catatan={r.iklanLewatBatas ? 'melewati batas anggaran' : undefined}
                  />
                </div>

                {r.target.note && <p className="mt-3 text-xs text-slate-500">{r.target.note}</p>}
              </div>
            ))}
          </div>
        )}

        <p className="mt-3 text-xs leading-relaxed text-slate-500">
          Angka realisasi tidak disimpan di menu ini — ia dihitung ulang dari order penjualan dan
          belanja iklan setiap kali halaman dibuka, sehingga tidak bisa berbeda dari Analisis Margin
          maupun Biaya Iklan. &quot;Laba setelah iklan&quot; adalah laba bersih order dikurangi belanja
          iklan toko itu pada bulan yang sama.
        </p>
      </div>

      <Modal open={!!form} onClose={() => setForm(null)} title={`Target ${form ? form.nama : ''} — ${labelPeriode(period)}`}>
        {form && (
          <form onSubmit={simpan} className="grid gap-3">
            <Field label="Target Omzet" hint="Pendapatan bersih penjualan sebelum biaya iklan">
              <input type="number" min="0" step="1000" className="input" value={form.omzet}
                onChange={(e) => setForm({ ...form, omzet: e.target.value })} />
            </Field>
            <Field label="Target Laba" hint="Laba bersih setelah belanja iklan dipotong">
              <input type="number" min="0" step="1000" className="input" value={form.laba}
                onChange={(e) => setForm({ ...form, laba: e.target.value })} />
            </Field>
            <Field label="Target Jumlah Order">
              <input type="number" min="0" step="1" className="input" value={form.orders}
                onChange={(e) => setForm({ ...form, orders: e.target.value })} />
            </Field>
            <Field label="Batas Belanja Iklan" hint="Batas, bukan sasaran — 100% berarti anggaran habis">
              <input type="number" min="0" step="1000" className="input" value={form.budget_iklan}
                onChange={(e) => setForm({ ...form, budget_iklan: e.target.value })} />
            </Field>
            <Field label="Catatan">
              <input className="input" value={form.note} maxLength={300}
                onChange={(e) => setForm({ ...form, note: e.target.value })} />
            </Field>
            <div className="flex gap-2">
              <button type="button" className="btn-secondary flex-1" onClick={() => setForm(null)}>Batal</button>
              <button type="submit" className="btn-primary flex-1" disabled={saving}>
                {saving ? 'Menyimpan...' : 'Simpan'}
              </button>
            </div>
          </form>
        )}
      </Modal>

      <Modal open={!!salin} onClose={() => setSalin(null)} title={`Salin Target ke ${labelPeriode(period)}`}>
        {salin && (
          <form onSubmit={jalankanSalin} className="grid gap-3">
            <Field label="Salin dari bulan *">
              <select className="input" required value={salin.dari}
                onChange={(e) => setSalin({ ...salin, dari: e.target.value })}>
                <option value="">— pilih bulan —</option>
                {data.periodeAda.filter((x) => x !== period).map((x) => (
                  <option key={x} value={x}>{labelPeriode(x)}</option>
                ))}
              </select>
            </Field>
            {data.periodeAda.filter((x) => x !== period).length === 0 && (
              <p className="rounded-xl bg-slate-50 px-3 py-2 text-xs text-slate-600">
                Belum ada bulan lain yang punya target untuk disalin.
              </p>
            )}
            <Field label="Naikkan (%)" hint="Isi 10 untuk menaikkan seluruh target 10%; 0 berarti sama persis">
              <input type="number" step="1" min="-100" max="1000" className="input" value={salin.naikPersen}
                onChange={(e) => setSalin({ ...salin, naikPersen: e.target.value })} />
            </Field>
            <label className="flex items-center gap-2 rounded-xl bg-slate-50 px-3 py-2 text-xs text-slate-600">
              <input type="checkbox" checked={salin.timpa}
                onChange={(e) => setSalin({ ...salin, timpa: e.target.checked })} />
              Timpa target yang sudah ada di bulan ini
            </label>
            <div className="flex gap-2">
              <button type="button" className="btn-secondary flex-1" onClick={() => setSalin(null)}>Batal</button>
              <button type="submit" className="btn-primary flex-1" disabled={saving || !salin.dari}>
                {saving ? 'Menyalin...' : 'Salin'}
              </button>
            </div>
          </form>
        )}
      </Modal>
    </div>
  );
}
