// ---------------------------------------------------------------------------
// Booking rules shared by every route that writes schedule / session /
// attendance rows (the generic CRUD route in routes/tables.js and the Excel
// import in routes/import.js), so the rules can't drift between them.
//
//  SCHEDULE
//   1. A beneficiary can have only ONE session on a given day (whoever the
//      facilitator is).
//   2. A resource (facilitator OR assistant) can't be in two sessions at the
//      same time. A schedule entry only has a start time, so each is treated
//      as lasting SESSION_MINUTES. Keep this in step with SESSION_MINUTES in
//      the app's ScheduleScreen.js.
//  SESSIONS (psr)
//   1. Same as schedule rule 1: one session record per beneficiary per day.
//   2. A resource can't have two session records whose time in/out ranges
//      overlap on the same day (as facilitator or assistant).
//  ATTENDANCE (new check-ins only)
//   A resource can't check in while they are still timed in elsewhere, or
//   at a time that falls inside another of their check-ins that day.
// ---------------------------------------------------------------------------
const SESSION_MINUTES = 60;

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

async function namesOf(pool, ids) {
  if (!ids || ids.length === 0) return [];
  const { rows } = await pool.query('SELECT name FROM resources WHERE id = ANY($1::text[])', [ids]);
  return rows.map((r) => r.name);
}

function beneficiaryLabel(row) {
  if (!row || !row.school) return 'This beneficiary';
  return `${row.school}${row.class ? ' - ' + row.class : ''}${row.section ? ' ' + row.section : ''}`;
}

// ---- Schedule: resource double-booking (start times) -----------------------

// Looks for an existing schedule row that clashes with the given entry.
// Returns { id, time, names } for the first clash, or null. `ignoreId`
// skips the row being edited. An unparseable time can't be compared, so it
// is treated as no clash.
async function findScheduleConflict(pool, { date, time, facilitatorId, assistantId, ignoreId }) {
  const start = timeToMinutes(time);
  const people = [facilitatorId, assistantId].filter(Boolean);
  if (start == null || !date || people.length === 0) return null;

  const { rows } = await pool.query(
    `SELECT id, time, facilitator_id, assistant_id FROM schedule
     WHERE date = $1 AND ($2::text IS NULL OR id <> $2)
       AND (facilitator_id = ANY($3::text[]) OR assistant_id = ANY($3::text[]))`,
    [date, ignoreId || null, people]
  );
  const hit = rows.find((r) => {
    const m = timeToMinutes(r.time);
    return m != null && Math.abs(m - start) < SESSION_MINUTES;
  });
  if (!hit) return null;

  const clashingIds = people.filter((p) => p === hit.facilitator_id || p === hit.assistant_id);
  return { id: hit.id, time: hit.time, names: await namesOf(pool, clashingIds) };
}

function clashMessage(conflict, date) {
  const who = conflict.names.length ? conflict.names.join(' & ') : 'A facilitator or assistant';
  return `Time clash: ${who} already booked at ${conflict.time} on ${date}.`;
}

// ---- Schedule + sessions: one per beneficiary per day -----------------------

async function findBeneficiaryDayConflict(pool, table, { date, beneficiaryId, ignoreId }) {
  if (table !== 'schedule' && table !== 'psr') throw new Error(`unsupported table ${table}`);
  if (!date || !beneficiaryId) return null;
  const { rows } = await pool.query(
    `SELECT t.id, r.name AS facilitator, b.school, b.class, b.section
     FROM ${table} t
     LEFT JOIN resources r ON r.id = t.facilitator_id
     LEFT JOIN beneficiaries b ON b.id = t.beneficiary_id
     WHERE t.date = $1 AND t.beneficiary_id = $2 AND ($3::text IS NULL OR t.id <> $3)
     LIMIT 1`,
    [date, beneficiaryId, ignoreId || null]
  );
  return rows[0] || null;
}

// ---- Sessions: resource time-range overlap ----------------------------------

async function findSessionOverlap(pool, { date, timeIn, timeOut, facilitatorId, assistantId, ignoreId }) {
  const s = timeToMinutes(timeIn);
  const e = timeToMinutes(timeOut);
  const people = [facilitatorId, assistantId].filter(Boolean);
  if (s == null || e == null || e <= s || !date || people.length === 0) return null;

  const { rows } = await pool.query(
    `SELECT id, time_in, time_out, facilitator_id, assistant_id FROM psr
     WHERE date = $1 AND ($2::text IS NULL OR id <> $2)
       AND (facilitator_id = ANY($3::text[]) OR assistant_id = ANY($3::text[]))`,
    [date, ignoreId || null, people]
  );
  const hit = rows.find((r) => {
    const os = timeToMinutes(r.time_in);
    const oe = timeToMinutes(r.time_out);
    return os != null && oe != null && oe > os && s < oe && os < e;
  });
  if (!hit) return null;

  const clashingIds = people.filter((p) => p === hit.facilitator_id || p === hit.assistant_id);
  return { id: hit.id, timeIn: hit.time_in, timeOut: hit.time_out, names: await namesOf(pool, clashingIds) };
}

// ---- Attendance: can't be checked in in two places at once ------------------

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

// ---- One entry point for the write routes -----------------------------------

// `record` uses the client's camelCase field names. Returns an error message
// string if the write would break a rule, or null if it's fine.
async function checkWriteRules(pool, clientTable, record, { ignoreId = null, creating = false } = {}) {
  if (clientTable === 'schedule') {
    const day = await findBeneficiaryDayConflict(pool, 'schedule', { ...record, ignoreId });
    if (day) {
      return `${beneficiaryLabel(day)} already has a session scheduled on ${record.date}${day.facilitator ? ` (${day.facilitator})` : ''}.`;
    }
    const clash = await findScheduleConflict(pool, { ...record, ignoreId });
    if (clash) return clashMessage(clash, record.date);
  }

  if (clientTable === 'psr') {
    const day = await findBeneficiaryDayConflict(pool, 'psr', { ...record, ignoreId });
    if (day) {
      return `${beneficiaryLabel(day)} already has a session record for ${record.date}${day.facilitator ? ` (${day.facilitator})` : ''}.`;
    }
    const clash = await findSessionOverlap(pool, { ...record, ignoreId });
    if (clash) {
      const who = clash.names.length ? clash.names.join(' & ') : 'A facilitator or assistant';
      return `Time clash: ${who} already has a session record from ${clash.timeIn} to ${clash.timeOut} on ${record.date}.`;
    }
  }

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
  SESSION_MINUTES,
  timeToMinutes,
  findScheduleConflict,
  clashMessage,
  findBeneficiaryDayConflict,
  findSessionOverlap,
  findAttendanceConflict,
  checkWriteRules,
};
