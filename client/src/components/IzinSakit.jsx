import { useRef, useState } from 'react';
import { HeartPulse, Clock4, Upload, Loader2 } from 'lucide-react';
import { api } from '../lib/api';
import { Modal, Field, useToast } from './ui';

export const LABEL_IZIN = {
  SAKIT: 'Sakit',
  SETENGAH_HARI: 'Setengah hari kerja',
  GESER_JAM: 'Ganti jam kerja',
  BERANGKAT_SIANG: 'Berangkat siang',
};

const JENIS_JAM = [
  { value: 'SETENGAH_HARI', desc: 'masuk/pulang separuh hari' },
  { value: 'BERANGKAT_SIANG', desc: 'ada urusan pagi, masuk siang' },
  { value: 'GESER_JAM', desc: 'jam kerja digeser hari ini' },
];

/**
 * Foto bukti dari galeri atau kamera, dikecilkan dulu di peramban.
 *
 * Surat dokter difoto dengan kamera belasan megapiksel, sedangkan peladen
 * menolak berkas di atas 3 MB. Mengecilkannya di sini membuat pengunggahan dari
 * HP bersinyal seadanya tetap berhasil, tanpa membuat tulisannya tak terbaca.
 */
function bacaGambar(file, maksPiksel = 1600) {
  return new Promise((resolve, reject) => {
    if (!file.type.startsWith('image/')) {
      reject(new Error('Berkas harus berupa gambar (foto surat, resep, atau kegiatan)'));
      return;
    }
    const pembaca = new FileReader();
    pembaca.onerror = () => reject(new Error('Foto gagal dibaca'));
    pembaca.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error('Foto tidak bisa dibuka'));
      img.onload = () => {
        const skala = Math.min(1, maksPiksel / Math.max(img.width, img.height));
        const kanvas = document.createElement('canvas');
        kanvas.width = Math.round(img.width * skala);
        kanvas.height = Math.round(img.height * skala);
        kanvas.getContext('2d').drawImage(img, 0, 0, kanvas.width, kanvas.height);
        resolve(kanvas.toDataURL('image/jpeg', 0.8));
      };
      img.src = pembaca.result;
    };
    pembaca.readAsDataURL(file);
  });
}

/**
 * Pengajuan sakit dan izin jam kerja — keduanya wajib berbukti foto.
 *
 * Sakit: surat dokter/bidan atau foto resep; harinya tidak menunggu check-in.
 * Izin jam: orangnya tetap masuk, hanya jamnya bergeser, dan keterlambatan
 * nanti dihitung dari jam yang disepakati di sini — bukan dari jam masuk umum.
 */
