const { esc } = require('./util');
const { isAvatar } = require('./avatars');

const csrf = (req) => `<input type="hidden" name="_csrf" value="${esc(req.session?.csrf)}">`;

const svg = (paths) =>
  `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
const ICONS = {
  grid: svg('<rect x="3.5" y="3.5" width="7" height="7" rx="2"/><rect x="13.5" y="3.5" width="7" height="7" rx="2"/><rect x="3.5" y="13.5" width="7" height="7" rx="2"/><rect x="13.5" y="13.5" width="7" height="7" rx="2"/>'),
  clock: svg('<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>'),
  wallet: svg('<path d="M3 7a2 2 0 0 1 2-2h12v4"/><path d="M3 7v10a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-6a2 2 0 0 0-2-2H5a2 2 0 0 1-2-2z"/><path d="M16.5 14h.01"/>'),
  sheet: svg('<rect x="4" y="3" width="16" height="18" rx="2"/><path d="M8 8h8M8 12h8M8 16h5"/>'),
  users: svg('<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0"/><path d="M16 4.6a3.5 3.5 0 0 1 0 6.8M18 14.2a6.5 6.5 0 0 1 3.5 5.8"/>'),
  key: svg('<circle cx="8" cy="15" r="4"/><path d="M11 12l9-9M16 7l3 3"/>'),
  logout: svg('<path d="M10 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h4"/><path d="M15 8l4 4-4 4M19 12H9"/>'),
  check: svg('<circle cx="12" cy="12" r="9"/><path d="M8.5 12.2l2.4 2.4 4.6-5"/>'),
  hourglass: svg('<path d="M7 3h10M7 21h10M8 3v4l4 5-4 5v4M16 3v4l-4 5 4 5v4"/>'),
  bank: svg('<path d="M3 10l9-6 9 6M5 10v8M9.5 10v8M14.5 10v8M19 10v8M3 20h18"/>'),
  shield: svg('<path d="M12 3l7.5 3v5.5c0 4.4-3 8-7.5 9.5-4.5-1.5-7.5-5.1-7.5-9.5V6z"/><path d="M9 12l2.2 2.2L15 10"/>'),
  close: svg('<path d="M6 6l12 12M18 6L6 18"/>'),
  plus: svg('<path d="M12 5v14M5 12h14"/>'),
};
const icon = (name) => ICONS[name] || '';
const LOGO = `<svg class="logo" viewBox="0 0 32 32" width="30" height="30" aria-hidden="true"><rect width="32" height="32" rx="9" fill="currentColor"/><circle cx="16" cy="16" r="8" fill="none" stroke-width="2.4"/><path d="M16 11.5V16l3 2" fill="none" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

const initials = (name) =>
  String(name || '?').replace(/[^\p{L}\p{N} ]/gu, '').trim().split(/\s+/).slice(0, 2).map((w) => w[0] || '').join('').toUpperCase() || '?';

// A person's chosen cartoon, or a coloured initials circle; the colour is stable per name.
function avatar(name, avatarId) {
  let hue = 0;
  for (const ch of String(name)) hue = (hue * 31 + ch.codePointAt(0)) % 6;
  return isAvatar(avatarId)
    ? `<span class="avatar pic hue${hue}"><img src="/avatars/${avatarId}.svg" alt=""></span>`
    : `<span class="avatar hue${hue}">${esc(initials(name))}</span>`;
}

const person = (name, avatarId) => `<span class="person">${avatar(name, avatarId)}${esc(name)}</span>`;

function nav(req) {
  const user = req.user;
  const path = req.originalUrl.split('?')[0].replace(/\/$/, '');
  const links = user.role === 'admin'
    ? [
      ['/admin/dashboard', 'Dashboard', 'grid', path === '/admin/dashboard'],
      ['/admin', 'Timesheets', 'sheet', path === '/admin' || path.startsWith('/admin/entries')],
      ['/admin/workers', 'Workers', 'users', path.startsWith('/admin/workers')],
      ['/admin/payruns', 'Pay runs', 'wallet', path.startsWith('/admin/payruns')],
      ['/admin/admins', 'Admins', 'shield', path.startsWith('/admin/admins')],
    ]
    : [
      ['/clock', 'Clock', 'clock', path === '/clock'],
      ['/pay', 'Pay', 'wallet', path === '/pay'],
    ];
  if (!req.session.kiosk) links.push(['/account/password', 'Password', 'key', path === '/account/password']);
  return `<nav>${links.map(([href, label, name, current]) =>
    `<a href="${href}"${current ? ' class="current" aria-current="page"' : ''}>${icon(name)}<span>${label}</span></a>`).join('')}</nav>`;
}

