// The shared crew tablet. An admin marks a device as a kiosk; logged out, it shows every worker's
// name. A worker taps theirs and enters a 4-digit PIN, which they choose the first time using their password.
const express = require('express');
const { get, all, run } = require('./db');
const auth = require('./auth');
const { page, avatar } = require('./views');
const { esc, go } = require('./util');

const PIN_TRIES = 5;
const isPin = (v) => /^\d{4}$/.test(v);

function grid(req) {
  const workers = all(
    `SELECT u.id, u.name, u.email, u.avatar,
            EXISTS (SELECT 1 FROM time_entries e WHERE e.user_id = u.id AND e.clock_out IS NULL) AS on_clock
     FROM users u WHERE u.role = 'worker' AND u.active = 1 ORDER BY u.name`,
  );
  const tiles = workers.map((w) => `<a class="tile${w.on_clock ? ' on' : ''}" href="/kiosk/${w.id}">
${avatar(w.name, w.avatar)}<strong>${esc(w.name)}</strong><small>${esc(w.email)}</small>
${w.on_clock ? '<span class="on-clock"><span class="dot"></span>On the clock</span>' : ''}</a>`).join('');
  return page(req, 'Who are you?', `
${workers.length ? `<div class="tiles">${tiles}</div>` : '<p class="empty">No workers yet. An admin adds them on the Workers page.</p>'}
<p class="back"><a href="/login?form">Admin or email log in</a></p>`, { wide: true });
}

const router = express.Router();

// Kiosk pages only exist on a kiosk device, and only for active workers.
router.use((req, res, next) => (req.kiosk && !req.user ? next() : res.redirect('/')));
router.param('id', (req, res, next, id) => {
  req.worker = get("SELECT * FROM users WHERE id = ? AND role = 'worker' AND active = 1", id);
  if (!req.worker) return res.redirect('/login');
  next();
});

const KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', 'clear', '0', 'back'];
const KEY_LABELS = { clear: 'Clear', back: '⌫' };

router.get('/:id', (req, res) => {
  const w = req.worker;
  const url = `/kiosk/${w.id}`;
  const who = `<div class="pin-who">${avatar(w.name, w.avatar)}<strong>${esc(w.name)}</strong></div>`;
  const back = '<p class="back"><a href="/login">Not you? Back to everyone</a></p>';

  if (!w.pin_hash || 'forgot' in req.query) {
    return res.send(page(req, 'Choose your PIN', `${who}
<p class="muted">Enter your password once, then pick 4 digits. From then on the PIN is all you need on this screen.</p>
<form method="post" action="${url}" class="stack">
<label>Your password<input type="password" name="password" required autocomplete="off"></label>
<label>New PIN (4 digits)<input type="password" name="pin" inputmode="numeric" pattern="\\d{4}" maxlength="4" required autocomplete="off"></label>
<label>PIN again<input type="password" name="pin2" inputmode="numeric" pattern="\\d{4}" maxlength="4" required autocomplete="off"></label>
<button>Save PIN and continue</button>
</form>${back}`, { idle: 120 }));
  }

  res.send(page(req, 'Enter your PIN', `${who}
<form method="post" action="${url}" class="pin-form" data-pin>
<input class="pin" type="password" name="pin" inputmode="numeric" pattern="\\d{4}" maxlength="4" required autocomplete="off" aria-label="Your 4-digit PIN">
<div class="keypad">${KEYS.map((k) => `<button type="button" class="secondary" data-key="${k}">${KEY_LABELS[k] || k}</button>`).join('')}</div>
</form>
<p class="back"><a href="${url}?forgot">Forgot your PIN?</a> · <a href="/login">Not you?</a></p>`, { idle: 45, bare: true }));
});

router.post('/:id', (req, res) => {
  const w = req.worker;
  const url = `/kiosk/${w.id}`;
  const pin = String(req.body.pin || '');

  if ('password' in req.body) {
    // Choosing or replacing a PIN takes the password.
    const retry = `${url}?forgot`;
    if (auth.loginBlocked(req.ip)) return go(res, retry, 'Too many attempts. Try again in 15 minutes.', true);
    if (!auth.matchesLogin(String(req.body.password), w.password_hash)) {
      auth.loginFailed(req.ip);
      return go(res, retry, 'Wrong password. An admin can reset it for you.', true);
    }
    if (!isPin(pin) || pin !== req.body.pin2) return go(res, retry, 'Enter the same 4 digits in both PIN boxes.', true);
    auth.loginSucceeded(req.ip);
    run('UPDATE users SET pin_hash = ?, pin_fails = 0 WHERE id = ?', auth.hashPassword(pin), w.id);
  } else {
    if (!w.pin_hash) return res.redirect(url);
    if (!isPin(pin) || !auth.verifyPassword(pin, w.pin_hash)) {
      const left = PIN_TRIES - w.pin_fails - 1;
      if (left <= 0) {
        // Guessing stops here: the PIN is gone until the password is used to choose a new one.
        run('UPDATE users SET pin_hash = NULL, pin_fails = 0 WHERE id = ?', w.id);
        return go(res, url, 'Too many wrong PINs. Enter your password to choose a new one.', true);
      }
      run('UPDATE users SET pin_fails = pin_fails + 1 WHERE id = ?', w.id);
      return go(res, url, `Wrong PIN. ${left} ${left === 1 ? 'try' : 'tries'} left.`, true);
    }
    run('UPDATE users SET pin_fails = 0 WHERE id = ?', w.id);
  }

  auth.startSession(req, res, w.id, true);
  res.redirect('/clock');
});

module.exports = { router, grid, isPin };
