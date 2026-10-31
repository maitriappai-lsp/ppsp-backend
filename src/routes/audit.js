// ---------------------------------------------------------------------------
// POST /api/audit/save -- an AUDIT VISIT, recorded by an Audit Facilitator.
//
// An audit is a header (date, times, beneficiary, the facilitator(s) at that
// beneficiary, remarks, a visit number) plus one detail row per checklist
// question answered (Y / N / NA / UN, a rating 1-4, remarks). The screen sends
// the whole thing and this route writes it in one transaction.
//
// Rules enforced here:
//   * Only an Audit Facilitator records audits, and they are recorded as that
//     person (auditor_id comes from the login, never the request).
//   * SAVE as often as needed while it is a Draft; SUBMIT once. After that it
//     can't be changed (by the audit facilitator, or by anyone through this
//     route) and nothing here deletes an audit. The Admin corrects or removes
//     audits from the admin side.
//   * The visit number (1, 2, 3 ... per beneficiary) is assigned by the
//     database when the audit is first saved, so it can't be chosen or clash.
//   * The beneficiary must exist, the date can't be in the future, the end time
//     must be after the start time, Facilitator 2 must differ from Facilitator
//     1, and every answered question must be an active checklist question.
//   * To submit: date, beneficiary, time from, time to and Facilitator 1 are
//     required. (Unanswered questions are allowed; the app asks first.)
// ---------------------------------------------------------------------------
const express = require('express');
const pool = require('../db');
const { rowToRecord } = require('../caseConvert');
const { timeToMinutes } = require('../scheduleRules');

const router = express.Router();

const FLAGS = ['Y', 'N', 'NA', 'UN'];

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function todayInAppTimezone() {
  const timeZone = process.env.APP_TIMEZONE || 'Asia/Kolkata';
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}

function textOrNull(v) {
  const s = String(v ?? '').trim();
  return s ? s : null;
}

