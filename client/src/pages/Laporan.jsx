import { useEffect, useState, useCallback, useMemo } from 'react';
import { Printer, FileText, FileSpreadsheet, FileDown } from 'lucide-react';
import { api } from '../lib/api';
import {
  PageHeader, Spinner, EmptyState, useToast, Field,
  DateRangeFilter, defaultRange, KotakCari, saringLokal, TombolCetak,
} from '../components/ui';
import { rupiah, dateID, today } from '../lib/format';

/**
 * Halaman laporan resmi.
 *
 * Satu komponen untuk keenam laporan. Isinya memang berbeda-beda, tetapi
 * kerangkanya sama persis: penyaring periode, pratinjau, lalu unduhan. Menulis
 * enam halaman yang hampir sama berarti enam tempat yang bisa berbeda diam-diam
 * ketika salah satunya diperbaiki.
 *
 * Pratinjaunya mengambil data yang sama dengan yang dicetak, jadi apa yang
 * terlihat di layar memang itu yang keluar di kertas.
 */
export default function Laporan({ jenis }) {
  const toast = useToast();
  const [range, setRange] = useState(defaultRange);
  const [asOf, setAsOf] = useState(today());
  const [kertas, setKertas] = useState('');
  const [q, setQ] = useState('');
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);

  // Laporan persediaan adalah potret satu tanggal, bukan rentang. Memaksakan
  // rentang pada laporan posisi hanya membuat orang bertanya-tanya tanggal mana
  // yang sebenarnya dipakai.
  const pakaiTanggal = jenis === 'persediaan';
  const params = useMemo(
    () => (pakaiTanggal ? { asOf } : { from: range.from, to: range.to }),
    [pakaiTanggal, asOf, range.from, range.to]
  );

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setData(await api.get(`/api/laporan/${jenis}`, params));
    } catch (err) {
      toast.error(err.message);
      setData(null);
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jenis, params]);

  useEffect(() => { load(); }, [load]);

  async function unduh(bentuk) {
    try {
      await api.download(
        `/api/laporan/${jenis}/export/${bentuk}`,
        { ...params, ...(kertas ? { kertas } : {}) },
        `laporan-${jenis}.${bentuk === 'excel' ? 'xlsx' : bentuk}`
      );
    } catch (err) {
      toast.error(err.message);
    }
  }

  if (loading) return <Spinner label="Menyusun laporan..." />;
  if (!data) return <EmptyState message="Laporan tidak dapat dimuat" />;

  const kunci = data.kolom.map((k) => k.key);
  const tampil = saringLokal(data.rows, q, (r) => kunci.map((k) => r[k]));

  const nilai = (r, k) => {
    const v = r[k.key];
    if (v === null || v === undefined || v === '') return '—';
    if (k.money) return rupiah(v);
    if (k.pct) return `${Number(v).toFixed(2)}%`;
    if (typeof v === 'number') return v.toLocaleString('id-ID');
    return String(v);
  };

  return (
    <div>
      <PageHeader title={data.judul} subtitle={data.subjudul}>
        <TombolCetak
          path={`/api/laporan/${jenis}/export/pdf`}
          params={{ ...params, ...(kertas ? { kertas } : {}) }}
          label="Cetak" icon={Printer}
        />
        <button className="btn-secondary" onClick={() => unduh('pdf')}>
          <FileText size={16} /> PDF
        </button>
        <button className="btn-secondary" onClick={() => unduh('excel')}>
          <FileSpreadsheet size={16} /> Excel
        </button>
        <button className="btn-secondary" onClick={() => unduh('csv')}>
          <FileDown size={16} /> CSV
        </button>
      </PageHeader>

      {pakaiTanggal ? (
        <div className="card mb-4 flex flex-col gap-3 sm:flex-row sm:items-end">
          <Field label="Posisi per Tanggal" className="sm:flex-1">
            <input type="date" className="input" value={asOf} onChange={(e) => setAsOf(e.target.value)} />
          </Field>
          <div className="sm:flex-[2]">
            <label className="label">Cari</label>
            <KotakCari nilai={q} onCari={setQ} placeholder="Cari di dalam laporan..." />
          </div>
          <Field label="Kertas" className="sm:w-40">
            <select className="input" value={kertas} onChange={(e) => setKertas(e.target.value)}>
              <option value="">{data.kertas} (bawaan)</option>
              <option value="A4">A4</option>
              <option value="FOLIO">Folio / F4</option>
            </select>
          </Field>
        </div>
      ) : (
        <DateRangeFilter range={range} onChange={setRange}>
          <div className="flex-[2]">
            <label className="label">Cari</label>
            <KotakCari nilai={q} onCari={setQ} placeholder="Cari di dalam laporan..." />
          </div>
          <div className="w-full sm:w-40">
            <label className="label">Kertas</label>
            <select className="input" value={kertas} onChange={(e) => setKertas(e.target.value)}>
              <option value="">{data.kertas} (bawaan)</option>
              <option value="A4">A4</option>
              <option value="FOLIO">Folio / F4</option>
            </select>
          </div>
        </DateRangeFilter>
      )}

      {data.meta && data.meta.length > 0 && (
        <div className="card mb-4">
          <h2 className="card-title mb-3">Ringkasan</h2>
          <dl className="grid gap-x-6 gap-y-2 sm:grid-cols-2 lg:grid-cols-3">
            {data.meta.map(([label, v]) => (
              <div key={label} className="flex justify-between gap-3 border-b border-slate-100 pb-1 text-sm">
                <dt className="text-slate-600">{label}</dt>
                <dd className="tabular font-semibold text-slate-900">
                  {typeof v === 'number'
                    ? (/rp|nilai|total|laba|piutang|utang|biaya|pendapatan|hpp|debit|kredit|selisih/i.test(label)
                      ? rupiah(v) : v.toLocaleString('id-ID'))
                    : String(v)}
                </dd>
              </div>
            ))}
          </dl>
        </div>
      )}

      <div className="card">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <h2 className="card-title">
            {tampil.length} baris{q && ` dari ${data.rows.length}`}
          </h2>
          <p className="text-xs text-slate-500">
            Pratinjau ini isinya sama dengan berkas yang akan dicetak
          </p>
        </div>

        {tampil.length === 0 ? (
          <EmptyState message="Tidak ada data pada periode ini" />
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  {data.kolom.map((k) => (
                    <th key={k.key} className={k.money || k.pct || k.angka ? 'text-right' : ''}>
                      {k.header}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {tampil.map((r, i) => (
                  <tr key={i}>
                    {data.kolom.map((k) => (
                      <td key={k.key} className={k.money || k.pct || k.angka ? 'tabular text-right' : ''}>
                        {nilai(r, k)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
              {data.ringkasBawah && (
                <tfoot>
                  <tr className="bg-slate-100 font-semibold">
                    {data.kolom.map((k) => (
                      <td key={k.key} className={k.money || k.pct || k.angka ? 'tabular text-right' : ''}>
                        {data.ringkasBawah[k.key] === undefined ? '' : nilai(data.ringkasBawah, k)}
                      </td>
                    ))}
                  </tr>
                </tfoot>
              )}
            </table>
          </div>
        )}

        {data.catatan && (
          <p className="mt-3 rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-600">{data.catatan}</p>
        )}

        <p className="mt-3 text-xs leading-relaxed text-slate-500">
          Berkas PDF dicetak berkop perusahaan, bernomor halaman, dan diakhiri blok tanda tangan
          digital berQR — sama seperti slip gaji dan nota supplier. Excel dan CSV tidak
          ditandatangani karena keduanya memang bahan untuk diolah lagi, bukan lembar yang
          diserahkan ke orang.
        </p>
      </div>
    </div>
  );
}
