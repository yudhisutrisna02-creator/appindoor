'use strict';
/**
 * Koreksi saldo awal persediaan yang tercatat dua kali.
 *
 * Apa yang terjadi: basis data produksi sudah punya posisi awal persediaan dari
 * pemuatan sebelumnya. Saat scripts/muat-ulang.js dijalankan, ia mencatat posisi
 * awal sekali lagi — pengamannya hanya memeriksa apakah sudah ada penjualan
 * Agustus, bukan apakah posisi awalnya sudah pernah dicatat. Akibatnya Modal
 * Pemilik bertambah dua kali, dan opname penutup menghapus kelebihan stoknya
 * sebagai kerugian sebesar nilai yang sama.
 *
 * Akibatnya pada laporan: laba bersih tampak minus padahal usahanya untung, dan
 * modal pemilik tampak hampir dua kali lipat. Nilai persediaan, stok, kas,
 * piutang, dan penjualan seluruhnya tidak terpengaruh — yang salah hanya
 * pembagian antara modal dan laba.
 *
 * Perbaikannya satu jurnal: mengurangi Modal Pemilik sebesar pencatatan kedua,
 * dan membatalkan penghapusan stok yang menyertainya. Dipilih jurnal koreksi,
 * bukan membongkar riwayat, supaya kejadiannya tetap terbaca oleh siapa pun
 * yang memeriksa pembukuan nanti.
 *
 * Skrip ini menghitung sendiri nilai koreksinya dari mutasi bertanda SALDO-AWAL,
 * memeriksa bahwa koreksinya belum pernah dipasang, lalu menampilkan hasilnya.
 */

const arg = (nama, bawaan) => {
  const p = process.argv.find((a) => a.startsWith(`--${nama}=`));
  return p ? p.split('=').slice(1).join('=') : bawaan;
};

const BASE = arg('base', 'http://localhost:3000');
const EMAIL = arg('email', process.env.SEED_ADMIN_EMAIL || 'admin@kebumen.local');
const SANDI = arg('password', process.env.SEED_ADMIN_PASSWORD || '');
const TERAP = process.argv.includes('--apply');

const KETERANGAN = 'Koreksi saldo awal persediaan yang tercatat dua kali';
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
  const data = teks ? JSON.parse(teks) : null;
  if (!res.ok) throw new Error((data && data.error) || `${res.status} ${method} ${path}`);
  return data;
}

(async () => {
  const masuk = await api('POST', '/api/auth/login', { email: EMAIL.toLowerCase(), password: SANDI });
  token = masuk.token;

  // Kedua pencatatan sama-sama bertanda SALDO-AWAL, jadi yang membedakannya
  // adalah tanggal: posisi awal yang benar bertanggal 31 Juli 2026 mengikuti
  // REPORT INVENTORY, sedangkan pemuatan sementara sebelumnya bertanggal lain.
  // Yang dibatalkan adalah yang bertanggal lain itu.
  const TANGGAL_BENAR = '2026-07-31';
  const mutasi = await api('GET', '/api/inventory/moves?from=2000-01-01&to=2099-12-31&move_type=IN&limit=20000');
  if (mutasi.terpotong) throw new Error('Daftar mutasi terpotong — koreksi dibatalkan agar tidak dihitung dari data yang kurang');

  const saldoAwal = (mutasi.rows || []).filter((m) => m.ref === 'SALDO-AWAL');
  const benar = saldoAwal.filter((m) => m.move_date === TANGGAL_BENAR);
  const duplikat = saldoAwal.filter((m) => m.move_date !== TANGGAL_BENAR);
  const nilai = Math.round(duplikat.reduce((s, m) => s + m.qty * m.unit_cost, 0));

  console.log('posisi awal 31 Juli    :', benar.length, 'baris,',
    rupiah(benar.reduce((s, m) => s + m.qty * m.unit_cost, 0)));
  console.log('pencatatan berlebih    :', duplikat.length, 'baris');

  const jurnal = await api('GET', '/api/finance/journals?from=2000-01-01&to=2099-12-31');
  const sudahAda = (jurnal.rows || []).some((j) => j.description === KETERANGAN);

  const { accounts } = await api('GET', '/api/finance/accounts');
  const modal = accounts.find((a) => a.code === '3000');
  const selisih = accounts.find((a) => a.code === '8000');

  console.log('sasaran                :', BASE);
  console.log('nilai yang dibatalkan  :', rupiah(nilai));
  console.log('modal pemilik sekarang :', rupiah(modal.balance));
  console.log('selisih opname sekarang:', rupiah(selisih.balance));

  if (!nilai) {
    console.log('\nTidak ada mutasi SALDO-AWAL — tidak ada yang perlu dikoreksi.');
    return;
  }
  if (sudahAda) {
    console.log('\nKoreksi ini sudah pernah dipasang. Tidak diulang.');
    return;
  }
  if (!TERAP) {
    console.log('\nAkan dibuat jurnal:');
    console.log(`  Debit  3000 Modal Pemilik        ${rupiah(nilai)}`);
    console.log(`  Kredit 8000 Selisih Stok Opname  ${rupiah(nilai)}`);
    console.log('\nJalankan ulang dengan --apply untuk menerapkan.');
    return;
  }

  const hasil = await api('POST', '/api/finance/journals', {
    entry_date: '2026-08-31',
    description: KETERANGAN,
    lines: [
      { account_id: modal.id, debit: nilai, credit: 0, memo: 'Membatalkan pencatatan modal awal yang kedua' },
      { account_id: selisih.id, debit: 0, credit: nilai, memo: 'Membatalkan penghapusan stok yang menyertainya' },
    ],
  });
  console.log('\n' + hasil.message);

  const pnl = await api('GET', '/api/finance/reports/income-statement?from=2026-07-01&to=2026-08-31');
  const neraca = await api('GET', '/api/finance/reports/balance-sheet?asOf=2026-08-31');

  console.log('\n--- Sesudah koreksi ---');
  console.log('  laba kotor      :', rupiah(pnl.grossProfit));
  console.log('  laba usaha      :', rupiah(pnl.operatingProfit));
  console.log('  pendapatan lain :', rupiah(pnl.otherIncome));
  console.log('  beban lain      :', rupiah(pnl.otherExpense));
  console.log('  LABA BERSIH     :', rupiah(pnl.netProfit));
  console.log('  modal pemilik   :', rupiah(neraca.equity.capital));
  console.log('  laba berjalan   :', rupiah(neraca.equity.currentEarnings));
  console.log('  total aset      :', rupiah(neraca.assets.total), '| seimbang:', neraca.balanced);
})().catch((e) => {
  console.error('GAGAL:', e.message);
  process.exit(1);
});
