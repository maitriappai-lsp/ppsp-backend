// ---------------------------------------------------------------------------
// Real Excel import -- replaces the "Import from Excel" stubs (file picker
// worked, nothing was ever parsed). Accepts a multipart .xlsx upload,
// reads the first worksheet with exceljs, and upserts rows by a natural key
// per table (not the internal R-0001-style id, which an Excel sheet
// wouldn't know) -- re-importing the same sheet updates existing rows
// instead of duplicating them. Schedule has no natural key of its own, so
// it always appends; each row's beneficiary/facilitator are resolved from
// human-readable columns (school/class/section, facilitator phone) rather
// than requiring internal ids in the sheet.
//
// Expected column headers (case-insensitive, any order) per table:
//   resources:     Name, Phone, Email, Address, Type, Role, Blood Group,
//                  Emergency Contact, Contract Start, Contract End
//   beneficiaries: School, Class, Section
//   categories:    Pillar, Topic, Subtopic
//   geo:           School, Label, Latitude, Longitude, Radius Meters
//   schedule:      School, Class, Section, Facilitator Phone, Date, Time,
//                  Pillar, Topic, Subtopic, Assistant Phone (optional)
// ---------------------------------------------------------------------------
const express = require('express');
const multer = require('multer');
const ExcelJS = require('exceljs');
const pool = require('../db');
const { checkWriteRules } = require('../scheduleRules');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

// Reads the first worksheet into an array of objects keyed by lower-cased,
// trimmed header names, e.g. { name: 'Divya Shankar', phone: '98400...' }.
async function readRows(buffer) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);
  const sheet = workbook.worksheets[0];
  if (!sheet) return [];

  const headerRow = sheet.getRow(1);
  const headers = [];
  headerRow.eachCell({ includeEmpty: true }, (cell, colNumber) => {
    headers[colNumber] = String(cell.value || '').trim().toLowerCase();
  });

  const rows = [];
  sheet.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return;
    const obj = {};
    let hasAnyValue = false;
    row.eachCell({ includeEmpty: true }, (cell, colNumber) => {
      const key = headers[colNumber];
      if (!key) return;
      let value = cell.value;
      if (value && typeof value === 'object' && value.text) value = value.text; // rich text
      if (value instanceof Date) value = value.toISOString().slice(0, 10);
      if (value !== null && value !== undefined && String(value).trim() !== '') hasAnyValue = true;
      obj[key] = value === null || value === undefined ? '' : String(value).trim();
    });
    if (hasAnyValue) rows.push(obj);
  });
  return rows;
}

async function nextSeq(prefix, table) {
  const { rows } = await pool.query(
    `SELECT COALESCE(MAX(CAST(SUBSTRING(id FROM LENGTH($1) + 2) AS INTEGER)), 0) AS max_n
     FROM ${table} WHERE id LIKE $2`,
    [prefix, `${prefix}-%`]
  );
  return Number(rows[0].max_n);
}

// ---- per-table importers ---------------------------------------------

async function importResources(rows) {
  let seq = await nextSeq('R', 'resources');
  const result = { inserted: 0, updated: 0, skipped: 0, errors: [] };
  for (const [i, r] of rows.entries()) {
    if (!r.name || !r.phone) {
      result.skipped++;
      result.errors.push(`Row ${i + 2}: Name and Phone are required.`);
      continue;
    }
    const existing = await pool.query('SELECT id FROM resources WHERE phone = $1', [r.phone]);
    if (existing.rows.length) {
      await pool.query(
        `UPDATE resources SET name=$1, email=$2, address=$3, type=$4, role=$5, blood_group=$6,
         emergency_contact=$7, contract_start=$8, contract_end=$9 WHERE id=$10`,
        [
          r.name, r.email || null, r.address || null, r.type || 'Volunteer', r.role || 'Facilitator',
          r['blood group'] || null, r['emergency contact'] || null,
          r['contract start'] || null, r['contract end'] || null, existing.rows[0].id,
        ]
      );
      result.updated++;
    } else {
      seq += 1;
      const id = `R-${String(seq).padStart(4, '0')}`;
      const bcrypt = require('bcryptjs');
      const passwordHash = await bcrypt.hash('changeme123', 10);
      await pool.query(
        `INSERT INTO resources (id, name, phone, email, address, type, role, blood_group,
         emergency_contact, contract_start, contract_end, facial_data_captured, password_hash, must_change_password)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,FALSE,$12,TRUE)`,
        [
          id, r.name, r.phone, r.email || null, r.address || null, r.type || 'Volunteer', r.role || 'Facilitator',
          r['blood group'] || null, r['emergency contact'] || null,
          r['contract start'] || null, r['contract end'] || null, passwordHash,
        ]
      );
      result.inserted++;
    }
  }
  return result;
}

