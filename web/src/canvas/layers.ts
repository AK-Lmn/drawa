// Layer order: bring forward / send backward / to front / to back, from the tab's right-click menu, the selection
// bar and Ctrl+] / Ctrl+[ (with Shift: all the way). Only windows on the canvas take part: pinned and floating ones
// sit above it anyway. The order is the 'z' key canvas.ts already saves.
import { make, keepOnScreen, shortcutOk } from '../lib/dom'
import { command } from '../lib/keys'
import { items, onCanvas, hidden, rect, hits, restack } from './canvas'
import { selected, selectionAction } from './select'
import { active } from './winkeys'

type Move = 'front' | 'forward' | 'backward' | 'back'
const z = (el: HTMLElement) => +el.style.zIndex || 0
// items whose CSS pins their layer (a group's frame, always under its windows) aren't in the stack
const stacked = (el: HTMLElement) => onCanvas(el) && !hidden(el) && getComputedStyle(el).zIndex === el.style.zIndex

/** Move one item in the stack. Forward and backward step past the next item it overlaps (one it doesn't overlap
 *  changes nothing you can see), so inside a group that's the group's windows around it. */
function move1(all: HTMLElement[], el: HTMLElement, how: Move) {
  const i = all.indexOf(el)
  all.splice(i, 1)
  if (how === 'front') return all.push(el)
  if (how === 'back') return all.unshift(el)
  const r = rect(el), over = (o: HTMLElement) => o !== el && stacked(o) && hits(r, rect(o), 0)
  if (how === 'forward') { const j = all.findIndex((o, k) => k >= i && over(o)); all.splice(j < 0 ? i : j + 1, 0, el) }
  else { const j = all.findLastIndex((o, k) => k < i && over(o)); all.splice(j < 0 ? i : j, 0, el) }
}

export function layer(els: HTMLElement[], how: Move) {
  const all = items().sort((a, b) => z(a) - z(b))
  // a selection keeps its own order: the top one moves first going up, the bottom one going down
  const mine = els.filter(stacked).sort((a, b) => (how === 'front' || how === 'forward' ? z(b) - z(a) : z(a) - z(b)))
  if (!mine.length) return
  for (const el of how === 'front' || how === 'back' ? mine.reverse() : mine) move1(all, el, how)
  restack(all)
}

const MOVES: [Move, string, string][] = [
  ['front', 'Bring to front', 'Ctrl+Shift+]'],
  ['forward', 'Bring forward', 'Ctrl+]'],
  ['backward', 'Send backward', 'Ctrl+['],
  ['back', 'Send to back', 'Ctrl+Shift+['],
]
const targets = () => { const s = selected(); if (s.length) return s; const a = active(); return a ? [a] : [] }
for (const [how, label, key] of MOVES) command({ label, group: 'Windows', keys: [key], run: () => layer(targets(), how) })
const barBtn = selectionAction('Layer', 'Bring forward or send back (Ctrl+] / Ctrl+[, with Shift: all the way)', () => {
  const r = barBtn.getBoundingClientRect()
  open(selected(), r.left, r.bottom + 4)
}, els => els.some(stacked))

addEventListener('keydown', e => {
  if (!(e.ctrlKey || e.metaKey) || e.altKey || !shortcutOk(e) || (e.code !== 'BracketRight' && e.code !== 'BracketLeft')) return
  e.preventDefault()
  const up = e.code === 'BracketRight'
  layer(targets(), e.shiftKey ? (up ? 'front' : 'back') : (up ? 'forward' : 'backward'))
})

/* ---------- the tab's right-click menu ---------- */
let menu: HTMLElement | null = null
const close = () => { menu?.remove(); menu = null }
addEventListener('pointerdown', e => { if (menu && !menu.contains(e.target as Node)) close() }, true)
addEventListener('keydown', e => { if (e.key === 'Escape' && menu) { e.stopPropagation(); close() } }, true)
addEventListener('wheel', close, { passive: true })

function open(els: HTMLElement[], x: number, y: number) {
  close()
  menu = document.body.appendChild(make('div', 'xsel-menu'))
  menu.setAttribute('role', 'menu')
  for (const [how, label, key] of MOVES) {
    const b = menu.appendChild(make('button', 'xsel-item layer-item'))
    b.setAttribute('role', 'menuitem')
    b.append(make('span', 'xsel-text', label), make('kbd', '', key))
    b.onclick = () => { layer(els, how); close() }
  }
  keepOnScreen(menu, x, y)
  menu.querySelector('button')!.focus()
}
document.addEventListener('contextmenu', e => {
  const el = (e.target as Element).closest<HTMLElement>('#world > .item')
  if (!el || !(e.target as Element).closest('.win-h') || !stacked(el)) return
  e.preventDefault()
  open(selected().includes(el) ? selected() : [el], e.clientX, e.clientY) // a selected window brings the selection along
})
