import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderChildren } from 'claude-code'

import type { Item, Section, Snapshot } from '../types'

type Engine = EngineInterface

const PANE = 'today'
const TOOL = 'update_today'
const EMPTY: Snapshot = { events: [], tasks: [], alerts: [] }
const SECTIONS: readonly Section[] = ['workday', 'timeline', 'focus', 'heads-up']
const STORE_HIDDEN = 'hidden-sections'
const STORE_ON = 'open-on-start'
const STORE_LAST = 'last-snapshot'
// The Claude Code process that last got a start refresh: a reload in the same process gets none.
const STORE_STARTED = 'start-refresh-pid'
const DEFAULT_START = 9 * 60
const DEFAULT_END = 18 * 60

type Colors = { accent: string; events: string; tasks: string; alerts: string; ok: string }
type Palette = 'calm' | 'nordic' | 'warm' | 'theme' | 'mono'

// Fixed palettes use mid tones that read on light and dark backgrounds, also as label backgrounds.
// `theme` and `mono` use theme keys, so they follow the user's Claude Code theme.
const PALETTES: Record<Palette, Colors> = {
  calm: { accent: '#14b8a6', events: '#818cf8', tasks: '#fbbf24', alerts: '#f87171', ok: '#4ade80' },
  nordic: { accent: '#88c0d0', events: '#81a1c1', tasks: '#b48ead', alerts: '#d08770', ok: '#a3be8c' },
  warm: { accent: '#eab308', events: '#84cc16', tasks: '#c084fc', alerts: '#f97316', ok: '#10b981' },
  theme: { accent: 'claude', events: 'suggestion', tasks: 'merged', alerts: 'error', ok: 'success' },
  mono: { accent: 'text', events: 'text', tasks: 'text', alerts: 'warning', ok: 'inactive' },
}

const THEME_KEYS = new Set([
  'text', 'inverseText', 'inactive', 'subtle', 'suggestion', 'remember', 'success', 'error',
  'warning', 'merged', 'claude', 'permission', 'planMode', 'autoAccept', 'ide',
])

/** A color the user typed: a hex value (#rgb or #rrggbb) or a theme key; anything else is ignored. */
function colorOf(v: unknown): string | undefined {
  const t = String(v ?? '').trim()
  if (/^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(t)) return t
  return THEME_KEYS.has(t) ? t : undefined
}

const snapshot = atom({ plugin: 'workday', key: 'snapshot' } as const, EMPTY, {
  shape: 'snapshot-4',
})
const hidden = atom({ plugin: 'workday', key: 'hidden' } as const, [] as Section[], {
  shape: 'hidden-1',
})

const itemList = {
  type: 'array',
  items: {
    type: 'object',
    properties: {
      text: { type: 'string', description: 'Short title, one line, without the key' },
      id: { type: 'string', description: 'Ticket or PR key, e.g. ABC-123 or web#42' },
      time: { type: 'string', description: 'Start time HH:MM (events only)' },
      source: { type: 'string', description: 'Tool it came from, e.g. Jira' },
      url: { type: 'string', description: 'https link to open the item (ticket, PR, event, mail)' },
    },
    required: ['text'],
  },
}

const listLinks = {
  type: 'array',
  description: 'Per tracker in tasks: a link that lists my open items there (a saved filter or search)',
  items: {
    type: 'object',
    properties: {
      source: { type: 'string', description: 'Same name as in the tasks, e.g. Jira' },
      url: { type: 'string', description: 'https link to my open items in that tool' },
    },
    required: ['source', 'url'],
  },
}

const LANGUAGE =
  'Write in the language the user normally uses with you in this session (e.g. German if they write German).'

const sourcesHint = (sources: string) => (sources ? `Preferred sources: ${sources}.` : '')

function todayPrompt(sources: string, maxTasks: number, maxAlerts: number, isPaneShown: boolean): string {
  return [
    'Refresh my Today pane.',
    'Use whatever tools are connected in this session to find what is on my plate today:',
    '- Calendar: my events today, sorted by start time',
    `- Ticket or task trackers, every one that is connected: open items assigned to me, merged into one list, most important first (at most ${maxTasks})`,
    '- Monitoring or error tracking: what is on fire right now (open alerts, new errors)',
    '- Inbox and code review: only things where someone waits for me (a question, a requested change, a review). Skip pure notifications such as "merged" or "pushed".',
    `Monitoring, inbox and code review together go into heads-up: at most ${maxAlerts * 2} items, most urgent first.`,
    'Give every item its key (`id`) and a `url` that opens it, wherever the tool returns one.',
    'A pull request or review gets `repo#number` as `id`; if the notification lacks the number, look it up with whatever code hosting access you have, and leave `id` empty rather than guess. A monitoring item gets the name of the site or customer, not an internal numeric ID.',
    'For each tracker in tasks, add to `lists` a link that shows my open items there (a saved filter or search URL), if the tool can build one.',
    'Skip any source that is not connected, without asking. Read only, change nothing.',
    sourcesHint(sources),
    LANGUAGE,
    `Then call mcp__workday__${TOOL} with the result.`,
    isPaneShown
      ? 'Reply in chat with a single line.'
      : 'The pane cannot be shown here (an IDE, or a narrow terminal), so also list the result in chat: short, grouped by events, tasks and heads-up, with links.',
  ]
    .filter(Boolean)
    .join('\n')
}

