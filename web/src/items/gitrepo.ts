// One repository in the Git window: its staged / changed / untracked files (click one for its diff), stage and unstage,
// recent commits, and its commit box (Claude can write the message), push and pull. With repos in subfolders the
// window shows one of these per repo, each a group you can fold; with only the project's own, just its lists.
import { make, ICON, iconButton, button, confirmBox, project } from '../lib/dom'
import { api, post, q } from '../lib/api'
import { changed } from '../canvas/canvas'
import { unified, openable, openFileButton } from '../panels/diff'
import { writer, setWriter, who, installed, blurb, chooser } from '../lib/agents'
import { ghStrip, type Strip } from './gitgh'

export interface GitFile { path: string; x: string; y: string; staged: [number, number]; unstaged: [number, number] }
export interface GitState {
  repo: boolean; missing?: boolean; error?: string; branch?: string; upstream?: boolean; ahead?: number; behind?: number
  files?: GitFile[]; total?: number; log?: { hash: string; subject: string; when: string; author: string }[]
  dir?: string // a nested repo's folder, relative to the project
  nested?: GitState[] // the project's own state only: the repos in its subfolders
}

/** What a repo's view needs from the window around it. */
export interface Host {
  refresh(): void
  open: Set<string> // the diffs you opened, kept open across refreshes
}

export interface RepoView {
  dir: string // '' for the project's own repo
  el: HTMLElement; head: HTMLButtonElement; files: HTMLElement; foot: HTMLElement; msg: HTMLTextAreaElement; out: HTMLElement
  gh: Strip // its pull request
  sig: string // the state last drawn: a refresh that changes nothing leaves the DOM (and open diffs) alone
  st?: GitState
}

/** Commit messages being written, by repo ('' the project's own): kept when the window closes, saved with the layout. */
export const drafts: Record<string, string> = {}
/** Groups you opened (true) or closed; the others are open while they have something to commit, push or pull. */
export const folds: Record<string, boolean> = {}

type GitReply = { ok?: boolean; out?: string; message?: string; error?: string }
/** A git action. Never throws: a dead server comes back as a failed reply. */
const gitPost = (body: object): Promise<GitReply> =>
  post('git', body).catch(e => ({ ok: false, out: (e as Error).message, error: (e as Error).message }))

export const repoName = (dir: string) => dir.split('/').pop() || project.name

export function repoView(dir: string, host: Host): RepoView {
  const el = make('section', 'ggroup'), head = make('button', 'ghead'), files = make('div', 'gfiles')
  const foot = make('div', 'gfoot'), msg = make('textarea'), out = make('p', 'gout')
  const v: RepoView = { dir, el, head, files, foot, msg, out, gh: ghStrip(dir, host.refresh), sig: '' }
  head.onclick = () => { folds[dir] = !isOpen(v); changed(); fold(v); if (isOpen(v)) v.gh.wake() }
  msg.rows = 2
  msg.placeholder = dir ? `Commit message for ${repoName(dir)}` : 'Commit message'
  msg.setAttribute('aria-label', msg.placeholder)
  msg.value = drafts[dir] ?? ''
  msg.addEventListener('keydown', e => { e.stopPropagation(); if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) commit(v, host) })
  msg.addEventListener('input', () => setDraft(dir, msg.value))
  foot.append(msg, out)
  el.append(head, v.gh.el, files, foot)
  return v
}

function setDraft(dir: string, text: string) {
  if (text) drafts[dir] = text
  else delete drafts[dir]
  changed()
}

export function say(v: RepoView, text: string, bad = false) { v.out.textContent = text; v.out.classList.toggle('bad', bad) }

const pending = (st?: GitState) => !!(st?.total || st?.ahead || st?.behind)
/** Is the repo's group open? (Its lists and pull request are in view, when the window is.) */
export const isOpen = (v: RepoView) => folds[v.dir] ?? pending(v.st)
function fold(v: RepoView) { v.head.setAttribute('aria-expanded', String(isOpen(v))) }

