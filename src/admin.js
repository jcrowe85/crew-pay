const express = require('express');
const { get, all, run, tx } = require('./db');
const payments = require('./payments');
const mailer = require('./mailer');
const {
  runItems, markItemPaid, sending, sendRun, pendingTopup, payableCents, pullFunds, stopAutoSend, checkFunding,
} = require('./payout');
const { requireAdmin, hashPassword, tempPassword, registerKiosk, unregisterKiosk, unregisterOtherKiosks } = require('./auth');
const { csrf, page, badge, table, person, stat, icon } = require('./views');
const {
  esc, money, fmtMinutes, fmtDateTime, fmtDate, fmtRange, now, toInputValue, fromInputValue,
  entryMinutes, payCents, parseDollars, go,
} = require('./util');

const router = express.Router();
router.use(requireAdmin);

router.get('/dashboard', require('./dashboard'));

const post = (req, action, label, cls = 'link') =>
  `<form method="post" action="${action}" class="inline">${csrf(req)}<button class="${cls}">${label}</button></form>`;

/* ---------- Timesheets ---------- */

router.get('/', (req, res) => {
  const status = ['pending', 'approved', 'paid', 'all'].includes(req.query.status) ? req.query.status : 'pending';
  const open = all(
    `SELECT e.*, u.name, u.avatar FROM time_entries e JOIN users u ON u.id = e.user_id
     WHERE e.clock_out IS NULL ORDER BY e.clock_in`,
  );
  const entries = all(
    `SELECT e.*, u.name, u.avatar, u.hourly_rate_cents FROM time_entries e JOIN users u ON u.id = e.user_id
     WHERE e.clock_out IS NOT NULL AND (? = 'all' OR e.status = ?) ORDER BY e.clock_in DESC LIMIT 300`,
    status, status,
  );

  const openRows = open.map((e) => [
    person(e.name, e.avatar), esc(fmtDateTime(e.clock_in)), `<a href="/admin/entries/${e.id}/edit">Edit</a>`,
  ]);
  const rows = entries.map((e) => {
    const minutes = entryMinutes(e);
    const actions = [];
    if (!e.pay_run_id) {
      if (e.status === 'pending') actions.push(post(req, `/admin/entries/${e.id}/approve`, 'Approve'));
      if (e.status === 'approved') actions.push(post(req, `/admin/entries/${e.id}/unapprove`, 'Unapprove'));
      actions.push(`<a href="/admin/entries/${e.id}/edit">Edit</a>`);
    } else {
      actions.push(`<a href="/admin/payruns/${e.pay_run_id}">Pay run #${e.pay_run_id}</a>`);
    }
    return [
      person(e.name, e.avatar), esc(fmtDateTime(e.clock_in)), esc(fmtDateTime(e.clock_out)), esc(fmtMinutes(minutes)),
      esc(money(payCents(minutes, e.hourly_rate_cents))), badge(e.status), esc(e.note), actions.join(' '),
    ];
  });
  const tabs = ['pending', 'approved', 'paid', 'all']
    .map((s) => `<a href="/admin?status=${s}" class="${s === status ? 'current' : ''}">${s}</a>`).join('');

  res.send(page(req, 'Timesheets', `
<h2>On the clock now</h2>
${table(['Worker', 'Since', ''], openRows, 'Nobody is clocked in.')}
<h2>Shifts</h2>
<div class="toolbar">
  <div class="tabs">${tabs}</div>
  <div class="actions">
    <a class="button secondary" href="/admin/entries/new">Add a shift</a>
    ${status === 'pending' && rows.length ? post(req, '/admin/entries/approve-all', 'Approve all pending', '') : ''}
  </div>
</div>
${table(['Worker', 'In', 'Out', 'Time', 'Amount', 'Status', 'Note', ''], rows, `No ${status === 'all' ? '' : status} shifts.`)}`));
});

router.post('/entries/approve-all', (req, res) => {
  const result = run("UPDATE time_entries SET status = 'approved' WHERE status = 'pending' AND clock_out IS NOT NULL");
  go(res, '/admin', `Approved ${result.changes} shift(s).`);
});

router.post('/entries/:id/approve', (req, res) => {
  run("UPDATE time_entries SET status = 'approved' WHERE id = ? AND status = 'pending' AND clock_out IS NOT NULL", req.params.id);
  res.redirect('/admin');
});

