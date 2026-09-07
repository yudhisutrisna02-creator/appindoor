import { useEffect, useState, useCallback } from 'react';
import { Wrench, PackageCheck, Trash2, Clock, Info } from 'lucide-react';
import { api } from '../lib/api';
import {
  PageHeader, StatCard, Spinner, EmptyState, Modal,
  DateRangeFilter, defaultRange, useToast, Field, TombolEkspor,
} from '../components/ui';
import { rupiah, num, dateID, today } from '../lib/format';
import { useAuth } from '../lib/auth';

const WARNA_STATUS = {
  MENUNGGU: 'badge-amber',
  SELESAI: 'badge-green',
  HAPUS: 'badge-slate',
};

const LABEL_STATUS = {
  MENUNGGU: 'Menunggu',
  SELESAI: 'Selesai',
  HAPUS: 'Dihapus',
};

/**
 * Barang retur yang masih bisa diselamatkan.
 *
 * Yang berstatus menunggu selalu tampil seluruhnya, tanpa memandang rentang
 * tanggal — barang yang sudah lama tertahan justru tidak akan muncul di rentang
 * mana pun yang baru, dan justru itu yang paling perlu dikerjakan.
 */
export default function Perbaikan() {
  const toast = useToast();
  const { punya } = useAuth();
  const bolehKerjakan = punya('gudang.mutasi');

  const [range, setRange] = useState(defaultRange);
  const [status, setStatus] = useState('');
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [selesai, setSelesai] = useState(null);
  const [saving, setSaving] = useState(false);
  const [rekening, setRekening] = useState([]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setData(await api.get('/api/perbaikan', { ...range, status }));
    } catch (err) {
      toast.error(err.message);
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [range, status]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    api.get('/api/cashflow/options').then((d) => setRekening(d.cashAccounts || [])).catch(() => {});
  }, []);

  async function simpanSelesai(e) {
    e.preventDefault();
    setSaving(true);
    try {
      const res = await api.post(`/api/perbaikan/${selesai.id}/selesai`, {
        tanggal_selesai: selesai.tanggal_selesai,
        biaya_perbaikan: Number(selesai.biaya_perbaikan) || 0,
        cash_code: Number(selesai.biaya_perbaikan) > 0 ? selesai.cash_code : null,
        catatan: selesai.catatan || null,
      });
      toast.success(res.message);
      setSelesai(null);
      load();
    } catch (err) {
      toast.error(err.message);
    } finally {
      setSaving(false);
    }
  }

  async function hapus(b) {
    if (!window.confirm(
      `Barang ${b.product_name} tidak bisa diperbaiki?\n\n`
      + `${num(b.qty)} ${b.unit} senilai ${rupiah(b.nilai)} akan dicatat sebagai kerugian `
      + 'barang rusak. Stok tidak berubah, karena barang ini memang belum pernah masuk stok jual.'
    )) return;

    try {
      const res = await api.post(`/api/perbaikan/${b.id}/hapus`, { tanggal_hapus: today() });
      toast.success(res.message);
      load();
    } catch (err) {
      toast.error(err.message);
    }
  }

  if (loading && !data) return <Spinner label="Memuat barang perbaikan..." />;

  const r = data?.ringkas;
  const biaya = Number(selesai?.biaya_perbaikan) || 0;
  const nilaiBaru = selesai ? selesai.nilai + biaya : 0;

  return (
    <div>
      <PageHeader
        title="Barang Perlu Perbaikan"
        subtitle="Barang retur yang masih bisa dijual setelah dikemas ulang"
      >
        <TombolEkspor path="/api/perbaikan" params={{ ...range, status }} nama="barang-perbaikan" />
      </PageHeader>

      <div className="mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          label="Menunggu Dikerjakan" value={`${num(r?.menunggu || 0)} barang`}
          sub={`${num(r?.qtyMenunggu || 0)} unit`}
          icon={Wrench} tone={r?.menunggu ? 'amber' : 'slate'}
        />
        <StatCard
          label="Nilai yang Menunggu" value={rupiah(r?.nilaiMenunggu || 0)}
          sub="masih tercatat sebagai aset" icon={Clock}
        />
        <StatCard
          label="Menunggu Terlama" value={`${num(r?.terlamaHari || 0)} hari`}
          sub="kerjakan yang ini lebih dulu"
          tone={r?.terlamaHari > 30 ? 'red' : r?.terlamaHari > 14 ? 'amber' : 'slate'}
        />
        <StatCard
          label="Sudah Kembali ke Stok" value={`${num(r?.selesai || 0)} barang`}
          sub={`biaya perbaikan ${rupiah(r?.biayaPerbaikan || 0)} • ${num(r?.dihapus || 0)} tidak terselamatkan`}
          icon={PackageCheck} tone="green"
        />
      </div>

      <div className="card mb-4 flex items-start gap-2.5">
        <Info size={17} className="mt-0.5 shrink-0 text-brand-600" />
        <p className="text-xs leading-relaxed text-slate-600">
          Barang di sini <strong>belum masuk stok jual</strong>, tetapi nilainya tetap tercatat
          sebagai aset di neraca — jadi tidak hilang dari pembukuan selama menunggu dikerjakan.
          Saat ditandai selesai, biaya label dan kemasan barunya <strong>menempel ke HPP</strong>{' '}
          barang itu, bukan menjadi beban terpisah: barangnya memang jadi lebih mahal modalnya.
        </p>
      </div>

      <div className="mb-4">
        <DateRangeFilter range={range} onChange={setRange}>
          <div className="flex-1">
            <label className="label">Status</label>
            <select className="input" value={status} onChange={(e) => setStatus(e.target.value)}>
              <option value="">Semua status</option>
              <option value="MENUNGGU">Menunggu dikerjakan</option>
              <option value="SELESAI">Selesai, kembali ke stok</option>
              <option value="HAPUS">Tidak bisa diperbaiki</option>
            </select>
          </div>
        </DateRangeFilter>
        <p className="mt-2 text-xs text-slate-500">
          Rentang tanggal hanya menyaring yang <strong>sudah selesai</strong>. Yang masih menunggu
          selalu ditampilkan seluruhnya — barang yang lama tertahan tidak boleh hilang dari layar
          hanya karena rentang tanggalnya digeser.
        </p>
      </div>

      <div className="card">
        {!data?.rows?.length ? (
          <EmptyState
            title="Tidak ada barang perbaikan"
            subtitle="Retur yang ditandai “perlu dikemas ulang” akan muncul di sini."
          />
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Tanggal Masuk</th><th>No. Retur</th><th>Produk</th>
                  <th className="text-right">Jumlah</th><th className="text-right">Nilai</th>
                  <th className="text-center">Umur</th><th>Status</th><th>Catatan</th>
                  {bolehKerjakan && <th />}
                </tr>
              </thead>
              <tbody>
                {data.rows.map((b) => (
                  <tr key={b.id}>
                    <td className="tabular whitespace-nowrap">{dateID(b.tanggal_masuk)}</td>
                    <td className="font-mono text-xs">{b.return_no || '—'}</td>
                    <td>
                      <span className="block font-medium">{b.product_name}</span>
                      <span className="block text-[11px] text-slate-400">{b.sku}</span>
                    </td>
                    <td className="tabular text-right">{num(b.qty)} {b.unit}</td>
                    <td className="tabular text-right font-medium">
                      {rupiah(b.nilai)}
                      {b.biaya_perbaikan > 0 && (
                        <span className="block text-[11px] text-slate-400">
                          + {rupiah(b.biaya_perbaikan)} biaya
                        </span>
                      )}
                    </td>
                    <td className="tabular text-center">
                      {b.status === 'MENUNGGU' ? (
                        <span className={
                          b.umur_hari >= 30 ? 'badge-red' : b.umur_hari >= 14 ? 'badge-amber' : 'badge-slate'
                        }>
                          {num(b.umur_hari)} hari
                        </span>
                      ) : <span className="text-slate-400">—</span>}
                    </td>
                    <td>
                      <span className={WARNA_STATUS[b.status]}>{LABEL_STATUS[b.status]}</span>
                      {b.tanggal_selesai && (
                        <span className="block text-[11px] text-slate-400">{dateID(b.tanggal_selesai)}</span>
                      )}
                    </td>
                    <td className="max-w-[180px] truncate text-xs text-slate-500">
                      {b.catatan || b.reason || '—'}
                    </td>
                    {bolehKerjakan && (
                      <td className="text-right">
                        {b.status === 'MENUNGGU' && (
                          <div className="flex justify-end gap-1">
                            <button
                              type="button" className="btn-ghost !px-2 !py-1 text-xs text-emerald-700"
                              onClick={() => setSelesai({
                                id: b.id, nama: b.product_name, qty: b.qty, unit: b.unit,
                                nilai: b.nilai,
                                tanggal_selesai: today(), biaya_perbaikan: '', cash_code: '', catatan: '',
                              })}
                            >
                              <PackageCheck size={15} /> Selesai
                            </button>
                            <button
                              type="button" onClick={() => hapus(b)}
                              className="rounded-lg p-1.5 text-slate-400 hover:bg-rose-50 hover:text-rose-600"
                              aria-label={`Tandai ${b.product_name} tidak bisa diperbaiki`}
                            >
                              <Trash2 size={15} />
                            </button>
                          </div>
                        )}
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <Modal open={!!selesai} onClose={() => setSelesai(null)} title="Selesai Dikemas Ulang">
        {selesai && (
          <form onSubmit={simpanSelesai} className="grid gap-3 sm:grid-cols-2">
            <p className="sm:col-span-2 rounded-xl bg-slate-50 px-3 py-2 text-sm text-slate-700">
              <strong>{num(selesai.qty)} {selesai.unit} {selesai.nama}</strong> akan kembali ke stok
              jual, dengan nilai awal {rupiah(selesai.nilai)}.
            </p>

            <Field label="Tanggal Selesai *">
              <input
                type="date" className="input" required value={selesai.tanggal_selesai}
                onChange={(e) => setSelesai({ ...selesai, tanggal_selesai: e.target.value })}
              />
            </Field>

            <Field
              label="Biaya Label & Kemasan Baru (Rp)"
              hint="Kosongkan bila tidak ada biaya"
            >
              <input
                type="number" min="0" step="any" className="input" value={selesai.biaya_perbaikan}
                onChange={(e) => setSelesai({ ...selesai, biaya_perbaikan: e.target.value })}
              />
            </Field>

            {biaya > 0 && (
              <Field label="Dibayar dari *" className="sm:col-span-2">
                <select
                  className="input" required value={selesai.cash_code}
                  onChange={(e) => setSelesai({ ...selesai, cash_code: e.target.value })}
                >
                  <option value="">— pilih rekening —</option>
                  {rekening.map((k) => <option key={k.code} value={k.code}>{k.code} — {k.name}</option>)}
                </select>
              </Field>
            )}

            <Field label="Catatan" hint="mis. ganti label & foil 250 gram" className="sm:col-span-2">
              <input
                className="input" maxLength={300} value={selesai.catatan}
                onChange={(e) => setSelesai({ ...selesai, catatan: e.target.value })}
              />
            </Field>

            <p className="sm:col-span-2 rounded-xl bg-brand-50 px-3 py-2 text-sm text-brand-900">
              Masuk stok senilai <strong>{rupiah(nilaiBaru)}</strong> —{' '}
              <strong>{rupiah(nilaiBaru / (selesai.qty || 1))}</strong> per {selesai.unit}.
              {biaya > 0 && ' Biaya kemasannya ikut menempel ke HPP, supaya margin barang ini tidak tampak lebih besar daripada kenyataan.'}
            </p>

            <div className="flex gap-2 sm:col-span-2">
              <button type="button" className="btn-secondary flex-1" onClick={() => setSelesai(null)}>
                Batal
              </button>
              <button type="submit" className="btn-primary flex-1" disabled={saving}>
                {saving ? 'Menyimpan...' : 'Kembalikan ke Stok Jual'}
              </button>
            </div>
          </form>
        )}
      </Modal>
    </div>
  );
}
