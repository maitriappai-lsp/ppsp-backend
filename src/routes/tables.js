// ---------------------------------------------------------------------------
// Generic CRUD for every "master/transaction" table, mirroring the shape of
// store.js's addRecord(table, record) / updateRecord(table, id, patch) /
// deleteRecord(table, id) on the client.
//
// The client still proposes an id via nextId()/nextIds() (e.g. "SCH-0004"),
// but the server treats that as a hint, not gospel: if it's already taken
// (e.g. because an earlier request partially failed and left a row behind,
// so the client's local count drifted out of sync with the database), the
// server asks Postgres for the true next free number with that prefix and
// retries, instead of just bouncing a 409 back at the user.
//
// 'resources' gets special handling: the client sends a plaintext
// `password` field on create (see MastersScreen.js), which we hash into
// password_hash and never return. 'overrides' and 'systemParameters' are NOT
// served here -- see routes/overrides.js and the systemParameters block in
// server.js's GET /api/db.
// ---------------------------------------------------------------------------
const express = require('express');
const bcrypt = require('bcryptjs');
const pool = require('../db');
const { recordToRow, rowToRecord } = require('../caseConvert');
const { checkWriteRules } = require('../scheduleRules');

const router = express.Router({ mergeParams: true });

// table name (as used by the client / store.js) -> Postgres table name.
// Whitelisted deliberately -- never interpolate a client-supplied table
// name straight into SQL.
const TABLES = {
  resources: 'resources',
  beneficiaries: 'beneficiaries',
  categories: 'categories',
  geo: 'geo',
  schedule: 'schedule',
  psr: 'psr',
  attendance: 'attendance',
  uploads: 'uploads',
  content: 'content',
};

function sqlTable(clientTable) {
  return TABLES[clientTable] || null;
}

// Never let a resource's password hash leave the server.
function scrub(clientTable, record) {
  if (clientTable === 'resources') {
    const { passwordHash, ...rest } = record;
    return rest;
  }
  return record;
}

async function fetchTable(clientTable) {
  const table = sqlTable(clientTable);
  const { rows } = await pool.query(`SELECT * FROM ${table} ORDER BY id`);
  return rows.map((r) => scrub(clientTable, rowToRecord(r)));
}

router.param('table', (req, res, next, table) => {
  if (!sqlTable(table)) return res.status(404).json({ error: `Unknown table "${table}"` });
  next();
});

// GET /api/:table -- list all records (mainly for debugging; the client
// normally loads everything at once via GET /api/db).
router.get('/:table', async (req, res, next) => {
  try {
    res.json(await fetchTable(req.params.table));
  } catch (err) {
    next(err);
  }
});

// POST /api/:table -- create. Body is the full record, including the id
// the client already generated via nextId()/nextIds(). If that id is
// already taken, we self-heal by asking Postgres for the true next free
// number with the same prefix and retrying (see header comment).
function friendlyDuplicateMessage(constraintName) {
  const known = {
    beneficiaries_school_class_section_unique: 'A beneficiary with this School, Class and Section already exists.',
    categories_pillar_topic_subtopic_unique: 'A category with this Pillar, Topic and Sub-topic already exists.',
  };
  return known[constraintName] || 'Duplicate id or unique field';
}

