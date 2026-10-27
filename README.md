# Crew Pay

Time clock, timesheet approval and payouts for hourly contractors.

- **Workers** log in, clock in and out, see their hours and pay history, and add their own bank details.
- **Admins** add workers and rates, fix and approve shifts, and create pay runs.
- **Payments** go out through Stripe Connect, or are recorded by hand if Stripe is not connected.

## Run it

```
npm install
cp .env.example .env
npm start
```

Open http://localhost:3000. The first visit creates the admin account, so do that before sharing the address.
Data lives in `data/crewpay.db` (SQLite). Back that file up.

## Backups

Every day the app saves a copy of the database in `data/backups/` (the newest 14 are kept) and, when email is set up,
sends it to the admins. Admins can also download a copy at any time from the Admins page.

To restore one: stop the app, replace `data/crewpay.db` with the copy (delete any `crewpay.db-wal` and `crewpay.db-shm`
next to it), and start the app again. Everyone logs in again afterwards; passwords and PINs are unchanged.

## How a pay period works

1. Workers clock in and out. A forgotten clock-out shows under "On the clock now"; edit the shift to close it.
2. Approve shifts on the Timesheets page.
3. On Pay runs, pick a date and create a run. This locks those shifts and moves no money.
4. Review the amounts, type `PAY` and send, or pay people yourself and mark each one paid.
5. Download the CSV for your records.

To change a shift that is already in a pay run, cancel the run first. A run cannot be cancelled once anyone in it is paid.

## Two rates for one worker

For someone paid more for lab work, open their page under Workers and fill in "Lab rate" next to their normal hourly
rate. They then get two buttons when clocking in, "Start lab work" and "Start other work", and switch by clocking out
and back in. Timesheets marks each of their shifts Lab or Other; edit a shift to change it before approving. A pay run
adds both up into one payment. Workers without a lab rate see no difference.

## Connecting Stripe

1. Create a Stripe account for the business and turn on Connect (Express accounts).
2. Link the business bank account in Stripe. Pay runs draw on the Stripe balance, so add funds from
   the bank before sending; bank top-ups take a few business days to arrive.
3. Put the secret key in `.env` as `STRIPE_SECRET_KEY` and set `BASE_URL` to the app's public address.
4. Each worker clicks "Add bank details" on their Clock page and completes Stripe's form.

Start with a test key (`sk_test_...`) and run one full pay period before switching to the live key.

## Putting it online

Workers need to reach it from their phones, so host it somewhere with HTTPS and a persistent disk for
`data/`. Set `TRUST_PROXY=1` behind an HTTPS proxy so login cookies are marked secure.

## Keeping the Stripe balance topped up

Set `STRIPE_REFILL_TO` to the dollars to keep in Stripe, for example `2000` (about one week's pay plus some spare).
After a pay run goes out, the app pulls the difference from the bank account saved in Stripe, so the balance is
back at that amount before the next payday. A pull takes a few business days. The app checks every ten minutes and
only pulls one at a time, and the dashboard shows what is on its way.

Before switching it on:

1. Add the starting amount by hand once (Stripe Dashboard, Balance > Add to balance > Payments balance).
2. In Stripe, Settings > Payouts: if Fleur's own payouts are automatic, set the minimum balance to at least this
   amount, or Stripe sends the money it pulled straight back to the bank.

If a pull fails, refills pause and every admin gets an email. Fix the bank in Stripe, then choose
"Try the refill again" on the dashboard.

## Automatic bank pulls

With `STRIPE_AUTO_TOPUP=1`, confirming a pay run that the Stripe balance cannot cover pulls the difference from the bank
account saved in Stripe (an ACH debit that takes a few business days). The pay run then waits, and the payments are sent
automatically when the money lands; the app checks every ten minutes. If the balance already covers the run, nothing is
pulled and payments go out straight away. A failed pull sends nothing and is reported on the pay run page.

## Shared tablet (kiosk)

For a crew that clocks in on one shared tablet: log in on the tablet as an admin, open Workers and choose
"Use this device as the crew kiosk", then log out. The tablet now shows every worker. Each taps their name and enters
a 4-digit PIN. Workers choose the PIN along with their password at first login; anyone without one enters their
password once on the tablet to choose it. Clocking in or out logs them out again, and
an untouched screen logs out after a minute.

To stop someone clocking in from anywhere else, tick "Can only clock in and out on the crew tablet" on their page
under Workers. They can still log in on their own phone to see their hours and set up their bank, but not to clock.

A PIN only works on a tablet set up this way, and only for the clock: bank details and passwords still need the email
and password login on the worker's own phone. Five wrong PINs clears the PIN until the password is used to pick a new
one. Resetting someone's password clears their PIN too. To shut out a lost tablet, open Workers
on any other device and choose "Turn off other kiosks".

On the tablet, open the site in Chrome (or Safari on an iPad) and choose "Add to Home screen". Opened from that icon
the app fills the screen, with no address bar or tabs.

## Welcome emails

When `RESEND_API_KEY` and `EMAIL_FROM` are set in `.env`, adding a worker or admin emails them their username and a
temporary password. Workers also get `assets/how-to-log-hours.pdf`, a picture guide to logging hours. The login link in
the email uses `BASE_URL`. Without those settings, or if sending fails, the temporary password is shown on screen instead.

## Credits

Avatar art in `public/avatars/` is from [Twemoji](https://github.com/jdecked/twemoji), licensed CC-BY 4.0.
