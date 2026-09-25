// The work as a graph: session card --action--> its Files window, --run--> its commands window, --plan/ref--> other items.
// Files a session touches are rows in one Files window per session (grouped by folder), not one node each:
// a session that reads 100 files is still one window and one edge. A file becomes its own canvas node only when
// you open it from the file tree.
import { tipText } from '../lib/tooltip'
import { make, ping, iconButton } from '../lib/dom'
import { persist } from '../lib/store'
import { world, onCanvas, liveRect, view, onChange, addItem, place, rect, savedRect, draggable, freeSpot, spotBeside, changed, items, byIds, type Rect } from './canvas'
import { makeWindow } from './window'
import { referable } from './refs'
import type { Session } from '../session/session'
import type { Change } from '../panels/diff'
import { openInspector, inspecting } from '../panels/files'

export type Act = 'read' | 'edit' | 'write' | 'run' | 'plan' | 'made' | 'agent' | 'ref'
const RANK: Act[] = ['plan', 'write', 'edit', 'run', 'agent', 'made', 'read', 'ref'] // which action colors an edge that carries several
/** Everything known about one file across sessions: its diffs (for the inspector) and where it's shown. */
interface FileInfo { path: string; add: number; del: number; changes: Change[]; kind: Act | 'fail'; rows: Set<HTMLElement>; node?: HTMLElement }
interface FileList { el: HTMLElement; list: HTMLElement; count: HTMLElement; rows: Map<string, HTMLElement> }
interface TermNode { el: HTMLElement; list: HTMLElement; count: HTMLElement; n: number }
interface Edge { S: Session; target: HTMLElement; path: SVGPathElement; label: HTMLElement; counts: Partial<Record<Act, number>>; live: number }
interface Pending { edge: Edge; file?: FileInfo; row?: HTMLElement; cmd?: HTMLDetailsElement; act: Act }

export const files = new Map<string, FileInfo>()
const lists = new Map<Session, FileList>()
const terms = new Map<Session, TermNode>()
const edges = new Map<Session, Map<HTMLElement, Edge>>()
const pending = new Map<string, Pending>() // tool_use id -> what to settle when its result arrives
/** Positions restored from the saved layout: "f:<path>" pinned files, "l:<sid>" Files windows, "t:<sid>" commands windows, "p:<id>" plans. */
export const savedPos: Record<string, Rect | { x: number; y: number }> = {}
persist('nodes', layout, v => Object.assign(savedPos, v), 0)
referable('files', {
  icon: '≡',
  label: () => 'files a session touched',
  content: el => ({ text: 'Files a session on my canvas worked with (edit/write = changed, read = only read):\n' +
    [...el.querySelectorAll<HTMLElement>('.frow')].map(r => `- ${tipText(r)} (${r.dataset.state ?? 'read'})`).join('\n') }),
})
referable('run', {
  icon: '$',
  name: 'commands',
  label: () => 'commands a session ran',
  content: el => {
    let budget = 20_000 // ponytail: long outputs are cut, newest commands first to keep
    const rows = [...el.querySelectorAll<HTMLElement>('.tcmd')].reverse().map(r => {
      const out = (r.querySelector('pre')?.textContent ?? '').slice(-Math.max(0, Math.min(3000, budget)))
      budget -= out.length
      return `$ ${tipText(r) || r.querySelector('summary')?.textContent}\n${out}`
    }).reverse()
    return { text: `Commands a session on my canvas ran, with their output:\n\n\`\`\`\n${rows.join('\n\n')}\n\`\`\`` }
  },
})
referable('file', { icon: '≡', label: el => tipText(el), content: (_, path) => ({ text: `File: ${path} (read it if you need its contents)` }) })

const svg = document.getElementById('edges') as unknown as SVGSVGElement
const SVGNS = 'http://www.w3.org/2000/svg'

