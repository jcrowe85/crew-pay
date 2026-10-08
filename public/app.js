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
