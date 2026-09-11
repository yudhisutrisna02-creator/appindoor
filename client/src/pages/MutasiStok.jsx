import { useEffect, useState, useCallback } from 'react';
import { ArrowDownToLine, ArrowUpFromLine, Plus, Package, Pencil, ShoppingCart } from 'lucide-react';
import { api } from '../lib/api';
import { PageHeader, StatCard, Spinner, EmptyState, Modal, DateRangeFilter, defaultRange, useToast, Field, TombolEkspor } from '../components/ui';
import { rupiah, num, today } from '../lib/format';
import { useAuth } from '../lib/auth';

const TYPE_BADGE = { IN: 'badge-green', OUT: 'badge-red', ADJ: 'badge-amber' };
const TYPE_LABEL = { IN: 'Masuk', OUT: 'Keluar', ADJ: 'Koreksi' };

/** Kode Kas Tunai pada bagan akun bawaan. */
const KODE_KAS_TUNAI = '1000';

export default function MutasiStok() {
  const toast = useToast();
  const [range, setRange] = useState(defaultRange);
  const [moveType, setMoveType] = useState('');
  const [data, setData] = useState(null);
  const [products, setProducts] = useState([]);
  const [suppliers, setSuppliers] = useState([]);
  const [rekening, setRekening] = useState([]);
  const [loading, setLoading] = useState(true);
  const [form, setForm] = useState(null);
  const [harga, setHarga] = useState(null);
  const [menyimpanHarga, setMenyimpanHarga] = useState(false);
  const { punya } = useAuth();
  const bolehUbahHarga = punya('gudang.produk');
  const bolehJadiPO = punya('pembelian.kelola');
  const [jadiPO, setJadiPO] = useState(null);
  const [menyimpanPO, setMenyimpanPO] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setData(await api.get('/api/inventory/moves', { ...range, move_type: moveType }));
    } catch (err) {
      toast.error(err.message);
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [range, moveType]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    api.get('/api/inventory/products').then((d) => setProducts(d.products)).catch(() => {});
    api.get('/api/partners', { kind: 'SUPPLIER' }).then((d) => setSuppliers(d.partners)).catch(() => {});
    api.get('/api/cashflow/options').then((d) => setRekening(d.cashAccounts || [])).catch(() => {});
  }, []);

  // Nilai baru = qty × harga per unit + biaya tambahan (ongkir dll).
  const nilaiHargaBaru = harga ? harga.qty * (Number(harga.unit_cost) || 0) + (Number(harga.biaya_tambahan) || 0) : 0;

  async function simpanHarga(e) {
    e.preventDefault();
    setMenyimpanHarga(true);
    try {
      const res = await api.put(`/api/inventory/moves/${harga.id}/harga`, {
        unit_cost: Number(harga.unit_cost),
        biaya_tambahan: Number(harga.biaya_tambahan) || 0,
        alasan: harga.alasan,
      });
      toast.success(res.message);
      setHarga(null);
      load();
      api.get('/api/inventory/products').then((d) => setProducts(d.products)).catch(() => {});
    } catch (err) {
      toast.error(err.message);
    } finally {
      setMenyimpanHarga(false);
    }
  }

  const nilaiPOBaru = jadiPO ? jadiPO.qty * (Number(jadiPO.unit_cost) || 0) + (Number(jadiPO.biaya_tambahan) || 0) : 0;

  async function simpanPO(e) {
    e.preventDefault();
    setMenyimpanPO(true);
    try {
      const res = await api.post('/api/pembelian/dari-barang-masuk', {
        move_id: jadiPO.id,
        order_date: jadiPO.order_date || null,
        unit_cost: Number(jadiPO.unit_cost),
        biaya_tambahan: Number(jadiPO.biaya_tambahan) || 0,
        invoice_no: jadiPO.invoice_no || null,
        note: jadiPO.catatan || null,
      });
      toast.success(res.message);
      setJadiPO(null);
      load();
      api.get('/api/inventory/products').then((d) => setProducts(d.products)).catch(() => {});
    } catch (err) {
      toast.error(err.message);
    } finally {
      setMenyimpanPO(false);
    }
  }

  function openForm(type) {
    setForm({
      move_type: type,
      product_id: '',
      move_date: today(),
      qty: '',
      unit_cost: '',
      batch_kode: '',
      batch_kadaluarsa: '',
      // Sengaja KOSONG. Dulu terisi Kas Tunai, sehingga setiap pembelian yang
      // sebenarnya dibayar transfer tercatat mengurangi uang tunai di laci —
      // itulah asal saldo Kas Tunai yang minus. Sekarang harus dipilih sendiri.
      cara: '',
      cash_code: '',
      partner_id: '',
      ref: '',
      note: '',
    });
  }

  const selected = products.find((p) => p.id === Number(form?.product_id));

  /**
   * Cara bayar pembelian stok, diterjemahkan ke bentuk yang dipahami peladen.
   *
   * "Dibayar dari rekening" selalu membawa rekening yang dipilih — Kas Tunai
   * hanyalah salah satu rekening di daftar, bukan pilihan bawaan.
   */
  function sumberDana() {
    if (form.cara === 'REKENING') {
      return { payment: form.cash_code === KODE_KAS_TUNAI ? 'CASH' : 'BANK', cash_code: form.cash_code };
    }
    return { payment: form.cara };
  }

  async function submit(e) {
    e.preventDefault();
    try {
      const payload = {
        product_id: Number(form.product_id),
        move_date: form.move_date,
        move_type: form.move_type,
        qty: Number(form.qty),
        ...(form.move_type === 'IN' ? sumberDana() : {}),
        partner_id: form.partner_id ? Number(form.partner_id) : null,
        ref: form.ref || null,
        note: form.note || null,
      };
      if (form.move_type === 'IN' && form.unit_cost !== '') payload.unit_cost = Number(form.unit_cost);
      // Hanya dikirim untuk produk yang memang dilacak per batch; peladen
      // mengabaikannya untuk produk lain.
      if (form.move_type === 'IN' && selected?.lacak_batch) {
        payload.batch_kode = form.batch_kode || null;
        payload.batch_kadaluarsa = form.batch_kadaluarsa || null;
      }

      await api.post('/api/inventory/moves', payload);
      toast.success(`Mutasi stok ${TYPE_LABEL[form.move_type].toLowerCase()} tersimpan & jurnal terbentuk`);
      setForm(null);
      load();
      api.get('/api/inventory/products').then((d) => setProducts(d.products));
    } catch (err) {
      toast.error(err.message);
    }
  }

  return (
    <div>
      <PageHeader title="Mutasi Stok" subtitle="Log stok masuk & keluar — otomatis membentuk jurnal persediaan">
        <button className="btn-primary" onClick={() => openForm('IN')}>
          <ArrowDownToLine size={16} /> Stok Masuk
        </button>
        <button className="btn-secondary" onClick={() => openForm('OUT')}>
          <ArrowUpFromLine size={16} /> Stok Keluar
        </button>
        <TombolEkspor path="/api/inventory/moves" params={range} nama="mutasi-stok" />
      </PageHeader>

      <DateRangeFilter range={range} onChange={setRange}>
        <div className="flex-1">
          <label className="label">Jenis Mutasi</label>
          <select className="input" value={moveType} onChange={(e) => setMoveType(e.target.value)}>
            <option value="">Semua</option>
            <option value="IN">Masuk</option>
            <option value="OUT">Keluar</option>
            <option value="ADJ">Koreksi Opname</option>
          </select>
        </div>
      </DateRangeFilter>

      {loading ? (
        <Spinner />
      ) : (
        <>
          <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
            <StatCard label="Qty Masuk" value={num(data.summary.inQty)} icon={ArrowDownToLine} tone="green" />
            <StatCard label="Nilai Masuk" value={rupiah(data.summary.inValue)} icon={ArrowDownToLine} tone="green" />
            <StatCard label="Qty Keluar" value={num(data.summary.outQty)} icon={ArrowUpFromLine} tone="red" />
            <StatCard label="Nilai Keluar" value={rupiah(data.summary.outValue)} icon={ArrowUpFromLine} tone="red" />
          </div>

          <div className="card">
            {data.rows.length === 0 ? (
              <EmptyState message="Belum ada mutasi pada rentang ini" />
            ) : (
              <div className="table-wrap">
                <table className="table">
                  <thead>
                    <tr>
                      <th>Tanggal</th><th>Jenis</th><th>Produk</th><th>Qty</th>
                      <th>HPP/Unit</th><th>Nilai</th><th>Saldo Akhir</th><th>Ref</th><th>Sumber</th><th>Petugas</th>{(bolehUbahHarga || bolehJadiPO) && <th />}
                    </tr>
                  </thead>
                  <tbody>
                    {data.rows.map((m) => (
                      <tr key={m.id}>
                        <td className="tabular">{m.move_date}</td>
                        <td><span className={TYPE_BADGE[m.move_type]}>{TYPE_LABEL[m.move_type]}</span></td>
                        <td>
                          <p className="font-medium text-slate-900">{m.product_name}</p>
                          <p className="text-xs text-slate-400">{m.sku}</p>
                        </td>
                        <td className={`tabular font-semibold ${m.move_type === 'OUT' ? 'text-rose-600' : 'text-emerald-600'}`}>
                          {m.move_type === 'OUT' ? '−' : '+'}{num(m.qty)} {m.unit}
                        </td>
                        <td className="tabular">{rupiah(m.unit_cost)}</td>
                        <td className="tabular">{rupiah(m.value)}</td>
                        <td className="tabular">{num(m.balance_after)}</td>
                        <td className="text-xs">{m.ref || '-'}</td>
                        <td className="text-xs text-slate-500">{m.source}</td>
                        <td className="text-xs text-slate-500">{m.user_name || '-'}</td>
                        {(bolehUbahHarga || bolehJadiPO) && (
                          <td className="whitespace-nowrap">
                            {bolehJadiPO && m.move_type === 'IN' && m.source === 'MANUAL' && m.partner_id
                              && !String(m.ref || '').startsWith('PO/') && (
                              <button
                                type="button" className="btn-ghost !px-2 !py-1 text-xs"
                                title="Catat barang masuk ini sebagai pesanan pembelian ke supplier-nya"
                                onClick={() => setJadiPO({
                                  ...m, order_date: m.move_date, biaya_tambahan: '', invoice_no: '', catatan: '',
                                })}
                              >
                                <ShoppingCart size={13} /> Jadikan PO
                              </button>
                            )}
                            {bolehUbahHarga && m.move_type === 'IN' && m.source === 'MANUAL' && (
                              <button
                                type="button" className="btn-ghost !px-2 !py-1 text-xs"
                                title="Betulkan harga barang masuk ini"
                                onClick={() => setHarga({ ...m, biaya_tambahan: '', alasan: '' })}
                              >
                                <Pencil size={13} /> Harga
                              </button>
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
        </>
      )}

      <Modal open={!!form} onClose={() => setForm(null)} title={form?.move_type === 'IN' ? 'Catat Stok Masuk' : 'Catat Stok Keluar'}>
        {form && (
          <form onSubmit={submit} className="grid gap-3 sm:grid-cols-2">
            <Field label="Tanggal *">
              <input type="date" className="input" required value={form.move_date} onChange={(e) => setForm({ ...form, move_date: e.target.value })} />
            </Field>
            <Field label="No. Referensi" hint="mis. nomor nota supplier">
              <input className="input" value={form.ref} onChange={(e) => setForm({ ...form, ref: e.target.value })} />
            </Field>

            <Field label="Produk *" className="sm:col-span-2">
              <select className="input" required value={form.product_id} onChange={(e) => setForm({ ...form, product_id: e.target.value })}>
                <option value="">— pilih produk —</option>
                {products.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.sku} — {p.name} (stok {num(p.stock)} {p.unit})
                  </option>
                ))}
              </select>
            </Field>

            <Field label={`Jumlah *${selected ? ` (${selected.unit})` : ''}`}>
              <input type="number" min="0" step="any" className="input" required value={form.qty} onChange={(e) => setForm({ ...form, qty: e.target.value })} />
            </Field>

            {form.move_type === 'IN' ? (
              <Field label="Harga Beli / Unit (Rp)" hint={selected ? `HPP saat ini ${rupiah(selected.cost)} — kosongkan untuk memakai HPP lama` : 'Menentukan HPP rata-rata baru'}>
                <input type="number" min="0" step="any" className="input" value={form.unit_cost} onChange={(e) => setForm({ ...form, unit_cost: e.target.value })} />
              </Field>
            ) : (
              <Field label="HPP Terpakai">
                <input className="input bg-slate-50" readOnly value={selected ? rupiah(selected.cost) : '-'} />
              </Field>
            )}

            {form.move_type === 'IN' && selected?.lacak_batch && (
              <>
                <Field
                  label="Kode Batch *"
                  hint="Wajib untuk produk berbatch — tanpa ini barangnya tidak bisa ditelusuri saat ada keluhan"
                >
                  <input
                    className="input" required maxLength={60} placeholder="mis. B-2609-01"
                    value={form.batch_kode}
                    onChange={(e) => setForm({ ...form, batch_kode: e.target.value })}
                  />
                </Field>
                <Field label="Tanggal Kadaluarsa" hint="Boleh dilengkapi menyusul di Master Produk">
                  <input
                    type="date" className="input" value={form.batch_kadaluarsa}
                    onChange={(e) => setForm({ ...form, batch_kadaluarsa: e.target.value })}
                  />
                </Field>
              </>
            )}

            {form.move_type === 'OUT' && selected?.lacak_batch && (
              <p className="sm:col-span-2 rounded-xl bg-sky-50 px-3 py-2 text-xs text-sky-900">
                Produk ini dilacak per batch. Barang diambil otomatis dari batch yang paling
                dekat kedaluwarsa, jadi tidak perlu memilih batch-nya sendiri.
              </p>
            )}

            {form.move_type === 'IN' && (
              <Field label="Supplier" hint="Wajib bila memakai tempo, agar utang terlacak" className="sm:col-span-2">
                <select className="input" value={form.partner_id} onChange={(e) => setForm({ ...form, partner_id: e.target.value })}>
                  <option value="">— tidak dicatat —</option>
                  {suppliers.map((sp) => <option key={sp.id} value={sp.id}>{sp.name}</option>)}
                </select>
              </Field>
            )}

            {form.move_type === 'IN' && (
              <Field
                label="Cara Bayar *"
                hint="Menentukan uang siapa yang berkurang — pilih sesuai kenyataannya"
                className={form.cara === 'REKENING' ? '' : 'sm:col-span-2'}
              >
                <select
                  className="input" required value={form.cara}
                  onChange={(e) => setForm({ ...form, cara: e.target.value, cash_code: '' })}
                >
                  <option value="">— pilih cara bayar —</option>
                  <option value="REKENING">Dibayar dari rekening / kas</option>
                  <option value="CREDIT">Utang Supplier (tempo)</option>
                  <option value="OPENING">Saldo Awal (modal pemilik)</option>
                </select>
              </Field>
            )}

            {form.move_type === 'IN' && form.cara === 'REKENING' && (
              <Field label="Dibayar dari *" hint="Rekening yang benar-benar dipakai membayar">
                <select
                  className="input" required value={form.cash_code}
                  onChange={(e) => setForm({ ...form, cash_code: e.target.value })}
                >
                  <option value="">— pilih rekening —</option>
                  {rekening.map((k) => <option key={k.code} value={k.code}>{k.code} — {k.name}</option>)}
                </select>
              </Field>
            )}

            <Field label="Catatan" className="sm:col-span-2">
              <input className="input" value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} />
            </Field>

            {selected && form.qty && (
              <p className="rounded-xl bg-brand-50 p-3 text-xs text-brand-800 sm:col-span-2">
                <Package size={13} className="mr-1 inline" />
                Nilai mutasi:{' '}
                <strong>
                  {rupiah(Number(form.qty) * (form.move_type === 'IN' && form.unit_cost !== '' ? Number(form.unit_cost) : selected.cost))}
                </strong>
                {' • '}Saldo stok menjadi{' '}
                <strong>
                  {num(form.move_type === 'IN' ? selected.stock + Number(form.qty) : selected.stock - Number(form.qty))} {selected.unit}
                </strong>
              </p>
            )}

            <div className="flex gap-2 sm:col-span-2">
              <button type="button" className="btn-secondary flex-1" onClick={() => setForm(null)}>Batal</button>
              <button type="submit" className="btn-primary flex-1"><Plus size={16} /> Simpan Mutasi</button>
            </div>
          </form>
        )}
      </Modal>

      {/* ---------- JADIKAN PESANAN PEMBELIAN ---------- */}
      <Modal open={!!jadiPO} onClose={() => setJadiPO(null)} title="Jadikan Pesanan Pembelian">
        {jadiPO && (
          <form onSubmit={simpanPO} className="grid gap-3 sm:grid-cols-2">
            <div className="rounded-xl bg-slate-50 px-3 py-2 text-sm sm:col-span-2">
              <p className="font-medium text-slate-900">{jadiPO.product_name}</p>
              <p className="text-xs text-slate-500">
                Barang masuk {jadiPO.move_date} · {num(jadiPO.qty)} {jadiPO.unit} · {jadiPO.ref || '-'} · tercatat{' '}
                <strong>{rupiah(jadiPO.value)}</strong>
              </p>
              <p className="mt-1 text-xs text-slate-500">
                Supplier diambil dari barang masuk ini. Stok <strong>tidak</strong> bertambah lagi — barang
                masuk ini yang menjadi penerimaan pesanannya.
              </p>
            </div>
            <Field label="Tanggal pesanan *">
              <input
                type="date" className="input" required value={jadiPO.order_date}
                onChange={(e) => setJadiPO({ ...jadiPO, order_date: e.target.value })}
              />
            </Field>
            <Field label="No. faktur supplier">
              <input
                className="input" maxLength={60} value={jadiPO.invoice_no}
                onChange={(e) => setJadiPO({ ...jadiPO, invoice_no: e.target.value })}
              />
            </Field>
            <Field label="Harga per unit dari pabrik *">
              <input
                type="number" min="0" step="any" className="input" required value={jadiPO.unit_cost}
                onChange={(e) => setJadiPO({ ...jadiPO, unit_cost: e.target.value })}
              />
            </Field>
            <Field label="Ongkir / biaya tambahan (total)" hint="Dibagi rata ke seluruh qty">
              <input
                type="number" min="0" step="any" className="input" value={jadiPO.biaya_tambahan} placeholder="0"
                onChange={(e) => setJadiPO({ ...jadiPO, biaya_tambahan: e.target.value })}
              />
            </Field>
            <Field label="Catatan" className="sm:col-span-2">
              <input
                className="input" maxLength={200} value={jadiPO.catatan}
                placeholder="mis. Transfer ke FRASIANTO PRIHADI, DP 17/08 + pelunasan 20/08"
                onChange={(e) => setJadiPO({ ...jadiPO, catatan: e.target.value })}
              />
            </Field>
            <div className="rounded-xl bg-brand-50 p-3 text-xs leading-relaxed text-brand-800 sm:col-span-2">
              Total pesanan <strong>{rupiah(nilaiPOBaru)}</strong>
              {jadiPO.qty > 0 && <> ({rupiah(nilaiPOBaru / jadiPO.qty)}/{jadiPO.unit})</>}
              {Math.abs(nilaiPOBaru - jadiPO.value) >= 0.01 && (
                <>, harga dibetulkan dari {rupiah(jadiPO.value)} — utang supplier dan HPP ikut menyesuaikan.
                  Bila pembayarannya sudah tercatat lebih besar dari nilai baru, hapus dulu pembayaran yang
                  salah di Utang & Piutang → Transaksi.</>
              )}
            </div>
            <div className="flex gap-2 sm:col-span-2">
              <button type="button" className="btn-secondary flex-1" onClick={() => setJadiPO(null)}>Batal</button>
              <button type="submit" className="btn-primary flex-1" disabled={menyimpanPO}>
                {menyimpanPO ? 'Menyimpan...' : 'Buat Pesanan Pembelian'}
              </button>
            </div>
          </form>
        )}
      </Modal>

      {/* ---------- BETULKAN HARGA BARANG MASUK ---------- */}
      <Modal open={!!harga} onClose={() => setHarga(null)} title="Betulkan Harga Barang Masuk">
        {harga && (
          <form onSubmit={simpanHarga} className="grid gap-3 sm:grid-cols-2">
            <div className="rounded-xl bg-slate-50 px-3 py-2 text-sm sm:col-span-2">
              <p className="font-medium text-slate-900">{harga.product_name}</p>
              <p className="text-xs text-slate-500">
                {harga.move_date} · {num(harga.qty)} {harga.unit} · {harga.ref || '-'} · tercatat{' '}
                <strong>{rupiah(harga.value)}</strong>
              </p>
            </div>
            <Field label="Harga per unit dari pabrik *">
              <input
                type="number" min="0" step="any" className="input" required value={harga.unit_cost}
                onChange={(e) => setHarga({ ...harga, unit_cost: e.target.value })}
              />
            </Field>
            <Field label="Ongkir / biaya tambahan (total)" hint="Dibagi rata ke seluruh qty">
              <input
                type="number" min="0" step="any" className="input" value={harga.biaya_tambahan}
                placeholder="0"
                onChange={(e) => setHarga({ ...harga, biaya_tambahan: e.target.value })}
              />
            </Field>
            <Field label="Alasan *" className="sm:col-span-2">
              <input
                className="input" required minLength={3} value={harga.alasan}
                placeholder="mis. Harga asli pabrik + ongkir"
                onChange={(e) => setHarga({ ...harga, alasan: e.target.value })}
              />
            </Field>
            <div className="rounded-xl bg-brand-50 p-3 text-xs leading-relaxed text-brand-800 sm:col-span-2">
              Nilai baru <strong>{rupiah(nilaiHargaBaru)}</strong>
              {harga.qty > 0 && <> ({rupiah(nilaiHargaBaru / harga.qty)}/{harga.unit})</>}, selisih{' '}
              <strong>{rupiah(nilaiHargaBaru - harga.value)}</strong>. Utang supplier (atau rekening
              pembayarnya) ikut menyesuaikan, dan selisihnya masuk ke HPP rata-rata stok yang tersisa.
              Penjualan yang sudah tercatat tidak berubah.
            </div>
            <div className="flex gap-2 sm:col-span-2">
              <button type="button" className="btn-secondary flex-1" onClick={() => setHarga(null)}>Batal</button>
              <button type="submit" className="btn-primary flex-1" disabled={menyimpanHarga}>
                {menyimpanHarga ? 'Menyimpan...' : 'Simpan Harga'}
              </button>
            </div>
          </form>
        )}
      </Modal>
    </div>
  );
}
