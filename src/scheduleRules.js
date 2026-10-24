// ---------------------------------------------------------------------------
// Write rules shared by the routes that write attendance rows (the generic
// CRUD route in routes/tables.js).
//
// PPSP has no Schedule and no Sessions (psr), so the booking rules that used
// to live here for those two tables are gone. What is left:
//
//  ATTENDANCE (new check-ins only)
//   A resource can't check in while they are still timed in elsewhere, or
//   at a time that falls inside another of their check-ins that day.
// ---------------------------------------------------------------------------

// "10:00" or "10:00 AM" -> minutes since midnight, or null if unparseable.
function timeToMinutes(t) {
  const m = /^\s*(\d{1,2}):(\d{2})\s*([AaPp][Mm])?\s*$/.exec(String(t || ''));
  if (!m) return null;
  let h = Number(m[1]);
  const min = Number(m[2]);
  const ap = m[3] && m[3].toLowerCase();
  if (min > 59) return null;
  if (ap) {
    if (h < 1 || h > 12) return null;
    if (ap === 'pm' && h !== 12) h += 12;
    if (ap === 'am' && h === 12) h = 0;
  } else if (h > 23) {
    return null;
  }
  return h * 60 + min;
}

async function findAttendanceConflict(pool, { date, timeIn, facilitatorId, ignoreId }) {
  if (!date || !facilitatorId) return null;
  const s = timeToMinutes(timeIn);
  const { rows } = await pool.query(
    `SELECT id, time_in, time_out FROM attendance
     WHERE date = $1 AND facilitator_id = $2 AND ($3::text IS NULL OR id <> $3)`,
    [date, facilitatorId, ignoreId || null]
  );
  return (
    rows.find((r) => {
      if (!r.time_out) return true; // still timed in elsewhere
      const os = timeToMinutes(r.time_in);
      const oe = timeToMinutes(r.time_out);
      return s != null && os != null && oe != null && os <= s && s < oe;
    }) || null
  );
}

// `record` uses the client's camelCase field names. Returns an error message
// string if the write would break a rule, or null if it's fine.
async function checkWriteRules(pool, clientTable, record, { ignoreId = null, creating = false } = {}) {
  if (clientTable === 'attendance' && creating) {
    const clash = await findAttendanceConflict(pool, { ...record, ignoreId });
    if (clash) {
      return clash.time_out
        ? `Time clash: already checked in from ${clash.time_in} to ${clash.time_out} on ${record.date}.`
        : `Time clash: already timed in at ${clash.time_in} on ${record.date} and not timed out yet.`;
    }
  }
  return null;
}

module.exports = {
  timeToMinutes,
  findAttendanceConflict,
  checkWriteRules,
};
