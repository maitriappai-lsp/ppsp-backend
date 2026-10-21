// One-off cleanup: converts time_in/time_out values already stored in the
// old locale format (whatever toLocaleTimeString() produced on a given
// phone -- typically '2:05:34 PM', but seconds, leading zeros, spacing and
// AM/PM case can all vary by device) into plain 24-hour 'HH:MM', matching
// what every screen now reads and writes via the clock picker.
//
// Safe to re-run: a value already in HH:MM is left untouched, and only
// rows that actually change are updated. Run once after deploying the
// HH:MM-everywhere change:
//   cd backend && node db/fix-time-format.js
//
// Anything this can't confidently parse is left as-is and printed at the
// end, so it can be fixed by hand (e.g. via the app's own edit screens)
// instead of being silently dropped or guessed at.
require('dotenv').config();
const pool = require('../src/db');

const HHMM = /^\d{2}:\d{2}$/;

// Parses '2:05:34 PM', '2:5 pm', '14:05:34', '14:05', etc. into a plain
// zero-padded 'HH:MM', or returns null if the text isn't recognisable as a
// time at all. Handles the narrow no-break space some locales insert
// before AM/PM.
function toHHMM(value) {
  if (!value) return null;
  const cleaned = String(value).replace(/[\u00a0\u202f]/g, ' ').trim();
  const m = cleaned.match(/^(\d{1,2}):(\d{1,2})(?::\d{1,2})?\s*([AaPp][Mm])?$/);
  if (!m) return null;
  let hours = Number(m[1]);
  const minutes = Number(m[2]);
  const meridiem = m[3] ? m[3].toLowerCase() : null;
  if (minutes > 59) return null;
  if (meridiem) {
    if (hours < 1 || hours > 12) return null;
    if (meridiem === 'pm' && hours !== 12) hours += 12;
    if (meridiem === 'am' && hours === 12) hours = 0;
  } else if (hours > 23) {
    return null;
  }
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
}

async function fixTable(table) {
  const { rows } = await pool.query(
    `SELECT id, time_in, time_out FROM ${table} WHERE
       (time_in IS NOT NULL AND time_in !~ '^[0-9]{2}:[0-9]{2}$')
       OR (time_out IS NOT NULL AND time_out !~ '^[0-9]{2}:[0-9]{2}$')`
  );

  let updated = 0;
  const unparseable = [];

  for (const row of rows) {
    const patch = {};

    if (row.time_in && !HHMM.test(row.time_in)) {
      const fixed = toHHMM(row.time_in);
      if (fixed) patch.time_in = fixed;
      else unparseable.push({ table, id: row.id, column: 'time_in', value: row.time_in });
    }
    if (row.time_out && !HHMM.test(row.time_out)) {
      const fixed = toHHMM(row.time_out);
      if (fixed) patch.time_out = fixed;
      else unparseable.push({ table, id: row.id, column: 'time_out', value: row.time_out });
    }

    if (Object.keys(patch).length === 0) continue;

    const sets = [];
    const values = [];
    let i = 1;
    if (patch.time_in !== undefined) {
      sets.push(`time_in = $${i++}`);
      values.push(patch.time_in);
    }
    if (patch.time_out !== undefined) {
      sets.push(`time_out = $${i++}`);
      values.push(patch.time_out);
    }
    values.push(row.id);
    await pool.query(`UPDATE ${table} SET ${sets.join(', ')} WHERE id = $${i}`, values);
    updated += 1;
  }

  return { checked: rows.length, updated, unparseable };
}

async function main() {
  const attendanceResult = await fixTable('attendance');
  const psrResult = await fixTable('psr');

  console.log(
    `attendance: ${attendanceResult.checked} row(s) needed a look, ${attendanceResult.updated} updated.`
  );
  console.log(`psr: ${psrResult.checked} row(s) needed a look, ${psrResult.updated} updated.`);

  const unparseable = [...attendanceResult.unparseable, ...psrResult.unparseable];
  if (unparseable.length > 0) {
    console.log(`\n${unparseable.length} value(s) could not be parsed and were left as-is:`);
    for (const u of unparseable) {
      console.log(`  ${u.table} ${u.id} ${u.column}: ${JSON.stringify(u.value)}`);
    }
    console.log('Fix these manually, e.g. through the app\'s own attendance/session edit screens.');
  }

  await pool.end();
}

main().catch((err) => {
  console.error('Fix-up failed:', err);
  process.exit(1);
});
