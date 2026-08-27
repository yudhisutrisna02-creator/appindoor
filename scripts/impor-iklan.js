'use strict';
/**
 * Memasukkan belanja iklan dari sheet "7. IKLAN" ke menu Biaya Iklan.
 *
 * Hanya blok bulan berjalan yang diambil. Blok bulan sebelumnya ada di sheet
 * yang sama, tetapi memasukkannya akan menaruh beban pada periode yang belum
 * punya penjualan pembanding di aplikasi — labanya akan tampak rugi besar
 * padahal penjualannya memang belum dicatat.
 *
 * Dijalankan tanpa --apply hanya menghitung dan melaporkan, tidak menulis.
 */
const { bacaIklan } = require('./baca-iklan');

const arg = (nama, bawaan) => {
  const p = process.argv.find((a) => a.startsWith(`--${nama}=`));
  return p ? p.split('=').slice(1).join('=') : bawaan;
};

const BASE = arg('base', 'http://localhost:3000');
const EMAIL = arg('email', process.env.SEED_ADMIN_EMAIL || 'admin@kebumen.local');
const SANDI = arg('password', process.env.SEED_ADMIN_PASSWORD || '');
const DARI = arg('dari', '2026-08-01');
const SAMPAI = arg('sampai', '2026-08-31');
const TERAP = process.argv.includes('--apply');

const rupiah = (n) => 'Rp ' + Math.round(n).toLocaleString('id-ID');

let token = null;
async function api(method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const teks = await res.text();
  let data = null;
  try {
    data = teks ? JSON.parse(teks) : null;
  } catch {
    data = { error: teks.slice(0, 200) };
  }
  if (!res.ok) {
    const err = new Error((data && data.error) || `${res.status} ${method} ${path}`);
    err.status = res.status;
    throw err;
  }
  return data;
}

/** Samakan penulisan nama toko: huruf besar, tanpa tanda baca dan spasi ganda. */
const normal = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]+/g, ' ').trim();

/**
 * Nama akun di sheet iklan tidak selalu sama persis dengan nama toko di
 * aplikasi — ada "Sh asia-Tronik" untuk "Sh asia", "Sh Agro Store" untuk
 * "Sh Agro", dan beda besar-kecil huruf di beberapa tempat. Dicocokkan
 * bertahap: sama persis dulu, baru awalan, supaya "Sh Agro Store" tidak
 * kebetulan menempel ke toko lain yang namanya lebih pendek.
 */
function cocokkanToko(nama, daftarToko) {
  const n = normal(nama);

  const persis = daftarToko.find((t) => normal(t.name) === n);
  if (persis) return { toko: persis, cara: 'nama sama' };

  const awalan = daftarToko
    .filter((t) => n.startsWith(normal(t.name)) || normal(t.name).startsWith(n))
    .sort((a, b) => normal(b.name).length - normal(a.name).length)[0];
  if (awalan) return { toko: awalan, cara: `dicocokkan dengan "${awalan.name}"` };

  return null;
}

/** Kanal ditentukan dari nama akun, bukan kolom MEDIA — sebagian MEDIA salah isi. */
function kanalDari(nama) {
  const t = normal(nama);
  if (t.startsWith('SH ')) return 'SHOPEE';
  if (t.startsWith('TIK TOK')) return 'TIKTOK_SHOP';
  if (t.startsWith('LZ ')) return 'LAZADA';
  if (t.startsWith('WA ')) return 'OFFLINE_WA';
  if (t.startsWith('TP ')) return 'TOKOPEDIA';
  return 'SHOPEE';
}

/** Nama platform iklan yang rapi, dari kolom MEDIA. */
function platformDari(media, kanal) {
  const m = normal(media);
  if (m.includes('TIK TOK') || m.includes('TIKTOK')) return 'TikTok Ads';
  if (m.includes('SHOPEE')) return 'Shopee Ads';
  if (m.includes('LAZADA')) return 'Lazada Ads';
  if (m.includes('TOKOPEDIA')) return 'Tokopedia Ads';
  return kanal === 'TIKTOK_SHOP' ? 'TikTok Ads' : 'Shopee Ads';
}

/**
 * Sumber dana. "SALDO" berarti dipotong dari dana marketplace yang belum cair —
 * uangnya tidak pernah keluar dari bank, jadi jangan disamakan dengan transfer.
 */
function sumberDana(rekening) {
  return normal(rekening) === 'SALDO' ? 'SALDO' : 'BANK';
}

