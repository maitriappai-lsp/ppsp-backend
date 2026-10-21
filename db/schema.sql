-- ---------------------------------------------------------------------------
-- Maitri LSP -- PostgreSQL schema
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
-- psr/session/content record that joins to them) show the new names too --
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

CREATE TABLE IF NOT EXISTS schedule (
  id             TEXT PRIMARY KEY,
  beneficiary_id TEXT REFERENCES beneficiaries(id) ON DELETE SET NULL,
  facilitator_id TEXT REFERENCES resources(id) ON DELETE SET NULL,
  date           DATE NOT NULL,
  time           TEXT NOT NULL,
  category_id    TEXT REFERENCES categories(id) ON DELETE SET NULL
);

-- Optional second resource on a scheduled session (assistant to the
-- facilitator). Added via ALTER, not inline above, so it also reaches
-- databases that already have the schedule table. Nullable: not every
-- session has an assistant.
ALTER TABLE schedule ADD COLUMN IF NOT EXISTS assistant_id TEXT REFERENCES resources(id) ON DELETE SET NULL;

CREATE TABLE IF NOT EXISTS psr (
  id                    TEXT PRIMARY KEY,
  beneficiary_id        TEXT REFERENCES beneficiaries(id) ON DELETE SET NULL,
  facilitator_id        TEXT REFERENCES resources(id) ON DELETE SET NULL,
  date                  DATE NOT NULL,
  time_in               TEXT,
  time_out              TEXT,
  category_id           TEXT REFERENCES categories(id) ON DELETE SET NULL,
  students_present      INTEGER,
  rating                TEXT,   -- Excellent / Good / Average / Poor
  rag                   TEXT,   -- Green / Amber / Red
  facilitator_feedback  TEXT,
  school_feedback       TEXT,
  photos_uploaded       BOOLEAN DEFAULT FALSE
);

-- The attendance check-in itself (geofence + face pass, then Time In) is
-- its own table -- separate from psr, which is purely the session-quality
-- report (category, rating, feedback). If an earlier version of this
-- schema added geo_verified/ad_hoc columns directly onto psr, this removes
-- them; that data now lives in attendance below.
ALTER TABLE psr DROP COLUMN IF EXISTS geo_verified;
ALTER TABLE psr DROP COLUMN IF EXISTS ad_hoc;

CREATE TABLE IF NOT EXISTS attendance (
  id             TEXT PRIMARY KEY,
  beneficiary_id TEXT REFERENCES beneficiaries(id) ON DELETE SET NULL,
  facilitator_id TEXT REFERENCES resources(id) ON DELETE SET NULL,
  date           DATE NOT NULL,
  time_in        TEXT,
  time_out       TEXT,
  geo_verified   BOOLEAN DEFAULT FALSE,   -- passed the live geofence + face check
  ad_hoc         BOOLEAN DEFAULT FALSE    -- true if this beneficiary wasn't on that day's schedule
);

-- Optional link from a completed session report back to the attendance
-- check-in it was filled in from (via the Sessions screen's "Complete
-- today's check-ins"). Null for a session record created from scratch with
-- no matching check-in.
ALTER TABLE psr ADD COLUMN IF NOT EXISTS attendance_id TEXT REFERENCES attendance(id) ON DELETE SET NULL;

-- Headcount, captured directly on the Attendance screen once a session's
-- underway (separate from psr.students_present, which is filled in later
-- as part of the session-quality report and may not always be the same
-- number if it's corrected afterward).
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
  title         TEXT NOT NULL,
  category_id   TEXT REFERENCES categories(id) ON DELETE SET NULL,
  file_type     TEXT,   -- PDF / PPT / Document / Excel / Audio / Video / Image / Other
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

-- Optional extra context on a session record: external partner org
-- involved (if any), resources they brought/used, and whether photos from
-- the session were taken and shared onward (reusing the existing
-- photos_uploaded flag as that Y/N, rather than adding a duplicate column).
ALTER TABLE psr ADD COLUMN IF NOT EXISTS external_org_name TEXT;
ALTER TABLE psr ADD COLUMN IF NOT EXISTS external_resources TEXT;

-- Optional assistant who helped run this session (same idea as
-- schedule.assistant_id). Nullable; ALTER so it reaches existing databases.
ALTER TABLE psr ADD COLUMN IF NOT EXISTS assistant_id TEXT REFERENCES resources(id) ON DELETE SET NULL;
