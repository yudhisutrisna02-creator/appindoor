import { useEffect, useState, useCallback } from 'react';
import { HandCoins, Receipt, Wallet, Eye } from 'lucide-react';
import { api } from '../lib/api';
import { PageHeader, StatCard, Spinner, EmptyState, Modal, useToast, Field, TombolEkspor } from '../components/ui';
import { rupiah, today, dateID } from '../lib/format';

/**
 * Saldo di sini dihitung langsung dari buku besar (baris jurnal yang menyentuh
 * akun Piutang/Utang dan menyimpan id mitra), bukan dari tabel saldo terpisah.
 * Jadi angkanya tidak mungkin berbeda dengan Neraca.
 */
export default function UtangPiutang() {
  const toast = useToast();
  const [tab, setTab] = useState('piutang');
  const [data, setData] = useState(null);
  const [options, setOptions] = useState(null);
  const [loading, setLoading] = useState(true);
  const [bayar, setBayar] = useState(null);
  const [detail, setDetail] = useState(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setData(await api.get('/api/cashflow/ar-ap'));
    } catch (err) {
      toast.error(err.message);
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    api.get('/api/cashflow/options').then(setOptions).catch(() => {});
  }, []);

  function openBayar(row) {
    setBayar({
      partner_id: row.id,
      nama: row.name,
      direction: tab === 'piutang' ? 'RECEIVE' : 'PAY',
      sisa: tab === 'piutang' ? row.piutang : row.utang,
      entry_date: today(),
      amount: tab === 'piutang' ? row.piutang : row.utang,
      cash_code: options?.cashAccounts?.[0]?.code || '',
      note: '',
    });
  }

  async function submit(e) {
    e.preventDefault();
    setSaving(true);
    try {
      const res = await api.post('/api/cashflow/settlements', {
        entry_date: bayar.entry_date,
        partner_id: bayar.partner_id,
        direction: bayar.direction,
        amount: Number(bayar.amount),
        cash_code: bayar.cash_code,
        note: bayar.note || null,
      });
      toast.success(`${res.message} — sisa ${rupiah(res.sisa)}`);
      setBayar(null);
      load();
    } catch (err) {
      toast.error(err.message);
    } finally {
      setSaving(false);
    }
  }

  async function lihatRiwayat(row) {
    try {
      setDetail(await api.get(`/api/partners/${row.id}/ledger`));
    } catch (err) {
      toast.error(err.message);
    }
  }

  const rows = data ? (tab === 'piutang' ? data.piutang : data.utang) : [];

  return (
    <div>
      <PageHeader
        title="Utang & Piutang"
        subtitle="Siapa berutang kepada Anda, dan kepada siapa Anda berutang"
      >
        <TombolEkspor path="/api/cashflow/ar-ap" nama="utang-piutang" />
      </PageHeader>

      {loading || !data ? (
        <Spinner />
      ) : (
        <>
          <div className="mb-4 grid grid-cols-1 gap-3 sm:grid-cols-3">
            <StatCard
              label="Total Piutang" value={rupiah(data.totalPiutang)}
              sub={`${data.piutang.length} pelanggan belum bayar`}
              icon={Receipt} tone="green"
            />
            <StatCard
              label="Total Utang" value={rupiah(data.totalUtang)}
              sub={`${data.utang.length} supplier belum dibayar`}
              icon={HandCoins} tone="amber"
            />
            <StatCard
              label="Posisi Bersih" value={rupiah(data.totalPiutang - data.totalUtang)}
              sub={data.totalPiutang >= data.totalUtang ? 'Lebih banyak menerima' : 'Lebih banyak membayar'}
              icon={Wallet} tone={data.totalPiutang >= data.totalUtang ? 'brand' : 'red'}
            />
          </div>

          <div className="mb-4 flex gap-1.5 rounded-xl bg-surface p-1.5 shadow-sm ring-1 ring-slate-200/70">
            {[
              { key: 'piutang', label: `Piutang (${data.piutang.length})`, icon: Receipt },
              { key: 'utang', label: `Utang (${data.utang.length})`, icon: HandCoins },
            ].map((t) => (
              <button
                key={t.key} onClick={() => setTab(t.key)}
                className={`flex flex-1 items-center justify-center gap-2 rounded-lg px-3 py-2 text-sm font-semibold transition ${
                  tab === t.key ? 'bg-brand-600 text-white' : 'text-slate-600 hover:bg-slate-100'
                }`}
              >
                <t.icon size={16} /> {t.label}
              </button>
            ))}
          </div>

          <div className="card">
            {rows.length === 0 ? (
              <EmptyState
                message={tab === 'piutang' ? 'Tidak ada piutang' : 'Tidak ada utang'}
                hint={
                  tab === 'piutang'
                    ? 'Piutang muncul saat order penjualan disimpan dengan status "Belum cair"'
                    : 'Utang muncul saat stok masuk dicatat dengan sumber dana "Utang Supplier"'
                }
              />
            ) : (
              <div className="table-wrap">
                <table className="table">
                  <thead>
                    <tr>
                      <th>Mitra</th><th>Kontak</th><th>Tempo</th>
                      <th>Transaksi Terakhir</th>
                      <th>{tab === 'piutang' ? 'Piutang' : 'Utang'}</th>
                      <th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r) => (
                      <tr key={r.id}>
                        <td>
                          <p className="font-medium text-slate-900">{r.name}</p>
                          {r.code && <p className="text-xs text-slate-400">{r.code}</p>}
                        </td>
                        <td className="text-xs text-slate-500">{r.phone || '-'}</td>
                        <td className="tabular text-xs">{r.term_days ? `${r.term_days} hari` : '-'}</td>
                        <td className="tabular text-xs">{dateID(r.transaksi_terakhir)}</td>
                        <td className={`tabular font-bold ${tab === 'piutang' ? 'text-emerald-600' : 'text-amber-700'}`}>
                          {rupiah(tab === 'piutang' ? r.piutang : r.utang)}
                        </td>
                        <td>
                          <div className="flex gap-1">
                            <button className="btn-ghost !px-2 !py-1" onClick={() => lihatRiwayat(r)} aria-label="Riwayat">
                              <Eye size={14} />
                            </button>
                            <button className="btn-primary !px-3 !py-1.5 text-xs" onClick={() => openBayar(r)}>
                              {tab === 'piutang' ? 'Terima' : 'Bayar'}
                            </button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr className="border-t-2 border-slate-200 bg-slate-50 font-bold">
                      <td colSpan={4} className="px-3 py-3 text-right">TOTAL</td>
                      <td className="tabular px-3 py-3">
                        {rupiah(tab === 'piutang' ? data.totalPiutang : data.totalUtang)}
                      </td>
                      <td />
                    </tr>
                  </tfoot>
                </table>
              </div>
            )}
          </div>
        </>
      )}

      {/* ---------- FORM PELUNASAN ---------- */}
      <Modal
        open={!!bayar}
        onClose={() => setBayar(null)}
        title={bayar?.direction === 'RECEIVE' ? 'Terima Pelunasan Piutang' : 'Bayar Utang'}
      >
        {bayar && (
          <form onSubmit={submit} className="grid gap-3 sm:grid-cols-2">
            <div className="rounded-xl bg-slate-50 p-3 text-sm sm:col-span-2">
              <p className="font-semibold text-slate-900">{bayar.nama}</p>
              <p className="text-xs text-slate-500">
                Sisa {bayar.direction === 'RECEIVE' ? 'piutang' : 'utang'}: <strong>{rupiah(bayar.sisa)}</strong>
              </p>
            </div>

            <Field label="Tanggal *">
              <input
                type="date" className="input" required value={bayar.entry_date}
                onChange={(e) => setBayar({ ...bayar, entry_date: e.target.value })}
              />
            </Field>

            <Field label="Nominal (Rp) *" hint="Boleh sebagian, tidak harus lunas">
              <input
                type="number" min="0" max={bayar.sisa} step="any" className="input" required
                value={bayar.amount}
                onChange={(e) => setBayar({ ...bayar, amount: e.target.value })}
              />
            </Field>

            <Field
              label={bayar.direction === 'RECEIVE' ? 'Uang masuk ke *' : 'Uang diambil dari *'}
              className="sm:col-span-2"
            >
              <select
                className="input" required value={bayar.cash_code}
                onChange={(e) => setBayar({ ...bayar, cash_code: e.target.value })}
              >
                {(options?.cashAccounts || []).map((k) => (
                  <option key={k.code} value={k.code}>{k.code} — {k.name}</option>
                ))}
              </select>
            </Field>

            <Field label="Catatan" className="sm:col-span-2">
              <input
                className="input" maxLength={200} value={bayar.note}
                onChange={(e) => setBayar({ ...bayar, note: e.target.value })}
              />
            </Field>

            {Number(bayar.amount) > 0 && (
              <p className="rounded-xl bg-brand-50 p-3 text-xs text-brand-800 sm:col-span-2">
                Sisa setelah pencatatan ini: <strong>{rupiah(bayar.sisa - Number(bayar.amount))}</strong>
              </p>
            )}

            <div className="flex gap-2 sm:col-span-2">
              <button type="button" className="btn-secondary flex-1" onClick={() => setBayar(null)}>Batal</button>
              <button type="submit" className="btn-primary flex-1" disabled={saving}>
                {saving ? 'Menyimpan...' : 'Simpan'}
              </button>
            </div>
          </form>
        )}
      </Modal>

      {/* ---------- RIWAYAT MITRA ---------- */}
      <Modal open={!!detail} onClose={() => setDetail(null)} title={`Riwayat — ${detail?.partner.name || ''}`} wide>
        {detail && (
          <div>
            <div className="mb-3 grid grid-cols-2 gap-3">
              <StatCard label="Piutang" value={rupiah(detail.receivable)} tone="green" />
              <StatCard label="Utang" value={rupiah(detail.payable)} tone="amber" />
            </div>
            {detail.entries.length === 0 ? (
              <EmptyState message="Belum ada transaksi utang/piutang" />
            ) : (
              <div className="table-wrap">
                <table className="table">
                  <thead>
                    <tr><th>Tanggal</th><th>No. Jurnal</th><th>Keterangan</th><th>Akun</th><th>Debit</th><th>Kredit</th></tr>
                  </thead>
                  <tbody>
                    {detail.entries.map((e, i) => (
                      <tr key={i}>
                        <td className="tabular">{dateID(e.entry_date)}</td>
                        <td className="font-mono text-xs">{e.entry_no}</td>
                        <td className="max-w-[240px] truncate">{e.memo || e.description}</td>
                        <td className="text-xs text-slate-500">{e.code}</td>
                        <td className="tabular">{e.debit ? rupiah(e.debit) : '-'}</td>
                        <td className="tabular">{e.credit ? rupiah(e.credit) : '-'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}
      </Modal>
    </div>
  );
}
