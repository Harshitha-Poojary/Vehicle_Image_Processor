/**
 * Database layer.
 *
 * Choice: SQLite (via better-sqlite3) for this reference implementation.
 * Rationale:
 *   - Zero external services to stand up -> the whole system runs with `npm install && npm start`.
 *   - Synchronous API keeps the worker code simple and easy to reason about.
 *   - Schema below is plain relational and maps 1:1 to Postgres/MySQL if you need to scale out
 *     (swap the driver, keep the schema/queries - they're standard SQL).
 *
 * For production with concurrent workers across multiple machines, swap this for Postgres
 * (row-level locking via `SELECT ... FOR UPDATE SKIP LOCKED` on the jobs table gives you
 * safe multi-worker dequeue without a separate broker).
 */
const path = require('path');
const Database = require('better-sqlite3');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data.sqlite');
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS images (
  id               TEXT PRIMARY KEY,
  original_filename TEXT NOT NULL,
  stored_filename  TEXT NOT NULL,
  storage_path     TEXT NOT NULL,
  mime_type        TEXT NOT NULL,
  size_bytes       INTEGER NOT NULL,
  sha256           TEXT NOT NULL,
  phash            TEXT,
  width            INTEGER,
  height           INTEGER,
  status           TEXT NOT NULL DEFAULT 'pending', -- pending | processing | completed | failed
  failure_reason   TEXT,
  attempts         INTEGER NOT NULL DEFAULT 0,
  uploaded_at      TEXT NOT NULL,
  processing_started_at TEXT,
  processed_at     TEXT
);

CREATE INDEX IF NOT EXISTS idx_images_status ON images(status);
CREATE INDEX IF NOT EXISTS idx_images_sha256 ON images(sha256);
CREATE INDEX IF NOT EXISTS idx_images_phash ON images(phash);

CREATE TABLE IF NOT EXISTS analysis_results (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  image_id         TEXT NOT NULL UNIQUE REFERENCES images(id) ON DELETE CASCADE,
  overall_verdict  TEXT NOT NULL,      -- clean | needs_review | rejected
  issues_json      TEXT NOT NULL,      -- structured array of detected issues
  checks_json      TEXT NOT NULL,      -- raw per-check output, for audit/debugging
  created_at       TEXT NOT NULL
);

-- Simple durable job table. The in-memory queue (src/queue/queue.js) is the hot path,
-- but every enqueue is mirrored here so a process restart can recover in-flight work
-- (see src/worker/recover.js) without losing jobs the way a pure in-memory queue would.
CREATE TABLE IF NOT EXISTS jobs (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  image_id         TEXT NOT NULL REFERENCES images(id) ON DELETE CASCADE,
  status           TEXT NOT NULL DEFAULT 'queued', -- queued | active | done | failed
  attempts         INTEGER NOT NULL DEFAULT 0,
  last_error       TEXT,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);
`);

module.exports = db;
