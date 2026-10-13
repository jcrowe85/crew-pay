// Daily copies of the database: kept beside it for two weeks and emailed to the admins,
// so the hours survive losing the disk they live on.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { db, file, all, get } = require('./db');
const mailer = require('./mailer');

const KEEP = 14;
const DIR = path.join(path.dirname(file), 'backups');
const NAME = /^crewpay-\d{4}-\d{2}-\d{2}\.db$/;
const today = () => new Date().toLocaleDateString('en-CA'); // YYYY-MM-DD in the business timezone

function writeCopy(target) {
  fs.rmSync(target, { force: true });
  db.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
  // Logins are left out, so restoring a backup never brings an old session back to life.
  const copy = new DatabaseSync(target);
  copy.exec('PRAGMA journal_mode = DELETE; DELETE FROM sessions; VACUUM;');
  copy.close();
}

const kept = () => (fs.existsSync(DIR) ? fs.readdirSync(DIR).filter((f) => NAME.test(f)).sort() : []);

// Who the copy is emailed to: BACKUP_EMAIL_TO (comma separated) or every active admin.
const recipients = () => (process.env.BACKUP_EMAIL_TO
  ? process.env.BACKUP_EMAIL_TO.split(',').map((s) => s.trim()).filter(Boolean)
  : all("SELECT email FROM users WHERE role = 'admin' AND active = 1").map((u) => u.email));

// Makes today's copy if there is none yet and emails it once. Safe to call as often as you like.
async function daily() {
  if (file === ':memory:') return;
  const day = today();
  const target = path.join(DIR, `crewpay-${day}.db`);
  if (!fs.existsSync(target)) {
    fs.mkdirSync(DIR, { recursive: true });
    writeCopy(target);
    for (const old of kept().slice(0, -KEEP)) {
      fs.rmSync(path.join(DIR, old), { force: true });
      fs.rmSync(path.join(DIR, `${old}.emailed`), { force: true });
    }
  }
  const mark = `${target}.emailed`;
  const to = recipients();
  if (!mailer.enabled || !to.length || fs.existsSync(mark)) return;
  const sent = await mailer.sendBackup({
    to,
    day,
    filename: path.basename(target),
    content: fs.readFileSync(target).toString('base64'),
    workers: get("SELECT COUNT(*) AS n FROM users WHERE role = 'worker' AND active = 1").n,
    shifts: get('SELECT COUNT(*) AS n FROM time_entries').n,
    open: get('SELECT COUNT(*) AS n FROM time_entries WHERE clock_out IS NULL').n,
  });
  if (sent.ok) fs.writeFileSync(mark, to.join(', '));
  else console.error(`Backup email for ${day} failed: ${sent.error}`);
}

// A copy made this instant, for an admin to download. The caller deletes the file.
function fresh() {
  const target = path.join(os.tmpdir(), `crewpay-${today()}-${process.pid}-${Date.now()}.db`);
  writeCopy(target);
  return target;
}

// What the Admins page shows: the newest copy, how many are kept, and who it was emailed to.
function status() {
  const files = kept();
  const latest = files.at(-1);
  const mark = latest && path.join(DIR, `${latest}.emailed`);
  return {
    latest: latest ? latest.slice(8, 18) : null,
    count: files.length,
    emailedTo: mark && fs.existsSync(mark) ? fs.readFileSync(mark, 'utf8') : null,
  };
}

module.exports = { daily, fresh, status, today };
