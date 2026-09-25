// The Git window: branch and sync state, staged / unstaged / untracked files (click one for its diff), stage and
// unstage, commit (Claude can write the message), push and pull, recent commits. One per canvas; it refreshes
// itself every few seconds while it's open and expanded.
import { make, ICON, iconButton, button, confirmBox, ping, project } from '../lib/dom'
import { api, q } from '../lib/api'
import { persist } from '../lib/store'
import { items, savedRect, centerOn, spotBeside, changed, type Rect } from '../canvas/canvas'
import { makeWindow } from '../canvas/window'
import { forget } from '../canvas/graph'

interface GitFile { path: string; x: string; y: string; staged: [number, number]; unstaged: [number, number] }
interface GitState { repo: boolean; error?: string; branch?: string; upstream?: boolean; ahead?: number; behind?: number; files?: GitFile[]; log?: { hash: string; subject: string; when: string; author: string }[] }

let win: { el: HTMLElement; meta: HTMLElement; body: HTMLElement; msg: HTMLTextAreaElement; out: HTMLElement; timer: number; open: Set<string>; last: string } | undefined

const gitPost = (body: object) =>
  fetch('/api/git', { method: 'POST', body: JSON.stringify(body) }).then(r => r.json() as Promise<{ ok?: boolean; out?: string; message?: string; error?: string }>)

/** Open (or bring into view) the Git window. */
export function openGit(r?: Rect) {
  if (win) { centerOn(win.el); ping(win.el); return }
  const meta = make('span', 'm')
  const { el, head, body } = makeWindow({
    kind: 'git', cls: 'gnode', title: 'git', minW: 300, minH: 200,
    rect: r ?? spotBeside(null, 380, 520),
    actions: [iconButton(ICON.x, 'Close', () => { clearInterval(win!.timer); forget(el); el.remove(); win = undefined; changed() })],
  })
  head.querySelector('.t')!.after(meta)
  const list = make('div', 'glist'), foot = make('div', 'gfoot'), msg = make('textarea'), out = make('p', 'gout')
  msg.rows = 2
  msg.placeholder = 'Commit message'
  msg.setAttribute('aria-label', 'Commit message')
  msg.addEventListener('keydown', e => { e.stopPropagation(); if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) commit() })
  foot.append(msg, out)
  body.append(list, foot)
  win = { el, meta, body: list, msg, out, timer: 0, open: new Set(), last: '' }
  // refresh while it's visible and expanded; git status is cheap
  win.timer = setInterval(() => { if (!document.hidden && !el.classList.contains('min')) refresh() }, 4000)
  refresh()
  if (!r) centerOn(el) // a free spot can be off-screen: bring the new window into view
  changed()
}

function say(text: string, bad = false) { if (!win) return; win.out.textContent = text; win.out.classList.toggle('bad', bad) }

export async function refresh() {
  if (!win) return
  let st: GitState
  try { st = await api<GitState>('git') } catch (e) { return say(`Could not read git status: ${(e as Error).message}`, true) }
  const sig = JSON.stringify(st)
  if (sig === win.last) return // nothing changed: keep the DOM (and any open diffs) as they are
  win.last = sig
  draw(st)
}

function draw(st: GitState) {
  const w = win!
  if (!st.repo) {
    w.meta.textContent = 'not a repository'
    const box = make('div', 'gempty')
    box.append(make('p', '', `${project.name} isn't a git repository yet.`), button('Initialize repository', 'primary', async () => {
      if (!await confirmBox('Initialize a git repository?', `Runs git init in ${project.root}. Nothing is committed until you commit.`, 'Initialize')) return
      const r = await gitPost({ op: 'init' })
      say(r.out ?? '', !r.ok)
      refresh()
    }))
    w.body.replaceChildren(box)
    w.msg.parentElement!.hidden = true
    return
  }
  w.msg.parentElement!.hidden = false
  const sync = [st.ahead ? `↑${st.ahead}` : '', st.behind ? `↓${st.behind}` : ''].filter(Boolean).join(' ')
  w.meta.textContent = `${st.branch}${sync ? ' ' + sync : ''}`
  w.meta.title = st.upstream ? `${st.ahead} commit(s) to push, ${st.behind} to pull` : 'No upstream branch yet: Push sets one up'

  const files = st.files ?? []
  const staged = files.filter(f => f.x !== ' ' && f.x !== '?')
  const changedFiles = files.filter(f => f.y !== ' ' && f.x !== '?')
  const untracked = files.filter(f => f.x === '?')
  const section = (title: string, list: GitFile[], isStaged: boolean, action: [string, () => void]) => {
    if (!list.length) return []
    const h = make('div', 'gsec')
    h.append(make('b', '', title), make('span', 'n', String(list.length)), button(action[0], '', action[1]))
    return [h, ...list.map(f => row(f, isStaged))]
  }
  const paths = (l: GitFile[]) => l.map(f => f.path)
  w.body.replaceChildren(
    ...section('Staged', staged, true, ['Unstage all', () => op('unstage', paths(staged))]),
    ...section('Changes', changedFiles, false, ['Stage all', () => op('stage', paths(changedFiles))]),
    ...section('Untracked', untracked, false, ['Stage all', () => op('stage', paths(untracked))]),
    ...(files.length ? [] : [make('p', 'none', 'Working tree clean.')]),
    ...(st.log?.length ? [commitsList(st.log)] : []),
  )
  // commit / push buttons reflect what's possible now
  const row2 = make('div', 'row')
  const write = button('Write with Claude', 'ai', () => writeMessage(write))
  write.disabled = !staged.length
  write.title = 'Claude reads the staged diff and drafts a message (you can edit it)'
  const commitBtn = button(staged.length ? `Commit ${staged.length} file${staged.length === 1 ? '' : 's'}` : 'Commit', 'primary', commit)
  commitBtn.disabled = !staged.length
  row2.append(write)
  if (st.behind) row2.append(button(`Pull ↓${st.behind}`, '', () => op('pull')))
  if (st.ahead || (!st.upstream && st.log?.length)) row2.append(button(st.ahead ? `Push ↑${st.ahead}` : 'Push', '', push))
  row2.append(commitBtn)
  w.msg.parentElement!.querySelector('.row')?.remove()
  w.msg.after(row2)
}