router.post('/entries/:id/unapprove', (req, res) => {
  run("UPDATE time_entries SET status = 'pending' WHERE id = ? AND status = 'approved' AND pay_run_id IS NULL", req.params.id);
  res.redirect('/admin?status=approved');
});

function entryForm(req, entry, workers) {
  const isNew = !entry.id;
  const workerField = isNew
    ? `<label>Worker<select name="user_id" required>${workers.map((w) => `<option value="${w.id}">${esc(w.name)}</option>`).join('')}</select></label>`
    : `<p><strong>${esc(entry.name)}</strong></p>`;
  return `<form method="post" action="${isNew ? '/admin/entries' : `/admin/entries/${entry.id}/edit`}" class="stack">
${csrf(req)}
${workerField}
<label>Clock in<input type="datetime-local" name="clock_in" value="${esc(toInputValue(entry.clock_in))}" required></label>
<label>Clock out<input type="datetime-local" name="clock_out" value="${esc(toInputValue(entry.clock_out))}"></label>
<label>Note<input name="note" maxlength="200" value="${esc(entry.note)}"></label>
<div class="row"><button>Save</button><a href="/admin">Cancel</a></div>
</form>
${isNew ? '' : `<p class="actions">${post(req, `/admin/entries/${entry.id}/delete`, 'Delete this shift', 'link quiet-danger')}</p>`}`;
}

// Returns { clockIn, clockOut, note } or a string describing what is wrong.
function readEntryForm(body) {
  const clockIn = fromInputValue(body.clock_in);
  const clockOut = body.clock_out ? fromInputValue(body.clock_out) : null;
  if (!clockIn) return 'Enter a clock-in time.';
  if (body.clock_out && !clockOut) return 'Clock-out time is not valid.';
  if (clockOut && clockOut <= clockIn) return 'Clock-out must be after clock-in.';
  if (clockOut && clockOut - clockIn > 24 * 3600) return 'A shift cannot be longer than 24 hours.';
  return { clockIn, clockOut, note: String(body.note || '').trim().slice(0, 200) || null };
}

const isOpenClash = (err) => String(err.message).includes('UNIQUE');

router.get('/entries/new', (req, res) => {
  const workers = all("SELECT id, name FROM users WHERE active = 1 AND role = 'worker' ORDER BY name");
  if (!workers.length) return go(res, '/admin/workers', 'Add a worker first.', true);
  res.send(page(req, 'Add a shift', entryForm(req, {}, workers)));
});

router.post('/entries', (req, res) => {
  const form = readEntryForm(req.body);
  if (typeof form === 'string') return go(res, '/admin/entries/new', form, true);
  const worker = get('SELECT id FROM users WHERE id = ?', req.body.user_id);
  if (!worker) return go(res, '/admin/entries/new', 'Pick a worker.', true);
  try {
    run(
      'INSERT INTO time_entries (user_id, clock_in, clock_out, note, edited_by) VALUES (?, ?, ?, ?, ?)',
      worker.id, form.clockIn, form.clockOut, form.note, req.user.id,
    );
  } catch (err) {
    if (isOpenClash(err)) return go(res, '/admin/entries/new', 'That worker is already clocked in.', true);
    throw err;
  }
  go(res, '/admin', 'Shift added.');
});

const editableEntry = (id) =>
  get('SELECT e.*, u.name FROM time_entries e JOIN users u ON u.id = e.user_id WHERE e.id = ? AND e.pay_run_id IS NULL', id);

router.get('/entries/:id/edit', (req, res) => {
  const entry = editableEntry(req.params.id);
  if (!entry) return go(res, '/admin', 'That shift is in a pay run and cannot be changed.', true);
  res.send(page(req, 'Edit shift', entryForm(req, entry)));
});

router.post('/entries/:id/edit', (req, res) => {
  const entry = editableEntry(req.params.id);
  if (!entry) return go(res, '/admin', 'That shift is in a pay run and cannot be changed.', true);
  const form = readEntryForm(req.body);
  if (typeof form === 'string') return go(res, `/admin/entries/${entry.id}/edit`, form, true);
  // A shift with no clock-out is still running, so it cannot stay approved.
  const status = form.clockOut ? entry.status : 'pending';
  try {
    run(
      'UPDATE time_entries SET clock_in = ?, clock_out = ?, note = ?, status = ?, edited_by = ? WHERE id = ?',
      form.clockIn, form.clockOut, form.note, status, req.user.id, entry.id,
    );
  } catch (err) {
    if (isOpenClash(err)) return go(res, `/admin/entries/${entry.id}/edit`, 'That worker is already clocked in on another shift.', true);
    throw err;
  }
  go(res, '/admin', 'Shift updated.');
});

