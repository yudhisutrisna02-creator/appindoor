'use strict';

/** Membungkus handler agar error (termasuk async) diteruskan ke error handler Express. */
const ah = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

/** Memvalidasi payload dengan skema zod; melempar error 400 yang rapi. */
function parse(schema, data) {
  const result = schema.safeParse(data);
  if (!result.success) {
    const detail = result.error.issues
      .map((i) => `${i.path.join('.') || 'body'}: ${i.message}`)
      .join('; ');
    const err = new Error(`Data tidak valid — ${detail}`);
    err.status = 400;
    throw err;
  }
  return result.data;
}

/** Error dengan status HTTP eksplisit. */
function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

/** Rentang tanggal default: bulan berjalan. */
function dateRange(query) {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const lastDay = new Date(y, now.getMonth() + 1, 0).getDate();
  return {
    from: query.from || `${y}-${m}-01`,
    to: query.to || `${y}-${m}-${String(lastDay).padStart(2, '0')}`,
  };
}

module.exports = { ah, parse, httpError, dateRange };
