// Canvas items: the registry of what's on the canvas (and pinned off it), their geometry, and their stacking order.
import { uuid } from '../../lib/dom';
import { each, persist, saveSoon } from '../../lib/store';
import { toWorld, view, world } from './view';

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
  min?: boolean;
}

/** Where items live: the canvas, and where windows go when lifted off it (sidebar, floating, full view). Items are
 *  always direct children of these, so listing them never walks into chat logs. */
const holders: Element[] = [world];
/** A place items can be moved to off the canvas (canvas/core/dock.ts, canvas/core/fullview.ts). */
export const holder = <T extends Element>(el: T) => {
  holders.push(el);
  return el;
};

/** Make `el` a canvas item of this kind and put it in the world. */
export function addItem<T extends HTMLElement>(el: T, kind: string): T {
  el.classList.add('item');
  el.dataset.kind = kind;
  el.dataset.id ||= uuid(); // for canvas tools; kinds with their own ids overwrite it
  world.append(el);
  return el;
}

const away = new WeakSet<HTMLElement>(),
  goneFns: ((el: HTMLElement) => void)[] = [];
/** Take an item off the page for now; it may come back (a finished sub-agent's window, a delete that can still be
 *  undone), so what holds on to it by id (a group's member list) keeps it. Returns what puts it back where it was. */
export function park(el: HTMLElement) {
  const parent = el.parentElement,
    next = el.nextSibling;
  away.add(el);
  el.remove();
  return () => {
    away.delete(el);
    parent?.insertBefore(el, next?.parentNode === parent ? next : null);
  };
}
/** Is this item parked (off the page for now, may come back)? */
export const parked = (el: HTMLElement) => away.has(el);
/** A parked item isn't coming back after all: whoever kept it lets go (`onGone`). */
export function drop(el: HTMLElement) {
  away.delete(el);
  goneFns.forEach(f => f(el));
}
/** Run `f(el)` when a parked item is dropped for good, so what holds it by id lets go. */
export const onGone = (f: (el: HTMLElement) => void) => goneFns.push(f);
/** Every canvas item, including windows pinned to the sidebar (they still belong to the canvas). */
export const items = (kind?: string) =>
  holders
    .flatMap(h => [...h.children])
    .filter(
      (el): el is HTMLElement => el.classList.contains('item') && (!kind || (el as HTMLElement).dataset.kind === kind),
    );
/** Only what's laid out on the canvas itself: placement, fit and the minimap ignore pinned windows, and windows
 *  hidden inside a collapsed group (data-hidden-in, items/group/group.ts). */
export const placed = () =>
  [...world.children].filter((el): el is HTMLElement => el.classList.contains('item') && !hidden(el as HTMLElement));
/** Inside a collapsed group (items/group/group.ts sets data-hidden-in): out of sight, so placement, arrows, Ctrl+K and the
 *  selection leave it alone. */
export const hidden = (el: HTMLElement) => !!el.dataset.hiddenIn;
/** Can you see this window now: page visible, not collapsed, on screen. For polling only while it's watched. */
export function watched(el: HTMLElement) {
  if (document.hidden || el.classList.contains('min') || !el.isConnected) return false;
  const r = el.getBoundingClientRect();
  return r.right > 0 && r.bottom > 0 && r.left < innerWidth && r.top < innerHeight;
}
/** Canvas items by their data-id: one pass, for restoring many saved references at once. */
export const byIds = () => new Map(items().map(el => [el.dataset.id!, el]));
/** An id as Claude sees it: UUIDs cut to 8 characters, readable ids (git, f:path, l:card…) kept whole. */
export const shortId = (id: string) => (/^[0-9a-f]{8}-[0-9a-f]{4}-/.test(id) ? id.slice(0, 8) : id);
/** Where an item appears right now, in canvas units: on the canvas its layout rect, when pinned to the sidebar the
 *  canvas spot under it on screen (edges to pinned windows end there). Reads layout: not for loops over many items. */