router.post('/entries/:id/delete', (req, res) => {
  const result = run('DELETE FROM time_entries WHERE id = ? AND pay_run_id IS NULL', req.params.id);
  go(res, '/admin', result.changes ? 'Shift deleted.' : 'That shift is in a pay run and cannot be deleted.', !result.changes);
});

/* ---------- Workers and admins ---------- */

// Workers and admins are both rows in users, shown on separate pages.
const listUrl = (role) => (role === 'admin' ? '/admin/admins' : '/admin/workers');

function payoutStatus(u) {
  if (u.payouts_enabled) return badge('ready');
  return u.stripe_account_id ? badge('incomplete') : '<span class="muted">not set up</span>';
}

// Turning a shared tablet into a crew kiosk, from the tablet itself.
function kioskCard(req) {
  const others = get('SELECT COUNT(*) AS n FROM kiosks').n - (req.kiosk ? 1 : 0);
  return `<section class="card split">
<div><h2>Shared tablet</h2>
<p class="muted">${req.kiosk
    ? 'This device is a crew kiosk. Log out and it shows every worker; they tap their name and enter a 4-digit PIN.'
    : 'Log in here on the crew tablet and turn this on. Logged out, it then shows every worker; they tap their name and enter a 4-digit PIN.'}</p></div>
<div class="actions">${req.kiosk
    ? post(req, '/admin/kiosk/off', 'Stop using this device as a kiosk', 'secondary')
    : post(req, '/admin/kiosk/on', 'Use this device as the crew kiosk', '')}
${others > 0 ? post(req, '/admin/kiosk/off-all', `Turn off ${others} other kiosk${others === 1 ? '' : 's'}`, 'secondary') : ''}</div>
</section>`;
}

function peoplePage(req, role, notice = '') {
  const isAdmin = role === 'admin';
  const users = all('SELECT * FROM users WHERE role = ? ORDER BY active DESC, name', role);
  const rows = users.map((u) => [
    `<a href="${listUrl(role)}/${u.id}">${person(u.name, u.avatar)}</a>`, esc(u.email),
    ...(isAdmin ? [] : [`${esc(money(u.hourly_rate_cents))}/hr`, payoutStatus(u)]),
    u.active ? 'Active' : '<span class="muted">Inactive</span>',
  ]);
  const headers = isAdmin ? ['Name', 'Email', 'Status'] : ['Name', 'Email', 'Rate', 'Direct deposit', 'Status'];
  return page(req, isAdmin ? 'Admins' : 'Workers', `
${notice}
${table(headers, rows, isAdmin ? 'No admins yet.' : 'No workers yet. Use the Add worker button to add the first one.')}
${isAdmin ? '' : kioskCard(req)}
<dialog id="add-person" class="modal" aria-labelledby="add-person-title">
<form method="post" action="${listUrl(role)}" class="stack">${csrf(req)}
<div class="modal-head"><h2 id="add-person-title">${isAdmin ? 'Add an admin' : 'Add a worker'}</h2>
<button type="button" class="ghost" data-close-dialog aria-label="Close">${icon('close')}</button></div>
<label>Name<input name="name" required maxlength="100" autofocus></label>
<label>Email<input type="email" name="email" required maxlength="200"></label>
${isAdmin ? '' : '<label>Hourly rate ($)<input name="rate" inputmode="decimal" placeholder="20.00" required></label>'}
<p class="muted small">${mailer.enabled
    ? `They get a welcome email with their username and a temporary password${isAdmin ? '' : ', plus a picture guide to logging hours'}.`
    : 'Their temporary password is shown on screen once for you to pass along.'}</p>
<div class="row"><button>${isAdmin ? 'Add admin' : 'Add worker'}</button><button type="button" class="link" data-close-dialog>Cancel</button></div>
</form>
</dialog>`, {
    lead: isAdmin
      ? 'People who manage timesheets, workers and pay. They are not paid through the app.'
      : 'People who clock in and get paid.',
    action: `<button type="button" data-open-dialog="add-person">${isAdmin ? 'Add admin' : 'Add worker'} ${icon('plus')}</button>`,
  });
}

