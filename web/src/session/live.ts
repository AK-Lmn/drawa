// The live connection to a card's Claude process: send messages, and read its output stream (re-attaching
// after network drops or a reload) until the process exits.
import { make, ui } from '../lib/dom'
import { post } from '../lib/api'
import { quiet } from '../canvas/graph'
import { toContent, type Ref } from '../canvas/refs'
import { cards, put, renderCard, type Session } from './session'
import { chip } from './composer'
import { on, type Msg } from './stream'
import { thumb, imageBlock, type Pasted } from './images'
import { askPermission } from './notify'
import { takeShell } from './shell'

/** Send a message (text, or content blocks like images with a short label for the bubble). */
export async function send(S: Session, prompt: string, content?: object[], refs: Ref[] = [], images: Pasted[] = []) {
  askPermission() // first message: a good moment to ask (it's a user action) whether you want notifications
  S.log.querySelector('.empty')?.remove()
  const bubble = put(S, make('div', 'me queued', prompt))
  if (refs.length || images.length) {
    const row = make('div', 'refs sent')
    row.append(...images.map(img => thumb(img)), ...refs.map(r => chip(r)))
    bubble.append(row)
    refs.forEach(r => S.sentRefs.add(r.el))
  }
  S.log.scrollTop = S.log.scrollHeight
  S.queued.push(bubble)
  if (S.title === 'New session') S.title = prompt.slice(0, 48)
  S.done = false
  S.pending++
  renderCard(S)
  try {
    let p: string | object[] = content ?? await toContent(prompt, refs)
    const shell = takeShell(S) // shell runs since the last message go first, like the terminal's bash mode
    if (shell) p = typeof p === 'string' ? shell + p : [{ type: 'text', text: shell }, ...p]
    if (images.length) p = [...(typeof p === 'string' ? [{ type: 'text', text: p }] : p), ...images.map(imageBlock)]
    await post('send', { cid: S.cid, sid: S.sid, p, mode: ui.mode.value, model: ui.model.value })
    attach(S)
  } catch (e) {
    S.queued.splice(S.queued.indexOf(bubble), 1)
    bubble.classList.replace('queued', 'failed')
    put(S, make('div', 'err', `Could not send: ${(e as Error).message}`))
    S.pending = Math.max(0, S.pending - 1)
    renderCard(S)
  }
}

/** Read this card's live output until the process exits. Re-attaches after network drops; no-op if already reading. */
export async function attach(S: Session) {
  if (S.stream) return
  const ctrl = (S.stream = new AbortController())
  let exited = false
  try {
    const res = await fetch(`/api/events?cid=${S.cid}&from=${S.n}`, { signal: ctrl.signal })
    if (!res.ok || !res.body) return // nothing live for this card (e.g. after a server restart)
    const rd = res.body.getReader(), dec = new TextDecoder()
    let buf = ''
    for (;;) {
      const { done, value } = await rd.read()
      if (done) break
      buf += dec.decode(value, { stream: true })
      const lines = buf.split('\n')
      buf = lines.pop()!
      for (const l of lines) {
        if (!l.trim()) continue // keep-alive
        let m: Msg
        try { m = JSON.parse(l) } catch { continue }
        if (m.type === 'attach') { S.n = m.from; continue }
        S.n++
        if (m.type === 'exit') { exited = true; continue }
        try { on(S, m) } catch (x) { console.error(x, l) }
      }
    }
  } catch (e) {
    if ((e as Error).name === 'AbortError') return
  } finally {
    if (S.stream === ctrl) S.stream = null
  }
  if (exited) {
    // process ended (closed as idle, crashed, or server restarted): the next message starts a new one resuming this session
    S.n = -1
    S.queued.splice(0).forEach(b => b.classList.replace('queued', 'failed'))
    if (S.pending || S.bg) { S.pending = S.bg = 0; quiet(S); renderCard(S) }
  } else if (cards.includes(S)) setTimeout(() => attach(S), 1000) // connection dropped: pick up where we left off
}
