// Permission mode, per session card: what that card's Claude may do without asking. Picked in the card's message
// bar; a change applies to its running Claude process right away (Claude reports the switch back as a status line).
import { make } from '../lib/dom'
import { post } from '../lib/api'
import { saveSoon } from '../lib/store'
import type { Session } from './session'

export const MODES: [string, string, string][] = [
  ['default', 'Read only', 'Asks before editing files or running commands'],
  ['acceptEdits', 'Allow edits', 'Edits files without asking; still asks before other commands'],
  ['plan', 'Plan only', 'Explores and writes a plan for you to review; changes nothing'],
  ['bypassPermissions', 'Allow everything', 'Never asks. Only for work you trust'],
]

/** The mode picker for a card's message bar. */
export function modePicker(S: Session) {
  const sel = make('select', 'modesel')
  sel.setAttribute('aria-label', 'Permission mode for this session')
  sel.append(...MODES.map(([value, label, desc]) => Object.assign(make('option', '', label), { value, title: desc })))
  sel.value = S.mode
  sel.dataset.mode = S.mode
  sel.onchange = () => setMode(S, sel.value)
  S.modeSel = sel
  return sel
}

/** Change a card's mode. `tell`: also switch its running Claude process (false when Claude itself reported it). */
export function setMode(S: Session, mode: string, tell = true) {
  if (!MODES.some(([m]) => m === mode)) return
  S.mode = mode
  const sel = S.modeSel
  if (sel) {
    sel.dataset.mode = mode // before .value: the custom dropdown mirrors both when value changes
    if (sel.value !== mode) sel.value = mode
  }
  // not running yet is fine (the next message starts it in this mode); a failed request means it didn't switch
  if (tell) post('mode', { cid: S.cid, mode }).catch(() => modeRefused(S))
  else S.confirmedMode = mode
  saveSoon()
}

/** Claude refused a switch: show the mode it's really in again. */
export const modeRefused = (S: Session) => setMode(S, S.confirmedMode ?? 'default', false)
