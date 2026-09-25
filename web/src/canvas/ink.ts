// Draw mode: freehand ink. A stroke started over a window (plan, session card, sketch: anything with data-ink)
// belongs to it: stored in the window's own coordinates, it moves, scrolls and collapses with it.
// Strokes on empty canvas live in world coordinates (pan and zoom with the canvas).
// A host marked data-ink-fit shows something that scales with the window (an image, a diagram): its strokes are
// stored in units of its width (FIT across), so they stay on the same spot at any size, full view included.
import { getStroke } from 'perfect-freehand'
import { $, confirmBox, shortcutOk, closestAt, perFrame } from '../lib/dom'
import { toWorld, view, changed, onChange } from './canvas'
import { persist } from '../lib/store'
import { startLink } from './links'

// a stroke with `t` is text: p[0] is its top-left corner, s its font size (both in the same units as a stroke's)
// In a host marked data-ink-rows (a chat log), `a` is the row the stroke was drawn over and `o` that row's offsetTop
// then: rows off screen are laid out at an estimated height (content-visibility) until they render, so the stroke
// follows its row, not the top of the log.
// `rid` is the row's own id when it has one (tool rows): the surest way back to it after a reload.
// `row` and `bb` (bounding box) are only kept in memory.
interface Stroke { c: string; s: number; sim: boolean; p: number[][]; t?: string; a?: number; o?: number; k?: string; rid?: string; h?: string
  host?: HTMLElement; el?: SVGPathElement | SVGTextElement; row?: HTMLElement; bb?: [number, number, number, number] }
const NS = 'http://www.w3.org/2000/svg'
const svg = $<SVGSVGElement>('#ink'), capture = $('#ink-capture'), bar = $('#inkbar'), btn = $('#btn-draw')
const strokes: Stroke[] = []
const FIT = 1000
const fits = (host?: HTMLElement) => !!host && 'inkFit' in host.dataset
const rows = (host: HTMLElement) => [...host.children].filter(c => !c.matches('svg.ink-local')) as HTMLElement[]

const rowKey = (row: Element) => (row.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 60)
/** The stroke's row: the one it's already on while that's still in the log; else by the row's id, or by index checked
 *  against the row's text (rows can shift: an empty state removed, a replay that groups differently); else the row
 *  with that text nearest the old index. Only the rare re-find reads row texts. */
function rowOf(s: Stroke, host: HTMLElement) {
  if (s.row?.parentElement === host) return s.row
  const list = rows(host), at = list[s.a!]
  let best = s.rid ? list.find(r => r.dataset.id === s.rid) : undefined
  if (!best && (!s.k || (at && rowKey(at) === s.k))) best = at
  if (!best) {
    let bd = Infinity
    list.forEach((r, i) => { if (Math.abs(i - s.a!) < bd && rowKey(r) === s.k) { best = r; bd = Math.abs(i - s.a!) } })
  }
  return (s.row = best ?? at)
}
const onHost = (host: HTMLElement) => strokes.filter(s => s.host === host)
/** Keep a rows host's strokes on their rows: reads each one's row position, then writes (no layout in between). */
function follow(host: HTMLElement) {
  const mine = onHost(host).filter(s => s.a != null && s.el)
  const dy = mine.map(s => { const row = rowOf(s, host); return row ? row.offsetTop - s.o! : 0 })
  mine.forEach((s, i) => s.el!.setAttribute('transform', `translate(0 ${dy[i]})`))
}
/** Re-follow whenever any row changes size: rows off screen render at their real height only after a scroll has
 *  already happened, so scroll events alone miss the last change. ponytail: observes every row of an inked log (one
 *  observer, cheap per row); only rows above a stroke matter, if logs of 10k+ rows ever show up. */
