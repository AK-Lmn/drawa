// History: Claude Code's saved transcripts for this folder. Opening one puts its card (and its graph) on the canvas.
import { api, type SavedMessage, type SessionInfo } from '../lib/api'
import { $, make, ago, quietPings, button } from '../lib/dom'
import { enhanceMarked } from '../lib/markdown'
import { save } from '../lib/store'
import { cards, newSession, focus, renderCard } from './session'
import { replay } from './stream'
import { centerOn, type Rect } from '../canvas/canvas'
import { redraw } from '../canvas/graph'

export async function loadSessions() {
  let list: SessionInfo[]
  try { list = await api<SessionInfo[]>('sessions') } catch { return }
  if (!list.length) return $('#sessions').replaceChildren(make('p', 'none', 'No saved sessions for this folder yet. Every session you start here is saved automatically.'))
  $('#sessions').replaceChildren(...list.map(s => {
    const b = make('button', 'sess' + (cards.some(t => t.sid === s.id) ? ' open' : '')), d = make('span', 'd')
    d.append(make('span', '', ago(s.mtime)))
    b.append(make('span', 't', s.title), d)
    b.title = s.title
    b.onclick = () => resume(s)
    return b
  }))
}

const SHOWN = 300 // messages put in the page when a session opens

/** "Show earlier messages": moves the off-page part in above, keeping what you're looking at in place. */
function earlier(log: HTMLElement, older: HTMLElement) {
  const b = button(`Show ${older.childElementCount} earlier entries`, 'earlier', () => {
    const fromBottom = log.scrollHeight - log.scrollTop
    b.replaceWith(...older.childNodes)
    enhanceMarked(log)
    log.scrollTop = log.scrollHeight - fromBottom
  })
  return b
}

/** Open a saved session as a card. `at` restores a saved position (on reload) instead of placing a new one. */
export async function resume(s: { id: string; title: string; cid?: string }, at?: Rect) {
  const open = cards.find(t => t.sid === s.id)
  if (open) { focus(open); centerOn(open.card); return }
  const blank = !at && cards.find(t => !t.sid && !t.pending && t.log.querySelector('.empty'))
  const S = blank || newSession(at ? { rect: at, cid: s.cid } : {})
  S.sid = s.id
  S.title = s.title.slice(0, 48)
  S.log.replaceChildren(make('p', 'none', 'Loading session…'))
  renderCard(S)
  try {
    const msgs = await api<SavedMessage[]>('session?id=' + s.id)
    S.log.replaceChildren()
    // one pass without layout reads (pinning to the bottom, pings, header updates), then settle once
    S.replaying = true
    quietPings(true)
    const live = S.log, older = make('div') as HTMLDivElement
    try {
      // long sessions: only the newest messages go into the page; older ones are still replayed (so the Files
      // window, terminal and plans are complete) but built off-page, and shown when you ask for them
      let cut = Math.max(0, msgs.length - SHOWN)
      while (cut > 0 && msgs[cut].role !== 'user') cut--
      S.log = older
      msgs.slice(0, cut).forEach(m => replay(S, m))
      S.log = live
      msgs.slice(cut).forEach(m => replay(S, m))
    } finally { S.log = live; S.replaying = false; quietPings(false) }
    if (older.childElementCount) live.prepend(earlier(live, older))
    S.log.scrollTop = S.log.scrollHeight
  } catch (e) {
    S.log.replaceChildren(make('div', 'err', `Could not load this session: ${(e as Error).message}`))
  }
  redraw()
  if (!at) centerOn(S.card)
  save()
  loadSessions()
}
