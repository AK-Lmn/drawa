// Up/Down in the message box: step through the messages (and ! commands) sent in this session, like a shell.
// ponytail: the history is what the page shows (the last 300 entries until "Show earlier" is clicked);
// read the transcript instead if that turns out too short.

/** What you typed, oldest first, read back from the card's log (bubble text is what the card shows, not always what you typed). */
function sent(log: ParentNode): string[] {
  const out: string[] = []
  for (const b of log.querySelectorAll(':scope > .me, :scope > .shell')) {
    const t = b.classList.contains('shell') ? typed(b) : said(b)
    if (t && t !== out.at(-1)) out.push(t)
  }
  return out
}
const typed = (b: Element) => { const c = b.querySelector('.sh-cmd')?.textContent?.trim(); return c ? '!' + c : '' }
function said(b: Element) {
  let t = b.firstChild?.nodeType === Node.TEXT_NODE ? b.firstChild.textContent! : ''
  t = t.split('\n\nReferenced from my canvas:\n\n')[0].trim() // a reloaded message carries its references' contents (refs.ts toContent)
  if (/^To the ".+?" agent: /.test(t)) return '' // a message to a sub-agent (items/agent.ts): not for this box
  if (b.querySelector('.refs') && /^Take a look at th(is|ese)\.$/.test(t)) return '' // stand-in text for attachments alone
  return t
}

/** Up/Down history for a message box. The returned keydown step says whether it handled the key.
 *  Up works with the caret at the very start, Down at the very end: anywhere else the browser moves the caret, so
 *  long messages (wrapped or multi-line) are walked row by row first. */
export function recall(ta: HTMLTextAreaElement, log: ParentNode) {
  let at: number | null = null, list: string[] = [], draft = '' // at: position in list while browsing
  return (e: KeyboardEvent) => {
    const up = e.key === 'ArrowUp'
    if (!up && e.key !== 'ArrowDown') return false
    if (e.shiftKey || e.altKey || e.ctrlKey || e.metaKey || e.isComposing || ta.selectionStart !== ta.selectionEnd) return false
    if (ta.selectionStart !== (up ? 0 : ta.value.length)) return false
    if (at !== null && ta.value !== list[at]) at = null // edited, sent or replaced since: it's your draft now
    if (at === null) {
      if (!up) return false
      list = sent(log)
      if (!list.length) return false
      draft = ta.value
      at = list.length
    }
    const next = at + (up ? -1 : 1)
    if (next < 0) return true // already at the oldest
    const text = next === list.length ? draft : list[next]
    at = next === list.length ? null : next // past the newest: back to your draft
    ta.value = text
    const end = up ? 0 : text.length // caret where the next press in the same direction steps again
    ta.setSelectionRange(end, end)
    return true
  }
}
