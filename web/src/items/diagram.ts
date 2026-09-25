// Mermaid code blocks -> diagrams, plus a zoom/pan view for them.
import Panzoom, { type PanzoomObject } from '@panzoom/panzoom'
import type { Mermaid } from 'mermaid'
import { $, make, ICON, iconButton } from '../lib/dom'
import { persist } from '../lib/store'
import { isDark, onTheme } from '../lib/theme'
import { forget } from '../canvas/graph'
import { items, place, savedRect, track, spotBeside, toWorld, changed, type Rect } from '../canvas/canvas'
import { makeWindow } from '../canvas/window'
import { referable } from '../canvas/refs'

let mermaid: Promise<Mermaid> | undefined // big library: loaded on first diagram only
const init = (m: Mermaid) => m.initialize({ startOnLoad: false, securityLevel: 'strict', theme: isDark() ? 'dark' : 'neutral' })
// Theme switched: new drawings use it, pinned diagrams redraw. ponytail: diagrams already in chat replies keep their colors.
onTheme(() => mermaid?.then(m => {
  init(m)
  live.clear()
  for (const n of items('diagram')) draw(n.querySelector<HTMLElement>('.dnode-b')!, n.dataset.src!).catch(() => {})
}))

function load() {
  return (mermaid ??= import('mermaid').then(({ default: m }) => {
    init(m)
    return m
  }))
}

export async function renderDiagrams(el: HTMLElement) {
  const nodes = [...el.querySelectorAll('pre > code.language-mermaid')].map(code => {
    const d = make('div', 'mermaid', code.textContent)
    d.dataset.src = code.textContent ?? ''
    code.parentElement!.replaceWith(d)
    return d
  })
  if (!nodes.length) return

  // Bad syntax, or the library failed to load: show the source (and why) instead of Mermaid's error graphic.
  const source = (d: HTMLElement, why = 'Mermaid could not load, showing the source.') => {
    const pre = make('pre')
    pre.append(make('code', '', d.dataset.src))
    d.replaceWith(make('p', 'mmd-err', why), pre)
  }
  try {
    const m = await load(), ok: HTMLElement[] = []
    for (const d of nodes) {
      try { await m.parse(d.dataset.src!); ok.push(d) } catch (e) {
        const fixed = /got 'GRAPH'/.test(String((e as Error)?.message)) && unkeyword(d.dataset.src!)
        if (fixed && await m.parse(fixed, { suppressErrors: true })) {
          d.dataset.src = d.textContent = fixed
          d.before(make('p', 'mmd-note', 'Drawn after renaming a node called graph (a Mermaid keyword) to graph_.'))
          ok.push(d)
        } else source(d, parseError(e))
      }
    }
    await m.run({ nodes: ok })
    for (const d of ok) {
      const tools = make('span', 'dtools')
      tools.append(iconButton(ICON.pin, 'Pin to canvas', () => pin(d.dataset.src!, origin(d), spotFor(d))),
                   iconButton(ICON.expand, 'Enlarge', () => openZoom(d.querySelector('svg')!)))
      d.append(tools)
      d.title = 'Click to enlarge, drag onto the canvas to pin'
      pullOut(d)
    }
  } catch (e) {
    console.error(e)
    nodes.filter(d => d.isConnected && !d.querySelector('svg')).forEach(d => source(d))
  }
}

/** Rename node ids spelled `graph` (a keyword Mermaid rejects) outside quoted labels, skipping the header line.
 *  ponytail: heuristic; also renames the word in unquoted labels like A[my graph]. */
