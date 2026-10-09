// Mermaid code blocks -> diagrams, plus a zoom/pan view for them.
import type { Mermaid } from 'mermaid';
import { dragOut } from '../canvas/core/drag';
import { isFull, toggleFull } from '../canvas/core/fullview';
import { items, type Rect, savedRect } from '../canvas/core/items';
import { spotBeside } from '../canvas/core/placement';
import { referable } from '../canvas/core/refs';
import { creatable } from '../canvas/core/tools';
import { changed } from '../canvas/core/view';
import { makeWindow, removeButton, winTitle } from '../canvas/core/window';
import { fitInk, inkBox } from '../canvas/ink/stroke';
import { $, ICON, iconButton, make, saveFile, toast, uuid } from '../lib/dom';
import { onRendered } from '../lib/markdown';
import { each, persist } from '../lib/store';
import { isDark, onTheme } from '../lib/theme';
import { openZoom } from '../lib/zoom';

let mermaid: Promise<Mermaid> | undefined; // big library: loaded on first diagram only
/** Set Mermaid up: the theme, and labels drawn as SVG text. */
// htmlLabels off: labels as SVG text, not HTML inside the SVG. Pictures of windows (canvas_read, plan feedback)
// come out blank otherwise: HTML-in-SVG nested inside the snapshot's own HTML-in-SVG doesn't render in Chromium.
const init = (m: Mermaid) =>
  m.initialize({
    startOnLoad: false,
    securityLevel: 'strict',
    theme: isDark() ? 'dark' : 'neutral',
    htmlLabels: false,
    flowchart: { htmlLabels: false },
    fontFamily: getComputedStyle(document.documentElement).getPropertyValue('--sans').trim() || 'system-ui, sans-serif',
  });
// Theme switched: new drawings use it; pinned diagrams and the ones in replies redraw. The zoom view needs nothing:
// it's modal (the theme can't change while it's open) and copies the reply's drawing each time it opens.
onTheme(() =>
  mermaid?.then(async m => {
    init(m);
    live.clear();
    for (const n of items('diagram'))
      drawDiagram(n.querySelector<HTMLElement>('.dnode-b')!, n.dataset.src!).catch(() => {});
    for (const d of document.querySelectorAll<HTMLElement>('.mermaid[data-src]')) {
      const old = d.querySelector(':scope > svg');
      if (!old) continue; // still being drawn: it picks up the new theme anyway
      try {
        old.outerHTML = (await m.render(`md-${Date.now()}-${++seq}`, d.dataset.src!)).svg;
      } catch {}
    }
  }),
);

/** Mermaid, loaded and set up on first use. */
function loadMermaid() {
  return (mermaid ??= import('mermaid').then(({ default: m }) => {
    init(m);
    return m;
  }));
}

/** Turn the mermaid code blocks in rendered Markdown into diagrams, with a zoom button and a way to pin each. */
async function renderDiagrams(el: HTMLElement) {
  const nodes = [...el.querySelectorAll('pre > code.language-mermaid')].map(code => {
    const d = make('div', 'mermaid', code.textContent);
    d.dataset.src = code.textContent ?? '';
    code.parentElement!.replaceWith(d);
    return d;
  });
  if (!nodes.length) return;

  /** Show a diagram's source (and why it isn't drawn) in place of the diagram. */
  // Bad syntax, or the library failed to load: show the source (and why) instead of Mermaid's error graphic.
  const source = (d: HTMLElement, why = 'Mermaid could not load, showing the source.') => {
    const pre = make('pre');
    pre.append(make('code', '', d.dataset.src));
    d.replaceWith(make('p', 'mmd-err', why), pre);
  };
  try {
    const m = await loadMermaid(),
      ok: HTMLElement[] = [];
    for (const d of nodes) {
      try {
        await m.parse(d.dataset.src!);
        ok.push(d);
      } catch (e) {
        const fixed = /got 'GRAPH'/.test(String((e as Error)?.message)) && unkeyword(d.dataset.src!);
        if (fixed && (await m.parse(fixed, { suppressErrors: true }))) {
          d.dataset.src = d.textContent = fixed;
          d.before(make('p', 'mmd-note', 'Drawn after renaming a node called graph (a Mermaid keyword) to graph_.'));
          ok.push(d);
        } else source(d, parseError(e));
      }
    }
    await m.run({ nodes: ok });
    for (const d of ok) {
      const tools = make('span', 'dtools');
      tools.append(
        iconButton(ICON.pin, 'Pin to canvas', () => diagramNode(d.dataset.src!, origin(d), spotFor(d))),
        iconButton(ICON.expand, 'Enlarge', () => openZoom(d.querySelector('svg')!)),
      );
      d.append(tools);
      d.title = 'Click to enlarge, drag onto the canvas to pin';
      pullOut(d);
    }
  } catch (e) {
    console.error(e);
    nodes.filter(d => d.isConnected && !d.querySelector('svg')).forEach(d => source(d));
  }
}