const watchers = new Map<HTMLElement, { sizes: ResizeObserver; added: MutationObserver }>()
function watchRows(host: HTMLElement) {
  const soon = perFrame(() => follow(host))
  // in the observer itself, not a frame later: it runs after layout and before paint, so ink never lags a frame
  const sizes = new ResizeObserver(() => { if (host.isConnected) follow(host); else unwatch(host) })
  sizes.observe(host)
  rows(host).forEach(r => sizes.observe(r))
  const added = new MutationObserver(ms => { for (const m of ms) m.addedNodes.forEach(n => { if (n instanceof HTMLElement) sizes.observe(n) }); soon() })
  added.observe(host, { childList: true })
  watchers.set(host, { sizes, added })
}
function unwatch(host: HTMLElement) {
  const w = watchers.get(host)
  if (!w) return
  w.sizes.disconnect()
  w.added.disconnect()
  watchers.delete(host)
}
let color = 'ink', size = 4
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
    // viewBox FIT wide and 1 tall, "meet": scales by the host's width (its height is always over 1px)
    if (fits(host)) { l.classList.add('ink-fit'); l.setAttribute('viewBox', `0 0 ${FIT} 1`); l.setAttribute('preserveAspectRatio', 'xMinYMin meet') }
    host.append(l)
    if ('inkRows' in host.dataset) watchRows(host)
  }
  return l
}
function paint(s: Stroke) {
  s.bb = undefined // measured again when asked
  if (s.host && s.a != null) requestAnimationFrame(() => follow(s.host!))
  if (s.t != null) return paintText(s)
  s.el ??= layer(s.host).appendChild(document.createElementNS(NS, 'path'))
  s.el.setAttribute('d', outline(s))
  s.el.setAttribute('class', `ink-${s.c}`)
}
function paintText(s: Stroke) {
  const el = (s.el ??= layer(s.host).appendChild(document.createElementNS(NS, 'text'))) as SVGTextElement
  const [x, y] = s.p[0]
  el.setAttribute('class', `ink-${s.c} ink-text`)
  el.setAttribute('font-size', String(s.s))
  el.replaceChildren(...s.t!.split('\n').map((line, i) => {
    const span = document.createElementNS(NS, 'tspan')
    span.setAttribute('x', String(x))
    span.setAttribute('y', String(y + s.s * (0.95 + i * 1.25))) // first baseline one line below the corner
    span.textContent = line || ' '
    return span
  }))
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
  document.body.classList.toggle('drawing', on) // lifts the drawing surface over pinned windows (canvas.css)
  if (!on) { setTool('pen'); editor?.blur() }
}
/** Draw mode's tool: the pen, the Arrow tool (connect two items), the eraser, or Text (click to write). */
export type Tool = 'pen' | 'arrow' | 'eraser' | 'text'
let tool: Tool = 'pen'
const BTN: Record<Tool, string> = { pen: '', arrow: 'arrow', eraser: 'erase', text: 'text' }
function setTool(t: Tool) {
  tool = t
  document.body.classList.toggle('erasing', t === 'eraser')
  document.body.classList.toggle('texting', t === 'text')
  for (const b of bar.querySelectorAll('[data-ink=arrow], [data-ink=erase], [data-ink=text]')) b.classList.toggle('on', b.getAttribute('data-ink') === BTN[t])
}
const pick = (t: Tool) => setTool(tool === t ? 'pen' : t) // picking the tool that's on goes back to the pen
/** Excalidraw's keys for the tools: P/7 pen, A/5 arrow, E/0 eraser, T/8 text. */
export function toolKey(e: KeyboardEvent): Tool | null {
  const k = e.key.toLowerCase(), c = e.code
  return k === 'p' || c === 'Digit7' ? 'pen' : k === 'a' || c === 'Digit5' ? 'arrow' : k === 'e' || c === 'Digit0' ? 'eraser' : k === 't' || c === 'Digit8' ? 'text' : null
}

