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
const { checkWriteRules, timeToMinutes } = require('../scheduleRules');

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
  auditCategories: 'audit_category_master', // id = the category number, e.g. '2.13'
  dsrOverrides: 'dsr_override', // admin approvals to file a DSR for a date + beneficiary
  leaveRequests: 'leave_permission', // leave and permission requests
};

// Tables a Facilitator may write, but ONLY for the beneficiary they are
// actively allocated to (their own student list, stock and book stock). The
// value is the column that records who last changed the row; for a
// facilitator the server fills it in from the login so it can't be faked.
// Admins are not restricted. (stockUpdate / bookUpdate screens come next.)
const OWN_BENEFICIARY_STAMP = {
  studentMaster: 'updatedBy',
  stockUpdate: 'lastUpdatedBy',
  bookUpdate: 'lastUpdatedBy',
};

// An Audit Facilitator can do everything a Facilitator can, plus audits.
const isFacilitatorRole = (role) => role === 'Facilitator' || role === 'Audit Facilitator';

async function ownBeneficiaryId(userId) {
  const { rows } = await pool.query(
    `SELECT beneficiary_id FROM beneficiary_resource_allocation
      WHERE active AND (resource1_id = $1 OR resource2_id = $1) LIMIT 1`,
    [userId]
  );
  return rows[0] ? rows[0].beneficiary_id : null;
}

// Returns an error message if this write isn't allowed, else null.
async function ownBeneficiaryCheck(req, clientTable, { record, patch, id }) {
  if (!isFacilitatorRole(req.user?.role) || !OWN_BENEFICIARY_STAMP[clientTable]) return null;
  const mine = await ownBeneficiaryId(req.user.sub);
  if (!mine) return "You aren't assigned to a beneficiary yet. Ask your admin to allocate you.";
  const msg = 'You can only change records for your own assigned beneficiary.';
  if (record && record.beneficiaryId !== mine) return msg;
  if (patch && patch.beneficiaryId !== undefined && patch.beneficiaryId !== mine) return msg;
  if (id) {
    const { rows } = await pool.query(`SELECT beneficiary_id FROM ${sqlTable(clientTable)} WHERE id = $1`, [id]);
    if (rows.length && rows[0].beneficiary_id !== mine) return msg;
  }
  return null;
}

function stampFacilitator(req, clientTable, obj) {
  const column = OWN_BENEFICIARY_STAMP[clientTable];
  if (!isFacilitatorRole(req.user?.role) || !column) return obj;
  return { ...obj, [column]: req.user.sub };
}

// ---- Leave and permission requests -----------------------------------------
// A facilitator may see, add, change and withdraw only THEIR OWN requests, and
// only while they are still Pending; they can't set a status or an admin
// remark. The Admin can do all of it for anyone (including raising a request on
// a resource's behalf and approving or rejecting). The server always records
// who made the change and when.

const LEAVE_TYPES = ['Leave', 'Permission'];
const LEAVE_STATUSES = ['Pending', 'Approved', 'Rejected'];

function validateLeave(rec) {
  if (!rec.resourceId) return 'Choose the resource.';
  if (!LEAVE_TYPES.includes(rec.requestType)) return 'Choose Leave or Permission.';
  if (!LEAVE_STATUSES.includes(rec.status)) return 'Status must be Pending, Approved or Rejected.';
  if (rec.requestType === 'Leave') {
    if (!rec.leaveFrom || !rec.leaveTo) return 'Give the leave from and to dates.';
    if (rec.leaveTo < rec.leaveFrom) return "The leave to date can't be before the from date.";
  } else {
    if (!rec.permissionDate || !rec.permissionFrom || !rec.permissionTo) return 'Give the permission date and the from and to times.';
    const from = timeToMinutes(rec.permissionFrom);
    const to = timeToMinutes(rec.permissionTo);
    if (from === null || to === null) return 'Enter the permission times like 10:30.';
    if (to <= from) return 'The permission end time must be after the start time.';
  }
  return null;
}

