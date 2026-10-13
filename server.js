try { process.loadEnvFile(); } catch { /* no .env file; use the real environment */ }
// All times are shown and entered in the business timezone.
process.env.TZ = process.env.BUSINESS_TZ || 'America/Chicago';

const path = require('node:path');
const express = require('express');
const { get, run } = require('./src/db');
const auth = require('./src/auth');
const { csrf, page, avatar } = require('./src/views');
const avatars = require('./src/avatars');
const kiosk = require('./src/kiosk');
const { esc, now, go } = require('./src/util');

const app = express();
app.disable('x-powered-by');
if (process.env.TRUST_PROXY) app.set('trust proxy', 1);

app.use((req, res, next) => {
  res.set({
    'Content-Security-Policy': "default-src 'self'; frame-ancestors 'none'; form-action 'self' https://connect.stripe.com",
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'same-origin',
    'Cache-Control': 'no-store',
  });
  next();
});
app.use(express.static(path.join(__dirname, 'public'), { cacheControl: false }));
app.use('/fonts', express.static(path.join(__dirname, 'node_modules/@fontsource-variable/outfit/files'), { cacheControl: false }));
app.use(express.urlencoded({ extended: false, limit: '20kb' }));
app.use(auth.loadUser);
app.use(auth.checkCsrf);

const home = (user) => (user.role === 'admin' ? '/admin/dashboard' : '/clock');
const hasUsers = () => Boolean(get('SELECT 1 FROM users LIMIT 1'));

app.get('/', (req, res) => {
  if (!hasUsers()) return res.redirect('/setup');
  res.redirect(req.user ? home(req.user) : '/login');
});

/* First run: whoever opens the app first creates the admin account. */
app.get('/setup', (req, res) => {
  if (hasUsers()) return res.redirect('/login');
  res.send(page(req, 'Create the admin account', `
<form method="post" action="/setup" class="stack">
<label>Your name<input name="name" required maxlength="100"></label>
<label>Email<input type="email" name="email" required maxlength="200"></label>
<label>Password (at least ${auth.MIN_PASSWORD} characters)<input type="password" name="password" required minlength="${auth.MIN_PASSWORD}" autocomplete="new-password"></label>
<button>Create account</button>
</form>`));
});

app.post('/setup', (req, res) => {
  if (hasUsers()) return res.redirect('/login');
  const name = String(req.body.name || '').trim().slice(0, 100);
  const email = String(req.body.email || '').trim().toLowerCase().slice(0, 200);
  const password = String(req.body.password || '');
  if (!name || !email.includes('@') || password.length < auth.MIN_PASSWORD) {
    return go(res, '/setup', `Fill in every field; the password needs ${auth.MIN_PASSWORD}+ characters.`, true);
  }
  const id = run(
    "INSERT INTO users (email, name, password_hash, role, created_at) VALUES (?, ?, ?, 'admin', ?)",
    email, name, auth.hashPassword(password), now(),
  ).lastInsertRowid;
  auth.startSession(req, res, id);
  res.redirect('/admin/workers');
});

app.get('/login', (req, res) => {
  if (req.user) return res.redirect(home(req.user));
  if (!hasUsers()) return res.redirect('/setup');
  const wantsForm = 'form' in req.query || 'email' in req.query;
  if (req.kiosk && !wantsForm) return res.send(kiosk.grid(req));
  res.send(page(req, 'Log in', `
<form method="post" action="/login" class="stack">
<label>Email<input type="email" name="email" required autocomplete="username" value="${esc(req.query.email)}"></label>
<label>Password<input type="password" name="password" required autocomplete="current-password"></label>
<button>Log in</button>
</form>${req.kiosk ? '<p class="back"><a href="/login">Back to the crew screen</a></p>' : ''}`));
});

app.post('/login', (req, res) => {
  if (auth.loginBlocked(req.ip)) return go(res, '/login', 'Too many attempts. Try again in 15 minutes.', true);
  const email = String(req.body.email || '').trim().toLowerCase();
  const user = get('SELECT * FROM users WHERE email = ? AND active = 1', email);
  if (!user || !auth.matchesLogin(String(req.body.password || ''), user.password_hash)) {
    auth.loginFailed(req.ip);
    return go(res, `/login?email=${encodeURIComponent(email)}`, 'Wrong email or password.', true);
  }
  auth.loginSucceeded(req.ip);
  auth.startSession(req, res, user.id);
  res.redirect(home(user));
});

app.post('/logout', (req, res) => {
  auth.endSession(req, res);
  res.redirect('/login');
});

