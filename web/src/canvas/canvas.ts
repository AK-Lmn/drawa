// The infinite canvas: viewport (pan / zoom), draggable items, fit, minimap.
// Items are absolutely positioned in #world, in world coordinates; #world carries the view transform.
// Every item carries class "item" and data-kind (session, file, run, diagram, sketch, plan, note, ...):
// that's all the canvas, the minimap and the saved layout need to know about it.
import { $, make } from '../lib/dom'

export const stage = $('#stage')
export const world = $('#world')
const inkworld = $('#inkworld') // drawing layer: same transform, stacked above every item
export const view = { x: 0, y: 0, k: 1 }
const MIN = 0.15, MAX = 2
const clamp = (k: number) => Math.min(MAX, Math.max(MIN, k))

const listeners: (() => void)[] = []
/** Called after any view change or item move (minimap, layout saving). */
export const onChange = (f: () => void) => listeners.push(f)
let queued = false
export function changed() {
  if (queued) return
  queued = true
  requestAnimationFrame(() => { queued = false; listeners.forEach(f => f()) })
}

export function apply(glide = false) {
  for (const el of [world, inkworld, stage]) el.classList.toggle('glide', glide)
  if (glide) setTimeout(() => { for (const el of [world, inkworld, stage]) el.classList.remove('glide') }, 460)
  world.style.transform = inkworld.style.transform = `translate(${view.x}px, ${view.y}px) scale(${view.k})`
  const g = 24 * view.k
  stage.style.backgroundSize = `${g}px ${g}px`
  stage.style.backgroundPosition = `${view.x}px ${view.y}px`
  $('#z-label').textContent = Math.round(view.k * 100) + '%'
  changed()
}

export function zoomAt(k: number, cx = innerWidth / 2, cy = innerHeight / 2, glide = false) {
  k = clamp(k)
  view.x = cx - (cx - view.x) * (k / view.k)
  view.y = cy - (cy - view.y) * (k / view.k)
  view.k = k
  apply(glide)
}

/* ---------- items ---------- */
export interface Rect { x: number; y: number; w: number; h: number; min?: boolean }

/** Make `el` a canvas item of this kind and put it in the world. */
export function addItem<T extends HTMLElement>(el: T, kind: string): T {
  el.classList.add('item')
  el.dataset.kind = kind
  world.append(el)
  return el
}
export const items = (kind?: string) => [...world.querySelectorAll<HTMLElement>(kind ? `.item[data-kind="${kind}"]` : '.item')]

export const place = (el: HTMLElement, x: number, y: number) => { el.style.left = `${Math.round(x)}px`; el.style.top = `${Math.round(y)}px` }
/** Where an item is and how big it looks right now (edges, minimap, placement). */
export const rect = (el: HTMLElement): Rect => ({ x: parseFloat(el.style.left) || 0, y: parseFloat(el.style.top) || 0, w: el.offsetWidth, h: el.offsetHeight })
/** Same, but with a collapsed window's expanded height: what saved layouts store. */
export const savedRect = (el: HTMLElement): Rect => {
  const min = el.classList.contains('min')
  return { ...rect(el), h: min ? Number(el.dataset.fullH) : el.offsetHeight, ...(min ? { min } : {}) }
}

let z = 10 // stacking inside #world only
export const front = (el: HTMLElement) => { el.style.zIndex = String(++z) }

/** Asked while an item is dragged (final=false, to highlight a target) and when it's released (final=true).
 *  Return true if the pointer is over something that takes the item: on release it then snaps back to where it was. */
type DropHandler = (el: HTMLElement, x: number, y: number, final: boolean) => boolean
let dropHandler: DropHandler | undefined
export const onDrop = (f: DropHandler) => { dropHandler = f }

/** Drag `el` by `handle`. A press that doesn't move counts as a click. */
export function draggable(el: HTMLElement, handle: HTMLElement, onMove: () => void, onClick?: () => void) {
  handle.addEventListener('pointerdown', e => {
    if (e.button !== 0 || (e.target as Element).closest('button, a, input, textarea, select, .log, .compose, [contenteditable="plaintext-only"], [contenteditable="true"]')) return
    e.stopPropagation()
    front(el)
    const sx = e.clientX, sy = e.clientY, o = rect(el)
    let moved = false
    handle.setPointerCapture(e.pointerId)
    const move = (ev: PointerEvent) => {
      const dx = ev.clientX - sx, dy = ev.clientY - sy
      if (!moved && Math.hypot(dx, dy) < 4) return
      moved = true
      el.classList.add('dragging')
      place(el, o.x + dx / view.k, o.y + dy / view.k)
      dropHandler?.(el, ev.clientX, ev.clientY, false)
      onMove()
    }
    const up = (ev: PointerEvent) => {
      handle.removeEventListener('pointermove', move)
      handle.removeEventListener('pointerup', up)
      handle.removeEventListener('pointercancel', up)
      el.classList.remove('dragging')
      if (moved && dropHandler?.(el, ev.clientX, ev.clientY, true)) { place(el, o.x, o.y); onMove() }
      if (moved) changed(); else onClick?.()
    }
    handle.addEventListener('pointermove', move)
    handle.addEventListener('pointerup', up)
    handle.addEventListener('pointercancel', up)
  })
}