/* ---------- input: left button draws (or erases); middle button and wheel still pan the canvas ---------- */
capture.addEventListener('pointerdown', e => {
  if (e.button !== 0) return // falls through to the canvas pan handler
  e.stopPropagation()
  if (tool !== 'text') editor?.blur() // finish text being written before anything else
  capture.setPointerCapture(e.pointerId)
  if (tool === 'arrow') return startLink(e, color, capture)
  if (tool === 'text') { e.preventDefault(); return writeAt(e) }
  if (tool === 'eraser') {
    eraseAt(e)
    const mv = (ev: PointerEvent) => eraseAt(ev)
    const up = () => { capture.removeEventListener('pointermove', mv); capture.removeEventListener('pointerup', up) }
    capture.addEventListener('pointermove', mv)
    capture.addEventListener('pointerup', up)
    return
  }
  const { host, pt, scale } = placeAt(e)
  // size is in screen px at the moment of drawing, so a stroke looks the same weight at any zoom (or in full view)
  const s: Stroke = { c: color, s: size * scale, sim: e.pointerType !== 'pen', p: [pt(e)], host, h: host?.dataset.ink, ...rowAt(host, e) }
  strokes.push(s)
  paint(s)
  const repaint = perFrame(() => paint(s))
  const mv = (ev: PointerEvent) => {
    for (const c of ev.getCoalescedEvents?.() ?? [ev]) s.p.push(pt(c))
    repaint()
  }
  const up = () => {
    capture.removeEventListener('pointermove', mv)
    capture.removeEventListener('pointerup', up)
    thin(s)
    paint(s)
    changed()
  }
  capture.addEventListener('pointermove', mv)
  capture.addEventListener('pointerup', up)
})

/** Drop points closer than a fraction of the pen's width to the last one kept: the outline looks the same, and
 *  saved layouts stay far smaller (a fast mouse sends hundreds of points per stroke). */
function thin(s: Stroke) {
  const tol = s.s * 0.35, out = [s.p[0]]
  for (const q of s.p.slice(1, -1)) { const l = out[out.length - 1]; if (Math.hypot(q[0] - l[0], q[1] - l[1]) >= tol) out.push(q) }
  if (s.p.length > 1) out.push(s.p[s.p.length - 1])
  s.p = out
}

/** Where a press lands: over a window, the ink is the window's, in its content coordinates (with its scroll
 *  position); otherwise the canvas's, in world coordinates. `scale`: stored units per screen px. */
function placeAt(e: { clientX: number; clientY: number }) {
  const host = closestAt(e.clientX, e.clientY, '[data-ink]') ?? undefined
  const fit = fits(host), b = host?.getBoundingClientRect()
  const k = host && b ? b.width / host.offsetWidth : view.k // screen px per host px (or world px)
  const u = fit ? FIT / host!.offsetWidth : 1 // stored units per host px
  const pt = (ev: { clientX: number; clientY: number; pressure?: number }) => {
    if (!host || !b) { const w = toWorld(ev.clientX, ev.clientY); return [w.x, w.y, ev.pressure || 0.5] }
    if (fit) return [(ev.clientX - b.left) / k * u, (ev.clientY - b.top) / k * u, ev.pressure || 0.5]
    return [(ev.clientX - b.left) / k + host.scrollLeft, (ev.clientY - b.top) / k + host.scrollTop, ev.pressure || 0.5]
  }
  return { host, pt, scale: u / k }
}

/** The row of a rows host under a point, and where it sits now. */
function rowAt(host: HTMLElement | undefined, e: { clientX: number; clientY: number }): { a?: number; o?: number; k?: string; rid?: string } {
  if (!host || !('inkRows' in host.dataset)) return {}
  const list = rows(host)
  const row = document.elementsFromPoint(e.clientX, e.clientY).map(el => list.find(r => r.contains(el))).find(Boolean)
    ?? list.findLast(r => r.getBoundingClientRect().top <= e.clientY) // between rows or below the last one
  return row ? { a: list.indexOf(row), o: row.offsetTop, k: rowKey(row), ...(row.dataset.id ? { rid: row.dataset.id } : {}) } : {}
}

/** Give an old stroke on a rows host the row it sits on now, so it stays with that row from here on. */
function adopt(s: Stroke) {
  const y = s.p[0][1], list = rows(s.host!)
  const row = list.findLast(r => r.offsetTop <= y) ?? list[0]
  if (!row) return
  s.a = list.indexOf(row)
  s.o = row.offsetTop
  s.k = rowKey(row)
  changed()
}

