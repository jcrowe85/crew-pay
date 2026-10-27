// Keeps the Stripe balance near a set amount, so a pay run can always be sent straight away.
// After money goes out, the app pulls the difference from the bank account saved in Stripe (an ACH
// debit, a few business days), ready for the next pay run. Set STRIPE_REFILL_TO to the amount in dollars.
//
// Everything is read from Stripe, not the app's database, so two copies of the app running with the
// same key cannot each start a pull.
const payments = require('./payments');
const mailer = require('./mailer');
const { all } = require('./db');
const { money, fmtDate } = require('./util');

const target = payments.refillTargetCents;
const enabled = payments.enabled && target > 0;
// Small gaps wait for the next pay run rather than starting a pull of a few dollars.
const MIN_PULL = 2000;

let last = null; // what the newest check found, for the dashboard
let checking = false;

const admins = () => all("SELECT email FROM users WHERE role = 'admin' AND active = 1").map((u) => u.email);

async function tellAdminsItFailed(t) {
  if (t.metadata?.crewpay_told || !mailer.enabled) return;
  const to = admins();
  if (!to.length) return;
  const why = t.failure_message || t.status;
  const sent = await mailer.send({
    to,
    subject: 'Crew Pay: the Stripe refill did not go through',
    text: `The app tried to pull ${money(t.amount)} from your bank into Stripe on ${fmtDate(t.created)}, and it did not go through (${why}).

Automatic refills are paused until you choose "Try the refill again" on the Crew Pay dashboard.
Check the bank account saved in Stripe under Balance > Add to balance first.`,
  });
  if (sent.ok) await payments.tagTopup(t.id, { crewpay_told: '1' });
  else console.error(`Refill failure email failed: ${sent.error}`);
}

// Starts a pull when the balance is short. Safe to call as often as you like.
async function check({ retry = false } = {}) {
  if (!enabled || checking) return last;
  checking = true;
  try {
    const recent = await payments.recentTopups();
    const inFlight = recent.find((t) => t.status === 'pending');
    if (inFlight) {
      last = { state: 'pulling', amount: inFlight.amount, expected: inFlight.expected_availability_date };
      return last;
    }
    const newest = recent.find((t) => t.metadata?.crewpay === 'refill');
    const failed = newest && newest.status !== 'succeeded' && !newest.metadata?.crewpay_cleared;
    if (failed && retry) await payments.tagTopup(newest.id, { crewpay_cleared: '1' });
    else if (failed) {
      await tellAdminsItFailed(newest);
      last = { state: 'failed', amount: newest.amount, error: newest.failure_message || newest.status };
      return last;
    }
    const balance = await payments.availableBalanceCents();
    const short = target - balance;
    if (short < MIN_PULL) {
      last = { state: 'full', balance };
      return last;
    }
    const t = await payments.createRefill(short, recent.filter((r) => r.metadata?.crewpay === 'refill').length);
    last = { state: 'pulling', amount: t.amount, expected: t.expected_availability_date };
    return last;
  } catch (err) {
    console.error(`Refill check failed: ${err.message}`);
    last = { state: 'error', error: err.message };
    return last;
  } finally {
    checking = false;
  }
}

module.exports = { enabled, target, check, status: () => last };
