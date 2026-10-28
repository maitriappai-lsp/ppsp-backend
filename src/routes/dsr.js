// ---------------------------------------------------------------------------
// POST /api/dsr/save -- the facilitator's Daily Status Report.
//
// A DSR is a header (one per facilitator per day) plus lines (materials used,
// with the students who worked on each). The screen sends the whole thing in
// one request and this route writes it in one transaction, so a report is
// never left half-saved.
//
// Rules enforced here (not just in the app):
//   * Only a Facilitator files a DSR, and always as THEMSELVES -- the resource
//     is taken from the login token, never from the request.
//   * Only for TODAY (in APP_TIMEZONE, default Asia/Kolkata) -- with two
//     exceptions. (1) An ADMIN APPROVAL (dsr_override: this facilitator, this
//     date, this beneficiary, set up in the admin Override screen) opens that one
//     date for that one beneficiary, and also waives the attendance rule below;
//     it can never be for a future date. (2) a DSR written on the phone while OFFLINE is uploaded later,
//     possibly after midnight, so a save marked `offlineQueued` is accepted
//     for up to DSR_MAX_BACKDATE_DAYS (default 3) days back, never the future.
//     For those, the time the facilitator pressed Submit is kept as the
//     submitted time.
//   * Only for a beneficiary the facilitator has an ATTENDANCE record at on that
//     day (they must have timed in there first) -- for an offline DSR uploaded
//     later, the check is made against the DSR's own date.
//   * The beneficiary is chosen by the facilitator (the app defaults it to
//     where they checked in today), so covering another beneficiary is fine.
//   * ONE DSR per facilitator, per beneficiary, per day (two resources can
//     share a beneficiary; one resource can cover several in a day). Any number
//     of SAVEs while it is a Draft (each one replaces the previous draft's
//     contents) but only ONE SUBMIT: once Submitted, further saves are
//     refused. Repeating a save is harmless, which is what lets the phone
//     safely retry an upload. The database also guarantees the one-per-day
//     rule, and that a submitted DSR is complete.
//   * Every material line needs at least one student, and each student must be
//     on the chosen beneficiary's list; an activity must be one of the chosen
//     material's activities; EPL materials must be in the EPL category.
//
// Admins edit DSRs from the admin dashboard through the generic table routes
// (routes/tables.js); those are closed to facilitators.
// ---------------------------------------------------------------------------
const express = require('express');
const pool = require('../db');
const { rowToRecord } = require('../caseConvert');

const router = express.Router();

const RAGS = ['Green', 'Amber', 'Red'];
const CIRCLE_TIME = [
  'Story book',
  'Good habits',
  'Zero activity & other presentation',
  'Correction details',
  'Material name game',
  'Others',
];

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function todayInAppTimezone() {
  const timeZone = process.env.APP_TIMEZONE || 'Asia/Kolkata';
  // 'en-CA' formats as YYYY-MM-DD.
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}

const MAX_BACKDATE_DAYS = Number(process.env.DSR_MAX_BACKDATE_DAYS || 3);

// 'YYYY-MM-DD' plus/minus whole days.
function shiftDate(ymd, days) {
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// The phone's own "submitted at" time for an offline DSR, if it is believable
// (not in the future, not older than the backdate window); otherwise now.
function clientTimeOrNow(value) {
  const t = Date.parse(value);
  const now = Date.now();
  if (!Number.isFinite(t) || t > now || now - t > (MAX_BACKDATE_DAYS + 1) * 86400000) return new Date();
  return new Date(t);
}

function textOrNull(v) {
  const s = String(v ?? '').trim();
  return s ? s : null;
}

function countOrNull(v, label) {
  if (v === '' || v === null || v === undefined) return null;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0) throw new HttpError(400, `${label} must be a whole number, 0 or more.`);
  return n;
}

function ragOrNull(v, label) {
  if (!v) return null;
  if (!RAGS.includes(v)) throw new HttpError(400, `${label} must be Green, Amber or Red.`);
  return v;
}