/* ---------- files ---------- */
function info(path: string): FileInfo {
  let f = files.get(path)
  if (!f) files.set(path, (f = { path, add: 0, del: 0, changes: [], kind: 'read', rows: new Set() }))
  return f
}
const RANK_FILE = { write: 0, edit: 1, fail: 2, read: 3 } as Record<string, number>
const stat = (f: FileInfo) => (f.add || f.del ? [make('span', 'a', `+${f.add}`), ' ', make('span', 'r', `−${f.del}`)] : [])

/** Every place a file shows (rows in Files windows, its pinned node) reflects its state. */
function paint(f: FileInfo) {
  for (const el of [...f.rows, ...(f.node ? [f.node] : [])]) {
    el.dataset.state = f.kind
    el.classList.toggle('sel', inspecting === f.path)
    el.querySelector('.s')!.replaceChildren(...stat(f))
  }
}

/** The session's Files window: right of its card, one row per file, grouped by folder, changed files first. */
function fileList(S: Session): FileList {
  const have = lists.get(S)
  if (have) return have
  const saved = S.sid ? savedPos['l:' + S.sid] as Rect | undefined : undefined
  const count = make('span', 'm'), list = make('div', 'flist')
  const reads = iconButton('<svg viewBox="0 0 16 16"><path d="M1.5 8s2.5-4.5 6.5-4.5S14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8z"/><circle cx="8" cy="8" r="2"/></svg>', 'Hide files that were only read', () => {
    const hide = l.el.classList.toggle('hide-reads')
    reads.classList.toggle('on', hide)
    reads.title = hide ? 'Show files that were only read' : 'Hide files that were only read'
  })
  // collapsed to its tab by default, like commands: the count says enough until you want the list (your choice is saved)
  const { el, head, body } = makeWindow({ kind: 'files', cls: 'lnode', title: 'files', rect: { min: true, ...spotBeside(S.card, 300, 380, 150, 0), ...saved }, minW: 220, minH: 120, actions: [reads] })
  el.dataset.id = 'l:' + S.cid // stable across reloads (the card's id is saved), so arrows and pins come back
  head.querySelector('.t')!.after(count)
  body.append(list)
  const l: FileList = { el, list, count, rows: new Map() }
  lists.set(S, l)
  return l
}

function addRow(l: FileList, f: FileInfo) {
  const slash = f.path.lastIndexOf('/'), dir = slash > 0 ? f.path.slice(0, slash + 1) : './'
  const row = make('button', 'frow')
  row.title = f.path
  row.dataset.dir = dir
  row.append(make('span', 'g'), make('span', 'n', f.path.slice(slash + 1)), make('span', 's'))
  row.onclick = () => openInspector(f.path)
  l.rows.set(f.path, row)
  f.rows.add(row)
  let group = [...l.list.children].find(g => (g as HTMLElement).dataset.dir === dir) as HTMLElement | undefined
  if (!group) {
    group = make('div', 'fgroup')
    group.dataset.dir = dir
    group.append(make('div', 'fdir', dir))
    l.list.append(group) // order() puts it in place
  }
  group.append(row)
  return row
}

/** Keep changed files at the top of their folder, and the header count current. */
function order(l: FileList, row: HTMLElement) {
  const group = row.parentElement!, rank = (r: Element) => RANK_FILE[(r as HTMLElement).dataset.state ?? 'read']
  const before = [...group.querySelectorAll(':scope > .frow')].find(r => r !== row && rank(r) > rank(row))
  if (before && before !== row.nextSibling) group.insertBefore(row, before)
  const all = [...l.rows.values()], changed = all.filter(r => r.dataset.state !== 'read').length
  l.count.textContent = changed ? `${changed} changed · ${all.length - changed} read` : `${all.length} read`
  group.classList.toggle('reads-only', ![...group.querySelectorAll(':scope > .frow')].some(r => (r as HTMLElement).dataset.state !== 'read'))
  // folders with changes first, then folders that were only read; each in path order
  const key = (g: Element) => (g.classList.contains('reads-only') ? '1' : '0') + (g as HTMLElement).dataset.dir
  const groups = [...l.list.children].sort((a, b) => key(a).localeCompare(key(b)))
  if (groups.some((g, i) => g !== l.list.children[i])) l.list.append(...groups)
}

