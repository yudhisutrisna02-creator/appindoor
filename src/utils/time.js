'use strict';
const dayjs = require('dayjs');
const utc = require('dayjs/plugin/utc');
const timezone = require('dayjs/plugin/timezone');
const customParse = require('dayjs/plugin/customParseFormat');

dayjs.extend(utc);
dayjs.extend(timezone);
dayjs.extend(customParse);

const { getSetting } = require('../db');

/** Zona waktu operasional; dapat diubah lewat tabel settings. */
function tz() {
  return getSetting('timezone', process.env.TZ_NAME || 'Asia/Jakarta');
}

/**
 * Selisih menit terhadap UTC bila nama zona tidak bisa dipakai.
 * WIB = UTC+7 dan tidak mengenal daylight saving, jadi offset tetap sudah cukup.
 */
function offsetCadangan() {
  return Number(getSetting('tz_offset_minutes', process.env.TZ_OFFSET_MINUTES || 420));
}

/**
 * Sebagian build Node dipasang tanpa data zona waktu lengkap (ICU dipangkas).
 * Di lingkungan seperti itu dayjs().tz('Asia/Jakarta') melempar RangeError dan
 * membuat setiap halaman yang memakai tanggal hari ini ikut gagal. Kemampuan itu
 * diperiksa sekali saja, lalu hasilnya menentukan jalur yang dipakai seterusnya.
 */
let dukunganZona = null;
function zonaDidukung() {
  if (dukunganZona === null) {
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: tz() }).format(new Date());
      dukunganZona = true;
    } catch (err) {
      dukunganZona = false;
      console.warn(
        `[waktu] Zona "${tz()}" tidak dikenali runtime ini (${err.message}). ` +
          `Beralih ke offset tetap UTC+${offsetCadangan() / 60} jam.`
      );
    }
  }
  return dukunganZona;
}

/** Ubah waktu apa pun ke waktu lokal perusahaan, dengan atau tanpa data zona. */
function keLokal(at) {
  const d = at === undefined ? dayjs() : dayjs(at);
  return zonaDidukung() ? d.tz(tz()) : d.utc().utcOffset(offsetCadangan());
}

/** Info diagnostik untuk endpoint /api/health. */
function statusZona() {
  return {
    zone: tz(),
    mode: zonaDidukung() ? 'intl' : 'offset-tetap',
    offsetMinutes: zonaDidukung() ? keLokal().utcOffset() : offsetCadangan(),
    icu: process.versions.icu || null,
  };
}

const nowLocal = () => keLokal();
const todayLocal = () => nowLocal().format('YYYY-MM-DD');

/**
 * Menghitung keterlambatan terhadap jam masuk standar.
 * @param {string|Date} at waktu check-in (ISO/Date)
 * @returns {{status:'ONTIME'|'LATE', lateMinutes:number, workStart:string}}
 */
function evaluateLateness(at) {
  const workStart = getSetting('work_start', process.env.WORK_START || '08:00');
  const tolerance = Number(getSetting('late_tolerance_minutes', process.env.LATE_TOLERANCE_MINUTES || 10));

  const local = keLokal(at);
  const [hh, mm] = workStart.split(':').map(Number);
  const deadline = local.hour(hh).minute(mm).second(0).millisecond(0);

  const diff = local.diff(deadline, 'minute');
  const lateMinutes = diff > tolerance ? diff : 0;

  return { status: lateMinutes > 0 ? 'LATE' : 'ONTIME', lateMinutes, workStart };
}

/** Selisih menit kerja antara check-in dan check-out. */
function workMinutes(checkIn, checkOut) {
  if (!checkIn || !checkOut) return 0;
  return Math.max(0, dayjs(checkOut).diff(dayjs(checkIn), 'minute'));
}

module.exports = { dayjs, tz, keLokal, statusZona, nowLocal, todayLocal, evaluateLateness, workMinutes };
