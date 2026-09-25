// Shapes in Draw mode (rectangle, ellipse, diamond, line) and moving your drawn objects around. A shape is an ink
// stroke (canvas/ink.ts) whose two points are its corners, or a line's two ends: it attaches to windows, scales in
// full view, follows chat rows, saves, erases and undoes like any stroke. In Select mode (not drawing), a shape or a
// piece of Text-tool text is an object in the canvas selection (canvas/select.ts): click to select it (Shift adds
// it), drag to move the selection, drag a corner to resize a lone shape; Delete, Esc and the arrow keys are the
// selection's own.
import { inkSelected, selectInk, selectedInk, selected, selectionMover, onSelect } from './select'
import { make, perFrame } from '../lib/dom'
import { onChange, changed, track, view } from './canvas'
import { handDrag } from './mode'
import { drawing, objectAt, unitsPerPx, paint, type Stroke } from './ink'

export type Shape = 'rect' | 'ellipse' | 'diamond' | 'line'
export const SHAPES: Shape[] = ['rect', 'ellipse', 'diamond', 'line']
export const SHAPE_NAME: Record<Shape, string> = { rect: 'rectangle', ellipse: 'ellipse', diamond: 'diamond', line: 'line' }

/** Points along a shape's outline between two corners (a line's two ends). Closed shapes run a little past where they
 *  started, the way a hand-drawn loop overlaps itself. `step`: spacing between points, so corners stay sharp. */
export function outlinePoints(sh: Shape, [x0, y0]: number[], [x1, y1]: number[], step: number): number[][] {
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2, rx = Math.abs(x1 - x0) / 2, ry = Math.abs(y1 - y0) / 2
  if (sh === 'ellipse') {
    const n = Math.max(24, Math.ceil((Math.PI * (rx + ry)) / step))
    return Array.from({ length: n + Math.ceil(n / 16) + 1 }, (_, i) => [cx + rx * Math.cos((i / n) * 2 * Math.PI - Math.PI / 2), cy + ry * Math.sin((i / n) * 2 * Math.PI - Math.PI / 2)])
  }
  const corners = sh === 'line' ? [[x0, y0], [x1, y1]]
    : sh === 'rect' ? [[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]]
    : [[cx, Math.min(y0, y1)], [Math.max(x0, x1), cy], [cx, Math.max(y0, y1)], [Math.min(x0, x1), cy], [cx, Math.min(y0, y1)]]
  if (sh !== 'line') { const [a, b] = [corners[0], corners[1]]; corners.push([a[0] + (b[0] - a[0]) * 0.08, a[1] + (b[1] - a[1]) * 0.08]) } // the overlap
  const out: number[][] = [corners[0]]
  for (let i = 1; i < corners.length; i++) {
    const [ax, ay] = corners[i - 1], [bx, by] = corners[i], n = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) / step))
    for (let j = 1; j <= n; j++) out.push([ax + ((bx - ax) * j) / n, ay + ((by - ay) * j) / n])
  }
  return out
}
/** The area a filled shape covers (its closed outline). */
export function fillPath(sh: Shape, a: number[], b: number[]) {
  if (sh === 'line') return ''
  const step = sh === 'ellipse' ? (Math.abs(b[0] - a[0]) + Math.abs(b[1] - a[1])) / 60 || 1 : Infinity
  return 'M' + outlinePoints(sh, a, b, step).map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join('L') + 'Z'
}
/** Shift while drawing: a square / circle, or a line at a multiple of 45°. */
export function constrain(sh: Shape, [x0, y0]: number[], [x, y]: number[]): number[] {
  const dx = x - x0, dy = y - y0
  if (sh !== 'line') { const d = Math.max(Math.abs(dx), Math.abs(dy)); return [x0 + Math.sign(dx || 1) * d, y0 + Math.sign(dy || 1) * d] }
  const a = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4), r = Math.hypot(dx, dy)
  return [x0 + r * Math.cos(a), y0 + r * Math.sin(a)]
}

/* ---------- Select mode: a lone selected shape gets a frame and corner handles to resize it ---------- */
const box = document.body.appendChild(make('div', 'shape-sel'))
box.hidden = true
const handles = [0, 1, 2, 3].map(i => { const h = box.appendChild(make('i', 'h')); h.dataset.c = String(i); return h }) // corners: tl tr br bl
let picked: Stroke | null = null

// the frame follows the selection: exactly one drawing and no windows
onSelect(() => { const ink = selectedInk(); picked = ink.length === 1 && !selected().length ? ink[0] : null; place() })
/** Frame the picked object on screen; shapes get corner handles (a line only at its two ends). */
function place() {
  const el = picked?.el
  if (!picked || !el?.isConnected || drawing) { box.hidden = true; if (picked && !el?.isConnected) picked = null; return }
  const r = el.getBoundingClientRect()
  Object.assign(box.style, { left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px` })
  box.hidden = false
  const [a, b] = picked.p
  handles.forEach((h, i) => {
    const cx = i === 1 || i === 2 ? 1 : 0, cy = i >= 2 ? 1 : 0
    // a line has a point at this corner only if one end is extreme on both axes here
    const at = (q: number[], o: number[]) => (cx ? q[0] >= o[0] : q[0] <= o[0]) && (cy ? q[1] >= o[1] : q[1] <= o[1])
    h.hidden = !picked!.sh || (picked!.sh === 'line' && !at(a, b) && !at(b, a))
  })
}
onChange(() => place())
addEventListener('scroll', perFrame(place), { capture: true, passive: true }) // a streaming chat scrolls often

// pressing a drawn object (before the canvas pans or boxes a selection, and before windows drag)
document.addEventListener('pointerdown', e => {
  const t = e.target as Element
  if (e.button !== 0 || drawing) return
  const corner = t.closest<HTMLElement>('.shape-sel .h')
  if (corner && picked?.sh) { // resize: move whichever point is extreme on this corner's sides
    const i = Number(corner.dataset.c), cx = i === 1 || i === 2, cy = i >= 2, s = picked, orig = s.p.map(q => [...q]), k = unitsPerPx(s)
    const ix = orig[0][0] <= orig[1][0] === !cx ? 0 : 1, iy = orig[0][1] <= orig[1][1] === !cy ? 0 : 1
    track(corner, e, (dx, dy) => { s.p[ix][0] = orig[ix][0] + dx * k; s.p[iy][1] = orig[iy][1] + dy * k; paint(s); place() }, () => changed())
    return
  }
  const s = handDrag() ? null : objectAt(t)
  if (!s) return
  if (!inkSelected(s)) selectInk(s, e.shiftKey)
  const move = selectionMover() // the whole selection moves, windows too; screen px to canvas units
  track(t, e, (dx, dy) => { move(dx / view.k, dy / view.k); place() }, () => { move.end(); place() })
}, true)