const passwordNotice = (name, email, password) => `<section class="card warn">
<h2>Login for ${esc(name)}</h2>
<p>Email: <code>${esc(email)}</code><br>Temporary password: <code>${esc(password)}</code></p>
<p>Pass this along now. It is not shown again, and they must choose their own password at first login.</p>
</section>`;

const baseUrl = (req) => process.env.BASE_URL || `${req.protocol}://${req.get('host')}`;

// Emails the new person their login. If that is not possible the login is shown on screen instead.
async function welcomeNotice(req, person, password) {
  if (!mailer.enabled) return passwordNotice(person.name, person.email, password);
  const sent = await mailer.sendWelcome({ ...person, password }, `${baseUrl(req)}/login`);
  if (sent.ok) {
    return `<section class="card good"><h2>${esc(person.name)} was added</h2>
<p>A welcome email with their username and temporary password${person.role === 'admin' ? '' : ', and the guide to logging hours,'} is on its way to <strong>${esc(person.email)}</strong>.</p></section>`;
  }
  console.error(`Welcome email to ${person.email} failed: ${sent.error}`);
  return `<p class="flash error" role="alert">The welcome email could not be sent (${esc(sent.error)}). Pass the login below along yourself.</p>
${passwordNotice(person.name, person.email, password)}`;
}

router.get('/workers', (req, res) => res.send(peoplePage(req, 'worker')));

router.post('/kiosk/on', (req, res) => {
  if (!req.kiosk) registerKiosk(req, res);
  go(res, '/admin/workers', 'This device is now the crew kiosk. Log out to show the crew screen.');
});
router.post('/kiosk/off', (req, res) => {
  unregisterKiosk(req, res);
  go(res, '/admin/workers', 'This device is no longer a kiosk.');
});
router.post('/kiosk/off-all', (req, res) => {
  unregisterOtherKiosks(req);
  go(res, '/admin/workers', 'The other kiosks are turned off.');
});
router.get('/admins', (req, res) => res.send(peoplePage(req, 'admin')));

// Returns { name, email, rate } or a string describing what is wrong. Only workers have a rate.
function readPersonForm(body, withRate) {
  const name = String(body.name || '').trim().slice(0, 100);
  const email = String(body.email || '').trim().toLowerCase().slice(0, 200);
  const rate = withRate ? parseDollars(body.rate) : 0;
  if (!name) return 'Enter a name.';
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return 'Enter a valid email.';
  if (rate === null) return 'Enter the hourly rate as dollars, like 20 or 18.50.';
  return { name, email, rate };
}

function addPerson(role) {
  return async (req, res) => {
    const form = readPersonForm(req.body, role === 'worker');
    if (typeof form === 'string') return go(res, listUrl(role), form, true);
    if (get('SELECT 1 FROM users WHERE email = ?', form.email)) {
      return go(res, listUrl(role), 'Someone with that email already exists.', true);
    }
    const password = tempPassword();
    run(
      `INSERT INTO users (email, name, password_hash, role, hourly_rate_cents, must_change_password, created_at)
       VALUES (?, ?, ?, ?, ?, 1, ?)`,
      form.email, form.name, hashPassword(password), role, form.rate, now(),
    );
    res.send(peoplePage(req, role, await welcomeNotice(req, { name: form.name, email: form.email, role }, password)));
  };
}
router.post('/workers', addPerson('worker'));
router.post('/admins', addPerson('admin'));

router.get(['/workers/:id', '/admins/:id'], (req, res) => {
  const u = get('SELECT * FROM users WHERE id = ?', req.params.id);
  if (!u) return go(res, '/admin/workers', 'No such person.', true);
  const url = `${listUrl(u.role)}/${u.id}`;
  // Keep the address (and the highlighted menu item) in step with the person's role.
  if (req.baseUrl + req.path !== url) return res.redirect(url);
  const self = u.id === req.user.id;
  const isAdmin = u.role === 'admin';
  res.send(page(req, u.name, `
<form method="post" action="${url}" class="stack">${csrf(req)}
<label>Name<input name="name" required maxlength="100" value="${esc(u.name)}"></label>
<label>Email<input type="email" name="email" required maxlength="200" value="${esc(u.email)}"></label>
${isAdmin ? '' : `<label>Hourly rate ($)<input name="rate" inputmode="decimal" required value="${(u.hourly_rate_cents / 100).toFixed(2)}"></label>
<p class="muted small">A new rate applies to pay runs created from now on.</p>`}
<label class="check"><input type="checkbox" name="active" ${u.active ? 'checked' : ''} ${self ? 'disabled' : ''}> Active (can log in)</label>
<div class="row"><button>Save</button><a href="${listUrl(u.role)}">Cancel</a></div>
</form>
<p class="actions">${post(req, `${url}/reset-password`, 'Reset password', 'secondary')}
${self ? '' : post(req, `${url}/role`, isAdmin ? 'Change to worker' : 'Make admin', 'secondary')}</p>`, { lead: esc(u.email) }));
});

