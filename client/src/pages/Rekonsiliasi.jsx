import { useEffect, useState, useCallback } from 'react';
import { Landmark, Upload, Link2, Unlink, PlusCircle, Trash2, ArrowLeft, Info } from 'lucide-react';
import { api } from '../lib/api';
import { PageHeader, Spinner, EmptyState, StatCard, useToast, Field, Modal } from '../components/ui';
import { rupiah, dateID } from '../lib/format';

/**
 * Membaca rekening koran yang ditempel dari spreadsheet atau CSV.
 *
 * Bank menulis tabelnya masing-masing dengan cara berbeda, jadi yang dikenali
 * di sini hanya bentuk paling umum: satu baris per transaksi, dipisah koma
 * atau tab, dengan kolom tanggal, keterangan, lalu nominal. Baris yang tidak
 * terbaca DILAPORKAN, bukan dibuang diam-diam — baris hilang yang tidak
 * diketahui jauh lebih berbahaya daripada impor yang gagal terang-terangan.
 */
function bacaTabel(teks) {
  const rows = [];
  const gagal = [];

  const angka = (v) => {
    if (v == null) return 0;
    const bersih = String(v).replace(/[^\d,.-]/g, '').replace(/\.(?=\d{3}\b)/g, '').replace(',', '.');
    const n = Number(bersih);
    return Number.isFinite(n) ? Math.abs(n) : 0;
  };

  const tanggal = (v) => {
    const t = String(v || '').trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return t;
    const m = t.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})$/);
    if (!m) return null;
    const [, d, bl, th] = m;
    const tahun = th.length === 2 ? `20${th}` : th;
    return `${tahun}-${String(bl).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  };

  for (const baris of teks.split(/\r?\n/)) {
    const isi = baris.trim();
    if (!isi) continue;

    const kolom = isi.includes('\t') ? isi.split('\t') : isi.split(',');
    if (kolom.length < 3) { gagal.push(isi); continue; }

    const tgl = tanggal(kolom[0]);
    if (!tgl) { gagal.push(isi); continue; } // termasuk baris judul

    const masuk = angka(kolom[kolom.length - 2]);
    const keluar = angka(kolom[kolom.length - 1]);
    if (masuk === 0 && keluar === 0) { gagal.push(isi); continue; }

    rows.push({
      tanggal: tgl,
      keterangan: kolom.slice(1, kolom.length - 2).join(' ').trim().slice(0, 300),
      masuk, keluar,
    });
  }

  return { rows, gagal };
}

export default function Rekonsiliasi() {
  const toast = useToast();
  const [daftar, setDaftar] = useState(null);
  const [buka, setBuka] = useState(null);
  const [detail, setDetail] = useState(null);
  const [formImpor, setFormImpor] = useState(null);
  const [catat, setCatat] = useState(null);
  const [kategori, setKategori] = useState({ incomeCategories: [], expenseCategories: [] });

  const load = useCallback(async () => {
    try {
      setDaftar(await api.get('/api/rekonsiliasi'));
    } catch (err) { toast.error(err.message); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    api.get('/api/cashflow/options').then(setKategori).catch(() => {});
  }, []);

  const bukaDetail = useCallback(async (id) => {
    try {
      setDetail(await api.get(`/api/rekonsiliasi/${id}`));
      setBuka(id);
    } catch (err) { toast.error(err.message); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function kirimImpor(e) {
    e.preventDefault();
    const { rows, gagal } = bacaTabel(formImpor.teks);
    if (!rows.length) return toast.error('Tidak ada baris yang bisa dibaca — periksa formatnya');

    try {
      const res = await api.post('/api/rekonsiliasi/impor', {
        account_code: formImpor.account_code,
        nama_berkas: formImpor.nama_berkas || null,
        rows,
      });
      toast.success(res.message + (gagal.length ? ` (${gagal.length} baris dilewati)` : ''));
      setFormImpor(null);
      await load();
      bukaDetail(res.statementId);
    } catch (err) { toast.error(err.message); }
  }

  async function pasang(barisId, journalLineId) {
    try {
      const res = await api.patch(`/api/rekonsiliasi/baris/${barisId}`, {
        journal_line_id: journalLineId,
      });
      toast.success(res.message);
      bukaDetail(buka);
    } catch (err) { toast.error(err.message); }
  }

  async function kirimCatat(e) {
    e.preventDefault();
    try {
      const res = await api.post(`/api/rekonsiliasi/baris/${catat.baris.id}/catat`, {
        category_code: catat.category_code,
        description: catat.description,
      });
      toast.success(res.message);
      setCatat(null);
      bukaDetail(buka);
    } catch (err) { toast.error(err.message); }
  }

  async function buang(id) {
    if (!window.confirm(
      'Buang rekening koran ini?\n\nCatatan kas yang terlanjur dibuat dari sini TETAP tersimpan — '
      + 'yang dibuang hanya daftar mutasi banknya.'
    )) return;
    try {
      const res = await api.del(`/api/rekonsiliasi/${id}`);
      toast.success(res.message);
      setBuka(null); setDetail(null);
      load();
    } catch (err) { toast.error(err.message); }
  }

  if (!daftar) return <Spinner label="Memuat rekonsiliasi..." />;

  // ---------- Layar detail ----------
  if (buka && detail) {
    const r = detail.ringkas;
    const selisih = r.mutasiBank - r.mutasiCatatan;

    return (
      <div>
        <PageHeader
          title={`Rekonsiliasi ${detail.akun.name}`}
          subtitle={`${dateID(detail.statement.periode_dari)} – ${dateID(detail.statement.periode_sampai)} · ${r.totalBaris} baris rekening koran`}
        >
          <button className="btn-secondary" onClick={() => { setBuka(null); setDetail(null); }}>
            <ArrowLeft size={16} /> Kembali
          </button>
          <button className="btn-secondary !text-rose-600" onClick={() => buang(detail.statement.id)}>
            <Trash2 size={16} /> Buang
          </button>
        </PageHeader>

        <div className="mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <StatCard label="Sudah Berpasangan" value={`${r.jumlahCocok} baris`}
            sub={`dari ${r.totalBaris} baris rekening koran`} tone="green" />
          <StatCard label="Ada di Bank, Belum Dicatat" value={`${r.bankSaja.baris} baris`}
            sub={`masuk ${rupiah(r.bankSaja.masuk)} • keluar ${rupiah(r.bankSaja.keluar)}`}
            tone={r.bankSaja.baris ? 'amber' : 'slate'} />
          <StatCard label="Dicatat, Tak Ada di Bank" value={`${r.catatanSaja.baris} baris`}
            sub={`masuk ${rupiah(r.catatanSaja.masuk)} • keluar ${rupiah(r.catatanSaja.keluar)}`}
            tone={r.catatanSaja.baris ? 'amber' : 'slate'} />
          <StatCard label="Selisih Mutasi" value={rupiah(selisih)}
            sub={Math.abs(selisih) < 0.01 ? 'bank & catatan sama' : 'dijelaskan oleh dua kolom di kiri'}
            tone={Math.abs(selisih) < 0.01 ? 'green' : 'red'} />
        </div>

        <div className="grid gap-4 lg:grid-cols-2">
          <div className="card">
            <h2 className="card-title mb-1">Ada di Bank, Belum Ada di Catatan</h2>
            <p className="mb-3 text-xs text-slate-500">
              Biasanya biaya admin bank, bunga, atau transfer masuk yang belum diakui.
            </p>
            {!detail.bankSaja.length ? (
              <EmptyState title="Semua baris bank sudah berpasangan" subtitle="Tidak ada yang perlu ditindak di sisi ini." />
            ) : (
              <div className="table-wrap max-h-96 overflow-y-auto">
                <table className="table text-xs">
                  <thead>
                    <tr><th>Tanggal</th><th>Keterangan</th><th className="text-right">Nilai</th><th /></tr>
                  </thead>
                  <tbody>
                    {detail.bankSaja.map((b) => (
                      <tr key={b.id}>
                        <td className="tabular whitespace-nowrap">{dateID(b.tanggal)}</td>
                        <td>{b.keterangan || '—'}</td>
                        <td className={`tabular text-right font-medium ${b.masuk > 0 ? 'text-emerald-700' : 'text-rose-700'}`}>
                          {b.masuk > 0 ? '+' : '−'}{rupiah(b.masuk > 0 ? b.masuk : b.keluar)}
                        </td>
                        <td className="text-right">
                          <button
                            type="button"
                            className="btn-secondary !px-2 !py-1 !text-[11px]"
                            onClick={() => setCatat({
                              baris: b,
                              category_code: '',
                              description: b.keterangan || '',
                            })}
                          >
                            <PlusCircle size={12} /> Catat
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          <div className="card">
            <h2 className="card-title mb-1">Dicatat, Tidak Ada di Rekening Koran</h2>
            <p className="mb-3 text-xs text-slate-500">
              Biasanya transaksi yang belum masuk periode ini, atau catatan ganda.
              Pasangkan manual bila memang sepadan dengan baris bank di sebelah.
            </p>
            {!detail.catatanSaja.length ? (
              <EmptyState title="Semua catatan sudah berpasangan" subtitle="Tidak ada yang perlu ditindak di sisi ini." />
            ) : (
              <div className="table-wrap max-h-96 overflow-y-auto">
                <table className="table text-xs">
                  <thead>
                    <tr><th>Tanggal</th><th>Keterangan</th><th className="text-right">Nilai</th><th /></tr>
                  </thead>
                  <tbody>
                    {detail.catatanSaja.map((j) => (
                      <tr key={j.id}>
                        <td className="tabular whitespace-nowrap">{dateID(j.entry_date)}</td>
                        <td>
                          <span className="block">{j.description}</span>
                          <span className="block text-[11px] text-slate-400">{j.entry_no}</span>
                        </td>
                        <td className={`tabular text-right font-medium ${j.debit > 0 ? 'text-emerald-700' : 'text-rose-700'}`}>
                          {j.debit > 0 ? '+' : '−'}{rupiah(j.debit > 0 ? j.debit : j.credit)}
                        </td>
                        <td className="text-right">
                          {detail.bankSaja.length > 0 && (
                            <select
                              className="input !py-1 !text-[11px]"
                              value=""
                              onChange={(e) => e.target.value && pasang(Number(e.target.value), j.id)}
                            >
                              <option value="">Pasangkan ke…</option>
                              {detail.bankSaja.map((b) => (
                                <option key={b.id} value={b.id}>
                                  {dateID(b.tanggal)} — {rupiah(b.masuk > 0 ? b.masuk : b.keluar)}
                                </option>
                              ))}
                            </select>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>

        <div className="card mt-4">
          <h2 className="card-title mb-3">Sudah Berpasangan ({detail.cocok.length})</h2>
          {!detail.cocok.length ? (
            <p className="text-xs text-slate-500">Belum ada yang berpasangan.</p>
          ) : (
            <div className="table-wrap max-h-72 overflow-y-auto">
              <table className="table text-xs">
                <thead>
                  <tr><th>Tanggal</th><th>Keterangan Bank</th><th>Catatan</th><th className="text-right">Nilai</th><th /></tr>
                </thead>
                <tbody>
                  {detail.cocok.map((b) => (
                    <tr key={b.id}>
                      <td className="tabular whitespace-nowrap">{dateID(b.tanggal)}</td>
                      <td>{b.keterangan || '—'}</td>
                      <td>
                        <span className="block">{b.jurnal_deskripsi || '—'}</span>
                        <span className="block text-[11px] text-slate-400">
                          {b.entry_no} · {b.cara_cocok === 'OTOMATIS' ? 'cocok otomatis'
                            : b.cara_cocok === 'DICATAT' ? 'dicatat dari sini' : 'dipasangkan manual'}
                        </span>
                      </td>
                      <td className="tabular text-right">{rupiah(b.masuk > 0 ? b.masuk : b.keluar)}</td>
                      <td className="text-right">
                        <button
                          type="button" onClick={() => pasang(b.id, null)}
                          className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-rose-600"
                          aria-label="Lepas pasangan"
                        >
                          <Unlink size={13} />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* ---- Catat baris bank sebagai kas masuk/keluar ---- */}
        <Modal open={!!catat} onClose={() => setCatat(null)} title="Catat sebagai Kas">
          {catat && (
            <form onSubmit={kirimCatat} className="grid gap-3">
              <div className="rounded-xl bg-slate-50 px-3 py-2 text-sm">
                <span className="block font-medium text-slate-900">{catat.baris.keterangan || '—'}</span>
                <span className="text-xs text-slate-600">
                  {dateID(catat.baris.tanggal)} ·{' '}
                  {catat.baris.masuk > 0 ? 'masuk ' : 'keluar '}
                  {rupiah(catat.baris.masuk > 0 ? catat.baris.masuk : catat.baris.keluar)}
                </span>
              </div>

              <Field label="Kategori *" hint="Dipilih Anda, bukan ditebak sistem — hanya Anda yang tahu konteksnya">
                <select
                  className="input" required value={catat.category_code}
                  onChange={(e) => setCatat({ ...catat, category_code: e.target.value })}
                >
                  <option value="">— pilih kategori —</option>
                  {(catat.baris.masuk > 0 ? kategori.incomeCategories : kategori.expenseCategories)
                    .map((k) => <option key={k.code} value={k.code}>{k.code} — {k.name}</option>)}
                </select>
              </Field>

              <Field label="Keterangan *">
                <input
                  className="input" required maxLength={200} value={catat.description}
                  onChange={(e) => setCatat({ ...catat, description: e.target.value })}
                />
              </Field>

              <div className="flex gap-2">
                <button type="button" className="btn-secondary flex-1" onClick={() => setCatat(null)}>Batal</button>
                <button type="submit" className="btn-primary flex-1">Simpan Catatan</button>
              </div>
            </form>
          )}
        </Modal>
      </div>
    );
  }

  // ---------- Daftar ----------
  return (
    <div>
      <PageHeader
        title="Rekonsiliasi Bank"
        subtitle="Cocokkan rekening koran dengan catatan aplikasi, lalu tindak yang tersisa"
      >
        <button className="btn-primary" onClick={() => setFormImpor({ account_code: '', nama_berkas: '', teks: '' })}>
          <Upload size={16} /> Impor Rekening Koran
        </button>
      </PageHeader>

      <div className="card mb-4 flex items-start gap-2.5">
        <Info size={17} className="mt-0.5 shrink-0 text-brand-600" />
        <p className="text-xs leading-relaxed text-slate-600">
          Salin mutasi dari internet banking atau file Excel, lalu tempel di sini. Yang dibaca:
          <strong> tanggal, keterangan, nominal masuk, nominal keluar</strong> — satu baris per transaksi.
          Baris yang tidak terbaca akan dilaporkan jumlahnya, bukan dibuang diam-diam.
        </p>
      </div>

      <div className="card">
        {!daftar.rows.length ? (
          <EmptyState
            title="Belum ada rekening koran yang diimpor"
            subtitle="Mulai dari rekening yang mutasinya paling ramai — biasanya di situ selisihnya bersembunyi."
          />
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Rekening</th><th>Periode</th><th>Berkas</th>
                  <th className="text-right">Baris</th><th className="text-right">Cocok</th>
                  <th>Diimpor Oleh</th><th />
                </tr>
              </thead>
              <tbody>
                {daftar.rows.map((s) => {
                  const rek = daftar.rekening.find((k) => k.code === s.account_code);
                  const sisa = s.baris - s.cocok;
                  return (
                    <tr key={s.id}>
                      <td className="font-medium">{rek ? rek.name : s.account_code}</td>
                      <td className="tabular whitespace-nowrap">
                        {dateID(s.periode_dari)} – {dateID(s.periode_sampai)}
                      </td>
                      <td className="text-xs text-slate-500">{s.nama_berkas || '—'}</td>
                      <td className="tabular text-right">{s.baris}</td>
                      <td className="tabular text-right">
                        <span className={sisa === 0 ? 'badge-green' : 'badge-amber'}>
                          {s.cocok}/{s.baris}
                        </span>
                      </td>
                      <td className="text-xs text-slate-500">{s.user_name || '—'}</td>
                      <td className="text-right">
                        <button className="btn-secondary !px-2 !py-1 !text-xs" onClick={() => bukaDetail(s.id)}>
                          <Link2 size={13} /> Buka
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* ---- Impor ---- */}
      <Modal open={!!formImpor} onClose={() => setFormImpor(null)} title="Impor Rekening Koran" wide>
        {formImpor && (
          <form onSubmit={kirimImpor} className="grid gap-3">
            <Field label="Rekening *">
              <select
                className="input" required value={formImpor.account_code}
                onChange={(e) => setFormImpor({ ...formImpor, account_code: e.target.value })}
              >
                <option value="">— pilih rekening —</option>
                {daftar.rekening.map((k) => (
                  <option key={k.code} value={k.code}>{k.code} — {k.name}</option>
                ))}
              </select>
            </Field>

            <Field label="Nama Berkas / Keterangan" hint="mis. BCA Yudhi September 2026">
              <input
                className="input" maxLength={150} value={formImpor.nama_berkas}
                onChange={(e) => setFormImpor({ ...formImpor, nama_berkas: e.target.value })}
              />
            </Field>

            <Field
              label="Mutasi Rekening *"
              hint="Satu baris per transaksi: tanggal, keterangan, masuk, keluar — dipisah koma atau tab"
            >
              <textarea
                className="input font-mono text-xs" rows={12} required
                placeholder={'2026-09-01,TRANSFER MASUK ANDI,750000,0\n2026-09-02,BIAYA ADM,0,17500'}
                value={formImpor.teks}
                onChange={(e) => setFormImpor({ ...formImpor, teks: e.target.value })}
              />
            </Field>

            {formImpor.teks.trim() && (() => {
              const { rows, gagal } = bacaTabel(formImpor.teks);
              return (
                <p className="rounded-xl bg-slate-50 px-3 py-2 text-xs text-slate-600">
                  Terbaca <strong>{rows.length} baris</strong>
                  {gagal.length > 0 && <> · {gagal.length} baris dilewati (judul kolom atau format lain)</>}
                </p>
              );
            })()}

            <div className="flex gap-2">
              <button type="button" className="btn-secondary flex-1" onClick={() => setFormImpor(null)}>Batal</button>
              <button type="submit" className="btn-primary flex-1">
                <Upload size={16} /> Impor & Cocokkan
              </button>
            </div>
          </form>
        )}
      </Modal>
    </div>
  );
}
