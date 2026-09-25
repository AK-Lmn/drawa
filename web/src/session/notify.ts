// Telling you when Claude needs you while you're looking elsewhere: a count in the tab title, and a system
// notification (if you allowed them) when a turn finishes or Claude waits for an approval or an answer.
import { project } from '../lib/dom'
import { centerOn } from '../canvas/canvas'
import { focus, type Session } from './session'

let unread = 0
const away = () => document.hidden || !document.hasFocus()
const title = () => { document.title = `${unread ? `(${unread}) ` : ''}${project.name} · Claude UI` }

/** Ask for notification permission once, from a user action (sending a message). */
export function askPermission() {
  if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission().catch(() => {})
}

export function notify(S: Session, why: 'done' | 'ask' | 'plan') {
  if (!away()) return
  unread++
  title()
  if (!('Notification' in window) || Notification.permission !== 'granted') return
  const head = why === 'done' ? 'Claude finished' : why === 'plan' ? 'Plan ready for review' : 'Claude needs your approval'
  const n = new Notification(head, { body: S.title, tag: S.cid + why, silent: why === 'done' })
  n.onclick = () => { window.focus(); focus(S); centerOn(S.card); n.close() }
}

const seen = () => { if (unread && !away()) { unread = 0; title() } }
addEventListener('focus', seen)
document.addEventListener('visibilitychange', seen)