/** A file on the canvas by itself, opened from the file tree. */
function fileNode(f: FileInfo): HTMLElement {
  if (f.node) return f.node
  const el = make('div', 'fnode'), n = make('span', 'n'), slash = f.path.lastIndexOf('/')
  const ext = f.path.includes('.') ? f.path.split('.').pop()!.slice(0, 4) : 'file'
  n.append(make('b', '', f.path.slice(slash + 1)), make('small', '', slash > 0 ? f.path.slice(0, slash + 1) : './'))
  el.append(make('span', 'g', ext), n, make('span', 's'))
  el.title = f.path
  el.tabIndex = 0
  el.setAttribute('role', 'button')
  el.setAttribute('aria-label', `Open ${f.path}`)
  el.dataset.id = 'f:' + f.path
  addItem(el, 'file')
  const p = savedPos['f:' + f.path] ?? spotBeside(null, 220, 44)
  place(el, p.x, p.y)
  f.node = el
  draggable(el, el, redraw, () => openInspector(f.path))
  el.onkeydown = e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openInspector(f.path) } }
  el.append(iconButton('<svg viewBox="0 0 16 16"><path d="M4 4l8 8M12 4l-8 8"/></svg>', 'Remove from canvas', () => {
    forget(el); el.remove(); f.node = undefined; changed()
  }, 'fdel'))
  paint(f)
  return el
}

function termNode(S: Session): TermNode {
  const have = terms.get(S)
  if (have) return have
  const r = rect(S.card), saved = S.sid ? savedPos['t:' + S.sid] as Rect | undefined : undefined
  const at = freeSpot({ x: r.x + 40, y: r.y + r.h + 90, w: 420, h: 240 })
  const count = make('span', 'm'), list = make('div', 'cmds-list')
  // collapsed to its tab by default: the run count says enough until you want the output (your choice is saved)
  const { el, head, body } = makeWindow({ kind: 'run', cls: 'tnode', title: 'commands', rect: { min: true, ...at, ...saved }, minW: 240, minH: 120 })
  el.dataset.id = 't:' + S.cid
  head.querySelector('.t')!.after(count)
  body.append(list)
  const t = { el, list, count, n: 0 }
  terms.set(S, t)
  return t
}

/* ---------- edges ---------- */
function edge(S: Session, target: HTMLElement): Edge {
  let m = edges.get(S)
  if (!m) edges.set(S, (m = new Map()))
  let e = m.get(target)
  if (!e) {
    const path = document.createElementNS(SVGNS, 'path')
    const label = make('div', 'elabel')
    svg.append(path)
    world.append(label)
    e = { S, target, path, label, counts: {}, live: 0 }
    m.set(target, e)
  }
  return e
}

function paintEdge(e: Edge) {
  const act = RANK.find(a => e.counts[a]) ?? 'read'
  e.path.setAttribute('class', `edge ${act}${e.live ? ' live' : ''}`)
  e.label.className = `elabel ${act}`
  e.label.textContent = RANK.filter(a => e.counts[a]).map(a => (e.counts[a]! > 1 ? `${a} ×${e.counts[a]}` : a)).join(' · ')
}

// a pan or zoom moves only edges with a pinned or floating end (the rest are in world coordinates)
onChange(viewOnly => {
  if (viewOnly && [...edges.values()].some(m => [...m.values()].some(e => !onCanvas(e.S.card) || !onCanvas(e.target)))) schedule(true)
})

