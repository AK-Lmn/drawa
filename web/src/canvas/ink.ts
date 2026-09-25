// Draw mode: freehand ink. A stroke started over a window (plan, session card, sketch: anything with data-ink)
// belongs to it: stored in the window's own coordinates, it moves, scrolls and collapses with it.
// Strokes on empty canvas live in world coordinates (pan and zoom with the canvas).
import { getStroke } from 'perfect-freehand'
import { $, confirmBox } from '../lib/dom'
import { toWorld, view, changed } from './canvas'
import { persist } from '../lib/store'

interface Stroke { c: string; s: number; sim: boolean; p: number[][]; h?: string; host?: HTMLElement; el?: SVGPathElement }
const NS = 'http://www.w3.org/2000/svg'
const svg = $<SVGSVGElement>('#ink'), capture = $('#ink-capture'), bar = $('#inkbar'), btn = $('#btn-draw')
const strokes: Stroke[] = []
let color = 'ink', size = 4, erasing = false
export let drawing = false

/* ---------- rendering ---------- */
function outline(s: Stroke) {
  const o = getStroke(s.p, { size: s.s, thinning: 0.5, smoothing: 0.5, streamline: 0.4, simulatePressure: s.sim })
  return o.length ? 'M' + o.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join('L') + 'Z' : ''
}
/** The layer a stroke draws into: the canvas-wide one, or an overlay inside its window (scrolls with its content). */
function layer(host?: HTMLElement): SVGSVGElement {
  if (!host) return svg
  let l = host.querySelector<SVGSVGElement>(':scope > svg.ink-local')
  if (!l) {
    l = document.createElementNS(NS, 'svg') as SVGSVGElement
    l.setAttribute('class', 'ink-local')
    l.setAttribute('aria-hidden', 'true')
    host.append(l)
  }
  return l
}
function paint(s: Stroke) {
  s.el ??= layer(s.host).appendChild(document.createElementNS(NS, 'path'))
  s.el.setAttribute('d', outline(s))
  s.el.setAttribute('class', `ink-${s.c}`)
}
function remove(s: Stroke) {
  s.el?.remove()
  strokes.splice(strokes.indexOf(s), 1)
  changed()
}

/* ---------- mode ---------- */
export function setDrawing(on: boolean) {
  drawing = on
  capture.hidden = bar.hidden = !on
  btn.setAttribute('aria-pressed', String(on))
  btn.classList.toggle('on', on)
  if (!on) setEraser(false)
}
function setEraser(on: boolean) {
  erasing = on
  document.body.classList.toggle('erasing', on)
  bar.querySelector('[data-ink=erase]')!.classList.toggle('on', on)
}

/* ---------- input: left button draws (or erases); middle button and wheel still pan the canvas ---------- */
capture.addEventListener('pointerdown', e => {
  if (e.button !== 0) return // falls through to the canvas pan handler
  e.stopPropagation()
  capture.setPointerCapture(e.pointerId)
  if (erasing) {
    eraseAt(e)
    const mv = (ev: PointerEvent) => eraseAt(ev)
    const up = () => { capture.removeEventListener('pointermove', mv); capture.removeEventListener('pointerup', up) }
    capture.addEventListener('pointermove', mv)
    capture.addEventListener('pointerup', up)
    return
  }
  // over a window? then the stroke is the window's, in its content coordinates (including its scroll position)
  const host = document.elementsFromPoint(e.clientX, e.clientY).map(el => el.closest<HTMLElement>('[data-ink]')).find(Boolean) ?? undefined
  const pt = (ev: PointerEvent) => {
    if (!host) { const w = toWorld(ev.clientX, ev.clientY); return [w.x, w.y, ev.pressure || 0.5] }
    const b = host.getBoundingClientRect(), k = b.width / host.offsetWidth
    return [(ev.clientX - b.left) / k + host.scrollLeft, (ev.clientY - b.top) / k + host.scrollTop, ev.pressure || 0.5]
  }
  // size is in screen px at the moment of drawing, so a stroke looks the same weight at any zoom
  const s: Stroke = { c: color, s: size / view.k, sim: e.pointerType !== 'pen', p: [pt(e)], host, h: host?.dataset.ink }
  strokes.push(s)
  paint(s)
  let raf = 0
  const mv = (ev: PointerEvent) => {
    for (const c of ev.getCoalescedEvents?.() ?? [ev]) s.p.push(pt(c))
    raf ||= requestAnimationFrame(() => { raf = 0; paint(s) })
  }
  const up = () => {
    capture.removeEventListener('pointermove', mv)
    capture.removeEventListener('pointerup', up)
    paint(s)
    changed()
  }
  capture.addEventListener('pointermove', mv)
  capture.addEventListener('pointerup', up)
})

