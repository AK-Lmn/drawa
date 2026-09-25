// Session cards: each is a live Claude process on the server. You can type any time (messages queue while Claude
// or its agents work, like the terminal); output streams in continuously (stream.ts). Every tool call also lands on
// the graph. This module owns the card itself: creating, focusing, closing, and its header / status.
import { make, ICON, iconButton, project } from '../lib/dom'
import { post } from '../lib/api'
import { persist, save, saveSoon } from '../lib/store'
import { front, savedRect, nextColumn, centerOn, fit, view as camera, type Rect } from '../canvas/canvas'
import { makeWindow } from '../canvas/window'
import { dropSession, redraw } from '../canvas/graph'
import type { Ref } from '../canvas/refs'
import type { Pasted } from './images'
import type { Change } from '../panels/diff'
import { dropPlans } from '../items/plan'
import { composer } from './composer'
import { attach } from './live'
import { loadSessions, resume } from './history'

export type ToolRow = HTMLDetailsElement & { chg?: Change }
export interface Block {
  type: string; buf: string; el?: HTMLElement; d?: ToolRow; raf?: number; name?: string; id?: string
  done?: number; tail?: HTMLElement // streaming text: chars already rendered for good, and the element redrawn each frame
}
export interface Session {
  cid: string // this card's live process on the server
  sid: string | null // Claude's session id (transcript), known after the first reply
  title: string
  model: string
  cost: number
  done: boolean
  card: HTMLElement
  log: HTMLDivElement
  ta: HTMLTextAreaElement
  stopBtn: HTMLButtonElement
  blocks: Record<number, Block>
  tools: Record<string, ToolRow>
  pending: number // messages sent and not yet answered
  bg: number // background agents still running
  queued: HTMLElement[] // bubbles waiting for Claude to pick them up
  picked: boolean // Claude echoed a message back during the current turn
  replaying?: boolean // rebuilding a saved transcript: no per-message scroll pinning or header updates (see history.ts)
  asks: Set<string> // approval requests waiting on you
  refs: Ref[] // canvas items attached to the next message
  images: Pasted[] // images pasted or dropped into the message box, sent with the next message
  sentRefs: Set<HTMLElement> // items referenced in messages already sent (their arrows stay)
  chips: HTMLElement
  stream: AbortController | null
  n: number // next output line to read (for re-attaching)
  ctx: { used: number; max: number; real?: boolean } // context window use, from the latest reply's token counts (real: size reported by the CLI)
}

export const cards: Session[] = []
export let cur: Session | undefined // the focused card
/** Models and slash commands / skills, from Claude itself (GET /api/meta). */
export const meta: { models: { value: string; displayName: string; description: string }[]; commands: { name: string; description: string; argumentHint?: string }[] } = { models: [], commands: [] }

/* ---------- saved with the canvas: open cards (by transcript id) and which one had focus ---------- */
type SavedCard = Rect & { id: string; title: string; cid?: string }
persist('cards',
  () => cards.filter(S => S.sid).map((S): SavedCard => ({ id: S.sid!, title: S.title, cid: S.cid, ...savedRect(S.card) })),
  async (list: SavedCard[], all) => {
    for (const c of list) await resume(c, c)
    for (const S of cards) attach(S) // pick up sessions still running on the server (in-flight replies, background agents)
    const f = cards.find(S => S.sid === all.focus)
    if (f) focus(f)
    if (!all.view || innerWidth < 760) fit(false)
  })
persist('focus', () => cur?.sid ?? undefined)

/* ---------- the card ---------- */
function emptyState(S: Session) {
  const e = make('div', 'empty'), ul = make('ul'), chips = make('div', 'chips')
  e.append(make('h2', '', 'New session'), make('p', '', `Claude works in ${project.root}`))
  const tips: [string, string][] = [
    ['--edit', 'Files Claude reads or changes are listed in a Files window beside this card, changed files first.'],
    ['--run', 'Commands it runs collect in a terminal below the card.'],
    ['--write', 'Type / for skills and commands, @ to reference sketches, diagrams, plans, notes or files (or drop them on the message box).'],
    ['--read', 'Read only by default. Pick Allow edits in the toolbar to let Claude change files.'],
  ]
  for (const [color, text] of tips) {
    const li = make('li'), i = make('i')
    i.style.background = `var(${color})`
    li.append(i, text)
    ul.append(li)
  }
  for (const q of ['Summarize this project', 'Map the main modules', 'Find TODOs and rough edges']) {
    const c = make('button', 'btn', q)
    c.type = 'button'
    c.onclick = () => { S.ta.value = q; S.ta.focus() }
    chips.append(c)
  }
  e.append(ul, chips)
  return e
}

