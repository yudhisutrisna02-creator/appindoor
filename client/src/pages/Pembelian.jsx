import { useEffect, useState, useCallback } from 'react';
import { Plus, PackageCheck, Truck, XCircle, Trash2, Clock, Receipt, Printer, FileText, FileSpreadsheet, Pencil } from 'lucide-react';
import { api } from '../lib/api';
import {
  PageHeader, StatCard, Spinner, EmptyState, Modal,
  DateRangeFilter, defaultRange, useToast, Field, TombolEkspor, TombolCetak,
} from '../components/ui';
import { rupiah, num, dateID, today } from '../lib/format';
import { useAuth } from '../lib/auth';

const KOSONG = () => ({
  order_date: today(),
  expected_date: '',
  partner_id: '',
  payment: 'CREDIT',
  cash_code: '',
  invoice_no: '',
  due_date: '',
  note: '',
  items: [{ product_id: '', qty: 1, unit_cost: '' }],
});

const WARNA_STATUS = {
  DIPESAN: 'badge-amber',
  SEBAGIAN: 'badge-blue',
  SELESAI: 'badge-green',
  BATAL: 'badge-slate',
};

/**
 * Pesanan pembelian.
 *
 * Mutasi stok hanya tahu apa yang sudah datang. Layar ini menjawab yang tidak
 * terjawab olehnya: barang apa yang sudah dipesan tetapi belum tiba, sudah
 * berapa lama menunggu, dan berapa nilainya.
 */
/** Kode Kas Tunai pada bagan akun bawaan. */
const KODE_KAS_TUNAI = '1000';

