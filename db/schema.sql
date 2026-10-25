-- ---------------------------------------------------------------------------
-- Maitri PPSP -- PostgreSQL schema (copied from LSP, then adapted)
--
-- Mirrors the tables in src/data/mockData.js exactly (same field names,
-- camelCase mapped to snake_case) so the API layer can pass records through
-- with minimal translation.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS resources (
  id                    TEXT PRIMARY KEY,
  name                  TEXT NOT NULL,
  phone                 TEXT NOT NULL UNIQUE,
  email                 TEXT,
  address               TEXT,
  type                  TEXT,                 -- Volunteer / Honorary Staff / Staff
  role                  TEXT NOT NULL,         -- Facilitator / Admin
  blood_group           TEXT,
  emergency_contact     TEXT,
  contract_start        DATE,
  contract_end          DATE,
  facial_data_captured  BOOLEAN DEFAULT FALSE,
  password_hash         TEXT NOT NULL,
  must_change_password  BOOLEAN DEFAULT TRUE,
  created_at            TIMESTAMPTZ DEFAULT now(),
  updated_at            TIMESTAMPTZ DEFAULT now()
);

-- Active/inactive toggle -- an inactive resource can't log in (checked in
-- routes/auth.js) but its historical attendance/session records stay put.
ALTER TABLE resources ADD COLUMN IF NOT EXISTS active BOOLEAN DEFAULT TRUE;

-- PPSP: a Facilitator who may also log in as an Audit Facilitator. The audit
-- visit screen is only enabled when this is TRUE and the person chooses to
-- log in as audit facilitator (that choice is handled in the app, not here).
ALTER TABLE resources ADD COLUMN IF NOT EXISTS is_audit_facilitator BOOLEAN DEFAULT FALSE;

CREATE TABLE IF NOT EXISTS beneficiaries (
  id       TEXT PRIMARY KEY,
  school   TEXT NOT NULL,
  class    TEXT,
  section  TEXT
);

-- One beneficiary per (school, class, section) combination -- a functional
-- index (not a plain UNIQUE constraint) so a blank section normalizes to ''
-- for comparison instead of two NULLs being treated as distinct, which
-- would otherwise let accidental duplicates slip through with the section
-- field left empty. Case-insensitive to match the app's own duplicate
-- checks elsewhere.
CREATE UNIQUE INDEX IF NOT EXISTS beneficiaries_school_class_section_unique
  ON beneficiaries (LOWER(school), LOWER(COALESCE(class, '')), LOWER(COALESCE(section, '')));

CREATE TABLE IF NOT EXISTS categories (
  id        TEXT PRIMARY KEY,
  pillar    TEXT NOT NULL,   -- Values / Health and Hygiene / Soft Skills / Environment / Creativity
  topic     TEXT,
  subtopic  TEXT
);

-- Renames the original seed pillar names to the fixed 5-value set the
-- Categories/Life Skills dropdown now uses, so existing rows (and every
-- upload/content record that joins to them) show the new names too --
-- not just newly-created categories. Safe to re-run: a row already renamed
-- won't match the old name a second time.
UPDATE categories SET pillar = 'Values' WHERE pillar = 'Value Education';
UPDATE categories SET pillar = 'Environment' WHERE pillar = 'Environment Education';
UPDATE categories SET pillar = 'Health and Hygiene' WHERE pillar = 'Health & Hygiene';

-- One category per (pillar, topic, subtopic) combination, same
-- blank-normalizing approach as beneficiaries above.
CREATE UNIQUE INDEX IF NOT EXISTS categories_pillar_topic_subtopic_unique
  ON categories (LOWER(pillar), LOWER(COALESCE(topic, '')), LOWER(COALESCE(subtopic, '')));

CREATE TABLE IF NOT EXISTS geo (
  id             TEXT PRIMARY KEY,
  school         TEXT NOT NULL,
  lat            DOUBLE PRECISION NOT NULL,
  lng            DOUBLE PRECISION NOT NULL,
  radius_meters  INTEGER NOT NULL DEFAULT 150
);

-- Added via ALTER, not as part of the CREATE TABLE above: CREATE TABLE IF
-- NOT EXISTS is skipped entirely on a database that already has this table
-- from an earlier version, so a column only added inline there would never
-- actually reach an existing installation. ALTER ... IF NOT EXISTS is the
-- part of this file that's genuinely safe to re-run against any state.
ALTER TABLE geo ADD COLUMN IF NOT EXISTS label TEXT; -- optional, e.g. "Block A" -- lets two geofences share a school name

