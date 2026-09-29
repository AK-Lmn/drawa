// Every keyboard shortcut and runnable action, registered by the module that handles it: the ? sheet lists them,
// Ctrl+K runs the ones with `run`, and the launch tips are drawn from the ones with `tip`.
// ponytail: this only describes the keys; each module's keydown handler still dispatches them (Draw mode and the
// number row's physical keys make the order matter). Move dispatch onto this list if the two drift.

export interface Command {
  label: string // "New session"
  group: string // the ? sheet's section: "Canvas", "Items", "Windows", "Selection", "Draw", "Message box"
  keys?: string[] // each a combo, keys joined by "+": ["W", "Shift+W"]; a lone "+" is the plus key
  run?: () => void // makes it a Ctrl+K command
  tip?: string // a launch tip about it, plain text; keys in backticks show as key caps: "`W` steps through your windows"
}

const cmds: Command[] = []
/** Register a shortcut or action. Call it at module top level, beside the handler. */
export const command = (c: Command) => void cmds.push(c)
export const commands = (): readonly Command[] => cmds
/** A combo's keys, for drawing key caps: "Shift+W" -> ["Shift", "W"]; "+" and "Ctrl++" keep their plus. */
export const keysOf = (combo: string) => (combo === '+' ? ['+'] : combo.endsWith('++') ? [...combo.slice(0, -2).split('+'), '+'] : combo.split('+'))
/** Ctrl on Windows and Linux, ⌘ on a Mac: what to show for a "Ctrl" key. */
export const MOD = /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Ctrl'