onRendered(renderDiagrams);

/** Rename node ids spelled `graph` (a keyword Mermaid rejects) outside quoted labels, skipping the header line.
 *  ponytail: heuristic; also renames the word in unquoted labels like A[my graph]. */
const unkeyword = (src: string) => {
  const [head, ...rest] = src.split('\n');
  return [
    head,
    ...rest.map(l =>
      l
        .split(/("[^"]*")/)
        .map((part, i) => (i % 2 ? part : part.replace(/\bgraph\b/g, 'graph_')))
        .join(''),
    ),
  ].join('\n');
};

/** "Parse error on line 6: … got 'GRAPH'" -> one readable sentence. */
function parseError(e: unknown) {
  const msg = String((e as Error)?.message ?? e);
  const line = msg.match(/line (\d+)/)?.[1],
    got = msg.match(/got '([^']+)'/)?.[1];
  const where = [line && `line ${line}`, got && `unexpected ${got.toLowerCase()}`].filter(Boolean).join(', ');
  return `Diagram not drawn: Mermaid syntax error${where ? ` (${where})` : ''}. Source below.`;
}
/** A Mermaid error's text, without the pointer to the source below it. */
const bareError = (e: unknown) => parseError(e).replace(' Source below.', '');

/* ---------- while a reply streams ---------- */
const live = new Map<string, string | null>(); // mermaid source -> rendered svg (null = rendering or invalid)
const LIVE_MAX = 50; // streamed diagrams kept drawn; each frame re-renders the tail, so a shown one is still needed