-- A school can genuinely have more than one geofence (different classes in
-- different blocks of the same school), so geo is NOT unique per school --
-- each Beneficiary instead links directly to the one specific geofence that
-- applies to it. If an earlier version of this schema added a uniqueness
-- constraint here, this drops it so schools can have multiple geofences.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'geo_school_unique'
  ) THEN
    ALTER TABLE geo DROP CONSTRAINT geo_school_unique;
  END IF;
END $$;

-- Direct Beneficiary -> Geo link (one geofence per beneficiary, not per
-- school name). Added as a nullable FK via ALTER so this file stays
-- re-runnable (npm run migrate) even on a database that already has the
-- beneficiaries/geo tables from before this column existed.
ALTER TABLE beneficiaries ADD COLUMN IF NOT EXISTS geo_id TEXT REFERENCES geo(id) ON DELETE SET NULL;

-- PPSP: the Sessions (psr) and Schedule tables are removed from this app.
-- These DROPs only matter once, on a database copied from LSP; on a fresh
-- database they do nothing. psr goes first because it references attendance.
-- (The CREATE TABLE statements for them were deleted from this file, so
-- re-running the migration will not bring them back.)
DROP TABLE IF EXISTS psr;
DROP TABLE IF EXISTS schedule;

CREATE TABLE IF NOT EXISTS attendance (
  id             TEXT PRIMARY KEY,
  beneficiary_id TEXT REFERENCES beneficiaries(id) ON DELETE SET NULL,
  facilitator_id TEXT REFERENCES resources(id) ON DELETE SET NULL,
  date           DATE NOT NULL,
  time_in        TEXT,
  time_out       TEXT,
  geo_verified   BOOLEAN DEFAULT FALSE,   -- passed the live geofence + face check
  ad_hoc         BOOLEAN DEFAULT FALSE    -- carried over from LSP (there is no schedule in PPSP, so nothing sets this)
);

-- Headcount, captured directly on the Attendance screen once a session's
-- underway.
ALTER TABLE attendance ADD COLUMN IF NOT EXISTS students_present INTEGER;

CREATE TABLE IF NOT EXISTS uploads (
  id             TEXT PRIMARY KEY,
  file_name      TEXT NOT NULL,
  beneficiary_id TEXT REFERENCES beneficiaries(id) ON DELETE SET NULL,
  category_id    TEXT REFERENCES categories(id) ON DELETE SET NULL,
  facilitator_id TEXT REFERENCES resources(id) ON DELETE SET NULL,
  date           DATE NOT NULL,
  description    TEXT,
  storage_path   TEXT   -- set by /api/files upload endpoint; null if metadata-only
);

-- The publicly-openable URL for this file (R2's public URL, or a
-- request-relative one for local-disk mode). storage_path alone isn't
-- enough to open a file -- for R2 it's just the object key, not a URL.
ALTER TABLE uploads ADD COLUMN IF NOT EXISTS file_url TEXT;

CREATE TABLE IF NOT EXISTS content (
  id            TEXT PRIMARY KEY,
  title         TEXT,   -- legacy; PPSP shows file_name instead
  file_type     TEXT,   -- Video / Document / PDF / PPT / Excel / Audio / Image / Other
  uploaded_by   TEXT REFERENCES resources(id) ON DELETE SET NULL,
  date          DATE NOT NULL,
  storage_path  TEXT
);

ALTER TABLE content ADD COLUMN IF NOT EXISTS file_url TEXT;

CREATE TABLE IF NOT EXISTS overrides (
  id              TEXT PRIMARY KEY,
  resource_id     TEXT REFERENCES resources(id) ON DELETE SET NULL,
  bypass_geofence BOOLEAN DEFAULT FALSE,
  bypass_face     BOOLEAN DEFAULT FALSE,
  reason          TEXT NOT NULL,
  logged_by       TEXT REFERENCES resources(id) ON DELETE SET NULL,
  timestamp       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Single-row table holding the app-wide system parameters.
CREATE TABLE IF NOT EXISTS system_parameters (
  id                     BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (id),  -- enforces exactly one row
  product_type           TEXT,
  org_name               TEXT,
  max_named_users        INTEGER,
  product_validity_end   DATE,
  login_by_email         BOOLEAN DEFAULT FALSE,
  gps_on_beneficiary     BOOLEAN DEFAULT TRUE,
  allowed_upload_types   JSONB DEFAULT '["photo","pdf","ppt"]'
);

-- Admin time-in/time-out corrections (Override screen). Kept on the
-- attendance row itself -- not just the separate `overrides` bypass log --
-- so every attendance record's audit trail (who corrected it, when, and
-- why) travels with the record itself, including in the Excel export.
ALTER TABLE attendance ADD COLUMN IF NOT EXISTS overridden BOOLEAN DEFAULT FALSE;
ALTER TABLE attendance ADD COLUMN IF NOT EXISTS override_reason TEXT;
ALTER TABLE attendance ADD COLUMN IF NOT EXISTS overridden_by TEXT REFERENCES resources(id) ON DELETE SET NULL;
ALTER TABLE attendance ADD COLUMN IF NOT EXISTS overridden_at TIMESTAMPTZ;