let drawing = false, moved = false
/** Recompute every edge's curve from the current card / node positions (next frame, batched). */
export const redraw = () => schedule(false) // no arguments: it's passed around as a callback
/** `viewOnly`: only the view changed, so the rest of the canvas (arrows, minimap) needn't redo its work. */
function schedule(viewOnly: boolean) {
  moved ||= !viewOnly
  if (drawing) return
  drawing = true
  requestAnimationFrame(() => {
    drawing = false
    for (const m of edges.values()) for (const e of m.values()) geometry(e)
    changed(!moved)
    moved = false
  })
}

function geometry(e: Edge) {
  // full view covers the canvas: its arrows would only draw over it. Pinned windows keep theirs.
  // (and arrows to windows gathered under their collapsed session: they sit right there)
  const hide = e.S.card.classList.contains('full') || e.target.classList.contains('full') || !!e.target.dataset.home
  e.path.style.display = e.label.style.display = hide ? 'none' : ''
  if (hide) return
  const a = liveRect(e.S.card), b = liveRect(e.target)
  const s = onCanvas(e.target) ? 1 : 1 / view.k // a pinned window isn't scaled with the canvas: its offsets are screen px
  let sx: number, sy: number, tx: number, ty: number, c1x: number, c1y: number, c2x: number, c2y: number
  // every edge aims at the target window's tab: it stays put as the window grows or collapses (then it's all there is)
  const head = e.target.querySelector<HTMLElement>(':scope > header')
  const hx = head ? b.x + head.offsetLeft * s : b.x, hw = head ? head.offsetWidth * s : b.w
  const below = b.y > a.y + a.h + 20 && b.x + b.w > a.x && b.x < a.x + a.w
  if (below) { // commands-style: leave from the card's bottom edge, down onto the tab
    tx = hx + hw / 2; ty = b.y
    sx = Math.min(Math.max(tx, a.x + 40), a.x + a.w - 40); sy = a.y + a.h
    const d = Math.max(40, (ty - sy) / 2)
    c1x = sx; c1y = sy + d; c2x = tx; c2y = ty - d
  } else { // leave from the side facing the node, at the node's height when possible
    const right = b.x + b.w / 2 >= a.x + a.w / 2
    sx = right ? a.x + a.w : a.x
    tx = right ? hx - 4 : hx + hw + 4
    ty = b.y + (head ? (head.offsetTop + head.offsetHeight / 2) * s : b.h / 2)
    sy = Math.min(Math.max(ty, a.y + Math.min(60, a.h / 2)), a.y + a.h - Math.min(40, a.h / 2)) // a collapsed card: its tab's middle
    const d = Math.max(60, Math.abs(tx - sx) / 2) * (right ? 1 : -1)
    c1x = sx + d; c1y = sy; c2x = tx - d; c2y = ty
  }
  e.path.setAttribute('d', `M${sx},${sy} C${c1x},${c1y} ${c2x},${c2y} ${tx},${ty}`)
  // label at the curve's midpoint
  e.label.style.left = `${(sx + 3 * c1x + 3 * c2x + tx) / 8}px`
  e.label.style.top = `${(sy + 3 * c1y + 3 * c2y + ty) / 8}px`
}

/* ---------- what chat.ts calls ---------- */
/** Claude read / edited / wrote a file. */
export function touch(S: Session, toolId: string, act: Act, path: string, chg?: Change) {
  const f = info(path), l = fileList(S), e = edge(S, l.el)
  const row = l.rows.get(path) ?? addRow(l, f)
  e.counts[act] = (e.counts[act] ?? 0) + 1
  e.live++
  if (chg) { f.changes.unshift(chg); f.add += chg.add; f.del += chg.del }
  if (act !== 'read' && f.kind !== 'write') f.kind = act // write outranks edit outranks read
  paint(f)
  row.classList.add('live')
  order(l, row)
  paintEdge(e)
  pending.set(toolId, { edge: e, file: f, row, act })
  redraw()
  if (inspecting === path) openInspector(path)
}

