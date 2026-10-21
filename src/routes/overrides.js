// ---------------------------------------------------------------------------
// Attendance override audit log. Mirrors store.js's logOverride(): the
// client sends { resourceId, bypassGeofence, bypassFace, reason, loggedBy },
// the server assigns id + timestamp (never trust the client's clock for an
// audit log) and returns the stored record.
// ---------------------------------------------------------------------------
const express = require('express');
const pool = require('../db');
const { recordToRow, rowToRecord } = require('../caseConvert');

const router = express.Router();

async function nextOverrideId() {
  const { rows } = await pool.query('SELECT COUNT(*)::int AS n FROM overrides');
  return `OVR-${String(rows[0].n + 1).padStart(4, '0')}`;
}

router.get('/', async (req, res, next) => {
  try {
    const { rows } = await pool.query('SELECT * FROM overrides ORDER BY timestamp DESC');
    res.json(rows.map(rowToRecord));
  } catch (err) {
    next(err);
  }
});

router.post('/', async (req, res, next) => {
  try {
    const { resourceId, bypassGeofence, bypassFace, reason, loggedBy } = req.body;
    if (!reason || !reason.trim()) return res.status(400).json({ error: 'reason is required' });
    if (!bypassGeofence && !bypassFace) {
      return res.status(400).json({ error: 'At least one of bypassGeofence/bypassFace must be true' });
    }

    const id = await nextOverrideId();
    const row = recordToRow({ id, resourceId, bypassGeofence: !!bypassGeofence, bypassFace: !!bypassFace, reason, loggedBy });
    const columns = Object.keys(row);
    const values = Object.values(row);
    const placeholders = columns.map((_, i) => `$${i + 1}`).join(', ');

    const { rows } = await pool.query(
      `INSERT INTO overrides (${columns.join(', ')}) VALUES (${placeholders}) RETURNING *`,
      values
    );
    res.status(201).json(rowToRecord(rows[0]));
  } catch (err) {
    next(err);
  }
});

module.exports = router;