router.post(['/workers/:id', '/admins/:id'], (req, res) => {
  const u = get('SELECT * FROM users WHERE id = ?', req.params.id);
  if (!u) return go(res, '/admin/workers', 'No such person.', true);
  const url = `${listUrl(u.role)}/${u.id}`;
  const form = readPersonForm(req.body, u.role === 'worker');
  if (typeof form === 'string') return go(res, url, form, true);
  if (get('SELECT 1 FROM users WHERE email = ? AND id != ?', form.email, u.id)) {
    return go(res, url, 'Someone else already uses that email.', true);
  }
  // Admins cannot deactivate themselves, so there is always a way back in.
  const active = u.id === req.user.id || req.body.active ? 1 : 0;
  const rate = u.role === 'worker' ? form.rate : u.hourly_rate_cents;
  run('UPDATE users SET name = ?, email = ?, hourly_rate_cents = ?, active = ? WHERE id = ?',
    form.name, form.email, rate, active, u.id);
  if (!active) run('DELETE FROM sessions WHERE user_id = ?', u.id);
  go(res, listUrl(u.role), 'Saved.');
});

// Moves someone between the Workers and Admins lists. Nobody can change their own role.
router.post(['/workers/:id/role', '/admins/:id/role'], (req, res) => {
  const u = get('SELECT * FROM users WHERE id = ?', req.params.id);
  if (!u) return go(res, '/admin/workers', 'No such person.', true);
  if (u.id === req.user.id) return go(res, `${listUrl(u.role)}/${u.id}`, 'You cannot change your own role.', true);
  const role = u.role === 'admin' ? 'worker' : 'admin';
  run('UPDATE users SET role = ? WHERE id = ?', role, u.id);
  go(res, `${listUrl(role)}/${u.id}`, role === 'admin' ? `${u.name} is now an admin.` : `${u.name} is now a worker. Check their hourly rate.`);
});

router.post(['/workers/:id/reset-password', '/admins/:id/reset-password'], (req, res) => {
  const u = get('SELECT * FROM users WHERE id = ?', req.params.id);
  if (!u) return go(res, '/admin/workers', 'No such person.', true);
  const password = tempPassword();
  // The PIN goes too, so a reset fully locks out whoever knew the old login.
  run('UPDATE users SET password_hash = ?, must_change_password = 1, pin_hash = NULL, pin_fails = 0 WHERE id = ?', hashPassword(password), u.id);
  if (u.id !== req.user.id) run('DELETE FROM sessions WHERE user_id = ?', u.id);
  res.send(peoplePage(req, u.role, passwordNotice(u.name, u.email, password)));
});

/* ---------- Pay runs ---------- */

const owedByWorker = (through) => all(
  `SELECT u.id, u.name, u.avatar, u.hourly_rate_cents, MIN(e.clock_in) AS first_in,
          SUM(CAST(ROUND((e.clock_out - e.clock_in) / 60.0) AS INTEGER)) AS minutes
   FROM time_entries e JOIN users u ON u.id = e.user_id
   WHERE e.status = 'approved' AND e.pay_run_id IS NULL AND e.clock_out <= ?
   GROUP BY u.id ORDER BY u.name`, through,
);

function endOfDay(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value || '')) return null;
  const t = new Date(`${value}T23:59:59`).getTime();
  return Number.isNaN(t) ? null : Math.floor(t / 1000);
}

