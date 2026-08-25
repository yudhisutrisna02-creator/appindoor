'use strict';
/**
 * Membangun frontend dari direktori root.
 *
 * Memakai spawn dengan `cwd: client/` alih-alih `npm --prefix client`, karena
 * bentuk --prefix membuat npm memuat ulang package.json root sehingga
 * postinstall memanggil dirinya sendiri secara berulang.
 *
 * Variabel ERP_SKIP_CLIENT_BUILD=1 melewati langkah ini (berguna di CI yang
 * sudah membangun frontend pada langkah terpisah).
 */
const { spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const CLIENT_DIR = path.join(__dirname, '..', 'client');
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

if (process.env.ERP_SKIP_CLIENT_BUILD === '1') {
  console.log('ERP_SKIP_CLIENT_BUILD=1 — build frontend dilewati.');
  process.exit(0);
}

if (!fs.existsSync(path.join(CLIENT_DIR, 'package.json'))) {
  console.error('Direktori client/ tidak ditemukan — build dibatalkan.');
  process.exit(1);
}

function run(args) {
  console.log(`> npm ${args.join(' ')}  (di client/)`);
  const result = spawnSync(npm, args, {
    cwd: CLIENT_DIR,
    stdio: 'inherit',
    shell: process.platform === 'win32',
    // Mencegah postinstall root ikut terpanggil dari proses anak
    env: { ...process.env, ERP_SKIP_CLIENT_BUILD: '1' },
  });
  if (result.status !== 0) {
    console.error(`Perintah gagal dengan kode ${result.status}`);
    process.exit(result.status || 1);
  }
}

run(['install', '--no-audit', '--no-fund']);
run(['run', 'build']);

console.log('Build frontend selesai — hasil ada di client/dist');
