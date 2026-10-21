// GET /api/attendance-open?date=YYYY-MM-DD
// Returns the signed-in user's open (no time_out) attendance record for
// that date, or { record: null } if there isn't one.
//
// This exists specifically for the mobile app's background geofencing
// task: that task runs outside the React tree (no access to the already-
// loaded `db` state from data/store.js) and needs to check "do I have an
// open session to close?" as cheaply as possible -- pulling the entire
// database via GET /api/db just to answer that one question would be slow
// and wasteful to run from a background task. `date` is passed by the
// client (computed the same way the rest of the app computes "today",
// i.e. local to the phone) rather than guessed server-side, since the
// server's own clock/timezone has no reason to match the phone's.
const express = require('express');
const pool = require('../db');
const { rowToRecord } = require('../caseConvert');

const router = express.Router();

router.get('/', async (req, res, next) => {
  try {
    const date = req.query.date;
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return res.status(400).json({ error: 'date query param (YYYY-MM-DD) is required' });
    }
    const facilitatorId = req.user.sub;
    // Joined to beneficiaries so the response carries which geofence this
    // check-in actually belongs to (checked_in_geo_id) -- the background
    // task uses this to ignore an exit from an unrelated, nearby geofence
    // rather than acting on any registered region's exit.
    const { rows } = await pool.query(
      `SELECT a.*, b.geo_id AS checked_in_geo_id
       FROM attendance a
       LEFT JOIN beneficiaries b ON b.id = a.beneficiary_id
       WHERE a.facilitator_id = $1 AND a.date = $2 AND (a.time_out IS NULL OR a.time_out = '')
       ORDER BY a.id DESC LIMIT 1`,
      [facilitatorId, date]
    );
    res.json({ record: rows[0] ? rowToRecord(rows[0]) : null });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
