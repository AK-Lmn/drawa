// Images you paste or drop into a message: read, scaled down to what Claude uses, shown as thumbnails.
import { make } from '../lib/dom'

export interface Pasted { type: string; data: string; url: string } // media type, base64, displayable URL

const TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] // what the API accepts
const MAX_EDGE = 1568 // Claude downsizes anything larger anyway; sending less keeps requests small

/** Read image files into sendable images. Other types, or ones that fail to decode, are skipped. */
export async function readImages(files: File[]): Promise<Pasted[]> {
  const out: Pasted[] = []
  for (const f of files) {
    try { out.push(await readOne(f)) } catch (e) { console.warn('image skipped:', f.name, e) }
  }
  return out
}

async function readOne(f: File): Promise<Pasted> {
  const bmp = await createImageBitmap(f)
  const k = Math.min(1, MAX_EDGE / Math.max(bmp.width, bmp.height))
  // small enough and a supported type: send the file as it is (keeps GIF animation, PNG exactness)
  if (k === 1 && TYPES.includes(f.type) && f.size < 3_500_000) {
    const data = await base64(f)
    return { type: f.type, data, url: URL.createObjectURL(f) }
  }
  const c = document.createElement('canvas')
  c.width = Math.round(bmp.width * k)
  c.height = Math.round(bmp.height * k)
  c.getContext('2d')!.drawImage(bmp, 0, 0, c.width, c.height)
  const type = f.type === 'image/png' ? 'image/png' : 'image/jpeg' // screenshots stay crisp, photos get smaller
  const blob = await new Promise<Blob>((res, rej) => c.toBlob(b => (b ? res(b) : rej(new Error('encode failed'))), type, 0.9))
  return { type, data: await base64(blob), url: URL.createObjectURL(blob) }
}

const base64 = (b: Blob) => new Promise<string>((res, rej) => {
  const r = new FileReader()
  r.onload = () => res(String(r.result).split(',')[1])
  r.onerror = () => rej(r.error)
  r.readAsDataURL(b)
})

export const imageBlock = (img: Pasted) => ({ type: 'image', source: { type: 'base64', media_type: img.type, data: img.data } })

/** A thumbnail; click to see it larger. With `remove`, an × to take it off the message. */
export function thumb(img: Pasted, remove?: () => void) {
  const t = make('span', 'thumb'), pic = make('img')
  pic.src = img.url
  pic.alt = 'Attached image'
  pic.onclick = () => t.classList.toggle('big')
  t.append(pic)
  if (remove) {
    const x = make('button', 'x', '×')
    x.type = 'button'
    x.title = 'Remove image'
    x.setAttribute('aria-label', 'Remove image')
    x.onclick = remove
    t.append(x)
  }
  return t
}