export function newSession(opts: { rect?: Rect; cid?: string } = {}) {
  const r = opts.rect ?? nextColumn(460, 600)
  const close = iconButton(ICON.x, 'Close session', () => closeSession(S))
  const { el: card, head, title, body } = makeWindow({ kind: 'session', cls: 'card', title: 'New session', rect: r, minW: 340, minH: 300, actions: [close] })
  head.prepend(make('span', 'dot'))
  const ctx = make('span', 'ctx') // a span, not a button: the tab's buttons are the window controls at its end
  ctx.tabIndex = 0
  ctx.setAttribute('role', 'button')
  ctx.onclick = e => { e.stopPropagation(); S.ta.value = '/compact '; S.ta.focus() } // a nudge, not an action: you still send it
  ctx.onkeydown = e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); ctx.click() } }
  title.after(make('span', 'm'), ctx)
  const log = make('div', 'log')
  body.append(log)

  const S: Session = {
    cid: opts.cid ?? crypto.randomUUID(), sid: null, title: 'New session', model: '', cost: 0, done: false,
    card, log, ta: null!, stopBtn: null!, blocks: {}, tools: {}, pending: 0, bg: 0, queued: [], picked: false, asks: new Set(), refs: [], images: [], sentRefs: new Set(), chips: null!, stream: null, n: -1, ctx: { used: 0, max: 0 },
  }
  composer(S, body) // message box, reference chips, / and @ menu
  log.dataset.ink = 'c:' + S.cid // drawing over the chat scrolls with it
  log.append(emptyState(S))
  cards.push(S)

  card.addEventListener('pointerdown', () => focus(S), true)
  card.addEventListener('focusin', () => focus(S))
  // a waiting permission prompt answers to Enter / Esc from the card (unless you're typing a message)
  card.addEventListener('keydown', e => {
    const open = S.log.querySelector<HTMLElement>('.ask.perm:not(.done)')
    if (!open || (e.target === S.ta && S.ta.value.trim()) || (e.target as Element).closest('.cmds, .pnode')) return
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); e.stopPropagation(); open.querySelector<HTMLButtonElement>('.btn.primary')!.click() }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); open.querySelector<HTMLButtonElement>('.row .btn:not(.primary)')!.click() }
  }, true)
  new ResizeObserver(redraw).observe(card)

  focus(S)
  renderCard(S)
  if (!opts.rect) {
    if (innerWidth < 520) camera.k = Math.min(camera.k, (innerWidth - 24) / r.w) // phones: the whole card fits on screen
    centerOn(card)
    S.ta.focus({ preventScroll: true })
  }
  return S
}

export function focus(S: Session) {
  if (cur === S) return
  cur?.card.classList.remove('focus')
  cur = S
  S.card.classList.add('focus')
  front(S.card)
  saveSoon()
}

function closeSession(S: Session) {
  S.stream?.abort()
  post('close', { cid: S.cid }).catch(() => {})
  dropSession(S)
  dropPlans(S)
  S.card.remove()
  cards.splice(cards.indexOf(S), 1)
  if (cur === S) cur = undefined
  if (!cards.length) newSession()
  save()
  loadSessions()
}

/** Header, status classes and composer placeholder from the session's current state. */
export function renderCard(S: Session) {
  if (S.replaying) return // once at the end instead
  const busy = S.pending > 0 || S.bg > 0
  S.card.dataset.state = S.asks.size ? 'asking' : busy ? 'busy' : S.done ? 'done' : 'idle'
  S.card.querySelector('.t')!.textContent = S.title
  const m = S.card.querySelector<HTMLElement>('.win-h .m')!
  m.textContent = [S.model.replace(/^claude-/, ''), S.bg ? `${S.bg} agent${S.bg === 1 ? '' : 's'} running` : ''].filter(Boolean).join(' · ')
  // The CLI reports an API-equivalent estimate even on a subscription, where it isn't billed: hover only.
  m.title = S.cost ? `Estimated API-equivalent cost: $${S.cost.toFixed(2)} (not billed on a Claude subscription)` : ''
  const ctx = S.card.querySelector<HTMLElement>('.win-h .ctx')!, pct = S.ctx.max ? Math.min(100, Math.round((S.ctx.used / S.ctx.max) * 100)) : 0
  ctx.hidden = !S.ctx.used
  ctx.style.setProperty('--p', `${pct}%`)
  ctx.dataset.level = pct >= 80 ? 'high' : pct >= 60 ? 'mid' : ''
  ctx.textContent = `${pct}%`
  ctx.title = `Context: ${S.ctx.used.toLocaleString()} of ${S.ctx.max.toLocaleString()} tokens used. Click to write /compact (summarizes the conversation to free space).`
  S.log.classList.toggle('busy', S.pending > 0)
  S.stopBtn.hidden = S.pending === 0
  S.ta.placeholder = busy ? 'Claude is working. Type to queue a message.' : 'Message Claude: / commands, @ files, ! shell'
}

/* ---------- appending to the log ---------- */
const nearBottom = (S: Session, px: number) => S.log.scrollHeight - S.log.scrollTop - S.log.clientHeight < px
/** Append to the log, staying pinned to the bottom if you were reading there. */
export function put<T extends HTMLElement>(S: Session, e: T): T {
  if (S.replaying) { S.log.append(e); return e } // measuring the log after every append re-lays it out each time
  const stick = nearBottom(S, 80)
  S.log.append(e)
  if (stick) S.log.scrollTop = S.log.scrollHeight
  return e
}
export const follow = (S: Session) => { if (!S.replaying && nearBottom(S, 200)) S.log.scrollTop = S.log.scrollHeight }
