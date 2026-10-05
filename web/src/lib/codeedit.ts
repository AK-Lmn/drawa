// A code editor (CodeMirror 6), with Vim motions when asked. Loaded with a dynamic import() on first edit: nothing
// here is in the page until someone edits a file. Colors come from the theme's --syn-* tokens (styles/items.css
// styles the rest), so it follows light, dark and every scheme without redrawing.
import { EditorView, basicSetup } from 'codemirror'
import { Compartment, type Extension } from '@codemirror/state'
import { keymap } from '@codemirror/view'
import { indentWithTab } from '@codemirror/commands'
import { HighlightStyle, LanguageDescription, syntaxHighlighting } from '@codemirror/language'
import { languages } from '@codemirror/language-data'
import { tags as t } from '@lezer/highlight'

export interface Editor { text(): string; setVim(on: boolean): Promise<void>; focus(): void; destroy(): void }
interface Opts { path: string; text: string; vim: boolean; save(): Promise<void>; quit(): void; change(): void }

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

// :w, :q and :wq go to the editor they were typed in. Vim's ex commands are global, so they're defined once.
const owners = new WeakMap<EditorView, Opts>()
let vimMod: Promise<typeof import('@replit/codemirror-vim')> | undefined
function loadVim() {
  return vimMod ??= import('@replit/codemirror-vim').then(m => {
    const of = (cm: { cm6: EditorView }) => owners.get(cm.cm6)
    m.Vim.defineEx('write', 'w', cm => of(cm)?.save())
    m.Vim.defineEx('quit', 'q', cm => of(cm)?.quit())
    m.Vim.defineEx('wq', 'wq', async cm => { await of(cm)?.save(); of(cm)?.quit() })
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
      basicSetup,
      keymap.of([{ key: 'Mod-s', preventDefault: true, run: () => { o.save(); return true } }, indentWithTab]),
      lang ? await lang.load() : [],
      syntaxHighlighting(colors),
      EditorView.updateListener.of(u => { if (u.docChanged) o.change() }),
    ],
  })
  owners.set(view, o)
  return {
    text: () => view.state.doc.toString(),
    setVim: async on => view.dispatch({ effects: vimSlot.reconfigure(await vimExt(on)) }),
    focus: () => view.focus(),
    destroy: () => view.destroy(),
  }
}
