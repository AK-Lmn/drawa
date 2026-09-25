// Canvas items you can reference in a message (type @ in a card, or drop the item onto a card's message box).
// Each item kind registers how it's labelled and what Claude receives for it (text, or text plus an image).
import { items } from './canvas'

export interface Ref { kind: string; label: string; el: HTMLElement }
interface Referable {
  icon: string
  label: (el: HTMLElement) => string
  content: (el: HTMLElement, label: string) => Promise<{ text: string; image?: string }> | { text: string; image?: string }
}
const kinds = new Map<string, Referable>()

/** Let items of this kind be referenced in messages. */
export const referable = (kind: string, r: Referable) => { kinds.set(kind, r) }
export const refIcon = (kind: string) => kinds.get(kind)?.icon ?? '•'

export function refOf(el: HTMLElement): Ref | null {
  const kind = el.dataset.kind, r = kind ? kinds.get(kind) : undefined
  if (!kind || !r) return null
  return { kind, el, label: r.label(el).trim() || kind }
}

export const canvasRefs = () => items().map(refOf).filter((r): r is Ref => !!r)

/** The message content for a prompt plus references: plain text, or text + image blocks when some carry images. */
export async function toContent(prompt: string, refs: Ref[]): Promise<string | object[]> {
  if (!refs.length) return prompt
  const parts: string[] = [], images: string[] = []
  for (const r of refs) {
    const c = await kinds.get(r.kind)!.content(r.el, r.label)
    if (c.image) images.push(c.image)
    parts.push(c.image ? `${c.text}: attached as image ${images.length}.` : c.text)
  }
  const text = `${prompt}\n\nReferenced from my canvas:\n\n${parts.join('\n\n')}`
  if (!images.length) return text
  return [{ type: 'text', text }, ...images.map(data => ({ type: 'image', source: { type: 'base64', media_type: 'image/png', data } }))]
}
