// ---------------------------------------------------------------------------
// Real Excel import -- replaces the "Import from Excel" stubs (file picker
// worked, nothing was ever parsed). Accepts a multipart .xlsx upload,
// reads the first worksheet with exceljs, and upserts rows by a natural key
// per table (not the internal R-0001-style id, which an Excel sheet
// wouldn't know) -- re-importing the same sheet updates existing rows
// instead of duplicating them. (Schedule no longer exists in PPSP.)
//
// Expected column headers (case-insensitive, any order) per table:
//   resources:     Name, Phone, Email, Address, Type, Role, Blood Group,
//                  Emergency Contact, Contract Start, Contract End
//   beneficiaries: School, Class, Section
//   categories:    Pillar, Topic, Subtopic
//   geo:           School, Label, Latitude, Longitude, Radius Meters
//   materialMaster: Material Category, Material Name, Material Type (optional),
//                  Material Activities (optional, comma separated, e.g. P,M1,M2),
//                  Material ID (optional)
//   studentMaster: Beneficiary ID (or School, Class, Section), Student Name,
//                  Student ID (optional), Joined Date (optional),
//                  Parent Name (optional), Parent Contact (optional)
//   bookMaster:    Title, Language, Classification, Author (optional),
//                  Book ID (optional)
// ---------------------------------------------------------------------------
const express = require('express');
const multer = require('multer');
const ExcelJS = require('exceljs');
const pool = require('../db');

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

// ---- PPSP masters -------------------------------------------------------

// First non-empty value among several accepted header spellings (headers
// are lower-cased by readRows).
function pick(r, ...keys) {
  for (const k of keys) {
    if (r[k] !== undefined && String(r[k]).trim() !== '') return String(r[k]).trim();
  }
  return '';
}