/* ---------- text: click to write; click your text again (Text tool) to change it ---------- */
const TEXT_PX: Record<number, number> = { 2: 14, 4: 18, 9: 28 } // pen size -> font size on screen
let editor: HTMLTextAreaElement | null = null
function writeAt(e: PointerEvent) {
  editor?.blur() // finish the one being written
  const hit = closestAt<SVGTextElement>(e.clientX, e.clientY, '.ink-text')
  const old = hit && strokes.find(s => s.el === hit)
  const box = old?.el?.getBoundingClientRect()
  const at = box ? { clientX: box.left, clientY: box.top } : { clientX: e.clientX, clientY: e.clientY - (TEXT_PX[size] ?? 18) * 0.6 }
  const { host, pt, scale } = placeAt(at)
  const s: Stroke = old ?? { c: color, s: (TEXT_PX[size] ?? 18) * scale, sim: false, p: [pt(at).slice(0, 2)], t: '', host, h: host?.dataset.ink, ...rowAt(host, at) }
  const px = s.s / scale // font size on screen now
  const ta = editor = document.body.appendChild(document.createElement('textarea'))
  ta.className = `ink-editor ink-c-${s.c}`
  ta.value = s.t ?? ''
  ta.setAttribute('aria-label', 'Text on the drawing')
  ta.style.cssText = `left:${at.clientX}px;top:${at.clientY}px;font-size:${px}px`
  const fitSize = () => { ta.style.height = 'auto'; ta.style.height = ta.scrollHeight + 'px'; ta.style.width = 'auto'; ta.style.width = Math.max(40, ta.scrollWidth + 4) + 'px' }
  ta.oninput = fitSize
  if (old?.el) old.el.style.visibility = 'hidden' // the editor stands in for it
  ta.onkeydown = ev => {
    ev.stopPropagation() // typing isn't a shortcut
    if (ev.key === 'Escape' || (ev.key === 'Enter' && !ev.shiftKey)) { ev.preventDefault(); ta.blur() }
  }
  ta.onblur = () => {
    if (editor === ta) editor = null
    ta.remove()
    const text = ta.value.replace(/\s+$/, '')
    if (old?.el) old.el.style.visibility = ''
    if (!text) { if (old) remove(old); return }
    s.t = text
    if (!old) strokes.push(s)
    paint(s)
    changed()
  }
  requestAnimationFrame(() => { fitSize(); ta.focus() })
}

function eraseAt(e: PointerEvent) {
  for (const el of document.elementsFromPoint(e.clientX, e.clientY)) {
    const s = strokes.find(s => s.el === el)
    if (s) remove(s)
  }
}

addEventListener('keydown', e => {
  if (!drawing || !shortcutOk(e)) return
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); const s = strokes.at(-1); if (s) remove(s) }
  else if (e.key === 'Escape') setDrawing(false)
  else if (e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return
  const t = toolKey(e)
  if (t) pick(t)
})
/** Draw mode with one tool picked. */
export function useTool(t: Tool) {
  if (!drawing) setDrawing(true)
  setTool(t)
}

