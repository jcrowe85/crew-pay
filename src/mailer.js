// Email through Resend. Without RESEND_API_KEY and EMAIL_FROM nothing is sent and logins are shown on screen instead.
const fs = require('node:fs');
const path = require('node:path');
const { esc } = require('./util');

const KEY = process.env.RESEND_API_KEY;
const FROM = process.env.EMAIL_FROM;
const enabled = Boolean(KEY && FROM);
const GUIDE = path.join(__dirname, '..', 'assets', 'how-to-log-hours.pdf');

// Resolves to { ok: true } or { ok: false, error }; never throws.
async function send(message) {
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: FROM, ...message }),
      signal: AbortSignal.timeout(15000),
    });
    if (res.ok) return { ok: true };
    const body = await res.json().catch(() => ({}));
    return { ok: false, error: body.message || `Resend answered ${res.status}` };
  } catch (err) {
    return { ok: false, error: err.name === 'TimeoutError' ? 'Resend did not answer in time' : err.message };
  }
}

// Welcome email with the login details; workers also get the "how to log your hours" PDF.
function sendWelcome({ name, email, password, role }, loginUrl) {
  const first = name.split(' ')[0];
  const isWorker = role !== 'admin';
  const steps = isWorker
    ? ['Open the login page and sign in with the details above.', 'Choose your own password when asked.',
      'Tap Clock in when you start work and Clock out when you finish.', 'Open the Pay tab to see your hours and what you have been paid.']
    : ['Open the login page and sign in with the details above.', 'Choose your own password when asked.',
      'Approve shifts under Timesheets, then create a pay run.'];
  const text = `Hi ${first},

Your Crew Pay account is ready.

Login page: ${loginUrl}
Username: ${email}
Temporary password: ${password}

${steps.map((s, i) => `${i + 1}. ${s}`).join('\n')}
${isWorker ? '\nThe attached PDF shows each step with pictures.\n' : ''}
You will be asked to choose your own password the first time you log in.`;

  const html = `<div style="background:#f4f5f9;padding:32px 16px;font-family:Arial,Helvetica,sans-serif;color:#1c1e2b">
<div style="max-width:520px;margin:0 auto;background:#ffffff;border-radius:16px;padding:32px">
<p style="margin:0 0 20px;font-size:20px;font-weight:bold;color:#5b3ef0">Crew Pay</p>
<h1 style="margin:0 0 8px;font-size:22px">Welcome, ${esc(first)}</h1>
<p style="margin:0 0 20px;color:#5d6275;line-height:1.5">Your account is ready. Here is how to log in.</p>
<table role="presentation" style="width:100%;background:#efecff;border-radius:12px;padding:8px 16px;margin:0 0 22px"><tr><td style="padding:8px 0;color:#5d6275">Username</td><td style="padding:8px 0;font-weight:bold">${esc(email)}</td></tr>
<tr><td style="padding:8px 0;color:#5d6275">Temporary password</td><td style="padding:8px 0;font-weight:bold;font-family:Consolas,Menlo,monospace;font-size:16px">${esc(password)}</td></tr></table>
<p style="margin:0 0 24px"><a href="${esc(loginUrl)}" style="display:inline-block;background:#5b3ef0;color:#ffffff;text-decoration:none;font-weight:bold;padding:13px 26px;border-radius:10px">Log in to Crew Pay</a></p>
<ol style="margin:0 0 20px;padding-left:20px;line-height:1.7;color:#1c1e2b">${steps.map((s) => `<li>${esc(s)}</li>`).join('')}</ol>
${isWorker ? '<p style="margin:0 0 20px;line-height:1.5">The attached PDF, <b>How to log your hours</b>, shows each step with pictures.</p>' : ''}
<p style="margin:0;color:#8b90a3;font-size:13px;line-height:1.5">You will be asked to choose your own password the first time you log in. If the button does not work, open ${esc(loginUrl)}</p>
</div></div>`;

  const message = { to: [email], subject: 'Welcome to Crew Pay: your login', text, html };
  if (isWorker && fs.existsSync(GUIDE)) {
    message.attachments = [{ filename: 'How to log your hours.pdf', content: fs.readFileSync(GUIDE).toString('base64') }];
  }
  return send(message);
}

module.exports = { enabled, sendWelcome };