router.get('/payruns', (req, res) => {
  const owed = owedByWorker(now());
  const total = owed.reduce((sum, o) => sum + payCents(o.minutes, o.hourly_rate_cents), 0);
  const owedRows = owed.map((o) => [
    person(o.name, o.avatar), esc(fmtMinutes(o.minutes)), esc(money(o.hourly_rate_cents)),
    esc(money(payCents(o.minutes, o.hourly_rate_cents))),
  ]);
  const runs = all(
    `SELECT r.*, COUNT(i.id) AS people, COALESCE(SUM(i.amount_cents), 0) AS total
     FROM pay_runs r LEFT JOIN pay_run_items i ON i.pay_run_id = r.id GROUP BY r.id ORDER BY r.id DESC`,
  );
  const runRows = runs.map((r) => [
    `<a href="/admin/payruns/${r.id}">#${r.id}</a>`,
    esc(fmtRange(r.period_start, r.period_end)),
    String(r.people), esc(money(r.total)), badge(r.status),
  ]);
  const today = toInputValue(now()).slice(0, 10);

  res.send(page(req, 'Pay runs', `
<h2>Approved and not yet paid</h2>
${table(['Worker', 'Time', 'Rate', 'Amount'], owedRows, 'No approved hours are waiting to be paid.')}
${owed.length ? `<p class="total">Total: ${esc(money(total))}</p>
<form method="post" action="/admin/payruns" class="stack">${csrf(req)}
<label>Include approved shifts through<input type="date" name="through" value="${today}" required></label>
<button>Create pay run</button>
</form>
<p class="muted small">Creating a pay run only locks the hours in for review. No money moves until you send it.</p>` : ''}
<h2>History</h2>
${table(['Run', 'Period', 'People', 'Total', 'Status'], runRows, 'No pay runs yet.')}`));
});

router.post('/payruns', (req, res) => {
  const through = endOfDay(req.body.through);
  if (!through) return go(res, '/admin/payruns', 'Pick a date.', true);
  const runId = tx(() => {
    const owed = owedByWorker(through);
    if (!owed.length) return null;
    const start = Math.min(...owed.map((o) => o.first_in));
    const id = run(
      'INSERT INTO pay_runs (period_start, period_end, created_by, created_at) VALUES (?, ?, ?, ?)',
      start, through, req.user.id, now(),
    ).lastInsertRowid;
    for (const o of owed) {
      run(
        'INSERT INTO pay_run_items (pay_run_id, user_id, minutes, rate_cents, amount_cents) VALUES (?, ?, ?, ?, ?)',
        id, o.id, o.minutes, o.hourly_rate_cents, payCents(o.minutes, o.hourly_rate_cents),
      );
    }
    run(
      "UPDATE time_entries SET pay_run_id = ? WHERE status = 'approved' AND pay_run_id IS NULL AND clock_out <= ?",
      id, through,
    );
    return id;
  });
  if (!runId) return go(res, '/admin/payruns', 'No approved hours up to that date.', true);
  res.redirect(`/admin/payruns/${runId}`);
});

