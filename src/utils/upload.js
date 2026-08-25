'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { httpError } = require('./http');

const UPLOAD_DIR = path.resolve(process.cwd(), process.env.UPLOAD_DIR || './uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

/** Batas ukuran foto selfie setelah decode (byte). */
const MAX_PHOTO_BYTES = 3 * 1024 * 1024;

const MIME_EXT = {
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};

/**
 * Menyimpan foto selfie yang dikirim sebagai data URL base64 dari kamera browser.
 * @param {string} dataUrl  'data:image/jpeg;base64,...'
 * @param {string} prefix   awalan nama file, mis. 'in-12'
 * @returns {string} nama file yang tersimpan
 */
function saveDataUrlImage(dataUrl, prefix = 'photo') {
  if (typeof dataUrl !== 'string') throw httpError(400, 'Foto tidak valid');

  const match = /^data:([\w/+.-]+);base64,(.+)$/s.exec(dataUrl.trim());
  if (!match) throw httpError(400, 'Format foto harus data URL base64');

  const [, mime, b64] = match;
  const ext = MIME_EXT[mime.toLowerCase()];
  if (!ext) throw httpError(400, `Tipe gambar ${mime} tidak didukung`);

  const buffer = Buffer.from(b64, 'base64');
  if (buffer.length === 0) throw httpError(400, 'Foto kosong');
  if (buffer.length > MAX_PHOTO_BYTES) {
    throw httpError(413, 'Ukuran foto melebihi 3 MB — turunkan kualitas kamera');
  }

  const safePrefix = String(prefix).replace(/[^a-zA-Z0-9_-]/g, '');
  const filename = `${safePrefix}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.${ext}`;
  fs.writeFileSync(path.join(UPLOAD_DIR, filename), buffer);
  return filename;
}

module.exports = { UPLOAD_DIR, saveDataUrlImage, MAX_PHOTO_BYTES };