async function importBeneficiaries(rows) {
  let seq = await nextSeq('EC', 'beneficiaries');
  const result = { inserted: 0, updated: 0, skipped: 0, errors: [] };
  for (const [i, r] of rows.entries()) {
    if (!r.school || !r.class) {
      result.skipped++;
      result.errors.push(`Row ${i + 2}: School and Class are required.`);
      continue;
    }
    const existing = await pool.query(
      'SELECT id FROM beneficiaries WHERE LOWER(school)=LOWER($1) AND LOWER(class)=LOWER($2) AND LOWER(COALESCE(section,\'\'))=LOWER($3)',
      [r.school, r.class, r.section || '']
    );
    if (existing.rows.length) {
      result.updated++; // nothing else to update -- the match key is the whole row
    } else {
      seq += 1;
      const id = `EC-${String(seq).padStart(4, '0')}`;
      await pool.query('INSERT INTO beneficiaries (id, school, class, section) VALUES ($1,$2,$3,$4)', [
        id, r.school, r.class, r.section || null,
      ]);
      result.inserted++;
    }
  }
  return result;
}

async function importCategories(rows) {
  let seq = await nextSeq('LSS-CAT', 'categories');
  const result = { inserted: 0, updated: 0, skipped: 0, errors: [] };
  for (const [i, r] of rows.entries()) {
    if (!r.pillar) {
      result.skipped++;
      result.errors.push(`Row ${i + 2}: Pillar is required.`);
      continue;
    }
    const existing = await pool.query(
      'SELECT id FROM categories WHERE LOWER(pillar)=LOWER($1) AND LOWER(COALESCE(topic,\'\'))=LOWER($2) AND LOWER(COALESCE(subtopic,\'\'))=LOWER($3)',
      [r.pillar, r.topic || '', r.subtopic || '']
    );
    if (existing.rows.length) {
      result.updated++;
    } else {
      seq += 1;
      const id = `LSS-CAT-${String(seq).padStart(4, '0')}`;
      await pool.query('INSERT INTO categories (id, pillar, topic, subtopic) VALUES ($1,$2,$3,$4)', [
        id, r.pillar, r.topic || 'OTHERS', r.subtopic || 'OTHERS',
      ]);
      result.inserted++;
    }
  }
  return result;
}

async function importGeo(rows) {
  let seq = await nextSeq('GEO', 'geo');
  const result = { inserted: 0, updated: 0, skipped: 0, errors: [] };
  for (const [i, r] of rows.entries()) {
    const lat = Number(r.latitude);
    const lng = Number(r.longitude);
    if (!r.school || Number.isNaN(lat) || Number.isNaN(lng)) {
      result.skipped++;
      result.errors.push(`Row ${i + 2}: School, Latitude and Longitude are required.`);
      continue;
    }
    const radius = Number(r['radius meters']) || 150;
    const existing = await pool.query(
      'SELECT id FROM geo WHERE LOWER(school)=LOWER($1) AND LOWER(COALESCE(label,\'\'))=LOWER($2)',
      [r.school, r.label || '']
    );
    if (existing.rows.length) {
      await pool.query('UPDATE geo SET lat=$1, lng=$2, radius_meters=$3 WHERE id=$4', [
        lat, lng, radius, existing.rows[0].id,
      ]);
      result.updated++;
    } else {
      seq += 1;
      const id = `GEO-${String(seq).padStart(4, '0')}`;
      await pool.query('INSERT INTO geo (id, school, label, lat, lng, radius_meters) VALUES ($1,$2,$3,$4,$5,$6)', [
        id, r.school, r.label || null, lat, lng, radius,
      ]);
      result.inserted++;
    }
  }
  return result;
}

