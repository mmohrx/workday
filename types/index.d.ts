export type Item = {
  text: string
  /** Ticket or PR key, e.g. ABC-123 or web#42 */
  id?: string
  /** Start time HH:MM (events only) */
  time?: string
  source?: string
  url?: string
}
export type Snapshot = {
  events: Item[]
  tasks: Item[]
  alerts: Item[]
  updatedAt: string
  /** Set when the data is sample data from /today demo */
  isDemo?: boolean
}
export type Section = 'workday' | 'timeline' | 'focus' | 'heads-up'

declare module 'claude-code' {
  interface PluginState {
    workday: { snapshot: Shaped<Snapshot>; hidden: Shaped<Section[]> }
  }
}
