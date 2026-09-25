// The canvas survives a reload (per project folder, this browser only). Each feature registers the slice it owns;
// save() gathers them all into one localStorage entry, restore() hands each slice back to its owner.
import { project } from './dom'

interface Part { save: () => unknown; load?: (value: any, all: Record<string, any>) => unknown; phase: number }
const parts = new Map<string, Part>()

/** Own a key of the saved layout. `phase` orders restoring: 0 settings, 1 canvas items, 2 things that attach to items (ink). */
export function persist<T>(key: string, save: () => T, load?: (value: T, all: Record<string, any>) => unknown, phase = 1) {
  parts.set(key, { save, load, phase })
}

const KEY = () => 'claude-ui:canvas:' + project.root

export function save() {
  try { localStorage.setItem(KEY(), JSON.stringify(Object.fromEntries([...parts].map(([k, p]) => [k, p.save()])))) } catch {}
}
let timer = 0
export const saveSoon = () => { clearTimeout(timer); timer = setTimeout(save, 400) }

/** Load every slice that was saved, phase by phase (a slice's loader may be async: the next one waits for it). */
export async function restore() {
  let all: Record<string, any> = {}
  try { all = JSON.parse(localStorage.getItem(KEY()) ?? '{}') ?? {} } catch {}
  for (const [key, p] of [...parts].sort((a, b) => a[1].phase - b[1].phase)) {
    if (all[key] === undefined || !p.load) continue
    try { await p.load(all[key], all) } catch (e) { console.error(`restoring ${key}:`, e) }
  }
  return all
}