function parseList(value) {
  const seen = new Set();
  return String(value || '')
    .split(/[,;]/)
    .map((s) => s.trim())
    .filter((s) => s && !seen.has(s.toLowerCase()) && seen.add(s.toLowerCase()));
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

async function importMaterialMaster(rows) {
  let seq = await nextSeq('MAT', 'material_master');
  const result = { inserted: 0, updated: 0, skipped: 0, errors: [] };
  for (const [i, r] of rows.entries()) {
    const category = pick(r, 'material category', 'category');
    const name = pick(r, 'material name', 'name');
    const type = pick(r, 'material type', 'type');
    const givenId = pick(r, 'material id', 'id');
    const activities = parseList(pick(r, 'material activities', 'activities'));
    if (!category || !name) {
      result.skipped++;
      result.errors.push(`Row ${i + 2}: Material Category and Material Name are required.`);
      continue;
    }
    // Category + name + type is the natural key (blank type compares as '').
    const existing = await pool.query(
      `SELECT id FROM material_master
       WHERE LOWER(category)=LOWER($1) AND LOWER(name)=LOWER($2) AND LOWER(COALESCE(type,''))=LOWER($3)`,
      [category, name, type]
    );
    if (existing.rows.length) {
      await pool.query('UPDATE material_master SET activities=$1, updated_at=now() WHERE id=$2', [
        activities,
        existing.rows[0].id,
      ]);
      result.updated++;
      continue;
    }
    let id;
    if (givenId) {
      const taken = await pool.query('SELECT 1 FROM material_master WHERE id=$1', [givenId]);
      if (taken.rows.length) {
        result.skipped++;
        result.errors.push(`Row ${i + 2}: Material ID ${givenId} is already used by a different material.`);
        continue;
      }
      id = givenId;
    } else {
      seq += 1;
      id = `MAT-${String(seq).padStart(4, '0')}`;
    }
    await pool.query(
      'INSERT INTO material_master (id, category, name, type, activities) VALUES ($1,$2,$3,$4,$5)',
      [id, category, name, type || null, activities]
    );
    result.inserted++;
  }
  return result;
}

async function importStudentMaster(rows, ctx = {}) {
  let seq = await nextSeq('STU', 'student_master');
  const result = { inserted: 0, updated: 0, skipped: 0, errors: [] };
  for (const [i, r] of rows.entries()) {
    const name = pick(r, 'student name', 'name');
    if (!name) {
      result.skipped++;
      result.errors.push(`Row ${i + 2}: Student Name is required.`);
      continue;
    }

    // Beneficiary: by Beneficiary ID, else by School / Class / Section.
    let beneficiaryId = pick(r, 'beneficiary id');
    if (beneficiaryId) {
      const b = await pool.query('SELECT id FROM beneficiaries WHERE id=$1', [beneficiaryId]);
      if (!b.rows.length) {
        result.skipped++;
        result.errors.push(`Row ${i + 2}: No beneficiary with ID ${beneficiaryId}.`);
        continue;
      }
    } else {
      const school = pick(r, 'school');
      const klass = pick(r, 'class');
      if (!school || !klass) {
        result.skipped++;
        result.errors.push(`Row ${i + 2}: Beneficiary ID (or School and Class) is required.`);
        continue;
      }
      const b = await pool.query(
        "SELECT id FROM beneficiaries WHERE LOWER(school)=LOWER($1) AND LOWER(class)=LOWER($2) AND LOWER(COALESCE(section,''))=LOWER($3)",
        [school, klass, pick(r, 'section')]
      );
      if (!b.rows.length) {
        result.skipped++;
        result.errors.push(`Row ${i + 2}: No beneficiary matches ${school} / ${klass} / ${pick(r, 'section')}.`);
        continue;
      }
      beneficiaryId = b.rows[0].id;
    }

    const joined = pick(r, 'joined date (optional)', 'joined date');
    if (joined && !DATE_RE.test(joined)) {
      result.skipped++;
      result.errors.push(`Row ${i + 2}: Joined Date should be a date like 2026-06-01.`);
      continue;
    }
    const parentName = pick(r, 'parent name (optional)', 'parent name') || null;
    const parentContact = pick(r, 'parent contact (optional)', 'parent contact') || null;
    const givenId = pick(r, 'student id');

    const existing = givenId
      ? await pool.query('SELECT id FROM student_master WHERE id=$1', [givenId])
      : await pool.query('SELECT id FROM student_master WHERE beneficiary_id=$1 AND LOWER(name)=LOWER($2)', [
          beneficiaryId,
          name,
        ]);
    if (existing.rows.length) {
      await pool.query(
        `UPDATE student_master SET beneficiary_id=$1, name=$2, joined_date=$3, parent_name=$4,
         parent_contact=$5, updated_by=$6, updated_at=now() WHERE id=$7`,
        [beneficiaryId, name, joined || null, parentName, parentContact, ctx.userId || null, existing.rows[0].id]
      );
      result.updated++;
    } else {
      let id = givenId;
      if (!id) {
        seq += 1;
        id = `STU-${String(seq).padStart(4, '0')}`;
      }
      await pool.query(
        `INSERT INTO student_master (id, beneficiary_id, name, joined_date, parent_name, parent_contact, updated_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [id, beneficiaryId, name, joined || null, parentName, parentContact, ctx.userId || null]
      );
      result.inserted++;
    }
  }
  return result;
}

async function importBookMaster(rows) {
  let seq = await nextSeq('BK', 'book_master');
  const result = { inserted: 0, updated: 0, skipped: 0, errors: [] };
  for (const [i, r] of rows.entries()) {
    const title = pick(r, 'title');
    if (!title) {
      result.skipped++;
      result.errors.push(`Row ${i + 2}: Title is required.`);
      continue;
    }
    const language = pick(r, 'language') || null;
    const classification = pick(r, 'classification') || null;
    const author = pick(r, 'author (optional)', 'author') || null;
    const givenId = pick(r, 'book id');

    const existing = givenId
      ? await pool.query('SELECT id FROM book_master WHERE id=$1', [givenId])
      : await pool.query(
          `SELECT id FROM book_master WHERE LOWER(title)=LOWER($1)
           AND LOWER(COALESCE(language,''))=LOWER($2) AND LOWER(COALESCE(author,''))=LOWER($3)`,
          [title, language || '', author || '']
        );
    if (existing.rows.length) {
      await pool.query(
        'UPDATE book_master SET title=$1, language=$2, classification=$3, author=$4, updated_at=now() WHERE id=$5',
        [title, language, classification, author, existing.rows[0].id]
      );
      result.updated++;
    } else {
      let id = givenId;
      if (!id) {
        seq += 1;
        id = `BK-${String(seq).padStart(4, '0')}`;
      }
      await pool.query(
        'INSERT INTO book_master (id, title, language, classification, author) VALUES ($1,$2,$3,$4,$5)',
        [id, title, language, classification, author]
      );
      result.inserted++;
    }
  }
  return result;
}

const IMPORTERS = {
  resources: importResources,
  beneficiaries: importBeneficiaries,
  categories: importCategories,
  geo: importGeo,
  materialMaster: importMaterialMaster,
  studentMaster: importStudentMaster,
  bookMaster: importBookMaster,
};

router.post('/:table', upload.single('file'), async (req, res, next) => {
  try {
    const importer = IMPORTERS[req.params.table];
    if (!importer) return res.status(404).json({ error: `Import not supported for "${req.params.table}"` });
    if (!req.file) return res.status(400).json({ error: 'No file provided (expected field "file")' });

    const rows = await readRows(req.file.buffer);
    if (rows.length === 0) return res.status(400).json({ error: 'No data rows found in the sheet.' });

    const result = await importer(rows, { userId: req.user?.sub });
    res.json(result);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
