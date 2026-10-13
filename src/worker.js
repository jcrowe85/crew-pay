const express = require('express');
const { get, all, run } = require('./db');
const payments = require('./payments');
const { requireLogin, requirePassword, endSession } = require('./auth');
const { csrf, page, badge, table, stat } = require('./views');
const {
  esc, money, fmtMinutes, fmtDateTime, fmtDate, fmtRange, now, entryMinutes, splitPay, rateText, go,
} = require('./util');

const router = express.Router();
router.use(requireLogin);

const baseUrl = (req) => process.env.BASE_URL || `${req.protocol}://${req.get('host')}`;

// Someone marked tablet-only can still log in anywhere to see their hours and set up their bank,
// but the clock itself only works on a crew kiosk.
const offTablet = (req) => Boolean(req.user.tablet_only && !req.kiosk);
const TABLET_ONLY = 'Clock in and out on the crew tablet.';

function payoutPanel(req) {
  const u = req.user;
  if (!payments.enabled || u.payouts_enabled) return '';
  if (req.session.kiosk && !u.payout_submitted) {
    return `<section class="card warn">
<h2>Set up direct deposit</h2>
<p>To be paid, add your bank details from your own phone: open ${esc(baseUrl(req).replace(/^https?:\/\//, ''))} and log in with your email and password.</p>
</section>`;
  }
  if (u.payout_submitted) {
    return `<section class="card warn split">
<div><h2>Direct deposit is being checked</h2>
<p>Stripe has your bank details and is checking them. There is nothing more for you to do; this notice goes away when you are ready to be paid.</p></div>
${req.session.kiosk ? '' : `<form method="post" action="/payouts/onboard">${csrf(req)}<button class="secondary">Review my details</button></form>`}
</section>`;
  }
  return `<section class="card warn split">
<div><h2>Set up direct deposit</h2>
<p>Add your bank details with Stripe, our payment processor, so you can be paid. It takes a few minutes.</p></div>
<form method="post" action="/payouts/onboard">${csrf(req)}
<button>${u.stripe_account_id ? 'Finish bank setup' : 'Add bank details'}</button></form>
</section>`;
}

router.get('/clock', async (req, res) => {
  const u = req.user;
  // Picks up Stripe's approval without the person having to do anything.
  if (await payments.refreshIfWaiting(u)) u.payouts_enabled = 1;
  else if (u.stripe_account_id && !u.payouts_enabled) u.payout_submitted = get('SELECT payout_submitted FROM users WHERE id = ?', u.id).payout_submitted;
  const open = get('SELECT * FROM time_entries WHERE user_id = ? AND clock_out IS NULL', u.id);
  const unpaid = all(
    "SELECT * FROM time_entries WHERE user_id = ? AND clock_out IS NOT NULL AND status != 'paid'", u.id,
  );
  const recent = all(
    'SELECT * FROM time_entries WHERE user_id = ? AND clock_out IS NOT NULL ORDER BY clock_in DESC LIMIT 30', u.id,
  );
  const unpaidMinutes = unpaid.reduce((sum, e) => sum + entryMinutes(e), 0);
  // Someone with a lab rate says which kind of work each shift is when they clock in.
  const twoRates = u.lab_rate_cents != null;
  const unpaidLabMinutes = twoRates ? unpaid.reduce((sum, e) => sum + (e.lab ? entryMinutes(e) : 0), 0) : 0;
  const workLabel = (e) => (e.lab ? 'Lab work' : 'Other work');

  const tz = process.env.TZ;
  const locked = offTablet(req);
  const today = new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
  const clock = open
    ? `<section class="card hero on">
<span class="eyebrow"><span class="dot"></span>On the clock${twoRates ? ` · ${workLabel(open)}` : ''}</span>
<div class="time" data-since="${open.clock_in}">${esc(fmtMinutes(Math.floor((now() - open.clock_in) / 60)))}</div>
<p class="sub">Started ${esc(fmtDateTime(open.clock_in))}</p>
${locked ? `<p class="sub">${TABLET_ONLY}</p>` : `<form method="post" action="/clock/out">${csrf(req)}
<label>Note (optional)<input name="note" maxlength="200" placeholder="What you worked on"></label>
<button class="big stop">Clock out</button></form>`}
</section>`
    : `<section class="card hero">
<span class="eyebrow"><span class="dot"></span>Off the clock</span>
<div class="time" data-now="${esc(tz)}">${esc(new Date().toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }))}</div>
<p class="sub">${esc(today)}</p>
${locked ? `<p class="sub">${TABLET_ONLY}</p>` : `<form method="post" action="/clock/in">${csrf(req)}${twoRates
    ? '<button class="big" name="lab" value="1">Start lab work</button><button class="big" name="lab" value="0">Start other work</button>'
    : '<button class="big">Clock in</button>'}</form>`}
</section>`;
  const done = req.session.kiosk
    ? `<form method="post" action="/logout" class="kiosk-done">${csrf(req)}<button class="big secondary">Done, log me out</button></form>`
    : '';

  const rows = recent.map((e) => [
    esc(fmtDateTime(e.clock_in)), esc(fmtDateTime(e.clock_out)), esc(fmtMinutes(entryMinutes(e))),
    ...(twoRates ? [workLabel(e)] : []), badge(e.status), esc(e.note),
  ]);

  res.send(page(req, `Hi, ${u.name.split(' ')[0]}`, `
${clock}
${done}
${payoutPanel(req)}
<section class="stat-grid three">
${stat({ label: 'Unpaid hours', value: esc(fmtMinutes(unpaidMinutes)), hint: 'Worked and not yet paid', iconName: 'clock', tone: 'blue' })}
${stat({ label: 'Hourly rate', value: `${esc(money(u.hourly_rate_cents))}/hr`, hint: twoRates ? `Lab work: ${esc(money(u.lab_rate_cents))}/hr` : 'Your current rate', iconName: 'wallet', tone: 'orange' })}
${stat({ label: 'Unpaid total', value: esc(money(splitPay(unpaidMinutes, u.hourly_rate_cents, unpaidLabMinutes, u.lab_rate_cents))), hint: 'Paid out in the next pay run', iconName: 'check', tone: 'violet' })}
</section>
<h2>Recent shifts</h2>
${table(['In', 'Out', 'Time', ...(twoRates ? ['Work'] : []), 'Status', 'Note'], rows, 'No shifts yet. Clock in to start your first one.')}`,
    { lead: 'Track your time and see what you are owed.' }));
});

