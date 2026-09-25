// Selecting several canvas items at once: double-tap and drag on empty canvas (or Shift+drag) draws a selection
// box; Shift/Ctrl+click an item's tab adds or removes it. Dragging a selected item moves them all; Delete (or the
// bar by the selection) removes them, each through its own remove path. Only items laid out on the canvas take part:
// pinned, floating and full-view windows don't.
import { make, ICON, button, iconButton, confirmBox, perFrame, shortcutOk, EDITABLE, keepOnScreen } from '../lib/dom'
import { stage, items, onCanvas, rect, place, toWorld, view, onChange, setGroup, changed, swallowNext, hits, type Rect } from './canvas'
import { redraw } from './graph'
import { drawing } from './ink'
import { handDrag } from './mode'

const sel = new Set<HTMLElement>()
const removers = new Map<string, (el: HTMLElement) => void>()
/** How items of this kind are removed when a selection is deleted, without asking again (the selection asks once).
 *  Kinds that don't register are removed by clicking their own × button; kinds with neither are left alone. */
export const removable = (kind: string, fn: (el: HTMLElement) => void) => { removers.set(kind, fn) }

/** The item's own × (every kind's close/remove button carries .closebtn). */
const closeButton = (el: HTMLElement) => el.querySelector<HTMLButtonElement>(':scope > .win-h .closebtn, :scope > .closebtn')
const canRemove = (el: HTMLElement) => removers.has(el.dataset.kind!) || !!closeButton(el)

export const selected = () => [...sel]
/** Select every item laid out on the canvas (Ctrl/Cmd+A). */
export function selectAll() { for (const el of items().filter(onCanvas)) set(el, true); sync() }
function set(el: HTMLElement, on: boolean) {
  if (on) sel.add(el); else sel.delete(el)
  el.classList.toggle('selected', on)
}
export function clearSelection() { for (const el of [...sel]) set(el, false); sync() }

setGroup(el => (sel.has(el) ? [...sel] : [el]))

/* ---------- the bar by the selection: how many, delete, clear ---------- */
const count = make('span', 'n')
const bar = document.body.appendChild(make('div', 'selbar float'))
bar.setAttribute('role', 'toolbar')
bar.setAttribute('aria-label', 'Selected items')
bar.append(count, button('Delete', '', () => { removeSelected() }), iconButton(ICON.x, 'Clear selection (Esc)', clearSelection))
bar.hidden = true

function sync() {
  for (const el of [...sel]) if (!el.isConnected || !onCanvas(el)) set(el, false) // removed, pinned or in full view
  bar.hidden = !sel.size
  if (!sel.size) return
  count.textContent = `${sel.size} selected`
  // above the selection's top-left, kept on screen
  const rs = [...sel].map(rect), x = Math.min(...rs.map(r => r.x)), y = Math.min(...rs.map(r => r.y))
  const sx = x * view.k + view.x, sy = y * view.k + view.y
  keepOnScreen(bar, sx, sy - bar.offsetHeight - 10, 64) // not over the toolbar
}
onChange(sync)

const plural = (n: number) => `${n} item${n === 1 ? '' : 's'}`

async function removeSelected() {
  const all = [...sel], gone = all.filter(canRemove), kept = all.length - gone.length
  if (!gone.length) return
  const sessions = gone.some(el => el.dataset.kind === 'session') ? 'Sessions are closed; their conversations stay in History. ' : ''
  const left = kept ? `${plural(kept)} can't be removed this way and stay${kept === 1 ? 's' : ''}.` : ''
  if (!await confirmBox(`Delete ${plural(gone.length)}?`, (sessions + left).trim() || 'They are removed from the canvas.', 'Delete')) return
  for (const el of gone) {
    set(el, false)
    const fn = removers.get(el.dataset.kind!)
    if (fn) fn(el); else closeButton(el)?.click()
  }
  sync()
  changed()
}