/** Draw the repo's state into its view: the group's head line, its lists, and its commit / push / pull buttons. */
export function fill(v: RepoView, st: GitState, host: Host) {
  v.st = st
  const slash = v.dir.lastIndexOf('/'), sync = syncText(st)
  const chev = make('span', 'gchev')
  chev.innerHTML = ICON.open
  v.head.replaceChildren(chev, make('span', 'gp', repoName(v.dir)), make('span', 'gd', slash > 0 ? v.dir.slice(0, slash + 1) : ''),
    make('span', 'gb', st.repo ? `${st.branch}${sync ? ' ' + sync : ''}` : 'unreadable'))
  if (st.total) v.head.append(make('span', 'n', String(st.total)))
  v.head.title = st.repo ? `${v.dir || project.name}: ${st.total ? `${st.total} changed file${st.total === 1 ? '' : 's'}` : 'clean'}` : st.error ?? ''
  fold(v)
  v.gh.el.hidden = !st.repo // pull request status means nothing without a repository
  if (!st.repo) {
    v.files.replaceChildren(make('p', 'none', st.error ?? 'Could not read this repository.'))
    v.foot.hidden = true
    return
  }
  v.foot.hidden = false
  const files = st.files ?? []
  const staged = files.filter(f => f.x !== ' ' && f.x !== '?')
  const changedFiles = files.filter(f => f.y !== ' ' && f.x !== '?')
  const untracked = files.filter(f => f.x === '?')
  const section = (title: string, list: GitFile[], isStaged: boolean, action: [string, () => void]) => {
    if (!list.length) return []
    const h = make('div', 'gsec')
    h.append(make('b', '', title), make('span', 'n', String(list.length)), button(action[0], '', action[1]))
    return [h, ...list.map(f => row(v, f, isStaged, host))]
  }
  const paths = (l: GitFile[]) => l.map(f => f.path)
  v.files.replaceChildren(
    ...section('Staged', staged, true, ['Unstage all', () => op(v, host, 'unstage', paths(staged))]),
    ...section('Changes', changedFiles, false, ['Stage all', () => op(v, host, 'stage', paths(changedFiles))]),
    ...section('Untracked', untracked, false, ['Stage all', () => op(v, host, 'stage', paths(untracked))]),
    ...(files.length ? [] : [make('p', 'none', 'Working tree clean.')]),
    ...((st.total ?? 0) > files.length ? [make('p', 'none', `…and ${st.total! - files.length} more changed files (the list stops at ${files.length}).`)] : []),
    ...(st.log?.length ? [commitsList(st.log)] : []),
  )
  // commit / push buttons reflect what's possible now
  const row2 = make('div', 'row')
  const { box: writeBox, b: write } = writeWith((b, agent) => writeMessage(v, b, agent), n => `${n} reads the staged diff and drafts a message (you can edit it)`)
  write.disabled = !staged.length
  const commitBtn = button(staged.length ? `Commit ${staged.length} file${staged.length === 1 ? '' : 's'}` : 'Commit', 'primary', () => commit(v, host))
  commitBtn.disabled = !staged.length
  row2.append(writeBox)
  if (st.behind) row2.append(button(`Pull ↓${st.behind}`, '', () => op(v, host, 'pull')))
  if (st.ahead || (!st.upstream && st.log?.length)) row2.append(button(st.ahead ? `Push ↑${st.ahead}` : 'Push', '', () => push(v, host)))
  row2.append(commitBtn)
  v.foot.querySelector('.row')?.remove()
  v.msg.after(row2)
}

export const syncText = (st: GitState) => [st.ahead ? `↑${st.ahead}` : '', st.behind ? `↓${st.behind}` : ''].filter(Boolean).join(' ')

const STATUS: Record<string, [string, string]> = { M: ['M', 'modified'], A: ['A', 'added'], D: ['D', 'deleted'], R: ['R', 'renamed'], C: ['C', 'copied'], U: ['U', 'conflict'], '?': ['U', 'untracked'] }

