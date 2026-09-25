// Markdown -> sanitized HTML, then code highlighting and diagrams.
import { marked } from 'marked'
import DOMPurify from 'dompurify'
import type { HLJSApi } from 'highlight.js'
import { renderDiagrams } from '../items/diagram'
import { copyButton, make, ICON } from './dom'

export const md = (text: string) => DOMPurify.sanitize(marked.parse(text, { async: false }))

// highlight.js is big: loaded on the first code block, not at startup
let hl: Promise<HLJSApi> | undefined
export const highlighter = () => (hl ??= import('highlight.js/lib/common').then(m => m.default))

/** Run after inserting md() output: diagrams first (they replace their code blocks), then highlight the rest.
 *  Not in the page yet (older messages built off-page)? Marked, and done when it's shown (see enhanceMarked). */
export function enhance(el: HTMLElement) {
  if (!el.isConnected) { el.dataset.enhance = ''; return } // diagrams can't be measured off-page
  renderDiagrams(el)
  // code blocks get a copy button (in a wrapper, so it stays put when the code scrolls sideways)
  for (const pre of el.querySelectorAll<HTMLElement>('pre:has(> code)')) {
    if (pre.parentElement?.classList.contains('codeblock')) continue
    const box = document.createElement('div')
    box.className = 'codeblock'
    pre.replaceWith(box)
    const tools = make('div', 'cbtools'), pull = make('button', 'icon pullbtn')
    pull.title = 'Drag onto the canvas (or click to pin it beside this window)'
    pull.setAttribute('aria-label', 'Pin this code to the canvas')
    pull.innerHTML = ICON.grip
    tools.append(pull, copyButton(() => pre.textContent ?? '', 'Copy code'))
    box.append(pre, tools)
  }
  const codes = el.querySelectorAll<HTMLElement>('pre code')
  if (codes.length) highlighter().then(h => codes.forEach(c => c.isConnected && h.highlightElement(c)))
}

/** Enhance everything under `root` that was deferred while off-page. */
export function enhanceMarked(root: HTMLElement) {
  for (const el of root.querySelectorAll<HTMLElement>('[data-enhance]')) { delete el.dataset.enhance; enhance(el) }
}
