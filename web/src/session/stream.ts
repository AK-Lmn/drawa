// Rendering Claude's stream-json output into a card: text, thinking, tool calls and their results, sub-agent
// activity, background-agent notifications. Saved transcripts replay through the same path, so the graph rebuilds too.
import type { ContentBlock, SavedMessage } from '../lib/api'
import { make, ui, rel } from '../lib/dom'
import { save } from '../lib/store'
import { md, enhance } from '../lib/markdown'
import { touch, run, settle, quiet, type Act } from '../canvas/graph'
import { change, settleChange, type Change } from '../panels/diff'
import { tree, openInspector, inspecting } from '../panels/files'
import { liveDiagrams } from '../items/diagram'
import { showPlan, planResult, focusPlan } from '../items/plan'
import { cur, put, follow, renderCard, type Session, type ToolRow, type Block } from './session'
import { approval } from './asks'
import { thumb } from './images'
import { notify } from './notify'
import { replayShell } from './shell'
import { TASK_TOOLS, taskCall, taskResult } from './tasks'
import { loadSessions } from './history'

// Claude's stream-json lines; loosely typed on purpose, the CLI owns the schema.
export type Msg = Record<string, any>

function fold(cls: string, title: string) {
  const d = make('details', cls) as ToolRow, s = make('summary')
  s.append(make('b', '', title), make('span', 'arg'), make('span', 'st'))
  d.append(s)
  return d
}
export const describe = (i: Record<string, unknown>) => String(i.command ?? i.file_path ?? i.pattern ?? i.url ?? i.query ?? i.description ?? i.prompt ?? '')
const plain = (c: ContentBlock['content']) => (typeof c === 'string' ? c : (c ?? []).map(x => x.text ?? '').join('\n'))
const ACTS: Record<string, Act> = { Read: 'read', Edit: 'edit', MultiEdit: 'edit', NotebookEdit: 'edit', Write: 'write', Bash: 'run' }
const tag = (xml: string, name: string) => xml.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`))?.[1]?.trim()

/** A tool call's effect on the graph (file nodes, terminal). Returns the diff block for edits. */
function wire(S: Session, id: string, name: string, inp: Record<string, any>): Change | undefined {
  const act = ACTS[name]
  if (act === 'run' && inp.command) run(S, id, inp.command)
  else if (act && inp.file_path) {
    const file = rel(inp.file_path)
    const c = act !== 'read' ? change(S, name, file, inp) : undefined
    touch(S, id, act, file, c)
    return c
  }
}

function start(S: Session, i: number, b: ContentBlock) {
  if (b.type === 'text') S.blocks[i] = { type: 'text', buf: '', el: put(S, make('div', 'md')) }
  else if (b.type === 'thinking') {
    const d = put(S, fold('think run', 'Thinking'))
    d.open = true
    S.blocks[i] = { type: 'thinking', buf: '', el: d.appendChild(make('div')), d }
  } else if (b.type === 'tool_use') {
    const act = ACTS[b.name ?? '']
    const d = put(S, fold(`tool run${act ? ' act-' + act : ''}${b.name === 'Agent' || b.name === 'Task' ? ' agent' : ''}`, b.name ?? 'Tool'))
    S.tools[b.id!] = d
    S.blocks[i] = { type: 'tool_use', buf: '', d, name: b.name, id: b.id }
  }
}

function delta(S: Session, i: number, dl: { text?: string; thinking?: string; partial_json?: string }) {
  const k = S.blocks[i]
  if (!k) return
  k.buf += dl.text ?? dl.thinking ?? dl.partial_json ?? ''
  if (k.type === 'thinking') { k.el!.textContent = k.buf; follow(S) }
  else if (k.type === 'text' && !k.raf) k.raf = requestAnimationFrame(() => { k.raf = 0; streamText(k); follow(S) })
}

/** Where the streamed text can be split for good: the last blank line after `from` that isn't inside a code
 *  fence. Everything before it is complete markdown blocks that won't change. (`from` is always outside a fence.) */
function safeCut(buf: string, from: number) {
  let cut = from, fence = false, i = from
  while (i < buf.length) {
    const nl = buf.indexOf('\n', i)
    if (nl < 0) break
    const line = buf.slice(i, nl)
    if (/^\s*(```|~~~)/.test(line)) fence = !fence
    else if (!fence && !line.trim() && nl > from) cut = nl + 1
    i = nl + 1
  }
  return cut
}