export default function Pembelian() {
  const toast = useToast();
  const { punya } = useAuth();
  const bolehKelola = punya('pembelian.kelola');

  const [range, setRange] = useState(defaultRange);
  const [status, setStatus] = useState('');
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [suppliers, setSuppliers] = useState([]);
  const [products, setProducts] = useState([]);
  const [rekening, setRekening] = useState([]);
  const [kodeMp, setKodeMp] = useState(null);
  const [form, setForm] = useState(null);
  const [terima, setTerima] = useState(null);
  const [nota, setNota] = useState(null);
  const [saving, setSaving] = useState(false);
  const [hapus, setHapus] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setData(await api.get('/api/pembelian', { ...range, status }));
    } catch (err) {
      toast.error(err.message);
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [range, status]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    api.get('/api/partners', { kind: 'SUPPLIER' }).then((d) => setSuppliers(d.partners)).catch(() => {});
    api.get('/api/cashflow/options').then((d) => {
      setRekening(d.cashAccounts || []);
      setKodeMp(d.rekeningMp ? d.rekeningMp.code : null);
    }).catch(() => {});
    api.get('/api/inventory/products', { limit: 2000 }).then((d) => setProducts(d.products)).catch(() => {});
  }, []);

  function setItem(i, patch) {
    const items = [...form.items];
    items[i] = { ...items[i], ...patch };
    // Harga beli diisikan dari HPP produk agar tidak perlu diketik ulang untuk
    // barang yang harganya memang tetap.
    if (patch.product_id) {
      const p = products.find((x) => x.id === Number(patch.product_id));
      if (p && !items[i].unit_cost) items[i].unit_cost = p.cost;
    }
    setForm({ ...form, items });
  }

  async function simpan(e) {
    e.preventDefault();
    setSaving(true);
    try {
      const isi = {
        order_date: form.order_date,
        expected_date: form.expected_date || null,
        partner_id: Number(form.partner_id),
        payment: form.payment,
        cash_code: form.payment === 'CREDIT' ? null : form.cash_code || null,
        invoice_no: form.invoice_no || null,
        due_date: form.due_date || null,
        note: form.note || null,
        items: form.items
          .filter((i) => i.product_id && Number(i.qty) > 0)
          .map((i) => ({
            ...(i.id ? { id: i.id } : {}),
            product_id: Number(i.product_id),
            qty: Number(i.qty),
            unit_cost: Number(i.unit_cost) || 0,
          })),
      };
      if (!isi.items.length) throw new Error('Tambahkan minimal satu barang');
      if (!isi.partner_id) throw new Error('Pilih supplier terlebih dahulu');

      const res = form.id
        ? await api.put(`/api/pembelian/${form.id}`, isi)
        : await api.post('/api/pembelian', isi);
      toast.success(res.message);
      setForm(null);
      load();
    } catch (err) {
      toast.error(err.message);
    } finally {
      setSaving(false);
    }
  }

  /**
   * Membuka pesanan yang sudah ada di formulir yang sama dengan pesanan baru.
   *
   * `qty_received` ikut dibawa supaya layar bisa menunjukkan baris mana yang
   * barangnya sudah datang — dan karena itu tidak lagi bebas diubah. Penjagaan
   * sesungguhnya tetap ada di peladen; ini hanya supaya orangnya tahu sebelum
   * mengetik, bukan setelah ditolak.
   */
  async function bukaUbah(po) {
    try {
      const d = await api.get(`/api/pembelian/${po.id}`);
      setForm({
        id: d.po.id,
        po_no: d.po.po_no,
        status: d.po.status,
        order_date: d.po.order_date,
        expected_date: d.po.expected_date || '',
        partner_id: String(d.po.partner_id || ''),
        payment: d.po.payment,
        cash_code: d.po.cash_code || '',
        payment_awal: d.po.payment,
        cash_code_awal: d.po.cash_code || '',
        invoice_no: d.po.invoice_no || '',
        due_date: d.po.due_date || '',
        note: d.po.note || '',
        items: d.po.items.map((i) => ({
          id: i.id,
          product_id: String(i.product_id),
          qty: i.qty,
          unit_cost: i.unit_cost,
          qty_received: i.qty_received,
          // Harga sebelum diubah — dasar pratinjau selisih harga nota.
          harga_awal: i.unit_cost,
        })),
      });
    } catch (err) {
      toast.error(err.message);
    }
  }

  async function bukaTerima(po) {
    try {
      const d = await api.get(`/api/pembelian/${po.id}`);
      setTerima({
        ...d.po,
        receive_date: today(),
        // Bawaan: terima seluruh sisanya. Yang paling sering terjadi adalah
        // barang datang lengkap; mengetik ulang jumlahnya cuma menambah kerja.
        lines: d.po.items.map((i) => ({ item_id: i.id, qty: i.qty_sisa, maks: i.qty_sisa, nama: i.product_name, unit: i.unit })),
      });
    } catch (err) {
      toast.error(err.message);
    }
  }

  async function simpanTerima(e) {
    e.preventDefault();
    setSaving(true);
    try {
      const lines = terima.lines
        .filter((l) => Number(l.qty) > 0)
        .map((l) => ({ item_id: l.item_id, qty: Number(l.qty) }));
      if (!lines.length) throw new Error('Isi jumlah barang yang diterima');

      const res = await api.post(`/api/pembelian/${terima.id}/terima`, {
        receive_date: terima.receive_date,
        lines,
      });
      toast.success(res.message);
      setTerima(null);
      load();
    } catch (err) {
      toast.error(err.message);
    } finally {
      setSaving(false);
    }
  }

  function bukaNota(po) {
    setNota({
      id: po.id,
      po_no: po.po_no,
      supplier_name: po.supplier_name,
      total: po.total,
      status_label: po.status_label,
      order_date: po.order_date,
      invoice_no: po.invoice_no || '',
      due_date: po.due_date || '',
      paid_date: po.paid_date || '',
    });
  }

  async function simpanNota(e) {
    e.preventDefault();
    setSaving(true);
    try {
      const res = await api.patch(`/api/pembelian/${nota.id}/nota`, {
        invoice_no: nota.invoice_no || null,
        due_date: nota.due_date || null,
        paid_date: nota.paid_date || null,
      });
      toast.success(res.message);
      setNota({ ...nota, ...res.po, id: res.po.id });
      load();
    } catch (err) {
      toast.error(err.message);
    } finally {
      setSaving(false);
    }
  }

  async function unduhNota(bentuk) {
    try {
      await api.download(`/api/pembelian/${nota.id}/nota/${bentuk}`, {}, `nota.${bentuk}`);
    } catch (err) {
      toast.error(err.message);
    }
  }

  async function batal(po) {
    if (!window.confirm(`Batalkan pesanan ${po.po_no}?`)) return;
    try {
      const res = await api.patch(`/api/pembelian/${po.id}/batal`);
      toast.success(res.message);
      load();
    } catch (err) {
      toast.error(err.message);
    }
  }

  async function bukaHapus(po) {
    try {
      const p = await api.get(`/api/pembelian/${po.id}/hapus-pratinjau`);
      setHapus({ po, p, stok: p.dariBarangMasuk || !p.stokCukup ? 'BIARKAN' : 'BALIK', ketik: '' });
    } catch (err) {
      toast.error(err.message);
    }
  }

  async function jalankanHapus(e) {
    e.preventDefault();
    setSaving(true);
    try {
      const q = new URLSearchParams({ stok: hapus.stok, konfirmasi: hapus.ketik.trim() });
      const res = await api.del(`/api/pembelian/${hapus.po.id}?${q}`);
      toast.success(res.message);
      setHapus(null);
      load();
    } catch (err) {
      toast.error(err.message);
    } finally {
      setSaving(false);
    }
  }

  if (loading || !data) return <Spinner label="Menyiapkan pesanan pembelian..." />;

  const r = data.ringkas;
  const totalForm = form
    ? form.items.reduce((s, i) => s + (Number(i.qty) || 0) * (Number(i.unit_cost) || 0), 0)
    : 0;

  /**
   * Selisih harga nota dari perubahan yang sedang dilakukan: jumlah yang sudah
   * datang × (harga baru − harga sebelumnya). Rumusnya sama dengan peladen,
   * supaya angka di layar tidak berbeda dari yang dibukukan.
   */
  function selisihBaris(it) {
    const diterima = Number(it.qty_received) || 0;
    if (!diterima || it.harga_awal === undefined) return 0;
    const nilai = diterima * ((Number(it.unit_cost) || 0) - (Number(it.harga_awal) || 0));
    return Math.abs(nilai) < 0.01 ? 0 : Math.round(nilai * 100) / 100;
  }


  return (
    <div>
      <PageHeader title="Pesanan Pembelian" subtitle="Barang yang sudah dipesan ke supplier dan belum tiba">
        {bolehKelola && (
          <button className="btn-primary" onClick={() => setForm(KOSONG())}>
            <Plus size={16} /> Pesanan Baru
          </button>
        )}
        <TombolEkspor path="/api/pembelian" params={{ ...range, status }} nama="pesanan-pembelian" csv />
      </PageHeader>

      <DateRangeFilter range={range} onChange={setRange}>
        <div className="flex-1">
          <label className="label">Status</label>
          <select className="input" value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">Semua status</option>
            <option value="DIPESAN">Dipesan</option>
            <option value="SEBAGIAN">Diterima sebagian</option>
            <option value="SELESAI">Selesai</option>
            <option value="BATAL">Batal</option>
          </select>
        </div>
      </DateRangeFilter>

      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard label="Jumlah Pesanan" value={r.total} icon={PackageCheck} />
        <StatCard
          label="Masih Ditunggu" value={r.menunggu}
          sub="belum diterima seluruhnya"
          icon={Truck} tone={r.menunggu > 0 ? 'amber' : 'green'}
        />
        <StatCard
          label="Nilai yang Ditunggu" value={rupiah(r.nilaiMenunggu)}
          sub="barang dipesan, belum tiba"
          tone={r.nilaiMenunggu > 0 ? 'amber' : 'green'}
        />
        <StatCard
          label="Menunggu Terlama" value={r.terlamaHari ? `${r.terlamaHari} hari` : '—'}
          sub="tanyakan ini lebih dulu ke supplier"
          icon={Clock} tone={r.terlamaHari >= 14 ? 'red' : r.terlamaHari >= 7 ? 'amber' : 'brand'}
        />
      </div>

      <div className="card">
        {data.rows.length === 0 ? (
          <EmptyState
            message="Belum ada pesanan pembelian pada periode ini"
            hint="Catat pesanan agar barang yang sedang ditunggu terlihat sebelum stoknya habis"
          />
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>No. PO</th><th>Tanggal</th><th>Supplier</th><th>Status</th>
                  <th>Barang</th><th>Nilai</th><th>Diterima</th><th>Sisa</th><th>Umur</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {data.rows.map((po) => (
                  <tr key={po.id}>
                    <td className="font-mono text-xs">
                      {po.po_no}
                      {po.invoice_no && (
                        <p className="text-[11px] text-slate-500">faktur {po.invoice_no}</p>
                      )}
                    </td>
                    <td className="tabular">
                      {dateID(po.order_date)}
                      {po.expected_date && (
                        <p className="text-[11px] text-slate-500">tiba ± {dateID(po.expected_date)}</p>
                      )}
                    </td>
                    <td className="text-sm">{po.supplier_name || '-'}</td>
                    <td><span className={WARNA_STATUS[po.status] || 'badge-slate'}>{po.status_label}</span></td>
                    <td className="tabular text-sm">{po.jumlah_barang}</td>
                    <td className="tabular">{rupiah(po.total)}</td>
                    <td className="tabular text-slate-500">{rupiah(po.total_diterima)}</td>
                    <td className={`tabular font-semibold ${po.sisa > 0 ? 'text-amber-700' : 'text-slate-400'}`}>
                      {po.sisa > 0 ? rupiah(po.sisa) : '—'}
                    </td>
                    <td className="tabular">
                      {po.status === 'DIPESAN' || po.status === 'SEBAGIAN' ? (
                        <span className={po.umur_hari >= 14 ? 'badge-red' : po.umur_hari >= 7 ? 'badge-amber' : 'badge-slate'}>
                          {po.umur_hari} hari
                        </span>
                      ) : (
                        <span className="text-slate-400">—</span>
                      )}
                    </td>
                    <td>
                      <div className="flex gap-1">
                        <button
                          className="btn-ghost !px-2 !py-1 text-xs"
                          onClick={() => bukaNota(po)}
                        >
                          <Receipt size={15} /> Nota
                        </button>
                        {bolehKelola && po.status !== 'BATAL' && (
                          <button className="btn-ghost !px-2 !py-1 text-slate-600" onClick={() => bukaUbah(po)} aria-label={`Ubah pesanan ${po.po_no}`}>
                            <Pencil size={15} />
                          </button>
                        )}
                        {bolehKelola && (po.status === 'DIPESAN' || po.status === 'SEBAGIAN') && (
                          <button className="btn-ghost !px-2 !py-1 text-emerald-600" onClick={() => bukaTerima(po)} aria-label="Terima barang">
                            <PackageCheck size={15} />
                          </button>
                        )}
                        {bolehKelola && po.status === 'DIPESAN' && (
                          <button className="btn-ghost !px-2 !py-1 text-rose-600" onClick={() => batal(po)} aria-label="Batalkan">
                            <XCircle size={15} />
                          </button>
                        )}
                        {bolehKelola && (
                          <button className="btn-ghost !px-2 !py-1 text-slate-400 hover:text-rose-600" onClick={() => bukaHapus(po)} aria-label={`Hapus pesanan ${po.po_no}`} title="Hapus pesanan">
                            <Trash2 size={15} />
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* ---------- PESANAN BARU ---------- */}
      <Modal
        open={!!form} onClose={() => setForm(null)} wide
        title={form?.id ? `Ubah Pesanan — ${form.po_no}` : 'Pesanan Pembelian Baru'}
      >
        {form && (
          <form onSubmit={simpan} className="grid gap-3 sm:grid-cols-2">
            {form.id && form.items.some((i) => i.qty_received > 0) && (
              <p className="sm:col-span-2 rounded-xl bg-amber-50 px-3 py-2 text-xs leading-relaxed text-amber-900">
                Sebagian barang sudah diterima. Baris yang barangnya sudah datang{' '}
                <strong>tidak bisa diganti atau dihapus</strong>, dan jumlahnya tidak bisa diturunkan
                di bawah yang sudah masuk. <strong>Harganya tetap boleh diubah</strong> mengikuti nota
                supplier: <strong>HPP stok yang sudah masuk tidak berubah</strong> — selisihnya hanya
                menyesuaikan {form.payment === 'CREDIT' ? 'utang ke supplier' : 'pembayarannya'} dan
                dicatat di akun Selisih Harga Pembelian.
              </p>
            )}
            <Field label="Supplier *" className="sm:col-span-2">
              <select className="input" required value={form.partner_id} onChange={(e) => setForm({ ...form, partner_id: e.target.value })}>
                <option value="">— pilih supplier —</option>
                {suppliers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
            </Field>
            <Field label="Tanggal Pesan *">
              <input type="date" className="input" required value={form.order_date} onChange={(e) => setForm({ ...form, order_date: e.target.value })} />
            </Field>
            <Field label="Perkiraan Tiba" hint="Dipakai menghitung keterlambatan">
              <input type="date" className="input" value={form.expected_date} onChange={(e) => setForm({ ...form, expected_date: e.target.value })} />
            </Field>
            <Field label="No. Faktur Supplier" hint="Boleh dikosongkan dan diisi saat notanya datang">
              <input className="input" maxLength={60} value={form.invoice_no} onChange={(e) => setForm({ ...form, invoice_no: e.target.value })} />
            </Field>
            <Field label="Jatuh Tempo" hint="Untuk pembelian tempo">
              <input type="date" className="input" value={form.due_date} onChange={(e) => setForm({ ...form, due_date: e.target.value })} />
            </Field>
            <Field label="Cara Bayar *" hint="Menentukan akun lawan saat barang diterima">
              <select
                className="input" value={form.payment}
                onChange={(e) => {
                  const payment = e.target.value;
                  setForm({
                    ...form,
                    payment,
                    // Tunai hampir selalu dari Kas Tunai; transfer harus dipilih
                    // sendiri — menebak rekening bank sama dengan mengarang.
                    cash_code: payment === 'CASH' ? KODE_KAS_TUNAI : payment === 'BANK' ? '' : '',
                  });
                }}
              >
                <option value="CREDIT">Tempo (utang supplier)</option>
                <option value="BANK">Transfer bank</option>
                <option value="CASH">Tunai</option>
              </select>
            </Field>
            {form.payment !== 'CREDIT' && (
              <Field
                label={form.payment === 'BANK' ? 'Transfer dari rekening *' : 'Dibayar dari *'}
                hint="Rekening yang benar-benar dipakai membayar supplier"
              >
                <select
                  className="input" required value={form.cash_code}
                  onChange={(e) => setForm({ ...form, cash_code: e.target.value })}
                >
                  <option value="">— pilih rekening —</option>
                  {rekening
                    .filter((k) => k.code !== kodeMp)
                    .filter((k) => form.payment !== 'BANK' || k.code !== KODE_KAS_TUNAI)
                    .map((k) => <option key={k.code} value={k.code}>{k.code} — {k.name}</option>)}
                </select>
              </Field>
            )}
            {form.id && form.items.some((i) => i.qty_received > 0)
              && (form.payment !== form.payment_awal || (form.cash_code || '') !== (form.cash_code_awal || '')) && (
              <p className="sm:col-span-2 rounded-xl bg-brand-50 px-3 py-2 text-xs leading-relaxed text-brand-800">
                Cara bayar barang yang <strong>sudah datang</strong> ikut dipindah pembukuannya ke{' '}
                {form.payment === 'CREDIT' ? 'utang supplier' : 'rekening yang dipilih'} — nilai persediaan dan
                HPP tidak berubah. Bila utangnya sudah dilunasi lewat Utang &amp; Piutang, perubahan ini ditolak
                supaya pesanan yang sama tidak terbayar dua kali.
              </p>
            )}
            <Field label="Catatan">
              <input className="input" value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} />
            </Field>

            <div className="sm:col-span-2">
              <div className="mb-2 flex items-center justify-between">
                <label className="label !mb-0">Barang yang Dipesan *</label>
                <button
                  type="button" className="btn-ghost !py-1 text-xs"
                  onClick={() => setForm({ ...form, items: [...form.items, { product_id: '', qty: 1, unit_cost: '' }] })}
                >
                  <Plus size={14} /> Tambah baris
                </button>
              </div>

              <div className="space-y-2">
                {form.items.map((it, i) => {
                  const sudahDatang = Number(it.qty_received) > 0;
                  const lunasDatang = sudahDatang && Number(it.qty_received) >= Number(it.qty);
                  return (
                    <div key={it.id || `baru-${i}`}>
                      <div className="grid grid-cols-12 gap-2">
                        <select
                          className="input col-span-6" value={it.product_id}
                          disabled={sudahDatang}
                          onChange={(e) => setItem(i, { product_id: e.target.value })}
                        >
                          <option value="">— pilih barang —</option>
                          {products.map((p) => <option key={p.id} value={p.id}>{p.sku} — {p.name}</option>)}
                        </select>
                        <input
                          type="number" min={sudahDatang ? it.qty_received : 0} step="any"
                          className="input col-span-2" placeholder="Qty"
                          value={it.qty} onChange={(e) => setItem(i, { qty: e.target.value })}
                        />
                        <input
                          type="number" min="0" step="any" className="input col-span-3" placeholder="Harga beli"
                          value={it.unit_cost} onChange={(e) => setItem(i, { unit_cost: e.target.value })}
                        />
                        <button
                          type="button" className="btn-ghost col-span-1 !px-2 text-rose-600 disabled:opacity-30"
                          disabled={sudahDatang}
                          onClick={() => setForm({ ...form, items: form.items.filter((_, x) => x !== i) })}
                          aria-label="Hapus baris"
                        >
                          <Trash2 size={15} />
                        </button>
                      </div>
                      {sudahDatang && (
                        <p className="mt-1 text-[11px] text-amber-700">
                          {num(it.qty_received)} sudah diterima — barang terkunci, harga boleh diubah;
                          HPP stok yang sudah masuk tetap
                          {!lunasDatang && '. Sisanya diterima dengan harga baru ini'}
                          {selisihBaris(it) !== 0 && (
                            <strong className="ml-1">
                              · selisih nota {selisihBaris(it) > 0 ? '+' : '−'}{rupiah(Math.abs(selisihBaris(it)))}
                            </strong>
                          )}
                        </p>
                      )}
                    </div>
                  );
                })}
              </div>

              <div className="mt-3 flex items-center justify-between rounded-xl bg-slate-50 px-3 py-2.5">
                <span className="text-sm font-semibold text-slate-700">Total Pesanan</span>
                <span className="tabular text-base font-bold text-slate-900">{rupiah(totalForm)}</span>
              </div>
            </div>

            <div className="flex gap-2 sm:col-span-2">
              <button type="button" className="btn-secondary flex-1" onClick={() => setForm(null)}>Batal</button>
              <button type="submit" className="btn-primary flex-1" disabled={saving}>
                {saving ? 'Menyimpan...' : form.id ? 'Simpan Perubahan' : 'Simpan Pesanan'}
              </button>
            </div>
          </form>
        )}
      </Modal>

      {/* ---------- TERIMA BARANG ---------- */}
      <Modal open={!!nota} onClose={() => setNota(null)} title={`Nota Pembayaran — ${nota?.po_no || ''}`}>
        {nota && (
          <div className="grid gap-3">
            <div className="rounded-xl bg-slate-50 px-3 py-2 text-sm text-slate-700">
              <p className="font-semibold text-slate-900">{nota.supplier_name || 'Supplier belum dipilih'}</p>
              <p className="text-xs text-slate-500">
                {dateID(nota.order_date)} • {nota.status_label} • {rupiah(nota.total)}
              </p>
            </div>

            <form onSubmit={simpanNota} className="grid gap-3">
              <Field
                label="No. Faktur Supplier"
                hint="Nomor yang dikeluarkan supplier — itu yang mereka kenali saat ditanya"
              >
                <input
                  className="input" maxLength={60} value={nota.invoice_no}
                  disabled={!bolehKelola}
                  onChange={(e) => setNota({ ...nota, invoice_no: e.target.value })}
                />
              </Field>
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Jatuh Tempo">
                  <input
                    type="date" className="input" value={nota.due_date} disabled={!bolehKelola}
                    onChange={(e) => setNota({ ...nota, due_date: e.target.value })}
                  />
                </Field>
                <Field label="Tanggal Dibayar" hint="Kosongkan bila belum dibayar">
                  <input
                    type="date" className="input" value={nota.paid_date} disabled={!bolehKelola}
                    onChange={(e) => setNota({ ...nota, paid_date: e.target.value })}
                  />
                </Field>
              </div>
              {bolehKelola && (
                <button type="submit" className="btn-secondary" disabled={saving}>
                  {saving ? 'Menyimpan...' : 'Simpan Keterangan Nota'}
                </button>
              )}
            </form>

            <p className="rounded-xl bg-slate-50 px-3 py-2 text-xs leading-relaxed text-slate-600">
              Keterangan di atas tidak menyentuh pembukuan — jurnal pembelian sudah terbentuk saat
              barang diterima. Yang dicatat di sini hanya penanda supaya notanya bisa ditelusuri.
              Satu nomor faktur tidak boleh dipakai dua pesanan; itu biasanya berarti pembayaran ganda.
            </p>

            <div className="flex flex-wrap gap-2">
              <TombolCetak path={`/api/pembelian/${nota.id}/nota/pdf`} label="Cetak Nota" icon={Printer} />
              <button className="btn-secondary" onClick={() => unduhNota('pdf')} disabled={saving}>
                <FileText size={16} /> PDF
              </button>
              <button className="btn-secondary" onClick={() => unduhNota('csv')} disabled={saving}>
                <FileSpreadsheet size={16} /> CSV
              </button>
            </div>
          </div>
        )}
      </Modal>

      <Modal open={!!terima} onClose={() => setTerima(null)} title={`Terima Barang — ${terima?.po_no || ''}`} wide>
        {terima && (
          <form onSubmit={simpanTerima} className="grid gap-3">
            <div className="rounded-xl bg-slate-50 px-3 py-2 text-xs text-slate-600">
              {terima.supplier_name} • dipesan {dateID(terima.order_date)} •
              {' '}nilai {rupiah(terima.total)} • {terima.status_label}
            </div>

            <Field label="Tanggal Terima *">
              <input
                type="date" className="input" required value={terima.receive_date}
                onChange={(e) => setTerima({ ...terima, receive_date: e.target.value })}
              />
            </Field>

            <div>
              <label className="label">Jumlah yang Diterima</label>
              <div className="space-y-2">
                {terima.lines.map((l, i) => (
                  <div key={l.item_id} className="grid grid-cols-12 items-center gap-2">
                    <span className="col-span-7 text-sm text-slate-700">
                      {l.nama}
                      <span className="ml-2 text-xs text-slate-500">sisa {l.maks} {l.unit}</span>
                    </span>
                    <input
                      type="number" min="0" max={l.maks} step="any" className="input col-span-4"
                      value={l.qty}
                      onChange={(e) => {
                        const lines = [...terima.lines];
                        lines[i] = { ...lines[i], qty: e.target.value };
                        setTerima({ ...terima, lines });
                      }}
                    />
                    <span className="col-span-1 text-xs text-slate-500">{l.unit}</span>
                  </div>
                ))}
              </div>
              <p className="mt-2 text-[11px] text-slate-500">
                Isi lebih kecil dari sisa bila barang datang bertahap. Menerima barang menambah stok,
                memperbarui HPP rata-rata, dan membentuk jurnalnya.
              </p>
            </div>

            <div className="flex gap-2">
              <button type="button" className="btn-secondary flex-1" onClick={() => setTerima(null)}>Batal</button>
              <button type="submit" className="btn-primary flex-1" disabled={saving}>
                {saving ? 'Memproses...' : 'Terima Barang'}
              </button>
            </div>
          </form>
        )}
      </Modal>

      {/* ---------- HAPUS PESANAN ---------- */}
      <Modal open={!!hapus} onClose={() => setHapus(null)} title={`Hapus Pesanan — ${hapus?.po.po_no || ''}`} wide>
        {hapus && (
          <form onSubmit={jalankanHapus} className="grid gap-3">
            <p className="text-sm text-slate-600">
              <strong>{hapus.po.supplier_name}</strong> · {rupiah(hapus.po.total)}
              {hapus.p.grn.length > 0 && <> · GRN {hapus.p.grn.join(', ')} ikut terhapus</>}
            </p>

            {hapus.p.returBeli.length > 0 && (
              <p className="rounded-xl bg-rose-50 px-3 py-2 text-sm text-rose-800">
                Pesanan ini punya retur pembelian ({hapus.p.returBeli.join(', ')}). Hapus returnya dulu.
              </p>
            )}

            {hapus.p.barang.length > 0 ? (
              <>
                <div className="table-wrap">
                  <table className="table text-sm">
                    <thead><tr><th>Barang yang sudah diterima</th><th className="text-right">Masuk dari PO ini</th><th className="text-right">Stok sekarang</th></tr></thead>
                    <tbody>
                      {hapus.p.barang.map((b) => (
                        <tr key={b.product_id}>
                          <td>{b.product_name}</td>
                          <td className="tabular text-right">{num(b.qty)} {b.unit}</td>
                          <td className={`tabular text-right ${b.cukup ? '' : 'font-semibold text-rose-600'}`}>{num(b.stok)} {b.unit}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                <div className="grid gap-2">
                  <label className={`flex cursor-pointer gap-3 rounded-xl border p-3 text-sm ${hapus.stok === 'BALIK' ? 'border-brand-500 bg-brand-50' : 'border-slate-200'} ${!hapus.p.stokCukup ? 'opacity-50' : ''}`}>
                    <input type="radio" name="stok" checked={hapus.stok === 'BALIK'} disabled={!hapus.p.stokCukup}
                      onChange={() => setHapus({ ...hapus, stok: 'BALIK' })} />
                    <span>
                      <strong>Hapus & batalkan penerimaan barang</strong>
                      <span className="block text-xs text-slate-500">
                        Stok dikurangi lagi, HPP & jurnal persediaan/utang dibalik. Pilih ini bila pesanan akan dibuat ulang lalu diterima lagi.
                        {!hapus.p.stokCukup && ' (Tidak bisa: sebagian barang sudah terjual.)'}
                      </span>
                    </span>
                  </label>
                  <label className={`flex cursor-pointer gap-3 rounded-xl border p-3 text-sm ${hapus.stok === 'BIARKAN' ? 'border-brand-500 bg-brand-50' : 'border-slate-200'}`}>
                    <input type="radio" name="stok" checked={hapus.stok === 'BIARKAN'}
                      onChange={() => setHapus({ ...hapus, stok: 'BIARKAN' })} />
                    <span>
                      <strong>Hapus pesanannya saja, stok tetap</strong>
                      <span className="block text-xs text-slate-500">
                        Barang masuk, stok, dan jurnalnya tidak berubah — hanya dilepas dari nomor PO ini, lalu bisa dijadikan pesanan lagi
                        lewat Mutasi Stok → "Jadikan pesanan".{hapus.p.dariBarangMasuk && ' Pesanan ini memang dibuat dari barang masuk.'}
                      </span>
                    </span>
                  </label>
                </div>

                {hapus.stok === 'BALIK' && Math.abs(hapus.p.utang.berkurang) > 0.5 && (
                  <p className={`rounded-xl px-3 py-2 text-xs ${hapus.p.utang.sesudah < -0.5 ? 'bg-amber-50 text-amber-800' : 'bg-slate-50 text-slate-600'}`}>
                    Utang ke {hapus.po.supplier_name}: {rupiah(hapus.p.utang.sekarang)} → {rupiah(hapus.p.utang.sesudah)}.
                    {hapus.p.utang.sesudah < -0.5 && ' Supplier akan tampak lebih bayar sampai pesanannya dicatat ulang.'}
                  </p>
                )}
              </>
            ) : (
              <p className="text-sm text-slate-600">Belum ada barang yang diterima — hanya dokumen pesanannya yang dihapus.</p>
            )}

            <Field label={`Ketik ${hapus.po.po_no} untuk konfirmasi`}>
              <input className="input font-mono" value={hapus.ketik} onChange={(e) => setHapus({ ...hapus, ketik: e.target.value })} placeholder={hapus.po.po_no} />
            </Field>
            <p className="text-xs text-slate-500">Cadangan database dibuat otomatis sebelum penghapusan.</p>
            <div className="flex gap-2">
              <button type="button" className="btn-secondary flex-1" onClick={() => setHapus(null)}>Batal</button>
              <button type="submit" className="btn-danger flex-1"
                disabled={saving || hapus.ketik.trim() !== hapus.po.po_no || hapus.p.returBeli.length > 0}>
                <Trash2 size={16} /> {saving ? 'Menghapus...' : 'Hapus Pesanan'}
              </button>
            </div>
          </form>
        )}
      </Modal>
    </div>
  );
}