export default function IzinSakit({ record, onSelesai }) {
  const toast = useToast();
  const berkasRef = useRef(null);
  const [form, setForm] = useState(null);
  const [mengirim, setMengirim] = useState(false);

  const izinAktif = record?.izin_jenis || null;

  function buka(jenis) {
    setForm({ jenis, mulai: jenis === 'SAKIT' ? '' : '13:00', selesai: '', notes: '', photo: null, namaBerkas: '' });
  }

  async function pilihBerkas(e) {
    const file = e.target.files && e.target.files[0];
    e.target.value = '';
    if (!file) return;
    try {
      const data = await bacaGambar(file);
      setForm((f) => ({ ...f, photo: data, namaBerkas: file.name }));
    } catch (err) {
      toast.error(err.message);
    }
  }

  async function kirim(e) {
    e.preventDefault();
    if (!form.photo) return toast.error('Lampirkan foto buktinya dulu');
    setMengirim(true);
    try {
      const res = form.jenis === 'SAKIT'
        ? await api.post('/api/attendance/sakit', { photo: form.photo, notes: form.notes || null })
        : await api.post('/api/attendance/izin-jam', {
          jenis: form.jenis,
          mulai: form.mulai,
          selesai: form.selesai || null,
          photo: form.photo,
          notes: form.notes || null,
        });
      toast.success(res.message);
      setForm(null);
      onSelesai?.();
    } catch (err) {
      toast.error(err.message);
    } finally {
      setMengirim(false);
    }
  }

  return (
    <div className="card mb-4">
      <h2 className="mb-1 font-semibold text-slate-900">Berhalangan hari ini?</h2>
      <p className="mb-3 text-xs leading-relaxed text-slate-500">
        Catat <strong>sakit</strong> beserta surat dokter/bidan atau foto resep, atau ajukan{' '}
        <strong>izin jam kerja</strong> bila masuknya bergeser. Keterlambatan nanti dihitung dari jam
        yang Anda isi, bukan dari jam masuk biasa. Semua pengajuan wajib berbukti foto.
      </p>

      {izinAktif ? (
        <div className="rounded-xl bg-amber-50 px-3 py-2 text-sm text-amber-900">
          Hari ini tercatat <strong>{LABEL_IZIN[izinAktif] || izinAktif}</strong>
          {record.izin_mulai && <> mulai <strong>{record.izin_mulai}</strong></>}
          {record.izin_selesai && <> sampai <strong>{record.izin_selesai}</strong></>}.
          {record.izin_catatan && <span className="block text-xs">Catatan: {record.izin_catatan}</span>}
          <span className="block text-xs">
            {izinAktif === 'SAKIT'
              ? 'Semoga lekas sembuh — tidak perlu check-in hari ini.'
              : 'Silakan check-in seperti biasa saat sudah sampai.'}
          </span>
        </div>
      ) : (
        <div className="grid gap-2 sm:grid-cols-2">
          <button type="button" className="btn-secondary" onClick={() => buka('SAKIT')}>
            <HeartPulse size={17} className="text-rose-600" /> Saya Sakit
          </button>
          <button type="button" className="btn-secondary" onClick={() => buka('BERANGKAT_SIANG')}>
            <Clock4 size={17} className="text-brand-600" /> Izin / Ganti Jam Kerja
          </button>
        </div>
      )}

      <Modal
        open={!!form}
        onClose={() => setForm(null)}
        title={form && form.jenis === 'SAKIT' ? 'Catat Sakit' : 'Izin Jam Kerja'}
      >
        {form && (
          <form onSubmit={kirim} className="grid gap-3 sm:grid-cols-2">
            {form.jenis !== 'SAKIT' && (
              <>
                <Field label="Jenis izin *" className="sm:col-span-2">
                  <select
                    className="input" required value={form.jenis}
                    onChange={(e) => setForm({ ...form, jenis: e.target.value })}
                  >
                    {JENIS_JAM.map((j) => (
                      <option key={j.value} value={j.value}>{LABEL_IZIN[j.value]} — {j.desc}</option>
                    ))}
                  </select>
                </Field>
                <Field label="Mulai kerja jam *" hint="Keterlambatan dihitung dari jam ini">
                  <input
                    type="time" className="input" required value={form.mulai}
                    onChange={(e) => setForm({ ...form, mulai: e.target.value })}
                  />
                </Field>
                <Field label="Sampai jam" hint="Opsional, mis. untuk setengah hari">
                  <input
                    type="time" className="input" value={form.selesai}
                    onChange={(e) => setForm({ ...form, selesai: e.target.value })}
                  />
                </Field>
              </>
            )}

            <Field
              label="Foto bukti *"
              className="sm:col-span-2"
              hint={form.jenis === 'SAKIT'
                ? 'Surat dokter/bidan atau foto resep obat'
                : 'Foto kegiatan atau surat keterangannya'}
            >
              <input
                ref={berkasRef} type="file" accept="image/*" capture="environment"
                className="hidden" onChange={pilihBerkas}
              />
              <button type="button" className="btn-secondary w-full" onClick={() => berkasRef.current && berkasRef.current.click()}>
                <Upload size={16} /> {form.photo ? 'Ganti Foto' : 'Ambil / Pilih Foto'}
              </button>
            </Field>

            {form.photo && (
              <div className="sm:col-span-2">
                <img
                  src={form.photo} alt="Bukti yang dilampirkan"
                  className="max-h-52 w-full rounded-xl bg-slate-100 object-contain"
                />
                <p className="mt-1 truncate text-xs text-slate-400">{form.namaBerkas}</p>
              </div>
            )}

            <Field label="Keterangan" className="sm:col-span-2">
              <input
                className="input" maxLength={500} value={form.notes}
                placeholder={form.jenis === 'SAKIT' ? 'mis. demam, periksa ke bidan desa' : 'mis. mengantar anak ke rumah sakit'}
                onChange={(e) => setForm({ ...form, notes: e.target.value })}
              />
            </Field>

            <div className="flex gap-2 sm:col-span-2">
              <button type="button" className="btn-secondary flex-1" onClick={() => setForm(null)}>Batal</button>
              <button type="submit" className="btn-primary flex-1" disabled={mengirim}>
                {mengirim ? <Loader2 size={16} className="animate-spin" /> : null}
                {mengirim ? 'Mengirim...' : 'Kirim Pengajuan'}
              </button>
            </div>
          </form>
        )}
      </Modal>
    </div>
  );
}
