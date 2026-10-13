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

// Columns and tables added after the first release.
function addColumn(table, column, definition) {
  if (!db.prepare(`SELECT 1 FROM pragma_table_info('${table}') WHERE name = ?`).get(column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}
addColumn('users', 'avatar', 'TEXT');
// auto_send: an admin confirmed this run and it goes out as soon as the bank pull lands.
addColumn('pay_runs', 'auto_send', 'INTEGER NOT NULL DEFAULT 0');
addColumn('pay_runs', 'funding_note', 'TEXT');
// The shared crew tablet: a 4-digit PIN per worker, and sessions started with one.
// The person finished Stripe's bank form; Stripe may still be checking them before payouts_enabled turns on.
addColumn('users', 'payout_submitted', 'INTEGER NOT NULL DEFAULT 0');
addColumn('users', 'pin_hash', 'TEXT');
addColumn('users', 'pin_fails', 'INTEGER NOT NULL DEFAULT 0');
addColumn('sessions', 'kiosk', 'INTEGER NOT NULL DEFAULT 0');
// A worker with a lab rate is paid it for shifts marked as lab work and their normal rate for the rest.
addColumn('users', 'lab_rate_cents', 'INTEGER');
// This worker can only clock in and out on a crew kiosk, not from their own phone.
addColumn('users', 'tablet_only', 'INTEGER NOT NULL DEFAULT 0');
addColumn('time_entries', 'lab', 'INTEGER NOT NULL DEFAULT 0');
// How much of a pay run item's minutes were lab work, and the rate they were paid at.
addColumn('pay_run_items', 'lab_minutes', 'INTEGER NOT NULL DEFAULT 0');
addColumn('pay_run_items', 'lab_rate_cents', 'INTEGER');
db.exec(`
  -- Devices an admin has set up as a crew kiosk. The id is the hash of the device's cookie.
  CREATE TABLE IF NOT EXISTS kiosks (
    id TEXT PRIMARY KEY,
    created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at INTEGER NOT NULL
  );

  -- Money pulled from the business bank account into the Stripe balance to cover a pay run.
  CREATE TABLE IF NOT EXISTS topups (
    id INTEGER PRIMARY KEY,
    pay_run_id INTEGER REFERENCES pay_runs(id) ON DELETE SET NULL,
    stripe_id TEXT NOT NULL UNIQUE,
    amount_cents INTEGER NOT NULL,
    status TEXT NOT NULL,
    expected_at INTEGER,
    error TEXT,
    created_at INTEGER NOT NULL
  );
`);

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

module.exports = { db, file, get, all, run, tx };
