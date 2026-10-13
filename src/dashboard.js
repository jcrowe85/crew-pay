// Admin dashboard: headline numbers, hours by week, shift status and recent activity.
const { get, all } = require('./db');
const payments = require('./payments');
const { page, badge, table, person, stat, icon } = require('./views');
const { esc, money, fmtMinutes, fmtDateTime, fmtRange, now, entryMinutes, payCents, entryRate, splitPay, LAB_MINUTES } = require('./util');

const WEEKS = 12;
const MINUTES = 'CAST(ROUND((e.clock_out - e.clock_in) / 60.0) AS INTEGER)';

// Monday 00:00 (business time) of the week containing the given date.
function weekStart(date) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return d;
}

function hoursByWeek() {
  const first = weekStart(new Date());
  first.setDate(first.getDate() - 7 * (WEEKS - 1));
  const weeks = Array.from({ length: WEEKS }, (_, i) => {
    const start = new Date(first);
    start.setDate(start.getDate() + 7 * i);
    return { start, minutes: 0 };
  });
  const entries = all(
    'SELECT clock_in, clock_out FROM time_entries WHERE clock_out IS NOT NULL AND clock_in >= ?',
    Math.floor(first.getTime() / 1000),
  );
  for (const e of entries) {
    const index = Math.round((weekStart(new Date(e.clock_in * 1000)) - first) / (7 * 86400 * 1000));
    if (weeks[index]) weeks[index].minutes += entryMinutes(e);
  }
  return weeks;
}

// Smallest "round" axis maximum at or above the tallest bar.
function niceMax(hours) {
  for (const step of [8, 20, 40, 80, 100, 200, 400, 800, 1000, 2000, 4000, 8000]) if (hours <= step) return step;
  return Math.ceil(hours / 10000) * 10000;
}

