'use strict';
/**
 * Menjalankan Vite dev server dari direktori root.
 * Memakai spawn dengan `cwd: client/` untuk alasan yang sama seperti
 * build-client.js — lihat komentar di berkas tersebut.
 */
const { spawn } = require('child_process');
const path = require('path');

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

const child = spawn(npm, ['run', 'dev'], {
  cwd: path.join(__dirname, '..', 'client'),
  stdio: 'inherit',
  shell: process.platform === 'win32',
});

child.on('exit', (code) => process.exit(code ?? 0));

// Teruskan sinyal agar Ctrl+C mematikan Vite juga
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => child.kill(signal));
}