/* ---------- picking: Shift/Ctrl+click an item's tab (or a bare node like a note) ---------- */
document.addEventListener('pointerdown', e => {
  if (e.button !== 0 || !(e.shiftKey || e.ctrlKey || e.metaKey) || drawing) return
  const t = e.target as Element, el = t.closest<HTMLElement>('#world > .item')
  if (!el || t.closest(`button, a, ${EDITABLE}`)) return
  if (el.classList.contains('win') && !t.closest('.win-h')) return // inside a window's body: its own clicks
  e.preventDefault()
  e.stopPropagation() // not a drag
  set(el, !sel.has(el))
  sync()
}, true)

/* ---------- the selection box: drag on empty canvas in Select mode; in Hand mode double-tap and drag (or Shift+drag) ---------- */
const box = stage.appendChild(make('div', 'marquee'))
box.hidden = true
const empty = (t: Element) => t === stage || t.matches('#world, #edges, #inkworld')
let last = { t: 0, x: 0, y: 0 }

stage.addEventListener('pointerdown', e => {
  const t = e.target as Element
  if (e.button !== 0 || drawing || !empty(t)) return
  const again = e.timeStamp - last.t < 400 && Math.hypot(e.clientX - last.x, e.clientY - last.y) < 24
  last = { t: e.timeStamp, x: e.clientX, y: e.clientY }
  if (!again && !e.shiftKey && handDrag()) {
    // Hand mode (or Space held): a plain press pans; if it's a click (no drag), it clears the selection
    const up = (ev: PointerEvent) => { if (Math.hypot(ev.clientX - e.clientX, ev.clientY - e.clientY) < 4) clearSelection() }
    addEventListener('pointerup', up, { once: true })
    return
  }
  e.stopImmediatePropagation() // not a pan
  stage.setPointerCapture(e.pointerId)
  const start = toWorld(e.clientX, e.clientY), before = e.shiftKey ? new Set(sel) : new Set<HTMLElement>()
  const candidates = items().filter(onCanvas).map(el => ({ el, r: rect(el) }))
  let moved = false
  const move = perFrame((ev: PointerEvent) => {
    if (!moved && Math.hypot(ev.clientX - e.clientX, ev.clientY - e.clientY) < 4) return
    moved = true
    const x0 = Math.min(e.clientX, ev.clientX), y0 = Math.min(e.clientY, ev.clientY)
    box.hidden = false
    box.style.cssText = `left:${x0}px;top:${y0}px;width:${Math.abs(ev.clientX - e.clientX)}px;height:${Math.abs(ev.clientY - e.clientY)}px`
    const p = toWorld(ev.clientX, ev.clientY)
    const m: Rect = { x: Math.min(start.x, p.x), y: Math.min(start.y, p.y), w: Math.abs(p.x - start.x), h: Math.abs(p.y - start.y) }
    let changes = 0
    for (const { el, r } of candidates) {
      const on = before.has(el) || hits(r, m, 0)
      if (on !== sel.has(el)) { set(el, on); changes++ } // only what crossed the box's edge
    }
    if (changes) sync()
  })
  const up = () => {
    stage.removeEventListener('pointermove', move)
    stage.removeEventListener('pointerup', up)
    stage.removeEventListener('pointercancel', up)
    box.hidden = true
    if (!moved) { if (!again && !e.shiftKey) clearSelection(); return } // a click clears; a double-click still makes a note
    swallowNext('dblclick', 400) // a double-tap-drag's own dblclick mustn't make a note
  }
  stage.addEventListener('pointermove', move)
  stage.addEventListener('pointerup', up)
  stage.addEventListener('pointercancel', up)
}, true)

const NUDGE: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }
addEventListener('keydown', e => {
  if (e.defaultPrevented || e.altKey || drawing) return
  if (!shortcutOk(e)) return
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') { e.preventDefault(); selectAll(); return }
  if (!sel.size || e.ctrlKey || e.metaKey) return
  if (e.key === 'Escape') clearSelection()
  else if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); removeSelected() }
  else if (NUDGE[e.key]) { // arrow keys nudge the selection (Shift: 10px), like Excalidraw
    e.preventDefault()
    const [dx, dy] = NUDGE[e.key], step = e.shiftKey ? 10 : 1
    for (const el of sel) { const r = rect(el); place(el, r.x + dx * step, r.y + dy * step) }
    redraw()
    changed()
  }
})