// Returns { error, status } to refuse, or { record } / { patch } with the values
// to save, or {} to carry on unchanged.
async function leaveWriteRules(req, { record, patch, id, deleting }) {
  const isAdmin = req.user?.role === 'Admin';
  const stamp = { updatedBy: req.user.sub, updatedAt: new Date().toISOString() };
  // a Leave carries no permission fields and vice versa
  const clearOther = (rec) =>
    rec.requestType === 'Leave'
      ? { permissionDate: null, permissionFrom: null, permissionTo: null }
      : rec.requestType === 'Permission'
        ? { leaveFrom: null, leaveTo: null }
        : {};

  if (record) {
    let rec = { status: 'Pending', ...record };
    if (!isAdmin) rec = { ...rec, resourceId: req.user.sub, status: 'Pending', adminRemarks: null };
    rec = { ...rec, ...clearOther(rec), ...stamp };
    const error = validateLeave(rec);
    return error ? { error, status: 400 } : { record: rec };
  }

  const { rows } = await pool.query('SELECT * FROM leave_permission WHERE id = $1', [id]);
  if (!rows.length) return {}; // the normal route answers "not found"
  const current = rowToRecord(rows[0]);
  if (!isAdmin) {
    if (current.resourceId !== req.user.sub) return { error: 'You can only change your own requests.', status: 403 };
    if (current.status !== 'Pending') {
      return { error: `This request has already been ${current.status.toLowerCase()} and can't be changed.`, status: 409 };
    }
  }
  if (deleting) return {};

  let p = { ...patch };
  if (!isAdmin) {
    delete p.status;
    delete p.resourceId;
    delete p.adminRemarks;
  }
  const merged = { ...current, ...p };
  p = { ...p, ...clearOther(merged), ...stamp };
  const error = validateLeave({ ...merged, ...p });
  return error ? { error, status: 400 } : { patch: p };
}

// Facilitators only ever receive their own leave requests.
function visibleTo(req, clientTable, rows) {
  if (clientTable === 'leaveRequests' && req.user?.role !== 'Admin') return rows.filter((r) => r.resourceId === req.user.sub);
  return rows;
}

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

// A facilitator's DSR must go through POST /api/dsr/save, which enforces
// "one submit per day, no edits after submit"; audits go through
// POST /api/audit/save; only the Admin may grant the approvals that let a
// facilitator file for another date, or change the audit checklist. These tables are
// therefore read-only through the generic routes for everyone except the Admin.
const ADMIN_WRITE_ONLY = new Set(['dsr', 'dsrDetail', 'dsrOverrides', 'audits', 'auditDetail', 'auditCategories']);

router.param('table', (req, res, next, table) => {
  if (!sqlTable(table)) return res.status(404).json({ error: `Unknown table "${table}"` });
  if (req.method !== 'GET' && ADMIN_WRITE_ONLY.has(table) && req.user?.role !== 'Admin') {
    return res.status(403).json({ error: 'DSRs are saved from the DSR screen.' });
  }
  next();
});

// GET /api/:table -- list all records (mainly for debugging; the client
// normally loads everything at once via GET /api/db).
router.get('/:table', async (req, res, next) => {
  try {
    res.json(visibleTo(req, req.params.table, await fetchTable(req.params.table)));
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
    dsr_one_per_resource_beneficiary_day: 'A DSR already exists for this resource, beneficiary and date.',
    audit_visit_number_per_beneficiary: 'That visit number already exists for this beneficiary.',
    audit_detail_audit_category_unique: 'This audit already has an answer for that checklist item.',
    audit_category_master_pkey: 'That category number already exists.',
    dsr_override_unique: 'This facilitator already has an approval for that beneficiary and date.',
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
    leave_permission_leave_ok: "For a leave, give the from and to dates; the to date can't be before the from date.",
    leave_permission_permission_ok: 'For a permission, give the date and the from and to times.',
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

    const ownError = await ownBeneficiaryCheck(req, clientTable, { record });
    if (ownError) return res.status(403).json({ error: ownError });
    record = stampFacilitator(req, clientTable, record);

    if (clientTable === 'leaveRequests') {
      const rules = await leaveWriteRules(req, { record });
      if (rules.error) return res.status(rules.status).json({ error: rules.error });
      record = rules.record;
    }

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

    const ownError = await ownBeneficiaryCheck(req, clientTable, { patch, id: req.params.id });
    if (ownError) return res.status(403).json({ error: ownError });
    patch = stampFacilitator(req, clientTable, patch);

    if (clientTable === 'leaveRequests') {
      const rules = await leaveWriteRules(req, { patch, id: req.params.id });
      if (rules.error) return res.status(rules.status).json({ error: rules.error });
      if (rules.patch) patch = rules.patch;
    }

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
    const ownError = await ownBeneficiaryCheck(req, req.params.table, { id: req.params.id });
    if (ownError) return res.status(403).json({ error: ownError });
    if (req.params.table === 'leaveRequests') {
      const rules = await leaveWriteRules(req, { id: req.params.id, deleting: true });
      if (rules.error) return res.status(rules.status).json({ error: rules.error });
    }
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
