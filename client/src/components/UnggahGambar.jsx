import { useRef, useState } from 'react';
import { Upload, Trash2, ImageIcon } from 'lucide-react';
import { useToast } from './ui';

const BATAS_BYTE = 3 * 1024 * 1024;
const TIPE_DIDUKUNG = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];

/**
 * Pemilih gambar yang mengubah berkas menjadi data URL.
 *
 * Peladen sudah menerima foto selfie presensi dalam bentuk data URL, jadi jalur
 * yang sama dipakai ulang di sini — tidak perlu menambah cara unggah kedua yang
 * harus dijaga terpisah.
 *
 * Gambar diperkecil di peramban sebelum dikirim. Foto dari ponsel sekarang
 * lazim 4–8 MB, jauh di atas batas peladen, dan menolaknya mentah-mentah hanya
 * memindahkan pekerjaan ke pengguna yang belum tentu tahu caranya memperkecil.
 *
 * @param {string|null} nilai data URL baru, URL gambar tersimpan, atau kosong
 * @param {(dataUrl: string|null) => void} onChange
 * @param {'kotak'|'bulat'} bentuk
 */
export default function UnggahGambar({
  nilai,
  onChange,
  label = 'Gambar',
  hint,
  bentuk = 'kotak',
  ukuranMaks = 512,
}) {
  const toast = useToast();
  const input = useRef(null);
  const [sibuk, setSibuk] = useState(false);

  async function pilih(e) {
    const berkas = e.target.files && e.target.files[0];
    e.target.value = '';
    if (!berkas) return;

    if (!TIPE_DIDUKUNG.includes(berkas.type)) {
      return toast.error('Gunakan berkas JPG, PNG, WebP, atau GIF');
    }

    setSibuk(true);
    try {
      // GIF dikirim apa adanya. Menggambarnya ke kanvas hanya mengambil bingkai
      // pertama — GIF bergerak akan berubah menjadi gambar diam, justru
      // menghilangkan satu-satunya alasan orang memilih GIF.
      const kecil = berkas.type === 'image/gif'
        ? await bacaApaAdanya(berkas)
        : await perkecil(berkas, ukuranMaks);
      if (kecil.length * 0.75 > BATAS_BYTE) {
        return toast.error('Gambar masih terlalu besar setelah diperkecil — coba gambar lain');
      }
      onChange(kecil);
    } catch (err) {
      toast.error(err.message || 'Gambar gagal dibaca');
    } finally {
      setSibuk(false);
    }
  }

  const kelasBingkai = bentuk === 'bulat' ? 'rounded-full' : 'rounded-xl';

  return (
    <div>
      <label className="label">{label}</label>
      <div className="flex items-center gap-3">
        <div
          className={`grid h-20 w-20 shrink-0 place-items-center overflow-hidden border border-slate-200 bg-slate-50 ${kelasBingkai}`}
        >
          {nilai ? (
            <img src={nilai} alt={label} className="h-full w-full object-cover" />
          ) : (
            <ImageIcon size={22} className="text-slate-300" />
          )}
        </div>

        <div className="flex flex-col gap-1.5">
          <div className="flex gap-2">
            <button type="button" className="btn-secondary !py-1.5 text-xs" onClick={() => input.current.click()} disabled={sibuk}>
              <Upload size={14} /> {sibuk ? 'Memproses...' : nilai ? 'Ganti' : 'Pilih Gambar'}
            </button>
            {nilai && (
              <button type="button" className="btn-ghost !px-2 !py-1.5 text-xs text-rose-600" onClick={() => onChange(null)}>
                <Trash2 size={14} /> Hapus
              </button>
            )}
          </div>
          {hint && <p className="text-[11px] text-slate-400">{hint}</p>}
        </div>
      </div>

      <input ref={input} type="file" accept="image/jpeg,image/png,image/webp,image/gif" className="hidden" onChange={pilih} />
    </div>
  );
}

/** Perkecil gambar sampai sisi terpanjangnya `maks` piksel, lalu jadikan data URL. */
/** Membaca berkas apa adanya menjadi data URL, tanpa diubah sama sekali. */
function bacaApaAdanya(berkas) {
  return new Promise((resolve, reject) => {
    const pembaca = new FileReader();
    pembaca.onerror = () => reject(new Error('Berkas gagal dibaca'));
    pembaca.onload = () => resolve(pembaca.result);
    pembaca.readAsDataURL(berkas);
  });
}

function perkecil(berkas, maks) {
  return new Promise((resolve, reject) => {
    const pembaca = new FileReader();
    pembaca.onerror = () => reject(new Error('Berkas gagal dibaca'));
    pembaca.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error('Berkas bukan gambar yang bisa dibaca'));
      img.onload = () => {
        const skala = Math.min(1, maks / Math.max(img.width, img.height));
        const w = Math.round(img.width * skala);
        const h = Math.round(img.height * skala);

        const kanvas = document.createElement('canvas');
        kanvas.width = w;
        kanvas.height = h;
        const ctx = kanvas.getContext('2d');

        // Bentuk berkasnya dipertahankan, tidak diseragamkan menjadi JPEG.
        // PNG sering memakai latar tembus pandang yang akan berubah jadi hitam,
        // dan WebP yang dipaksa menjadi JPEG justru membengkak — padahal WebP
        // dipilih justru supaya ringan.
        const tembusPandang = berkas.type === 'image/png' || berkas.type === 'image/webp';
        if (!tembusPandang) {
          ctx.fillStyle = '#FFFFFF';
          ctx.fillRect(0, 0, w, h);
        }
        ctx.drawImage(img, 0, 0, w, h);

        if (berkas.type === 'image/png') return resolve(kanvas.toDataURL('image/png'));
        if (berkas.type === 'image/webp') {
          const webp = kanvas.toDataURL('image/webp', 0.85);
          // Peramban yang tidak bisa menulis WebP diam-diam mengembalikan PNG.
          // Kalau begitu, JPEG lebih kecil daripada PNG untuk foto.
          if (webp.startsWith('data:image/webp')) return resolve(webp);
        }
        return resolve(kanvas.toDataURL('image/jpeg', 0.85));
      };
      img.src = pembaca.result;
    };
    pembaca.readAsDataURL(berkas);
  });
}
