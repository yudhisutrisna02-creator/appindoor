/** Format Rupiah penuh, mis. 1250000 -> "Rp 1.250.000". */
export const rupiah = (n) =>
  'Rp ' + Math.round(Number(n) || 0).toLocaleString('id-ID');

/** Rupiah ringkas untuk kartu KPI, mis. 1250000 -> "Rp 1,25 jt". */
export function rupiahShort(n) {
  const v = Number(n) || 0;
  const abs = Math.abs(v);
  const sign = v < 0 ? '-' : '';
  if (abs >= 1_000_000_000) return `${sign}Rp ${(abs / 1_000_000_000).toLocaleString('id-ID', { maximumFractionDigits: 2 })} M`;
  if (abs >= 1_000_000) return `${sign}Rp ${(abs / 1_000_000).toLocaleString('id-ID', { maximumFractionDigits: 2 })} jt`;
  if (abs >= 1_000) return `${sign}Rp ${(abs / 1_000).toLocaleString('id-ID', { maximumFractionDigits: 1 })} rb`;
  return rupiah(v);
}

export const num = (n, digits = 0) =>
  Number(n || 0).toLocaleString('id-ID', { maximumFractionDigits: digits });

export const pct = (n) => `${Number(n || 0).toFixed(2)}%`;

export const dateID = (d) =>
  d ? new Date(d).toLocaleDateString('id-ID', { day: '2-digit', month: 'short', year: 'numeric' }) : '-';

export const timeID = (d) =>
  d ? new Date(d).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' }) : '-';

/** Tanggal hari ini dalam format input[type=date]. */
export const today = () => new Date().toLocaleDateString('sv-SE');

/** Tanggal pertama bulan berjalan. */
export const firstOfMonth = () => {
  const d = new Date();
  return new Date(d.getFullYear(), d.getMonth(), 1).toLocaleDateString('sv-SE');
};

export const CHANNEL_LABEL = {
  OFFLINE_WA: 'Offline / WhatsApp',
  SOCIAL_MEDIA: 'Social Media',
  WEBSITE: 'Website',
  SHOPEE: 'Shopee',
  TOKOPEDIA: 'Tokopedia',
  TIKTOK_SHOP: 'TikTok Shop',
  LAZADA: 'Lazada',
};

export const WORK_TYPE_LABEL = {
  WFO: 'WFO (Kantor/Gudang)',
  WFH: 'WFH',
  DINAS_LUAR: 'Dinas Luar / Kunjungan',
};

export const STATUS_LABEL = {
  ONTIME: 'Tepat Waktu',
  LATE: 'Terlambat',
  LEAVE: 'Izin/Cuti',
  ABSENT: 'Alpa',
};

/** Palet grafik konsisten lintas halaman. */
export const CHART_COLORS = ['#1a5cf5', '#0ea5e9', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6'];

/**
 * Tahapan pesanan marketplace, dari barang disiapkan sampai dananya cair.
 * Ditaruh di sini karena dipakai daftar order, formulir, dan dashboard.
 */
export const STATUS_PESANAN = {
  DIPROSES: 'Diproses',
  DIKIRIM: 'Dikirim',
  SELESAI: 'Selesai',
  CAIR: 'Cair',
  RETUR: 'Retur',
  BATAL: 'Batal',
};

/** Warna badge tiap tahapan — hijau hanya untuk yang uangnya sudah diterima. */
export const WARNA_STATUS = {
  DIPROSES: 'badge-slate',
  DIKIRIM: 'badge-amber',
  SELESAI: 'badge-amber',
  CAIR: 'badge-green',
  RETUR: 'badge-red',
  BATAL: 'badge-red',
};

/**
 * Warna lencana per channel penjualan.
 *
 * Memakai warna yang sudah dikenali orang dari aplikasi marketplace-nya
 * masing-masing, supaya satu baris bisa dikenali tanpa membaca tulisannya —
 * yang berguna saat menyusuri ratusan order sekaligus.
 *
 * Nilainya ditulis sebagai heksadesimal, bukan warna bawaan Tailwind, karena
 * yang diminta adalah warna merek yang tepat; padanan terdekat Tailwind
 * meleset cukup jauh untuk oranye Shopee dan hijau army Tokopedia.
 */
export const WARNA_CHANNEL = {
  SHOPEE: 'bg-[#EE4D2D]',
  TIKTOK_SHOP: 'bg-[#111111]',
  LAZADA: 'bg-[#EC1C7E]',
  OFFLINE_WA: 'bg-[#16A34A]',
  WEBSITE: 'bg-[#2563EB]',
  TOKOPEDIA: 'bg-[#4B5320]',
  // Tidak diminta secara khusus; diberi warna sendiri agar tidak tertukar
  // dengan channel lain saat muncul.
  SOCIAL_MEDIA: 'bg-[#7C3AED]',
};

/** Lencana channel siap pakai — teksnya selalu putih agar kontras terjaga. */
export const kelasChannel = (channel) =>
  `inline-block rounded-md px-2 py-0.5 text-xs font-semibold text-white ${
    WARNA_CHANNEL[channel] || 'bg-slate-500'
  }`;