router.get('/payruns/:id', async (req, res) => {
  if (pendingTopup(req.params.id)) await checkFunding();
  const payRun = get('SELECT * FROM pay_runs WHERE id = ?', req.params.id);
  if (!payRun) return go(res, '/admin/payruns', 'No such pay run.', true);
  const items = runItems(payRun.id);
  const unpaid = items.filter((i) => i.status !== 'paid');
  const unpaidTotal = unpaid.reduce((sum, i) => sum + i.amount_cents, 0);
  const total = items.reduce((sum, i) => sum + i.amount_cents, 0);

  const rows = items.map((i) => [
    person(i.name, i.avatar), esc(fmtMinutes(i.minutes)), esc(money(i.rate_cents)), esc(money(i.amount_cents)),
    badge(i.status) + (i.error ? `<br><small class="error">${esc(i.error)}</small>` : ''),
    i.status === 'paid'
      ? `${esc(i.method)}${i.stripe_transfer_id ? ` <small>${esc(i.stripe_transfer_id)}</small>` : ''}`
      : payoutStatus(i),
    i.status === 'paid' ? esc(fmtDate(i.paid_at)) : post(req, `/admin/payruns/${payRun.id}/items/${i.id}/mark-paid`, 'Mark paid by hand'),
  ]);

  let sendPanel = '';
  const pull = pendingTopup(payRun.id);
  const note = payRun.funding_note ? `<p class="flash${/Nothing was sent|could not/.test(payRun.funding_note) ? ' error' : ''}" role="status">${esc(payRun.funding_note)}</p>` : '';
  if (unpaid.length && pull) {
    sendPanel = `<section class="card">
<h2>${esc(money(pull.amount_cents))} is on its way from your bank</h2>
<p>Started ${esc(fmtDate(pull.created_at))}${pull.expected_at ? `, expected by <strong>${esc(fmtDate(pull.expected_at))}</strong>` : ''}.
${payRun.auto_send
    ? 'Payments are sent automatically as soon as it lands. Nothing more to do.'
    : 'Automatic sending is off, so come back and send the payments once it lands.'}</p>
${payRun.auto_send ? `<p class="actions">${post(req, `/admin/payruns/${payRun.id}/hold`, 'Do not send automatically', 'link')}</p>` : ''}
</section>`;
  } else if (unpaid.length && payments.enabled) {
    let balanceLine = '';
    let short = 0;
    try {
      const balance = await payments.availableBalanceCents();
      short = Math.max(0, payableCents(payRun.id) - balance);
      balanceLine = `<p>Stripe balance available: <strong>${esc(money(balance))}</strong>.${!short ? ''
        : payments.autoTopup
          ? ` That is ${esc(money(short))} short, so confirming pulls <strong>${esc(money(short))}</strong> from your bank. It takes a few business days, and payments go out by themselves when it lands.`
          : ' <span class="error">Not enough to cover this run. Add funds in Stripe first.</span>'}</p>`;
    } catch (err) {
      balanceLine = `<p class="error">Could not read the Stripe balance: ${esc(err.message)}</p>`;
    }
    const pulling = short > 0 && payments.autoTopup;
    sendPanel = `<section class="card">
<h2>Send ${esc(money(unpaidTotal))} to ${unpaid.length} ${unpaid.length === 1 ? 'person' : 'people'}</h2>
${balanceLine}
<form method="post" action="/admin/payruns/${payRun.id}/pay" class="stack">${csrf(req)}
<label>Type PAY to confirm<input name="confirm" autocomplete="off" required pattern="PAY"></label>
<button class="danger">${pulling ? 'Pull funds and send' : 'Send payments'}</button>
</form>
<p class="muted small">Payments cannot be pulled back once sent. Anyone without direct deposit set up is skipped.</p>
</section>`;
  } else if (unpaid.length) {
    sendPanel = `<section class="card warn"><p>Stripe is not connected, so payments are not sent from here.
Pay each person yourself, then use “Mark paid by hand”. See the README to connect Stripe.</p></section>`;
  }

  const anyPaid = items.some((i) => i.status === 'paid');
  res.send(page(req, `Pay run #${payRun.id}`, `
<section class="stat-grid three">
${stat({ label: 'Period', value: esc(fmtRange(payRun.period_start, payRun.period_end)), hint: `${items.length} ${items.length === 1 ? 'person' : 'people'}`, iconName: 'sheet', tone: 'blue' })}
${stat({ label: 'Status', value: badge(payRun.status), hint: unpaid.length ? `${unpaid.length} still to pay` : 'Everyone is paid', iconName: 'check', tone: 'green' })}
${stat({ label: 'Total', value: esc(money(total)), hint: unpaid.length ? `${esc(money(unpaidTotal))} outstanding` : 'Nothing outstanding', iconName: 'wallet', tone: 'violet' })}
</section>
${note}
${table(['Worker', 'Time', 'Rate', 'Amount', 'Status', 'Payment', ''], rows)}
${sendPanel}
<p class="actions">
  <a class="button secondary" href="/admin/payruns/${payRun.id}/export.csv">Download CSV</a>
  ${anyPaid ? '' : post(req, `/admin/payruns/${payRun.id}/delete`, 'Cancel this pay run', 'link quiet-danger')}
</p>`));
});

