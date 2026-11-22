import { atom, read, update } from 'claude-code'
import type { Register, RenderChildren } from 'claude-code'

import type { Item, Section, Snapshot } from '../types'

const PANE = 'today'
const TOOL = 'update_today'
const EMPTY: Snapshot = { events: [], tasks: [], alerts: [], updatedAt: '' }
const SECTIONS: readonly Section[] = ['workday', 'timeline', 'focus', 'heads-up']
const STORE_HIDDEN = 'hidden-sections'
const STORE_ON = 'open-on-start'
const STORE_LAST = 'last-snapshot'

type Colors = { accent: string; events: string; tasks: string; alerts: string; ok: string }
type Palette = 'theme' | 'pastel' | 'mono'

// `theme` uses theme keys, so the pane follows the user's light or dark theme.
const PALETTES: Record<Palette, Colors> = {
  theme: { accent: 'claude', events: 'suggestion', tasks: 'merged', alerts: 'error', ok: 'success' },
  pastel: { accent: '#fdba74', events: '#93c5fd', tasks: '#c4b5fd', alerts: '#fca5a5', ok: '#86efac' },
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
  shape: 'snapshot-3',
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

const LANGUAGE =
  'Write in the language the user normally uses with you in this session (e.g. German if they write German).'

const sourcesHint = (sources: string) => (sources ? `Preferred sources: ${sources}.` : '')

function todayPrompt(sources: string, maxTasks: number, maxAlerts: number): string {
  return [
    'Refresh my Today pane.',
    'Use whatever tools are connected in this session to find what is on my plate today:',
    '- Calendar: my events today, sorted by start time',
    `- Ticket or task tracker: open items assigned to me, most important first (at most ${maxTasks})`,
    `- Monitoring or error tracking: what is on fire right now (open alerts, new errors)`,
    `At most ${maxAlerts * 2} heads-up items in total, most urgent first.`,
    '- Inbox and code review: only things where someone waits for me (a question, a requested change, a review). Skip pure notifications such as "merged" or "pushed".',
    'Give every item its key (`id`) and a `url` that opens it, wherever the tool returns one.',
    'Skip any source that is not connected, without asking. Read only, change nothing.',
    sourcesHint(sources),
    LANGUAGE,
    `Then call mcp__workday__${TOOL} with the result and reply in chat with a single line.`,
  ]
    .filter(Boolean)
    .join('\n')
}

function wrapupPrompt(sources: string, note: string): string {
  return [
    'Write my end-of-day report for today. Read only, change nothing.',
    'Sources, as available:',
    '- this session: what we worked on',
    '- git: `git log --since=midnight --author="$(git config user.email)"` in the repositories under the working directory',
    '- ticket or task tracker: what I closed, moved or commented on today',
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

// Segmented bar, as claude-flightdeck draws its gauges.
function gauge(pct: number, width: number) {
  const full = Math.max(0, Math.min(width, Math.round((pct / 100) * width)))
  return { on: '▰'.repeat(full), off: '▱'.repeat(width - full) }
}

function minutes(hhmm: string | undefined): number | undefined {
  const m = /^(\d{1,2}):(\d{2})/.exec(hhmm ?? '')
  return m ? Number(m[1]) * 60 + Number(m[2]) : undefined
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

function toItems(value: unknown): Item[] {
  if (!Array.isArray(value)) return []
  const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined)
  return value
    .filter(x => x && typeof x.text === 'string')
    .map(x => ({
      text: String(x.text),
      id: str(x.id),
      time: str(x.time),
      source: str(x.source),
      url: /^https:\/\//.test(String(x.url ?? '')) ? String(x.url) : undefined,
    }))
}

/** Sample data that shows every state of the pane: past, next and later events, overflow, links, alerts. */
function demoSnapshot(): Snapshot {
  const t = nowMinutes()
  const updatedAt = fmt(t)
  const url = (path: string) => `https://example.com/${path}`
  return {
    events: [
      { time: fmt(t - 150), text: 'Daily standup', source: 'Calendar', url: url('event/1') },
      { time: fmt(t - 60), text: 'Design review: checkout flow', source: 'Calendar' },
      { time: fmt(t + 25), text: '1:1 with team lead', source: 'Calendar', url: url('event/3') },
      { time: fmt(t + 120), text: 'Customer call – rollout plan for the new pricing pages', source: 'Calendar' },
    ],
    tasks: [
      { id: 'ABC-101', text: 'Fix login redirect loop', source: 'Tracker', url: url('ABC-101') },
      { id: 'ABC-87', text: 'Write migration guide for v2 API', source: 'Tracker', url: url('ABC-87') },
      { id: 'OPS-7', text: 'Rotate staging certificates', source: 'Tracker' },
      { id: 'ABC-120', text: 'Clean up feature flags', source: 'Tracker', url: url('ABC-120') },
      { id: 'ABC-121', text: 'Update onboarding docs', source: 'Tracker' },
    ],
    alerts: [
      { id: 'web#412', text: 'Review requested: new pricing page', source: 'Code review', url: url('pr/412') },
      { id: 'API-5XX', text: 'Error rate above 2 % on /checkout', source: 'Monitoring', url: url('alert/9') },
      { text: '3 dependency updates waiting for review', source: 'Code review', url: url('deps') },
    ],
    updatedAt,
    isDemo: true,
  }
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
  const dayStart = minutes(String(options.dayStart ?? '09:00')) ?? 9 * 60
  const dayEnd = minutes(String(options.dayEnd ?? '18:00')) ?? 18 * 60
  const count = (v: unknown, fallback: number, max: number) => {
    const n = Math.round(Number(v))
    return Number.isFinite(n) && n >= 1 ? Math.min(n, max) : fallback
  }
  const focusCount = count(options.focusCount, 3, 20)
  const maxTasks = Math.max(focusCount, count(options.maxTasks, 7, 50))
  const maxAlerts = count(options.maxAlerts, 5, 20)
  const maxEvents = count(options.maxEvents, 8, 30)

  const palette: Palette = (['theme', 'pastel', 'mono'] as const).find(p => p === options.palette) ?? 'theme'
  const base = PALETTES[palette]
  const C: Colors = {
    accent: colorOf(options.colorWorkday) ?? base.accent,
    events: colorOf(options.colorTimeline) ?? base.events,
    tasks: colorOf(options.colorFocus) ?? base.tasks,
    alerts: colorOf(options.colorHeadsUp) ?? base.alerts,
    ok: base.ok,
  }

  const configText = () =>
    [
      'workday settings. Change them in /config.',
      `  Workday           ${fmt(dayStart)}–${fmt(dayEnd)}   (dayStart, dayEnd)`,
      `  Focus shows       ${focusCount} tasks             (focusCount)`,
      `  Tasks fetched     up to ${maxTasks}            (maxTasks)`,
      `  Heads-up shows    ${maxAlerts} items             (maxAlerts)`,
      `  Timeline shows    ${maxEvents} events            (maxEvents)`,
      `  Preferred sources ${sources || 'whatever is connected'}   (sources)`,
      `  Palette           ${palette}             (palette)`,
      `  Card colors       workday ${C.accent} · timeline ${C.events} · focus ${C.tasks} · heads-up ${C.alerts}`,
      '                    (colorWorkday, colorTimeline, colorFocus, colorHeadsUp: #hex or a theme name)',
    ].join('\n')

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'today',
      description: 'Your day in a pane: events, tasks, heads-up',
      argumentHint: '[on|off|show|hide|demo|config|help] [card]',
    })
    await $.command.register({
      name: 'wrapup',
      description: 'End-of-day report: done, open, tomorrow, time blocks',
      argumentHint: '[note]',
    })
    await $.tool.register({
      name: TOOL,
      description:
        "Fills the user's Today pane with events, tasks and alerts. Call it after /today.",
      inputSchema: {
        type: 'object',
        properties: { events: itemList, tasks: itemList, alerts: itemList },
      },
      isDeferred: false,
    })
    // Hidden cards outlive the session.
    const saved = await $.store.get(STORE_HIDDEN)
    if (Array.isArray(saved)) {
      const list = saved.filter((x): x is Section => SECTIONS.includes(x as Section))
      await update($, hidden, () => list)
    }
    // Today's last snapshot comes back in a new session; yesterday's does not.
    const last = (await $.store.get(STORE_LAST)) as { date?: string; snapshot?: Snapshot } | undefined
    if (last?.date === todayKey() && last.snapshot?.updatedAt) {
      const saved = last.snapshot
      await update($, snapshot, () => saved)
    }
    if ((await $.store.get(STORE_ON)) === true) void $.ui.open({ id: PANE, title: 'Today' })

    return next(e)
  })

  on('command.run', { command: 'today' }, async ($, e) => {
    const [verb = '', arg = ''] = e.args.trim().toLowerCase().split(/\s+/)
    const open = () => $.ui.open({ id: PANE, title: 'Today' })

    if (verb === 'help') return { text: HELP }
    if (verb === 'config') return { text: configText() }

    if (verb === 'on' || verb === 'off') {
      await $.store.set(STORE_ON, verb === 'on')
      if (verb === 'off') {
        await $.ui.close({ id: PANE })
        return { text: 'Off. The pane stays closed until you run /today on.' }
      }
      await open()
      return { text: 'On. The pane opens when a session starts, in terminals at least 144 columns wide.' }
    }

    if (verb === 'hide' || verb === 'show') {
      if (!arg) {
        if (verb === 'hide') {
          await $.ui.close({ id: PANE })
          return { text: 'Hidden for now. /today show brings it back.' }
        }
        await open()
        return { text: 'Shown.' }
      }
      const section = SECTIONS.find(s => s === arg || s.replace('-', '') === arg.replace('-', ''))
      if (!section) return { text: `There is no "${arg}" card. Try ${SECTIONS.join(', ')}.` }
      const list = await update($, hidden, cur =>
        verb === 'hide' ? [...new Set([...cur, section])] : cur.filter(x => x !== section),
      )
      await $.store.set(STORE_HIDDEN, list)
      await open()
      return { text: verb === 'hide' ? `${section} hidden. /today show ${section} brings it back.` : `${section} is back.` }
    }

    if (verb === 'demo') {
      if (arg === 'off') {
        // Back to today's real data, as last gathered; no new request.
        const last = (await $.store.get(STORE_LAST)) as { date?: string; snapshot?: Snapshot } | undefined
        const real = last?.date === todayKey() && last.snapshot ? last.snapshot : EMPTY
        await update($, snapshot, () => real)
        await open()
        return { text: 'Demo off. This is your data again.' }
      }
      if (arg && arg !== 'on') return { text: 'That would be /today demo or /today demo off.' }
      await update($, snapshot, () => demoSnapshot())
      await open()
      return { text: 'Demo on. The pane shows sample data now; /today demo off gets yours back.' }
    }

    if (verb && verb !== 'refresh') return { text: HELP }

    await open()
    void $.prompt.submit({ text: todayPrompt(sources, maxTasks, maxAlerts) })
    return { text: 'Looking through your tools…' }
  })

  on('command.run', { command: 'wrapup' }, async ($, e) => {
    void $.prompt.submit({ text: wrapupPrompt(sources, e.args.trim()) })

    return { text: 'Writing your end-of-day report…' }
  })

  on('tool.run', { tool: `mcp__workday__${TOOL}` }, async ($, e) => {
    const input = e as unknown as Record<string, unknown>
    const fresh: Snapshot = {
      events: toItems(input.events).sort(
        (a, b) => (minutes(a.time) ?? 0) - (minutes(b.time) ?? 0),
      ),
      tasks: toItems(input.tasks),
      alerts: toItems(input.alerts),
      updatedAt: fmt(nowMinutes()),
    }
    await update($, snapshot, () => fresh)
    await $.store.set(STORE_LAST, { date: todayKey(), snapshot: fresh })
    void $.ui.open({ id: PANE, title: 'Today' })
    const count = fresh.events.length + fresh.tasks.length + fresh.alerts.length

    return { result: `Today pane updated (${count} items).` }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Link, Button } = $.ui.resolve(e)
    const [s, off] = await Promise.all([read($, snapshot), read($, hidden)])
    const isShown = (x: Section) => !off.includes(x)
    // The body's own width; a wider drawing is cut off at the frame.
    const W = Math.max(24, e.props.bodyColumns ?? 40)
    const isWide = W >= 110
    const colW = isWide ? Math.floor((W - 2) / 2) : W

    const now = new Date()
    const nowMin = now.getHours() * 60 + now.getMinutes()
    const date = now.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })

    const refresh = () => {
      void $.prompt.submit({ text: todayPrompt(sources, maxTasks, maxAlerts) })
    }

    // A rounded card in its section's color: title left, a figure right, then the body.
    const card = (w: number, color: string, title: string, sub: string, right: string, body: RenderChildren) => (
      <Box flexDirection="column" borderStyle="round" borderColor={color} paddingX={1} width={w} marginBottom={1}>
        <Box justifyContent="space-between">
          <Text wrap="truncate">
            <Text color={color} bold>{title}</Text>
            {sub ? <Text color={color}>{` · ${sub}`}</Text> : null}
          </Text>
          <Box flexShrink={0}>
            <Text dimColor>{right}</Text>
          </Box>
        </Box>
        {body}
      </Box>
    )

    // Column widths shared by every row of one card, so marks, keys, titles and arrows line up.
    type Cols = { lead: number; key: number }
    const colsOf = (items: Item[], lead: number): Cols => {
      const longest = Math.max(0, ...items.map(x => (x.id ? x.id.length : 0)))
      return { lead, key: longest ? Math.min(longest, 18) + 1 : 0 }
    }

    const row = (x: Item, cols: Cols, color: string, lead: RenderChildren, dim = false) => {
      const title = (
        <Text dimColor={dim} wrap="truncate-end">
          {x.text}
        </Text>
      )
      return (
        <Box>
          <Box width={cols.lead} flexShrink={0}>
            {lead}
          </Box>
          {cols.key > 0 && (
            <Box width={cols.key} flexShrink={0}>
              <Text color={color} bold dimColor={dim} wrap="truncate-end">
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
    }

    const more = (n: number, cols: Cols) =>
      n > 0 ? (
        <Box marginLeft={cols.lead + cols.key}>
          <Text dimColor>{`+ ${n} more`}</Text>
        </Box>
      ) : null

    // ---- title bar with a legend
    const titleBar = (
      <Box flexDirection="column" alignItems="center" marginBottom={1} width={W}>
        <Text wrap="truncate">
          <Text bold>TODAY</Text>
          <Text dimColor>{' · '}</Text>
          <Text color={C.accent} bold>{date}</Text>
          <Text dimColor>{` · ${fmt(nowMin)}`}</Text>
          {s.isDemo ? <Text color={C.accent} bold>{'  DEMO'}</Text> : null}
        </Text>
        <Text>
          <Text color={C.events}>■</Text>
          <Text dimColor> events  </Text>
          <Text color={C.tasks}>■</Text>
          <Text dimColor> tasks  </Text>
          <Text color={C.alerts}>■</Text>
          <Text dimColor> heads-up</Text>
        </Text>
      </Box>
    )

    // ---- workday: the day's progress and what comes next
    const span = Math.max(1, dayEnd - dayStart)
    const done = Math.min(span, Math.max(0, nowMin - dayStart))
    const pct = Math.round((done / span) * 100)
    const g = gauge(pct, Math.max(6, Math.min(20, colW - 16)))
    const nextIdx = s.events.findIndex(x => (minutes(x.time) ?? 0) >= nowMin)
    const next = nextIdx >= 0 ? s.events[nextIdx] : undefined
    const inMin = next ? (minutes(next.time) ?? nowMin) - nowMin : 0
    const nextText = next
      ? `next ${next.time} ${next.text} · in ${inMin >= 60 ? `${Math.floor(inMin / 60)}h ${inMin % 60}m` : `${inMin}m`}`
      : s.events.length
        ? 'no more events today'
        : 'no events today'
    const status = nowMin >= dayEnd ? '○ off' : nowMin < dayStart ? '○ not yet' : '● on'
    const workday = (w: number) =>
      card(
        w,
        C.accent,
        'WORKDAY',
        `${fmt(dayStart)}–${fmt(dayEnd)}`,
        status,
        <Box flexDirection="column">
          <Text>
            <Text color={C.accent}>{g.on}</Text>
            <Text dimColor>{g.off}</Text>
            <Text bold>{`  ${pct}%`}</Text>
          </Text>
          <Text dimColor={!next} wrap="truncate-end">
            {nextText}
          </Text>
        </Box>,
      )

    // ---- timeline: past dim, the next one bold, the rest plain
    // A window of maxEvents around now: one past event for context, then what comes next.
    const pivot = nextIdx === -1 ? s.events.length : nextIdx
    const evStart = Math.max(0, Math.min(pivot - 1, s.events.length - maxEvents))
    const evShown = s.events.slice(evStart, evStart + maxEvents)
    const evCols = colsOf(evShown, 8)
    const timeline = (w: number) =>
      s.events.length === 0
        ? null
        : card(
            w,
            C.events,
            'TIMELINE',
            '',
            `${s.events.length} event${s.events.length === 1 ? '' : 's'}`,
            <Box flexDirection="column">
              {evStart > 0 && <Text dimColor>{`${' '.repeat(8)}${evStart} earlier`}</Text>}
              {evShown.map((x, j) => {
                const i = evStart + j
                const isPast = nextIdx === -1 || i < nextIdx
                const isNext = i === nextIdx
                const mark = isPast ? '✓' : isNext ? '▶' : '◇'
                return row(
                  x,
                  evCols,
                  C.events,
                  <Text dimColor={isPast} bold={isNext} color={isNext ? C.events : undefined}>
                    {`${(x.time ?? '--:--').padEnd(5)} ${mark}`}
                  </Text>,
                  isPast,
                )
              })}
              {more(s.events.length - evStart - evShown.length, evCols)}
            </Box>,
          )

    // ---- focus: top tasks, numbered
    const focus = s.tasks.slice(0, focusCount)
    const taskCols = colsOf(focus, 3)
    const tasks = (w: number) =>
      card(
        w,
        C.tasks,
        'FOCUS',
        s.tasks[0]?.source ?? '',
        `${s.tasks.length} open`,
        s.tasks.length === 0 ? (
          <Text dimColor>nothing open</Text>
        ) : (
          <Box flexDirection="column">
            {focus.map((x, i) => row(x, taskCols, C.tasks, <Text color={C.tasks} bold>{String(i + 1)}</Text>))}
            {more(s.tasks.length - focus.length, taskCols)}
          </Box>
        ),
      )

    // ---- heads-up: red with items, green when quiet
    const alertsShown = s.alerts.slice(0, maxAlerts)
    const alertCols = colsOf(alertsShown, 2)
    const headsUp = (w: number) =>
      s.alerts.length === 0
        ? card(w, C.ok, 'HEADS-UP', '', '0', <Text color={C.ok}>✓ all quiet</Text>)
        : card(
            w,
            C.alerts,
            'HEADS-UP',
            '',
            String(s.alerts.length),
            <Box flexDirection="column">
              {alertsShown.map(x => row(x, alertCols, C.alerts, <Text color={C.alerts} bold>⚠</Text>))}
              {more(s.alerts.length - alertsShown.length, alertCols)}
            </Box>,
          )

    const hiddenNote = off.length ? ` · hidden: ${off.join(', ')}` : ''
    const footer = (
      <Box justifyContent="space-between" width={W}>
        <Button label="↻ Refresh" onPress={refresh} />
        <Text dimColor wrap="truncate-start">
          {(s.updatedAt ? `updated ${s.updatedAt}` : '') + hiddenNote}
        </Text>
      </Box>
    )

    if (!s.updatedAt) {
      return (
        <Box flexDirection="column">
          {titleBar}
          {isShown('workday') && workday(W)}
          <Text dimColor>Empty so far. Press Refresh, or run /today demo to see a full pane.</Text>
          {footer}
        </Box>
      )
    }

    const show = (x: Section, el: RenderChildren) => (isShown(x) ? el : null)
    const body = isWide ? (
      <Box columnGap={2}>
        <Box flexDirection="column" width={colW}>
          {show('workday', workday(colW))}
          {show('timeline', timeline(colW))}
        </Box>
        <Box flexDirection="column" width={colW}>
          {show('focus', tasks(colW))}
          {show('heads-up', headsUp(colW))}
        </Box>
      </Box>
    ) : (
      <Box flexDirection="column">
        {show('workday', workday(W))}
        {show('heads-up', headsUp(W))}
        {show('timeline', timeline(W))}
        {show('focus', tasks(W))}
      </Box>
    )

    return (
      <Box flexDirection="column">
        {titleBar}
        {body}
        {footer}
      </Box>
    )
  })
}