router.post('/save', async (req, res, next) => {
  const client = await pool.connect();
  try {
    if (req.user.role !== 'Facilitator') {
      throw new HttpError(403, 'Only facilitators file a DSR from here. Admins edit DSRs from the dashboard.');
    }
    const me = req.user.sub;
    const { date, submit = false, header = {}, lines = [], offlineQueued = false, submittedAt: clientSubmittedAt } = req.body || {};

    const today = todayInAppTimezone();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date))) throw new HttpError(400, 'The DSR date is missing.');
    if (!Array.isArray(lines)) throw new HttpError(400, 'Lines must be a list.');

    // ---- header values ------------------------------------------------
    const h = {
      timeIn: textOrNull(header.timeIn),
      childrenMorning: countOrNull(header.childrenMorning, 'Number of children at 9.30 am'),
      childrenAfternoon: countOrNull(header.childrenAfternoon, 'Number of active children 12.30 to 2 pm'),
      stockRag: ragOrNull(header.stockRag, 'Stock RAG rating'),
      stockRemarks: textOrNull(header.stockRemarks),
      bookRag: ragOrNull(header.bookRag, 'Book RAG rating'),
      overallRag: ragOrNull(header.overallRag, 'Overall day RAG rating'),
      circleTime: [],
      eplMaterialsUsed: [],
      remarks: textOrNull(header.remarks),
    };
    const picked = Array.isArray(header.circleTimeActivities) ? header.circleTimeActivities : [];
    for (const a of picked) {
      if (!CIRCLE_TIME.includes(a)) throw new HttpError(400, `"${a}" is not a circle time activity.`);
    }
    h.circleTime = [...new Set(picked)];

    if (submit) {
      const missing = [];
      if (!h.timeIn) missing.push('Facilitator time in');
      if (h.childrenMorning === null) missing.push('Children at 9.30 am');
      if (h.childrenAfternoon === null) missing.push('Active children 12.30 to 2 pm');
      if (!h.stockRag) missing.push('Stock RAG rating');
      if (!h.bookRag) missing.push('Book RAG rating');
      if (!h.overallRag) missing.push('Overall day RAG rating');
      if (missing.length) throw new HttpError(400, `Please fill in: ${missing.join(', ')}.`);
    }

    // ---- beneficiary + EPL materials ---------------------------------
    const beneficiaryId = textOrNull(header.beneficiaryId);
    if (!beneficiaryId) throw new HttpError(400, 'Choose the beneficiary.');
    const ben = await client.query('SELECT 1 FROM beneficiaries WHERE id = $1', [beneficiaryId]);
    if (!ben.rows.length) throw new HttpError(400, "That beneficiary doesn't exist.");

    // ---- admin approval for this facilitator + date + beneficiary? -----
    const approval = await client.query(
      'SELECT 1 FROM dsr_override WHERE resource_id = $1 AND dsr_date = $2 AND beneficiary_id = $3 AND active LIMIT 1',
      [me, date, beneficiaryId]
    );
    const approved = approval.rows.length > 0;

    // ---- the date --------------------------------------------------------
    if (date > today) throw new HttpError(400, "A DSR can't be filed for a future date.");
    if (date !== today && !approved) {
      if (!offlineQueued) {
        throw new HttpError(400, 'A DSR can only be filed for today, unless your admin has approved another date for you.');
      }
      if (date < shiftDate(today, -MAX_BACKDATE_DAYS)) {
        throw new HttpError(400, `This DSR (${date}) is too old to upload from the app. Ask your admin to approve it for you.`);
      }
    }

    // ---- attendance first (waived by an approval) ------------------------
    if (!approved) {
      const attended = await client.query(
        'SELECT 1 FROM attendance WHERE facilitator_id = $1 AND date = $2 AND beneficiary_id = $3 LIMIT 1',
        [me, date, beneficiaryId]
      );
      if (!attended.rows.length) {
        throw new HttpError(
          400,
          "You can only file a DSR for a beneficiary you've marked attendance at on that day. Mark your time in there on the Attendance screen first, or ask your admin to approve this DSR."
        );
      }
    }

    const eplPicked = Array.isArray(header.eplMaterialsUsed) ? [...new Set(header.eplMaterialsUsed)] : [];
    if (eplPicked.length) {
      const epl = await client.query(
        "SELECT id FROM material_master WHERE id = ANY($1::text[]) AND LOWER(TRIM(category)) = 'epl'",
        [eplPicked]
      );
      if (epl.rows.length !== eplPicked.length) throw new HttpError(400, "One of the EPL materials isn't in the EPL category.");
    }
    h.eplMaterialsUsed = eplPicked;

    // ---- lines ---------------------------------------------------------
    const materialIds = [...new Set(lines.map((l) => l.materialId).filter(Boolean))];
    const materials = {};
    if (materialIds.length) {
      const m = await client.query('SELECT id, activities FROM material_master WHERE id = ANY($1::text[])', [materialIds]);
      m.rows.forEach((r) => (materials[r.id] = r.activities || []));
    }
    const allStudentIds = [...new Set(lines.flatMap((l) => (Array.isArray(l.studentIds) ? l.studentIds : [])))];
    if (allStudentIds.length) {
      const s = await client.query('SELECT id FROM student_master WHERE id = ANY($1::text[]) AND beneficiary_id = $2', [allStudentIds, beneficiaryId]);
      if (s.rows.length !== allStudentIds.length) {
        throw new HttpError(400, "One of the students isn't on the chosen beneficiary's student list.");
      }
    }
    const cleanLines = lines.map((l, i) => {
      const n = i + 1;
      if (!l.materialId || !materials[l.materialId]) throw new HttpError(400, `Line ${n}: choose a material.`);
      if (!['M', 'A'].includes(l.sessionPeriod)) throw new HttpError(400, `Line ${n}: choose Morning or Afternoon.`);
      if (!Array.isArray(l.studentIds) || l.studentIds.length === 0) throw new HttpError(400, `Line ${n}: choose at least one student.`);
      const activity = textOrNull(l.materialActivity);
      if (activity && !materials[l.materialId].includes(activity)) {
        throw new HttpError(400, `Line ${n}: "${activity}" isn't one of that material's activities.`);
      }
      return { materialId: l.materialId, activity, period: l.sessionPeriod, studentIds: [...new Set(l.studentIds || [])] };
    });

    // ---- write ---------------------------------------------------------
    await client.query('BEGIN');
    const existing = await client.query(
      'SELECT id, status FROM dsr_header WHERE resource_id = $1 AND dsr_date = $2 AND beneficiary_id = $3 FOR UPDATE',
      [me, date, beneficiaryId]
    );
    if (existing.rows[0] && existing.rows[0].status === 'Submitted') {
      throw new HttpError(409, 'This DSR has already been submitted and can\'t be changed.');
    }
    const status = submit ? 'Submitted' : 'Draft';
    const submittedAt = submit ? (offlineQueued ? clientTimeOrNow(clientSubmittedAt) : new Date()) : null;
    const dsrId = existing.rows[0] ? existing.rows[0].id : `DSR-${date.replace(/-/g, '')}-${me}-${beneficiaryId}`;

    const values = [
      beneficiaryId, h.timeIn, h.childrenMorning, h.childrenAfternoon, h.stockRag, h.stockRemarks,
      h.bookRag, h.overallRag, h.circleTime, h.eplMaterialsUsed, h.remarks, status, submittedAt,
    ];
    if (existing.rows[0]) {
      await client.query(
        `UPDATE dsr_header SET beneficiary_id=$1, time_in=$2, children_morning=$3, children_afternoon=$4,
           stock_rag=$5, stock_remarks=$6, book_rag=$7, overall_rag=$8, circle_time_activities=$9,
           epl_materials_used=$10, remarks=$11, status=$12, submitted_at=$13, updated_at=now()
         WHERE id=$14`,
        [...values, dsrId]
      );
      await client.query('DELETE FROM dsr_detail WHERE dsr_id = $1', [dsrId]); // students go with them (cascade)
    } else {
      await client.query(
        `INSERT INTO dsr_header (beneficiary_id, time_in, children_morning, children_afternoon, stock_rag,
           stock_remarks, book_rag, overall_rag, circle_time_activities, epl_materials_used, remarks,
           status, submitted_at, id, resource_id, dsr_date)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
        [...values, dsrId, me, date]
      );
    }

    for (const [i, l] of cleanLines.entries()) {
      const lineId = `${dsrId}-L${i + 1}`;
      await client.query(
        'INSERT INTO dsr_detail (id, dsr_id, material_id, material_activity, session_period) VALUES ($1,$2,$3,$4,$5)',
        [lineId, dsrId, l.materialId, l.activity, l.period]
      );
      for (const studentId of l.studentIds) {
        await client.query('INSERT INTO dsr_detail_students (dsr_detail_id, student_id) VALUES ($1,$2)', [lineId, studentId]);
      }
    }
    const saved = await client.query('SELECT * FROM dsr_header WHERE id = $1', [dsrId]);
    await client.query('COMMIT');
    res.json({ dsr: rowToRecord(saved.rows[0]) });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
    if (err.code === '23505') {
      return res.status(409).json({ error: 'A DSR for this beneficiary and day already exists. Reload the screen and try again.' });
    }
    if (err.code === '23514') {
      return res.status(400).json({ error: 'A submitted DSR needs time in, both child counts and all three RAG ratings.' });
    }
    next(err);
  } finally {
    client.release();
  }
});

module.exports = router;
