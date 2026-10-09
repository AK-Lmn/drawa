// Go to definition from a diff: a name in a diff's text is underlined under the pointer, and a click (or the name
// typed in the diff's header box) asks where it's defined (lib/symbols.ts). One definition shows its source around
// the line; several are listed to pick from; none opens nothing (a local variable is the usual case, not an error).
// Open file puts the file in a window on the canvas, at the line. Rows stay plain text: the name under the pointer
// is found from the caret position there, and underlined with the CSS Custom Highlight API.

import { openFileAt, stickFileAt } from '../canvas/core/find';
import { api, q } from '../lib/api';
import { button, ICON, iconButton, keepOnScreen, make, perFrame, revealIn, toast } from '../lib/dom';
import { type CodeSymbol, definitions, symbolsOn } from '../lib/symbols';
import { sourceView } from './files';

const box = document.body.appendChild(make('div', 'defs float'));
box.hidden = true;
box.setAttribute('role', 'dialog');
const AROUND = 4; // lines above the definition; the snippet shows 16 in all

const NAME = /[\w$]/;
/** The identifier (a name, not a number) at a screen point inside `within`, with its range; null when there's none. */
function nameAt(x: number, y: number, within: Element) {
  const p = document.caretPositionFromPoint?.(x, y),
    r = p ? null : document.caretRangeFromPoint?.(x, y);
  const node = p?.offsetNode ?? r?.startContainer,
    off = p?.offset ?? r?.startOffset ?? 0;
  if (!node || node.nodeType !== Node.TEXT_NODE || !within.contains(node)) return null;
  const t = node.textContent ?? '';
  let a = off,
    b = off;
  while (a > 0 && NAME.test(t[a - 1])) a--;
  while (b < t.length && NAME.test(t[b])) b++;
  if (!/^[A-Za-z_$]/.test(t.slice(a, b))) return null;
  const range = new Range();
  range.setStart(node, a);
  range.setEnd(node, b);
  // the caret snaps to the nearest character: past the end of a line, or between words, isn't on the name
  const rc = range.getBoundingClientRect();
  return x >= rc.left && x <= rc.right && y >= rc.top && y <= rc.bottom ? { name: t.slice(a, b), range } : null;
}

const ROWS = '.diff > :is(.add, .del, .eq)'; // code rows: not hunk headers, folds or a pull request's comments
const hl = typeof Highlight === 'function' ? new Highlight() : null;
if (hl) CSS.highlights.set('def-name', hl);
let under: HTMLElement | null = null;
/** Underline the name under the pointer in a diff (once a frame); `t` is null where names lead nowhere. */
const hover = perFrame((t: Element | null, x: number, y: number) => {
  const row = t?.closest<HTMLElement>(ROWS),
    at = row ? nameAt(x, y, row) : null;
  hl?.clear();
  under?.classList.remove('def-on');
  under = at ? row! : null;
  if (!at) return;
  hl?.add(at.range);
  row!.classList.add('def-on');
});

/** What a click on a name in a diff does with it: where it's defined (showDefs), or where it's used (showRefs).
 *  `row` is the diff row clicked. */
type Look = (name: string, x: number, y: number, row: Element) => void;
/** Where a clicked name is defined. */
const toDefs: Look = (name, x, y) => showDefs(name, x, y);
/** Make the names in diffs inside `el` lead somewhere: hovering underlines one, clicking runs `look` on it (where
 *  it's defined, or with showRefs where it's used). Such a click is `defaultPrevented`, so a diff's own click (a pull
 *  request's line comment) can skip it. */
export function definable(el: HTMLElement, look: Look = toDefs) {
  /** Do names lead anywhere now? Where it's used is a text search: no ctags needed. */
  const on = () => look !== toDefs || symbolsOn();
  el.addEventListener('pointermove', e => hover(on() ? (e.target as Element) : null, e.clientX, e.clientY));
  el.addEventListener('pointerleave', () => hover(null, 0, 0));
  el.addEventListener(
    'click',
    e => {
      const row = (e.target as Element).closest(ROWS);
      if (!row || !on() || !getSelection()?.isCollapsed) return; // selecting text isn't asking
      const at = nameAt(e.clientX, e.clientY, row);
      if (!at) return;
      e.preventDefault();
      look(at.name, e.clientX, e.clientY + 14, row);
    },
    true,
  ); // capturing: before the diff's own click handlers
}

