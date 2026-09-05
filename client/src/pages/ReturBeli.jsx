import { useEffect, useState, useCallback } from 'react';
import { Undo2, Trash2, Info } from 'lucide-react';
import { api } from '../lib/api';
import { PageHeader, Spinner, EmptyState, StatCard, useToast, Field, Modal, TombolEkspor } from '../components/ui';
import { rupiah, num, dateID, today, firstOfMonth } from '../lib/format';
import { useAuth } from '../lib/auth';

const KOSONG = {
  return_date: today(),
  partner_id: '',
  product_id: '',
  qty: '',
  unit_cost: '',
  mode: 'UTANG',
  cash_code: '',
  reason: '',
};

/**
 * Retur pembelian — barang yang dikembalikan ke supplier.
 *
 * Perlakuannya dipilih orangnya, bukan ditebak dari status pembayaran PO:
 * satu pesanan bisa dibayar sebagian, dan supplier sering memilih memotong
 * tagihan berikutnya alih-alih mengirim uang kembali. Yang tahu kesepakatannya
 * hanya orang yang menghubungi suppliernya.
 */
export default function ReturBeli() {
  const toast = useToast();
  const { punya } = useAuth();
  const bolehKelola = punya('pembelian.kelola');

  const [range, setRange] = useState({ from: firstOfMonth(), to: today() });
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [form, setForm] = useState(null);
  const [kirim, setKirim] = useState(false);

  const [produk, setProduk] = useState([]);
  const [supplier, setSupplier] = useState([]);
  const [rekening, setRekening] = useState([]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setData(await api.get(`/api/retur-beli?from=${range.from}&to=${range.to}`));
    } catch (err) {
      toast.error(err.message);
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [range.from, range.to]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    api.get('/api/inventory/products').then((d) => setProduk(d.products)).catch(() => {});
    api.get('/api/partners?type=SUPPLIER').then((d) => setSupplier(d.rows || d.partners || [])).catch(() => {});
    api.get('/api/cashflow/options').then((d) => setRekening(d.cashAccounts || [])).catch(() => {});
  }, []);

  const dipilih = produk.find((p) => p.id === Number(form?.product_id));
  const nilai = (Number(form?.qty) || 0)
    * (form?.unit_cost !== '' ? Number(form?.unit_cost) || 0 : (dipilih?.cost || 0));

  async function simpan(e) {
    e.preventDefault();
    setKirim(true);
    try {
      const res = await api.post('/api/retur-beli', {
        return_date: form.return_date,
        partner_id: Number(form.partner_id),
        product_id: Number(form.product_id),
        qty: Number(form.qty),
        unit_cost: form.unit_cost === '' ? null : Number(form.unit_cost),
        mode: form.mode,
        cash_code: form.mode === 'REFUND' ? form.cash_code : null,
        reason: form.reason || null,
      });
      toast.success(res.message);
      setForm(null);
      load();
      api.get('/api/inventory/products').then((d) => setProduk(d.products)).catch(() => {});
    } catch (err) {
      toast.error(err.message);
    } finally {
      setKirim(false);
    }
  }

  async function batalkan(r) {
    if (!window.confirm(
      `Batalkan retur ${r.return_no}?\n\n`
      + `${num(r.qty)} ${r.unit} ${r.product_name} kembali ke gudang, dan `
      + `${r.mode === 'REFUND' ? 'pengembalian dananya dibatalkan' : 'utang ke supplier kembali seperti semula'}.`
    )) return;

    try {
      const res = await api.del(`/api/retur-beli/${r.id}`);
      toast.success(res.message);
      load();
    } catch (err) {
      toast.error(err.message);
    }
  }

  if (loading && !data) return <Spinner label="Memuat retur pembelian..." />;

  const r = data?.ringkas;

  return (
    <div>
      <PageHeader
        title="Retur Pembelian"
        subtitle="Barang yang dikembalikan ke supplier — stok berkurang, utang atau kas ikut menyesuaikan"
      >
        <TombolEkspor path={`/api/retur-beli?from=${range.from}&to=${range.to}`} nama="retur-pembelian" />
        {bolehKelola && (
          <button className="btn-primary" onClick={() => setForm({ ...KOSONG })}>
            <Undo2 size={16} /> Retur Baru
          </button>
        )}
      </PageHeader>

      <div className="mb-4 flex flex-wrap items-end gap-3">
        <Field label="Dari Tanggal" className="w-44">
          <input type="date" className="input" value={range.from}
            onChange={(e) => setRange({ ...range, from: e.target.value })} />
        </Field>
        <Field label="Sampai Tanggal" className="w-44">
          <input type="date" className="input" value={range.to}
            onChange={(e) => setRange({ ...range, to: e.target.value })} />
        </Field>
      </div>

      <div className="mb-4 grid gap-3 sm:grid-cols-3">
        <StatCard label="Nilai Retur" value={rupiah(r?.nilai || 0)}
          sub={`${r?.jumlah || 0} kali retur`} icon={Undo2} />
        <StatCard label="Mengurangi Utang" value={rupiah(r?.kurangUtang || 0)}
          sub="barang belum dibayar" tone="amber" />
        <StatCard label="Dana Dikembalikan" value={rupiah(r?.danaKembali || 0)}
          sub="supplier mengembalikan uangnya" tone="green" />
      </div>

      <div className="card mb-4 flex items-start gap-2.5">
        <Info size={17} className="mt-0.5 shrink-0 text-brand-600" />
        <p className="text-xs leading-relaxed text-slate-600">
          Mencatat retur di sini <strong>sekaligus mengurangi stok dan menyesuaikan pembukuan</strong>.
          Sebelumnya barang rusak dari supplier hanya bisa dicatat lewat koreksi stok — stoknya
          berkurang tetapi utangnya tidak, sehingga aplikasi tetap menagih pembayaran untuk barang
          yang sudah dikembalikan.
        </p>
      </div>

      <div className="card">
        {!data?.rows?.length ? (
          <EmptyState
            title="Belum ada retur pembelian"
            subtitle="Retur yang dicatat pada rentang tanggal ini akan tampil di sini."
          />
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>No. Retur</th><th>Tanggal</th><th>Supplier</th><th>Produk</th>
                  <th className="text-right">Jumlah</th><th className="text-right">Nilai</th>
                  <th>Perlakuan</th><th>Alasan</th>{bolehKelola && <th />}
                </tr>
              </thead>
              <tbody>
                {data.rows.map((x) => (
                  <tr key={x.id}>
                    <td className="tabular whitespace-nowrap font-medium">{x.return_no}</td>
                    <td className="tabular whitespace-nowrap">{dateID(x.return_date)}</td>
                    <td>{x.partner_name || '—'}</td>
                    <td>
                      <span className="block">{x.product_name}</span>
                      <span className="block text-[11px] text-slate-400">{x.sku}</span>
                    </td>
                    <td className="tabular text-right">{num(x.qty)} {x.unit}</td>
                    <td className="tabular text-right font-medium">{rupiah(x.amount)}</td>
                    <td>
                      <span className={x.mode === 'REFUND' ? 'badge-green' : 'badge-amber'}>
                        {x.mode === 'REFUND' ? 'Dana kembali' : 'Potong utang'}
                      </span>
                    </td>
                    <td className="text-xs text-slate-500">{x.reason || '—'}</td>
                    {bolehKelola && (
                      <td className="text-right">
                        <button type="button" onClick={() => batalkan(x)}
                          className="rounded-lg p-1.5 text-slate-400 hover:bg-rose-50 hover:text-rose-600"
                          aria-label={`Batalkan ${x.return_no}`}>
                          <Trash2 size={15} />
                        </button>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <Modal open={!!form} onClose={() => setForm(null)} title="Retur Pembelian Baru" wide>
        {form && (
          <form onSubmit={simpan} className="grid gap-3 sm:grid-cols-2">
            <Field label="Tanggal *">
              <input type="date" className="input" required value={form.return_date}
                onChange={(e) => setForm({ ...form, return_date: e.target.value })} />
            </Field>

            <Field label="Supplier *">
              <select className="input" required value={form.partner_id}
                onChange={(e) => setForm({ ...form, partner_id: e.target.value })}>
                <option value="">— pilih supplier —</option>
                {supplier.map((sp) => <option key={sp.id} value={sp.id}>{sp.name}</option>)}
              </select>
            </Field>

            <Field label="Produk *" className="sm:col-span-2">
              <select className="input" required value={form.product_id}
                onChange={(e) => setForm({ ...form, product_id: e.target.value })}>
                <option value="">— pilih produk —</option>
                {produk.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.sku} — {p.name} (stok {num(p.stock)} {p.unit})
                  </option>
                ))}
              </select>
            </Field>

            <Field label={`Jumlah *${dipilih ? ` (${dipilih.unit})` : ''}`}
              hint={dipilih ? `Stok tersedia ${num(dipilih.stock)}` : 'Pilih produknya dulu'}>
              <input type="number" min="0" step="any" className="input" required value={form.qty}
                onChange={(e) => setForm({ ...form, qty: e.target.value })} />
            </Field>

            <Field label="Harga Beli / Unit (Rp)"
              hint={dipilih ? `Kosongkan untuk memakai HPP ${rupiah(dipilih.cost)}` : 'Kosongkan untuk memakai HPP'}>
              <input type="number" min="0" step="any" className="input" value={form.unit_cost}
                onChange={(e) => setForm({ ...form, unit_cost: e.target.value })} />
            </Field>

            <Field
              label="Perlakuan *"
              hint="Dipilih Anda — satu PO bisa dibayar sebagian, dan sistem tidak tahu kesepakatannya"
              className="sm:col-span-2"
            >
              <select className="input" required value={form.mode}
                onChange={(e) => setForm({ ...form, mode: e.target.value })}>
                <option value="UTANG">Potong utang — barang belum dibayar</option>
                <option value="REFUND">Dana dikembalikan — barang sudah dibayar</option>
              </select>
            </Field>

            {form.mode === 'REFUND' && (
              <Field label="Dana Masuk ke *" className="sm:col-span-2">
                <select className="input" required value={form.cash_code}
                  onChange={(e) => setForm({ ...form, cash_code: e.target.value })}>
                  <option value="">— pilih rekening —</option>
                  {rekening.map((k) => <option key={k.code} value={k.code}>{k.code} — {k.name}</option>)}
                </select>
              </Field>
            )}

            <Field label="Alasan" hint="mis. kemasan rusak, salah kirim" className="sm:col-span-2">
              <input className="input" maxLength={300} value={form.reason}
                onChange={(e) => setForm({ ...form, reason: e.target.value })} />
            </Field>

            {nilai > 0 && (
              <p className="sm:col-span-2 rounded-xl bg-brand-50 px-3 py-2 text-sm text-brand-900">
                Nilai retur <strong>{rupiah(nilai)}</strong> —{' '}
                {form.mode === 'REFUND' ? 'masuk ke rekening yang dipilih' : 'mengurangi utang supplier'},
                dan stok berkurang {num(form.qty)} {dipilih?.unit || ''}.
              </p>
            )}

            <div className="flex gap-2 sm:col-span-2">
              <button type="button" className="btn-secondary flex-1" onClick={() => setForm(null)}>Batal</button>
              <button type="submit" className="btn-primary flex-1" disabled={kirim}>
                {kirim ? 'Menyimpan...' : 'Simpan Retur'}
              </button>
            </div>
          </form>
        )}
      </Modal>
    </div>
  );
}