-- ===========================================================================
-- PPSP additions
-- Everything below is new for PPSP. Same conventions as the LSP tables:
-- TEXT primary keys generated by the API, snake_case names, and statements
-- that are safe to re-run (npm run migrate).
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- Master tables
-- ---------------------------------------------------------------------------

-- Material master. The ID is generated by the API (or supplied by the
-- upload). Category + name + type must be unique together; a blank type is
-- compared as '' (same trick as beneficiaries) so two rows with the same
-- category and name and no type can't both exist.
CREATE TABLE IF NOT EXISTS material_master (
  id          TEXT PRIMARY KEY,
  category    TEXT NOT NULL,
  name        TEXT NOT NULL,
  type        TEXT,
  activities  TEXT[] NOT NULL DEFAULT '{}',   -- activity codes, e.g. {P,M1,M2}
  created_at  TIMESTAMPTZ DEFAULT now(),
  updated_at  TIMESTAMPTZ DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS material_master_category_name_type_unique
  ON material_master (LOWER(category), LOWER(name), LOWER(COALESCE(type, '')));

-- Students of a beneficiary. A beneficiary that still has students can't be
-- deleted (RESTRICT) -- remove or move the students first.
CREATE TABLE IF NOT EXISTS student_master (
  id              TEXT PRIMARY KEY,           -- Student ID
  beneficiary_id  TEXT NOT NULL REFERENCES beneficiaries(id) ON DELETE RESTRICT,
  name            TEXT NOT NULL,
  joined_date     DATE,                       -- optional
  parent_name     TEXT,                       -- optional
  parent_contact  TEXT,                       -- optional
  updated_by      TEXT REFERENCES resources(id) ON DELETE SET NULL,
  updated_at      TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS student_master_beneficiary_idx ON student_master (beneficiary_id);

CREATE TABLE IF NOT EXISTS book_master (
  id              TEXT PRIMARY KEY,           -- Book ID (unique)
  title           TEXT NOT NULL,
  language        TEXT,
  classification  TEXT,                       -- e.g. Comedy / Story / Cartoon
  author          TEXT,                       -- optional
  created_at      TIMESTAMPTZ DEFAULT now(),
  updated_at      TIMESTAMPTZ DEFAULT now()
);

-- Which resource(s) run which beneficiary. This is also what defines a
-- facilitator's "own assigned beneficiary" for stock / books / students.
-- Rows are kept (active = FALSE) rather than deleted, so history stays.
CREATE TABLE IF NOT EXISTS beneficiary_resource_allocation (
  id              TEXT PRIMARY KEY,
  beneficiary_id  TEXT NOT NULL REFERENCES beneficiaries(id) ON DELETE RESTRICT,
  resource1_id    TEXT NOT NULL REFERENCES resources(id) ON DELETE RESTRICT,
  resource2_id    TEXT REFERENCES resources(id) ON DELETE RESTRICT,   -- optional
  from_date       DATE NOT NULL,
  opens_at        TEXT,    -- "HH:MM", stored as text like attendance times
  closes_at       TEXT,
  active          BOOLEAN NOT NULL DEFAULT TRUE,
  updated_at      TIMESTAMPTZ DEFAULT now(),
  updated_by      TEXT REFERENCES resources(id) ON DELETE SET NULL,
  update_remarks  TEXT,
  CONSTRAINT allocation_distinct_resources
    CHECK (resource2_id IS NULL OR resource2_id <> resource1_id)
);

CREATE INDEX IF NOT EXISTS allocation_beneficiary_idx ON beneficiary_resource_allocation (beneficiary_id);

-- Rule: one resource can be in only ONE active allocation, whether it sits
-- in the resource 1 or the resource 2 slot. Two partial unique indexes catch
-- a clash within the same slot (and are safe against simultaneous saves);
-- the trigger below catches a resource that is resource 1 in one active row
-- and resource 2 in another, which a plain index can't express.
CREATE UNIQUE INDEX IF NOT EXISTS allocation_active_resource1_unique
  ON beneficiary_resource_allocation (resource1_id) WHERE active;
CREATE UNIQUE INDEX IF NOT EXISTS allocation_active_resource2_unique
  ON beneficiary_resource_allocation (resource2_id) WHERE active AND resource2_id IS NOT NULL;

CREATE OR REPLACE FUNCTION check_allocation_resource_free() RETURNS trigger AS $$
BEGIN
  IF NEW.active THEN
    IF EXISTS (
      SELECT 1 FROM beneficiary_resource_allocation a
      WHERE a.active
        AND a.id <> NEW.id
        AND (a.resource1_id IN (NEW.resource1_id, NEW.resource2_id)
             OR a.resource2_id IN (NEW.resource1_id, NEW.resource2_id))
    ) THEN
      RAISE EXCEPTION 'A resource can be in only one active beneficiary allocation'
        USING ERRCODE = '23505';   -- unique_violation, so the API can treat it like any duplicate
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS allocation_resource_free ON beneficiary_resource_allocation;
CREATE TRIGGER allocation_resource_free
  BEFORE INSERT OR UPDATE ON beneficiary_resource_allocation
  FOR EACH ROW EXECUTE FUNCTION check_allocation_resource_free();

-- ---------------------------------------------------------------------------
-- Stock and book updates (one current row per beneficiary + item, so an
-- Excel import can upsert on the unique constraint)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS stock_update (
  id               TEXT PRIMARY KEY,
  beneficiary_id   TEXT NOT NULL REFERENCES beneficiaries(id) ON DELETE RESTRICT,
  material_id      TEXT NOT NULL REFERENCES material_master(id) ON DELETE RESTRICT,
  qty              INTEGER NOT NULL DEFAULT 0 CHECK (qty >= 0),
  status           TEXT,
  remarks          TEXT,
  last_updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_updated_by  TEXT REFERENCES resources(id) ON DELETE SET NULL,
  CONSTRAINT stock_update_beneficiary_material_unique UNIQUE (beneficiary_id, material_id)
);

CREATE TABLE IF NOT EXISTS book_update (
  id               TEXT PRIMARY KEY,
  beneficiary_id   TEXT NOT NULL REFERENCES beneficiaries(id) ON DELETE RESTRICT,
  book_id          TEXT NOT NULL REFERENCES book_master(id) ON DELETE RESTRICT,
  qty              INTEGER NOT NULL DEFAULT 0 CHECK (qty >= 0),
  status           TEXT,
  remarks          TEXT,
  last_updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_updated_by  TEXT REFERENCES resources(id) ON DELETE SET NULL,
  CONSTRAINT book_update_beneficiary_book_unique UNIQUE (beneficiary_id, book_id)
);

-- ---------------------------------------------------------------------------
-- DSR (daily status report)
-- One row per facilitator per day: "Save" as many times as needed while it
-- is a Draft, then one "Submit" flips it to Submitted. The database enforces
-- the one-per-day rule and that a submitted DSR is complete; "a facilitator
-- cannot edit after submit" (while the Admin can) is a role rule, so the
-- API enforces that part.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS dsr_header (
  id                         TEXT PRIMARY KEY,           -- DSR ID
  resource_id                TEXT NOT NULL REFERENCES resources(id) ON DELETE RESTRICT,
  beneficiary_id             TEXT REFERENCES beneficiaries(id) ON DELETE SET NULL,
  dsr_date                   DATE NOT NULL,
  time_in                    TEXT,                       -- facilitator time in
  children_morning           INTEGER CHECK (children_morning >= 0),      -- number of children at 9.30 am
  children_afternoon         INTEGER CHECK (children_afternoon >= 0),    -- active children 12.30 to 2 pm
  stock_rag                  TEXT CHECK (stock_rag IN ('Green', 'Amber', 'Red')),
  stock_remarks              TEXT,                       -- optional
  book_rag                   TEXT CHECK (book_rag IN ('Green', 'Amber', 'Red')),
  overall_rag                TEXT CHECK (overall_rag IN ('Green', 'Amber', 'Red')),
  -- multi-select: Story book / Good habits / Zero activity & other
  -- presentation / Correction details / Material name game / Others
  circle_time_activities     TEXT[] NOT NULL DEFAULT '{}',
  epl_materials_used         TEXT,
  remarks                    TEXT,                       -- optional
  status                     TEXT NOT NULL DEFAULT 'Draft' CHECK (status IN ('Draft', 'Submitted')),
  submitted_at               TIMESTAMPTZ,
  created_at                 TIMESTAMPTZ DEFAULT now(),
  updated_at                 TIMESTAMPTZ DEFAULT now(),
  CONSTRAINT dsr_one_per_resource_per_day UNIQUE (resource_id, dsr_date),
  CONSTRAINT dsr_submitted_is_complete CHECK (
    status <> 'Submitted' OR (
      submitted_at IS NOT NULL
      AND time_in IS NOT NULL
      AND children_morning IS NOT NULL
      AND children_afternoon IS NOT NULL
      AND stock_rag IS NOT NULL
      AND book_rag IS NOT NULL
      AND overall_rag IS NOT NULL
    )
  )
);

CREATE INDEX IF NOT EXISTS dsr_header_beneficiary_date_idx ON dsr_header (beneficiary_id, dsr_date);

-- Databases that already ran the first version of this file have the old
-- column names (children_at_930 / active_children_1230_2pm), which the app's
-- camelCase <-> snake_case conversion can't map (a digit after an underscore
-- doesn't survive the round trip). Rename them once; a no-op on a fresh
-- database. The CHECK constraints follow the rename automatically.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_name = 'dsr_header' AND column_name = 'children_at_930') THEN
    ALTER TABLE dsr_header RENAME COLUMN children_at_930 TO children_morning;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_name = 'dsr_header' AND column_name = 'active_children_1230_2pm') THEN
    ALTER TABLE dsr_header RENAME COLUMN active_children_1230_2pm TO children_afternoon;
  END IF;
