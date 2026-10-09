// Where things go and where to look: a free spot for a new window (one that overlaps nothing), windows made
// beside an item or at a spot, and bringing an item (or everything) into view.
import { claim, hits, occupied, placed, type Rect, rect } from './items';
import { apply, clampZoom, FIT_MIN, view, viewCenter } from './view';

/** Move `r` down (then right) until it overlaps nothing on the canvas. */
export function freeSpot(r: Rect, step = 56): Rect {
  const others = occupied();
  for (let i = 0; i < 400 && others.some(o => hits(r, o)); i++)
    r = i % 12 === 11 ? { ...r, x: r.x + r.w + 40, y: r.y - step * 11 } : { ...r, y: r.y + step };
  return claim(r);
}
/** The free spot nearest to `r` (in any direction) where it overlaps nothing: for things that should land right
 *  by where they came from. Searches rings outward and stops at the first ring with a free spot. */
export function nearestFree(r: Rect, step = 24, reach = 60): Rect {
  const near = { x: r.x - reach * step, y: r.y - reach * step, w: r.w + 2 * reach * step, h: r.h + 2 * reach * step };
  const others = occupied().filter(o => hits(near, o)); // only what the search can bump into
  if (!others.some(o => hits(r, o))) return claim(r);
  for (let ring = 1; ring <= reach; ring++) {
    let best: Rect | null = null,
      bd = Infinity;
    for (let i = -ring; i <= ring; i++)
      for (let j = -ring; j <= ring; j++) {
        if (Math.max(Math.abs(i), Math.abs(j)) !== ring) continue; // this ring's edge only
        const d = Math.hypot(i, j * 1.3); // a little cheaper sideways than up or down: reading order
        if (d >= bd) continue;
        const c = { ...r, x: r.x + i * step, y: r.y + j * step };
        if (!others.some(o => hits(c, o))) {
          best = c;
          bd = d;
        }
      }
    if (best) return claim(best);
  }
  return freeSpot(r);
}
/** Just right of everything on the canvas, top-aligned with the current view. */
export function nextColumn(w: number, h: number): Rect {
  const all = occupied();
  const x = all.length ? Math.max(...all.map(r => r.x + r.w)) + 160 : 0;
  const y = all.length ? Math.min(...all.map(r => r.y)) : 0;
  return freeSpot({ x, y, w, h });
}
/** Where a window made beside `from` (an item) or at `from` (a spot: a drop, a paste) goes instead of a free spot,
 *  or null (items/group/group.ts: inside the group `from` is in). */
let spawnHook: (from: HTMLElement | Rect, w: number, h: number) => Rect | null = () => null;
export const spawnIn = (f: typeof spawnHook) => {
  spawnHook = f;
};
/** Beside an item (right of it, top-aligned), or the middle of the view when there's none. */
export function spotBeside(el: HTMLElement | null | undefined, w: number, h: number, dx = 150, dy = 0): Rect {
  if (!el) {
    const c = viewCenter();
    return freeSpot({ x: c.x - w / 2, y: c.y - h / 2, w, h });
  }
  const r = rect(el);
  return spawnHook(el, w, h) ?? freeSpot({ x: r.x + r.w + dx, y: r.y + dy, w, h });
}
/** At `r`, or the nearest free spot below it; inside the group whose frame holds `r`'s corner or middle. */
export const spotAt = (r: Rect): Rect => spawnHook(r, r.w, r.h) ?? freeSpot(r);

/** Bring `el` to the middle of the screen. The zoom stays, unless the window would be too small to read (under
 *  50%) or wouldn't fit: then it zooms to fit the window, never past 100%. */
export function centerOn(el: HTMLElement, glide = true) {
  const r = rect(el);
  const fits = Math.min((innerWidth - 32) / r.w, (innerHeight - 96) / r.h);
  if (view.k < 0.5 || view.k > fits) view.k = clampZoom(Math.min(1, fits));
  view.x = innerWidth / 2 - (r.x + r.w / 2) * view.k;
  view.y = innerHeight / 2 - (r.y + r.h / 2) * view.k;
  apply(glide);
}

/** Zoom to show everything (or just `rs`, e.g. the selection). */
export function fit(glide = true, rs = placed().map(rect)) {
  if (!rs.length) return;
  const x0 = Math.min(...rs.map(r => r.x)),
    y0 = Math.min(...rs.map(r => r.y));
  const x1 = Math.max(...rs.map(r => r.x + r.w)),
    y1 = Math.max(...rs.map(r => r.y + r.h));
  const pad = 80,
    top = 64; // keep clear of the toolbar
  const k = Math.max(
    FIT_MIN,
    Math.min((innerWidth - pad * 2) / (x1 - x0), (innerHeight - top - pad * 2) / (y1 - y0), 1),
  );
  view.k = k;
  view.x = (innerWidth - (x1 - x0) * k) / 2 - x0 * k;
  view.y = top + (innerHeight - top - (y1 - y0) * k) / 2 - y0 * k;
  apply(glide);
}
