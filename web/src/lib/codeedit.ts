// A code editor (CodeMirror 6), with Vim motions when asked. Loaded with a dynamic import() on first edit: nothing
// here is in the page until someone edits a file. Colors come from the theme's --syn-* tokens (styles/items.css
// styles the rest), so it follows light, dark and every scheme without redrawing.
import { EditorView, basicSetup } from 'codemirror'
import { Compartment, EditorState, type Extension, type Text } from '@codemirror/state'
import { keymap } from '@codemirror/view'
import { indentWithTab } from '@codemirror/commands'
import { HighlightStyle, LanguageDescription, syntaxHighlighting } from '@codemirror/language'
import { languages } from '@codemirror/language-data'
import { tags as t } from '@lezer/highlight'

/** `take()`: the text to save, and `done()` to call once it's saved; `dirty()`: changed since the last save;
 *  `text()`: what the editor holds now. */
export interface Editor {
  take(): { text: string; done(): void }; dirty(): boolean; text(): string
  setVim(on: boolean): Promise<void>; focus(): void; destroy(): void
}
/** `save()` answers whether the text reached the disk; `quit(force)` stops editing (force: drop unsaved changes). */
interface Opts { path: string; text: string; vim: boolean; save(): Promise<boolean>; quit(force?: boolean): void }

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
    return m
  })
}
const vimExt = async (on: boolean): Promise<Extension> => on ? (await loadVim()).vim() : []

export async function codeEditor(parent: HTMLElement, o: Opts): Promise<Editor> {
  const lang = LanguageDescription.matchFilename(languages, o.path), vimSlot = new Compartment()
  const view = new EditorView({
    parent,
    doc: o.text,
    extensions: [
      vimSlot.of(await vimExt(o.vim)), // before the other keymaps, so Vim sees keys first
      // a CRLF file stays CRLF: CodeMirror would otherwise save every line with \n (files mixing endings, or
      // with a lone \r, aren't opened here: the server says so)
      o.text.includes('\r\n') ? EditorState.lineSeparator.of('\r\n') : [],
      basicSetup,
      keymap.of([{ key: 'Mod-s', preventDefault: true, run: () => { void o.save(); return true } }, indentWithTab]),
      lang ? await lang.load() : [],
      syntaxHighlighting(colors),
      EditorView.contentAttributes.of({ 'aria-label': `Editing ${o.path}` }),
    ],
  })
  // eq() skips the parts an edit didn't touch, so asking is cheap even for a big file
  let saved: Text = view.state.doc, gone = false, vimAsked = o.vim
  const dirty = () => !view.state.doc.eq(saved)
  owners.set(view, { o, dirty })
  return {
    take() { const doc = view.state.doc; return { text: view.state.sliceDoc(), done: () => { saved = doc } } },
    dirty,
    text: () => view.state.sliceDoc(),
    async setVim(on) {
      vimAsked = on
      const ext = await vimExt(on)
      if (!gone && vimAsked === on) view.dispatch({ effects: vimSlot.reconfigure(ext) }) // the newest choice wins
    },
    focus: () => view.focus(),
    destroy: () => { gone = true; view.destroy() },
  }
}
