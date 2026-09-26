// Up/Down in the message box: step through the messages sent in this session, like a shell.
// ponytail: the history is the `.me` bubbles in the page (the last 300 entries until "Show earlier" is clicked);
// read the transcript instead if that turns out too short.

/** The texts you sent, oldest first: each bubble's first text node (chips and thumbnails come after it). */
export function sent(log: ParentNode): string[] {
  const out: string[] = []
  for (const b of log.querySelectorAll('.me')) {
    const t = b.firstChild?.nodeType === Node.TEXT_NODE ? b.firstChild.textContent!.trim() : ''
    if (t && t !== out.at(-1)) out.push(t)
  }
  return out
}

export const onFirstLine = (v: string, caret: number) => !v.slice(0, caret).includes('\n')
export const onLastLine = (v: string, caret: number) => !v.slice(caret).includes('\n')

/** Up/Down history for a message box. The returned keydown step says whether it handled the key. */
export function recall(ta: HTMLTextAreaElement, log: ParentNode) {
  let at: number | null = null, list: string[] = [], draft = '' // at: position in list while browsing
  const stop = () => { at = null }
  ta.addEventListener('input', stop) // typing makes the recalled text your own draft
  ta.form?.addEventListener('submit', stop)
  return (e: KeyboardEvent) => {
    const up = e.key === 'ArrowUp'
    if (!up && e.key !== 'ArrowDown') return false
    if (e.shiftKey || e.altKey || e.ctrlKey || e.metaKey || e.isComposing || ta.selectionStart !== ta.selectionEnd) return false
    if (!(up ? onFirstLine : onLastLine)(ta.value, ta.selectionStart)) return false // multi-line: move the caret as usual
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
    ta.setSelectionRange(text.length, text.length)
    return true
  }
}
