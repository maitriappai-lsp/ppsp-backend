require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const pool = require('./db');
const requireAuth = require('./middleware/requireAuth');
const { router: authRouter } = require('./routes/auth');
const { router: tablesRouter, TABLES, fetchTable } = require('./routes/tables');
const overridesRouter = require('./routes/overrides');
const filesRouter = require('./routes/files');
const exportRouter = require('./routes/export');
const importRouter = require('./routes/import');
const attendanceOpenRouter = require('./routes/attendanceOpen');
const dsrRouter = require('./routes/dsr');
const { rowToRecord } = require('./caseConvert');

const app = express();
const PORT = process.env.PORT || 4000;

app.use(cors());
app.use(express.json());
app.use('/uploads', express.static(path.join(__dirname, '..', 'uploads')));

app.get('/health', (req, res) => res.json({ ok: true }));

// Public: login + forced password change happen before a token exists.
app.use('/api/auth', authRouter);

// Everything else requires a valid session token.
app.use('/api', requireAuth);

// GET /api/db -- the client's single "give me everything" call on startup,
// matching the shape of store.js's initial `db` state object: one key per
// table in routes/tables.js's TABLES (resources, beneficiaries, ...,
// materialMaster, studentMaster, bookMaster, allocations, stockUpdate,
// bookUpdate, dsr, dsrDetail, audits, auditDetail, auditCategories) plus
// overrides and systemParameters.
app.get('/api/db', async (req, res, next) => {
  try {
    const keys = Object.keys(TABLES);
    const tables = await Promise.all(keys.map(fetchTable));
    const data = {};
    keys.forEach((k, i) => {
      data[k] = tables[i];
    });
    // A facilitator only receives their own leave and permission requests.
    if (req.user?.role !== 'Admin') {
      data.leaveRequests = (data.leaveRequests || []).filter((r) => r.resourceId === req.user.sub);
    }
    const { rows: overrideRows } = await pool.query('SELECT * FROM overrides ORDER BY timestamp DESC');
    const { rows: spRows } = await pool.query('SELECT * FROM system_parameters LIMIT 1');
    // Which students worked on each DSR line (read-only here; written by the DSR screens).
    const { rows: dsrStudentRows } = await pool.query('SELECT * FROM dsr_detail_students');

    res.json({
      ...data,
      dsrDetailStudents: dsrStudentRows.map(rowToRecord),
      overrides: overrideRows.map(rowToRecord),
      systemParameters: spRows[0] ? rowToRecord(spRows[0]) : null,
    });
  } catch (err) {
    next(err);
  }
});

app.use('/api/overrides', overridesRouter);
app.use('/api/files', filesRouter);
app.use('/api/export', exportRouter);
app.use('/api/import', importRouter);
app.use('/api/attendance-open', attendanceOpenRouter);
app.use('/api/dsr', dsrRouter); // facilitator DSR save/submit (must come before the generic table routes)
app.use('/api', tablesRouter);

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Internal server error', detail: process.env.NODE_ENV === 'production' ? undefined : err.message });
});

app.listen(PORT, () => {
  console.log(`Maitri PPSP backend listening on http://localhost:${PORT}`);
});
