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

const nowLocal = () => dayjs().tz(tz());
const todayLocal = () => nowLocal().format('YYYY-MM-DD');

/**
 * Menghitung keterlambatan terhadap jam masuk standar.
 * @param {string|Date} at waktu check-in (ISO/Date)
 * @returns {{status:'ONTIME'|'LATE', lateMinutes:number, workStart:string}}
 */
function evaluateLateness(at) {
  const workStart = getSetting('work_start', process.env.WORK_START || '08:00');
  const tolerance = Number(getSetting('late_tolerance_minutes', process.env.LATE_TOLERANCE_MINUTES || 10));

  const local = dayjs(at).tz(tz());
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

module.exports = { dayjs, tz, nowLocal, todayLocal, evaluateLateness, workMinutes };