function barChart(weeks) {
  const W = 720; const H = 270; const left = 46; const right = 8; const top = 12; const bottom = 34;
  const plotH = H - top - bottom;
  const slot = (W - left - right) / weeks.length;
  const barW = Math.min(30, slot * 0.5);
  const max = niceMax(Math.max(...weeks.map((w) => w.minutes / 60), 1));
  const y = (hours) => top + plotH - (hours / max) * plotH;

  const grid = [0, 0.25, 0.5, 0.75, 1].map((f) => {
    const gy = y(max * f);
    return `<line class="grid" x1="${left}" x2="${W - right}" y1="${gy}" y2="${gy}"/>
<text class="axis" x="${left - 10}" y="${gy + 4}" text-anchor="end">${Math.round(max * f)}h</text>`;
  }).join('');

  const bars = weeks.map((w, i) => {
    const hours = w.minutes / 60;
    const x = left + slot * i + (slot - barW) / 2;
    const h = hours > 0 ? Math.max(3, (hours / max) * plotH) : 0;
    const label = w.start.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    return `<g><title>Week of ${esc(label)}: ${esc(fmtMinutes(w.minutes))}</title>
<rect class="ghost" x="${x}" y="${top}" width="${barW}" height="${plotH}" rx="5"/>
${h ? `<rect class="bar" x="${x}" y="${top + plotH - h}" width="${barW}" height="${h}" rx="5"/>` : ''}
<text class="axis" x="${x + barW / 2}" y="${H - 10}" text-anchor="middle">${esc(label)}</text></g>`;
  }).join('');

  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Hours worked per week for the last ${weeks.length} weeks">
<defs><linearGradient id="barFill" x1="0" y1="0" x2="0" y2="1"><stop offset="0" class="bar-from"/><stop offset="1" class="bar-to"/></linearGradient></defs>
${grid}${bars}</svg>`;
}

function statusCard() {
  const since = now() - 30 * 86400;
  const counts = { pending: 0, approved: 0, paid: 0 };
  for (const r of all('SELECT status, COUNT(*) AS n FROM time_entries WHERE clock_out IS NOT NULL AND clock_in >= ? GROUP BY status', since)) {
    counts[r.status] = r.n;
  }
  const total = counts.pending + counts.approved + counts.paid;
  const pct = (n) => (total ? Math.round((n / total) * 100) : 0);
  const parts = [['pending', 'Awaiting approval'], ['approved', 'Approved, unpaid'], ['paid', 'Paid']];

  let x = 0;
  const segments = parts.map(([key]) => {
    const w = total ? (counts[key] / total) * 100 : 0;
    const rect = `<rect class="seg-${key}" x="${x}" y="0" width="${w}" height="8"/>`;
    x += w;
    return rect;
  }).join('');

  return `<section class="card">
<div class="card-head"><h2>Shift status</h2><span class="muted small">Last 30 days</span></div>
<svg class="segbar" viewBox="0 0 100 8" preserveAspectRatio="none" aria-hidden="true"><rect class="seg-empty" width="100" height="8"/>${segments}</svg>
<div class="seg-pcts">${parts.map(([key]) => `<span>${pct(counts[key])}%</span>`).join('')}</div>
<div class="kv"><span>Total shifts</span><strong>${total}</strong></div>
${parts.map(([key, label]) => `<a class="pill-row" href="/admin?status=${key}"><span class="dot seg-${key}"></span>${label}<b>${counts[key]}</b><i>${pct(counts[key])}%</i></a>`).join('')}
</section>`;
}

function accountCard() {
  return `<section class="card">
<div class="card-head"><span class="label">${icon('bank')} Payment account</span></div>
<h3>Stripe payouts</h3>
${payments.enabled
    ? `<p class="state ok">Connected</p><p class="muted small">${payments.autoTopup ? 'Pay runs pull any shortfall from your bank automatically.' : 'Automatic bank pulls are off. Fund the Stripe balance before each pay run.'}</p>`
    : '<p class="state off">Not connected</p><p class="muted small">Payments are recorded by hand until a Stripe key is added.</p>'}
</section>`;
}

function lastRunCard() {
  const last = get(
    `SELECT r.*, COUNT(i.id) AS people, COALESCE(SUM(i.amount_cents), 0) AS total
     FROM pay_runs r LEFT JOIN pay_run_items i ON i.pay_run_id = r.id GROUP BY r.id ORDER BY r.id DESC LIMIT 1`,
  );
  if (!last) {
    return `<section class="card"><div class="card-head"><span class="label">${icon('wallet')} Latest pay run</span></div>
<p class="muted">No pay runs yet.</p></section>`;
  }
  return `<section class="card">
<div class="card-head"><span class="label">${icon('wallet')} Latest pay run</span><a href="/admin/payruns/${last.id}">#${last.id}</a></div>
<div class="run-line"><strong>${esc(money(last.total))}</strong>${badge(last.status)}</div>
<p class="muted small">${esc(fmtRange(last.period_start, last.period_end))} · ${last.people} ${last.people === 1 ? 'person' : 'people'}</p>
</section>`;
}

function dashboard(req, res) {
  const owed = all(
    `SELECT u.hourly_rate_cents, u.lab_rate_cents, SUM(${MINUTES}) AS minutes, SUM(${LAB_MINUTES}) AS lab_minutes FROM time_entries e JOIN users u ON u.id = e.user_id
     WHERE e.status = 'approved' AND e.pay_run_id IS NULL AND e.clock_out IS NOT NULL GROUP BY u.id`,
  );
  const owedCents = owed.reduce((sum, o) => sum + splitPay(o.minutes, o.hourly_rate_cents, o.lab_minutes, o.lab_rate_cents), 0);
  const pending = get(`SELECT COUNT(*) AS n, COALESCE(SUM(${MINUTES}), 0) AS minutes FROM time_entries e WHERE e.status = 'pending' AND e.clock_out IS NOT NULL`);
  const paid = get("SELECT COALESCE(SUM(amount_cents), 0) AS cents, COUNT(*) AS n FROM pay_run_items WHERE status = 'paid' AND paid_at >= ?", now() - 30 * 86400);
  const clockedIn = all(
    `SELECT e.id, e.clock_in, e.lab, u.name, u.avatar, u.hourly_rate_cents, u.lab_rate_cents FROM time_entries e JOIN users u ON u.id = e.user_id
     WHERE e.clock_out IS NULL ORDER BY e.clock_in`,
  );
  const onClock = clockedIn.length;
  const clockedInRows = clockedIn.map((e) => {
    const soFar = Math.max(0, Math.floor((now() - e.clock_in) / 60));
    return [
      person(e.name, e.avatar) + (e.lab_rate_cents == null ? '' : ` <span class="badge ${e.lab ? 'lab' : 'other'}">${e.lab ? 'Lab' : 'Other'}</span>`),
      esc(fmtDateTime(e.clock_in)), esc(fmtMinutes(soFar)), esc(money(payCents(soFar, entryRate(e)))),
      `<a href="/admin/entries/${e.id}/edit">Edit</a>`,
    ];
  });
  const workers = get("SELECT COUNT(*) AS n FROM users WHERE active = 1 AND role = 'worker'").n;

  const weeks = hoursByWeek();
  const totalMinutes = weeks.reduce((sum, w) => sum + w.minutes, 0);
  const recent = all(
    `SELECT e.*, u.name, u.avatar, u.hourly_rate_cents, u.lab_rate_cents FROM time_entries e JOIN users u ON u.id = e.user_id
     WHERE e.clock_out IS NOT NULL ORDER BY e.clock_in DESC LIMIT 6`,
  ).map((e) => {
    const minutes = entryMinutes(e);
    return [person(e.name, e.avatar), esc(fmtDateTime(e.clock_in)), esc(fmtMinutes(minutes)), esc(money(payCents(minutes, entryRate(e)))), badge(e.status)];
  });

  res.send(page(req, `Hi, ${req.user.name.split(' ')[0]}`, `
<section class="stat-grid">
${stat({ label: 'Ready to pay', value: esc(money(owedCents)), hint: `${owed.length} ${owed.length === 1 ? 'person' : 'people'} with approved hours`, iconName: 'wallet', tone: 'violet' })}
${stat({ label: 'Awaiting approval', value: esc(fmtMinutes(pending.minutes)), hint: `${pending.n} ${pending.n === 1 ? 'shift' : 'shifts'} to review`, iconName: 'hourglass', tone: 'orange' })}
${stat({ label: 'Paid, last 30 days', value: esc(money(paid.cents)), hint: `${paid.n} ${paid.n === 1 ? 'payment' : 'payments'}`, iconName: 'check', tone: 'green' })}
${stat({ label: 'On the clock now', value: String(onClock), hint: `of ${workers} active ${workers === 1 ? 'worker' : 'workers'}`, iconName: 'clock', tone: 'blue' })}
</section>

<div class="dash">
  <div class="dash-main">
    <section class="card flush">
      <div class="card-head"><h2>On the clock now</h2><span class="chip-note">${onClock} of ${workers}</span></div>
      ${table(['Worker', 'Since', 'So far', 'Earned', ''], clockedInRows, 'Nobody is clocked in.')}
    </section>
    <section class="card">
      <div class="card-head"><div><span class="muted small">All workers</span><h2>Hours by week</h2></div>
      <span class="chip-note">${esc(fmtMinutes(totalMinutes))} in ${WEEKS} weeks</span></div>
      ${totalMinutes ? barChart(weeks) : '<p class="empty">Hours appear here once shifts are clocked.</p>'}
    </section>
    <section class="card flush">
      <div class="card-head"><h2>Recent shifts</h2><a href="/admin?status=all">View all</a></div>
      ${table(['Worker', 'In', 'Time', 'Amount', 'Status'], recent, 'No shifts yet.')}
    </section>
  </div>
  <div class="dash-side">
    ${statusCard()}
    ${accountCard()}
    ${lastRunCard()}
  </div>
</div>`, {
    lead: 'Here is where your crew’s hours and pay stand today.',
    action: `<a class="button" href="/admin/payruns">Create pay run ${icon('plus')}</a>`,
  }));
}

module.exports = dashboard;
