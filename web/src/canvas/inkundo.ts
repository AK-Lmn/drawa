// Undo and redo for the drawing: stacks of what was done to it (strokes added, removed, moved, resized or retyped),
// undone newest first. Persisted to localStorage alongside the canvas layout as JSON so undo and redo survive page reloads.
import { changed } from './canvas'
import { strokes, paint, remove, saveStroke, type Stroke, type Saved } from './ink'
import { dropLinks } from './links'
import { persist } from '../lib/store'
import { uuid } from '../lib/dom'

export interface SerializedChange {
  id: string
  was: { p: number[][]; t?: string }
  now: { p: number[][]; t?: string }
}

export type SerializedOp =
  | { type: 'added'; strokes: Saved[] }
  | { type: 'erase'; strokes: Saved[] }
  | { type: 'changing'; strokes: SerializedChange[] }

interface OpAdd {
  type: 'added'
  strokes: Saved[]
}

interface OpErase {
  type: 'erase'
  strokes: Saved[]
  links?: (() => void)[]
}

interface OpChange {
  type: 'changing'
  strokes: SerializedChange[]
}

type Op = OpAdd | OpErase | OpChange

const MAX = 100 // oldest actions fall off
const ops: Op[] = [] // each puts the drawing back the way it was before one action, returning what redoes it
const redos: Op[] = [] // each re-applies an undone action, returning what undoes it
const push = (op: Op) => {
  ops.push(op)
  if (ops.length > MAX) ops.shift()
  redos.length = 0
  changed()
}

/** New strokes: undoing takes them off again. */
export function added(...list: Stroke[]) {
  if (!list.length) return
  for (const s of list) s.id ??= uuid()
  push({ type: 'added', strokes: list.map(saveStroke) })
}

/** Take strokes off the drawing as one action undo can bring back (the eraser, Delete, Erase all). */
export function erase(...gone: Stroke[]) {
  if (!gone.length) return
  for (const s of gone) s.id ??= uuid()
  const links = gone.map(dropLinks) // their arrows go now and come back with them
  push({ type: 'erase', strokes: gone.map(saveStroke), links })
  remove(...gone)
}

/** Call before strokes change in place (moved, resized, retyped); call what it returns once they have, to record it. */
export function changing(list: Stroke[]) {
  for (const s of list) s.id ??= uuid()
  const was = list.map(s => ({ p: s.p.map(q => [...q]), t: s.t }))
  return () => {
    const now = list.map(s => ({ p: s.p.map(q => [...q]), t: s.t }))
    const changes: SerializedChange[] = list.map((s, i) => ({
      id: s.id!,
      was: was[i],
      now: now[i],
    }))
    push({ type: 'changing', strokes: changes })
  }
}

export function undo() {
  const op = ops.pop()
  if (!op) return
  const redoOp = applyUndo(op)
  if (redoOp) {
    redos.push(redoOp)
    if (redos.length > MAX) redos.shift()
  }
  changed()
}

export function redo() {
  const op = redos.pop()
  if (!op) return
  const undoOp = applyRedo(op)
  if (undoOp) {
    ops.push(undoOp)
    if (ops.length > MAX) ops.shift()
  }
  changed()
}

function applyUndo(op: Op): Op | undefined {
  if (op.type === 'added') {
    const ids = new Set(op.strokes.map(s => s.id).filter(Boolean))
    const live = strokes.filter(s => (s.id && ids.has(s.id)) || (op.strokes as unknown as Stroke[]).includes(s))
    remove(...live)
    return { type: 'added', strokes: op.strokes }
  }
  if (op.type === 'erase') {
    restore(op.strokes)
    op.links?.forEach(back => back())
    return { type: 'erase', strokes: op.strokes }
  }
  if (op.type === 'changing') {
    return applyChange(op)
  }
}

function applyRedo(op: Op): Op | undefined {
  if (op.type === 'added') {
    restore(op.strokes)
    return { type: 'added', strokes: op.strokes }
  }
  if (op.type === 'erase') {
    const ids = new Set(op.strokes.map(s => s.id).filter(Boolean))
    const live = strokes.filter(s => (s.id && ids.has(s.id)) || (op.strokes as unknown as Stroke[]).includes(s))
    const relinks = live.map(dropLinks)
    remove(...live)
    return { type: 'erase', strokes: op.strokes, links: relinks }
  }
  if (op.type === 'changing') {
    return applyChange(op)
  }
}

function applyChange(op: OpChange): OpChange {
  for (const c of op.strokes) {
    const s = strokes.find(x => x.id === c.id)
    if (s) {
      s.p = c.was.p.map(q => [...q])
      s.t = c.was.t
      paint(s)
    }
  }
  return {
    type: 'changing',
    strokes: op.strokes.map(c => ({ id: c.id, was: c.now, now: c.was })),
  }
}

function restore(list: Saved[]): Stroke[] {
  const restored: Stroke[] = []
  for (const s of list) {
    if (s.id && strokes.some(x => x.id === s.id)) continue
    const host = s.h ? document.querySelector<HTMLElement>(`[data-ink="${CSS.escape(s.h)}"]`) ?? undefined : undefined
    if (s.h && (!host || !host.isConnected)) continue
    const st: Stroke = {
      ...s,
      p: s.p.map(q => [...q]),
      host,
      el: undefined,
      sel: false,
    }
    strokes.push(st)
    paint(st)
    restored.push(st)
  }
  return restored
}

const serializeOp = (op: Op): SerializedOp => {
  if (op.type === 'changing') return { type: 'changing', strokes: op.strokes }
  return { type: op.type, strokes: op.strokes }
}

persist('inkundo',
  () => ({
    ops: ops.map(serializeOp),
    redos: redos.map(serializeOp),
  }),
  (val: { ops?: SerializedOp[]; redos?: SerializedOp[] }) => {
    ops.length = 0
    redos.length = 0
    if (Array.isArray(val?.ops)) {
      for (const o of val.ops) {
        if (o && (o.type === 'added' || o.type === 'erase' || o.type === 'changing') && Array.isArray(o.strokes)) {
          ops.push(o)
        }
      }
    }
    if (Array.isArray(val?.redos)) {
      for (const o of val.redos) {
        if (o && (o.type === 'added' || o.type === 'erase' || o.type === 'changing') && Array.isArray(o.strokes)) {
          redos.push(o)
        }
      }
    }
  },
  3
)