/** The header box: type a name, Enter shows where it's defined. */
export function defField() {
  const f = make('input', 'def-q');
  f.placeholder = 'Go to definition';
  f.setAttribute('aria-label', 'Go to the definition of a name');
  f.spellcheck = false;
  f.oninput = () => f.removeAttribute('aria-invalid');
  f.onclick = e => e.stopPropagation(); // the header folds the diff on click
  f.onkeydown = e => {
    e.stopPropagation(); // typing here isn't a shortcut, and Enter or Space here isn't the header's fold
    if (e.key !== 'Enter' || e.isComposing || !f.value.trim()) return;
    e.preventDefault();
    const r = f.getBoundingClientRect();
    showDefs(f.value.trim(), r.left, r.bottom + 6, f);
  };
  return f;
}

let asked = 0,
  from: HTMLElement | null = null,
  x0 = 0,
  y0 = 0;
/** Look `name` up and show where it's defined near (x, y). Nothing opens when it isn't a known definition; `field`
 *  (where it was typed) says so with its border instead. */
export async function showDefs(name: string, x: number, y: number, field?: HTMLElement) {
  const n = ++asked,
    defs = await definitions(name);
  if (n !== asked) return;
  if (!defs.length) {
    closeDefs();
    field?.setAttribute('aria-invalid', 'true');
    return;
  }
  from = field ?? null;
  x0 = x;
  y0 = y;
  if (defs.length === 1) showDefinition(name, defs[0]);
  else pickDefinition(name, defs);
}

/** One place a name is used: its file, line and that line's text. */
type Ref = { path: string; line: number; text: string };
/** Where `name` is used, listed near (x, y): a whole-word search (comments and strings too) of the repo the clicked
 *  diff `row` is from (its data-repo: the project's own, a nested repo or a worktree). Picking one opens its file at
 *  the line in a small window stuck to the screen beside the list, which stays open to step through the rest. */
export async function showRefs(name: string, x: number, y: number, row?: Element) {
  const n = ++asked;
  from = null;
  x0 = x;
  y0 = y;
  const repo = row?.closest<HTMLElement>('.diff')?.dataset.repo ?? '';
  showBox(defsHeader(name, 'Searching…'));
  let got: { refs: Ref[]; more: boolean; outside?: boolean };
  try {
    got = await api(`refs?name=${q(name)}&repo=${q(repo)}`);
  } catch (e) {
    if (n === asked) showBox(defsHeader(name, (e as Error).message)); // couldn't search: not the same as no uses
    return;
  }
  if (n !== asked) return;
  const { refs, more, outside } = got;
  if (!refs.length) {
    showBox(defsHeader(name, repo ? `no uses found in ${repo}` : 'no uses found in the project'));
    return;
  }
  const at = new RegExp(`(?<![\\w$])${name.replace(/\$/g, '\\$')}(?![\\w$])`);
  const list = listOf(
    refs,
    r => {
      const text = make('small', 'ref-t'),
        m = at.exec(r.text);
      if (m) text.append(r.text.slice(0, m.index), make('mark', '', name), r.text.slice(m.index + name.length));
      else text.textContent = r.text;
      return [make('b', '', `${r.path}:${r.line}`), text];
    },
    // a worktree outside the project folder: its files can't be opened from here
    r =>
      outside
        ? toast(`${r.path} is in a worktree outside the project folder: open it from there.`)
        : stickFileAt(r.path, r.line, ...besideBox()),
  );
  showBox(
    defsHeader(name, more ? `the first ${refs.length} uses` : `${refs.length} use${refs.length > 1 ? 's' : ''}`),
    list,
  );
  list.querySelector('button')?.focus();
}

/** A list of places to pick from (definitions, uses), rows styled as Ctrl+K's: `main` is a row's text, `kind` its
 *  tag on the right. */