// On the shared tablet clocking in or out is the whole visit, so it also logs the person out.
function clocked(req, res, what) {
  if (!req.session.kiosk) return go(res, '/clock', `${what}.`);
  const time = new Date().toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  endSession(req, res);
  go(res, '/login', `${req.user.name} ${what.toLowerCase()} at ${time}.`);
}

router.post('/clock/in', (req, res) => {
  if (offTablet(req)) return go(res, '/clock', TABLET_ONLY, true);
  const twoRates = req.user.lab_rate_cents != null;
  if (twoRates && !['0', '1'].includes(req.body.lab)) return go(res, '/clock', 'Choose lab work or other work.', true);
  const lab = twoRates && req.body.lab === '1' ? 1 : 0;
  try {
    run('INSERT INTO time_entries (user_id, clock_in, lab) VALUES (?, ?, ?)', req.user.id, now(), lab);
  } catch (err) {
    if (String(err.message).includes('UNIQUE')) return go(res, '/clock', 'You are already clocked in.', true);
    throw err;
  }
  clocked(req, res, twoRates ? `Clocked in for ${lab ? 'lab' : 'other'} work` : 'Clocked in');
});

router.post('/clock/out', (req, res) => {
  if (offTablet(req)) return go(res, '/clock', TABLET_ONLY, true);
  const note = String(req.body.note || '').trim().slice(0, 200) || null;
  const result = run(
    'UPDATE time_entries SET clock_out = ?, note = ? WHERE user_id = ? AND clock_out IS NULL',
    now(), note, req.user.id,
  );
  if (!result.changes) return go(res, '/clock', 'You were not clocked in.', true);
  clocked(req, res, 'Clocked out');
});

router.get('/pay', (req, res) => {
  const items = all(
    `SELECT i.*, r.period_start, r.period_end FROM pay_run_items i
     JOIN pay_runs r ON r.id = i.pay_run_id WHERE i.user_id = ? ORDER BY r.period_end DESC`, req.user.id,
  );
  const rows = items.map((i) => [
    esc(fmtRange(i.period_start, i.period_end)),
    esc(fmtMinutes(i.minutes)), esc(rateText(i.minutes, i.rate_cents, i.lab_minutes, i.lab_rate_cents)), esc(money(i.amount_cents)),
    badge(i.status === 'paid' ? 'paid' : 'pending'),
    i.paid_at ? esc(fmtDate(i.paid_at)) : '',
  ]);
  res.send(page(req, 'Pay history',
    table(['Period', 'Time', 'Rate', 'Amount', 'Status', 'Paid on'], rows, 'No payments yet.'),
    { lead: 'Every pay run you have been part of.' }));
});

router.post('/payouts/onboard', requirePassword, async (req, res) => {
  if (!payments.enabled) return go(res, '/clock', 'Direct deposit is not available yet.', true);
  res.redirect(await payments.onboardingLink(req.user, baseUrl(req)));
});

router.get('/payouts/return', async (req, res) => {
  if (!payments.enabled) return res.redirect('/clock');
  const ready = await payments.refreshStatus(req.user);
  if (ready) return go(res, '/clock', 'Direct deposit is set up.');
  const { payout_submitted: submitted } = get('SELECT payout_submitted FROM users WHERE id = ?', req.user.id);
  go(res, '/clock', submitted ? 'Stripe has your details and is checking them. Nothing more to do.' : 'Bank setup is not finished yet.', !submitted);
});

router.get('/payouts/refresh', (req, res) => go(res, '/clock', 'That link expired. Start bank setup again.', true));

module.exports = router;
