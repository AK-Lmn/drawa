// The canvas's viewport: pan and zoom. Items are absolutely positioned in #world, in world coordinates; #world
// carries the view transform. Every item carries class "item" and data-kind (session, file, run, diagram, sketch,
// plan, note, ...): that's all the canvas, the minimap and the saved layout need to know about it.
// The items themselves are canvas/core/items.ts, dragging canvas/core/drag.ts, where new ones go canvas/core/placement.ts.
import { $, make, perFrame } from '../../lib/dom';

export const stage = $('#stage');
export const world = $('#world');
const inkworld = $('#inkworld'); // drawing layer: same transform, stacked above every item
export const view = { x: 0, y: 0, k: 1 };
// Fit may go below MIN, so a canvas spread past ~9000px shows whole; from there the wheel can zoom in but not out.
// ponytail: FIT_MIN still cuts off a canvas wider than ~45000px (its middle shows)
const MIN = 0.15,
  MAX = 2;
export const FIT_MIN = 0.03;
/** A zoom level within the wheel's range. */
export const clampZoom = (k: number) => Math.min(MAX, Math.max(MIN, k));

const listeners: ((viewOnly: boolean) => void)[] = [];
/** Called (once per frame) after any view change or item move (minimap, arrows, layout saving). `viewOnly`: only
 *  the pan/zoom changed since last time, nothing moved on the canvas; world-space things can skip their work. */
export const onChange = (f: (viewOnly: boolean) => void) => listeners.push(f);
let queued = false,
  moved = false;
export function changed(viewOnly = false) {
  if (!viewOnly) moved = true;
  if (queued) return;
  queued = true;
  requestAnimationFrame(() => {
    queued = false;
    const v = !moved;
    moved = false;
    listeners.forEach(f => f(v));
  });
}

// The dot grid: a layer one cell bigger than the screen, moved by a transform (the offset modulo a cell), so a pan
// only moves a composited layer instead of repainting a full-screen background. Its spacing (a repaint) changes
// only with the zoom; the dots stay 1px at any zoom, as before.
// ponytail: during a glide the grid shifts by the offset modulo a cell, not the whole way the world flies (a
// slight drift for .45s); exact at rest. A JS-driven glide would fix it if anyone notices.
const grid = stage.insertBefore(make('div', 'grid'), world);
const zLabel = $('#z-label');
let gridG = 0;
export function apply(glide = false) {
  for (const el of [world, inkworld, stage]) el.classList.toggle('glide', glide);
  if (glide)
    setTimeout(() => {
      for (const el of [world, inkworld, stage]) el.classList.remove('glide');
    }, 460);
  world.style.transform = inkworld.style.transform = `translate(${view.x}px, ${view.y}px) scale(${view.k})`;
  const g = 24 * view.k,
    mod = (a: number) => (((a % g) + g) % g) - g;
  if (g !== gridG) {
    grid.style.backgroundSize = `${g}px ${g}px`;
    gridG = g;
    zLabel.textContent = `${Math.round(view.k * 100)}%`;
    grid.hidden = view.k < MIN;
  } // (under MIN the dots are a grey haze)
  grid.style.transform = `translate(${mod(view.x)}px, ${mod(view.y)}px)`;
  changed(true);
}
/** For input that fires many times a frame (pointer pans, wheels, trackpads): the view updates now, the DOM once a frame. */
export const applySoon = perFrame(() => apply());

export function zoomView(k: number, cx: number, cy: number) {
  k = Math.min(MAX, Math.max(Math.min(MIN, view.k), k)); // under MIN (a fit): no further out
  view.x = cx - (cx - view.x) * (k / view.k);
  view.y = cy - (cy - view.y) * (k / view.k);
  view.k = k;
}
export function zoomAt(k: number, cx = innerWidth / 2, cy = innerHeight / 2, glide = false) {
  zoomView(k, cx, cy);
  apply(glide);
}

export const toWorld = (cx: number, cy: number) => ({ x: (cx - view.x) / view.k, y: (cy - view.y) / view.k });
export const viewCenter = () => ({ x: (innerWidth / 2 - view.x) / view.k, y: (innerHeight / 2 - view.y) / view.k });

addEventListener('resize', () => changed());