router.post('/save', async (req, res, next) => {
  const client = await pool.connect();
  try {
    if (req.user.role !== 'Audit Facilitator') {
      throw new HttpError(403, 'Only an audit facilitator can record an audit visit.');
    }
    const me = req.user.sub;
    const { id = null, submit = false, header = {}, details = [] } = req.body || {};
    if (!Array.isArray(details)) throw new HttpError(400, 'Details must be a list.');

    // ---- header ----------------------------------------------------------
    const h = {
      auditDate: textOrNull(header.auditDate),
      timeFrom: textOrNull(header.timeFrom),
      timeTo: textOrNull(header.timeTo),
      beneficiaryId: textOrNull(header.beneficiaryId),
      facilitator1Id: textOrNull(header.facilitator1Id),
      facilitator2Id: textOrNull(header.facilitator2Id),
      visitRemarks: textOrNull(header.visitRemarks),
    };
    if (!h.beneficiaryId) throw new HttpError(400, 'Choose the beneficiary.');
    if (!h.auditDate || !/^\d{4}-\d{2}-\d{2}$/.test(h.auditDate)) throw new HttpError(400, 'Choose the audit date.');
    if (h.auditDate > todayInAppTimezone()) throw new HttpError(400, "The audit date can't be in the future.");

    const from = h.timeFrom ? timeToMinutes(h.timeFrom) : null;
    const to = h.timeTo ? timeToMinutes(h.timeTo) : null;
    if ((h.timeFrom && from === null) || (h.timeTo && to === null)) throw new HttpError(400, 'Enter the times like 10:30.');
    if (from !== null && to !== null && to <= from) throw new HttpError(400, 'The end time must be after the start time.');
    if (h.facilitator1Id && h.facilitator1Id === h.facilitator2Id) {
      throw new HttpError(400, 'Facilitator 1 and Facilitator 2 must be different people.');
    }
    if (submit) {
      const missing = [];
      if (!h.timeFrom) missing.push('Time from');
      if (!h.timeTo) missing.push('Time to');
      if (!h.facilitator1Id) missing.push('Facilitator 1');
      if (missing.length) throw new HttpError(400, `Please fill in: ${missing.join(', ')}.`);
    }

    const ben = await client.query('SELECT 1 FROM beneficiaries WHERE id = $1', [h.beneficiaryId]);
    if (!ben.rows.length) throw new HttpError(400, "That beneficiary doesn't exist.");
    const facIds = [h.facilitator1Id, h.facilitator2Id].filter(Boolean);
    if (facIds.length) {
      const f = await client.query(
        "SELECT id FROM resources WHERE id = ANY($1::text[]) AND role IN ('Facilitator', 'Audit Facilitator')",
        [facIds]
      );
      if (f.rows.length !== new Set(facIds).size) throw new HttpError(400, 'Facilitators must be facilitators.');
    }

    // ---- details: answered, active, non-heading checklist questions only ----
    const answers = new Map();
    for (const d of details) {
      const categoryNo = textOrNull(d.categoryNo);
      const statusFlag = textOrNull(d.statusFlag);
      const remarks = textOrNull(d.remarks);
      const ratingText = textOrNull(d.rating);
      const rating = ratingText === null ? null : Number(ratingText);
      if (!categoryNo) continue;
      if (statusFlag && !FLAGS.includes(statusFlag)) throw new HttpError(400, `${categoryNo}: the answer must be Y, N, NA or UN.`);
      if (rating !== null && !(Number.isInteger(rating) && rating >= 1 && rating <= 4)) {
        throw new HttpError(400, `${categoryNo}: the rating must be 1 to 4.`);
      }
      if (!statusFlag && rating === null && !remarks) continue; // nothing answered for this question
      answers.set(categoryNo, { categoryNo, statusFlag, rating, remarks });
    }
    if (answers.size) {
      const ok = await client.query(
        'SELECT id FROM audit_category_master WHERE id = ANY($1::text[]) AND NOT is_heading AND active',
        [[...answers.keys()]]
      );
      if (ok.rows.length !== answers.size) {
        const valid = new Set(ok.rows.map((r) => r.id));
        const bad = [...answers.keys()].find((k) => !valid.has(k));
        throw new HttpError(400, `${bad} isn't an active checklist question.`);
      }
    }

    // ---- write -------------------------------------------------------------
    await client.query('BEGIN');
    await client.query("SELECT pg_advisory_xact_lock(hashtext('audit_header_write'))");
    const status = submit ? 'Submitted' : 'Draft';
    let auditId = id;

    if (auditId) {
      const cur = await client.query('SELECT * FROM audit_header WHERE id = $1 FOR UPDATE', [auditId]);
      if (!cur.rows.length) throw new HttpError(404, 'That audit was not found.');
      if (cur.rows[0].auditor_id !== me) throw new HttpError(403, 'You can only change audits you recorded.');
      if (cur.rows[0].status === 'Submitted') throw new HttpError(409, "This audit has already been submitted and can't be changed.");
      await client.query(
        `UPDATE audit_header SET audit_date=$1, time_from=$2, time_to=$3, beneficiary_id=$4,
           facilitator1_id=$5, facilitator2_id=$6, visit_remarks=$7, status=$8,
           submitted_at=$9, updated_at=now(),
           visit_number = CASE WHEN beneficiary_id IS DISTINCT FROM $4
             THEN (SELECT COALESCE(MAX(visit_number), 0) + 1 FROM audit_header WHERE beneficiary_id = $4)
             ELSE visit_number END
         WHERE id=$10`,
        [h.auditDate, h.timeFrom, h.timeTo, h.beneficiaryId, h.facilitator1Id, h.facilitator2Id, h.visitRemarks, status, submit ? new Date() : null, auditId]
      );
      await client.query('DELETE FROM audit_detail WHERE audit_id = $1', [auditId]);
    } else {
      const next = await client.query("SELECT COALESCE(MAX(CAST(SUBSTRING(id FROM 5) AS INTEGER)), 0) + 1 AS n FROM audit_header WHERE id ~ '^AUD-[0-9]+$'");
      auditId = `AUD-${String(next.rows[0].n).padStart(4, '0')}`;
      // visit_number is left out: the database numbers it per beneficiary (1, 2, 3 ...)
      await client.query(
        `INSERT INTO audit_header (id, audit_date, time_from, time_to, beneficiary_id, facilitator1_id,
           facilitator2_id, visit_remarks, status, submitted_at, auditor_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [auditId, h.auditDate, h.timeFrom, h.timeTo, h.beneficiaryId, h.facilitator1Id, h.facilitator2Id, h.visitRemarks, status, submit ? new Date() : null, me]
      );
    }

    for (const a of answers.values()) {
      await client.query(
        'INSERT INTO audit_detail (id, audit_id, category_no, status_flag, rating, remarks) VALUES ($1,$2,$3,$4,$5,$6)',
        [`${auditId}-${a.categoryNo}`, auditId, a.categoryNo, a.statusFlag, a.rating, a.remarks]
      );
    }
    const saved = await client.query('SELECT * FROM audit_header WHERE id = $1', [auditId]);
    await client.query('COMMIT');
    res.json({ audit: rowToRecord(saved.rows[0]) });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
    if (err.code === '23505') return res.status(409).json({ error: 'That audit clashed with another save. Please try again.' });
    next(err);
  } finally {
    client.release();
  }
});

module.exports = router;
