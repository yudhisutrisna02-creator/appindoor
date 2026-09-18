import { useEffect, useState } from 'react';
import { Scale, Loader2 } from 'lucide-react';
import { api } from '../lib/api';
import { Modal, Field, useToast } from './ui';
import { rupiah, dateID } from '../lib/format';

/**
 * Menyetel saldo tiap rekening pada satu tanggal menjadi angka yang sebenarnya.
 *
 * Yang diketik adalah SALDO AKHIR menurut rekening koran atau hitungan uang di
 * laci — bukan selisihnya. Selisih terhadap catatan aplikasi dihitung sendiri
 * dan dibukukan sebagai Saldo Awal Kas & Bank, sehingga bulan berikutnya
 * berangkat dari posisi yang benar tanpa perlu mengarang transaksi.
 */
export default function SetelSaldo({ open, onClose, onSelesai, tanggalAwal }) {
  const toast = useToast();
  const [tanggal, setTanggal] = useState(tanggalAwal);
  const [data, setData] = useState(null);
  const [isi, setIsi] = useState({});
  const [catatan, setCatatan] = useState('');
  const [menyimpan, setMenyimpan] = useState(false);

  useEffect(() => {
    if (!open) return;
    setData(null);
    setIsi({});
    api.get('/api/cashflow/saldo-awal', { tanggal })
      .then(setData)
      .catch((err) => toast.error(err.message));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, tanggal]);

  async function simpan(e) {
    e.preventDefault();
    const baris = Object.entries(isi)
      .filter(([, v]) => v !== '' && v !== null && !Number.isNaN(Number(v)))
      .map(([code, v]) => ({ code, saldo: Number(v) }));
    if (!baris.length) return toast.error('Isi dulu saldo minimal satu rekening');

    setMenyimpan(true);
    try {
      const res = await api.post('/api/cashflow/saldo-awal', { tanggal, baris, catatan: catatan || null });
      toast.success(res.message);
      onClose();
      onSelesai?.();
    } catch (err) {
      toast.error(err.message);
    } finally {
      setMenyimpan(false);
    }
  }

  // Total dihitung dari rekening yang DIISI saja, ditambah saldo aplikasi untuk
  // rekening yang dibiarkan kosong — supaya angkanya sebanding.
  const totalAplikasi = (data?.rows || []).reduce((n, a) => n + a.saldo, 0);
  const totalSebenarnya = (data?.rows || []).reduce((n, a) => {
    const v = isi[a.code];
    return n + (v !== undefined && v !== '' && !Number.isNaN(Number(v)) ? Number(v) : a.saldo);
  }, 0);
  const totalSelisih = totalSebenarnya - totalAplikasi;

  return (
    <Modal open={open} onClose={onClose} title="Setel Saldo Rekening" wide>
      <form onSubmit={simpan} className="grid gap-3">
        <p className="rounded-xl bg-slate-50 px-3 py-2 text-xs leading-relaxed text-slate-600">
          Isi <strong>saldo sebenarnya</strong> tiap rekening pada tanggal ini — sesuai rekening koran atau
          hitungan uang di laci. Selisihnya terhadap catatan aplikasi dibukukan sebagai{' '}
          <strong>Saldo Awal Kas &amp; Bank</strong>. Rekening yang dikosongkan tidak disentuh.
        </p>

        <Field label="Saldo per tanggal *" className="w-52">
          <input type="date" className="input" required value={tanggal} onChange={(e) => setTanggal(e.target.value)} />
        </Field>

        {!data ? (
          <p className="py-6 text-center text-sm text-slate-500">Memuat saldo…</p>
        ) : (
          <div className="table-wrap">
            <table className="table text-sm">
              <thead>
                <tr>
                  <th>Rekening</th>
                  <th className="text-right">Menurut aplikasi</th>
                  <th className="text-right">Saldo sebenarnya</th>
                  <th className="text-right">Selisih</th>
                </tr>
              </thead>
              <tbody>
                {data.rows.map((a) => {
                  const diisi = isi[a.code] !== undefined && isi[a.code] !== '';
                  const selisih = diisi ? Number(isi[a.code]) - a.saldo : 0;
                  return (
                    <tr key={a.code}>
                      <td>
                        <span className="font-mono text-xs text-slate-500">{a.code}</span> {a.name}
                      </td>
                      <td className={`tabular text-right ${a.saldo < 0 ? 'text-rose-600' : 'text-slate-600'}`}>
                        {rupiah(a.saldo)}
                      </td>
                      <td className="text-right">
                        <input
                          type="number" step="any" className="input !py-1.5 text-right"
                          placeholder="biarkan kosong"
                          value={isi[a.code] ?? ''}
                          onChange={(e) => setIsi({ ...isi, [a.code]: e.target.value })}
                        />
                      </td>
                      <td className={`tabular text-right text-xs ${
                        !diisi ? 'text-slate-400' : selisih < 0 ? 'text-rose-600' : 'text-emerald-700'
                      }`}>
                        {diisi ? `${selisih > 0 ? '+' : ''}${rupiah(selisih)}` : '—'}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
              {/* Saldo akhir sebuah usaha jarang berada di satu rekening;
                  totalnya yang dicocokkan dengan hitungan di luar aplikasi. */}
              <tfoot>
                <tr className="border-t-2 border-slate-200 bg-slate-50 font-bold">
                  <td className="px-3 py-2.5">TOTAL SEMUA REKENING</td>
                  <td className="tabular px-3 py-2.5 text-right">{rupiah(totalAplikasi)}</td>
                  <td className="tabular px-3 py-2.5 text-right">{rupiah(totalSebenarnya)}</td>
                  <td className={`tabular px-3 py-2.5 text-right ${totalSelisih < 0 ? 'text-rose-600' : 'text-emerald-700'}`}>
                    {totalSelisih > 0 ? '+' : ''}{rupiah(totalSelisih)}
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>
        )}

        <Field label="Catatan" hint={`Muncul pada jurnalnya, mis. "posisi ${dateID(tanggal)} menurut rekening koran"`}>
          <input className="input" maxLength={200} value={catatan} onChange={(e) => setCatatan(e.target.value)} />
        </Field>

        <div className="flex gap-2">
          <button type="button" className="btn-secondary flex-1" onClick={onClose}>Batal</button>
          <button type="submit" className="btn-primary flex-1" disabled={menyimpan || !data}>
            {menyimpan ? <Loader2 size={16} className="animate-spin" /> : <Scale size={16} />}
            {menyimpan ? 'Menyimpan...' : 'Setel Saldo'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