(async () => {
  const semua = await bacaIklan();
  const baris = semua.filter((r) => r.tanggal >= DARI && r.tanggal <= SAMPAI);

  console.log('='.repeat(64));
  console.log(TERAP ? 'IMPOR BIAYA IKLAN — MENULIS' : 'IMPOR BIAYA IKLAN — PRATINJAU (tidak menulis)');
  console.log('='.repeat(64));
  console.log('sasaran        :', BASE);
  console.log('periode        :', DARI, 's/d', SAMPAI);
  console.log('baris terbaca  :', baris.length, '|', rupiah(baris.reduce((s, r) => s + r.nominal, 0)));

  const masuk = await api('POST', '/api/auth/login', { email: EMAIL.toLowerCase(), password: SANDI });
  token = masuk.token;

  const daftarToko = (await api('GET', '/api/shops')).shops;

  // --- cocokkan nama akun ke toko ---
  const namaUnik = [...new Set(baris.map((r) => r.toko))];
  const peta = new Map();
  const perluBuat = [];
  for (const nama of namaUnik) {
    const hit = cocokkanToko(nama, daftarToko);
    if (hit) peta.set(nama, { id: hit.toko.id, nama: hit.toko.name, cara: hit.cara });
    else perluBuat.push(nama);
  }

  console.log('\n--- Pencocokan toko ---');
  for (const [nama, t] of peta) {
    console.log(`  ${nama.padEnd(26)} -> ${t.nama.padEnd(26)} [${t.cara}]`);
  }
  if (perluBuat.length) {
    console.log('  belum ada tokonya, akan dibuat:');
    for (const n of perluBuat) console.log(`    ${n}  (${kanalDari(n)})`);
  }

  const perDana = {};
  for (const r of baris) {
    const d = sumberDana(r.rekening);
    perDana[d] = (perDana[d] || 0) + r.nominal;
  }
  console.log('\n--- Sumber dana ---');
  for (const [k, v] of Object.entries(perDana)) {
    console.log(`  ${k.padEnd(8)} ${rupiah(v)}${k === 'SALDO' ? '  (memotong piutang marketplace, bukan bank)' : ''}`);
  }

  if (!TERAP) {
    console.log('\nJalankan ulang dengan --apply untuk menerapkan.');
    return;
  }

  // --- buat toko yang belum ada ---
  for (const nama of perluBuat) {
    const hasil = await api('POST', '/api/shops', { name: nama, channel: kanalDari(nama) });
    const toko = hasil.shop || hasil;
    peta.set(nama, { id: toko.id, nama: toko.name, cara: 'toko baru' });
    console.log(`toko baru      : ${nama}`);
  }

  // --- lewati yang sudah pernah masuk ---
  // Catatan diberi tanda baris asalnya di Excel, sehingga menjalankan ulang
  // skrip ini tidak menggandakan belanja yang sama.
  const sudahAda = await api('GET', `/api/iklan?from=${DARI}&to=${SAMPAI}`);
  const tanda = new Set(
    (sudahAda.rows || [])
      .map((b) => (String(b.note || '').match(/\[baris (\d+)\]/) || [])[1])
      .filter(Boolean)
  );

  let ok = 0;
  let lewat = 0;
  const gagal = [];

  for (const r of baris) {
    if (tanda.has(String(r.baris))) {
      lewat += 1;
      continue;
    }
    const toko = peta.get(r.toko);
    const kanal = kanalDari(r.toko);
    try {
      await api('POST', '/api/iklan', {
        spend_date: r.tanggal,
        shop_id: toko ? toko.id : null,
        channel: kanal,
        platform: platformDari(r.media, kanal),
        amount: Math.round(r.nominal),
        payment: sumberDana(r.rekening),
        note: `${r.rekening || 'tanpa rekening'} — dari sheet 7. IKLAN [baris ${r.baris}]`,
      });
      ok += 1;
    } catch (e) {
      gagal.push({ baris: r.baris, toko: r.toko, pesan: e.message });
    }
  }

  console.log(`\nbelanja iklan  : ${ok} tercatat, ${lewat} dilewati (sudah ada), ${gagal.length} gagal`);
  for (const g of gagal.slice(0, 10)) console.log(`  ! baris ${g.baris} ${g.toko}: ${g.pesan}`);

  // --- hasil ---
  const ringkas = await api('GET', `/api/iklan?from=${DARI}&to=${SAMPAI}`);
  const r = ringkas.ringkas;
  console.log('\n--- Hasil ---');
  console.log('  total belanja iklan :', rupiah(r.totalIklan), `(${r.jumlahCatatan} catatan)`);
  console.log('  pendapatan kotor    :', rupiah(r.pendapatanKotor));
  console.log('  laba sebelum iklan  :', rupiah(r.labaSebelumIklan));
  console.log('  laba setelah iklan  :', rupiah(r.labaSetelahIklan));
  console.log('  ROAS                :', r.roas != null ? `${r.roas.toFixed(2)}x` : '-');
  console.log('  rasio iklan         :', r.rasioIklanPct != null ? `${r.rasioIklanPct}%` : '-');

  const neraca = await api('GET', `/api/finance/reports/balance-sheet?asOf=${SAMPAI}`);
  console.log('  neraca seimbang     :', neraca.balanced);
})().catch((e) => {
  console.error('\nGAGAL:', e.message);
  process.exit(1);
});
