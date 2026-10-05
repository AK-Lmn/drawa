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

interface Edit { editor: Editor; base: string; saving: boolean; quit(): Promise<void>; close(): void }
const edits = new Map<HTMLElement, Edit>(), opening = new WeakSet<HTMLElement>()
/** The editor holds the window's content box, or is about to: the file view must not be drawn into it. */
export const editing = (el: HTMLElement) => edits.has(el) || opening.has(el)

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
  let file: { text: string | null; editable?: boolean }
  try { file = await api('file?path=' + q(path)) }
  catch (e) { return toast(`Couldn't read ${path}: ${(e as Error).message}`) }
  const base = file.text
  if (base == null) return toast(`${path} isn't a text file.`)
  if (!file.editable) return toast(`${path} is over 1 MB or not UTF-8 text, so it can't be edited here.`)
  const box = make('div', 'pvnode-ed')
  let editor: Editor
  try {
    const { codeEditor } = await import('../lib/codeedit')
    if (!el.isConnected) return // removed while loading
    for (const c of [...host.children]) if (!c.matches('svg.ink-local')) c.remove()
    host.prepend(box)
    editor = await codeEditor(box, {
      path, text: base, vim: prefs().vim === 'on',
      save: () => save(e, path),
      quit: () => void e.quit(),
    })
  } catch (err) {
    toast(`Couldn't open the editor: ${(err as Error).message}`)
    opening.delete(el)
    return done() // the file view again, if the box was cleared
  }
  if (!el.isConnected) { // removed while the language loaded: onForget has been and gone, so don't start
    editor.destroy()
    opening.delete(el)
    return done()
  }
  const e: Edit = {
    base, editor, saving: false,
    async quit() {
      if (!e.editor.dirty() || await confirmBox('Discard your changes?', `${path} has changes you haven't saved.`, 'Discard')) e.close()
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
  if (e.saving) return // a second Ctrl+S while one is on its way would be refused as a stale copy
  e.saving = true
  const { text, done } = e.editor.take()
  try {
    await post('file', { path, base: e.base, text })
    e.base = text
    done()
    toast(`Saved ${path}`)
  } catch (err) {
    toast((err as { status?: number }).status === 409
      ? `${path} changed on disk since you opened it, so it wasn't saved. Copy your changes, then stop editing to read it again.`
      : `Couldn't save ${path}: ${(err as Error).message}`)
  } finally { e.saving = false }
}

onPrefs(p => { for (const e of edits.values()) e.editor.setVim(p.vim === 'on') })
onForget(el => edits.get(el)?.close()) // removed: an Undo brings it back showing the file
addEventListener('beforeunload', ev => { if ([...edits.values()].some(e => e.editor.dirty())) ev.preventDefault() })

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
