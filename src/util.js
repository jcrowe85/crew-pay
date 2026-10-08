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
  entryMinutes, payCents, parseDollars, go,
};
