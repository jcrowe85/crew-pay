const crypto = require('node:crypto');
const { get, run } = require('./db');
const { now, go } = require('./util');

const SESSION_DAYS = 14;
const KIOSK_SESSION_MINUTES = 15; // a PIN login on the shared tablet
const KIOSK_DAYS = 365;
const MIN_PASSWORD = 10;

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

function verifyPassword(password, stored) {
  const [scheme, saltHex, hashHex] = String(stored).split('$');
  if (scheme !== 'scrypt' || !saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, 'hex');
  const actual = crypto.scryptSync(password, Buffer.from(saltHex, 'hex'), expected.length);
  return crypto.timingSafeEqual(actual, expected);
}

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString('hex');

// Readable temporary password an admin can pass along to a new worker.
function tempPassword() {
  const alphabet = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return Array.from(crypto.randomBytes(14), (b) => alphabet[b % alphabet.length]).join('');
}

function cookieOptions(req) {
  return {
    httpOnly: true,
    sameSite: 'lax',
    secure: req.secure,
    path: '/',
    maxAge: SESSION_DAYS * 86400 * 1000,
  };
}

function startSession(req, res, userId, kiosk = false) {
  run('DELETE FROM sessions WHERE expires_at < ?', now());
  const token = randomToken();
  const seconds = kiosk ? KIOSK_SESSION_MINUTES * 60 : SESSION_DAYS * 86400;
  run(
    'INSERT INTO sessions (id, user_id, csrf, expires_at, kiosk) VALUES (?, ?, ?, ?, ?)',
    sha256(token), userId, randomToken(16), now() + seconds, kiosk ? 1 : 0,
  );
  res.cookie('sid', token, { ...cookieOptions(req), maxAge: seconds * 1000 });
}

function endSession(req, res) {
  if (req.session) run('DELETE FROM sessions WHERE id = ?', req.session.id);
  res.clearCookie('sid', { path: '/' });
}

function readCookie(req, name) {
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}

// Marks this device as a crew kiosk: logged out, it shows everyone's name and takes a PIN.
function registerKiosk(req, res) {
  const token = randomToken();
  run('INSERT INTO kiosks (id, created_by, created_at) VALUES (?, ?, ?)', sha256(token), req.user.id, now());
  res.cookie('kiosk', token, { ...cookieOptions(req), maxAge: KIOSK_DAYS * 86400 * 1000 });
}

function unregisterKiosk(req, res) {
  const token = readCookie(req, 'kiosk');
  if (token) run('DELETE FROM kiosks WHERE id = ?', sha256(token));
  res.clearCookie('kiosk', { path: '/' });
}

// For a lost or replaced tablet: every kiosk except the device in hand stops working.
const unregisterOtherKiosks = (req) => run('DELETE FROM kiosks WHERE id != ?', sha256(readCookie(req, 'kiosk') || ''));

function loadUser(req, res, next) {
  const kiosk = readCookie(req, 'kiosk');
  req.kiosk = Boolean(kiosk && get('SELECT 1 FROM kiosks WHERE id = ?', sha256(kiosk)));
  const token = readCookie(req, 'sid');
  if (token) {
    const session = get('SELECT * FROM sessions WHERE id = ? AND expires_at > ?', sha256(token), now());
    const user = session && get('SELECT * FROM users WHERE id = ? AND active = 1', session.user_id);
    // A PIN session only counts on a device that is still a kiosk.
    if (user && (!session.kiosk || req.kiosk)) {
      req.session = session;
      req.user = user;
    }
  }
  next();
}

// Every POST made with a session must carry that session's CSRF token.
function checkCsrf(req, res, next) {
  if (req.method !== 'POST' || !req.session) return next();
  const sent = Buffer.from(String(req.body?._csrf || ''));
  const expected = Buffer.from(req.session.csrf);
  if (sent.length === expected.length && crypto.timingSafeEqual(sent, expected)) return next();
  res.status(403).send('Form expired. Go back, reload the page and try again.');
}

function requireLogin(req, res, next) {
  if (!req.user) return res.redirect('/login');
  // PIN sessions are for the clock only; passwords are changed on the person's own device.
  if (req.session.kiosk) return next();
  if (req.user.must_change_password && req.path !== '/account/password' && req.path !== '/logout') {
    return go(res, '/account/password', 'Choose your own password to continue.');
  }
  next();
}

function requireAdmin(req, res, next) {
  requireLogin(req, res, () => {
    if (req.user.role !== 'admin' || req.session.kiosk) return res.status(403).send('Admins only.');
    next();
  });
}

// For pages that need the person's password behind them, not just a PIN.
function requirePassword(req, res, next) {
  requireLogin(req, res, () => {
    if (req.session.kiosk) return go(res, '/clock', 'Log in with your email and password on your own phone to do that.', true);
    next();
  });
}

// Slow down password guessing: 10 failures per address locks it out for 15 minutes.
const failures = new Map();
const WINDOW_MS = 15 * 60 * 1000;
function loginBlocked(ip) {
  const f = failures.get(ip);
  if (f && Date.now() - f.first > WINDOW_MS) failures.delete(ip);
  return (failures.get(ip)?.count || 0) >= 10;
}
function loginFailed(ip) {
  const f = failures.get(ip) || { count: 0, first: Date.now() };
  f.count += 1;
  failures.set(ip, f);
}
const loginSucceeded = (ip) => failures.delete(ip);

module.exports = {
  MIN_PASSWORD, hashPassword, verifyPassword, tempPassword, startSession, endSession,
  registerKiosk, unregisterKiosk, unregisterOtherKiosks, loadUser, checkCsrf, requireLogin, requireAdmin, requirePassword, loginBlocked, loginFailed, loginSucceeded,
};