/** Claude ran a shell command. */
export function run(S: Session, toolId: string, cmd: string) {
  const t = termNode(S), e = edge(S, t.el)
  // one expandable row per command: summary = first line, body = full command + output (filled in by settle)
  const row = make('details', 'tcmd live'), sum = make('summary', '', cmd.split('\n')[0]), out = make('pre')
  out.textContent = '$ ' + cmd
  row.append(sum, out)
  row.title = cmd
  t.list.prepend(row)
  while (t.list.children.length > 200) t.list.lastElementChild!.remove() // ponytail: newest 200 kept
  t.n++
  t.count.textContent = `${t.n} run${t.n === 1 ? '' : 's'}`
  e.counts.run = (e.counts.run ?? 0) + 1
  e.live++
  paintEdge(e)
  ping(t.el)
  pending.set(toolId, { edge: e, cmd: row, act: 'run' })
  redraw()
}

/** A tool finished: stop the edge flowing, mark failures. */
const status = (d: HTMLDetailsElement, s: string) => { d.classList.remove('live', 'ok', 'bad', 'stopped'); d.classList.add(s) }
export function settle(toolId: string, ok: boolean, output?: string) {
  const p = pending.get(toolId)
  if (!p) return
  pending.delete(toolId)
  p.edge.live = Math.max(0, p.edge.live - 1)
  paintEdge(p.edge)
  if (p.cmd) {
    status(p.cmd, ok ? 'ok' : 'bad')
    if (output) p.cmd.querySelector('pre')!.append('\n\n' + (output.length > 20000 ? output.slice(0, 20000) + '\n\u2026 (truncated)' : output))
  }
  p.row?.classList.remove('live')
  if (p.file && !ok && p.act !== 'read') { p.file.kind = 'fail'; paint(p.file) }
}

/** The session's request ended (done, stopped or errored): nothing on its edges is running any more. */
export function quiet(S: Session) {
  for (const [id, p] of pending) {
    if (p.edge.S !== S) continue
    pending.delete(id)
    p.edge.live = 0
    paintEdge(p.edge)
    if (p.cmd) status(p.cmd, 'stopped')
    p.row?.classList.remove('live')
  }
}

/** Card closed: drop its edges, commands and Files windows, and files nothing shows any more. */
export function dropSession(S: Session) {
  quiet(S)
  for (const e of edges.get(S)?.values() ?? []) { e.path.remove(); e.label.remove() }
  edges.delete(S)
  terms.get(S)?.el.remove()
  terms.delete(S)
  const l = lists.get(S)
  if (l) { l.el.remove(); lists.delete(S); for (const [path, row] of l.rows) files.get(path)?.rows.delete(row) }
  for (const [path, f] of files) if (!f.rows.size && !f.node) files.delete(path)
  // (plan nodes are removed by plan.ts)
  redraw()
}

/** Wire any other node to its session (plan documents). */
export function link(S: Session, el: HTMLElement, act: Act) {
  const e = edge(S, el)
  e.counts[act] = Math.max(1, e.counts[act] ?? 0)
  paintEdge(e)
  redraw()
}

