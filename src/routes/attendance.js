'use strict';
const express = require('express');
const { z } = require('zod');
const { db, getSetting } = require('../db');
const { requireAuth, butuhIzin } = require('../middleware/auth');
const { ah, parse, httpError, dateRange } = require('../utils/http');
const { saveDataUrlImage } = require('../utils/upload');
const { nearestOffice } = require('../utils/geo');
const { dayjs, todayLocal, evaluateLateness, workMinutes } = require('../utils/time');
const { attendanceExcel, attendancePdf } = require('../utils/exporters');

const router = express.Router();
router.use(requireAuth);

const WORK_TYPES = ['WFO', 'WFH', 'DINAS_LUAR'];

const punchSchema = z.object({
  workType: z.enum(WORK_TYPES),
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  accuracy: z.number().nonnegative().optional().default(0),
  photo: z.string().min(20, 'foto selfie wajib diambil'),
  address: z.string().max(300).optional().nullable(),
  notes: z.string().max(500).optional().nullable(),
});

/** Validasi akurasi GPS — menolak koordinat yang terlalu kabur. */
function assertAccuracy(accuracy) {
  const max = Number(getSetting('max_gps_accuracy_m', process.env.MAX_GPS_ACCURACY_M || 100));
  if (max > 0 && accuracy > max) {
    throw httpError(
      422,
      `Akurasi GPS ${Math.round(accuracy)} m melebihi batas ${max} m. ` +
        'Aktifkan GPS presisi tinggi lalu coba lagi di area terbuka.'
    );
  }
}

/**
 * GET /api/attendance/today — status presensi hari ini + konteks geofence.
 */
router.get('/today', ah((req, res) => {
  const date = todayLocal();
  const record = db
    .prepare('SELECT * FROM attendance WHERE user_id = ? AND work_date = ?')
    .get(req.user.id, date);

  res.json({
    date,
    record: record || null,
    offices: db.prepare('SELECT id, name, address, lat, lng, radius_m FROM offices WHERE active = 1').all(),
    workStart: getSetting('work_start', '08:00'),
    lateTolerance: Number(getSetting('late_tolerance_minutes', 10)),
    maxAccuracy: Number(getSetting('max_gps_accuracy_m', 100)),
  });
}));

/**
 * POST /api/attendance/check-in
 * WFO wajib berada dalam radius geofence; WFH & Dinas Luar hanya merekam titik.
 */