/** One frame of a streaming reply: complete blocks are rendered once and kept; only the unfinished tail is
 *  re-rendered. (Re-rendering the whole reply every frame made long replies slower the longer they got.)
 *  ponytail: blocks render separately while streaming (a loose list may show as two); stop() renders it whole. */
function streamText(k: Block) {
  k.done ??= 0
  if (!k.tail) k.tail = k.el!.appendChild(make('div', 'tail'))
  const cut = safeCut(k.buf, k.done)
  if (cut > k.done) {
    k.tail.insertAdjacentHTML('beforebegin', md(k.buf.slice(k.done, cut)))
    k.done = cut
  }
  k.tail.innerHTML = md(k.buf.slice(k.done))
  liveDiagrams(k.el!, k.buf)
}

function stop(S: Session, i: number) {
  const k = S.blocks[i]
  if (!k) return
  delete S.blocks[i]
  if (k.type === 'text') {
    cancelAnimationFrame(k.raf ?? 0)
    k.el!.innerHTML = md(k.buf)
    enhance(k.el!)
  } else if (k.type === 'thinking') {
    if (!k.buf.trim()) return k.d!.remove()
    k.d!.classList.remove('run')
    k.d!.open = false
    k.d!.querySelector('b')!.textContent = 'Thought'
  } else if (k.type === 'tool_use') {
    let inp: Record<string, any> = {}
    try { inp = JSON.parse(k.buf || '{}') } catch {}
    const d = k.d!
    d.querySelector('.arg')!.textContent = rel(describe(inp))
    const c = wire(S, k.id!, k.name ?? '', inp)
    if (TASK_TOOLS.has(k.name ?? '')) {
      d.classList.add('taskrow')
      d.querySelector('.arg')!.textContent = taskCall(S, k.id!, k.name!, inp) // the checklist above the message box shows the rest
    } else if (k.name === 'ExitPlanMode') {
      showPlan(S, k.id!, String(inp.plan ?? ''))
      d.querySelector('.arg')!.textContent = 'plan ready for review'
      const b = make('button', 'jump', 'Open plan')
      b.onclick = e => { e.preventDefault(); focusPlan(S) }
      d.querySelector('.st')!.before(b)
    } else if (c) {
      d.chg = c
      const j = make('button', 'jump', 'View diff')
      j.onclick = e => { e.preventDefault(); openInspector(c.file, 'changes', c) }
      d.querySelector('.st')!.before(j)
    } else if (d.classList.contains('agent')) {
      // you can't type to an agent directly; the main session relays with SendMessage
      const b = make('button', 'jump', 'Message agent')
      b.title = 'Ask the main session to send this agent a message'
      b.onclick = e => {
        e.preventDefault()
        S.ta.value = `Send the "${inp.description ?? 'agent'}" agent this message (use SendMessage): `
        S.ta.focus()
      }
      d.querySelector('.st')!.before(b)
      const pre = d.appendChild(make('div', 'io')).appendChild(make('pre', '', String(inp.prompt ?? '')))
      pre.dataset.l = 'Task'
    } else {
      // edits skip this: their diff is the input
      const pre = d.appendChild(make('div', 'io')).appendChild(make('pre', '', JSON.stringify(inp, null, 2)))
      pre.dataset.l = 'Input'
    }
  }
}

function result(S: Session, r: ContentBlock) {
  const d = S.tools[r.tool_use_id!]
  const t = plain(r.content)
  if (d?.classList.contains('agent') && /^Async agent launched/.test(t)) {
    // background agent: its row keeps running until a task-notification reports back
    d.classList.add('bg')
    d.querySelector('.st')!.textContent = 'background'
    S.bg++
    renderCard(S)
    return
  }
  settle(r.tool_use_id!, !r.is_error, t)
  if (!r.is_error) taskResult(S, r.tool_use_id!, t)
  if (d?.querySelector('summary b')?.textContent === 'ExitPlanMode') planResult(S, !r.is_error)
  if (!d) return
  d.classList.remove('run')
  if (d.classList.contains('agent')) d.open = false
  if (r.is_error) { d.classList.add('bad'); d.querySelector('.st')!.textContent = 'failed' }
  const io = d.querySelector('.io') ?? d.appendChild(make('div', 'io'))
  const pre = io.appendChild(make('pre', '', t.length > 20000 ? t.slice(0, 20000) + '\n… (truncated)' : t || '(no output)'))
  pre.dataset.l = r.is_error ? 'Error' : d.classList.contains('agent') ? 'Result' : 'Output'
  if (d.chg) {
    settleChange(d.chg, !r.is_error)
    if (inspecting === d.chg.file) openInspector(d.chg.file) // refresh the open file
  }
}