function row(v: RepoView, f: GitFile, isStaged: boolean, host: Host) {
  const code = isStaged ? f.x : f.y === ' ' ? f.x : f.y
  const [letter, word] = STATUS[code] ?? [code, 'changed']
  const [a, d] = isStaged ? f.staged : f.unstaged
  const key = `${isStaged ? 's' : 'w'}:${f.path}`
  const wrap = make('div', 'gfile'), r = make('div', 'grow')
  wrap.dataset.state = word
  const folder = f.path.endsWith('/') // an untracked folder is one row (git status --untracked-files=normal)
  // paths are the project's; a nested repo's rows show them from its own folder, which its group names
  const shown = v.dir && f.path.startsWith(v.dir + '/') ? f.path.slice(v.dir.length + 1) : f.path
  const p = folder ? shown.slice(0, -1) : shown, slash = p.lastIndexOf('/')
  const name = make('button', 'gname')
  name.title = folder ? `${f.path} (untracked folder). Stage it to see its files.` : `${f.path} (${word}). Click for the diff.`
  name.append(make('span', 'gs', letter), make('span', 'gp', p.slice(slash + 1) + (folder ? '/' : '')), make('span', 'gd', slash > 0 ? p.slice(0, slash + 1) : ''))
  const stat = make('span', 's')
  if (a || d) stat.append(make('span', 'a', `+${a}`), ' ', make('span', 'r', `−${d}`))
  const act = iconButton(isStaged ? '<svg viewBox="0 0 16 16"><path d="M3.5 8h9"/></svg>' : ICON.plus, isStaged ? 'Unstage' : 'Stage', () => op(v, host, isStaged ? 'unstage' : 'stage', [f.path]))
  // a deleted file has nothing on disk to open; an untracked folder isn't a file. Paths are the project's: a nested
  // repo's open as they are
  const opens = !folder && word !== 'deleted'
  r.append(name, stat, ...(opens ? [openFileButton(f.path, () => wrap.querySelector('.diff'))] : []), act)
  wrap.append(r)
  const toggle = async () => {
    const open = wrap.querySelector('.diff')
    wrap.classList.toggle('open', !open)
    name.setAttribute('aria-expanded', String(!open))
    if (open) { open.remove(); host.open.delete(key); return }
    host.open.add(key)
    try {
      const { diff } = await api<{ diff: string }>(`git/diff?repo=${q(v.dir)}&path=${q(f.path)}&staged=${isStaged ? 1 : 0}`)
      const d = wrap.appendChild(unified(diff))
      if (opens) openable(d, f.path) // its new side is the file as staged or as it is: line numbers that match it
    } catch (e) { // not an empty open row: closed again, and why
      wrap.classList.remove('open')
      name.setAttribute('aria-expanded', 'false')
      host.open.delete(key)
      say(v, `Couldn't load the diff of ${f.path}: ${(e as Error).message}`, true)
    }
  }
  if (folder) return wrap
  name.onclick = toggle
  if (host.open.has(key)) toggle() // keep a diff you opened open across refreshes
  return wrap
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

async function op(v: RepoView, host: Host, o: string, paths?: string[]) {
  const r = await gitPost({ op: o, repo: v.dir, paths })
  say(v, r.ok ? (o === 'pull' ? r.out || 'Up to date.' : '') : r.out ?? 'Failed', !r.ok)
  host.refresh()
}

async function commit(v: RepoView, host: Host) {
  const message = v.msg.value.trim()
  if (!message) { v.msg.focus(); return say(v, `Write a commit message first (or let ${who(writer())} write one).`, true) }
  const r = await gitPost({ op: 'commit', repo: v.dir, message })
  if (r.ok) { v.msg.value = ''; setDraft(v.dir, ''); say(v, r.out?.split('\n')[0] ?? 'Committed.'); v.gh.refresh() } else say(v, r.out ?? 'Commit failed', true)
  host.refresh()
}

async function push(v: RepoView, host: Host) {
  const where = v.dir ? ` of ${v.dir}` : ''
  if (!await confirmBox('Push to the remote?', `Your commits on this branch${where} are uploaded to the remote repository, where others can see them.`, 'Push')) return
  say(v, 'Pushing…')
  const r = await gitPost({ op: 'push', repo: v.dir })
  if (r.ok) v.gh.refresh()
  say(v, r.ok ? r.out?.split('\n').pop() || 'Pushed.' : r.out ?? 'Push failed', !r.ok)
  host.refresh()
}

/** "Write with <agent>", and a ▾ to pick which agent writes when more than one installed can (remembered, this
 *  browser). `tip` says what it reads, given the agent's name. */
export function writeWith(run: (b: HTMLButtonElement, agent: string) => void, tip: (name: string) => string) {
  const box = make('span', 'writewith'), b = button('', 'ai', () => run(b, writer()))
  const label = () => { b.textContent = `Write with ${who(writer())}`; b.title = tip(who(writer())) }
  label()
  box.append(b)
  const can = installed().filter(a => a.canWrite)
  if (can.length > 1) box.append(chooser('Who writes it', can.map(a => ({ value: a.name, text: a.title, desc: blurb(a.name) })), writer(), v => { setWriter(v); label() }))
  return { box, b }
}

async function writeMessage(v: RepoView, b: HTMLButtonElement, agent: string) {
  b.disabled = true
  const label = b.textContent
  b.textContent = 'Writing…'
  const r = await gitPost({ op: 'message', repo: v.dir, backend: agent })
  b.textContent = label
  b.disabled = false
  if (r.message) { v.msg.value = r.message; setDraft(v.dir, r.message); v.msg.style.height = 'auto'; v.msg.style.height = Math.min(160, v.msg.scrollHeight) + 'px'; say(v, '') }
  else say(v, r.error ?? `${who(agent)} could not write a message.`, true)
}
