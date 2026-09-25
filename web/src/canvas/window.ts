// Windows on the canvas (session cards, terminals, diagrams, sketches, plans) share one shape: a folder.
// The header is a tab on the top-left that carries the title and the window's buttons; the body sits under it.
// Drag by the tab, double-click it (or its – button) to collapse the window down to the tab, resize from the corner.
import { make, ICON } from '../lib/dom'
import { addItem, place, front, draggable, resizable, changed, type Rect } from './canvas'
import { redraw } from './graph'

export interface WindowOpts {
  kind: string // data-kind: minimap color, saved layout, references
  cls: string // the window's own class, for its content styles
  title: string
  rect: Rect
  minW: number
  minH: number
  actions?: HTMLElement[] // buttons at the tab's end (the collapse button goes before them)
  onChange?: () => void // after it moves, resizes or collapses (default: re-route the edges)
}
export interface Win { el: HTMLElement; head: HTMLElement; title: HTMLElement; body: HTMLElement }

export function makeWindow(o: WindowOpts): Win {
  const el = make('div', 'win ' + o.cls), head = make('header', 'win-h'), title = make('span', 't', o.title), body = make('div', 'win-b')
  head.append(title, ...(o.actions ?? []))
  el.append(head, body)
  addItem(el, o.kind)
  place(el, o.rect.x, o.rect.y)
  el.style.width = `${o.rect.w}px`
  el.style.height = `${o.rect.h}px`
  front(el)
  const onChange = o.onChange ?? redraw
  draggable(el, head, onChange)
  minimizable(el, head, onChange, !!o.rect.min)
  resizable(el, o.minW, o.minH, onChange)
  return { el, head, title, body }
}

/** Collapse a window to its tab. `start` restores a saved collapse. */
function minimizable(el: HTMLElement, head: HTMLElement, onToggle: () => void, start: boolean) {
  const b = make('button', 'icon minbtn')
  b.type = 'button'
  const sync = () => {
    const min = el.classList.contains('min')
    b.innerHTML = min ? ICON.open : ICON.collapse
    b.title = min ? 'Expand' : 'Collapse'
    b.setAttribute('aria-label', b.title)
    b.setAttribute('aria-expanded', String(!min))
  }
  const toggle = () => {
    if (!el.classList.contains('min')) el.dataset.fullH = String(el.offsetHeight)
    el.classList.toggle('min')
    sync()
    onToggle()
    changed()
  }
  b.onclick = e => { e.stopPropagation(); toggle() }
  head.addEventListener('dblclick', e => { if (!(e.target as Element).closest('button, input')) toggle() })
  head.insertBefore(b, head.querySelector(':scope > button'))
  if (start) { el.dataset.fullH = String(parseFloat(el.style.height) || el.offsetHeight); el.classList.add('min') }
  sync()
}
