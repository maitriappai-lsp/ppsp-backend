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
  attendance: 'attendance',
  uploads: 'uploads',
  content: 'content',

  // ---- PPSP ----
  // (Schedule and Sessions/psr are gone from PPSP.)
  materialMaster: 'material_master',
  studentMaster: 'student_master',
  bookMaster: 'book_master',
  allocations: 'beneficiary_resource_allocation',
  stockUpdate: 'stock_update',
  bookUpdate: 'book_update',
  dsr: 'dsr_header',
  dsrDetail: 'dsr_detail',
  audits: 'audit_header',
  auditDetail: 'audit_detail',
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
function friendlyDuplicateMessage(constraintName, err) {
  const known = {
    beneficiaries_school_class_section_unique: 'A beneficiary with this School, Class and Section already exists.',
    categories_pillar_topic_subtopic_unique: 'A category with this Pillar, Topic and Sub-topic already exists.',
    material_master_category_name_type_unique: 'A material with this Category, Name and Type already exists.',
    allocation_active_resource1_unique: 'That resource is already in another active allocation. Make that one inactive first.',
    allocation_active_resource2_unique: 'That resource is already in another active allocation. Make that one inactive first.',
    stock_update_beneficiary_material_unique: 'Stock for this material already exists for this beneficiary -- edit that row instead.',
    book_update_beneficiary_book_unique: 'This book already exists for this beneficiary -- edit that row instead.',
    dsr_one_per_resource_per_day: 'A DSR already exists for this resource on this date.',
    audit_visit_number_per_beneficiary: 'That visit number already exists for this beneficiary.',
    audit_detail_audit_category_unique: 'This audit already has an answer for that checklist item.',
  };
  if (known[constraintName]) return known[constraintName];
  // The allocation trigger raises its own readable message.
  if (err && /only one active/i.test(err.message || '')) return err.message;
  return 'Duplicate id or unique field';
}

function friendlyCheckMessage(constraintName) {
  const known = {
    dsr_submitted_is_complete: 'A submitted DSR needs time in, both child counts and all three RAG ratings.',
    allocation_distinct_resources: 'Resource 1 and Resource 2 must be different people.',
    audit_distinct_facilitators: 'Facilitator 1 and Facilitator 2 must be different people.',
    audit_submitted_has_timestamp: 'A submitted audit needs a submitted time.',
  };
  return known[constraintName] || 'A value is out of range, or a required field is missing.';
}

// Turns the Postgres errors the PPSP tables can raise on purpose (unique,
// foreign-key and check constraints) into a readable 4xx instead of a
// generic 500. Returns null for anything else.
function mapDbError(err) {
  if (err.code === '23505') {
    return { status: 409, body: { error: friendlyDuplicateMessage(err.constraint, err), detail: err.detail } };
  }
  if (err.code === '23503') {
    const stillUsed = /is still referenced/i.test(err.detail || '');
    return {
      status: 409,
      body: {
        error: stillUsed
          ? "This record is still used by other records (for example students, allocations, stock, DSRs or attendance), so it can't be deleted. Remove or reassign those first."
          : "A linked record (beneficiary, resource, material or book) doesn't exist.",
        detail: err.detail,
      },
    };
  }
  if (err.code === '23514') {
    return { status: 400, body: { error: friendlyCheckMessage(err.constraint), detail: err.detail } };
  }
  if (err.code === '22P02' || err.code === '22007' || err.code === '22008') {
    return { status: 400, body: { error: 'One of the values has an invalid format.', detail: err.message } };
  }
  return null;
}

router.post('/:table', async (req, res, next) => {
  try {
    const clientTable = req.params.table;
    const table = sqlTable(clientTable);
    let record = { ...req.body };

    if (!record.id) return res.status(400).json({ error: 'record.id is required' });

    // Write rules (currently: no overlapping attendance check-ins) -- see scheduleRules.js.
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
          const mapped = mapDbError(err);
          if (mapped) return res.status(mapped.status).json(mapped.body);
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

    const setClause = columns.map((c, i) => `${c} = $${i + 1}`).join(', ');
    const values = Object.values(row);

    const { rows } = await pool.query(
      `UPDATE ${table} SET ${setClause} WHERE id = $${columns.length + 1} RETURNING *`,
      [...values, req.params.id]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Not found' });
    res.json(scrub(clientTable, rowToRecord(rows[0])));
  } catch (err) {
    const mapped = mapDbError(err);
    if (mapped) return res.status(mapped.status).json(mapped.body);
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
    const mapped = mapDbError(err);
    if (mapped) return res.status(mapped.status).json(mapped.body);
    next(err);
  }
});

module.exports = { router, TABLES, fetchTable };
