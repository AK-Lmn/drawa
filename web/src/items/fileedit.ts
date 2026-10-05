// Editing a file window's file in place: the pencil swaps the highlighted view for an editor (lib/codeedit.ts,
// loaded on first use), Ctrl+S or Vim's :w saves it, the pencil again (or :q) goes back to the view. A save only
// goes through while the file on disk is still what the editor started from (POST /api/file), so it never throws
// away someone else's change. Vim motions are a setting (`vim` in your settings file), off until you turn it on.
// ponytail: an unsaved draft isn't kept through a reload (the page asks before leaving instead); keep drafts in
// the layout if that ever bites.
import { api, post, q } from '../lib/api'
import { $, make, toast, confirmBox, pressed } from '../lib/dom'
import { enhance } from '../lib/select'
import { prefs, setPrefs, onPrefs } from '../lib/prefs'
import { command } from '../lib/keys'
import { onForget } from '../canvas/graph'
import type { Editor } from '../lib/codeedit'

interface Edit { editor: Editor; base: string; dirty: boolean; quit(): Promise<void>; close(): void }
const edits = new Map<HTMLElement, Edit>(), opening = new WeakSet<HTMLElement>()
export const editing = (el: HTMLElement) => edits.has(el)

/** Edit `path` in `host` (the window `el`'s content box), or stop editing if it already is. `done` shows the file
 *  again; `button` is the pencil, shown pressed while editing. */
export async function toggleEdit(el: HTMLElement, host: HTMLElement, path: string, button: HTMLElement, done: () => void) {
  const open = edits.get(el)
  if (open) return open.quit()
  if (opening.has(el)) return // a second click while the editor loads
  opening.add(el)
  try { await start(el, host, path, button, done) } finally { opening.delete(el) }
}

async function start(el: HTMLElement, host: HTMLElement, path: string, button: HTMLElement, done: () => void) {
  let base: string | null
  try { base = (await api<{ text: string | null }>('file?path=' + q(path))).text }
  catch (e) { return toast(`Couldn't read ${path}: ${(e as Error).message}`) }
  if (base == null) return toast(`${path} isn't a text file.`)
  const box = make('div', 'pvnode-ed')
  const { codeEditor } = await import('../lib/codeedit')
  if (!el.isConnected) return // removed while loading
  for (const c of [...host.children]) if (!c.matches('svg.ink-local')) c.remove()
  host.prepend(box)
  const e: Edit = {
    base, dirty: false,
    editor: await codeEditor(box, {
      path, text: base, vim: prefs().vim === 'on',
      save: () => save(e, path),
      quit: () => void e.quit(),
      change: () => { e.dirty = e.editor.text() !== e.base },
    }),
    async quit() {
      if (!e.dirty || await confirmBox('Discard your changes?', `${path} has changes you haven't saved.`, 'Discard')) e.close()
    },
    close() {
      edits.delete(el)
      e.editor.destroy()
      delete el.dataset.state
      pressed(button, false)
      done()
    },
  }
  edits.set(el, e)
  el.dataset.state = 'editing' // canvas_update leaves the window alone while you edit
  pressed(button, true)
  e.editor.focus()
}

async function save(e: Edit, path: string) {
  const text = e.editor.text()
  try {
    await post('file', { path, base: e.base, text })
    e.base = text
    e.dirty = e.editor.text() !== text
    toast(`Saved ${path}`)
  } catch (err) {
    toast((err as { status?: number }).status === 409
      ? `${path} changed on disk since you opened it, so it wasn't saved. Copy your changes, then stop editing to read it again.`
      : `Couldn't save ${path}: ${(err as Error).message}`)
  }
}

onPrefs(p => { for (const e of edits.values()) e.editor.setVim(p.vim === 'on') })
onForget(el => edits.get(el)?.close()) // removed: an Undo brings it back showing the file
addEventListener('beforeunload', ev => { if ([...edits.values()].some(e => e.dirty)) ev.preventDefault() })

command({ label: 'Save the file you’re editing (or :w with Vim motions on)', group: 'Windows', keys: ['Ctrl+S'] })

// the Settings panel's control
const sel = $<HTMLSelectElement>('#vim')
sel.replaceChildren(...([['off', 'Plain editor'], ['on', 'Vim motions']] as const)
  .map(([value, textContent]) => Object.assign(document.createElement('option'), { value, textContent })))
sel.onchange = () => setPrefs({ vim: sel.value === 'on' ? 'on' : 'off' })
enhance(sel)
const sync = () => { sel.value = prefs().vim }
onPrefs(sync)
sync()