END $$;

-- Materials used during the day: one row per material / activity / period.
CREATE TABLE IF NOT EXISTS dsr_detail (
  id                 TEXT PRIMARY KEY,
  dsr_id             TEXT NOT NULL REFERENCES dsr_header(id) ON DELETE CASCADE,
  material_id        TEXT NOT NULL REFERENCES material_master(id) ON DELETE RESTRICT,
  material_activity  TEXT,                               -- one of material_master.activities
  session_period     TEXT NOT NULL CHECK (session_period IN ('M', 'A'))   -- Morning / Afternoon
);

CREATE INDEX IF NOT EXISTS dsr_detail_dsr_idx ON dsr_detail (dsr_id);

-- The students who worked with that material (several allowed). If a
-- student is deleted from the master they drop out of past DSR lines too.
CREATE TABLE IF NOT EXISTS dsr_detail_students (
  dsr_detail_id  TEXT NOT NULL REFERENCES dsr_detail(id) ON DELETE CASCADE,
  student_id     TEXT NOT NULL REFERENCES student_master(id) ON DELETE CASCADE,
  PRIMARY KEY (dsr_detail_id, student_id)
);

-- ---------------------------------------------------------------------------
-- Audit visits
-- ---------------------------------------------------------------------------

-- The checklist. Rows like '1', '2' ... are section headings; rows like
-- '1.01' are the questions. The id IS the category number, and is TEXT on
-- purpose: as a number, 2.10 would collapse to 2.1 and sort wrongly.
-- sort_order is derived from the number (2.13 -> 2013, heading 3 -> 3000) so
-- a new question slots into place without renumbering anything.
CREATE TABLE IF NOT EXISTS audit_category_master (
  id           TEXT PRIMARY KEY,
  description  TEXT NOT NULL,
  is_heading   BOOLEAN NOT NULL DEFAULT FALSE,
  sort_order   INTEGER NOT NULL,
  active       BOOLEAN NOT NULL DEFAULT TRUE
);