function wrapupPrompt(sources: string, note: string): string {
  return [
    'Write my end-of-day report for today. Read only, change nothing.',
    'Sources, as available:',
    '- this session: what we worked on',
    '- code hosting, every account that is connected: my commits, pull requests and reviews from today, in any repository',
    '- local git, for commits not pushed yet: the folders of my Claude Code sessions today (the `cwd` in session files changed today under ~/.claude/projects, or $CLAUDE_CONFIG_DIR/projects), and the working directory; in each git repository there, `git log --all --since=midnight --author="$(git config user.email)"`',
    '- count a commit once, even when both sources find it',
    '- ticket or task trackers, every one that is connected: what I closed, moved or commented on today',
    '- calendar: my events today',
    sourcesHint(sources),
    note ? `My note: ${note}` : '',
    LANGUAGE,
    '',
    'Format, short bullet points, four sections, with links to tickets and PRs:',
    'Done · In progress / open · First thing tomorrow (max 3) · Time blocks (rough, for time tracking, e.g. "09:00–11:30 Project X")',
  ]
    .filter(line => line !== '')
    .join('\n')
}

const pad = (n: number) => String(n).padStart(2, '0')
const fmt = (min: number) => {
  const m = ((min % 1440) + 1440) % 1440
  return `${pad(Math.floor(m / 60))}:${pad(m % 60)}`
}
/** "1h 5m" or "25m". */
const until = (min: number) => (min >= 60 ? `${Math.floor(min / 60)}h ${min % 60}m` : `${min}m`)

/** A progress line: the done part heavy, the rest thin. */
function bar(pct: number, width: number) {
  const done = Math.round((Math.min(100, Math.max(0, pct)) * width) / 100)
  return ['━'.repeat(done), '─'.repeat(width - done)] as const
}

function minutes(hhmm: string | undefined): number | undefined {
  const m = /^(\d{1,2}):(\d{2})/.exec(hhmm ?? '')
  if (!m) return undefined
  const h = Number(m[1])
  const min = Number(m[2])
  return h < 24 && min < 60 ? h * 60 + min : undefined
}