// fence lines counted per reply so far, up to its last line break: each frame only reads the new text
const fences = new WeakMap<HTMLElement, { at: number; n: number }>();
/** Is this line a code fence (```)? */
const isFence = (line: string) => /^\s*```/.test(line);

/** Called on every streamed frame (after the markdown is re-rendered): diagrams whose code block is complete
 *  show up drawn right away instead of waiting for the whole reply. Full interactivity comes at the end. */
export function liveDiagrams(el: HTMLElement, text: string) {
  let f = fences.get(el);
  if (!f || text.length < f.at) fences.set(el, (f = { at: 0, n: 0 }));
  for (let nl: number; (nl = text.indexOf('\n', f.at)) >= 0; f.at = nl + 1) if (isFence(text.slice(f.at, nl))) f.n++;
  const open = (f.n + +isFence(text.slice(f.at))) % 2 === 1; // last fence not closed yet
  const codes = [...el.querySelectorAll<HTMLElement>('pre > code.language-mermaid')];
  codes.forEach((code, i) => {
    if (open && i === codes.length - 1) return;
    const src = code.textContent ?? '';
    const svg = live.get(src);
    if (svg) {
      const d = make('div', 'mermaid');
      d.innerHTML = svg;
      code.parentElement!.replaceWith(d);
    } else if (svg === undefined) {
      if (live.size >= LIVE_MAX) live.delete(live.keys().next().value!); // the oldest
      live.set(src, null);
      loadMermaid()
        .then(async m => {
          if (!(await m.parse(src, { suppressErrors: true }))) return;
          live.set(src, (await m.render(`live-${Date.now()}-${++seq}`, src)).svg);
        })
        .catch(() => {});
    }
  });
}

/* ---------- diagrams pinned to the canvas ---------- */
/** Where a diagram came from, for its node's title: the session card, or the file open in the inspector. */
const origin = (d: HTMLElement) =>
  d.closest('.card')?.querySelector('.t')?.textContent ??
  (d.closest('#inspector') ? ($('#ipath').textContent ?? '') : '');

/** Pin button: next to the diagram's card, else the middle of the view. */
const spotFor = (d: HTMLElement): Rect => spotBeside(d.closest<HTMLElement>('.card'), 440, 320);

/** Drag a rendered diagram out of a card or the inspector: a pinned copy follows the pointer. A plain click still enlarges. */
function pullOut(d: HTMLElement) {
  d.addEventListener('pointerdown', e => {
    if (e.button !== 0 || (e.target as Element).closest('button')) return;
    const W = 440,
      H = 320; // the pointer holds the new node by its tab
    dragOut(d, e, (x, y) => diagramNode(d.dataset.src!, origin(d), { x, y, w: W, h: H }), { x: 140, y: 18 });
  });
  d.addEventListener('click', () => openZoom(d.querySelector('svg')!)); // a drag-out's closing click never gets here
}

let seq = 0;
/** Render Mermaid source into a box, as an SVG that fills it (with the drawing kept on it). */
const drawDiagram = async (into: HTMLElement, src: string) => {
  const { svg } = await (await loadMermaid()).render(`pin-${Date.now()}-${++seq}`, src);
  const t = document.createElement('template');
  t.innerHTML = svg;
  const el = t.content.querySelector('svg')!;
  el.removeAttribute('style'); // fill the node instead of Mermaid's fixed max-width
  el.setAttribute('width', '100%');
  el.setAttribute('height', '100%');
  // on the canvas: into the drawing box, shaped like the diagram, keeping the ink drawn on it
  into.querySelector(':scope > .mmd-err')?.remove();
  const box = into.querySelector<HTMLElement>(':scope > .ink-box');
  if (!box) return into.replaceChildren(el);
  fitInk(box, el);
};

/** A diagram node on the canvas, drawn from its Mermaid source (so it can be restored after a reload).
 *  Edit opens the source under the drawing; it redraws as you type and keeps the last good drawing on errors. */
const setSource = new WeakMap<HTMLElement, (src: string) => Promise<void>>();

/** A diagram window on the canvas: the rendered diagram, and its source to edit. */
export function diagramNode(src: string, title: string, r: Rect, id: string = uuid(), draft?: string) {
  const view = make('div', 'dnode-b'),
    ed = make('div', 'dnode-ed'),
    ta = make('textarea'),
    status = make('p', 'dnode-st');
  const edit = iconButton(ICON.pencil, 'Edit source', () => {
    ed.hidden = !ed.hidden;
    edit.classList.toggle('on', !ed.hidden);
    if (!ed.hidden) ta.focus();
  });
  const { el: node, body } = makeWindow({
    kind: 'diagram',
    cls: 'dnode',
    title: title || 'Diagram',
    rect: r,
    minW: 220,
    minH: 160,
    actions: [
      edit,
      iconButton(ICON.download, 'Download as SVG', () => download(node)),
      removeButton('Remove from canvas'),
    ],
  });
  node.dataset.src = src;
  node.dataset.id = id;
  node.dataset.ink = `d:${id}`; // drawing over the window belongs to it (moves, collapses and saves with it)
  view.append(inkBox(`df:${id}`)); // drawing on the diagram itself stays on the same spot at any size
  ta.value = src;
  ta.spellcheck = false;
  ta.setAttribute('aria-label', 'Mermaid source');
  ed.append(ta, status);
  ed.hidden = true;
  body.append(view, ed);
  view.onclick = () => {
    if (!isFull(node)) toggleFull(node);
  }; // click the drawing: full view, where it zooms and pans
  // a new source from outside (Claude's canvas_update): checked first, so a bad one leaves the drawing as it was
  setSource.set(node, async text => {
    await (await loadMermaid()).parse(text);
    await drawDiagram(view, text);
    node.dataset.src = ta.value = text;
    status.textContent = '';
    status.className = 'dnode-st';
  });

  let timer = 0,
    n = 0;
  ta.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      const mine = ++n,
        text = ta.value;
      try {
        await (await loadMermaid()).parse(text);
        await drawDiagram(view, text);
        if (mine !== n) return; // a newer keystroke already won
        node.dataset.src = text;
        delete node.dataset.state;
        status.textContent = 'Saved';
        status.className = 'dnode-st';
        changed(); // persist with the canvas layout
      } catch (e) {
        if (mine !== n) return;
        // the draft is kept (saved with the layout, and canvas_update won't overwrite it) until it draws
        node.dataset.state = 'editing';
        status.textContent = `${bareError(e).replace('Diagram not drawn: ', '')} Draft kept; the drawing is the last version that worked.`;
        status.className = 'dnode-st bad';
        changed();
      }
    }, 250);
  });
  ta.addEventListener('keydown', e => e.stopPropagation()); // typing here isn't a canvas shortcut

  drawDiagram(view, src).catch(e => {
    view.prepend(make('p', 'mmd-err', parseError(e)));
    ed.hidden = false;
    edit.classList.add('on');
  });
  if (draft != null && draft !== src) {
    ta.value = draft;
    ed.hidden = false;
    edit.classList.add('on');
    ta.dispatchEvent(new Event('input'));
  } // says why it isn't drawn
  changed();
  return node;
}

/** Save the drawing as an SVG file, in the current theme's colors and on its background (a dark theme's light text
 *  would vanish on a viewer's white page otherwise). Drawings on it aren't included. */
function download(node: HTMLElement) {
  const svg = node.querySelector<SVGSVGElement>('.dnode-b .ink-box > svg:not(.ink-local)');
  if (!svg) return toast('Nothing drawn to download yet.');
  const out = svg.cloneNode(true) as SVGSVGElement,
    vb = svg.viewBox.baseVal;
  if (vb?.width) {
    out.setAttribute('width', String(vb.width));
    out.setAttribute('height', String(vb.height));
  }
  out.style.backgroundColor = getComputedStyle(node.querySelector('.win-b')!).backgroundColor;
  saveFile(
    new Blob([new XMLSerializer().serializeToString(out)], { type: 'image/svg+xml' }),
    `${winTitle(node).trim() || 'diagram'}.svg`,
  );
}

/** The diagram source being edited and not yet drawn, if any (saved so a reload keeps the draft). */
const draftOf = (n: HTMLElement) =>
  n.dataset.state === 'editing' ? n.querySelector<HTMLTextAreaElement>('.dnode-ed textarea')!.value : undefined;
persist(
  'diagrams',
  () =>
    items('diagram').map(n => ({
      id: n.dataset.id!,
      src: n.dataset.src!,
      title: n.querySelector('.t')!.textContent ?? '',
      ...savedRect(n),
      draft: draftOf(n),
    })),
  (list: (Rect & { src: string; title: string; id?: string; draft?: string })[]) =>
    each(list, d => diagramNode(d.src, d.title, d, d.id, d.draft)),
);
creatable('diagram', {
  size: () => ({ w: 440, h: 320 }),
  create: async (a, r) => {
    const src = String(a.text);
    try {
      await (await loadMermaid()).parse(src);
    } catch (e) {
      throw new Error(`${bareError(e)} Fix the Mermaid and try again.`);
    }
    return diagramNode(src, String(a.title ?? 'Diagram'), r);
  },
  update: async (el, a) => {
    try {
      await setSource.get(el)!(String(a.text));
    } catch (e) {
      throw new Error(`${bareError(e)} The diagram is unchanged; fix the Mermaid and try again.`);
    }
  },
});
referable('diagram', {
  icon: '◇',
  label: el => el.querySelector('.t')?.textContent ?? '',
  copy: el => el.dataset.src ?? '',
  content: (el, label) => ({ text: `Diagram "${label}" (Mermaid):\n\`\`\`mermaid\n${el.dataset.src ?? ''}\n\`\`\`` }),
});
