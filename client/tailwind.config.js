/** @type {import('tailwindcss').Config} */

/**
 * Warna netral dijadikan variabel CSS, bukan nilai tetap.
 *
 * Aplikasi ini memakai skala slate di ratusan tempat — text-slate-900 untuk
 * tulisan utama, bg-slate-50 untuk kepala tabel, border-slate-200 untuk garis.
 * Menambahkan varian dark: pada tiap pemakaian berarti ratusan perubahan yang
 * mudah terlewat satu-dua, dan yang terlewat baru ketahuan saat ada yang
 * membuka halamannya dalam gelap. Dengan variabel, seluruh skalanya cukup
 * dibalik sekali di index.css.
 *
 * Yang memang harus tetap gelap pada kedua tema — sidebar dan panel ringkasan —
 * memakai skala "ink" yang nilainya tidak ikut berubah.
 */
const netral = (nama) => ({
  50: `rgb(var(--${nama}-50) / <alpha-value>)`,
  100: `rgb(var(--${nama}-100) / <alpha-value>)`,
  200: `rgb(var(--${nama}-200) / <alpha-value>)`,
  300: `rgb(var(--${nama}-300) / <alpha-value>)`,
  400: `rgb(var(--${nama}-400) / <alpha-value>)`,
  500: `rgb(var(--${nama}-500) / <alpha-value>)`,
  600: `rgb(var(--${nama}-600) / <alpha-value>)`,
  700: `rgb(var(--${nama}-700) / <alpha-value>)`,
  800: `rgb(var(--${nama}-800) / <alpha-value>)`,
  900: `rgb(var(--${nama}-900) / <alpha-value>)`,
  950: `rgb(var(--${nama}-950) / <alpha-value>)`,
});

export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        slate: netral('slate'),
        // Latar kartu, input, dan panel — putih pada tema terang, abu gelap
        // pada tema gelap. Dipisah dari `white` karena `text-white` di atas
        // tombol biru harus tetap putih pada kedua tema.
        surface: 'rgb(var(--surface) / <alpha-value>)',
        // Permukaan yang memang selalu gelap.
        ink: {
          700: '#334155', 800: '#1e293b', 900: '#0f172a', 950: '#020617',
        },
        brand: {
          50: '#eef6ff', 100: '#d9eaff', 200: '#bcdaff', 300: '#8ec2ff',
          400: '#589fff', 500: '#317bff', 600: '#1a5cf5', 700: '#1548e1',
          800: '#183db6', 900: '#19388f',
        },
      },
      fontFamily: { sans: ['Inter', 'system-ui', 'Segoe UI', 'sans-serif'] },
    },
  },
  plugins: [],
};
