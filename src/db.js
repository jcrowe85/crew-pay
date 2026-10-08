const { DatabaseSync } = require('node:sqlite');
const path = require('node:path');
const fs = require('node:fs');

const file = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'crewpay.db');
if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });

const db = new DatabaseSync(file);
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;
  PRAGMA busy_timeout = 5000;

  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY,
    email TEXT NOT NULL UNIQUE COLLATE NOCASE,
    name TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'worker' CHECK (role IN ('admin', 'worker')),
    hourly_rate_cents INTEGER NOT NULL DEFAULT 0,
    active INTEGER NOT NULL DEFAULT 1,
    must_change_password INTEGER NOT NULL DEFAULT 0,
    stripe_account_id TEXT,
    payouts_enabled INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    csrf TEXT NOT NULL,
    expires_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS pay_runs (
    id INTEGER PRIMARY KEY,
    period_start INTEGER NOT NULL,
    period_end INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'partial', 'paid')),
    created_by INTEGER NOT NULL REFERENCES users(id),
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS pay_run_items (
    id INTEGER PRIMARY KEY,
    pay_run_id INTEGER NOT NULL REFERENCES pay_runs(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id),
    minutes INTEGER NOT NULL,
    rate_cents INTEGER NOT NULL,
    amount_cents INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'failed', 'paid')),
    method TEXT,
    stripe_transfer_id TEXT,
    attempts INTEGER NOT NULL DEFAULT 0,
    error TEXT,
    paid_at INTEGER
  );

  CREATE TABLE IF NOT EXISTS time_entries (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id),
    clock_in INTEGER NOT NULL,
    clock_out INTEGER,
    note TEXT,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'paid')),
    pay_run_id INTEGER REFERENCES pay_runs(id) ON DELETE SET NULL,
    edited_by INTEGER REFERENCES users(id)
  );

  -- A worker can only be on the clock once.
  CREATE UNIQUE INDEX IF NOT EXISTS one_open_entry ON time_entries(user_id) WHERE clock_out IS NULL;
  CREATE INDEX IF NOT EXISTS entries_by_status ON time_entries(status, clock_in);
`);

// Columns added after the first release.
if (!db.prepare("SELECT 1 FROM pragma_table_info('users') WHERE name = 'avatar'").get()) {
  db.exec('ALTER TABLE users ADD COLUMN avatar TEXT');
}

const get = (sql, ...params) => db.prepare(sql).get(...params);
const all = (sql, ...params) => db.prepare(sql).all(...params);
const run = (sql, ...params) => db.prepare(sql).run(...params);

function tx(fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

module.exports = { db, get, all, run, tx };
