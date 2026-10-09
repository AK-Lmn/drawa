// Which tab of this server is the live one. Every open tab's event stream holds one of the browser's ~6 connections
// to this host for good, and two tabs saving one layout undo each other's changes. So one tab owns both: it reads the
// stream and saves the canvas; the others say so and do neither. The owner is the newest tab, or the one you
// switch to, or the one you send from: it holds the `drawa:events` Web Lock, and taking the lock is taking over.
// A tab whose canvas another tab has saved over since (stale) can't take over as it is: it would save its outdated
// copy over those changes. It reloads instead.
import { button, notice } from './dom';

let owner = !navigator.locks,
  stale = false,
  waiting = false; // no Web Locks (very old browser): every tab streams, as before
const listeners: ((on: boolean) => void)[] = [];
/** `f(on)` runs when this tab becomes the owner (on) or another tab takes over. */
export const onOwner = (f: (on: boolean) => void) => listeners.push(f);
/** Is this the tab that owns the server (streams and saves)? */
export const ownsServer = () => owner;
/** Whether this tab may save the layout. */
export const saving = () => owner && !stale;

const use = button('Use here', '', () => (stale ? location.reload() : claim(true)));
const away = notice('', use);
/** Show or hide the "open in another tab" notice to match this tab's state. */
function showNotice() {
  away.hidden = owner && !stale;
  away.firstChild!.textContent = stale
    ? 'The canvas was changed in another tab. Reload to pick that up: changes here aren’t saved.'
    : 'Drawa is open in another tab. This one isn’t updating or saving.';
  use.textContent = stale ? 'Reload' : 'Use here';
}

/** This tab gained or lost the server: update the notice and tell the listeners. */
function setOwner(on: boolean) {
  owner = on;
  showNotice();
  listeners.forEach(f => f(on));
}

/** Ask for the server's lock (the events stream); `steal` takes it from the tab that has it. */
function claim(steal = false) {
  if (owner || (waiting && !steal)) return;
  if (!steal) waiting = true;
  navigator.locks
    .request('drawa:events', { steal }, () => {
      if (!steal) waiting = false;
      if (stale)
        location.reload(); // (see the top) the reloaded page takes over again, with the saved canvas
      else setOwner(true);
      return new Promise<never>(() => {}); // held until the tab closes, or another tab takes it
    })
    .catch(() => {
      // another tab took over: queue to get it back when that tab closes
      setOwner(false);
      claim();
    });
}

/** Another tab saved this project's layout: this tab's copy is out of date. */
export function markStale() {
  if (stale) return;
  stale = true;
  showNotice();
}

/** Before a send: replies go to the owner, so sending from here takes over first, or says why it can't. */
export function takeOver() {
  if (owner) return;
  if (stale)
    throw new Error('Drawa is open in another tab, and the canvas changed there. Reload this tab to send from it.');
  claim(true);
}

showNotice();
if (!owner) claim(!document.hidden); // a new tab (drawa opens one per start) is the one you're looking at
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && !stale) claim(true);
});
