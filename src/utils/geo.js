'use strict';
const { db } = require('../db');

const R_EARTH_M = 6_371_000;
const toRad = (deg) => (deg * Math.PI) / 180;

/** Jarak dua koordinat dalam meter (formula haversine). */
function haversineMeters(lat1, lng1, lat2, lng2) {
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return Math.round(2 * R_EARTH_M * Math.asin(Math.sqrt(a)));
}

/**
 * Mencari titik kantor terdekat dari koordinat pengguna.
 * @returns {{office:object, distance:number, inside:boolean}|null}
 */
function nearestOffice(lat, lng) {
  const offices = db.prepare('SELECT * FROM offices WHERE active = 1').all();
  if (offices.length === 0) return null;

  let best = null;
  for (const o of offices) {
    const distance = haversineMeters(lat, lng, o.lat, o.lng);
    if (!best || distance < best.distance) {
      best = { office: o, distance, inside: distance <= o.radius_m };
    }
  }
  return best;
}

module.exports = { haversineMeters, nearestOffice };