export function liveRect(el: HTMLElement): Rect {
  const on = onCanvas(el);
  let r: Rect;
  if (on)
    r = rect(el); // world geometry: no screen read needed
  else {
    const b = el.getBoundingClientRect(),
      p = toWorld(b.left, b.top);
    r = { x: p.x, y: p.y, w: b.width / view.k, h: b.height / view.k };
  }
  // collapsed: only its tab is showing, so that's what arrows attach to (not its full width)
  const tab = el.classList.contains('min') ? el.querySelector<HTMLElement>(':scope > .win-h') : null;
  if (tab) r.w = (tab.offsetLeft + tab.offsetWidth) / (on ? 1 : view.k);
  return r;
}
/** Is it laid out on the canvas right now (not pinned to the sidebar, not in full view)? */
export const onCanvas = (el: HTMLElement) => el.parentElement === world;

/** Move an item to (x, y) in canvas units, rounded to whole pixels. */
export const place = (el: HTMLElement, x: number, y: number) => {
  el.style.left = `${Math.round(x)}px`;
  el.style.top = `${Math.round(y)}px`;
};
/** Where an item is and how big it looks right now (edges, minimap, placement). */
export const rect = (el: HTMLElement): Rect => ({
  x: parseFloat(el.style.left) || 0,
  y: parseFloat(el.style.top) || 0,
  // pinned or in full view (or placing in bulk): its canvas size is kept in its styles (what it gets back on the canvas)
  ...(!onCanvas(el) || inBulk
    ? { w: parseFloat(el.style.width) || el.offsetWidth, h: parseFloat(el.style.height) || el.offsetHeight }
    : { w: el.offsetWidth, h: el.offsetHeight }),
});
/** Same, but with a collapsed window's expanded height: what saved layouts store. */
export const savedRect = (el: HTMLElement): Rect => {
  const min = el.classList.contains('min');
  const r = rect(el); // (pinned to the sidebar: its canvas size, not its size in the sidebar)
  return { ...r, h: min ? Number(el.dataset.fullH) || r.h : r.h, min }; // min: false too, so a window collapsed by default stays open once you open it
};

let z = 10; // stacking inside #world only
/** Raise an item above everything else on the canvas (saved with the layout). */
export const bringToFront = (el: HTMLElement) => {
  if (el.style.zIndex !== String(z)) {
    el.style.zIndex = String(++z);
    saveSoon();
  }
};
/** Stack these bottom to top (canvas/core/layers.ts reorders the whole stack). */
export const restack = (order: HTMLElement[]) => {
  z = 10;
  for (const el of order) el.style.zIndex = String(++z);
  saveSoon();
};
// which one is on top survives a reload: ids bottom to top, raised in that order once the items exist. Layouts from
// before (no key) stack in load order, as they always did. ponytail: an item that shows up later (a card rebuilt
// from its process) lands on top.
persist(
  'z',
  () =>
    items()
      .filter(el => el.style.zIndex)
      .sort((a, b) => +a.style.zIndex - +b.style.zIndex)
      .map(el => el.dataset.id!),
  (ids: string[]) => {
    const found = byIds();
    each(ids, id => {
      const el = found.get(id);
      if (el) bringToFront(el);
    });
  },
  2,
);
// a press anywhere on an item (not only its tab) brings it to the front: overlapping windows swap as you click them
// (not a right-click: that opens the tab's layer menu, which would act on it already raised)
world.addEventListener(
  'pointerdown',
  e => {
    if (e.button === 2) return;
    const el = (e.target as Element).closest<HTMLElement>('#world > .item');
    if (el) bringToFront(el);
  },
  true,
);

/** Do two rects overlap, or come within `pad` of each other? */
export const overlaps = (a: Rect, b: Rect, pad = 16) =>
  a.x < b.x + b.w + pad && b.x < a.x + a.w + pad && a.y < b.y + b.h + pad && b.y < a.y + a.h + pad;

// Bulk mode (a transcript replaying makes many windows at once): the canvas is measured once and every spot handed
// out is added to that list, instead of reading layout after each window is written. ponytail: a spot handed out
// but not used (a saved position won) still counts as taken until bulk mode ends.
let inBulk = false,
  taken: Rect[] | null = null;
/** Many items are being placed at once (the session owner sets it around a replay): no layout reads per item. */
export const bulk = (on: boolean) => {
  inBulk = on;
  taken = null;
};
/** What's on the canvas, as rects: measured once while in bulk mode. */
export const occupied = () => (inBulk ? (taken ??= placed().map(rect)) : placed().map(rect));
/** A spot handed out: in bulk mode it counts as taken from now on. */
export const claim = (r: Rect) => {
  taken?.push(r);
  return r;
};
