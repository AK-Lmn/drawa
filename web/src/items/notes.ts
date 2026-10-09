// Text on the canvas: double-click empty space (or press T) and type. Click a note to edit it; empty notes vanish.

import { draggable, resizable } from '../canvas/core/drag';
import { addItem, bringToFront, items, place, rect } from '../canvas/core/items';
import { referable } from '../canvas/core/refs';
import { creatable } from '../canvas/core/tools';
import { changed, stage, toWorld, viewCenter } from '../canvas/core/view';
import { removeButton } from '../canvas/core/window';
import { forget } from '../canvas/graph/graph';
import { make, uuid } from '../lib/dom';
import { each, persist } from '../lib/store';

interface Note {
  id?: string;
  text?: string;
  x: number;
  y: number;
  w?: number;
  edit?: boolean;
}

/** A text note on the canvas, edited in place; an empty one goes away when you leave it. */
export function makeNote(opts: Note) {
  const el = make('div', 'nnode'),
    text = make('div', 'ntext');
  el.dataset.id = opts.id ?? uuid();
  text.textContent = opts.text ?? '';
  text.setAttribute('role', 'textbox');
  text.setAttribute('aria-label', 'Canvas note');
  const del = removeButton('Delete note', undefined, 'ndel');
  el.append(text, del);
  addItem(el, 'note');
  place(el, opts.x, opts.y);
  if (opts.w) el.style.width = `${opts.w}px`;
  bringToFront(el);

  /** Start editing the note, with the caret at the end. */
  const edit = () => {
    text.contentEditable = 'plaintext-only';
    el.dataset.state = 'editing';
    text.focus();
    const range = document.createRange(); // caret at the end
    range.selectNodeContents(text);
    range.collapse(false);
    getSelection()?.removeAllRanges();
    getSelection()?.addRange(range);
  };
  /** Stop editing; a note left empty is removed. */
  const done = () => {
    text.contentEditable = 'false';
    delete el.dataset.state;
    if (!text.textContent?.trim()) {
      forget(el);
      el.remove();
    }
    changed();
  };
  text.addEventListener('blur', done);
  text.addEventListener('keydown', e => {
    e.stopPropagation(); // typing isn't a canvas shortcut
    if (e.key === 'Escape' || (e.key === 'Enter' && (e.ctrlKey || e.metaKey))) {
      e.preventDefault();
      text.blur();
    }
  });
  text.addEventListener('input', () => changed());
  draggable(el, el, changed, () => {
    if (el.dataset.state !== 'editing') edit();
  });
  resizable(el, 80, 0, changed, true); // drag the corner to set the width; text wraps to fit
  if (opts.edit) edit();
  return el;
}

/** A note's text. */
const noteText = (el: HTMLElement) => el.querySelector('.ntext')?.textContent ?? '';

persist(
  'notes',
  () =>
    items('note')
      .filter(n => noteText(n).trim())
      .map(n => {
        const r = rect(n);
        return { id: n.dataset.id!, text: noteText(n), x: r.x, y: r.y, w: n.style.width ? r.w : undefined };
      }),
  (list: Note[]) => each(list, makeNote),
);
creatable('note', {
  size: a => ({ w: Math.min(360, Math.max(120, String(a.text).length * 8)), h: 60 }),
  create: (a, r) => makeNote({ x: r.x, y: r.y, text: String(a.text), w: String(a.text).length > 45 ? 360 : undefined }),
  update: (el, a) => {
    el.querySelector('.ntext')!.textContent = String(a.text);
  },
});
referable('note', {
  icon: '¶',
  label: el => noteText(el).slice(0, 40),
  content: el => ({ text: `Note from my canvas:\n${noteText(el).trim()}` }),
});

/** A new note at the view's center (T key). */
export const noteHere = () => {
  const c = viewCenter();
  makeNote({ x: c.x - 40, y: c.y - 12, edit: true });
};

// Double-click empty canvas: a note right where you clicked.
stage.addEventListener('dblclick', e => {
  const t = e.target as Element;
  if (t !== stage && !t.matches('#world, #edges, #inkworld')) return;
  const w = toWorld(e.clientX, e.clientY);
  makeNote({ x: w.x, y: w.y - 12, edit: true });
});