function eraseAt(e: PointerEvent) {
  for (const el of document.elementsFromPoint(e.clientX, e.clientY)) {
    const s = strokes.find(s => s.el === el)
    if (s) remove(s)
  }
}

addEventListener('keydown', e => {
  if (!drawing || document.querySelector('dialog[open]') || (e.target instanceof Element && e.target.closest('input, textarea, select'))) return
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); const s = strokes.at(-1); if (s) remove(s) }
  else if (e.key === 'Escape') setDrawing(false)
  else if (e.key.toLowerCase() === 'e' && !e.ctrlKey && !e.metaKey) setEraser(!erasing)
})

for (const b of bar.querySelectorAll<HTMLButtonElement>('[data-ink]')) {
  b.onclick = () => {
    const [kind, val] = b.dataset.ink!.split(':')
    if (kind === 'color') { color = val; setEraser(false) }
    else if (kind === 'size') { size = Number(val); setEraser(false) }
    else if (kind === 'erase') return setEraser(!erasing)
    else if (kind === 'undo') { const s = strokes.at(-1); if (s) remove(s); return }
    else if (kind === 'clear') {
      if (strokes.length) confirmBox('Erase all drawing?', 'Every stroke on the canvas is removed. Undo can\'t bring them back.', 'Erase all').then(ok => { if (ok) [...strokes].forEach(remove) })
      return
    }
    else if (kind === 'done') return setDrawing(false)
    for (const o of bar.querySelectorAll(`[data-ink^="${kind}:"]`)) o.classList.toggle('on', o === b)
  }
}
btn.onclick = () => setDrawing(!drawing)

/** Does this window (or anything inside it) carry ink of its own? */
export const hasInk = (el: HTMLElement) => strokes.some(s => s.host && el.contains(s.host))

/** Drop a window's own ink (e.g. a plan's marks when a new version replaces the text they were about). */
export function clearInk(host: HTMLElement) {
  for (const s of strokes.filter(s => s.host === host)) remove(s)
}

/** Canvas-level strokes overlapping a world-space rectangle, as SVG path data + color (for snapshots). */
export function strokesIn(r: { x: number; y: number; w: number; h: number }) {
  return strokes.filter(s => !s.host && s.p.some(([x, y]) => x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h))
    .map(s => ({ d: s.el?.getAttribute('d') ?? '', color: s.el ? getComputedStyle(s.el).fill : '#000' }))
}

/* ---------- persistence (saved with the canvas layout) ---------- */
const ink = () =>
  strokes.filter(s => !s.host || s.host.isConnected)
    .map(({ c, s, sim, p, h }) => ({ c, s: +s.toFixed(2), sim, h, p: p.map(q => q.map(n => +n.toFixed(1))) }))
persist('ink', ink, loadInk, 2) // after the windows it can belong to
function loadInk(list: Omit<Stroke, 'el' | 'host'>[]) {
  for (const s of list) {
    const host = s.h ? document.querySelector<HTMLElement>(`[data-ink="${CSS.escape(s.h)}"]`) ?? undefined : undefined
    if (s.h && !host) continue // its window is gone
    const st: Stroke = { ...s, host }
    strokes.push(st)
    paint(st)
  }
}
