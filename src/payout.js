// Sending a pay run through Stripe, and pulling money from the bank first when the balance is short.
const { get, all, run, tx } = require('./db');
const payments = require('./payments');
const { money, fmtDate, now } = require('./util');

const runItems = (runId) => all(
  `SELECT i.*, u.name, u.avatar, u.email, u.stripe_account_id, u.payouts_enabled
   FROM pay_run_items i JOIN users u ON u.id = i.user_id WHERE i.pay_run_id = ? ORDER BY u.name`, runId,
);

function markItemPaid(item, method, transferId) {
  tx(() => {
    run(
      "UPDATE pay_run_items SET status = 'paid', method = ?, stripe_transfer_id = ?, error = NULL, paid_at = ? WHERE id = ?",
      method, transferId, now(), item.id,
    );
    run("UPDATE time_entries SET status = 'paid' WHERE pay_run_id = ? AND user_id = ?", item.pay_run_id, item.user_id);
    const left = get("SELECT COUNT(*) AS n FROM pay_run_items WHERE pay_run_id = ? AND status != 'paid'", item.pay_run_id).n;
    run('UPDATE pay_runs SET status = ? WHERE id = ?', left ? 'partial' : 'paid', item.pay_run_id);
  });
}

const failItem = (item, message, countAttempt) => run(
  "UPDATE pay_run_items SET status = 'failed', error = ?, attempts = attempts + ? WHERE id = ?",
  String(message).slice(0, 300), countAttempt ? 1 : 0, item.id,
);

const sending = new Set(); // pay runs with a send in progress in this process

// Pays everyone in the run who is not paid yet. Returns { sent, skipped }, or null if a send is already running.
async function sendRun(runId) {
  if (sending.has(runId)) return null;
  sending.add(runId);
  let sent = 0;
  let skipped = 0;
  try {
    for (const item of runItems(runId).filter((i) => i.status !== 'paid')) {
      let transfer;
      try {
        const ready = item.stripe_account_id
          && await payments.refreshStatus({ id: item.user_id, stripe_account_id: item.stripe_account_id });
        if (!ready) {
          failItem(item, 'Direct deposit is not set up for this person.', false);
          skipped += 1;
          continue;
        }
        transfer = await payments.sendTransfer({ runId, item, accountId: item.stripe_account_id });
      } catch (err) {
        failItem(item, err.message, payments.isDefinitiveFailure(err));
        skipped += 1;
        continue;
      }
      // Outside the try: if recording fails after money moved, the retry must reuse the same
      // idempotency key, so the attempt counter is left alone.
      markItemPaid(item, 'stripe', transfer.id);
      sent += 1;
    }
  } finally {
    sending.delete(runId);
  }
  return { sent, skipped };
}

/* ---------- Pulling funds from the bank ---------- */

const pendingTopup = (runId) =>
  get("SELECT * FROM topups WHERE pay_run_id = ? AND status = 'pending' ORDER BY id DESC LIMIT 1", runId);

// What is still owed to the people in this run who can receive a payout right now.
const payableCents = (runId) => runItems(runId)
  .filter((i) => i.status !== 'paid' && i.payouts_enabled)
  .reduce((sum, i) => sum + i.amount_cents, 0);

// Asks Stripe to pull the amount from the bank and marks the run to be sent when it lands.
async function pullFunds(runId, amountCents) {
  // Failed pulls stay on record, so each new pull gets its own idempotency key.
  const attempt = get('SELECT COUNT(*) AS n FROM topups WHERE pay_run_id = ?', runId).n;
  const topup = await payments.createTopup({ runId, amountCents, attempt });
  tx(() => {
    run(
      `INSERT INTO topups (pay_run_id, stripe_id, amount_cents, status, expected_at, created_at) VALUES (?, ?, ?, 'pending', ?, ?)
       ON CONFLICT (stripe_id) DO NOTHING`,
      runId, topup.id, amountCents, topup.expected_availability_date || null, now(),
    );
    run('UPDATE pay_runs SET auto_send = 1, funding_note = NULL WHERE id = ?', runId);
  });
  return topup;
}

const stopAutoSend = (runId, note) => run('UPDATE pay_runs SET auto_send = 0, funding_note = ? WHERE id = ?', note, runId);

let checking = false;

// Looks up every bank pull still in flight; when one lands, sends the pay run that was waiting on it.
async function checkFunding() {
  if (!payments.enabled || checking) return;
  checking = true;
  try {
    for (const t of all("SELECT * FROM topups WHERE status = 'pending'")) {
      try {
        const fresh = await payments.retrieveTopup(t.stripe_id);
        if (fresh.status === 'pending') {
          run('UPDATE topups SET expected_at = ? WHERE id = ?', fresh.expected_availability_date || t.expected_at, t.id);
          continue;
        }
        run('UPDATE topups SET status = ?, error = ? WHERE id = ?', fresh.status, fresh.failure_message || null, t.id);
        const payRun = get('SELECT * FROM pay_runs WHERE id = ?', t.pay_run_id);
        if (!payRun || !payRun.auto_send) continue;
        if (fresh.status !== 'succeeded') {
          stopAutoSend(payRun.id, `The bank pull of ${money(t.amount_cents)} did not go through (${fresh.failure_message || fresh.status}). Nothing was sent.`);
          continue;
        }
        const owed = payableCents(payRun.id);
        const balance = await payments.availableBalanceCents();
        if (balance < owed) {
          stopAutoSend(payRun.id, `The bank pull arrived, but the Stripe balance (${money(balance)}) is still less than the ${money(owed)} owed. Nothing was sent.`);
          continue;
        }
        // Cleared before sending, so a crash mid-send can never trigger a second automatic send.
        stopAutoSend(payRun.id, 'The bank pull arrived. Sending payments.');
        const result = await sendRun(payRun.id);
        if (result) {
          stopAutoSend(payRun.id, `The bank pull arrived on ${fmtDate(now())} and ${result.sent} payment(s) were sent automatically${
            result.skipped ? `; ${result.skipped} could not be sent` : ''}.`);
        }
      } catch (err) {
        console.error(`Checking bank pull ${t.stripe_id} failed: ${err.message}`);
      }
    }
  } finally {
    checking = false;
  }
}

module.exports = {
  runItems, markItemPaid, sending, sendRun, pendingTopup, payableCents, pullFunds, stopAutoSend, checkFunding,
};