for (const b of bar.querySelectorAll<HTMLButtonElement>('[data-ink]')) {
  b.onclick = () => {
    const [kind, val] = b.dataset.ink!.split(':')
    if (kind === 'color') { color = val; if (tool === 'eraser') setTool('pen') }
    else if (kind === 'size') { size = Number(val); if (tool === 'eraser') setTool('pen') }
    else if (kind === 'erase') return pick('eraser')
    else if (kind === 'arrow') return pick('arrow')
    else if (kind === 'text') return pick('text')
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

/** Drop a window's own ink (e.g. a plan's marks when a new version replaces the text they were about, or a session
 *  being closed) and stop watching its rows. */
export function clearInk(host: HTMLElement) {
  for (const s of onHost(host)) remove(s)
  unwatch(host)
}

type Box = { x: number; y: number; w: number; h: number }
/** A stroke's bounding box (x0, y0, x1, y1), measured once after it changes. */
function bbox(s: Stroke) {
  if (s.bb) return s.bb
  if (s.t != null) { // text: about 0.6em per character, 1.25em per line
    const lines = s.t.split('\n'), [x, y] = s.p[0]
    return (s.bb = [x, y, x + s.s * 0.6 * Math.max(...lines.map(l => l.length)), y + s.s * 1.25 * lines.length])
  }
  const xs = s.p.map(q => q[0]), ys = s.p.map(q => q[1]), m = s.s
  return (s.bb = [Math.min(...xs) - m, Math.min(...ys) - m, Math.max(...xs) + m, Math.max(...ys) + m])
}
/** Does a canvas-level stroke overlap `r`? Its box first; then a point really inside (a long diagonal line's box
 *  covers far more than the line). */
const over = (s: Stroke, r: Box) => {
  const [x0, y0, x1, y1] = bbox(s)
  if (x1 < r.x || x0 > r.x + r.w || y1 < r.y || y0 > r.y + r.h) return false
  return s.t != null || s.p.some(([x, y]) => x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h)
}

/** Canvas-level strokes overlapping a world-space rectangle, as SVG path data + color (for snapshots). */
export function strokesIn(r: Box) {
  return strokes.filter(s => !s.host && over(s, r))
    .map(s => ({ d: s.el?.getAttribute('d') ?? '', color: s.el ? getComputedStyle(s.el).fill : '#000', text: s.t, at: s.p[0], size: s.s }))
}
/** Is anything drawn on or over this window (canvas_list's drawnOn)? Cheaper than strokesIn: stops at the first. */
export const inkOn = (el: HTMLElement, r: Box) => strokes.some(s => (s.host ? el.contains(s.host) : over(s, r)))

/** What the user wrote (Text tool) on a window or over its area, for Claude to read as text. */
export function textsOn(el: HTMLElement, r: Box) {
  return strokes.filter(s => s.t && (s.host ? el.contains(s.host) : over(s, r))).map(s => s.t!)
}

/* ---------- persistence (saved with the canvas layout) ---------- */
type Saved = Omit<Stroke, 'el' | 'host' | 'row' | 'bb'>
const ink = () => [
  ...strokes.filter(s => !s.host || s.host.isConnected) // a closed window's ink goes with it
    .map(({ c, s, sim, p, h, t, a, o, k, rid }): Saved => ({ c, s: +s.toFixed(2), sim, h, p: p.map(q => q.map(n => +n.toFixed(1))), ...(t != null ? { t } : {}), ...(a != null ? { a, o: Math.round(o!), k, ...(rid ? { rid } : {}) } : {}) })),
  ...waiting,
]
// strokes whose window isn't on the canvas (yet): kept and written back, so a window that loads late (or failed to
// load once) doesn't lose its ink at the next save; attached when it shows up. ponytail: kept forever if it never does.
let waiting: Saved[] = [], tried = 0
persist('ink', ink, (list: Saved[]) => { waiting = list; attach() }, 2) // after the windows it can belong to
function attach() {
  tried = performance.now()
  waiting = waiting.filter(s => {
    const host = s.h ? document.querySelector<HTMLElement>(`[data-ink="${CSS.escape(s.h)}"]`) ?? undefined : undefined
    if (s.h && !host) return true
    const st: Stroke = { ...s, host }
    strokes.push(st)
    paint(st)
    if (host && 'inkRows' in host.dataset && st.a == null) adopt(st) // drawn before strokes followed their rows
    return false
  })
}
onChange(viewOnly => { if (!viewOnly && waiting.length && performance.now() - tried > 1000) attach() })

/** A drawing area for content that scales with its window (see data-ink-fit): the content's own shape (w/h), as big
 *  as its parent allows (the parent needs container-type: size). Put the content inside; call again to reshape. */
export function inkBox(key: string, box?: HTMLElement, w = 1, h = 1) {
  box ??= Object.assign(document.createElement('div'), { className: 'ink-box' })
  box.dataset.ink = key
  box.dataset.inkFit = ''
  box.style.setProperty('--ar', String(w / h || 1))
  return box
}
/** Show a (re)drawn SVG in its drawing box, shaped by its viewBox, keeping the ink drawn on it. */
export function fitInk(box: HTMLElement, svg: SVGSVGElement) {
  const vb = svg.viewBox.baseVal
  inkBox(box.dataset.ink!, box, vb?.width || 1, vb?.height || 1)
  box.querySelector(':scope > svg:not(.ink-local)')?.remove()
  box.prepend(svg)
}
