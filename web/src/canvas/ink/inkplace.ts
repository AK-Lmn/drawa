// Where a press on the drawing lands: over a window its ink is the window's, in the window's content coordinates;
// otherwise the canvas's, in world coordinates. And moving a stroke drawn past its window's edge onto the canvas.
import { closestAt } from '../../lib/dom';
import { toWorld, view } from '../core/view';
import { fits, paint, type Stroke, unitsPerHostPx } from './stroke';

export type Pt = { clientX: number; clientY: number; pressure?: number };
/** Where a press lands: over a window, the ink is the window's, in its content coordinates (with its scroll
 *  position); otherwise the canvas's, in world coordinates. `scale`: stored units per screen px; `off(ev)`: has the
 *  pointer left the window; `back(q)`: a stored point on screen again. */
export function placeAt(e: Pt) {
  const hit = closestAt(e.clientX, e.clientY, '[data-ink]') ?? undefined;
  // anywhere on a picture's window (its margin, a resize grip, a diagram's editor) draws on the picture: the window's
  // own ink is in its pixels, so it would drift off the picture when that scales (full view, a resize)
  const pic = hit && !fits(hit) ? hit.querySelector<HTMLElement>('[data-ink-fit]') : null;
  const host = pic?.offsetWidth ? pic : hit; // not while it's hidden (collapsed, nothing to show yet)
  const fit = fits(host),
    b = host?.getBoundingClientRect(),
    edge = hit?.getBoundingClientRect();
  const k = host && b ? b.width / host.offsetWidth : view.k; // screen px per host px (or world px)
  const u = unitsPerHostPx(host);
  const pt = (ev: Pt) => {
    if (!host || !b) return worldPt(ev);
    if (fit) return [((ev.clientX - b.left) / k) * u, ((ev.clientY - b.top) / k) * u, ev.pressure || 0.5];
    return [(ev.clientX - b.left) / k + host.scrollLeft, (ev.clientY - b.top) / k + host.scrollTop, ev.pressure || 0.5];
  };
  // only a window on the canvas hands its strokes over: past a pinned or full-view one's edge the canvas isn't where
  // the ink shows (ponytail: those still clip)
  const off = (ev: Pt) =>
    !!edge &&
    !!hit!.closest('#world') &&
    (ev.clientX < edge.left || ev.clientX > edge.right || ev.clientY < edge.top || ev.clientY > edge.bottom);
  const back = ([x, y]: number[]) =>
    fit
      ? [b!.left + (x / u) * k, b!.top + (y / u) * k]
      : [b!.left + (x - host!.scrollLeft) * k, b!.top + (y - host!.scrollTop) * k];
  return { host, pt, scale: u / k, off, back };
}
export type Place = ReturnType<typeof placeAt>;
const worldPt = (ev: Pt) => {
  const w = toWorld(ev.clientX, ev.clientY);
  return [w.x, w.y, ev.pressure || 0.5];
};
/** A stroke drawn past its window's edge moves to the canvas, whole: the window would clip it there (an arrow from a
 *  card to something else), and the clipped part couldn't be erased. Returns the canvas's point mapping. */
export function toCanvas(s: Stroke, at: Place) {
  at.off = () => false; // once is enough
  s.p = s.p.map(q => {
    const [x, y] = at.back(q);
    return [...worldPt({ clientX: x, clientY: y }).slice(0, 2), ...q.slice(2)];
  });
  s.s = s.s / at.scale / view.k; // same weight on screen
  s.el?.remove();
  for (const f of ['el', 'host', 'h', 'a', 'o', 'k', 'rid', 'row'] as const) delete s[f];
  paint(s);
  return worldPt;
}
