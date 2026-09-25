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
  callouts(el)
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

/** GitHub's alerts: a quote starting with [!NOTE], [!TIP], [!IMPORTANT], [!WARNING] or [!CAUTION] becomes a labeled box. */
function callouts(el: HTMLElement) {
  for (const q of el.querySelectorAll<HTMLElement>('blockquote:not([data-callout])')) {
    const p = q.firstElementChild, m = p?.tagName === 'P' ? /^\s*\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*/i.exec(p.textContent ?? '') : null
    const t = p?.firstChild // the marker, as plain text leading the first line (a bold "[!NOTE]" isn't one)
    if (!m || !p || t?.nodeType !== 3 || !/^\s*\[!/.test(t.textContent ?? '')) continue
    const kind = m[1].toLowerCase()
    q.dataset.callout = kind
    t.textContent = (t.textContent ?? '').replace(/^\s*\[![a-z]+\]\s*/i, '') // it can be followed by more text on the line
    if (!p.textContent?.trim()) p.remove()
    q.prepend(make('p', 'callout-t', kind[0].toUpperCase() + kind.slice(1)))
  }
}

/** Enhance everything under `root` that was deferred while off-page. */
export function enhanceMarked(root: HTMLElement) {
  for (const el of root.querySelectorAll<HTMLElement>('[data-enhance]')) { delete el.dataset.enhance; enhance(el) }
}
