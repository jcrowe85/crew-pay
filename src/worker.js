const express = require('express');
const { get, all, run } = require('./db');
const payments = require('./payments');
const { requireLogin } = require('./auth');
const { csrf, page, badge, table, stat } = require('./views');
const {
  esc, money, fmtMinutes, fmtDateTime, fmtDate, fmtRange, now, entryMinutes, payCents, go,
} = require('./util');

const router = express.Router();
router.use(requireLogin);

const baseUrl = (req) => process.env.BASE_URL || `${req.protocol}://${req.get('host')}`;

function payoutPanel(req) {
  const u = req.user;
  if (!payments.enabled || u.payouts_enabled) return '';
  return `<section class="card warn split">
<div><h2>Set up direct deposit</h2>
<p>Add your bank details with Stripe, our payment processor, so you can be paid. It takes a few minutes.</p></div>
<form method="post" action="/payouts/onboard">${csrf(req)}
<button>${u.stripe_account_id ? 'Finish bank setup' : 'Add bank details'}</button></form>
</section>`;
}

router.get('/clock', (req, res) => {
  const u = req.user;
  const open = get('SELECT * FROM time_entries WHERE user_id = ? AND clock_out IS NULL', u.id);
  const unpaid = all(
    "SELECT * FROM time_entries WHERE user_id = ? AND clock_out IS NOT NULL AND status != 'paid'", u.id,
  );
  const recent = all(
    'SELECT * FROM time_entries WHERE user_id = ? AND clock_out IS NOT NULL ORDER BY clock_in DESC LIMIT 30', u.id,
  );
  const unpaidMinutes = unpaid.reduce((sum, e) => sum + entryMinutes(e), 0);

  const tz = process.env.TZ;
  const today = new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
  const clock = open
    ? `<section class="card hero on">
<span class="eyebrow"><span class="dot"></span>On the clock</span>
<div class="time" data-since="${open.clock_in}">${esc(fmtMinutes(Math.floor((now() - open.clock_in) / 60)))}</div>
<p class="sub">Started ${esc(fmtDateTime(open.clock_in))}</p>
<form method="post" action="/clock/out">${csrf(req)}
<label>Note (optional)<input name="note" maxlength="200" placeholder="What you worked on"></label>
<button class="big stop">Clock out</button></form>
</section>`
    : `<section class="card hero">
<span class="eyebrow"><span class="dot"></span>Off the clock</span>
<div class="time" data-now="${esc(tz)}">${esc(new Date().toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }))}</div>
<p class="sub">${esc(today)}</p>
<form method="post" action="/clock/in">${csrf(req)}<button class="big">Clock in</button></form>
</section>`;

  const rows = recent.map((e) => [
    esc(fmtDateTime(e.clock_in)), esc(fmtDateTime(e.clock_out)), esc(fmtMinutes(entryMinutes(e))),
    badge(e.status), esc(e.note),
  ]);

  res.send(page(req, `Hi, ${u.name.split(' ')[0]}`, `
${clock}
${payoutPanel(req)}
<section class="stat-grid three">
${stat({ label: 'Unpaid hours', value: esc(fmtMinutes(unpaidMinutes)), hint: 'Worked and not yet paid', iconName: 'clock', tone: 'blue' })}
${stat({ label: 'Hourly rate', value: `${esc(money(u.hourly_rate_cents))}/hr`, hint: 'Your current rate', iconName: 'wallet', tone: 'orange' })}
${stat({ label: 'Unpaid total', value: esc(money(payCents(unpaidMinutes, u.hourly_rate_cents))), hint: 'Paid out in the next pay run', iconName: 'check', tone: 'violet' })}
</section>
<h2>Recent shifts</h2>
${table(['In', 'Out', 'Time', 'Status', 'Note'], rows, 'No shifts yet. Clock in to start your first one.')}`,
    { lead: 'Track your time and see what you are owed.' }));
});

router.post('/clock/in', (req, res) => {
  try {
    run('INSERT INTO time_entries (user_id, clock_in) VALUES (?, ?)', req.user.id, now());
  } catch (err) {
    if (String(err.message).includes('UNIQUE')) return go(res, '/clock', 'You are already clocked in.', true);
    throw err;
  }
  go(res, '/clock', 'Clocked in.');
});

router.post('/clock/out', (req, res) => {
  const note = String(req.body.note || '').trim().slice(0, 200) || null;
  const result = run(
    'UPDATE time_entries SET clock_out = ?, note = ? WHERE user_id = ? AND clock_out IS NULL',
    now(), note, req.user.id,
  );
  go(res, '/clock', result.changes ? 'Clocked out.' : 'You were not clocked in.', !result.changes);
});

router.get('/pay', (req, res) => {
  const items = all(
    `SELECT i.*, r.period_start, r.period_end FROM pay_run_items i
     JOIN pay_runs r ON r.id = i.pay_run_id WHERE i.user_id = ? ORDER BY r.period_end DESC`, req.user.id,
  );
  const rows = items.map((i) => [
    esc(fmtRange(i.period_start, i.period_end)),
    esc(fmtMinutes(i.minutes)), esc(money(i.rate_cents)), esc(money(i.amount_cents)),
    badge(i.status === 'paid' ? 'paid' : 'pending'),
    i.paid_at ? esc(fmtDate(i.paid_at)) : '',
  ]);
  res.send(page(req, 'Pay history',
    table(['Period', 'Time', 'Rate', 'Amount', 'Status', 'Paid on'], rows, 'No payments yet.'),
    { lead: 'Every pay run you have been part of.' }));
});

router.post('/payouts/onboard', async (req, res) => {
  if (!payments.enabled) return go(res, '/clock', 'Direct deposit is not available yet.', true);
  res.redirect(await payments.onboardingLink(req.user, baseUrl(req)));
});

router.get('/payouts/return', async (req, res) => {
  if (!payments.enabled) return res.redirect('/clock');
  const ready = await payments.refreshStatus(req.user);
  go(res, '/clock', ready ? 'Direct deposit is set up.' : 'Bank setup is not finished yet.', !ready);
});

router.get('/payouts/refresh', (req, res) => go(res, '/clock', 'That link expired. Start bank setup again.', true));

module.exports = router;
