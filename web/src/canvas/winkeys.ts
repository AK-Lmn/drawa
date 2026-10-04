// Window keys: W steps through the windows, and M, Shift+F, F2, Shift+P, Shift+S act on the active one (the single
// selected item, else the frontmost window), so every tab button has a key.
import { shortcutOk, ping, ICON } from '../lib/dom'
import { command } from '../lib/keys'
import { items, hidden, front, centerOn, onCanvas } from './canvas'
import { rename } from './window'
import { toggleFull, anyFull, exitFull, isFull } from './fullview'
import { toggleDock, toggleFloat, docked, floating } from './dock'
import { selected, selectOnly } from './select'
import { drawing } from './ink'
import { menuSection } from './menu'

const shown = () => items().filter(el => !hidden(el))
/** The window the keys act on: the one selected item, else the frontmost. */
export function active(): HTMLElement | undefined {
  const s = selected()
  if (s.length === 1) return s[0]
  return shown().reduce<HTMLElement | undefined>((a, el) => (!a || +el.style.zIndex > +a.style.zIndex ? el : a), undefined)
}
/** The active item, only if it's a real window (a tab to act through), not a bare note. */
const activeWin = () => { const el = active(); return el?.querySelector(':scope > .win-h') ? el : undefined }

// reading order (top to bottom, then left to right), not z-order: stepping brings each one forward, which would
// reshuffle a z-order. Styles, not layout reads: this runs over every item.
const at = (el: HTMLElement) => [parseFloat(el.style.top) || 0, parseFloat(el.style.left) || 0]
function step(dir: 1 | -1) {
  const list = shown().sort((a, b) => at(a)[0] - at(b)[0] || at(a)[1] - at(b)[1])
  if (!list.length) return
  const i = list.indexOf(active()!)
  const el = list[i < 0 ? (dir > 0 ? 0 : list.length - 1) : (i + dir + list.length) % list.length]
  front(el)
  if (onCanvas(el)) centerOn(el); else el.scrollIntoView({ block: 'nearest' }) // pinned or floating: already on screen
  ping(el)
  selectOnly(el) // Delete, the arrows and Ctrl+G act on it
}

const collapse = () => activeWin()?.querySelector<HTMLElement>(':scope > .win-h .minbtn')?.click()
const full = () => { if (anyFull()) return exitFull(true); const el = activeWin(); if (el) toggleFull(el) }
const renameActive = () => { const el = activeWin(); if (el) rename(el) }
const pin = () => { const el = activeWin(); if (el) toggleDock(el) }
const stick = () => { const el = activeWin(); if (el) toggleFloat(el) }

command({ label: 'Next window', group: 'Windows', keys: ['W'], run: () => step(1), tip: '`W` steps through your windows; `M` collapses the one it lands on' })
command({ label: 'Previous window', group: 'Windows', keys: ['Shift+W'] })
command({ label: 'Collapse or expand the window', group: 'Windows', keys: ['M'], run: collapse, tip: '`M` collapses the active window to its tab, and opens it again' })
command({ label: 'Full view', group: 'Windows', keys: ['Shift+F'], run: full, tip: '`Shift+F` puts the active window in full view; `Esc` puts it back' })
command({ label: 'Rename the window', group: 'Windows', keys: ['F2'], run: renameActive })
command({ label: 'Pin the window to the sidebar', group: 'Windows', keys: ['Shift+P'], run: pin })
command({ label: 'Stick the window to the screen', group: 'Windows', keys: ['Shift+S'], run: stick })

// the Window section of the right-click menu (canvas/menu.ts): the tab's buttons, for the one window clicked
menuSection('Window', els => {
  const el = els.length === 1 ? els[0] : undefined
  if (!el?.querySelector(':scope > .win-h')) return []
  const min = el.classList.contains('min')
  return [
    { label: min ? 'Expand' : 'Collapse', icon: min ? ICON.open : ICON.collapse, keys: 'M', run: () => el.querySelector<HTMLElement>(':scope > .win-h .minbtn')?.click() },
    { label: isFull(el) ? 'Leave full view' : 'Full view', icon: ICON.full, keys: 'Shift+F', run: () => toggleFull(el) },
    { label: 'Rename', icon: ICON.pencil, keys: 'F2', run: () => rename(el) },
    { label: docked(el) ? 'Unpin from the sidebar' : 'Pin to the sidebar', icon: ICON.pin, keys: 'Shift+P', run: () => toggleDock(el) },
    { label: floating(el) ? 'Unstick from the screen' : 'Stick to the screen', icon: ICON.float, keys: 'Shift+S', run: () => toggleFloat(el) },
  ]
})

const PLAIN: Record<string, () => void> = { w: () => step(1), m: collapse, F2: renameActive }
const SHIFT: Record<string, () => void> = { w: () => step(-1), f: full, p: pin, s: stick }
addEventListener('keydown', e => {
  // Draw mode keeps its own keys (Shift+S, Shift+F and the rest belong to its tools)
  if (e.ctrlKey || e.metaKey || e.altKey || e.defaultPrevented || drawing || !shortcutOk(e)) return
  const k = e.key.length === 1 ? e.key.toLowerCase() : e.key
  const fn = (e.shiftKey ? SHIFT : PLAIN)[k]
  if (!fn || (anyFull() && fn !== full)) return // in full view only its own toggle: the rest would act behind it
  e.preventDefault()
  fn()
})
