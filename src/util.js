const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ESC[c]);

const money = (cents) =>
  (cents / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' });

const fmtMinutes = (m) => `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;

// The year is left off dates in the current year to keep tables narrow.
const sameYear = (d) => d.getFullYear() === new Date().getFullYear();
function fmtDateTime(sec) {
  const d = new Date(sec * 1000);
  return d.toLocaleString('en-US', {
    month: 'short', day: 'numeric', ...(sameYear(d) ? {} : { year: 'numeric' }), hour: 'numeric', minute: '2-digit',
  });
}

const fmtDate = (sec) => new Date(sec * 1000).toLocaleDateString('en-US', { dateStyle: 'medium' });

// "Sep 28 – Oct 1, 2026"
function fmtRange(startSec, endSec) {
  const start = new Date(startSec * 1000);
  const end = new Date(endSec * 1000);
  const opts = { month: 'short', day: 'numeric' };
  const from = start.toLocaleDateString('en-US', start.getFullYear() === end.getFullYear() ? opts : { ...opts, year: 'numeric' });
  return `${from} – ${fmtDate(endSec)}`;
}

const now = () => Math.floor(Date.now() / 1000);

// <input type="datetime-local"> values are in the business timezone (process.env.TZ).
const pad = (n) => String(n).padStart(2, '0');
function toInputValue(sec) {
  if (!sec) return '';
  const d = new Date(sec * 1000);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
function fromInputValue(v) {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(v || '')) return null;
  const t = new Date(v).getTime();
  return Number.isNaN(t) ? null : Math.floor(t / 1000);
}

const entryMinutes = (e) => (e.clock_out ? Math.max(0, Math.round((e.clock_out - e.clock_in) / 60)) : 0);
const payCents = (minutes, rateCents) => Math.round((minutes * rateCents) / 60);

// Lab work is paid at the worker's lab rate, when they have one. These take a shift or a worker's
// totals joined with the worker's two rates.
const entryRate = (e) => (e.lab && e.lab_rate_cents != null ? e.lab_rate_cents : e.hourly_rate_cents);
const splitPay = (minutes, rateCents, labMinutes, labRateCents) =>
  payCents(minutes - labMinutes, rateCents) + payCents(labMinutes, labRateCents || 0);
// "$30.00", or "2h 00m lab at $80.00 + 3h 00m at $30.00" when both rates were worked.
function rateText(minutes, rateCents, labMinutes, labRateCents) {
  if (!labMinutes) return money(rateCents);
  const lab = `${fmtMinutes(labMinutes)} lab at ${money(labRateCents)}`;
  return labMinutes === minutes ? lab : `${lab} + ${fmtMinutes(minutes - labMinutes)} at ${money(rateCents)}`;
}
// SQL for the minutes of a shift (e) that are paid at the worker's (u) lab rate.
const LAB_MINUTES = 'CASE WHEN e.lab = 1 AND u.lab_rate_cents IS NOT NULL THEN CAST(ROUND((e.clock_out - e.clock_in) / 60.0) AS INTEGER) ELSE 0 END';

// "18.50" -> 1850. Returns null for anything that isn't a sane dollar amount.
function parseDollars(v) {
  if (!/^\d{1,5}(\.\d{1,2})?$/.test(String(v || '').trim())) return null;
  return Math.round(parseFloat(v) * 100);
}

function go(res, url, msg, isError) {
  if (!msg) return res.redirect(url);
  const sep = url.includes('?') ? '&' : '?';
  res.redirect(`${url}${sep}msg=${encodeURIComponent(msg)}${isError ? '&err=1' : ''}`);
}

module.exports = {
  esc, money, fmtMinutes, fmtDateTime, fmtDate, fmtRange, now, toInputValue, fromInputValue,
  entryMinutes, payCents, entryRate, splitPay, rateText, LAB_MINUTES, parseDollars, go,
};
