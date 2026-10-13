// Contractor payouts through Stripe Connect. The business funds its Stripe balance from its
// bank account; each contractor enters their own bank details with Stripe, never with us.
const Stripe = require('stripe');
const { run } = require('./db');

const stripe = process.env.STRIPE_SECRET_KEY ? new Stripe(process.env.STRIPE_SECRET_KEY) : null;
const enabled = Boolean(stripe);

async function onboardingLink(user, baseUrl) {
  let accountId = user.stripe_account_id;
  if (!accountId) {
    const account = await stripe.accounts.create({
      type: 'express',
      country: 'US',
      email: user.email,
      business_type: 'individual',
      capabilities: { transfers: { requested: true } },
      metadata: { crewpay_user_id: String(user.id) },
    });
    accountId = account.id;
    run('UPDATE users SET stripe_account_id = ? WHERE id = ?', accountId, user.id);
  }
  const link = await stripe.accountLinks.create({
    account: accountId,
    refresh_url: `${baseUrl}/payouts/refresh`,
    return_url: `${baseUrl}/payouts/return`,
    type: 'account_onboarding',
  });
  return link.url;
}

// Re-read the contractor's Stripe account and record whether it can receive money yet.
async function refreshStatus(user) {
  if (!user.stripe_account_id) return false;
  const account = await stripe.accounts.retrieve(user.stripe_account_id);
  const ready = Boolean(account.payouts_enabled && account.capabilities?.transfers === 'active');
  run('UPDATE users SET payouts_enabled = ? WHERE id = ?', ready ? 1 : 0, user.id);
  return ready;
}

function sendTransfer({ runId, item, accountId }) {
  return stripe.transfers.create(
    {
      amount: item.amount_cents,
      currency: 'usd',
      destination: accountId,
      transfer_group: `payrun_${runId}`,
      description: `Pay run #${runId}`,
      metadata: { pay_run_id: String(runId), pay_run_item_id: String(item.id) },
    },
    // Same key on a retry of the same attempt, so a timeout can never pay someone twice.
    { idempotencyKey: `crewpay-run${runId}-item${item.id}-try${item.attempts}` },
  );
}

// True when Stripe definitely did not move money, so the next attempt needs a fresh key.
const isDefinitiveFailure = (err) =>
  !['StripeConnectionError', 'StripeAPIError'].includes(err?.type);

async function availableBalanceCents() {
  const balance = await stripe.balance.retrieve();
  return balance.available.filter((b) => b.currency === 'usd').reduce((sum, b) => sum + b.amount, 0);
}

// With STRIPE_AUTO_TOPUP=1 a pay run that the balance cannot cover pulls the difference from the bank.
const autoTopup = enabled && process.env.STRIPE_AUTO_TOPUP === '1';

// An ACH pull from the bank account saved in Stripe (Balance > Add funds). It takes a few business days to land.
function createTopup({ runId, amountCents, attempt }) {
  return stripe.topups.create(
    {
      amount: amountCents,
      currency: 'usd',
      description: `Crew Pay run #${runId}`,
      statement_descriptor: `Pay run ${runId}`.slice(0, 15),
      metadata: { pay_run_id: String(runId) },
      // Only needed in a sandbox, where there is no saved bank account (for example btok_us_verified).
      ...(process.env.STRIPE_TOPUP_SOURCE ? { source: process.env.STRIPE_TOPUP_SOURCE } : {}),
    },
    { idempotencyKey: `crewpay-run${runId}-topup${attempt}` },
  );
}

const retrieveTopup = (id) => stripe.topups.retrieve(id);

module.exports = {
  enabled, autoTopup, onboardingLink, refreshStatus, sendTransfer, isDefinitiveFailure, availableBalanceCents,
  createTopup, retrieveTopup,
};
