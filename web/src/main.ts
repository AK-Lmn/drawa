// Boot: wire the toolbar and panels, restore the canvas, load history + files.
// Features register themselves on import (saved-layout slices, referable kinds); the imports below are the app.
import './lib/fonts' // applies the saved font choice right away
import './lib/theme'
import { api } from './lib/api'
import { $, make, ui, project } from './lib/dom'
import { persist, restore, save, saveSoon } from './lib/store'
import { enhance } from './lib/select'
import { onReconnect } from './lib/connection'
import { apply, fit, zoomAt, onChange, stage, track, view as camera } from './canvas/canvas'
import { redraw } from './canvas/graph'
import { setDrawing, drawing } from './canvas/ink'
import { noteHere } from './items/notes'
import { sketch } from './items/sketch'
import './items/diagram'
import './items/plan'
import { openGit } from './items/git'
import { tree, closeInspector, showTab } from './panels/files'
import { cards, cur, newSession, meta } from './session/session'
import { attach } from './session/live'
import { loadSessions } from './session/history'

const drawer = $('#drawer'), inspector = $('#inspector'), drawerBtn = $('#btn-drawer')
const toggleDrawer = (open = drawer.hidden) => { drawer.hidden = !open; drawerBtn.setAttribute('aria-expanded', String(open)) }

$('#btn-new').onclick = () => newSession()
$('#btn-sketch').onclick = () => sketch({ edit: true })
$('#btn-git').onclick = () => openGit()
drawerBtn.onclick = () => toggleDrawer()
$('#dclose').onclick = () => toggleDrawer(false)
$('#iclose').onclick = closeInspector
$('#refresh').onclick = () => { tree(); loadSessions() }
for (const b of document.querySelectorAll<HTMLElement>('[data-l]')) {
  b.onclick = () => {
    for (const o of document.querySelectorAll('[data-l]')) o.classList.toggle('on', o === b)
    $('#tree').hidden = b.dataset.l !== 'tree'
    $('#sessions').hidden = b.dataset.l !== 'sessions'
  }
}
for (const b of document.querySelectorAll<HTMLElement>('[data-r]')) b.onclick = () => showTab(b.dataset.r as 'changes' | 'viewer')

/* ---------- permission mode + model: toolbar settings, saved with the canvas ---------- */
ui.mode.onchange = () => { ui.mode.dataset.mode = ui.mode.value; save() }
ui.model.onchange = save
enhance(ui.mode) // custom dropdowns; the native selects stay the source of truth
enhance(ui.model)
let savedModel = ''
persist('mode', () => ui.mode.value, v => { ui.mode.value = v }, 0)
persist('model', () => ui.model.value || savedModel, v => { savedModel = v }, 0)
persist('view', () => ({ ...camera }), v => { Object.assign(camera, v) }, 0)

// Inspector: drag its left edge to widen it.
const edgeGrip = inspector.appendChild(Object.assign(document.createElement('div'), { className: 'edge-grip', title: 'Drag to resize' }))
edgeGrip.addEventListener('pointerdown', e => {
  if (e.button !== 0) return
  const w = inspector.offsetWidth
  inspector.classList.add('resizing')
  track(edgeGrip, e, dx => { inspector.style.width = `${Math.min(innerWidth - 24, Math.max(360, w - dx))}px` }, () => inspector.classList.remove('resizing'))
})

// Single-key shortcuts, only when not typing.
addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    if (!inspector.hidden) closeInspector()
    else if (!drawer.hidden) toggleDrawer(false)
    return
  }
  const t = e.target instanceof Element ? e.target : null
  if (e.ctrlKey || e.metaKey || e.altKey || t?.closest('input, textarea, select, [contenteditable]') || document.querySelector('dialog[open]')) return
  const k = e.key.toLowerCase()
  if (k === 'n') { e.preventDefault(); newSession() }
  else if (k === 't') { e.preventDefault(); noteHere() }
  else if (k === 'd') setDrawing(!drawing)
  else if (k === 's') { e.preventDefault(); sketch({ edit: true }) }
  else if (k === 'f') fit()
  else if (k === 'g') openGit()
  else if (k === 'h') toggleDrawer()
  else if (k === '0') zoomAt(1, undefined, undefined, true)
})

// The hint teaches pan/zoom once, then gets out of the way.
const hint = $('#hint')
const dismiss = () => hint.classList.add('gone')
stage.addEventListener('wheel', dismiss, { once: true })
stage.addEventListener('pointerdown', e => { if (e.target === stage) dismiss() }, { once: true })
setTimeout(dismiss, 12000)

/* ---------- boot ---------- */
project.root = (await api<{ root: string }>('info')).root
project.name = project.root.split('/').pop() || project.root
document.title = `${project.name} · Claude UI`
$('#pname').textContent = project.name
$('#ppath').textContent = project.root

// Models and skills / slash commands come from Claude itself (slow the first time: the server asks a fresh process).
api<typeof meta>('meta').then(m => {
  Object.assign(meta, m)
  ui.model.replaceChildren(...m.models.map(o => {
    const opt = make('option', '', o.displayName)
    opt.value = o.value === 'default' ? '' : o.value
    opt.title = o.description
    return opt
  }))
  ui.model.value = savedModel
}).catch(() => {})

await restore()
ui.mode.dataset.mode = ui.mode.value
apply()
if (!cards.length) newSession()
document.fonts.ready.then(redraw) // card text reflow can shift edge anchors
onChange(saveSoon)
// server back after an outage (or a restart): pick the live streams and lists up again
onReconnect(() => { for (const S of cards) attach(S); tree(); loadSessions() })
tree()
loadSessions()
cur?.ta.focus({ preventScroll: true })