// Someone on a temporary password has just logged in with it, so they are not asked for it again.
app.get('/account/password', auth.requirePassword, (req, res) => {
  const first = Boolean(req.user.must_change_password);
  // Workers pick their tablet PIN along with their first password.
  const withPin = first && req.user.role === 'worker';
  res.send(page(req, first ? (withPin ? 'Choose your password and PIN' : 'Choose your password') : 'Change password', `
<form method="post" action="/account/password" class="stack">${csrf(req)}
${first ? '' : '<label>Current password<input type="password" name="current" required autocomplete="current-password"></label>'}
<label>New password (at least ${auth.MIN_PASSWORD} characters)<input type="password" name="password" required minlength="${auth.MIN_PASSWORD}" autocomplete="new-password"></label>
${withPin ? `<label>PIN (4 digits)<input type="password" name="pin" inputmode="numeric" pattern="\\d{4}" maxlength="4" required autocomplete="off"></label>
<label>PIN again<input type="password" name="pin2" inputmode="numeric" pattern="\\d{4}" maxlength="4" required autocomplete="off"></label>` : ''}
<button>${withPin ? 'Save password and PIN' : 'Save password'}</button>
</form>`, first ? {
    lead: withPin
      ? 'Pick a password only you know, and a 4-digit PIN for fast log in on the crew tablet.'
      : 'Pick a password only you know. You will use it from now on.',
  } : {}));
});

app.post('/account/password', auth.requirePassword, (req, res) => {
  const password = String(req.body.password || '');
  if (!req.user.must_change_password && !auth.verifyPassword(String(req.body.current || ''), req.user.password_hash)) {
    return go(res, '/account/password', 'Current password is wrong.', true);
  }
  if (password.length < auth.MIN_PASSWORD) {
    return go(res, '/account/password', `Use at least ${auth.MIN_PASSWORD} characters.`, true);
  }
  if (auth.verifyPassword(password, req.user.password_hash)) {
    return go(res, '/account/password', 'Choose a password different from your current one.', true);
  }
  if (req.user.must_change_password && req.user.role === 'worker') {
    const pin = String(req.body.pin || '');
    if (!kiosk.isPin(pin) || pin !== req.body.pin2) return go(res, '/account/password', 'Enter the same 4 digits in both PIN boxes.', true);
    run('UPDATE users SET pin_hash = ?, pin_fails = 0 WHERE id = ?', auth.hashPassword(pin), req.user.id);
  }
  run('UPDATE users SET password_hash = ?, must_change_password = 0 WHERE id = ?', auth.hashPassword(password), req.user.id);
  // Log out every other device.
  run('DELETE FROM sessions WHERE user_id = ? AND id != ?', req.user.id, req.session.id);
  go(res, home(req.user), req.user.must_change_password ? 'Password saved. You are all set.' : 'Password changed.');
});

app.get('/account/avatar', auth.requireLogin, (req, res) => {
  const current = avatars.isAvatar(req.user.avatar) ? req.user.avatar : '';
  const groups = avatars.GROUPS.map(([title, ids]) => `<h2>${title}</h2>
<div class="avatar-grid">${ids.map((id) => {
    const name = esc(avatars.label(id));
    return `<button class="pick${id === current ? ' current' : ''}" name="avatar" value="${id}" title="${name}" aria-label="${name}"${id === current ? ' aria-pressed="true"' : ''}><img src="/avatars/${id}.svg" alt="" loading="lazy"></button>`;
  }).join('')}</div>`).join('');
  res.send(page(req, 'Choose your avatar', `
<form method="post" action="/account/avatar" class="card avatar-picker">${csrf(req)}
<div class="avatar-now">${avatar(req.user.name, current)}<div><strong>${esc(req.user.name)}</strong>
<p class="muted small">${current ? `Currently: ${esc(avatars.label(current))}` : 'Currently showing your initials'}</p></div>
${current ? '<button class="secondary" name="avatar" value="">Use my initials</button>' : ''}</div>
${groups}
<p class="muted small credit">Avatar art: Twemoji, CC-BY 4.0.</p>
</form>`, { lead: 'Click one to use it. Everyone sees it next to your name.' }));
});

app.post('/account/avatar', auth.requireLogin, (req, res) => {
  const choice = String(req.body.avatar || '');
  if (choice && !avatars.isAvatar(choice)) return go(res, '/account/avatar', 'Pick one of the avatars shown.', true);
  run('UPDATE users SET avatar = ? WHERE id = ?', choice || null, req.user.id);
  go(res, '/account/avatar', choice ? 'Avatar updated.' : 'Showing your initials again.');
});

app.use('/admin', require('./src/admin'));
app.use('/kiosk', kiosk.router);
app.use('/', require('./src/worker'));

app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  console.error(err);
  res.status(500).send('Something went wrong. Go back and try again.');
});

if (require.main === module) {
  const port = Number(process.env.PORT) || 3000;
  app.listen(port, () => console.log(`Crew Pay running at http://localhost:${port}`));
  // Bank pulls take days to land, so look in on them every ten minutes.
  // The same visit re-checks anyone waiting on Stripe to approve their bank details.
  const { checkFunding } = require('./src/payout');
  const { refreshAllWaiting } = require('./src/payments');
  const lookIn = () => checkFunding().then(refreshAllWaiting).catch((err) => console.error(err));
  // And makes the day's backup, once, the first time it runs after midnight.
  const backup = require('./src/backup');
  const everyTen = () => {
    lookIn();
    backup.daily().catch((err) => console.error(`Backup failed: ${err.message}`));
  };
  setInterval(everyTen, 10 * 60 * 1000).unref();
  everyTen();
}

module.exports = app;