router.post('/:table', async (req, res, next) => {
  try {
    const clientTable = req.params.table;
    const table = sqlTable(clientTable);
    let record = { ...req.body };

    if (!record.id) return res.status(400).json({ error: 'record.id is required' });

    // Booking rules (one session per beneficiary per day, no double-booked
    // resources, no overlapping check-ins) -- see scheduleRules.js.
    const ruleError = await checkWriteRules(pool, clientTable, record, { creating: true });
    if (ruleError) return res.status(409).json({ error: ruleError });

    if (clientTable === 'resources') {
      if (!record.password) {
        return res.status(400).json({ error: 'password is required when creating a resource' });
      }
      const passwordHash = await bcrypt.hash(record.password, 10);
      const { password, ...rest } = record;
      record = { ...rest, passwordHash };
    }

    const idPattern = /^(.+)-(\d+)$/.exec(record.id);
    const maxAttempts = 10;
    let lastErr;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const row = recordToRow(record);
      const columns = Object.keys(row);
      const values = Object.values(row);
      const placeholders = columns.map((_, i) => `$${i + 1}`).join(', ');

      try {
        const { rows } = await pool.query(
          `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${placeholders}) RETURNING *`,
          values
        );
        return res.status(201).json(scrub(clientTable, rowToRecord(rows[0])));
      } catch (err) {
        const isIdConflict = err.code === '23505' && /_pkey$/.test(err.constraint || '');
        if (!isIdConflict || !idPattern) {
          if (err.code === '23505') {
            return res.status(409).json({ error: friendlyDuplicateMessage(err.constraint), detail: err.detail });
          }
          throw err;
        }

        lastErr = err;
        const [, prefix, numStr] = idPattern;
        const width = numStr.length;
        // Strictly "prefix-digits" only -- a LIKE '%' match would also pick
        // up a different prefix that happens to start the same way (e.g.
        // 'ATT-OV-0009' when prefix is 'ATT'), whose non-numeric suffix
        // then breaks the CAST below.
        const escapedPrefix = prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const { rows: maxRows } = await pool.query(
          `SELECT COALESCE(MAX(CAST(SUBSTRING(id FROM LENGTH($1) + 2) AS INTEGER)), 0) AS max_n
           FROM ${table} WHERE id ~ $2`,
          [prefix, `^${escapedPrefix}-[0-9]+$`]
        );
        const nextN = Number(maxRows[0].max_n) + 1 + attempt; // +attempt covers a same-instant race
        record = { ...record, id: `${prefix}-${String(nextN).padStart(width, '0')}` };
      }
    }
    return res.status(409).json({ error: 'Could not assign a free id after several attempts', detail: lastErr?.detail });
  } catch (err) {
    next(err);
  }
});

// PATCH /api/:table/:id -- partial update (store.js's updateRecord patch).
router.patch('/:table/:id', async (req, res, next) => {
  try {
    const clientTable = req.params.table;
    const table = sqlTable(clientTable);
    let patch = { ...req.body };
    delete patch.id; // id is not patchable

    if (clientTable === 'resources' && patch.password) {
      patch.passwordHash = await bcrypt.hash(patch.password, 10);
      delete patch.password;
    }

    const row = recordToRow(patch);
    const columns = Object.keys(row);
    if (columns.length === 0) return res.status(400).json({ error: 'Empty patch' });

    // Only re-check when the patch touches something a rule depends on. The
    // check runs on the row as it WOULD be after the patch (existing values
    // merged with the patch), ignoring the row itself.
    const RULE_FIELDS = {
      schedule: ['date', 'time', 'beneficiaryId', 'facilitatorId', 'assistantId'],
      psr: ['date', 'timeIn', 'timeOut', 'beneficiaryId', 'facilitatorId', 'assistantId'],
    };
    if (RULE_FIELDS[clientTable] && RULE_FIELDS[clientTable].some((k) => k in patch)) {
      const { rows: current } = await pool.query(`SELECT * FROM ${table} WHERE id = $1`, [req.params.id]);
      if (current.length > 0) {
        const merged = { ...rowToRecord(current[0]), ...patch };
        const ruleError = await checkWriteRules(pool, clientTable, merged, { ignoreId: req.params.id });
        if (ruleError) return res.status(409).json({ error: ruleError });
      }
    }

    const setClause = columns.map((c, i) => `${c} = $${i + 1}`).join(', ');
    const values = Object.values(row);

    const { rows } = await pool.query(
      `UPDATE ${table} SET ${setClause} WHERE id = $${columns.length + 1} RETURNING *`,
      [...values, req.params.id]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Not found' });
    res.json(scrub(clientTable, rowToRecord(rows[0])));
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ error: friendlyDuplicateMessage(err.constraint), detail: err.detail });
    }
    next(err);
  }
});

// DELETE /api/:table/:id
router.delete('/:table/:id', async (req, res, next) => {
  try {
    const table = sqlTable(req.params.table);
    const { rowCount } = await pool.query(`DELETE FROM ${table} WHERE id = $1`, [req.params.id]);
    if (rowCount === 0) return res.status(404).json({ error: 'Not found' });
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

module.exports = { router, TABLES, fetchTable };