function listOf<T>(all: T[], main: (t: T) => HTMLElement[], pick: (t: T) => void, kind?: (t: T) => string) {
  const list = make('div', 'defs-list');
  list.setAttribute('role', 'listbox');
  for (const t of all) {
    const row = make('button', 'finder-row'),
      m = make('span', 'fr-main');
    row.setAttribute('role', 'option');
    row.dataset.kind = 'preview';
    m.append(...main(t));
    row.append(m, ...(kind ? [make('span', 'fr-k', kind(t))] : []));
    row.onclick = () => pick(t);
    list.append(row);
  }
  return list;
}

/** Where a 380×260 window fits beside the open box: right, else left, else (a phone) below or above it. */
function besideBox(): [number, number] {
  const b = box.getBoundingClientRect();
  if (b.right + 388 <= innerWidth) return [b.right + 8, b.top];
  if (b.left >= 388) return [b.left - 388, b.top];
  return [8, b.bottom + 268 <= innerHeight ? b.bottom + 8 : Math.max(8, b.top - 268)];
}

/** The definition box's header: the name, a note, a way back to the list, and close. */
function defsHeader(name: string, note: string, back?: () => void) {
  const h = make('div', 'defs-h');
  if (back) h.append(button('‹ All', 'defs-back', back));
  h.append(
    make('b', '', name),
    make('span', '', note),
    iconButton(ICON.x, 'Close (Esc)', () => closeDefs()),
  );
  return h;
}

/** Where a symbol is defined, as path:line. */
const locationOf = (s: CodeSymbol) => `${s.path}:${s.line}`;

/** A name defined in several places: a list to pick from. */
function pickDefinition(name: string, defs: CodeSymbol[]) {
  const list = listOf(
    defs,
    s => [make('b', '', locationOf(s)), ...(s.scope ? [make('small', '', s.scope)] : [])],
    s => showDefinition(name, s, () => pickDefinition(name, defs)),
    s => s.kind,
  );
  showBox(defsHeader(name, `${defs.length} definitions`), list);
  list.querySelector('button')?.focus();
}

/** One definition: the lines around it, and a button to open the file there. */
async function showDefinition(name: string, s: CodeSymbol, back?: () => void) {
  const n = ++asked;
  const text = (await api<{ text: string | null }>(`file?path=${q(s.path)}`).catch(() => null))?.text;
  if (n !== asked) return;
  const first = Math.max(1, s.line - AROUND);
  const snippet =
    text == null
      ? make('p', 'none', "This file can't be read now.")
      : await sourceView(
          s.path,
          text
            .split('\n', first + 15)
            .slice(first - 1)
            .join('\n'),
          { first, at: s.line },
        );
  if (n !== asked) return;
  const code = make('div', 'defs-code');
  code.append(snippet);
  const open = button('Open file', 'primary', () => {
    closeDefs(false);
    openFileAt(s.path, s.line);
  });
  const foot = make('div', 'defs-f');
  foot.append(make('span', '', locationOf(s)), open);
  showBox(defsHeader(name, s.scope ? `${s.kind} in ${s.scope}` : s.kind, back), code, foot);
  revealIn(code);
  open.focus();
}

/** Show the definition box with these contents, by the name that was clicked. */
function showBox(...parts: HTMLElement[]) {
  box.replaceChildren(...parts);
  box.hidden = false;
  keepOnScreen(box, x0, y0);
}

/** Close the definition box; `restore` hands focus back. */
function closeDefs(restore = true) {
  asked++;
  if (box.hidden) return;
  box.hidden = true;
  box.replaceChildren();
  if (restore && from?.isConnected) from.focus();
  from = null;
}

// Escape closes this first, wherever focus is: not the inspector under it
addEventListener(
  'keydown',
  e => {
    if (e.key === 'Escape' && !box.hidden) {
      e.preventDefault();
      e.stopPropagation();
      closeDefs();
    }
  },
  true,
);
box.addEventListener('keydown', e => {
  e.stopPropagation(); // keys here aren't canvas shortcuts
  const rows = [...box.querySelectorAll<HTMLElement>('.defs-list button')],
    i = rows.indexOf(document.activeElement as HTMLElement);
  if (i >= 0 && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
    e.preventDefault();
    rows[(i + (e.key === 'ArrowDown' ? 1 : rows.length - 1)) % rows.length].focus();
  }
});
addEventListener(
  'pointerdown',
  e => {
    if (!box.hidden && !box.contains(e.target as Node)) closeDefs(false);
  },
  true,
);