/** Local date as YYYY-MM-DD: the last snapshot is shown again only on the day it was taken. */
const todayKey = () => {
  const d = new Date()
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

const nowMinutes = () => {
  const d = new Date()
  return d.getHours() * 60 + d.getMinutes()
}

const DATE = new Intl.DateTimeFormat(undefined, { weekday: 'short', day: 'numeric', month: 'short' })

// Greetings follow the system language, like the date; anything without a table here gets English.
const GREETINGS: Record<string, readonly [night: string, morning: string, noon: string, afternoon: string, evening: string]> = {
  en: ['Still up', 'Good morning', 'Hello', 'Good afternoon', 'Good evening'],
  de: ['Noch wach', 'Guten Morgen', 'Mahlzeit', 'Guten Tag', 'Guten Abend'],
}
const LANG = DATE.resolvedOptions().locale.slice(0, 2)
const WORDS = GREETINGS[LANG] ?? GREETINGS.en!

/** The part of the day as an index into WORDS and SKY: night, morning, noon, afternoon, evening. */
function dayPart(min: number): 0 | 1 | 2 | 3 | 4 {
  const h = Math.floor(min / 60)
  return h < 5 ? 0 : h < 11 ? 1 : h < 14 ? 2 : h < 18 ? 3 : h < 23 ? 4 : 0
}

/** "Good morning" by the time of day; late at night "Still up?". */
function greeting(min: number): string {
  const part = dayPart(min)
  return `${WORDS[part]}${part === 0 ? '?' : ''}`
}

// A sky for each part of the day, in front of the greeting.
const SKY = ['🌙', '🌅', '🌞', '⛅', '🌆'] as const

const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined)
/** Links are https only; anything else is dropped. */
const httpsUrl = (v: unknown) => (typeof v === 'string' && /^https:\/\//.test(v) ? v : undefined)

/** Cleans what Claude (or the store) hands over. Each item's start time is parsed here, once. */
function toItems(value: unknown): Item[] {
  if (!Array.isArray(value)) return []
  return value
    .filter(x => x && typeof x.text === 'string')
    .map(x => {
      const time = str(x.time)
      return {
        text: String(x.text),
        id: str(x.id),
        time,
        start: minutes(time),
        source: str(x.source),
        url: httpsUrl(x.url),
      }
    })
}

/** Links to a tracker's list of open items, keyed by the source name; https only. */
function toLists(value: unknown): { source: string; url: string }[] {
  if (!Array.isArray(value)) return []
  return value.flatMap(x => {
    const source = str(x?.source)
    const url = httpsUrl(x?.url)
    return source && url ? [{ source, url }] : []
  })
}

/** The one way into the pane's state: items cleaned, events by start time, all-day ones last. */
function normalize(raw: Record<string, unknown>, isDemo?: true): Snapshot {
  const events = toItems(raw.events).sort((a, b) => (a.start ?? Infinity) - (b.start ?? Infinity))
  return {
    events,
    tasks: toItems(raw.tasks),
    alerts: toItems(raw.alerts),
    lists: toLists(raw.lists),
    takenAt: Date.now(),
    ...(isDemo ? { isDemo } : {}),
  }
}

/** Sample data that shows every state of the pane: past, next and later events, overflow, links, alerts. */
function demoSnapshot(): Snapshot {
  const t = nowMinutes()
  const url = (path: string) => `https://example.com/${path}`
  // Offsets stay inside the day, so the demo makes sense at 00:30 and at 23:30 alike.
  const at = (offset: number) => fmt(Math.min(1439, Math.max(0, t + offset)))
  return normalize(
    {
      events: [
        { time: at(-150), text: 'Daily standup', source: 'Calendar', url: url('event/1') },
        { time: at(-60), text: 'Design review: checkout flow', source: 'Calendar' },
        { time: at(+25), text: '1:1 with team lead', source: 'Calendar', url: url('event/3') },
        { time: at(+120), text: 'Customer call – rollout plan for the new pricing pages', source: 'Calendar' },
        { text: 'Out of office: Sam', source: 'Calendar' },
      ],
      tasks: [
        { id: 'ABC-101', text: 'Fix login redirect loop', source: 'Tracker', url: url('ABC-101') },
        { id: 'ABC-87', text: 'Write migration guide for v2 API', source: 'Tracker', url: url('ABC-87') },
        { id: 'OPS-7', text: 'Rotate staging certificates', source: 'Tracker' },
        { id: 'ABC-120', text: 'Clean up feature flags', source: 'Tracker', url: url('ABC-120') },
        { id: 'ABC-121', text: 'Update onboarding docs', source: 'Tracker' },
      ],
      lists: [{ source: 'Tracker', url: url('my-issues') }],
      alerts: [
        { id: 'web#412', text: 'Review requested: new pricing page', source: 'Code review', url: url('pr/412') },
        { id: 'API-5XX', text: 'Error rate above 2 % on /checkout', source: 'Monitoring', url: url('alert/9') },
        { text: '3 dependency updates waiting for review', source: 'Code review', url: url('deps') },
      ],
    },
    true,
  )
}

const openPane = ($: Engine) => $.ui.open({ id: PANE, title: 'Today' })

/** Today's last real snapshot from the store, or undefined when it is from another day. */
async function loadLast($: Engine): Promise<Snapshot | undefined> {
  const last = (await $.store.get(STORE_LAST)) as { date?: string; snapshot?: Snapshot } | undefined
  // A snapshot stored by an older version has no takenAt; it is dropped, /today gets a new one.
  if (last?.date !== todayKey() || !last.snapshot?.takenAt) return undefined
  return { ...normalize(last.snapshot), takenAt: last.snapshot.takenAt }
}

/** Minutes since the data was taken, across midnight too; undefined when there is no data. */
function ageOf(s: Snapshot): number | undefined {
  return s.takenAt ? Math.max(0, Math.floor((Date.now() - s.takenAt) / 60_000)) : undefined
}

/**
 * Whether auto-refresh should ask now: during the workday, with the pane on screen, no demo
 * showing, and `every` minutes since the data and the last ask. The refresh runs in a background
 * agent, so a running turn or text in the prompt box does not hold it back.
 */
async function isRefreshDue(
  $: Engine,
  o: { every: number; dayStart: number; dayEnd: number; lastAsked: number },
): Promise<boolean> {
  const now = nowMinutes()
  if (now < o.dayStart || now >= o.dayEnd) return false
  if (Date.now() - o.lastAsked < o.every * 60_000) return false
  const [s, panes] = await Promise.all([read($, snapshot), $.ui.panes()])
  if (s.isDemo || !panes.some(p => p.id === PANE && p.isPlaced)) return false
  return (ageOf(s) ?? Infinity) >= o.every
}

type RefreshState = {
  /** When the last refresh was asked for (ms), so auto-refresh never asks twice in one interval. */
  lastAsked: number
  /** A turn of the chat is running; a prompt is never dropped into the middle of work. */
  isBusy: boolean
  /**
   * Prompts commands queue: the engine refuses a prompt submitted from inside command.run (it
   * would wait on the turn the command holds), so turn.complete sends them.
   */
  queue: string[]
  /** The background agent gathering data right now, and when it started. */
  refreshing?: { agentId: string; since: number }
}

/**
 * Gathers fresh data in a background agent, so the chat stays free and nothing waits for the
 * current turn. False when no agent started (background tasks off, a limit, a refusal).
 */
async function refresh($: Engine, st: RefreshState, prompt: string): Promise<boolean> {
  // One at a time; an agent that never reported back is given up after 10 minutes.
  if (st.refreshing && Date.now() - st.refreshing.since < 10 * 60_000) return true
  st.lastAsked = Date.now()
  const r = await $.agent.spawn({ prompt, description: 'Refresh the Today pane' }).catch(() => undefined)
  if (!r || 'deny' in r) return false
  // The engine sets agentId on every agent it started; turn.complete matches the agent's end by it.
  st.refreshing = { agentId: r.agentId ?? '', since: Date.now() }
  $.ui.invalidate('ui.render')
  return true
}

/** The fallback without a background agent: the refresh as a turn in the chat, when it is idle. */
async function refreshInChat($: Engine, st: RefreshState, prompt: string) {
  const box = await $.prompt.read()
  if (st.isBusy || st.queue.length || box.text.trim()) return
  st.lastAsked = Date.now()
  // A refused submit is retried by the next due tick; nothing to report in the pane.
  $.prompt.submit({ text: prompt }).catch(() => undefined)
}

const HELP = ([
  ['/today', 'gather fresh data and show the pane'],
  ['/today on', 'open the pane when a session starts'],
  ['/today off', 'close it and keep it closed'],
  ['/today show', 'show the pane, no new data'],
  ['/today hide', 'hide the pane for now'],
  ['/today hide <card>', 'hide one card: workday, timeline, focus, heads-up'],
  ['/today show <card>', 'bring it back'],
  ['/today demo', 'sample data, to see every state of the pane'],
  ['/today demo off', 'back to your own data'],
  ['/today config', 'print the settings (change them in /config)'],
] as const)
  .map(([cmd, what]) => `${cmd.padEnd(20)}${what}`)
  .join('\n')

export const register: Register = (on, options) => {
  const sources = String(options.sources ?? '').trim()
  const start = minutes(String(options.dayStart ?? '')) ?? DEFAULT_START
  const end = minutes(String(options.dayEnd ?? '')) ?? DEFAULT_END
  // Overnight ranges are not supported; an end before the start falls back to the defaults.
  const isDayValid = end > start
  const [dayStart, dayEnd] = isDayValid ? [start, end] : [DEFAULT_START, DEFAULT_END]
  // A whole number from the settings, clamped to [min, max]; unset or invalid gives the fallback.
  // With `canBeOff`, 0 means off and stays 0.
  const count = (v: unknown, fallback: number, max: number, min = 1, canBeOff = false) => {
    const n = Math.round(Number(v))
    if (String(v ?? '').trim() === '' || !Number.isFinite(n) || n < 0) return fallback
    if (n === 0) return canBeOff ? 0 : fallback
    return Math.min(max, Math.max(min, n))
  }
  const focusCount = count(options.focusCount, 3, 20)
  const maxTasks = Math.max(focusCount, count(options.maxTasks, 7, 50))
  const maxAlerts = count(options.maxAlerts, 5, 20)
  const maxEvents = count(options.maxEvents, 8, 30)
  // Off by default; when on, at least 15 minutes apart, so a day stays around 30 requests at most.
  const autoRefresh = count(options.autoRefresh, 0, 240, 15, true)
  // 0 turns the stale warning off.
  const staleAfter = count(options.staleAfter, 60, 24 * 60, 1, true)
  // On by default: a new session asks for fresh data once, unless it is under 15 minutes old.
  const refreshOnStart = options.refreshOnStart !== false && options.refreshOnStart !== 'false'

  const paletteName = String(options.palette)
  const palette: Palette = Object.hasOwn(PALETTES, paletteName) ? (paletteName as Palette) : 'calm'
  const base = PALETTES[palette]
  const C: Colors = {
    accent: colorOf(options.colorWorkday) ?? base.accent,
    events: colorOf(options.colorTimeline) ?? base.events,
    tasks: colorOf(options.colorFocus) ?? base.tasks,
    alerts: colorOf(options.colorHeadsUp) ?? base.alerts,
    ok: base.ok,
  }

  const refreshPrompt = (isPaneShown: boolean) => todayPrompt(sources, maxTasks, maxAlerts, isPaneShown)

  const configText = () => {
    // Label, value, setting keys: the values pad to one width, so the keys line up.
    const rows: [string, string, string][] = [
      ['Workday', `${fmt(dayStart)}–${fmt(dayEnd)}`, 'dayStart, dayEnd'],
      ['Focus shows', `${focusCount} tasks`, 'focusCount'],
      ['Tasks fetched', `up to ${maxTasks}`, 'maxTasks'],
      ['Heads-up shows', `${maxAlerts} items`, 'maxAlerts'],
      ['Timeline shows', `${maxEvents} events`, 'maxEvents'],
      ['Stale after', staleAfter ? `${staleAfter} min` : 'never', 'staleAfter'],
      ['Refresh on start', refreshOnStart ? 'on' : 'off', 'refreshOnStart'],
      ['Auto-refresh', autoRefresh ? `every ${autoRefresh} min, during the workday` : 'off', 'autoRefresh'],
      ['Preferred sources', sources || 'whatever is connected', 'sources'],
      ['Palette', palette, 'palette'],
    ]
    const LABEL_W = 18
    const valueW = Math.max(...rows.map(r => r[1].length)) + 3
    return [
      'workday settings. Change them in /config.',
      ...rows.map(([label, value, keys]) => `  ${label.padEnd(LABEL_W)}${value.padEnd(valueW)}(${keys})`),
      ...(isDayValid ? [] : ['  ← your workday ends before it starts, using the default']),
      `  ${'Card colors'.padEnd(LABEL_W)}workday ${C.accent} · timeline ${C.events} · focus ${C.tasks} · heads-up ${C.alerts}`,
      `  ${' '.repeat(LABEL_W)}(colorWorkday, colorTimeline, colorFocus, colorHeadsUp: #hex or a theme name)`,
    ].join('\n')
  }

  // When the last refresh was asked for, whether the chat is busy, queued prompts, the background refresh.
  const st: RefreshState = { lastAsked: 0, isBusy: false, queue: [] }
  const queue = st.queue
  // session.start can fire again (resume, clear); the minute clock is set up once.
  let isTicking = false
  // The same prompt twice in one turn is one request; a second /today must not ask Claude again.
  const ask = (text: string) => {
    if (!queue.includes(text)) queue.push(text)
  }
  on('turn.start', async (_$, e, next) => {
    // A subagent's turn, the refresh's own included, does not make the chat busy.
    if (!e.agentId) st.isBusy = true
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId) {
      if (e.agentId !== st.refreshing?.agentId) return result
      const { since } = st.refreshing
      st.refreshing = undefined
      const s = await read($, snapshot)
      // The agent ended without filling the pane: say so instead of leaving old data unexplained.
      if ((s.takenAt ?? 0) < since) $.ui.toast('Today: the refresh brought no new data. /today in the chat shows why.')
      $.ui.invalidate('ui.render')
      return result
    }
    st.isBusy = false
    for (const text of queue.splice(0)) $.prompt.submit({ text }).catch(() => undefined)
    return result
  })

  on('session.start', async ($, e, next) => {
    const [, , , savedHidden, last, isOn] = await Promise.all([
      $.command.register({
        name: 'today',
        description: 'Your day in a pane: events, tasks, heads-up',
        argumentHint: '[on|off|show|hide|demo|config|help] [card]',
      }),
      $.command.register({
        name: 'wrapup',
        description: 'End-of-day report: done, open, tomorrow, time blocks',
        argumentHint: '[note]',
      }),
      $.tool.register({
        name: TOOL,
        description: "Fills the user's Today pane with events, tasks and alerts. Call it after /today.",
        inputSchema: {
          type: 'object',
          properties: { events: itemList, tasks: itemList, alerts: itemList, lists: listLinks },
        },
        isDeferred: false,
      }),
      $.store.get(STORE_HIDDEN),
      loadLast($),
      $.store.get(STORE_ON),
    ])
    // Hidden cards and today's last snapshot outlive the session; yesterday's snapshot does not.
    const cards = Array.isArray(savedHidden) ? savedHidden.filter((x): x is Section => SECTIONS.includes(x)) : []
    await Promise.all([
      update($, hidden, () => cards),
      last ? update($, snapshot, () => last) : undefined,
    ])
    if (isOn === true) void openPane($)
    // Once a minute: redraw (clock, progress line, age of the data move on), and, when the user
    // turned auto-refresh on, ask for fresh data if it is due.
    if (isTicking) return next(e)
    isTicking = true
    // Fresh data for a new session, unless the pane was turned off. A moment's wait lets the
    // session settle; a turn the user starts first wins, the refresh then waits for auto-refresh.
    if (refreshOnStart && isOn !== false) {
      $.clock.after(3_000, async () => {
        if (queue.length) return
        const [s, pid, env] = await Promise.all([
          read($, snapshot),
          $.store.get(STORE_STARTED),
          $.process.hookEnv().catch(() => ({}) as Record<string, string>),
        ])
        // Same process as the last start refresh: a reload of the mod, not a new start.
        const now = env.CLAUDE_PID
        if (now && pid === now) return
        if (now) await $.store.set(STORE_STARTED, now)
        if ((ageOf(s) ?? Infinity) < 15) return
        if (!(await refresh($, st, refreshPrompt(true)))) await refreshInChat($, st, refreshPrompt(true))
      })
    }
    $.clock.every(60_000, async () => {
      $.ui.invalidate('ui.render')
      if (!autoRefresh || queue.length || st.refreshing) return
      if (!(await isRefreshDue($, { every: autoRefresh, dayStart, dayEnd, lastAsked: st.lastAsked }))) return
      if (!(await refresh($, st, refreshPrompt(true)))) await refreshInChat($, st, refreshPrompt(true))
    })

    return next(e)
  })

  on('command.run', { command: 'today' }, async ($, e) => {
    const [verb = '', arg = ''] = e.args.trim().toLowerCase().split(/\s+/)

    switch (verb) {
      case 'help':
        return { text: HELP }
      case 'config':
        return { text: configText() }

      case 'on':
        await Promise.all([$.store.set(STORE_ON, true), openPane($)])
        return { text: 'On. The pane opens when a session starts, in terminals at least 144 columns wide.' }
      case 'off':
        await Promise.all([$.store.set(STORE_ON, false), $.ui.close({ id: PANE })])
        return { text: 'Off. The pane stays closed until you run /today on.' }

      case 'hide':
      case 'show': {
        const isHiding = verb === 'hide'
        if (!arg) {
          if (isHiding) await $.ui.close({ id: PANE })
          else await openPane($)
          return { text: isHiding ? 'Hidden for now. /today show brings it back.' : 'Shown.' }
        }
        const section = SECTIONS.find(s => s.replace('-', '') === arg.replace('-', ''))
        if (!section) return { text: `There is no "${arg}" card. Try ${SECTIONS.join(', ')}.` }
        const list = await update($, hidden, cur =>
          isHiding ? [...new Set([...cur, section])] : cur.filter(x => x !== section),
        )
        await $.store.set(STORE_HIDDEN, list)
        return { text: isHiding ? `${section} hidden. /today show ${section} brings it back.` : `${section} is back.` }
      }

      case 'demo': {
        if (arg && arg !== 'on' && arg !== 'off') return { text: 'That would be /today demo or /today demo off.' }
        // Demo off goes back to today's data as last gathered, with no new request.
        const data = arg === 'off' ? ((await loadLast($)) ?? EMPTY) : demoSnapshot()
        // A refresh still waiting would overwrite what the person just asked to see.
        queue.length = 0
        await Promise.all([update($, snapshot, () => data), openPane($)])
        return {
          text: arg === 'off'
            ? 'Demo off. This is your data again.'
            : 'Demo on. The pane shows sample data now; /today demo off gets yours back.',
        }
      }

      case '':
      case 'refresh': {
        const { isPlaced } = await openPane($)
        // Where the pane shows, a background agent fills it. Where it cannot show, the result
        // has to be listed in the chat, so the refresh runs there as a turn.
        if (isPlaced && (await refresh($, st, refreshPrompt(true)))) {
          return { text: 'Gathering in the background. The pane fills in when it is done.' }
        }
        st.lastAsked = Date.now()
        ask(refreshPrompt(isPlaced))
        return { text: 'Looking through your tools…' }
      }

      default:
        return { text: HELP }
    }
  })

  on('command.run', { command: 'wrapup' }, async (_$, e) => {
    ask(wrapupPrompt(sources, e.args.trim()))
    return { text: 'Writing your end-of-day report…' }
  })

  on('tool.run', { tool: `mcp__workday__${TOOL}` }, async ($, e) => {
    const fresh = normalize(e as unknown as Record<string, unknown>)
    await Promise.all([
      update($, snapshot, () => fresh),
      $.store.set(STORE_LAST, { date: todayKey(), snapshot: fresh }),
    ])
    void openPane($)
    const total = fresh.events.length + fresh.tasks.length + fresh.alerts.length

    return { result: `Today pane updated (${total} items).` }
  }).catch((_$, _e, next) => {
    // Say so instead of failing silently: Claude then tells the user the pane is not up to date.
    const why = next.error.kind === 'timeout' ? 'it took too long' : (next.error.message ?? 'unknown error')
    return { result: `Today pane could not be saved: ${why}` }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Link } = $.ui.resolve(e)
    const [s, off] = await Promise.all([read($, snapshot), read($, hidden)])
    // Some air on both sides; W is the width inside it (a wider drawing is cut off at the frame).
    const PAD = 2
    const W = Math.max(20, (e.props.bodyColumns ?? 40) - 2 * PAD)
    const isWide = W >= 110
    const colW = isWide ? Math.floor((W - 2) / 2) : W
    const nowMin = nowMinutes()

    // A section: a colored label with the title, a figure on the right, the body indented below.
    const card = (color: string, title: string, sub: RenderChildren, right: string, body: RenderChildren, w = colW) => (
      <Box flexDirection="column" width={w} marginBottom={1}>
        <Box justifyContent="space-between">
          <Box flexShrink={1}>
            <Text wrap="truncate">
              <Text color={color}>▌</Text>
              <Text backgroundColor={color} color="inverseText" bold>{` ${title} `}</Text>
            </Text>
            {sub}
          </Box>
          <Box flexShrink={0}>
            <Text color={color}>{right}</Text>
          </Box>
        </Box>
        <Box paddingLeft={2} paddingRight={1} flexDirection="column">
          {body}
        </Box>
      </Box>
    )

    // A list of rows whose marks, keys, titles and arrows line up, then "+ N more".
    // `lead` is the width of the mark column; `mark(x, i)` draws it, `dim(x, i)` fades a row.
    const list = (
      items: Item[],
      total: number,
      color: string,
      lead: number,
      mark: (x: Item, i: number) => RenderChildren,
      dim: (x: Item, i: number) => boolean = () => false,
    ) => {
      const longest = Math.max(0, ...items.map(x => x.id?.length ?? 0))
      // Long keys (repo#123) are cut in the middle, so the prefix and the number both stay.
      const keyW = longest ? Math.min(longest, 12) + 1 : 0
      return (
        <Box flexDirection="column">
          {items.map((x, i) => {
            const isDim = dim(x, i)
            const title = (
              <Text dimColor={isDim} wrap="truncate-end">
                {x.text}
              </Text>
            )
            return (
              <Box>
                <Box width={lead} flexShrink={0}>
                  {mark(x, i)}
                </Box>
                {keyW > 0 && (
                  <Box width={keyW} paddingRight={1} flexShrink={0}>
                    <Text color={color} bold dimColor={isDim} wrap="truncate-middle">
                      {x.id ?? ''}
                    </Text>
                  </Box>
                )}
                <Box flexGrow={1} flexShrink={1}>
                  {x.url ? <Link href={x.url}>{title}</Link> : title}
                </Box>
                <Box width={2} flexShrink={0} justifyContent="flex-end">
                  <Text dimColor>{x.url ? '↗' : ' '}</Text>
                </Box>
              </Box>
            )
          })}
          {total > items.length && (
            <Box marginLeft={lead + keyW}>
              <Text dimColor>{`+ ${total - items.length} more`}</Text>
            </Box>
          )}
        </Box>
      )
    }

    // ---- title line: the day on the left, a color key on the right, a rule below
    const titleBar = (
      <Box flexDirection="column" marginBottom={1} width={W}>
        <Box justifyContent="space-between">
          <Box flexShrink={1}>
            {/* The sky of the time of day: a moon at night, a sunrise in the morning, and so on. */}
            <Box flexShrink={0} marginRight={1}>
              <Text>{SKY[dayPart(nowMin)]}</Text>
            </Box>
          <Text wrap="truncate">
            <Text color={C.accent} bold>{greeting(nowMin)}</Text>
            <Text bold>{`  ${DATE.format(new Date())}`}</Text>
            <Text dimColor>{`  ${fmt(nowMin)}`}</Text>
            {s.isDemo ? <Text color={C.accent} bold>{'  · DEMO'}</Text> : null}
          </Text>
          </Box>
          {/* The color key only where it fits next to the day; the cards carry their colors anyway. */}
          {W >= 72 && (
            <Box flexShrink={0}>
              <Text>
                <Text color={C.events}>●</Text>
                <Text dimColor> events </Text>
                <Text color={C.tasks}>●</Text>
                <Text dimColor> tasks </Text>
                <Text color={C.alerts}>●</Text>
                <Text dimColor> heads-up</Text>
              </Text>
            </Box>
          )}
        </Box>
        <Text dimColor>{'┄'.repeat(W)}</Text>
      </Box>
    )

    // ---- events: past, next, later (all-day ones have no start and are never past)
    const isPast = (x: Item) => x.start !== undefined && x.start < nowMin
    const nextIdx = s.events.findIndex(x => x.start !== undefined && x.start >= nowMin)
    const next = s.events[nextIdx]

    // ---- workday: the day's progress and what comes next
    const span = dayEnd - dayStart
    const pct = Math.round((Math.min(span, Math.max(0, nowMin - dayStart)) / span) * 100)
    const [doneBar, restBar] = bar(pct, Math.max(6, Math.min(24, colW - 12)))
    let nextText = 'no events today'
    if (next?.start !== undefined) nextText = `next ${next.time} ${next.text} · in ${until(next.start - nowMin)}`
    else if (s.events.length) nextText = 'no more events today'
    let status = '● on'
    if (nowMin >= dayEnd) status = '○ off'
    else if (nowMin < dayStart) status = '○ not yet'
    const workday = (w = colW) =>
      card(
        C.accent,
        'WORKDAY',
        <Text color={C.accent} wrap="truncate">{`  ${fmt(dayStart)}–${fmt(dayEnd)}`}</Text>,
        status,
        <Box flexDirection="column">
          <Text>
            <Text color={C.accent}>{doneBar}</Text>
            <Text dimColor>{restBar}</Text>
            <Text bold>{` ${pct}%`}</Text>
          </Text>
          <Text dimColor={!next} wrap="truncate-end">
            {nextText}
          </Text>
        </Box>,
        w,
      )

    // ---- timeline: a window of maxEvents, starting with the last event before now
    const timeline = () => {
      if (s.events.length === 0) return null
      const pastCount = s.events.filter(isPast).length
      const from = Math.max(0, Math.min(pastCount - 1, s.events.length - maxEvents))
      const shown = s.events.slice(from, from + maxEvents)
      const hereNext = nextIdx - from
      return card(
        C.events,
        'TIMELINE',
        null,
        `${s.events.length} event${s.events.length === 1 ? '' : 's'}`,
        <Box flexDirection="column">
          {from > 0 && <Text dimColor>{`${' '.repeat(8)}${from} earlier`}</Text>}
          {list(
            shown,
            s.events.length - from,
            C.events,
            8,
            (x, i) => {
              const isNext = i === hereNext
              const mark = isPast(x) ? '✓' : isNext ? '▶' : '◇'
              return (
                <Text dimColor={isPast(x)} bold={isNext} color={isNext ? C.events : undefined}>
                  {`${(x.time ?? '--:--').padEnd(5)} ${mark}`}
                </Text>
              )
            },
            isPast,
          )}
        </Box>,
      )
    }

    // The trackers behind the tasks, each a link to its list of open items when Claude sent one.
    const trackerLinks = () => {
      const names = [...new Set(s.tasks.map(x => x.source).filter((x): x is string => !!x))]
      if (!names.length) return null
      return (
        <Box marginLeft={2} flexShrink={1}>
          {names.map((name, i) => {
            const url = s.lists?.find(l => l.source === name)?.url
            const label = <Text color={C.tasks} wrap="truncate">{name}</Text>
            return (
              <Box flexShrink={1}>
                {i > 0 ? <Text color={C.tasks}>{' · '}</Text> : null}
                {url ? <Link href={url}>{label}</Link> : label}
              </Box>
            )
          })}
        </Box>
      )
    }

    // ---- focus: top tasks, numbered
    const tasks = () =>
      card(
        C.tasks,
        'FOCUS',
        trackerLinks(),
        `${s.tasks.length} open`,
        s.tasks.length === 0 ? (
          <Text dimColor>nothing open</Text>
        ) : (
          list(s.tasks.slice(0, focusCount), s.tasks.length, C.tasks, 3, (_x, i) => (
            <Text color={C.tasks} bold>{String(i + 1)}</Text>
          ))
        ),
      )

    // ---- heads-up: red with items, green when quiet
    const headsUp = () => {
      const isQuiet = s.alerts.length === 0
      return card(
        isQuiet ? C.ok : C.alerts,
        'HEADS-UP',
        null,
        String(s.alerts.length),
        isQuiet ? (
          <Text color={C.ok}>✓ all quiet</Text>
        ) : (
          list(s.alerts.slice(0, maxAlerts), s.alerts.length, C.alerts, 2, () => (
            <Text color={C.alerts} bold>⚠</Text>
          ))
        ),
      )
    }

    // How old the data is; past `staleAfter` minutes the note turns into a warning.
    const age = ageOf(s)
    const isStale = staleAfter > 0 && age !== undefined && age >= staleAfter
    let ageText = ''
    if (age !== undefined) ageText = age < 1 ? 'updated just now' : `updated ${until(age)} ago`
    if (isStale && age !== undefined) ageText = `⚠ ${until(age)} old · stale`
    if (st.refreshing) ageText = 'updating…'
    // Minutes until auto-refresh asks again; undefined when it is off, outside the workday, or in demo.
    const isWorkTime = nowMin >= dayStart && nowMin < dayEnd
    const nextAuto =
      autoRefresh && isWorkTime && !s.isDemo && age !== undefined
        ? Math.max(0, Math.ceil(autoRefresh - Math.min(age, (Date.now() - st.lastAsked) / 60_000)))
        : undefined
    const hiddenNote = off.length ? ` · hidden: ${off.join(', ')}` : ''
    const footer = (
      <Box justifyContent="space-between" width={W}>
        {/* No refresh button: Enter in a focused pane would press it, and each press costs a request. */}
        <Text dimColor={!isStale} color={isStale ? C.alerts : undefined} bold={isStale}>
          {nextAuto === undefined ? '/today to refresh' : `next refresh in ${until(nextAuto)}`}
        </Text>
        <Text wrap="truncate-start">
          <Text dimColor={!isStale} color={isStale ? C.alerts : undefined}>{ageText}</Text>
          <Text dimColor>{hiddenNote}</Text>
        </Text>
      </Box>
    )

    const show = (x: Section, el: () => RenderChildren) => (off.includes(x) ? null : el())

    if (!s.takenAt) {
      return (
        <Box flexDirection="column" paddingX={PAD} paddingTop={1}>
          {titleBar}
          {show('workday', () => workday(W))}
          <Text dimColor>Empty so far. Run /today, or /today demo to see a full pane.</Text>
          {footer}
        </Box>
      )
    }

    const body = isWide ? (
      <Box columnGap={2}>
        <Box flexDirection="column" width={colW}>
          {show('workday', workday)}
          {show('timeline', timeline)}
        </Box>
        <Box flexDirection="column" width={colW}>
          {show('focus', tasks)}
          {show('heads-up', headsUp)}
        </Box>
      </Box>
    ) : (
      <Box flexDirection="column">
        {show('workday', workday)}
        {show('heads-up', headsUp)}
        {show('timeline', timeline)}
        {show('focus', tasks)}
      </Box>
    )

    return (
      <Box flexDirection="column" paddingX={PAD} paddingTop={1}>
        {titleBar}
        {body}
        {footer}
      </Box>
    )
  })
}