async function importSchedule(rows) {
  let seq = await nextSeq('SCH', 'schedule');
  const result = { inserted: 0, updated: 0, skipped: 0, errors: [] };
  for (const [i, r] of rows.entries()) {
    if (!r.school || !r.class || !r['facilitator phone'] || !r.date || !r.time) {
      result.skipped++;
      result.errors.push(`Row ${i + 2}: School, Class, Facilitator Phone, Date and Time are required.`);
      continue;
    }
    const ben = await pool.query(
      'SELECT id FROM beneficiaries WHERE LOWER(school)=LOWER($1) AND LOWER(class)=LOWER($2) AND LOWER(COALESCE(section,\'\'))=LOWER($3)',
      [r.school, r.class, r.section || '']
    );
    if (!ben.rows.length) {
      result.skipped++;
      result.errors.push(`Row ${i + 2}: No beneficiary matches ${r.school} / ${r.class} / ${r.section || ''}.`);
      continue;
    }
    const fac = await pool.query('SELECT id FROM resources WHERE phone = $1', [r['facilitator phone']]);
    if (!fac.rows.length) {
      result.skipped++;
      result.errors.push(`Row ${i + 2}: No facilitator with phone ${r['facilitator phone']}.`);
      continue;
    }
    // Optional: leave the Assistant Phone cell blank for no assistant. If a
    // phone IS given but matches no resource, skip the row (same as an
    // unknown facilitator) rather than silently dropping the assistant.
    let assistantId = null;
    if (r['assistant phone']) {
      const asst = await pool.query('SELECT id FROM resources WHERE phone = $1', [r['assistant phone']]);
      if (!asst.rows.length) {
        result.skipped++;
        result.errors.push(`Row ${i + 2}: No assistant with phone ${r['assistant phone']}.`);
        continue;
      }
      assistantId = asst.rows[0].id;
    }
    // Booking rules: one session per beneficiary per day, and the facilitator
    // and assistant must each be free (as facilitator OR assistant) around
    // this start time -- see scheduleRules.js.
    const ruleError = await checkWriteRules(pool, 'schedule', {
      date: r.date,
      time: r.time,
      beneficiaryId: ben.rows[0].id,
      facilitatorId: fac.rows[0].id,
      assistantId,
    });
    if (ruleError) {
      result.skipped++;
      result.errors.push(`Row ${i + 2}: ${ruleError}`);
      continue;
    }
    let categoryId = null;
    if (r.pillar) {
      const cat = await pool.query(
        'SELECT id FROM categories WHERE LOWER(pillar)=LOWER($1) AND LOWER(COALESCE(topic,\'\'))=LOWER($2) AND LOWER(COALESCE(subtopic,\'\'))=LOWER($3)',
        [r.pillar, r.topic || '', r.subtopic || '']
      );
      if (cat.rows.length) categoryId = cat.rows[0].id;
    }
    seq += 1;
    const id = `SCH-${String(seq).padStart(4, '0')}`;
    await pool.query(
      'INSERT INTO schedule (id, beneficiary_id, facilitator_id, assistant_id, date, time, category_id) VALUES ($1,$2,$3,$4,$5,$6,$7)',
      [id, ben.rows[0].id, fac.rows[0].id, assistantId, r.date, r.time, categoryId]
    );
    result.inserted++;
  }
  return result;
}

const IMPORTERS = {
  resources: importResources,
  beneficiaries: importBeneficiaries,
  categories: importCategories,
  geo: importGeo,
  schedule: importSchedule,
};

router.post('/:table', upload.single('file'), async (req, res, next) => {
  try {
    const importer = IMPORTERS[req.params.table];
    if (!importer) return res.status(404).json({ error: `Import not supported for "${req.params.table}"` });
    if (!req.file) return res.status(400).json({ error: 'No file provided (expected field "file")' });

    const rows = await readRows(req.file.buffer);
    if (rows.length === 0) return res.status(400).json({ error: 'No data rows found in the sheet.' });

    const result = await importer(rows);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