router.post('/payruns/:id/pay', async (req, res) => {
  const payRun = get('SELECT * FROM pay_runs WHERE id = ?', req.params.id);
  if (!payRun) return go(res, '/admin/payruns', 'No such pay run.', true);
  const back = `/admin/payruns/${payRun.id}`;
  if (!payments.enabled) return go(res, back, 'Stripe is not connected.', true);
  if (req.body.confirm !== 'PAY') return go(res, back, 'Type PAY to confirm.', true);
  if (sending.has(payRun.id)) return go(res, back, 'This pay run is already being sent.', true);
  if (pendingTopup(payRun.id)) return go(res, back, 'A bank pull for this pay run is already on its way.', true);

  if (payments.autoTopup) {
    // Short of funds: pull the difference from the bank, and send once it lands.
    let short;
    try {
      short = payableCents(payRun.id) - await payments.availableBalanceCents();
    } catch (err) {
      return go(res, back, `Could not read the Stripe balance: ${err.message}`, true);
    }
    if (short > 0) {
      try {
        const topup = await pullFunds(payRun.id, short);
        const when = topup.expected_availability_date ? ` It should arrive by ${fmtDate(topup.expected_availability_date)}.` : '';
        return go(res, back, `Pulling ${money(short)} from your bank.${when} Payments go out automatically when it lands.`);
      } catch (err) {
        return go(res, back, `The bank pull could not be started: ${err.message}`, true);
      }
    }
  }

  const result = await sendRun(payRun.id);
  if (!result) return go(res, back, 'This pay run is already being sent.', true);
  stopAutoSend(payRun.id, null);
  go(res, back, `Sent ${result.sent} payment(s)${result.skipped ? `, ${result.skipped} not sent (see below)` : ''}.`, result.skipped > 0);
});

// Keeps the money that is on its way but leaves sending to a person.
router.post('/payruns/:id/hold', (req, res) => {
  stopAutoSend(req.params.id, 'Automatic sending was switched off. Send the payments yourself once the funds arrive.');
  go(res, `/admin/payruns/${req.params.id}`, 'Payments will not be sent automatically.');
});

router.post('/payruns/:id/items/:itemId/mark-paid', (req, res) => {
  const item = get("SELECT * FROM pay_run_items WHERE id = ? AND pay_run_id = ? AND status != 'paid'", req.params.itemId, req.params.id);
  const back = `/admin/payruns/${req.params.id}`;
  if (!item) return go(res, back, 'That payment is already marked paid.', true);
  if (sending.has(item.pay_run_id)) return go(res, back, 'This pay run is being sent right now.', true);
  markItemPaid(item, 'manual', null);
  go(res, back, 'Marked as paid.');
});

router.post('/payruns/:id/delete', (req, res) => {
  const id = Number(req.params.id);
  if (sending.has(id)) return go(res, `/admin/payruns/${id}`, 'This pay run is being sent right now.', true);
  if (pendingTopup(id)) return go(res, `/admin/payruns/${id}`, 'A bank pull for this pay run is on its way, so it cannot be cancelled.', true);
  const deleted = tx(() => {
    if (get("SELECT 1 FROM pay_run_items WHERE pay_run_id = ? AND status = 'paid'", id)) return false;
    run('UPDATE time_entries SET pay_run_id = NULL WHERE pay_run_id = ?', id);
    return run('DELETE FROM pay_runs WHERE id = ?', id).changes > 0;
  });
  if (!deleted) return go(res, `/admin/payruns/${id}`, 'A pay run with payments in it cannot be cancelled.', true);
  go(res, '/admin/payruns', 'Pay run cancelled. Its shifts are back in the approved list.');
});

// Quote every cell and neutralise leading = + - @ so spreadsheets never run a name as a formula.
const csvCell = (v) => {
  const s = String(v ?? '');
  return `"${(/^[=+\-@\t\r]/.test(s) ? `'${s}` : s).replace(/"/g, '""')}"`;
};

router.get('/payruns/:id/export.csv', (req, res) => {
  const payRun = get('SELECT * FROM pay_runs WHERE id = ?', req.params.id);
  if (!payRun) return res.status(404).send('No such pay run.');
  const lines = [['Name', 'Email', 'Hours', 'Rate', 'Amount', 'Status', 'Method', 'Transfer', 'Paid on']];
  for (const i of runItems(payRun.id)) {
    lines.push([
      i.name, i.email, (i.minutes / 60).toFixed(2), (i.rate_cents / 100).toFixed(2), (i.amount_cents / 100).toFixed(2),
      i.status, i.method, i.stripe_transfer_id, i.paid_at ? new Date(i.paid_at * 1000).toISOString().slice(0, 10) : '',
    ]);
  }
  res.type('text/csv').attachment(`pay-run-${payRun.id}.csv`).send(lines.map((l) => l.map(csvCell).join(',')).join('\r\n'));
});

module.exports = router;
