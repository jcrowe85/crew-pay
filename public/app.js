// Live shift timer and wall clock on the Clock page.
(function () {
  const pad = (n) => String(n).padStart(2, '0');
  const timer = document.querySelector('[data-since]');
  const wall = document.querySelector('[data-now]');
  if (!timer && !wall) return;

  function tick() {
    if (timer) {
      const s = Math.max(0, Math.floor(Date.now() / 1000) - Number(timer.dataset.since));
      timer.textContent = `${pad(Math.floor(s / 3600))}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`;
    }
    if (wall) {
      wall.textContent = new Date().toLocaleTimeString('en-US', {
        hour: 'numeric', minute: '2-digit', timeZone: wall.dataset.now,
      });
    }
  }
  tick();
  setInterval(tick, 1000);
})();

// Pop-up forms: a [data-open-dialog="id"] button opens the <dialog> with that id.
document.addEventListener('click', (event) => {
  const opener = event.target.closest('[data-open-dialog]');
  if (opener) return document.getElementById(opener.dataset.openDialog)?.showModal();
  if (event.target.closest('[data-close-dialog]')) return event.target.closest('dialog')?.close();
  // A click on the dimmed area around the box closes it.
  if (event.target instanceof HTMLDialogElement) event.target.close();
});

// PIN pad on the shared tablet: big keys fill the box, and the fourth digit sends it.
(function () {
  const form = document.querySelector('[data-pin]');
  if (!form) return;
  const input = form.querySelector('input.pin');
  input.readOnly = true; // keeps the tablet's own keyboard out of the way
  form.addEventListener('click', (event) => {
    const key = event.target.closest('[data-key]')?.dataset.key;
    if (!key) return;
    if (key === 'clear') input.value = '';
    else if (key === 'back') input.value = input.value.slice(0, -1);
    else if (input.value.length < 4) input.value += key;
    if (input.value.length === 4) form.submit();
  });
})();

// Shared tablet: after [data-idle] seconds without a touch, log out and go back to the crew screen.
(function () {
  const seconds = Number(document.body.dataset.idle);
  if (!seconds) return;
  let timer;
  function leave() {
    const logout = document.querySelector('form[action="/logout"]');
    if (logout) logout.submit();
    else location.href = '/login';
  }
  function reset() {
    clearTimeout(timer);
    timer = setTimeout(leave, seconds * 1000);
  }
  ['pointerdown', 'keydown', 'scroll'].forEach((type) => addEventListener(type, reset, { passive: true }));
  reset();
})();
