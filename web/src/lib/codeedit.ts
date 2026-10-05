// A code editor (CodeMirror 6), with Vim motions when asked. Loaded with a dynamic import() on first edit: nothing
// here is in the page until someone edits a file. Colors come from the theme's --syn-* tokens (styles/items.css
// styles the rest), so it follows light, dark and every scheme without redrawing.
import { EditorView, basicSetup } from 'codemirror'
import { Compartment, EditorState, Prec, StateEffect, StateField, type Extension, type Text } from '@codemirror/state'
import { Decoration, keymap, placeholder, type DecorationSet } from '@codemirror/view'
import { indentWithTab } from '@codemirror/commands'
import { HighlightStyle, LanguageDescription, syntaxHighlighting } from '@codemirror/language'
import { languages } from '@codemirror/language-data'
import { tags as t } from '@lezer/highlight'

/** `take()`: the text to save, and `done()` to call once it's saved; `dirty()`: changed since the last save;
 *  `text()`: what the editor holds now. */
export interface Editor {
  take(): { text: string; done(): void }; dirty(): boolean; text(): string; setText(text: string): void
  goto(line: number): void; setVim(on: boolean): Promise<void>; focus(): void; destroy(): void
}
/** `save()` answers whether the text reached the disk; `quit(force)` stops editing (force: drop unsaved changes).
 *  `path`: picks the language. `change(text)`: kept as you type (a scratchpad), so nothing is ever unsaved. `leave`:
 *  Esc (without Vim) and Ctrl/Cmd+Enter stop editing. `label`, `hint`: its accessible name and empty placeholder.
 *  `max`: characters it holds at most (an edit past it doesn't happen, rather than being cut off later). */
interface Opts {
  path: string; text: string; vim: boolean; save(): Promise<boolean>; quit(force?: boolean): void
  change?(text: string): void; leave?: boolean; label?: string; hint?: string; max?: number
}

// the same token groups as highlight.js's colors in styles/markdown.css
const colors = HighlightStyle.define([
  { tag: [t.keyword, t.modifier, t.controlKeyword, t.operatorKeyword, t.definitionKeyword, t.typeName], color: 'var(--syn-key)' },
  { tag: [t.string, t.special(t.string), t.regexp, t.inserted], color: 'var(--syn-str)' },
  { tag: [t.number, t.bool, t.null, t.atom, t.attributeName, t.constant(t.variableName)], color: 'var(--syn-num)' },
  { tag: [t.function(t.variableName), t.function(t.propertyName), t.className, t.heading, t.tagName], color: 'var(--syn-fn)' },
  { tag: [t.comment, t.meta], color: 'var(--syn-com)', fontStyle: 'italic' },
  { tag: t.deleted, color: 'var(--del)' },
  { tag: t.strong, fontWeight: '600' },
  { tag: t.emphasis, fontStyle: 'italic' },
])

// what was just yanked, marked for a moment (Neovim's highlight-on-yank): which text Vim took, at a glance
const flash = StateEffect.define<{ from: number; to: number }[]>()
const yankMark = Decoration.mark({ class: 'cm-yanked' })
const yanked = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update: (marks, tr) => {
    for (const e of tr.effects) if (e.is(flash)) return Decoration.set(e.value.filter(r => r.to > r.from).map(r => yankMark.range(r.from, r.to)), true)
    return marks.map(tr.changes)
  },
  provide: f => EditorView.decorations.from(f),
})

