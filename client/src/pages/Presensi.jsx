import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Camera, MapPin, RefreshCw, CheckCircle2, LogIn, LogOut, Loader2,
  Building2, Home, Route as RouteIcon, CameraOff, SwitchCamera,
} from 'lucide-react';
import { api } from '../lib/api';
import { PageHeader, StatCard, Spinner, useToast } from '../components/ui';
import { timeID, WORK_TYPE_LABEL } from '../lib/format';

const WORK_TYPES = [
  { value: 'WFO', label: 'WFO', desc: 'Kantor / Gudang', icon: Building2 },
  { value: 'WFH', label: 'WFH', desc: 'Kerja dari rumah', icon: Home },
  { value: 'DINAS_LUAR', label: 'Dinas Luar', desc: 'Kunjungan lapangan', icon: RouteIcon },
];

/** Mengambil posisi GPS presisi tinggi sebagai Promise. */
function getPosition() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) {
      reject(new Error('Perangkat/browser ini tidak mendukung Geolocation'));
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve(pos),
      (err) => {
        const messages = {
          1: 'Izin lokasi ditolak. Aktifkan akses lokasi di pengaturan browser lalu muat ulang halaman.',
          2: 'Sinyal GPS tidak tersedia. Coba pindah ke area terbuka.',
          3: 'Permintaan lokasi kehabisan waktu. Coba lagi.',
        };
        reject(new Error(messages[err.code] || err.message));
      },
      { enableHighAccuracy: true, timeout: 20000, maximumAge: 0 }
    );
  });
}