router.post('/check-in', ah((req, res) => {
  const body = parse(punchSchema, req.body);
  assertAccuracy(body.accuracy);

  const date = todayLocal();
  const existing = db
    .prepare('SELECT id FROM attendance WHERE user_id = ? AND work_date = ?')
    .get(req.user.id, date);
  if (existing) throw httpError(409, 'Anda sudah melakukan check-in hari ini');

  const near = nearestOffice(body.lat, body.lng);
  const inside = near ? near.inside : false;

  if (body.workType === 'WFO') {
    if (!near) throw httpError(422, 'Belum ada titik kantor terdaftar. Hubungi admin.');
    if (!inside) {
      throw httpError(
        422,
        `Presensi WFO ditolak — Anda berada ${near.distance} m dari ${near.office.name} ` +
          `(radius izin ${near.office.radius_m} m). Gunakan tipe WFH atau Dinas Luar bila memang di luar kantor.`
      );
    }
  }

  const at = dayjs().toISOString();
  const { status, lateMinutes } = evaluateLateness(at);
  const photo = saveDataUrlImage(body.photo, `in-${req.user.id}`);

  const info = db
    .prepare(
      `INSERT INTO attendance
        (user_id, work_date, work_type, check_in_at, in_lat, in_lng, in_accuracy_m,
         in_photo, in_address, in_office_id, in_distance_m, in_inside_geofence,
         status, late_minutes, notes)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    )
    .run(
      req.user.id, date, body.workType, at, body.lat, body.lng, body.accuracy,
      photo, body.address || null,
      near ? near.office.id : null,
      near ? near.distance : null,
      inside ? 1 : 0,
      status, lateMinutes, body.notes || null
    );

  res.status(201).json({
    ok: true,
    message: status === 'LATE'
      ? `Check-in tercatat — TERLAMBAT ${lateMinutes} menit`
      : 'Check-in tercatat — TEPAT WAKTU',
    record: db.prepare('SELECT * FROM attendance WHERE id = ?').get(info.lastInsertRowid),
    geofence: near ? { office: near.office.name, distance: near.distance, inside } : null,
  });
}));

/** POST /api/attendance/check-out */
router.post('/check-out', ah((req, res) => {
  const body = parse(punchSchema.partial({ workType: true }), req.body);
  assertAccuracy(body.accuracy);

  const date = todayLocal();
  const record = db
    .prepare('SELECT * FROM attendance WHERE user_id = ? AND work_date = ?')
    .get(req.user.id, date);

  if (!record) throw httpError(404, 'Belum ada check-in hari ini');
  if (record.check_out_at) throw httpError(409, 'Anda sudah melakukan check-out hari ini');

  const near = nearestOffice(body.lat, body.lng);
  const at = dayjs().toISOString();
  const photo = saveDataUrlImage(body.photo, `out-${req.user.id}`);
  const minutes = workMinutes(record.check_in_at, at);

  db.prepare(
    `UPDATE attendance SET
       check_out_at = ?, out_lat = ?, out_lng = ?, out_accuracy_m = ?,
       out_photo = ?, out_address = ?, out_distance_m = ?, work_minutes = ?
     WHERE id = ?`
  ).run(
    at, body.lat, body.lng, body.accuracy, photo, body.address || null,
    near ? near.distance : null, minutes, record.id
  );

  res.json({
    ok: true,
    message: `Check-out tercatat — durasi kerja ${Math.floor(minutes / 60)} jam ${minutes % 60} menit`,
    record: db.prepare('SELECT * FROM attendance WHERE id = ?').get(record.id),
  });
}));

/** Query builder bersama untuk rekap & ekspor. */
function recapRows(query, user) {
  const { from, to } = dateRange(query);
  const params = [from, to];
  let where = 'WHERE a.work_date BETWEEN ? AND ?';

  // Staff hanya melihat datanya sendiri
  if (user.role === 'staff') {
    where += ' AND a.user_id = ?';
    params.push(user.id);
  } else if (query.userId) {
    where += ' AND a.user_id = ?';
    params.push(Number(query.userId));
  }
  if (query.workType && WORK_TYPES.includes(query.workType)) {
    where += ' AND a.work_type = ?';
    params.push(query.workType);
  }
  if (query.status) {
    where += ' AND a.status = ?';
    params.push(query.status);
  }

  const rows = db
    .prepare(
      `SELECT a.*, u.name AS user_name, u.position, o.name AS office_name
         FROM attendance a
         JOIN users u   ON u.id = a.user_id
         LEFT JOIN offices o ON o.id = a.in_office_id
         ${where}
        ORDER BY a.work_date DESC, u.name`
    )
    .all(...params);

  return { from, to, rows };
}

/** GET /api/attendance — rekap dengan ringkasan agregat. */
router.get('/', ah((req, res) => {
  const { from, to, rows } = recapRows(req.query, req.user);
  const summary = {
    total: rows.length,
    ontime: rows.filter((r) => r.status === 'ONTIME').length,
    late: rows.filter((r) => r.status === 'LATE').length,
    totalLateMinutes: rows.reduce((s, r) => s + r.late_minutes, 0),
    byType: WORK_TYPES.reduce((acc, t) => {
      acc[t] = rows.filter((r) => r.work_type === t).length;
      return acc;
    }, {}),
    avgWorkMinutes: rows.length
      ? Math.round(rows.reduce((s, r) => s + r.work_minutes, 0) / rows.length)
      : 0,
  };
  res.json({ from, to, summary, rows });
}));

/** GET /api/attendance/export/excel */
router.get('/export/excel', ah(async (req, res) => {
  const { from, to, rows } = recapRows(req.query, req.user);
  const buffer = await attendanceExcel(rows, { from, to });
  res
    .set('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
    .set('Content-Disposition', `attachment; filename="rekap-absensi-${from}_${to}.xlsx"`)
    .send(buffer);
}));

/** GET /api/attendance/export/pdf */
router.get('/export/pdf', ah(async (req, res) => {
  const { from, to, rows } = recapRows(req.query, req.user);
  const buffer = await attendancePdf(rows, { from, to, company: getSetting('company_name', 'Perusahaan') });
  res
    .set('Content-Type', 'application/pdf')
    .set('Content-Disposition', `attachment; filename="rekap-absensi-${from}_${to}.pdf"`)
    .send(buffer);
}));

/**
 * POST /api/attendance/leave — mencatat izin, cuti, atau alpa.
 *
 * Baris presensi tetap dibuat agar karyawan yang berhalangan tidak menghilang
 * begitu saja dari rekap. Kolom work_type tetap diisi karena skema
 * mensyaratkannya, tetapi yang bermakna adalah kolom status.
 */
const leaveSchema = z.object({
  user_id: z.number().int().positive(),
  work_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  status: z.enum(['LEAVE', 'ABSENT']),
  notes: z.string().max(500).optional().nullable(),
});

router.post('/leave', butuhIzin('presensi.kelola'), ah((req, res) => {
  const body = parse(leaveSchema, req.body);

  const user = db.prepare('SELECT id, name FROM users WHERE id = ? AND active = 1').get(body.user_id);
  if (!user) throw httpError(404, 'Karyawan tidak ditemukan atau tidak aktif');

  const existing = db
    .prepare('SELECT * FROM attendance WHERE user_id = ? AND work_date = ?')
    .get(body.user_id, body.work_date);

  if (existing && existing.check_in_at) {
    throw httpError(
      409,
      `${user.name} sudah melakukan check-in pada ${body.work_date}. ` +
        'Gunakan koreksi status bila memang perlu diubah.'
    );
  }

  if (existing) {
    db.prepare('UPDATE attendance SET status = ?, notes = ? WHERE id = ?')
      .run(body.status, body.notes || null, existing.id);
  } else {
    db.prepare(
      `INSERT INTO attendance (user_id, work_date, work_type, status, notes)
       VALUES (?, ?, 'WFH', ?, ?)`
    ).run(body.user_id, body.work_date, body.status, body.notes || null);
  }

  res.status(201).json({
    ok: true,
    message: `${user.name} ditandai ${body.status === 'LEAVE' ? 'Izin/Cuti' : 'Alpa'} pada ${body.work_date}`,
  });
}));

/** PATCH /api/attendance/:id — koreksi manual oleh admin/manager. */
const correctionSchema = z.object({
  status: z.enum(['ONTIME', 'LATE', 'LEAVE', 'ABSENT']).optional(),
  late_minutes: z.number().int().min(0).optional(),
  notes: z.string().max(500).optional().nullable(),
});

router.patch('/:id', butuhIzin('presensi.kelola'), ah((req, res) => {
  const patch = parse(correctionSchema, req.body);
  const record = db.prepare('SELECT * FROM attendance WHERE id = ?').get(req.params.id);
  if (!record) throw httpError(404, 'Data presensi tidak ditemukan');

  db.prepare('UPDATE attendance SET status = ?, late_minutes = ?, notes = ? WHERE id = ?').run(
    patch.status ?? record.status,
    patch.late_minutes ?? record.late_minutes,
    patch.notes ?? record.notes,
    record.id
  );
  res.json({ ok: true, record: db.prepare('SELECT * FROM attendance WHERE id = ?').get(record.id) });
}));

module.exports = router;
