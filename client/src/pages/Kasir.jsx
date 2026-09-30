import { useEffect, useRef, useState, useCallback } from 'react';
import { Link } from 'react-router-dom';
import {
  ScanBarcode, Minus, Plus, Trash2, Banknote, QrCode, Landmark, Printer, LockOpen, Lock,
  ShoppingCart, History, CheckCircle2, Search,
} from 'lucide-react';
import { api } from '../lib/api';
import { PageHeader, Spinner, Modal, useToast, Field, TombolCetak } from '../components/ui';
import { rupiah, num } from '../lib/format';

const METODE = [
  { v: 'TUNAI', label: 'Tunai', icon: Banknote, warna: 'bg-emerald-600' },
  { v: 'QRIS', label: 'QRIS', icon: QrCode, warna: 'bg-violet-600' },
  { v: 'TRANSFER', label: 'Transfer', icon: Landmark, warna: 'bg-sky-600' },
];

const jamLokal = (iso) => (iso ? new Date(iso).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' }) : '-');

/**
 * Mencetak struk ke printer thermal lewat dialog cetak peramban.
 *
 * Halaman kecil selebar kertas 80 mm dibuka di jendela tersendiri lalu
 * langsung dicetak. Cara ini bekerja dengan printer thermal apa pun yang
 * terpasang di komputer kasir, tanpa driver atau aplikasi tambahan.
 */
function cetakStruk(s) {
  const rp = (n) => Number(n || 0).toLocaleString('id-ID');
  const baris = s.items.map((i) => `
    <div>${i.name}</div>
    <div class="dua"><span>&nbsp;&nbsp;${rp(i.qty)} x ${rp(i.price)}</span><span>${rp(i.subtotal)}</span></div>`).join('');
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>${s.order_no}</title>
  <style>
    @page { size: 80mm auto; margin: 3mm; }
    body { font-family: 'Courier New', monospace; font-size: 12px; width: 72mm; margin: 0; color: #000; }
    .tengah { text-align: center; } .tebal { font-weight: bold; }
    .dua { display: flex; justify-content: space-between; gap: 6px; }
    hr { border: 0; border-top: 1px dashed #000; margin: 6px 0; }
    .besar { font-size: 14px; }
  </style></head><body>
    <div class="tengah tebal besar">${s.toko.nama}</div>
    ${s.toko.alamat ? `<div class="tengah">${s.toko.alamat}</div>` : ''}
    ${s.toko.telepon ? `<div class="tengah">${s.toko.telepon}</div>` : ''}
    <hr>
    <div>${s.order_no}</div><div>${s.waktu}</div>
    <div>Kasir: ${s.kasir || '-'}</div>
    ${s.customer ? `<div>Pembeli: ${s.customer}</div>` : ''}
    <hr>${baris}<hr>
    <div class="dua"><span>Subtotal</span><span>${rp(s.subtotal)}</span></div>
    ${s.diskon ? `<div class="dua"><span>Diskon</span><span>-${rp(s.diskon)}</span></div>` : ''}
    <div class="dua tebal besar"><span>TOTAL</span><span>${rp(s.total)}</span></div>
    <div class="dua"><span>Bayar (${s.metode})</span><span>${rp(s.dibayar != null ? s.dibayar : s.total)}</span></div>
    ${s.kembali ? `<div class="dua tebal"><span>Kembali</span><span>${rp(s.kembali)}</span></div>` : ''}
    ${s.rekening ? `<div>Ke rekening ${s.rekening}</div>` : ''}
    <hr><div class="tengah">${s.toko.catatan}</div>
  </body></html>`;
  const w = window.open('', '_blank', 'width=380,height=640');
  if (!w) return false;
  w.document.write(html);
  w.document.close();
  w.focus();
  setTimeout(() => { w.print(); }, 250);
  return true;
}

/**
 * Kasir / POS.
 *
 * Alur tercepat untuk penjualan langsung di toko: pindai barcode (atau ketik
 * SKU/nama lalu Enter), atur jumlah, pilih cara bayar, Bayar. Setiap transaksi
 * menjadi order penjualan biasa, jadi stok, laba, dan pembukuannya ikut
 * tercatat — dan melekat pada sesi kasir yang sedang dibuka.
 */
export default function Kasir() {
  const toast = useToast();
  const scanRef = useRef(null);

  const [data, setData] = useState(null);
  const [cari, setCari] = useState('');
  const [hasil, setHasil] = useState([]);
  const [keranjang, setKeranjang] = useState([]);
  const [diskon, setDiskon] = useState('');
  const [metode, setMetode] = useState('TUNAI');
  const [dibayar, setDibayar] = useState('');
  const [rekening, setRekening] = useState('');
  const [pembeli, setPembeli] = useState('');
  const [memproses, setMemproses] = useState(false);
  const [struk, setStruk] = useState(null);
  const [buka, setBuka] = useState({ opening_cash: '' });
  const [tutup, setTutup] = useState(null);

  const muat = useCallback(async () => {
    try {
      setData(await api.get('/api/kasir/sesi-aktif'));
    } catch (err) {
      toast.error(err.message);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => { muat(); }, [muat]);

  // Daftar produk awal & hasil ketikan (bukan pindaian) — ditunda sedikit
  // supaya tidak menembak peladen di setiap huruf.
  useEffect(() => {
    if (!data?.sesi) return undefined;
    const t = setTimeout(() => {
      api.get('/api/kasir/produk', { q: cari }).then((d) => setHasil(d.rows)).catch(() => {});
    }, 250);
    return () => clearTimeout(t);
  }, [cari, data?.sesi]);

  const fokusScan = () => setTimeout(() => scanRef.current?.focus(), 30);

  function tambah(p) {
    setKeranjang((k) => {
      const ada = k.find((x) => x.product_id === p.id);
      if (ada) return k.map((x) => (x.product_id === p.id ? { ...x, qty: x.qty + 1 } : x));
      return [...k, { product_id: p.id, name: p.name, sku: p.sku, unit: p.unit, price: p.price, stock: p.stock, qty: 1 }];
    });
    fokusScan();
  }

  /** Enter di kotak pindai: kode persis langsung masuk keranjang. */
  async function pindai(e) {
    e.preventDefault();
    const q = cari.trim();
    if (!q) return;
    try {
      const d = await api.get('/api/kasir/produk', { q });
      if (d.persis) {
        tambah(d.persis);
        setCari('');
      } else if (d.rows.length === 1) {
        tambah(d.rows[0]);
        setCari('');
      } else if (d.rows.length === 0) {
        toast.error(`Barang "${q}" tidak ditemukan`);
      } else {
        setHasil(d.rows);
      }
    } catch (err) {
      toast.error(err.message);
    }
  }

  function ubahBaris(id, patch) {
    setKeranjang((k) => k.map((x) => (x.product_id === id ? { ...x, ...patch } : x)).filter((x) => x.qty > 0));
  }

  const subtotal = keranjang.reduce((s, x) => s + x.qty * (Number(x.price) || 0), 0);
  const total = Math.max(0, subtotal - (Number(diskon) || 0));
  const uang = dibayar === '' ? total : Number(dibayar) || 0;
  const kembali = metode === 'TUNAI' ? uang - total : 0;
  const bisaBayar = keranjang.length > 0 && !memproses
    && (metode !== 'TUNAI' || uang >= total)
    && (metode !== 'TRANSFER' || rekening);

  async function bayar() {
    if (!bisaBayar) return;
    setMemproses(true);
    try {
      const res = await api.post('/api/kasir/transaksi', {
        items: keranjang.map((x) => ({ product_id: x.product_id, qty: Number(x.qty), price: Number(x.price) || 0 })),
        discount: Number(diskon) || 0,
        method: metode,
        cash_code: metode === 'TRANSFER' ? rekening : null,
        paid: metode === 'TUNAI' ? uang : null,
        customer: pembeli || null,
      });
      toast.success(res.message);
      setStruk(res.struk);
      setKeranjang([]);
      setDiskon('');
      setDibayar('');
      setPembeli('');
      muat();
    } catch (err) {
      toast.error(err.message);
    } finally {
      setMemproses(false);
    }
  }

  // F9 = bayar, dari mana pun di layar kasir.
  useEffect(() => {
    const tekan = (e) => {
      if (e.key === 'F9') { e.preventDefault(); bayar(); }
    };
    window.addEventListener('keydown', tekan);
    return () => window.removeEventListener('keydown', tekan);
  });

  async function bukaSesi(e) {
    e.preventDefault();
    try {
      const res = await api.post('/api/kasir/sesi/buka', { opening_cash: Number(buka.opening_cash) || 0 });
      toast.success(res.message);
      setBuka({ opening_cash: '' });
      muat();
      fokusScan();
    } catch (err) {
      toast.error(err.message);
    }
  }

  async function tutupSesi(e) {
    e.preventDefault();
    try {
      const res = await api.post(`/api/kasir/sesi/${data.sesi.id}/tutup`, {
        counted_cash: Number(tutup.counted_cash) || 0,
        setor_amount: Number(tutup.setor_amount) || 0,
        setor_to: Number(tutup.setor_amount) > 0 ? tutup.setor_to || null : null,
        note: tutup.note || null,
      });
      toast.success(res.message);
      setTutup(null);
      muat();
    } catch (err) {
      toast.error(err.message);
    }
  }

  if (!data) return <Spinner />;
  const sesi = data.sesi;

  // ---------- belum ada sesi ----------
  if (!sesi) {
    return (
      <div>
        <PageHeader title="Kasir / POS" subtitle="Penjualan langsung di toko">
          <Link className="btn-secondary" to="/penjualan/sesi-kasir"><History size={16} /> Riwayat Sesi</Link>
        </PageHeader>
        <div className="card mx-auto max-w-md text-center">
          <LockOpen size={40} className="mx-auto mb-3 text-brand-600" />
          <h2 className="text-lg font-bold text-slate-900">Buka Sesi Kasir</h2>
          <p className="mb-4 mt-1 text-sm text-slate-500">
            Hitung uang di laci sebelum mulai — itulah modal awalnya. Saat sesi ditutup, uang laci
            dicocokkan dengan modal ini ditambah penjualan tunai.
          </p>
          <form onSubmit={bukaSesi} className="grid gap-3 text-left">
            <Field label="Modal awal di laci (Rp)">
              <input
                type="number" min="0" step="any" className="input text-lg" autoFocus placeholder="0"
                value={buka.opening_cash} onChange={(e) => setBuka({ opening_cash: e.target.value })}
              />
            </Field>
            <button type="submit" className="btn-primary w-full"><LockOpen size={16} /> Buka Sesi</button>
          </form>
        </div>
      </div>
    );
  }

  const r = sesi.rekap;
  const rekeningBank = (data.rekening || []).filter((k) => k.code !== sesi.cash_code);

  return (
    <div>
      <PageHeader
        title="Kasir / POS"
        subtitle={`Sesi ${sesi.session_no} · dibuka ${jamLokal(sesi.opened_at)} · ${num(r.transaksi)} transaksi · ${rupiah(r.total)}`}
      >
        <Link className="btn-secondary" to="/penjualan/sesi-kasir"><History size={16} /> Riwayat Sesi</Link>
        <button
          className="btn-secondary text-rose-600"
          onClick={() => setTutup({ counted_cash: '', setor_amount: '', setor_to: '', note: '' })}
        >
          <Lock size={16} /> Tutup Sesi
        </button>
      </PageHeader>

      <div className="grid gap-4 lg:grid-cols-12">
        {/* ---------- PRODUK ---------- */}
        <div className="lg:col-span-7">
          <form onSubmit={pindai} className="card mb-3">
            <label className="label" htmlFor="pindai">Pindai barcode atau ketik SKU / nama, lalu Enter</label>
            <div className="relative">
              <ScanBarcode size={20} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
              <input
                id="pindai" ref={scanRef} autoFocus className="input !pl-10 text-lg" autoComplete="off"
                placeholder="Arahkan scanner ke barcode…"
                value={cari} onChange={(e) => setCari(e.target.value)}
              />
            </div>
          </form>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            {hasil.map((p) => (
              <button
                key={p.id} type="button" onClick={() => tambah(p)}
                className="rounded-xl bg-surface p-3 text-left shadow-sm ring-1 ring-slate-200/70 transition hover:-translate-y-0.5 hover:shadow-md hover:ring-brand-300"
              >
                <p className="line-clamp-2 text-sm font-semibold text-slate-900">{p.name}</p>
                <p className="font-mono text-[11px] text-slate-400">{p.sku}</p>
                <p className="mt-1 font-bold text-brand-700">{rupiah(p.price)}</p>
                <p className={`text-[11px] ${p.stock > 0 ? 'text-slate-500' : 'text-rose-600'}`}>stok {num(p.stock)} {p.unit}</p>
              </button>
            ))}
            {hasil.length === 0 && (
              <p className="col-span-full py-8 text-center text-sm text-slate-500">
                <Search size={18} className="mx-auto mb-1" /> Tidak ada barang yang cocok
              </p>
            )}
          </div>
        </div>

        {/* ---------- KERANJANG & BAYAR ---------- */}
        <div className="lg:col-span-5">
          <div className="card lg:sticky lg:top-4">
            <h2 className="mb-2 flex items-center gap-2 font-bold text-slate-900">
              <ShoppingCart size={18} /> Keranjang ({keranjang.length})
            </h2>
            {keranjang.length === 0 ? (
              <p className="py-6 text-center text-sm text-slate-500">Pindai barang untuk mulai</p>
            ) : (
              <ul className="mb-3 max-h-72 space-y-2 overflow-y-auto pr-1">
                {keranjang.map((x) => (
                  <li key={x.product_id} className="rounded-xl bg-slate-50 p-2.5">
                    <div className="flex items-start justify-between gap-2">
                      <p className="text-sm font-medium text-slate-900">{x.name}</p>
                      <button type="button" className="text-rose-600" aria-label={`Hapus ${x.name}`}
                        onClick={() => ubahBaris(x.product_id, { qty: 0 })}>
                        <Trash2 size={14} />
                      </button>
                    </div>
                    <div className="mt-1.5 flex items-center justify-between gap-2">
                      <div className="flex items-center gap-1">
                        <button type="button" className="btn-secondary !px-2 !py-1" aria-label="Kurangi"
                          onClick={() => ubahBaris(x.product_id, { qty: x.qty - 1 })}><Minus size={13} /></button>
                        <input type="number" min="0" step="any" className="input !w-16 !py-1 text-center"
                          value={x.qty} onChange={(e) => ubahBaris(x.product_id, { qty: Number(e.target.value) || 0 })} />
                        <button type="button" className="btn-secondary !px-2 !py-1" aria-label="Tambah"
                          onClick={() => ubahBaris(x.product_id, { qty: x.qty + 1 })}><Plus size={13} /></button>
                      </div>
                      <input type="number" min="0" step="any" className="input !w-28 !py-1 text-right" title="Harga satuan"
                        value={x.price} onChange={(e) => ubahBaris(x.product_id, { price: e.target.value })} />
                      <span className="tabular w-24 text-right text-sm font-semibold">{rupiah(x.qty * (Number(x.price) || 0))}</span>
                    </div>
                    {x.qty > x.stock && <p className="mt-1 text-[11px] text-rose-600">Melebihi stok ({num(x.stock)})</p>}
                  </li>
                ))}
              </ul>
            )}

            <div className="space-y-1.5 border-t border-slate-100 pt-3 text-sm">
              <div className="flex justify-between"><span className="text-slate-500">Subtotal</span><span className="tabular">{rupiah(subtotal)}</span></div>
              <div className="flex items-center justify-between gap-3">
                <span className="text-slate-500">Diskon</span>
                <input type="number" min="0" step="any" className="input !w-32 !py-1 text-right" placeholder="0"
                  value={diskon} onChange={(e) => setDiskon(e.target.value)} />
              </div>
              <div className="flex items-center justify-between pt-1">
                <span className="font-bold text-slate-900">TOTAL</span>
                <span className="tabular text-2xl font-extrabold text-brand-700">{rupiah(total)}</span>
              </div>
            </div>

            <div className="mt-3 grid grid-cols-3 gap-2">
              {METODE.map((m) => (
                <button
                  key={m.v} type="button" onClick={() => setMetode(m.v)}
                  className={`flex flex-col items-center gap-1 rounded-xl px-2 py-2.5 text-sm font-semibold transition ${
                    metode === m.v ? `${m.warna} text-white shadow` : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
                  }`}
                >
                  <m.icon size={18} /> {m.label}
                </button>
              ))}
            </div>

            {metode === 'TUNAI' && (
              <div className="mt-3 space-y-2">
                <Field label="Uang diterima">
                  <input type="number" min="0" step="any" className="input text-lg" placeholder={String(total)}
                    value={dibayar} onChange={(e) => setDibayar(e.target.value)} />
                </Field>
                <div className="flex flex-wrap gap-1.5">
                  {[['Uang pas', total], ['50.000', 50000], ['100.000', 100000], ['200.000', 200000]].map(([l, v]) => (
                    <button key={l} type="button" className="btn-secondary !px-2.5 !py-1 text-xs" onClick={() => setDibayar(String(v))}>{l}</button>
                  ))}
                </div>
                <div className={`flex justify-between rounded-xl px-3 py-2 text-sm font-semibold ${kembali < 0 ? 'bg-rose-50 text-rose-700' : 'bg-emerald-50 text-emerald-800'}`}>
                  <span>{kembali < 0 ? 'Uang kurang' : 'Kembalian'}</span>
                  <span className="tabular text-base">{rupiah(Math.abs(kembali))}</span>
                </div>
              </div>
            )}
            {metode === 'TRANSFER' && (
              <Field label="Masuk ke rekening *" className="mt-3">
                <select className="input" value={rekening} onChange={(e) => setRekening(e.target.value)}>
                  <option value="">— pilih rekening —</option>
                  {rekeningBank.map((k) => <option key={k.code} value={k.code}>{k.code} — {k.name}</option>)}
                </select>
              </Field>
            )}
            {metode === 'QRIS' && (
              <p className="mt-3 rounded-xl bg-violet-50 px-3 py-2 text-xs text-violet-800">
                Pastikan pembayaran QRIS sudah berhasil di aplikasi merchant sebelum menekan Bayar.
              </p>
            )}

            <Field label="Nama pembeli (opsional)" className="mt-3">
              <input className="input" maxLength={120} value={pembeli} onChange={(e) => setPembeli(e.target.value)} />
            </Field>

            <button type="button" className="btn-primary mt-3 w-full !py-3 text-base" disabled={!bisaBayar} onClick={bayar}>
              <CheckCircle2 size={18} /> {memproses ? 'Memproses...' : `Bayar ${rupiah(total)}`}
              <span className="ml-1 text-xs opacity-75">(F9)</span>
            </button>
          </div>
        </div>
      </div>

      {/* ---------- STRUK ---------- */}
      <Modal open={!!struk} onClose={() => { setStruk(null); fokusScan(); }} title="Transaksi Berhasil">
        {struk && (
          <div className="grid gap-3">
            <div className="mx-auto w-full max-w-xs rounded-xl bg-white p-4 font-mono text-xs text-slate-900 shadow-inner ring-1 ring-slate-200">
              <p className="text-center text-sm font-bold">{struk.toko.nama}</p>
              <p className="text-center">{struk.order_no} · {struk.waktu}</p>
              <hr className="my-2 border-dashed border-slate-400" />
              {struk.items.map((i, k) => (
                <div key={k}>
                  <p>{i.name}</p>
                  <p className="flex justify-between"><span>&nbsp;&nbsp;{num(i.qty)} x {num(i.price)}</span><span>{num(i.subtotal)}</span></p>
                </div>
              ))}
              <hr className="my-2 border-dashed border-slate-400" />
              {struk.diskon > 0 && <p className="flex justify-between"><span>Diskon</span><span>-{num(struk.diskon)}</span></p>}
              <p className="flex justify-between text-sm font-bold"><span>TOTAL</span><span>{num(struk.total)}</span></p>
              <p className="flex justify-between"><span>Bayar ({struk.metode})</span><span>{num(struk.dibayar ?? struk.total)}</span></p>
              {struk.kembali > 0 && <p className="flex justify-between font-bold"><span>Kembali</span><span>{num(struk.kembali)}</span></p>}
            </div>
            <div className="grid grid-cols-2 gap-2">
              <button type="button" className="btn-primary"
                onClick={() => { if (!cetakStruk(struk)) toast.error('Pop-up diblokir — izinkan pop-up untuk mencetak struk'); }}>
                <Printer size={16} /> Cetak Struk
              </button>
              <TombolCetak path={`/api/kasir/transaksi/${struk.id}/struk.pdf`} label="PDF" icon={Printer} />
            </div>
            <button type="button" className="btn-secondary" onClick={() => { setStruk(null); fokusScan(); }}>
              Transaksi Baru
            </button>
          </div>
        )}
      </Modal>

      {/* ---------- TUTUP SESI ---------- */}
      <Modal open={!!tutup} onClose={() => setTutup(null)} title={`Tutup Sesi ${sesi.session_no}`}>
        {tutup && (
          <form onSubmit={tutupSesi} className="grid gap-3">
            <div className="grid grid-cols-2 gap-x-4 gap-y-1 rounded-xl bg-slate-50 p-3 text-sm">
              <span className="text-slate-500">Transaksi</span><span className="tabular text-right">{num(r.transaksi)}</span>
              <span className="text-slate-500">Tunai</span><span className="tabular text-right">{rupiah(r.perMetode.TUNAI)}</span>
              <span className="text-slate-500">QRIS</span><span className="tabular text-right">{rupiah(r.perMetode.QRIS)}</span>
              <span className="text-slate-500">Transfer</span><span className="tabular text-right">{rupiah(r.perMetode.TRANSFER)}</span>
              <span className="text-slate-500">Modal awal laci</span><span className="tabular text-right">{rupiah(sesi.opening_cash)}</span>
              <span className="font-semibold text-slate-900">Uang laci seharusnya</span>
              <span className="tabular text-right font-bold">{rupiah(r.uangLaciSeharusnya)}</span>
            </div>
            <Field label="Uang yang dihitung di laci (Rp) *">
              <input type="number" min="0" step="any" className="input text-lg" required autoFocus
                value={tutup.counted_cash} onChange={(e) => setTutup({ ...tutup, counted_cash: e.target.value })} />
            </Field>
            {tutup.counted_cash !== '' && (() => {
              const sel = (Number(tutup.counted_cash) || 0) - r.uangLaciSeharusnya;
              return (
                <p className={`rounded-xl px-3 py-2 text-sm font-semibold ${Math.abs(sel) < 1 ? 'bg-emerald-50 text-emerald-800' : sel < 0 ? 'bg-rose-50 text-rose-700' : 'bg-amber-50 text-amber-800'}`}>
                  {Math.abs(sel) < 1 ? 'Laci pas' : `${sel < 0 ? 'Kurang' : 'Lebih'} ${rupiah(Math.abs(sel))}`}
                  {Math.abs(sel) >= 1 && <span className="block text-xs font-normal">Dicatat di akun Selisih Kas Kasir</span>}
                </p>
              );
            })()}
            <div className="grid grid-cols-2 gap-3">
              <Field label="Setor ke bank (Rp)" hint="Opsional">
                <input type="number" min="0" step="any" className="input" placeholder="0"
                  value={tutup.setor_amount} onChange={(e) => setTutup({ ...tutup, setor_amount: e.target.value })} />
              </Field>
              <Field label="Ke rekening">
                <select className="input" value={tutup.setor_to} required={Number(tutup.setor_amount) > 0}
                  onChange={(e) => setTutup({ ...tutup, setor_to: e.target.value })}>
                  <option value="">— pilih —</option>
                  {rekeningBank.map((k) => <option key={k.code} value={k.code}>{k.code} — {k.name}</option>)}
                </select>
              </Field>
            </div>
            <Field label="Catatan">
              <input className="input" maxLength={300} value={tutup.note} onChange={(e) => setTutup({ ...tutup, note: e.target.value })} />
            </Field>
            <div className="flex gap-2">
              <button type="button" className="btn-secondary flex-1" onClick={() => setTutup(null)}>Batal</button>
              <button type="submit" className="btn-primary flex-1 !bg-rose-600 hover:!bg-rose-700"><Lock size={16} /> Tutup Sesi</button>
            </div>
          </form>
        )}
      </Modal>
    </div>
  );
}
