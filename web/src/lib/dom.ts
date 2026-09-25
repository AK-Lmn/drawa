// Small DOM helpers and the page's fixed elements.

export const $ = <T extends Element = HTMLElement>(sel: string) => document.querySelector(sel) as T

export function make<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string | null) {
  const e = document.createElement(tag)
  if (cls) e.className = cls
  if (text != null) e.textContent = text
  return e
}

const svg = (d: string) => `<svg viewBox="0 0 16 16">${d}</svg>`
export const ICON = {
  x: svg('<path d="M4 4l8 8M12 4l-8 8"/>'),
  plus: svg('<path d="M8 3v10M3 8h10"/>'),
  up: svg('<path d="M8 13V3M3.5 7.5 8 3l4.5 4.5"/>'),
  stop: svg('<rect x="4" y="4" width="8" height="8" rx="1" fill="currentColor" stroke="none"/>'),
  expand: svg('<path d="M9.5 2.5h4v4M6.5 13.5h-4v-4M13.5 2.5 9 7M2.5 13.5 7 9"/>'),
  pencil: svg('<path d="M10.5 2.5l3 3-8 8H2.5v-3z"/>'),
  pin: svg('<path d="M6 2.5h4M7 2.5v4L4.5 9h7L9 6.5v-4M8 9v4.5"/>'),
  collapse: svg('<path d="M3.5 8h9"/>'),
  open: svg('<path d="M4 6.5 8 10.5l4-4"/>'),
}

/** A square icon button; the click doesn't reach the window under it (no drag, no focus steal). */
export function iconButton(icon: string, label: string, onClick: () => void, cls = '') {
  const b = make('button', 'icon' + (cls ? ' ' + cls : ''))
  b.type = 'button'
  b.innerHTML = icon
  b.title = label
  b.setAttribute('aria-label', label)
  b.onclick = e => { e.stopPropagation(); onClick() }
  return b
}

/** A text button (.btn), optionally with a modifier class like primary. */
export function button(label: string, cls: string, onClick: () => void) {
  const b = make('button', 'btn' + (cls ? ' ' + cls : ''), label)
  b.type = 'button'
  b.onclick = onClick
  return b
}

export const ui = {
  mode: $<HTMLSelectElement>('#mode'),
  model: $<HTMLSelectElement>('#model'),
}

/** The folder Claude works in, set once at boot from the server. */
export const project = { root: '', name: '' }
export const rel = (p: string) => (p && p.startsWith(project.root + '/') ? p.slice(project.root.length + 1) : p)

export const ago = (t: number) => {
  const s = Date.now() / 1000 - t
  return s < 60 ? 'just now' : s < 3600 ? `${(s / 60) | 0}m ago` : s < 86400 ? `${(s / 3600) | 0}h ago` : `${(s / 86400) | 0}d ago`
}

/** "dir/sub/" muted + "file.ts" emphasized. */
export function pathEl(cls: string, p: string) {
  const e = make('span', cls), i = p.lastIndexOf('/') + 1
  e.append(p.slice(0, i), make('b', '', p.slice(i)))
  e.title = p
  return e
}

/** A brief outline flash drawing the eye to an element. Web Animations: no forced layout, safe to call often. */
let quietUntil = 0
export const ping = (el: HTMLElement) => {
  if (performance.now() < quietUntil || !el.isConnected) return
  const c = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim()
  el.animate([{ outline: `2px solid ${c}`, outlineOffset: '3px' }, { outline: '2px solid transparent', outlineOffset: '9px' }], { duration: 650, easing: 'cubic-bezier(.22,1,.36,1)' })
}
/** No pings while something rebuilds in bulk (replaying a saved session would flash every file it touched). */
export const quietPings = (on: boolean) => { quietUntil = on ? Infinity : 0 }

/** In-app confirmation (instead of the browser's native confirm()). Resolves true when the action button is chosen. */
export function confirmBox(title: string, body: string, action: string): Promise<boolean> {
  const d = $<HTMLDialogElement>('#confirm')
  d.querySelector('h2')!.textContent = title
  d.querySelector('p')!.textContent = body
  d.querySelector<HTMLButtonElement>('button[value=ok]')!.textContent = action
  d.returnValue = ''
  d.onclick = e => { if (e.target === d) d.close('') } // click outside the box = cancel
  d.showModal()
  return new Promise(res => d.addEventListener('close', () => res(d.returnValue === 'ok'), { once: true }))
}