-- Databases created from the first version of this file call the key column
-- category_no. Rename it once so the generic routes can use it; the foreign
-- key from audit_detail follows the rename. A no-op on a fresh database.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_name = 'audit_category_master' AND column_name = 'category_no') THEN
    ALTER TABLE audit_category_master RENAME COLUMN category_no TO id;
  END IF;
END $$;

-- Keep sort_order in step with the number (safe to re-run).
UPDATE audit_category_master
   SET sort_order = split_part(id, '.', 1)::int * 1000 + COALESCE(NULLIF(split_part(id, '.', 2), '')::int, 0)
 WHERE id ~ '^[0-9]+(\.[0-9]+)?$'
   AND sort_order IS DISTINCT FROM
       (split_part(id, '.', 1)::int * 1000 + COALESCE(NULLIF(split_part(id, '.', 2), '')::int, 0));

CREATE TABLE IF NOT EXISTS audit_header (
  id               TEXT PRIMARY KEY,                     -- Audit ID
  audit_date       DATE NOT NULL,
  time_from        TEXT,
  time_to          TEXT,
  beneficiary_id   TEXT REFERENCES beneficiaries(id) ON DELETE SET NULL,
  facilitator1_id  TEXT REFERENCES resources(id) ON DELETE SET NULL,
  facilitator2_id  TEXT REFERENCES resources(id) ON DELETE SET NULL,   -- optional
  visit_remarks    TEXT,
  visit_number     INTEGER NOT NULL CHECK (visit_number >= 1),
  status           TEXT NOT NULL DEFAULT 'Draft' CHECK (status IN ('Draft', 'Submitted')),
  submitted_at     TIMESTAMPTZ,
  created_at       TIMESTAMPTZ DEFAULT now(),
  updated_at       TIMESTAMPTZ DEFAULT now(),
  CONSTRAINT audit_visit_number_per_beneficiary UNIQUE (beneficiary_id, visit_number),
  CONSTRAINT audit_distinct_facilitators CHECK (facilitator2_id IS NULL OR facilitator2_id <> facilitator1_id),
  CONSTRAINT audit_submitted_has_timestamp CHECK (status <> 'Submitted' OR submitted_at IS NOT NULL)
);