// opts.lead: escaped HTML under the title. opts.action: HTML shown to the right of the title.
// Logged-out pages: opts.wide gives the full-width layout, opts.idle returns to /login after that many idle seconds.
function page(req, title, body, { lead = '', action = '', wide = false, idle = 0 } = {}) {
  const user = req.user;
  const msg = req.query?.msg
    ? `<p class="flash ${req.query.err ? 'error' : ''}" role="status">${esc(req.query.msg)}</p>`
    : '';
  const head = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="theme-color" content="#ffffff">
<link rel="manifest" href="/manifest.webmanifest">
<link rel="apple-touch-icon" href="/icon-192.png">
<title>${esc(title)} · Crew Pay</title>
<link rel="preload" href="/fonts/outfit-latin-wght-normal.woff2" as="font" type="font/woff2" crossorigin>
<link rel="stylesheet" href="/style.css">
<script src="/app.js" defer></script>
</head>`;

  if (!user) {
    return `${head}
<body class="auth${wide ? ' wide' : ''}"${idle ? ` data-idle="${idle}"` : ''}>
<main>
  <div class="brand big">${LOGO}<span>Crew Pay</span></div>
  <section class="card">
    <h1>${esc(title)}</h1>
    ${msg}
    ${body}
  </section>
  <p class="muted small">Time tracking and pay for your crew.</p>
</main>
</body>
</html>`;
  }

  const today = new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
  // On the shared tablet a forgotten login is closed for the next person.
  return `${head}
<body${req.session.kiosk ? ' data-idle="60"' : ''}>
<aside class="side">
  <a class="brand" href="/">${LOGO}<span>Crew Pay</span></a>
  ${nav(req)}
  <form method="post" action="/logout" class="side-foot">${csrf(req)}
    <button class="navlink">${icon('logout')}<span>Log out</span></button>
  </form>
</aside>
<div class="shell">
  <header class="top">
    <a class="brand" href="/">${LOGO}<span>Crew Pay</span></a>
    <span class="today">${esc(today)}</span>
    <div class="me">
      <a class="me-avatar" href="/account/avatar" title="Change your avatar" aria-label="Change your avatar">${avatar(user.name, user.avatar)}</a>
      <span class="me-text"><strong>${esc(user.name)}</strong><small>${esc(user.email)}</small></span>
      <form method="post" action="/logout" class="me-logout">${csrf(req)}<button class="ghost" aria-label="Log out">${icon('logout')}</button></form>
    </div>
  </header>
  <main>
  ${msg}
  <div class="page-head">
    <div><h1>${esc(title)}</h1>${lead ? `<p class="muted">${lead}</p>` : ''}</div>
    ${action}
  </div>
  ${body}
  </main>
</div>
</body>
</html>`;
}

const badge = (status) => `<span class="badge ${esc(status)}">${esc(status)}</span>`;

// Rows are arrays of already-escaped HTML cells.
function table(headers, rows, empty = 'Nothing here yet.') {
  if (!rows.length) return `<p class="empty">${esc(empty)}</p>`;
  return `<div class="scroll"><table>
<thead><tr>${headers.map((h) => `<th>${esc(h)}</th>`).join('')}</tr></thead>
<tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join('')}</tr>`).join('')}</tbody>
</table></div>`;
}

// Summary tile: coloured icon chip and label, a rule, then the figure and a hint underneath.
function stat({ label, value, hint = '', iconName = 'wallet', tone = 'violet' }) {
  return `<div class="stat">
<div class="stat-top"><span class="chip ${tone}">${icon(iconName)}</span>${esc(label)}</div>
<strong>${value}</strong>
<small>${hint}</small>
</div>`;
}

module.exports = { csrf, page, badge, table, person, avatar, stat, icon };
