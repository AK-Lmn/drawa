// Binary things too big for localStorage (images on the canvas): IndexedDB, this browser only.
let db: Promise<IDBDatabase> | undefined
const open = () => (db ??= new Promise((res, rej) => {
  const r = indexedDB.open('claude-ui', 1)
  r.onupgradeneeded = () => r.result.createObjectStore('blobs')
  r.onsuccess = () => res(r.result)
  r.onerror = () => rej(r.error)
}))

async function run<T>(mode: IDBTransactionMode, f: (s: IDBObjectStore) => IDBRequest): Promise<T> {
  const s = (await open()).transaction('blobs', mode).objectStore('blobs')
  return new Promise((res, rej) => {
    const r = f(s)
    r.onsuccess = () => res(r.result as T)
    r.onerror = () => rej(r.error)
  })
}

export const getBlob = (key: string) => run<Blob | undefined>('readonly', s => s.get(key))
export const putBlob = (key: string, b: Blob) => run<void>('readwrite', s => s.put(b, key))
export const dropBlob = (key: string) => run<void>('readwrite', s => s.delete(key))

/** A Blob's bytes as base64 (what Claude's image blocks carry). */
export const base64 = (b: Blob) => new Promise<string>((res, rej) => {
  const r = new FileReader()
  r.onload = () => res(String(r.result).split(',')[1])
  r.onerror = () => rej(r.error)
  r.readAsDataURL(b)
})
/** An image content block for a Claude message. */
export const imageBlock = (type: string, data: string) => ({ type: 'image', source: { type: 'base64', media_type: type, data } })