/** Follow one pointer press on `handle`: move(dx, dy) in screen px, end() on release. */
export function track(handle: HTMLElement, e: PointerEvent, move: (dx: number, dy: number) => void, end?: () => void) {
  e.preventDefault()
  e.stopPropagation()
  const sx = e.clientX, sy = e.clientY
  handle.setPointerCapture(e.pointerId)
  const mv = (ev: PointerEvent) => move(ev.clientX - sx, ev.clientY - sy)
  const up = () => {
    handle.removeEventListener('pointermove', mv)
    handle.removeEventListener('pointerup', up)
    handle.removeEventListener('pointercancel', up)
    end?.()
  }
  handle.addEventListener('pointermove', mv)
  handle.addEventListener('pointerup', up)
  handle.addEventListener('pointercancel', up)
}

/** Corner grip that resizes `el` in world units (so it tracks the pointer at any zoom).
 *  `widthOnly`: the height follows the content (text notes). */
export function resizable(el: HTMLElement, minW: number, minH: number, onResize: () => void, widthOnly = false) {
  const grip = make('div', 'grip')
  grip.title = 'Drag to resize'
  el.append(grip)
  grip.addEventListener('pointerdown', e => {
    if (e.button !== 0) return
    front(el)
    const w = el.offsetWidth, h = el.offsetHeight
    el.classList.add('resizing')
    track(grip, e, (dx, dy) => {
      el.style.width = `${Math.max(minW, Math.round(w + dx / view.k))}px`
      if (!widthOnly) el.style.height = `${Math.max(minH, Math.round(h + dy / view.k))}px`
      onResize()
    }, () => { el.classList.remove('resizing'); changed() })
  })
}

const hits = (a: Rect, b: Rect, pad = 16) => a.x < b.x + b.w + pad && b.x < a.x + a.w + pad && a.y < b.y + b.h + pad && b.y < a.y + a.h + pad
/** Move `r` down (then right) until it overlaps nothing on the canvas. */
export function freeSpot(r: Rect, step = 56): Rect {
  const others = items().map(rect)
  for (let i = 0; i < 400 && others.some(o => hits(r, o)); i++) r = i % 12 === 11 ? { ...r, x: r.x + r.w + 40, y: r.y - step * 11 } : { ...r, y: r.y + step }
  return r
}
/** Just right of everything on the canvas, top-aligned with the current view. */
export function nextColumn(w: number, h: number): Rect {
  const all = items().map(rect)
  const x = all.length ? Math.max(...all.map(r => r.x + r.w)) + 160 : 0
  const y = all.length ? Math.min(...all.map(r => r.y)) : 0
  return freeSpot({ x, y, w, h })
}
/** Beside an item (right of it, top-aligned), or the middle of the view when there's none. */
export function spotBeside(el: HTMLElement | null | undefined, w: number, h: number, dx = 150, dy = 0): Rect {
  if (!el) { const c = viewCenter(); return freeSpot({ x: c.x - w / 2, y: c.y - h / 2, w, h }) }
  const r = rect(el)
  return freeSpot({ x: r.x + r.w + dx, y: r.y + dy, w, h })
}
export const toWorld = (cx: number, cy: number) => ({ x: (cx - view.x) / view.k, y: (cy - view.y) / view.k })
export const viewCenter = () => ({ x: (innerWidth / 2 - view.x) / view.k, y: (innerHeight / 2 - view.y) / view.k })

export function centerOn(el: HTMLElement, glide = true) {
  const r = rect(el)
  view.x = innerWidth / 2 - (r.x + r.w / 2) * view.k
  view.y = innerHeight / 2 - (r.y + r.h / 2) * view.k
  apply(glide)
}

export function fit(glide = true) {
  const rs = items().map(rect)
  if (!rs.length) return
  const x0 = Math.min(...rs.map(r => r.x)), y0 = Math.min(...rs.map(r => r.y))
  const x1 = Math.max(...rs.map(r => r.x + r.w)), y1 = Math.max(...rs.map(r => r.y + r.h))
  const pad = 80, top = 64 // keep clear of the toolbar
  const k = clamp(Math.min((innerWidth - pad * 2) / (x1 - x0), (innerHeight - top - pad * 2) / (y1 - y0), 1))
  view.k = k
  view.x = (innerWidth - (x1 - x0) * k) / 2 - x0 * k
  view.y = top + (innerHeight - top - (y1 - y0) * k) / 2 - y0 * k
  apply(glide)
}

