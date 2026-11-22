export type Item = {
  text: string
  /** Ticket or PR key, e.g. ABC-123 or web#42 */
  id?: string
  /** Start time HH:MM (events only) */
  time?: string
  /** `time` as minutes since midnight, parsed once when the item is stored; absent for all-day or unknown */
  start?: number
  source?: string
  url?: string
}
export type Snapshot = {
  events: Item[]
  tasks: Item[]
  alerts: Item[]
  /** Per tracker: a link to the user's open items there, matched to `Item.source` */
  lists?: { source: string; url: string }[]
  /** When the data was taken (ms since epoch); absent while the pane is empty */
  takenAt?: number
  /** Set when the data is sample data from /today demo */
  isDemo?: boolean
}
export type Section = 'workday' | 'timeline' | 'focus' | 'heads-up'

declare module 'claude-code' {
  interface PluginState {
    workday: { snapshot: Shaped<Snapshot>; hidden: Shaped<Section[]> }
  }
}