// :w, :q, :q! and :wq go to the editor they were typed in. Vim's ex commands are global, so they're defined once.
const owners = new WeakMap<EditorView, { o: Opts; dirty(): boolean }>()
let vimMod: Promise<typeof import('@replit/codemirror-vim')> | undefined
type VimCM = { cm6: EditorView; openNotification(n: Node, o: { bottom?: boolean; duration?: number }): void }
function loadVim() {
  return vimMod ??= import('@replit/codemirror-vim').then(m => {
    const of = (cm: { cm6: EditorView }) => owners.get(cm.cm6)
    // quit after Vim has finished with the command: destroying the editor inside it breaks Vim's own cleanup
    const quit = (o: Opts | undefined, force: boolean) => setTimeout(() => o?.quit(force))
    const refuse = (cm: VimCM) => cm.openNotification(Object.assign(document.createElement('span'),
      { textContent: 'E37: No write since last change (add ! to override)' }), { bottom: true, duration: 5000 })
    m.Vim.defineEx('write', 'w', cm => void of(cm)?.o.save())
    m.Vim.defineEx('quit', 'q', (cm, p) => {
      const ed = of(cm), force = p.argString?.trim() === '!'
      if (ed?.dirty() && !force) refuse(cm as unknown as VimCM)
      else quit(ed?.o, true) // nothing to lose, or told to drop it: no Discard dialog
    })
    m.Vim.defineEx('wq', 'wq', async cm => { const ed = of(cm); if (await ed?.o.save()) quit(ed?.o, true) }) // a failed save stays open
    // the system clipboard is Vim's unnamed register, as with clipboard=unnamedplus: a yank or delete is copied out,
    // and what was copied elsewhere is what p pastes (read when the editor or the page gets focus again). `seen` is
    // the clipboard as last known: only a change to it since (a copy in another app) replaces the register, so a
    // copy out the browser refused never brings the old clipboard back over a yank.
    const regs = m.Vim.getRegisterController(), push = regs.pushText.bind(regs)
    regs.pushText = (name, op, text, linewise, blockwise) => {
      push(name, op, text, linewise, blockwise)
      if (op === 'yank') markYank(m)
      if (!name || name === '"' || name === '+' || name === '*') navigator.clipboard?.writeText(text).then(() => { seen = text }, () => {})
    }
    pull = () => navigator.clipboard?.readText().then(text => {
      if (seen !== undefined && text && text !== seen) regs.unnamedRegister.setText(text, text.endsWith('\n'))
      seen = text // the first read only learns what's there: a clipboard from before the editor opened isn't news
    }, () => {}) // not allowed (Firefox, or turned down): the register keeps Vim's own yanks
    addEventListener('focus', () => { const v = activeView(); if (v && owners.has(v)) pull() })
    // Vim's own messages: "N lines yanked" only from 3 lines up, as Vim's 'report' does (it said "1 lines yanked" for a
    // word), in the muted color; anything else (an unknown command) in the theme's danger color, not a raw red
    const open = m.CodeMirror.prototype.openNotification
    m.CodeMirror.prototype.openNotification = function (n: Node, o: Parameters<typeof open>[1]) {
      const msg = n instanceof HTMLElement && n.classList.contains('cm-vim-message') ? n : null, y = /^(\d+) lines yanked/.exec(msg?.textContent ?? '')
      if (y && +y[1] < 3) return () => {}
      if (msg) msg.style.color = y ? 'var(--muted)' : 'var(--danger)'
      return open.call(this, n, o)
    }
    return m
  })
}
let seen: string | undefined, pull = (): unknown => undefined
/** Flash what a yank took: while Vim's yank runs, the editor's selections are exactly the yanked ranges. */
function markYank(m: typeof import('@replit/codemirror-vim')) {
  const view = activeView(), cm = view && m.getCM(view)
  if (!view || !cm) return
  const ranges = cm.listSelections().map(s => {
    const a = cm.indexFromPos(s.anchor), b = cm.indexFromPos(s.head)
    return { from: Math.min(a, b), to: Math.max(a, b) }
  })
  // after Vim's own update (it's mid-command now), and gone again shortly after
  setTimeout(() => {
    if (!owners.has(view)) return
    view.dispatch({ effects: flash.of(ranges) })
    setTimeout(() => { if (owners.has(view)) view.dispatch({ effects: flash.of([]) }) }, 250)
  })
}
const activeView = () => { const ed = document.activeElement?.closest<HTMLElement>('.cm-editor'); return ed ? EditorView.findFromDOM(ed) : null }
// what fills the Vim slot: Vim itself, or without it the keys that leave a scratchpad (Esc is Vim's own when it's on)
const vimExt = async (on: boolean, o: Opts): Promise<Extension> => on ? (await loadVim()).vim()
  : o.leave ? keymap.of([{ key: 'Escape', run: () => { o.quit(); return true } }]) : []

export async function codeEditor(parent: HTMLElement, o: Opts): Promise<Editor> {
  const lang = LanguageDescription.matchFilename(languages, o.path), vimSlot = new Compartment()
  const view = new EditorView({
    parent,
    doc: o.text,
    extensions: [
      vimSlot.of(await vimExt(o.vim, o)), // before the other keymaps, so Vim sees keys first
      basicSetup,
      Prec.high(keymap.of([ // above basicSetup's own Mod-Enter (insert a blank line)
        { key: 'Mod-s', preventDefault: true, run: () => { void o.save(); return true } },
        ...(o.leave ? [{ key: 'Mod-Enter', run: () => { o.quit(); return true } }] : []),
        indentWithTab,
      ])),
      lang ? await lang.load() : [],
      syntaxHighlighting(colors),
      yanked,
      EditorView.contentAttributes.of({ 'aria-label': o.label ?? `Editing ${o.path}` }),
      o.hint ? placeholder(o.hint) : [],
      o.max ? EditorState.changeFilter.of(tr => tr.newDoc.length <= o.max! || tr.newDoc.length <= tr.startState.doc.length) : [],
      // kept as you type: what's kept is never unsaved, so :q never refuses
      o.change ? EditorView.updateListener.of(u => { if (u.docChanged) { saved = u.state.doc; o.change!(text()) } }) : [],
    ],
  })
  // eq() skips the parts an edit didn't touch, so asking is cheap even for a big file
  let saved: Text = view.state.doc, gone = false, vimAsked = o.vim
  const dirty = () => !view.state.doc.eq(saved)
  // a CRLF file stays CRLF, pasted lines included: the editor works in \n and every line gets \r\n back on the way
  // out (the server only opens files with one kind of line ending, so this gives back exactly what was read)
  const crlf = o.text.includes('\r\n'), text = () => crlf ? view.state.sliceDoc().replace(/\n/g, '\r\n') : view.state.sliceDoc()
  owners.set(view, { o, dirty })
  view.contentDOM.addEventListener('focus', () => { if (vimAsked) pull() })
  return {
    take() { const doc = view.state.doc; return { text: text(), done: () => { saved = doc } } },
    dirty,
    text,
    setText(t) { view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: t } }) },
    goto(line) {
      const at = view.state.doc.line(Math.min(Math.max(1, line), view.state.doc.lines)).from
      view.dispatch({ selection: { anchor: at }, effects: EditorView.scrollIntoView(at, { y: 'center' }) })
      view.focus()
    },
    async setVim(on) {
      vimAsked = on
      const ext = await vimExt(on, o)
      if (!gone && vimAsked === on) view.dispatch({ effects: vimSlot.reconfigure(ext) }) // the newest choice wins
    },
    focus: () => view.focus(),
    destroy: () => { gone = true; owners.delete(view); view.destroy() },
  }
}