/* ---------- input: pan by dragging the background, wheel pans, Ctrl/Cmd+wheel (and pinch) zooms ---------- */
stage.addEventListener('pointerdown', e => {
  if (e.button > 1 || (e.target as Element).closest('.item')) return
  const sx = e.clientX - view.x, sy = e.clientY - view.y
  stage.setPointerCapture(e.pointerId)
  stage.classList.add('panning')
  const move = (ev: PointerEvent) => { view.x = ev.clientX - sx; view.y = ev.clientY - sy; apply() }
  const up = () => { stage.classList.remove('panning'); stage.removeEventListener('pointermove', move); stage.removeEventListener('pointerup', up) }
  stage.addEventListener('pointermove', move)
  stage.addEventListener('pointerup', up)
})

/** Is the pointer over something that scrolls (a card's log, a list, a code block)? Then the wheel is its, even
 *  at the end of its content: reaching the bottom of a log shouldn't start panning the canvas. */
const inScroller = (el: Element | null, e: WheelEvent): boolean => {
  const vertical = Math.abs(e.deltaY) >= Math.abs(e.deltaX)
  for (; el && el !== stage; el = el.parentElement) {
    const s = el as HTMLElement, cs = getComputedStyle(s)
    if (vertical ? s.scrollHeight > s.clientHeight + 1 && /auto|scroll/.test(cs.overflowY) : s.scrollWidth > s.clientWidth + 1 && /auto|scroll/.test(cs.overflowX)) return true
  }
  return false
}
stage.addEventListener('wheel', e => {
  if (e.ctrlKey || e.metaKey) {
    e.preventDefault()
    zoomAt(view.k * Math.exp(-e.deltaY * 0.0022), e.clientX, e.clientY)
    return
  }
  if (inScroller(e.target as Element, e)) return // let card logs, lists and code scroll natively
  e.preventDefault()
  view.x -= e.deltaX
  view.y -= e.deltaY
  apply()
}, { passive: false })

/* ---------- minimap: one box per item, colored by data-kind (and data-state, e.g. a busy session) ---------- */
const mm = $('#mm'), minimap = $('#minimap')
let mmScale = 1, mmOrigin = { x: 0, y: 0 }
onChange(() => {
  if (minimap.offsetParent === null) return // hidden on small screens
  const W = minimap.clientWidth, H = minimap.clientHeight
  const vp: Rect = { x: -view.x / view.k, y: -view.y / view.k, w: innerWidth / view.k, h: innerHeight / view.k }
  const els = items(), rs = els.map(rect), all = [...rs, vp]
  const x0 = Math.min(...all.map(r => r.x)), y0 = Math.min(...all.map(r => r.y))
  const x1 = Math.max(...all.map(r => r.x + r.w)), y1 = Math.max(...all.map(r => r.y + r.h))
  mmScale = Math.min((W - 12) / (x1 - x0), (H - 12) / (y1 - y0))
  mmOrigin = { x: x0 - (W / mmScale - (x1 - x0)) / 2, y: y0 - (H / mmScale - (y1 - y0)) / 2 }
  const box = (r: Rect, kind: string, state?: string) => {
    const i = make('i')
    i.dataset.k = kind
    if (state) i.dataset.s = state
    i.style.cssText = `left:${(r.x - mmOrigin.x) * mmScale}px;top:${(r.y - mmOrigin.y) * mmScale}px;width:${Math.max(2, r.w * mmScale)}px;height:${Math.max(2, r.h * mmScale)}px`
    return i
  }
  mm.replaceChildren(...els.map((el, n) => box(rs[n], el.dataset.kind!, el.dataset.state)), box(vp, 'vp'))
})
minimap.addEventListener('pointerdown', e => {
  const b = minimap.getBoundingClientRect()
  const wx = (e.clientX - b.left) / mmScale + mmOrigin.x, wy = (e.clientY - b.top) / mmScale + mmOrigin.y
  view.x = innerWidth / 2 - wx * view.k
  view.y = innerHeight / 2 - wy * view.k
  apply(true)
})

$('#z-in').onclick = () => zoomAt(view.k * 1.25, undefined, undefined, true)
$('#z-out').onclick = () => zoomAt(view.k / 1.25, undefined, undefined, true)
$('#z-label').onclick = () => zoomAt(1, undefined, undefined, true)
$('#z-fit').onclick = () => fit()
addEventListener('resize', () => changed())