/* ---------- a session's own windows (Files, commands, plans, what its Claude made) fold with it ---------- */
const owned = (e: Edge) => !!(e.counts.made || e.counts.plan || e.counts.agent) || ['files', 'run'].includes(e.target.dataset.kind ?? '')
const minBtn = (el: HTMLElement) => el.querySelector<HTMLElement>(':scope > .win-h .minbtn')
document.addEventListener('collapse', ev => {
  const S = [...edges.keys()].find(s => s.card === ev.target), min = (ev as CustomEvent<boolean>).detail
  if (!S) return
  // collapse what's open, and on expand reopen only those: windows you collapsed yourself stay collapsed. On the
  // canvas they also gather as a stack of tabs under the session's tab, and go back to their places on expand
  // (saved: see 'gathered' below). Stacked by the tab's height: no layout reads in the loop.
  const a = rect(S.card), step = (parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--tab-h')) || 34) + 6
  let y = a.y + a.h + 10
  for (const e of edges.get(S)!.values()) {
    const t = e.target
    if (!owned(e) || t.classList.contains('full')) continue
    if (min) {
      if (!t.classList.contains('min')) { t.dataset.folded = '1'; minBtn(t)?.click() }
      if (onCanvas(t) && t.classList.contains('win') && !t.dataset.home) { // already collapsed ones come along too
        t.dataset.home = `${parseFloat(t.style.left) || 0},${parseFloat(t.style.top) || 0}`
        place(t, a.x + 24, y)
        y += step
      }
    } else {
      if (t.dataset.home && onCanvas(t)) { const [x, hy] = t.dataset.home.split(',').map(Number); place(t, x, hy) }
      delete t.dataset.home
      if (t.dataset.folded) { delete t.dataset.folded; if (t.classList.contains('min')) minBtn(t)?.click() }
    }
  }
  redraw()
  changed()
})

// a window you drag out of the pile is yours again: it stays where you put it (and its arrow shows again)
document.addEventListener('moved', ev => {
  const t = ev.target as HTMLElement
  if (!t.dataset.home) return
  delete t.dataset.home
  redraw()
})
// where gathered windows came from, and which ones the session folded, so expanding after a reload still undoes it
persist('gathered',
  () => Object.fromEntries(items().filter(el => el.dataset.id && (el.dataset.home || el.dataset.folded))
    .map(el => [el.dataset.id!, { home: el.dataset.home, folded: !!el.dataset.folded }])),
  (v: Record<string, { home?: string; folded?: boolean }>) => {
    const found = byIds()
    for (const [id, g] of Object.entries(v ?? {})) {
      const el = found.get(id)
      if (!el) continue
      if (g.home) el.dataset.home = g.home
      if (g.folded) el.dataset.folded = '1'
    }
    redraw()
  }, 2)

/** Links to canvas items a session's Claude made or edited (canvas tools). Replaying the transcript rebuilds file
 *  links, not these, so they're saved with the layout (see session.ts). */
export const itemLinks = () => [...edges].flatMap(([S, m]) => [...m.values()]
  .filter(e => e.target.dataset.id && (e.counts.made || (e.counts.edit && !['file', 'files', 'run'].includes(e.target.dataset.kind ?? ''))))
  .map(e => ({ cid: S.cid, id: e.target.dataset.id!, acts: (['made', 'edit'] as const).filter(a => e.counts[a]) })))

/** Take one kind of link off a session's edge to a node (e.g. a reference chip removed before sending);
 *  the edge goes away only when nothing else connects them. Without `act`, drop the whole edge. */
export function unlink(S: Session, el: HTMLElement, act?: Act) {
  const e = edges.get(S)?.get(el)
  if (!e) return
  if (act) delete e.counts[act]
  if (act && Object.keys(e.counts).length) return paintEdge(e)
  e.path.remove()
  e.label.remove()
  edges.get(S)!.delete(el)
  changed()
}

/** A node left the canvas: drop every edge pointing at it. */
export function forget(el: HTMLElement) {
  for (const S of edges.keys()) unlink(S, el)
}

/** Put a file on the canvas by itself (opened from the file tree). */
export function pin(path: string) {
  const el = fileNode(info(path))
  ping(el)
  redraw()
  return el
}

export function refreshSelection() { for (const f of files.values()) paint(f) }

function layout() {
  const pos: typeof savedPos = {}
  for (const [path, f] of files) if (f.node) { const r = rect(f.node); pos['f:' + path] = { x: r.x, y: r.y } }
  for (const [S, l] of lists) if (S.sid) pos['l:' + S.sid] = savedRect(l.el)
  for (const [S, t] of terms) if (S.sid) pos['t:' + S.sid] = savedRect(t.el)
  return pos
}