export default function Presensi() {
  const toast = useToast();
  const videoRef = useRef(null);
  const canvasRef = useRef(null);
  const streamRef = useRef(null);

  const [status, setStatus] = useState(null);
  const [loading, setLoading] = useState(true);
  const [workType, setWorkType] = useState('WFO');
  const [notes, setNotes] = useState('');

  const [cameraOn, setCameraOn] = useState(false);
  const [facingMode, setFacingMode] = useState('user');
  const [photo, setPhoto] = useState(null);

  const [coords, setCoords] = useState(null);
  const [locating, setLocating] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const loadStatus = useCallback(async () => {
    try {
      setStatus(await api.get('/api/attendance/today'));
    } catch (err) {
      toast.error(err.message);
    } finally {
      setLoading(false);
    }
    // toast identitasnya stabil dari provider
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => { loadStatus(); }, [loadStatus]);

  // Menghentikan kamera saat komponen dilepas agar lampu kamera mati.
  const stopCamera = useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    setCameraOn(false);
  }, []);

  useEffect(() => stopCamera, [stopCamera]);

  async function startCamera(mode = facingMode) {
    try {
      stopCamera();
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: mode, width: { ideal: 1280 }, height: { ideal: 960 } },
        audio: false,
      });
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play();
      }
      setFacingMode(mode);
      setCameraOn(true);
      setPhoto(null);
    } catch (err) {
      const hint =
        err.name === 'NotAllowedError'
          ? 'Izin kamera ditolak. Aktifkan izin kamera di browser.'
          : err.name === 'NotFoundError'
          ? 'Kamera tidak terdeteksi pada perangkat ini.'
          : err.message;
      toast.error(`Kamera gagal dibuka — ${hint}`);
    }
  }

  /** Mengambil frame video menjadi JPEG data URL (kualitas 0.75 agar ringan). */
  function capture() {
    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas || !video.videoWidth) {
      toast.error('Kamera belum siap, tunggu sesaat lalu coba lagi');
      return;
    }
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;

    const ctx = canvas.getContext('2d');
    if (facingMode === 'user') {
      // Cermin agar hasil foto sesuai dengan yang dilihat pengguna
      ctx.translate(canvas.width, 0);
      ctx.scale(-1, 1);
    }
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

    setPhoto(canvas.toDataURL('image/jpeg', 0.75));
    stopCamera();
  }

  async function locate() {
    setLocating(true);
    try {
      const pos = await getPosition();
      setCoords({
        lat: pos.coords.latitude,
        lng: pos.coords.longitude,
        accuracy: pos.coords.accuracy,
      });
      toast.success(`Lokasi terkunci (akurasi ±${Math.round(pos.coords.accuracy)} m)`);
    } catch (err) {
      toast.error(err.message);
    } finally {
      setLocating(false);
    }
  }

  async function submit(kind) {
    if (!photo) return toast.error('Ambil foto selfie terlebih dahulu');
    if (!coords) return toast.error('Kunci lokasi GPS terlebih dahulu');

    setSubmitting(true);
    try {
      const payload = {
        workType,
        lat: coords.lat,
        lng: coords.lng,
        accuracy: coords.accuracy,
        photo,
        notes: notes || null,
      };
      const res = await api.post(`/api/attendance/${kind}`, payload);
      toast.success(res.message);
      setPhoto(null);
      setNotes('');
      await loadStatus();
    } catch (err) {
      toast.error(err.message);
    } finally {
      setSubmitting(false);
    }
  }

  if (loading) return <Spinner />;

  const record = status?.record;
  const doneToday = !!record?.check_out_at;
  const mode = !record ? 'check-in' : 'check-out';

  // Perkiraan jarak ke kantor terdekat untuk umpan balik langsung sebelum submit
  const nearest = coords && status?.offices?.length
    ? status.offices
        .map((o) => ({ ...o, distance: haversine(coords.lat, coords.lng, o.lat, o.lng) }))
        .sort((a, b) => a.distance - b.distance)[0]
    : null;
  const insideGeofence = nearest ? nearest.distance <= nearest.radius_m : false;

  return (
    <div>
      <PageHeader
        title="Presensi Karyawan"
        subtitle={`${status.date} • Jam masuk ${status.workStart} (toleransi ${status.lateTolerance} menit)`}
      />

      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard
          label="Check In" value={timeID(record?.check_in_at)}
          sub={record ? WORK_TYPE_LABEL[record.work_type] : 'Belum absen masuk'}
          icon={LogIn} tone={record ? 'green' : 'slate'}
        />
        <StatCard
          label="Check Out" value={timeID(record?.check_out_at)}
          sub={doneToday ? `${Math.floor(record.work_minutes / 60)}j ${record.work_minutes % 60}m kerja` : 'Belum absen pulang'}
          icon={LogOut} tone={doneToday ? 'green' : 'slate'}
        />
        <StatCard
          label="Status"
          value={record ? (record.status === 'LATE' ? 'Terlambat' : 'Tepat Waktu') : '-'}
          sub={record?.late_minutes ? `${record.late_minutes} menit` : 'Sesuai jadwal'}
          icon={CheckCircle2} tone={record?.status === 'LATE' ? 'red' : 'green'}
        />
        <StatCard
          label="Akurasi GPS"
          value={coords ? `±${Math.round(coords.accuracy)} m` : '-'}
          sub={`Batas maksimum ${status.maxAccuracy} m`}
          icon={MapPin} tone={coords && coords.accuracy <= status.maxAccuracy ? 'green' : 'amber'}
        />
      </div>

      {doneToday ? (
        <div className="card text-center">
          <CheckCircle2 size={40} className="mx-auto mb-3 text-emerald-500" />
          <h2 className="text-lg font-bold text-slate-900">Presensi hari ini sudah lengkap</h2>
          <p className="mt-1 text-sm text-slate-500">
            Masuk {timeID(record.check_in_at)} • Pulang {timeID(record.check_out_at)} •
            Durasi {Math.floor(record.work_minutes / 60)} jam {record.work_minutes % 60} menit
          </p>
        </div>
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          {/* ---------- KAMERA ---------- */}
          <div className="card">
            <div className="mb-3 flex items-center justify-between">
              <h2 className="font-semibold text-slate-900">1. Foto Selfie</h2>
              {cameraOn && (
                <button
                  className="btn-ghost !px-2 !py-1.5 text-xs"
                  onClick={() => startCamera(facingMode === 'user' ? 'environment' : 'user')}
                >
                  <SwitchCamera size={15} /> Balik kamera
                </button>
              )}
            </div>

            <div className="relative aspect-[4/3] overflow-hidden rounded-xl bg-slate-900">
              {photo ? (
                <img src={photo} alt="Hasil selfie presensi" className="h-full w-full object-cover" />
              ) : (
                <video
                  ref={videoRef} playsInline muted
                  className={`h-full w-full object-cover ${facingMode === 'user' ? '-scale-x-100' : ''} ${cameraOn ? '' : 'opacity-0'}`}
                />
              )}
              {!cameraOn && !photo && (
                <div className="absolute inset-0 grid place-items-center text-slate-400">
                  <div className="text-center">
                    <CameraOff size={34} className="mx-auto mb-2" />
                    <p className="text-xs">Kamera belum aktif</p>
                  </div>
                </div>
              )}
            </div>
            <canvas ref={canvasRef} className="hidden" />

            <div className="mt-3 flex gap-2">
              {!cameraOn && !photo && (
                <button className="btn-primary flex-1" onClick={() => startCamera()}>
                  <Camera size={17} /> Aktifkan Kamera
                </button>
              )}
              {cameraOn && (
                <button className="btn-primary flex-1" onClick={capture}>
                  <Camera size={17} /> Ambil Foto
                </button>
              )}
              {photo && (
                <button className="btn-secondary flex-1" onClick={() => startCamera()}>
                  <RefreshCw size={17} /> Ulangi Foto
                </button>
              )}
            </div>
          </div>

          {/* ---------- LOKASI & TIPE ---------- */}
          <div className="card">
            <h2 className="mb-3 font-semibold text-slate-900">2. Lokasi & Tipe Presensi</h2>

            <button className="btn-secondary mb-3 w-full" onClick={locate} disabled={locating}>
              {locating ? <Loader2 size={17} className="animate-spin" /> : <MapPin size={17} />}
              {locating ? 'Mencari sinyal GPS...' : coords ? 'Perbarui Lokasi' : 'Kunci Lokasi GPS'}
            </button>

            {coords && (
              <div className="mb-3 rounded-xl bg-slate-50 p-3 text-xs">
                <div className="tabular grid grid-cols-2 gap-2 text-slate-600">
                  <div><span className="text-slate-400">Lintang</span><br />{coords.lat.toFixed(6)}</div>
                  <div><span className="text-slate-400">Bujur</span><br />{coords.lng.toFixed(6)}</div>
                  <div><span className="text-slate-400">Akurasi</span><br />±{Math.round(coords.accuracy)} m</div>
                  <div>
                    <span className="text-slate-400">Kantor terdekat</span><br />
                    {nearest ? `${nearest.name} — ${nearest.distance} m` : 'Tidak ada data'}
                  </div>
                </div>
                {nearest && (
                  <p className={`mt-2 font-semibold ${insideGeofence ? 'text-emerald-600' : 'text-amber-600'}`}>
                    {insideGeofence
                      ? '✓ Anda berada di dalam radius kantor — WFO diizinkan'
                      : `Di luar radius ${nearest.radius_m} m — pilih WFH atau Dinas Luar`}
                  </p>
                )}
              </div>
            )}

            <p className="label">Tipe Presensi</p>
            <div className="mb-3 grid grid-cols-3 gap-2">
              {WORK_TYPES.map((t) => (
                <button
                  key={t.value}
                  onClick={() => setWorkType(t.value)}
                  disabled={mode === 'check-out'}
                  className={`rounded-xl border-2 p-2.5 text-center transition disabled:opacity-60 ${
                    workType === t.value
                      ? 'border-brand-600 bg-brand-50 text-brand-700'
                      : 'border-slate-200 text-slate-600 hover:border-slate-300'
                  }`}
                >
                  <t.icon size={19} className="mx-auto mb-1" />
                  <p className="text-xs font-semibold">{t.label}</p>
                  <p className="mt-0.5 text-[10px] leading-tight text-slate-400">{t.desc}</p>
                </button>
              ))}
            </div>

            <label className="label" htmlFor="notes">Catatan (opsional)</label>
            <textarea
              id="notes" className="input mb-4" rows={2}
              placeholder="mis. kunjungan ke toko mitra Gombong"
              value={notes} onChange={(e) => setNotes(e.target.value)}
            />

            <button
              className="btn-primary w-full"
              onClick={() => submit(mode)}
              disabled={submitting || !photo || !coords}
            >
              {submitting ? <Loader2 size={17} className="animate-spin" /> : mode === 'check-in' ? <LogIn size={17} /> : <LogOut size={17} />}
              {mode === 'check-in' ? 'Kirim Check In' : 'Kirim Check Out'}
            </button>

            {(!photo || !coords) && (
              <p className="mt-2 text-center text-xs text-slate-400">
                Lengkapi foto selfie dan lokasi GPS untuk mengaktifkan tombol.
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/** Salinan ringan haversine untuk pratinjau jarak di sisi klien (meter). */
function haversine(lat1, lng1, lat2, lng2) {
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return Math.round(2 * 6371000 * Math.asin(Math.sqrt(a)));
}