const STATUS: Record<string, [string, string]> = { M: ['M', 'modified'], A: ['A', 'added'], D: ['D', 'deleted'], R: ['R', 'renamed'], C: ['C', 'copied'], U: ['U', 'conflict'], '?': ['U', 'untracked'] }

function row(f: GitFile, isStaged: boolean) {
  const code = isStaged ? f.x : f.y === ' ' ? f.x : f.y
  const [letter, word] = STATUS[code] ?? [code, 'changed']
  const [a, d] = isStaged ? f.staged : f.unstaged
  const key = `${isStaged ? 's' : 'w'}:${f.path}`
  const wrap = make('div', 'gfile'), r = make('div', 'grow')
  wrap.dataset.state = word
  const slash = f.path.lastIndexOf('/')
  const name = make('button', 'gname')
  name.type = 'button'
  name.title = `${f.path} (${word}). Click for the diff.`
  name.append(make('span', 'gs', letter), make('span', 'gp', f.path.slice(slash + 1)), make('span', 'gd', slash > 0 ? f.path.slice(0, slash + 1) : ''))
  const stat = make('span', 's')
  if (a || d) stat.append(make('span', 'a', `+${a}`), ' ', make('span', 'r', `−${d}`))
  const act = iconButton(isStaged ? '<svg viewBox="0 0 16 16"><path d="M3.5 8h9"/></svg>' : ICON.plus, isStaged ? 'Unstage' : 'Stage', () => op(isStaged ? 'unstage' : 'stage', [f.path]))
  r.append(name, stat, act)
  wrap.append(r)
  const toggle = async () => {
    const open = wrap.querySelector('.diff')
    if (open) { open.remove(); win!.open.delete(key); return }
    win!.open.add(key)
    const { diff } = await api<{ diff: string }>(`git/diff?path=${q(f.path)}&staged=${isStaged ? 1 : 0}`)
    wrap.append(unified(diff))
  }
  name.onclick = toggle
  if (win!.open.has(key)) toggle() // keep a diff you opened open across refreshes
  return wrap
}

/** A unified diff as rows in the same style as the inspector's diffs. */
function unified(text: string) {
  const box = make('div', 'diff')
  const lines = text.split('\n')
  const start = lines.findIndex(l => l.startsWith('@@'))
  for (const l of start < 0 ? ['(no textual changes)'] : lines.slice(start)) {
    const kind = l.startsWith('@@') ? 'sep' : l.startsWith('+') ? 'add' : l.startsWith('-') ? 'del' : 'ctx'
    const row = box.appendChild(make('div', kind, kind === 'sep' ? l.replace(/^@@.*?@@\s?/, '⋯ ') : l.slice(1)))
    if (kind !== 'sep') row.dataset.s = kind === 'add' ? '+' : kind === 'del' ? '−' : ''
  }
  return box
}

function commitsList(log: NonNullable<GitState['log']>) {
  const d = make('details', 'glog'), s = make('summary')
  s.append(make('b', '', 'Recent commits'))
  d.append(s, ...log.map(c => {
    const r = make('div', 'gc')
    r.append(make('code', '', c.hash), make('span', 'gm', c.subject), make('span', 'gw', c.when))
    r.title = `${c.hash} · ${c.author} · ${c.when}`
    return r
  }))
  return d
}

async function op(o: string, paths?: string[]) {
  const r = await gitPost({ op: o, paths })
  say(r.ok ? (o === 'pull' ? r.out || 'Up to date.' : '') : r.out ?? 'Failed', !r.ok)
  refresh()
}

async function commit() {
  const w = win!, message = w.msg.value.trim()
  if (!message) { w.msg.focus(); return say('Write a commit message first (or let Claude write one).', true) }
  const r = await gitPost({ op: 'commit', message })
  if (r.ok) { w.msg.value = ''; say(r.out?.split('\n')[0] ?? 'Committed.') } else say(r.out ?? 'Commit failed', true)
  refresh()
}

async function push() {
  if (!await confirmBox('Push to the remote?', 'Your commits on this branch are uploaded to the remote repository, where others can see them.', 'Push')) return
  say('Pushing…')
  const r = await gitPost({ op: 'push' })
  say(r.ok ? r.out?.split('\n').pop() || 'Pushed.' : r.out ?? 'Push failed', !r.ok)
  refresh()
}

async function writeMessage(b: HTMLButtonElement) {
  b.disabled = true
  const label = b.textContent
  b.textContent = 'Writing…'
  const r = await gitPost({ op: 'message' }).catch(e => ({ error: (e as Error).message }) as { message?: string; error?: string })
  b.textContent = label
  b.disabled = false
  if (r.message) { win!.msg.value = r.message; win!.msg.style.height = 'auto'; win!.msg.style.height = Math.min(160, win!.msg.scrollHeight) + 'px'; say('') }
  else say(r.error ?? 'Claude could not write a message.', true)
}

persist('git', () => (win ? savedRect(win.el) : null), (r: Rect | null) => { if (r) openGit(r) })
export const gitOpen = () => !!win && items('git').length > 0