/** A background agent finished (Claude gets a <task-notification> message). */
function notification(S: Session, xml: string) {
  const d = S.tools[tag(xml, 'tool-use-id') ?? '']
  const summary = tag(xml, 'summary') ?? 'Background agent finished'
  if (d?.classList.contains('bg')) {
    d.classList.remove('run', 'bg')
    d.querySelector('.st')!.textContent = tag(xml, 'status') === 'completed' ? '' : tag(xml, 'status') ?? ''
    const pre = (d.querySelector('.io') ?? d.appendChild(make('div', 'io'))).appendChild(make('pre', '', tag(xml, 'result') ?? summary))
    pre.dataset.l = 'Result'
    S.bg = Math.max(0, S.bg - 1)
  }
  put(S, make('p', 'note', summary))
  renderCard(S)
}

/** Sub-agent activity (lines tagged with the Agent call that started it) goes inside that Agent row. */
function subagent(S: Session, m: Msg) {
  const d = S.tools[m.parent_tool_use_id]
  if (!d || (m.type !== 'assistant' && m.type !== 'user')) return
  let box = d.querySelector<HTMLElement>('.sublog')
  if (!box) {
    box = make('div', 'sublog')
    d.querySelector('summary')!.after(box)
    d.open = true
  }
  const content = m.message?.content
  if (m.type === 'assistant') {
    for (const b of content ?? []) {
      if (b.type === 'text' && b.text.trim()) { const t = box.appendChild(make('div', 'md')); t.innerHTML = md(b.text); enhance(t) }
      else if (b.type === 'tool_use') {
        const act = ACTS[b.name]
        const row = box.appendChild(make('div', `subtool run${act ? ' act-' + act : ''}`))
        row.dataset.id = b.id
        row.append(make('b', '', b.name), make('span', 'arg', rel(describe(b.input ?? {}))), make('span', 'st'))
        wire(S, b.id, b.name, b.input ?? {})
      }
    }
  } else if (Array.isArray(content)) {
    for (const b of content) {
      if (b.type !== 'tool_result') continue
      settle(b.tool_use_id, !b.is_error, plain(b.content))
      const row = box.querySelector<HTMLElement>(`[data-id="${CSS.escape(b.tool_use_id)}"]`)
      if (row) { row.classList.remove('run'); if (b.is_error) { row.classList.add('bad'); row.querySelector('.st')!.textContent = 'failed' } }
    }
  }
  box.scrollTop = box.scrollHeight
  follow(S)
}

/** Context in use = everything sent to the model for this reply (fresh input + cache reads + cache writes). */
function usage(S: Session, u: Msg | undefined) {
  if (!u) return
  S.ctx.used = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0)
  // until a result reports the real window: 1M if the model says so, or if we're already past 200k (can't exceed the window)
  if (!S.ctx.real) S.ctx.max = /\[1m\]/.test(S.model) || S.ctx.used > 200_000 ? 1_000_000 : 200_000
  renderCard(S)
}