const unkeyword = (src: string) => {
  const [head, ...rest] = src.split('\n')
  return [head, ...rest.map(l => l.split(/("[^"]*")/).map((part, i) => (i % 2 ? part : part.replace(/\bgraph\b/g, 'graph_'))).join(''))].join('\n')
}

/** "Parse error on line 6: … got 'GRAPH'" -> one readable sentence. */
function parseError(e: unknown) {
  const msg = String((e as Error)?.message ?? e)
  const line = msg.match(/line (\d+)/)?.[1], got = msg.match(/got '([^']+)'/)?.[1]
  const where = [line && `line ${line}`, got && `unexpected ${got.toLowerCase()}`].filter(Boolean).join(', ')
  return `Diagram not drawn: Mermaid syntax error${where ? ` (${where})` : ''}. Source below.`
}

/* ---------- while a reply streams ---------- */
const live = new Map<string, string | null>() // mermaid source -> rendered svg (null = rendering or invalid)

/** Called on every streamed frame (after the markdown is re-rendered): diagrams whose code block is complete
 *  show up drawn right away instead of waiting for the whole reply. Full interactivity comes at the end. */
export function liveDiagrams(el: HTMLElement, text: string) {
  const codes = [...el.querySelectorAll<HTMLElement>('pre > code.language-mermaid')]
  const open = (text.match(/^\s*```/gm)?.length ?? 0) % 2 === 1 // last fence not closed yet
  codes.forEach((code, i) => {
    if (open && i === codes.length - 1) return
    const src = code.textContent ?? ''
    const svg = live.get(src)
    if (svg) { const d = make('div', 'mermaid'); d.innerHTML = svg; code.parentElement!.replaceWith(d) }
    else if (svg === undefined) {
      live.set(src, null)
      load().then(async m => {
        if (!(await m.parse(src, { suppressErrors: true }))) return
        live.set(src, (await m.render(`live-${Date.now()}-${++seq}`, src)).svg)
      }).catch(() => {})
    }
  })
}

/* ---------- diagrams pinned to the canvas ---------- */
/** Where a diagram came from, for its node's title: the session card, or the file open in the inspector. */
const origin = (d: HTMLElement) =>
  d.closest('.card')?.querySelector('.t')?.textContent ?? (d.closest('#inspector') ? $('#ipath').textContent ?? '' : '')

/** Pin button: next to the diagram's card, else the middle of the view. */
const spotFor = (d: HTMLElement): Rect => spotBeside(d.closest<HTMLElement>('.card'), 440, 320)

/** Drag a rendered diagram out of a card or the inspector: a pinned copy follows the pointer. A plain click still enlarges. */
function pullOut(d: HTMLElement) {
  let dragged = false
  d.addEventListener('pointerdown', e => {
    if (e.button !== 0 || (e.target as Element).closest('button')) return
    let node: HTMLElement | undefined
    const W = 440, H = 320, grabX = 140, grabY = 18 // pointer holds the new node by its header
    track(d, e, (dx, dy) => {
      if (!node && Math.hypot(dx, dy) < 8) return
      const p = toWorld(e.clientX + dx, e.clientY + dy)
      if (!node) { node = pin(d.dataset.src!, origin(d), { x: p.x - grabX, y: p.y - grabY, w: W, h: H }); node.classList.add('dragging') }
      place(node, p.x - grabX, p.y - grabY)
    }, () => {
      if (!node) return
      dragged = true
      node.classList.remove('dragging')
      changed()
    })
  })
  d.addEventListener('click', () => {
    if (dragged) { dragged = false; return } // the click that ends a pull-out
    openZoom(d.querySelector('svg')!)
  })
}

let seq = 0
const draw = async (into: HTMLElement, src: string) => {
  const { svg } = await (await load()).render(`pin-${Date.now()}-${++seq}`, src)
  into.innerHTML = svg
  const el = into.querySelector('svg')!
  el.removeAttribute('style') // fill the node instead of Mermaid's fixed max-width
  el.setAttribute('width', '100%')
  el.setAttribute('height', '100%')
}

/** A diagram node on the canvas, drawn from its Mermaid source (so it can be restored after a reload).
 *  Edit opens the source under the drawing; it redraws as you type and keeps the last good drawing on errors. */
export function pin(src: string, title: string, r: Rect, id: string = crypto.randomUUID()) {
  const view = make('div', 'dnode-b'), ed = make('div', 'dnode-ed'), ta = make('textarea'), status = make('p', 'dnode-st')
  const edit = iconButton(ICON.pencil, 'Edit source', () => {
    ed.hidden = !ed.hidden
    edit.classList.toggle('on', !ed.hidden)
    if (!ed.hidden) ta.focus()
  })
  const { el: node, body } = makeWindow({
    kind: 'diagram', cls: 'dnode', title: title || 'Diagram', rect: r, minW: 220, minH: 160,
    actions: [edit,
      iconButton(ICON.expand, 'Enlarge', () => { const s = view.querySelector('svg'); if (s) openZoom(s) }),
      iconButton(ICON.x, 'Remove from canvas', () => { forget(node); node.remove(); changed() })],
  })
  node.dataset.src = src
  node.dataset.id = id
  node.dataset.ink = 'd:' + id // drawing over the diagram belongs to it (moves, collapses and saves with it)
  ta.value = src
  ta.spellcheck = false
  ta.setAttribute('aria-label', 'Mermaid source')
  ed.append(ta, status)
  ed.hidden = true
  body.append(view, ed)
  view.ondblclick = () => { const s = view.querySelector('svg'); if (s) openZoom(s) }

  let timer = 0, n = 0
  ta.addEventListener('input', () => {
    clearTimeout(timer)
    timer = setTimeout(async () => {
      const mine = ++n, text = ta.value
      try {
        await (await load()).parse(text)
        await draw(view, text)
        if (mine !== n) return // a newer keystroke already won
        node.dataset.src = text
        status.textContent = 'Saved'
        status.className = 'dnode-st'
        changed() // persist with the canvas layout
      } catch (e) {
        if (mine !== n) return
        status.textContent = parseError(e).replace(' Source below.', '').replace('Diagram not drawn: ', '')
        status.className = 'dnode-st bad'
      }
    }, 250)
  })
  ta.addEventListener('keydown', e => e.stopPropagation()) // typing here isn't a canvas shortcut

  draw(view, src).catch(e => { view.replaceChildren(make('p', 'mmd-err', parseError(e))); ed.hidden = false; edit.classList.add('on') })
  changed()
  return node
}

persist('diagrams',
  () => items('diagram').map(n => ({ id: n.dataset.id!, src: n.dataset.src!, title: n.querySelector('.t')!.textContent ?? '', ...savedRect(n) })),
  (list: (Rect & { src: string; title: string; id?: string })[]) => list.forEach(d => pin(d.src, d.title, d, d.id)))
referable('diagram', {
  icon: '◇',
  label: el => el.querySelector('.t')?.textContent ?? '',
  content: (el, label) => ({ text: `Diagram "${label}" (Mermaid):\n\`\`\`mermaid\n${el.dataset.src ?? ''}\n\`\`\`` }),
})

/* ---------- zoom dialog ---------- */
const dialog = $<HTMLDialogElement>('#zoom')
const stage = dialog.querySelector<HTMLElement>('.stage')!
const content = dialog.querySelector<HTMLElement>('.content')!
let pz: PanzoomObject | undefined

function openZoom(svg: SVGSVGElement) {
  const copy = svg.cloneNode(true) as SVGSVGElement
  copy.removeAttribute('style') // Mermaid pins a max-width; let it fill the stage instead
  content.replaceChildren(copy)
  dialog.showModal()
  pz = Panzoom(content, { maxScale: 12, minScale: 0.4, step: 0.35, cursor: 'grab' })
}

stage.addEventListener('wheel', e => pz?.zoomWithWheel(e), { passive: false })
dialog.addEventListener('close', () => { pz?.destroy(); pz = undefined; content.replaceChildren() })
dialog.addEventListener('click', e => { if (e.target === dialog) dialog.close() }) // backdrop
dialog.addEventListener('keydown', e => {
  if (e.key === '+' || e.key === '=') pz?.zoomIn()
  else if (e.key === '-') pz?.zoomOut()
  else if (e.key === '0') pz?.reset()
})
for (const b of dialog.querySelectorAll<HTMLButtonElement>('[data-z]')) {
  b.onclick = () => {
    const z = b.dataset.z
    if (z === 'in') pz?.zoomIn()
    else if (z === 'out') pz?.zoomOut()
    else if (z === 'fit') pz?.reset()
    else dialog.close()
  }
}
