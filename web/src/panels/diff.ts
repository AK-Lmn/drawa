// A diff block for every Edit / MultiEdit / Write. Blocks live on their file's node; the inspector shows them.
import { diffLines } from 'diff'
import { make } from '../lib/dom'
import type { Session } from '../session/session'

export type Change = HTMLDivElement & { file: string; add: number; del: number }
const MAX_LINES = 600 // ponytail: per-change cap; huge writes are unreadable as a diff anyway

export function change(S: Session, tool: string, file: string, inp: Record<string, any>): Change | undefined {
  const pairs: [string, string][] | null =
    tool === 'Write' ? [['', inp.content ?? '']]
    : tool === 'Edit' ? [[inp.old_string ?? '', inp.new_string ?? '']]
    : tool === 'MultiEdit' ? (inp.edits ?? []).map((e: any) => [e.old_string ?? '', e.new_string ?? ''])
    : null
  if (!pairs) return

  const c = make('div', 'chg pending') as Change, h = make('div', 'h'), who = make('span', 'who'), stat = make('span', 'stat'), body = make('div', 'diff')
  c.file = file
  who.append(make('b', tool === 'Write' ? 'write' : '', tool === 'Write' ? 'write' : 'edit'), S.title)
  who.title = `From session: ${S.title}`

  let add = 0, del = 0, shown = 0
  pairs.forEach(([a, b], n) => {
    if (n) body.append(make('div', 'sep', '⋯'))
    for (const part of diffLines(a, b)) {
      const lines = part.value.replace(/\n$/, '').split('\n')
      if (part.added) add += lines.length
      if (part.removed) del += lines.length
      for (const l of lines) {
        if (shown++ >= MAX_LINES) continue
        const row = body.appendChild(make('div', part.added ? 'add' : part.removed ? 'del' : 'ctx', l))
        row.dataset.s = part.added ? '+' : part.removed ? '−' : ''
      }
    }
  })
  if (shown > MAX_LINES) body.append(make('div', 'sep', `… ${shown - MAX_LINES} more lines`))
  c.add = add
  c.del = del
  stat.append(make('span', 'a', `+${add}`), ' ', make('span', 'r', `−${del}`))
  h.append(who, stat, make('span', 'state', 'pending'))
  // click the header to fold the diff down to this one line
  h.tabIndex = 0
  h.setAttribute('role', 'button')
  h.setAttribute('aria-expanded', 'true')
  const fold = () => { const f = c.classList.toggle('folded'); h.setAttribute('aria-expanded', String(!f)) }
  h.onclick = fold
  h.onkeydown = e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fold() } }
  c.append(h, body)
  return c
}

export function settleChange(c: Change, ok: boolean) {
  c.classList.remove('pending')
  c.classList.toggle('failed', !ok)
  c.querySelector('.state')!.textContent = ok ? '' : 'failed'
}