export function on(S: Session, m: Msg) {
  if (m.session_id && m.session_id !== S.sid && !m.parent_tool_use_id) { S.sid = m.session_id; save() }
  if (m.parent_tool_use_id) return subagent(S, m)
  if (m.type === 'control_request' && m.request?.subtype === 'can_use_tool') return approval(S, m)
  if (m.type === 'system' && m.subtype === 'status' && m.permissionMode && S === cur) { ui.mode.value = m.permissionMode; ui.mode.dataset.mode = m.permissionMode; ui.mode.dispatchEvent(new Event('sync')) }
  if (m.type === 'system' && m.subtype === 'init') {
    S.model = m.model
    renderCard(S)
  } else if (m.type === 'stream_event') {
    const e = m.event
    if (e.type === 'message_start') { S.blocks = {}; usage(S, e.message?.usage) }
    else if (e.type === 'content_block_start') start(S, e.index, e.content_block)
    else if (e.type === 'content_block_delta') delta(S, e.index, e.delta)
    else if (e.type === 'content_block_stop') stop(S, e.index)
  } else if (m.type === 'user') {
    const c = m.message?.content
    const text = typeof c === 'string' ? c : Array.isArray(c) ? c.filter((b: ContentBlock) => b.type === 'text').map((b: ContentBlock) => b.text).join('\n') : ''
    if (text.startsWith('<task-notification>')) notification(S, text)
    else if (text) { S.queued.shift()?.classList.remove('queued'); S.picked = true } // Claude picked up a message we sent
    if (Array.isArray(c)) for (const b of c) if (b.type === 'tool_result') result(S, b)
  } else if (m.type === 'assistant' && m.message?.model === '<synthetic>') {
    // replies that don't come from the model (local slash commands like /model): whole, not streamed
    const text = (m.message.content ?? []).filter((b: ContentBlock) => b.type === 'text').map((b: ContentBlock) => b.text).join('\n')
    if (text) { const el = put(S, make('div', 'md')); el.innerHTML = md(text); enhance(el) }
  } else if (m.type === 'error') {
    put(S, make('div', 'err', m.text))
  } else if (m.type === 'result') {
    if (m.is_error && m.subtype !== 'error_during_execution') put(S, make('div', 'err', m.result || m.subtype))
    if (m.subtype === 'error_during_execution') put(S, make('p', 'note', 'Stopped.'))
    const denied = [...new Set<string>((m.permission_denials ?? []).map((p: Msg) => p.tool_name))]
    if (denied.length) put(S, make('div', 'err', `Blocked: ${denied.join(', ')}. Pick Allow edits (or Allow everything) in the toolbar and ask again.`))
    // the model's real context window, when the CLI reports it
    const windows = Object.values(m.modelUsage ?? {}).map((u: any) => u?.contextWindow).filter(Boolean) as number[]
    if (windows.length) { S.ctx.max = Math.max(...windows); S.ctx.real = true }
    const turns = m.num_turns ?? 0
    S.cost += m.total_cost_usd ?? 0
    S.done = !m.is_error
    const foot = put(S, make('p', 'foot', `${((m.duration_ms ?? 0) / 1000).toFixed(1)}s · ${turns} turn${turns === 1 ? '' : 's'}`))
    foot.title = `Estimated API-equivalent cost: $${(m.total_cost_usd ?? 0).toFixed(4)} (not billed on a Claude subscription)`
    // a turn answers every message Claude picked up so far (queued ones can join a turn mid-way): only unread ones remain
    // local commands (/model, /cost...) finish without echoing the message back: the oldest queued one was it
    if (!S.picked) S.queued.shift()?.classList.remove('queued')
    S.picked = false
    S.pending = S.queued.length
    if (!S.pending) notify(S, 'done')
    if (!S.pending) {
      S.log.querySelectorAll('details.run:not(.bg)').forEach(d => d.classList.remove('run'))
      if (!S.bg) quiet(S)
    }
    renderCard(S)
    save()
    loadSessions()
    tree()
  }
}

/** Rebuild a saved transcript through the same start/delta/stop path the live stream uses (so the graph rebuilds too). */
export function replay(S: Session, m: SavedMessage & { usage?: Msg }) {
  if (m.usage) usage(S, m.usage) // the latest reply's token counts: the context meter works for reopened sessions too
  const blocks: ContentBlock[] = typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : m.content ?? []
  if (m.role === 'user') {
    let bubble: HTMLElement | undefined
    for (const b of blocks) {
      if (b.type === 'tool_result') result(S, b)
      else if (b.type === 'text' && b.text!.startsWith('<task-notification>')) notification(S, b.text!)
      else if (b.type === 'text' && b.text!.startsWith('<bash-input>')) { const rest = replayShell(S, b.text!); if (rest) bubble = put(S, make('div', 'me', rest)) }
      else if (b.type === 'text' && !b.text!.startsWith('<')) bubble = put(S, make('div', 'me', b.text))
      else if (b.type === 'image' && (b as any).source?.data) { // images you sent: thumbnails in your message
        bubble ??= put(S, make('div', 'me'))
        const row = bubble.querySelector('.refs.sent') ?? bubble.appendChild(make('div', 'refs sent'))
        const src = (b as any).source
        row.append(thumb({ type: src.media_type, data: src.data, url: `data:${src.media_type};base64,${src.data}` }))
      }
    }
  } else {
    for (const b of blocks) {
      start(S, 0, b)
      delta(S, 0, b.type === 'tool_use' ? { partial_json: JSON.stringify(b.input) } : b)
      stop(S, 0)
    }
  }
}