-- Visit number = 1, 2, 3 ... per beneficiary. Leave it NULL on insert and the
-- database assigns the next one (a BEFORE trigger runs before the NOT NULL
-- check). If two visits are saved at the very same instant, the unique
-- constraint above rejects one of them and the API can retry.
CREATE OR REPLACE FUNCTION set_audit_visit_number() RETURNS trigger AS $$
BEGIN
  IF NEW.visit_number IS NULL THEN
    SELECT COALESCE(MAX(visit_number), 0) + 1
      INTO NEW.visit_number
      FROM audit_header
     WHERE beneficiary_id IS NOT DISTINCT FROM NEW.beneficiary_id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS audit_header_visit_number ON audit_header;
CREATE TRIGGER audit_header_visit_number
  BEFORE INSERT ON audit_header
  FOR EACH ROW EXECUTE FUNCTION set_audit_visit_number();

CREATE INDEX IF NOT EXISTS audit_header_beneficiary_idx ON audit_header (beneficiary_id, audit_date);

-- One row per checklist question answered in a visit.
-- status_flag: Y = Yes, N = No, NA = Not applicable, UN = Unknown to me;
-- NULL (blank) until answered.  rating: 1 Very bad, 2 Bad, 3 OK, 4 Very good.
CREATE TABLE IF NOT EXISTS audit_detail (
  id           TEXT PRIMARY KEY,
  audit_id     TEXT NOT NULL REFERENCES audit_header(id) ON DELETE CASCADE,
  category_no  TEXT NOT NULL REFERENCES audit_category_master(id) ON DELETE RESTRICT,
  status_flag  TEXT CHECK (status_flag IN ('Y', 'N', 'NA', 'UN')),
  rating       SMALLINT CHECK (rating BETWEEN 1 AND 4),
  remarks      TEXT,
  CONSTRAINT audit_detail_audit_category_unique UNIQUE (audit_id, category_no)
);

-- ---------------------------------------------------------------------------
-- Content: tied to a material (several files per material), not to a
-- service category. Added as ALTERs so the existing LSP content table is
-- reused: file_type holds Video / Document / etc., and file_url / storage_path
-- point at the file in R2. The file's display name is file_name; title is no
-- longer required. Rows created in LSP days have no material_id -- the admin
-- Content screen flags them so they can be linked to a material or removed.
-- ---------------------------------------------------------------------------

ALTER TABLE content DROP COLUMN IF EXISTS category_id;
ALTER TABLE content ALTER COLUMN title DROP NOT NULL;
ALTER TABLE content ADD COLUMN IF NOT EXISTS material_id TEXT REFERENCES material_master(id) ON DELETE SET NULL;
ALTER TABLE content ADD COLUMN IF NOT EXISTS file_name TEXT;
-- One of the selected material's activities (material_master.activities); optional.
ALTER TABLE content ADD COLUMN IF NOT EXISTS activity TEXT;
ALTER TABLE content ADD COLUMN IF NOT EXISTS remarks TEXT;
CREATE INDEX IF NOT EXISTS content_material_idx ON content (material_id);
