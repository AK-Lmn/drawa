// Layer order: bring forward / send backward / to front / to back, from the right-click menu (canvas/menu.ts), the
// selection bar and ] / [ (with Shift: all the way). Only windows on the canvas take part: pinned and floating ones
// sit above it anyway. The order is the 'z' key canvas.ts already saves.
import { shortcutOk } from '../lib/dom'
import { command } from '../lib/keys'
import { items, onCanvas, hidden, rect, hits, restack } from './canvas'
import { selected, selectionAction } from './select'
import { active } from './winkeys'
import { drawing } from './ink'
import { openMenu, menuSection } from './menu'

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
  ['front', 'Bring to front', 'Shift+]'],
  ['forward', 'Bring forward', ']'],
  ['backward', 'Send backward', '['],
  ['back', 'Send to back', 'Shift+['],
]
// to front / to back: two sheets, the moving one filled; forward / backward: an arrow past a line
const sheet = (d: string) => `<svg viewBox="0 0 16 16">${d}</svg>`
const ICONS: Record<Move, string> = {
  front: sheet('<path d="M2.5 5.5h7v7h-7z" stroke-dasharray="1.5 1.5"/><path d="M6.5 2.5h7v7h-7z" fill="currentColor" fill-opacity=".25"/>'),
  forward: sheet('<path d="M8 13V5M5 8l3-3 3 3M3 2.5h10"/>'),
  backward: sheet('<path d="M8 3v8M5 8l3 3 3-3M3 13.5h10"/>'),
  back: sheet('<path d="M6.5 2.5h7v7h-7z" stroke-dasharray="1.5 1.5"/><path d="M2.5 5.5h7v7h-7z" fill="currentColor" fill-opacity=".25"/>'),
}
const targets = () => { const s = selected(); if (s.length) return s; const a = active(); return a ? [a] : [] }
for (const [how, label, key] of MOVES) command({ label, group: 'Windows', keys: [key], run: () => layer(targets(), how) })
const barBtn = selectionAction('Layer', 'Bring forward or send back (] / [, with Shift: all the way)', () => {
  const r = barBtn.getBoundingClientRect()
  openMenu(selected(), r.left, r.bottom + 4, 'Layer')
}, els => els.some(stacked))

// bare keys, like a drawing app's: with Cmd or Ctrl the browser keeps them (Cmd+Shift+[ / ] switch tabs on a Mac,
// Cmd+[ / ] go back and forward), so the page never sees them. By physical key: Shift turns them into { and }.
addEventListener('keydown', e => {
  if (e.ctrlKey || e.metaKey || e.altKey || e.defaultPrevented || drawing || !shortcutOk(e) || (e.code !== 'BracketRight' && e.code !== 'BracketLeft')) return
  e.preventDefault()
  const up = e.code === 'BracketRight'
  layer(targets(), e.shiftKey ? (up ? 'front' : 'back') : (up ? 'forward' : 'backward'))
})

// the Layer section of the right-click menu (canvas/menu.ts)
menuSection('Layer', els => (els.some(stacked) ? MOVES.map(([how, label, key]) => ({ label, icon: ICONS[how], keys: key, run: () => layer(els, how) })) : []))
