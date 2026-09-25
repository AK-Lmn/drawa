// Claude asking you: tool permission prompts and AskUserQuestion forms, answered right in the card.
// (Plan approval goes through the same request, but plan.ts shows it as a document on the canvas.)
import { make, rel, button } from '../lib/dom'
import { post } from '../lib/api'
import { reviewPlan } from '../items/plan'
import { change } from '../panels/diff'
import { notify } from './notify'
import { put, renderCard, type Session } from './session'
import { describe, type Msg } from './stream'

/** Claude wants to use a tool that needs your OK (or presents a plan, see plan.ts). */
export function approval(S: Session, m: Msg) {
  const r = m.request, id: string = m.request_id
  if (S.asks.has(id)) return // already shown (re-sent on re-attach)
  S.asks.add(id)
  if (r.tool_name === 'ExitPlanMode') { if (!reviewPlan(S, id, r.tool_use_id, r.input?.plan)) S.asks.delete(id); else notify(S, 'plan'); renderCard(S); return }
  notify(S, 'ask')
  if (r.tool_name === 'AskUserQuestion') return question(S, id, r.input?.questions ?? [])
  // compact prompt: what exactly will run (the command / path), Claude's own description as a caption
  const input = r.input ?? {}, tool = r.display_name ?? r.tool_name
  const what = rel(String(input.command ?? input.file_path ?? input.url ?? input.pattern ?? describe(input) ?? ''))
  const box = put(S, make('div', 'ask perm')), top = make('div', 'top'), row = make('div', 'row')
  top.append(make('span', 'need', 'Approval needed'), make('b', '', tool))
  box.append(top, make('code', '', what || tool))
  const caption = r.description && r.description !== what ? r.description : r.decision_reason !== 'This command requires approval' ? r.decision_reason : ''
  if (caption) box.append(make('p', '', caption))
  // file changes: show exactly what would change before you allow it
  const diff = input.file_path && ['Edit', 'MultiEdit', 'Write'].includes(r.tool_name) ? change(S, r.tool_name, rel(String(input.file_path)), input) : undefined
  if (diff) box.append(diff)
  const answer = (allow: boolean, always = false) => {
    box.replaceChildren(make('span', 'answered', `${allow ? '\u2713' : '\u2717'} ${allow ? (always ? 'Always allowed' : 'Allowed') : 'Denied'} ${tool}`), make('code', '', what))
    box.classList.add('done', allow ? 'yes' : 'no')
    S.asks.delete(id)
    renderCard(S)
    post('respond', { cid: S.cid, request_id: id, allow, always }).catch(e => box.append(make('span', 'err', ` Could not answer: ${e.message}`)))
  }
  const btn = (label: string, cls: string, fn: () => void) => row.appendChild(button(label, cls, fn))
  btn('Deny', '', () => answer(false)).title = 'Deny (Esc)'
  if (r.permission_suggestions?.length) btn('Always allow', '', () => answer(true, true)).title = 'Allow, and don\u2019t ask again for this'
  const allow = btn('Allow', 'primary', () => answer(true))
  allow.title = 'Allow (Enter)'
  box.append(row)
  row.prepend(make('span', 'keys', 'Enter to allow \u00b7 Esc to deny'))
  renderCard(S)
  box.scrollIntoView({ block: 'nearest' })
}

/** Claude asks you multiple-choice questions (AskUserQuestion): answer them in the card. */
function question(S: Session, id: string, qs: { question: string; header?: string; options: { label: string; description?: string }[]; multiSelect?: boolean }[]) {
  const box = put(S, make('div', 'ask q')), picked = qs.map(() => new Set<string>()), other = qs.map(() => '')
  const row = make('div', 'row'), skip = make('button', 'btn', 'Skip'), ok = make('button', 'btn primary', 'Answer')
  const ready = () => { ok.disabled = !qs.every((_, i) => picked[i].size || other[i].trim()) }
  qs.forEach((q, i) => {
    const f = make('fieldset')
    f.append(make('legend', '', q.question))
    if (q.header) f.prepend(make('span', 'chip', q.header))
    for (const o of q.options) {
      const b = make('button', 'opt')
      b.setAttribute('aria-pressed', 'false')
      b.append(make('b', '', o.label), ...(o.description ? [make('span', '', o.description)] : []))
      b.onclick = () => {
        if (!q.multiSelect) { picked[i].clear(); f.querySelectorAll('.opt').forEach(x => x.setAttribute('aria-pressed', 'false')) }
        const on = !picked[i].has(o.label)
        if (on) picked[i].add(o.label); else picked[i].delete(o.label)
        b.setAttribute('aria-pressed', String(on))
        ready()
      }
      f.append(b)
    }
    const inp = make('input')
    inp.placeholder = 'Other (type your own answer)'
    inp.setAttribute('aria-label', `Other answer: ${q.question}`)
    inp.oninput = () => { other[i] = inp.value; ready() }
    f.append(inp)
    box.append(f)
  })
  const finish = (text: string) => { row.replaceChildren(make('span', 'answered', text)); box.classList.add('done'); box.querySelectorAll('button, input').forEach(x => ((x as HTMLButtonElement).disabled = true)); S.asks.delete(id); renderCard(S) }
  ok.onclick = () => {
    const answers = Object.fromEntries(qs.map((q, i) => [q.question, [...picked[i], ...(other[i].trim() ? [other[i].trim()] : [])].join(', ')]))
    finish('Answered')
    post('respond', { cid: S.cid, request_id: id, allow: true, answers }).catch(e => row.replaceChildren(make('span', 'err', `Could not answer: ${e.message}`)))
  }
  skip.onclick = () => {
    finish('Skipped')
    post('respond', { cid: S.cid, request_id: id, allow: false, message: 'The user skipped these questions; continue with your best judgment.' }).catch(() => {})
  }
  row.append(skip, ok)
  box.append(row)
  ready()
  renderCard(S)
  box.scrollIntoView({ block: 'nearest' })
}
