// Undo and redo for the drawing: short stacks of what was done to it (strokes added, removed, moved, resized or retyped),
// undone newest first. Only what was done since the page loaded: after a reload there's nothing to undo, rather
// than Ctrl+Z taking saved strokes off one by one.
import { changed } from '../core/view';
import { dropLinks } from '../graph/links';
import { paint, remove, type Stroke, strokes } from './stroke';

const MAX = 200; // oldest actions fall off
type Action = () => Action;
const ops: Action[] = []; // each puts the drawing back the way it was before one action, returning what redoes it
const redos: Action[] = []; // each re-applies an undone action, returning what undoes it

/** Add an undo step, dropping the oldest past MAX and clearing redo history. */
const pushUndo = (op: Action) => {
  ops.push(op);
  if (ops.length > MAX) ops.shift();
  redos.length = 0;
};

/** Undo/redo for newly added strokes. */
function undoAdded(list: Stroke[]): Action {
  return () => {
    remove(...list);
    return () => {
      restore(list);
      return undoAdded(list);
    };
  };
}

/** New strokes: undoing takes them off again. */
export const recordAdded = (...list: Stroke[]) => pushUndo(undoAdded(list));

/** Undo/redo for erased strokes, dropping arrows when erased and restoring them when brought back. */
function undoErase(gone: Stroke[], links: (() => void)[]): Action {
  return () => {
    restore(gone);
    links.forEach(back => back());
    return () => {
      const relinks = gone.map(dropLinks);
      remove(...gone);
      return undoErase(gone, relinks);
    };
  };
}

/** Take strokes off the drawing as one action undo can bring back (the eraser, Delete, Erase all). */
export function erase(...gone: Stroke[]) {
  if (!gone.length) return;
  const links = gone.map(dropLinks); // their arrows go now and come back with them
  pushUndo(undoErase(gone, links));
  remove(...gone);
}

/** Undo/redo for in-place modifications (moved, resized, retyped). */
function undoChange(
  list: Stroke[],
  was: { p: number[][]; t?: string }[],
  now: { p: number[][]; t?: string }[],
): Action {
  return () => {
    list.forEach((s, i) => {
      Object.assign(s, was[i]);
      paint(s);
    });
    return undoChange(list, now, was);
  };
}

/** Call before strokes change in place (moved, resized, retyped); call what it returns once they have, to record it. */
export function changing(list: Stroke[]) {
  const was = list.map(s => ({ p: s.p.map(q => [...q]), t: s.t }));
  return () => {
    const now = list.map(s => ({ p: s.p.map(q => [...q]), t: s.t }));
    pushUndo(undoChange(list, was, now));
  };
}

/** Undo the last drawing action (Ctrl+Z in Draw mode). */
export function undo() {
  const op = ops.pop();
  if (!op) return;
  const redoOp = op();
  if (redoOp) {
    redos.push(redoOp);
    if (redos.length > MAX) redos.shift();
  }
  changed();
}

/** Redo the last undone drawing action (Ctrl+Shift+Z or Ctrl+Y in Draw mode). */
export function redo() {
  const op = redos.pop();
  if (!op) return;
  const undoOp = op();
  if (undoOp) {
    ops.push(undoOp);
    if (ops.length > MAX) ops.shift();
  }
  changed();
}

/** Put strokes back on the drawing, unless their window has closed since. */
function restore(list: Stroke[]) {
  for (const s of list) {
    if (s.host && !s.host.isConnected) continue; // its window was closed since: nowhere to put it back
    s.el = undefined; // painted afresh
    s.sel = false;
    strokes.push(s);
    paint(s);
  }
}
