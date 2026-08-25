import { useEffect, useState, useCallback } from 'react';
import { FileSpreadsheet, FileText, Users, Clock, MapPin, Image as ImageIcon, CalendarPlus, Pencil } from 'lucide-react';
import { api } from '../lib/api';
import { PageHeader, StatCard, Spinner, EmptyState, DateRangeFilter, defaultRange, useToast, Modal, Field } from '../components/ui';
import { timeID, today, WORK_TYPE_LABEL, STATUS_LABEL } from '../lib/format';
import { useAuth } from '../lib/auth';

const BADGE = { ONTIME: 'badge-green', LATE: 'badge-red', LEAVE: 'badge-amber', ABSENT: 'badge-slate' };

export default function RekapAbsensi() {
  const toast = useToast();
  const { canManage } = useAuth();
  const [range, setRange] = useState(defaultRange);
  const [filters, setFilters] = useState({ workType: '', status: '', userId: '' });
  const [data, setData] = useState(null);
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [preview, setPreview] = useState(null);
  const [leaveForm, setLeaveForm] = useState(null);
  const [koreksi, setKoreksi] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setData(await api.get('/api/attendance', { ...range, ...filters }));
    } catch (err) {
      toast.error(err.message);
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [range, filters]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    if (!canManage) return;
    api.get('/api/admin/users').then((d) => setUsers(d.users)).catch(() => {});
  }, [canManage]);

  async function download(kind) {
    try {
      await api.download(`/api/attendance/export/${kind}`, { ...range, ...filters }, `rekap-absensi.${kind === 'excel' ? 'xlsx' : 'pdf'}`);
      toast.success(`Rekap ${kind.toUpperCase()} berhasil diunduh`);
    } catch (err) {
      toast.error(err.message);
    }
  }

  return (
    <div>
      <PageHeader title="Rekap Absensi" subtitle="Riwayat kehadiran, keterlambatan, dan bukti lokasi">
        <button className="btn-secondary" onClick={() => download('excel')}>
          <FileSpreadsheet size={16} /> Excel
        </button>
        <button className="btn-secondary" onClick={() => download('pdf')}>
          <FileText size={16} /> PDF
        </button>
        {canManage && (
          <button
            className="btn-primary"
            onClick={() => setLeaveForm({ user_id: '', work_date: today(), status: 'LEAVE', notes: '' })}
          >
            <CalendarPlus size={16} /> Catat Izin/Cuti
          </button>
        )}
      </PageHeader>

      <DateRangeFilter range={range} onChange={setRange}>
        <div className="flex-1">
          <label className="label">Tipe</label>
          <select className="input" value={filters.workType} onChange={(e) => setFilters({ ...filters, workType: e.target.value })}>
            <option value="">Semua Tipe</option>
            {Object.entries(WORK_TYPE_LABEL).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
        </div>
        <div className="flex-1">
          <label className="label">Status</label>
          <select className="input" value={filters.status} onChange={(e) => setFilters({ ...filters, status: e.target.value })}>
            <option value="">Semua Status</option>
            {Object.entries(STATUS_LABEL).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
        </div>
        {canManage && (
          <div className="flex-1">
            <label className="label">Karyawan</label>
            <select className="input" value={filters.userId} onChange={(e) => setFilters({ ...filters, userId: e.target.value })}>
              <option value="">Semua Karyawan</option>
              {users.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
            </select>
          </div>
        )}
      </DateRangeFilter>

      {loading ? (
        <Spinner />
      ) : (
        <>
          <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
            <StatCard label="Total Kehadiran" value={data.summary.total} icon={Users} />
            <StatCard label="Tepat Waktu" value={data.summary.ontime} icon={Clock} tone="green" />
            <StatCard label="Terlambat" value={data.summary.late} sub={`${data.summary.totalLateMinutes} menit total`} icon={Clock} tone="red" />
            <StatCard
              label="Rata-rata Jam Kerja"
              value={`${Math.floor(data.summary.avgWorkMinutes / 60)}j ${data.summary.avgWorkMinutes % 60}m`}
              sub={`WFO ${data.summary.byType.WFO} • WFH ${data.summary.byType.WFH} • Dinas ${data.summary.byType.DINAS_LUAR}`}
              icon={MapPin} tone="slate"
            />
          </div>

          <div className="card">
            {data.rows.length === 0 ? (
              <EmptyState message="Belum ada data presensi pada rentang ini" />
            ) : (
              <div className="table-wrap">
                <table className="table">
                  <thead>
                    <tr>
                      <th>Tanggal</th><th>Nama</th><th>Tipe</th><th>Masuk</th><th>Pulang</th>
                      <th>Durasi</th><th>Status</th><th>Telat</th><th>Lokasi</th><th>Bukti</th>{canManage && <th></th>}
                    </tr>
                  </thead>
                  <tbody>
                    {data.rows.map((r) => (
                      <tr key={r.id}>
                        <td className="tabular">{r.work_date}</td>
                        <td>
                          <p className="font-medium text-slate-900">{r.user_name}</p>
                          <p className="text-xs text-slate-400">{r.position || '-'}</p>
                        </td>
                        <td className="text-xs">
                          {r.status === 'LEAVE' || r.status === 'ABSENT'
                            ? <span className="text-slate-400">—</span>
                            : WORK_TYPE_LABEL[r.work_type]}
                        </td>
                        <td className="tabular">{timeID(r.check_in_at)}</td>
                        <td className="tabular">{timeID(r.check_out_at)}</td>
                        <td className="tabular">{r.work_minutes ? `${Math.floor(r.work_minutes / 60)}j ${r.work_minutes % 60}m` : '-'}</td>
                        <td><span className={BADGE[r.status]}>{STATUS_LABEL[r.status]}</span></td>
                        <td className="tabular">{r.late_minutes ? `${r.late_minutes} m` : '-'}</td>
                        <td className="text-xs">
                          {/* Jarak ke kantor hanya bermakna untuk WFO; WFH & Dinas
                              cukup menampilkan tipe kerjanya. */}
                          {r.work_type === 'WFO' ? (
                            <>
                              {r.office_name || 'Kantor tidak dikenal'}
                              {r.in_distance_m != null && (
                                <span className={r.in_inside_geofence ? 'text-emerald-600' : 'text-amber-600'}>
                                  {' '}({r.in_distance_m} m)
                                </span>
                              )}
                            </>
                          ) : (
                            // Untuk WFH & Dinas Luar, alamat yang direkam lebih berguna
                            // daripada jarak ke kantor.
                            <span className="text-slate-500">{r.in_address || 'Di luar kantor'}</span>
                          )}
                        </td>
                        <td>
                          {r.in_photo ? (
                            <button className="btn-ghost !px-2 !py-1 text-xs" onClick={() => setPreview(r)}>
                              <ImageIcon size={14} /> Lihat
                            </button>
                          ) : (
                            <span className="text-xs text-slate-400">—</span>
                          )}
                        </td>
                        {canManage && (
                          <td>
                            <button
                              className="btn-ghost !px-2 !py-1"
                              onClick={() => setKoreksi({ id: r.id, nama: r.user_name, tanggal: r.work_date, status: r.status, late_minutes: r.late_minutes, notes: r.notes || '' })}
                              aria-label="Koreksi"
                            >
                              <Pencil size={14} />
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
        </>
      )}

      <Modal open={!!preview} onClose={() => setPreview(null)} title={`Bukti Presensi — ${preview?.user_name || ''}`} wide>
        {preview && (
          <div className="grid gap-4 sm:grid-cols-2">
            {[
              { label: `Check In • ${timeID(preview.check_in_at)}`, photo: preview.in_photo, lat: preview.in_lat, lng: preview.in_lng, acc: preview.in_accuracy_m },
              { label: `Check Out • ${timeID(preview.check_out_at)}`, photo: preview.out_photo, lat: preview.out_lat, lng: preview.out_lng, acc: preview.out_accuracy_m },
            ].map((side) => (
              <div key={side.label}>
                <p className="label">{side.label}</p>
                {side.photo ? (
                  <AuthImage file={side.photo} alt={side.label} />
                ) : (
                  <div className="grid aspect-[4/3] place-items-center rounded-xl bg-slate-100 text-xs text-slate-400">
                    Tidak ada foto
                  </div>
                )}
                {side.lat != null && (
                  <p className="tabular mt-2 text-xs text-slate-500">
                    {side.lat.toFixed(6)}, {side.lng.toFixed(6)} • ±{Math.round(side.acc || 0)} m
                    {' • '}
                    <a
                      className="text-brand-600 underline"
                      href={`https://www.google.com/maps?q=${side.lat},${side.lng}`}
                      target="_blank" rel="noreferrer"
                    >
                      buka peta
                    </a>
                  </p>
                )}
              </div>
            ))}
            {preview.notes && (
              <p className="text-sm text-slate-600 sm:col-span-2">
                <span className="font-semibold">Catatan:</span> {preview.notes}
              </p>
            )}
          </div>
        )}
      </Modal>
      {/* ---------- CATAT IZIN / CUTI ---------- */}
      <Modal open={!!leaveForm} onClose={() => setLeaveForm(null)} title="Catat Izin, Cuti, atau Alpa">
        {leaveForm && (
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              try {
                const res = await api.post('/api/attendance/leave', {
                  user_id: Number(leaveForm.user_id),
                  work_date: leaveForm.work_date,
                  status: leaveForm.status,
                  notes: leaveForm.notes || null,
                });
                toast.success(res.message);
                setLeaveForm(null);
                load();
              } catch (err) {
                toast.error(err.message);
              }
            }}
            className="grid gap-3 sm:grid-cols-2"
          >
            <Field label="Karyawan *" className="sm:col-span-2">
              <select
                className="input" required value={leaveForm.user_id}
                onChange={(e) => setLeaveForm({ ...leaveForm, user_id: e.target.value })}
              >
                <option value="">— pilih karyawan —</option>
                {users.filter((u) => u.active).map((u) => (
                  <option key={u.id} value={u.id}>{u.name}{u.position ? ` — ${u.position}` : ''}</option>
                ))}
              </select>
            </Field>

            <Field label="Tanggal *">
              <input
                type="date" className="input" required value={leaveForm.work_date}
                onChange={(e) => setLeaveForm({ ...leaveForm, work_date: e.target.value })}
              />
            </Field>

            <Field label="Status *">
              <select
                className="input" value={leaveForm.status}
                onChange={(e) => setLeaveForm({ ...leaveForm, status: e.target.value })}
              >
                <option value="LEAVE">Izin / Cuti</option>
                <option value="ABSENT">Alpa (tanpa keterangan)</option>
              </select>
            </Field>

            <Field label="Keterangan" hint="mis. cuti tahunan, sakit, izin keluarga" className="sm:col-span-2">
              <input
                className="input" maxLength={500} value={leaveForm.notes}
                onChange={(e) => setLeaveForm({ ...leaveForm, notes: e.target.value })}
              />
            </Field>

            <p className="rounded-xl bg-brand-50 p-3 text-xs text-brand-800 sm:col-span-2">
              Baris presensi tetap dibuat supaya karyawan yang berhalangan tidak hilang dari rekap.
              Karyawan yang sudah terlanjur check-in tidak bisa ditandai izin — gunakan tombol koreksi
              pada barisnya.
            </p>

            <div className="flex gap-2 sm:col-span-2">
              <button type="button" className="btn-secondary flex-1" onClick={() => setLeaveForm(null)}>Batal</button>
              <button type="submit" className="btn-primary flex-1">Simpan</button>
            </div>
          </form>
        )}
      </Modal>

      {/* ---------- KOREKSI PRESENSI ---------- */}
      <Modal open={!!koreksi} onClose={() => setKoreksi(null)} title="Koreksi Data Presensi">
        {koreksi && (
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              try {
                await api.patch(`/api/attendance/${koreksi.id}`, {
                  status: koreksi.status,
                  late_minutes: Number(koreksi.late_minutes) || 0,
                  notes: koreksi.notes || null,
                });
                toast.success('Data presensi dikoreksi');
                setKoreksi(null);
                load();
              } catch (err) {
                toast.error(err.message);
              }
            }}
            className="grid gap-3 sm:grid-cols-2"
          >
            <div className="rounded-xl bg-slate-50 p-3 text-sm sm:col-span-2">
              <p className="font-semibold text-slate-900">{koreksi.nama}</p>
              <p className="text-xs text-slate-500">{koreksi.tanggal}</p>
            </div>

            <Field label="Status *">
              <select
                className="input" value={koreksi.status}
                onChange={(e) => setKoreksi({ ...koreksi, status: e.target.value })}
              >
                {Object.entries(STATUS_LABEL).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </select>
            </Field>

            <Field label="Menit Terlambat" hint="Isi 0 bila dianggap tepat waktu">
              <input
                type="number" min="0" className="input" value={koreksi.late_minutes}
                onChange={(e) => setKoreksi({ ...koreksi, late_minutes: e.target.value })}
              />
            </Field>

            <Field label="Catatan Koreksi" hint="Sebaiknya isi alasan perubahan" className="sm:col-span-2">
              <input
                className="input" maxLength={500} value={koreksi.notes}
                onChange={(e) => setKoreksi({ ...koreksi, notes: e.target.value })}
              />
            </Field>

            <div className="flex gap-2 sm:col-span-2">
              <button type="button" className="btn-secondary flex-1" onClick={() => setKoreksi(null)}>Batal</button>
              <button type="submit" className="btn-primary flex-1">Simpan Koreksi</button>
            </div>
          </form>
        )}
      </Modal>

    </div>
  );
}

/** Foto presensi butuh header Authorization, jadi diambil sebagai blob URL. */
function AuthImage({ file, alt }) {
  const [src, setSrc] = useState(null);

  useEffect(() => {
    let url;
    let cancelled = false;
    fetch(`/api/uploads/${file}`, { headers: { Authorization: `Bearer ${localStorage.getItem('erp_token')}` } })
      .then((r) => (r.ok ? r.blob() : Promise.reject(new Error('gagal'))))
      .then((blob) => {
        if (cancelled) return;
        url = URL.createObjectURL(blob);
        setSrc(url);
      })
      .catch(() => setSrc(null));

    return () => {
      cancelled = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [file]);

  if (!src) {
    return <div className="grid aspect-[4/3] animate-pulse place-items-center rounded-xl bg-slate-100" />;
  }
  return <img src={src} alt={alt} className="aspect-[4/3] w-full rounded-xl object-cover" />;
}
