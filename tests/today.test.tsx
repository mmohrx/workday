import { expect, test } from 'claude-code/testing'

const PANE = {
  plugin: 'workday',
  component: 'Pane',
  requestId: 'today',
  props: {
    title: 'Today',
    isFocused: false,
    bodyColumns: 50,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const

test('an empty pane points to /today', async $ => {
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /\/today/ }))?.text).toContain('Empty so far')
  await ui.unmount()
})

test('the tool fills the pane with links, on every surface', async ($, on) => {
  on('command.register', () => ({ value: { command: 'x' } }))
  on('tool.register', (_, e) => ({ value: e as never }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('store.get', () => ({ value: undefined }) as never)
  on('store.set', () => ({ value: undefined }) as never)

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.tool.call({
    tool: 'mcp__workday__update_today',
    events: [{ text: 'Weekly', time: '10:00', source: 'Calendar' }],
    tasks: [
      { text: 'Checkout bug', id: 'ABC-1', url: 'https://example.com/issue/ABC-1' },
      { text: 'Two', id: 'ABC-2' },
      { text: 'Three', id: 'ABC-3' },
      { text: 'Four', id: 'ABC-4' },
    ],
    alerts: [{ text: 'Bad link', url: 'javascript:alert(1)' }],
  } as never)

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ type: 'Text', text: /Weekly/ })).toBeTruthy()
    expect(await ui.find({ type: 'Link', href: 'https://example.com/issue/ABC-1' } as never)).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /\+ 1 more/ })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /Bad link/ })).toBeTruthy()
    await ui.unmount()
  }
})

test('demo shows every card; hide removes one', async ($, on) => {
  on('store.get', () => ({ value: undefined }) as never)
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('store.set', () => ({ value: undefined }) as never)

  await $.command.run({ command: 'today', args: 'demo' } as never)
  let ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  for (const t of [/TIMELINE/, /FOCUS/, /HEADS-UP/, /WORKDAY/, /DEMO/, /\+ 2 more/, /updated just now/]) {
    expect(await ui.find({ type: 'Text', text: t })).toBeTruthy()
  }
  await ui.unmount()

  await $.command.run({ command: 'today', args: 'hide focus' } as never)
  ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /FOCUS/ })).toBeFalsy()
  expect(await ui.find({ type: 'Text', text: /hidden: focus/ })).toBeTruthy()
  await ui.unmount()

  await $.command.run({ command: 'today', args: 'demo off' } as never)
  ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /DEMO/ })).toBeFalsy()
  expect(await ui.find({ type: 'Text', text: /Empty so far/ })).toBeTruthy()
  await ui.unmount()
})

test('on and off are remembered', async ($, on) => {
  const store = new Map<string, unknown>()
  on('store.get', (_, e) => ({ value: store.get((e as { key: string }).key) }) as never)
  on('store.set', (_, e) => {
    const { key, value } = e as { key: string; value: unknown }
    store.set(key, value)
    return { value: undefined } as never
  })
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.close', () => ({ value: undefined }) as never)

  await $.command.run({ command: 'today', args: 'off' } as never)
  expect(store.get('open-on-start')).toBe(false)
  await $.command.run({ command: 'today', args: 'on' } as never)
  expect(store.get('open-on-start')).toBe(true)
})

test('settings change how many items show', { options: { focusCount: 2, maxAlerts: 1 } }, async ($, on) => {
  on('store.get', () => ({ value: undefined }) as never)
  on('ui.open', () => ({ value: { isPlaced: true } }))

  const config = await $.command.run({ command: 'today', args: 'config' } as never)
  expect(config.text).toContain('2 tasks')

  await $.command.run({ command: 'today', args: 'demo' } as never)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /\+ 3 more/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /\+ 2 more/ })).toBeTruthy()
  await ui.unmount()
})

test('a card color can be set, a bad one is ignored', { options: { palette: 'nordic', colorFocus: '#ff8800', colorHeadsUp: 'not-a-color' } }, async $ => {
  const config = await $.command.run({ command: 'today', args: 'config' } as never)
  expect(config.text).toContain('focus #ff8800')
  expect(config.text).toContain('heads-up #d08770')
  expect(config.text).toContain('nordic')
})

test('help and unknown verbs list the commands', async $ => {
  for (const args of ['help', 'nonsense']) {
    const r = await $.command.run({ command: 'today', args } as never)
    expect(r.text).toContain('/today demo off')
  }
})

test('/wrapup and /today answer at once and start no turn while they run', async ($, on) => {
  const prompts: string[] = []
  on('prompt.submit', (_, e) => {
    prompts.push((e as { text: string }).text)
    return {} as never
  })
  on('ui.open', () => ({ value: { isPlaced: false, reason: 'no-surface' } }) as never)

  // The engine refuses a prompt submitted from inside command.run; the mod queues it for turn.complete.
  expect((await $.command.run({ command: 'wrapup', args: 'a note' } as never)).text).toContain('report')
  expect((await $.command.run({ command: 'today', args: '' } as never)).text).toContain('Looking')
  expect(prompts).toHaveLength(0)
})

test('events without a time go last and are never marked past', async ($, on) => {
  on('command.register', () => ({ value: { command: 'x' } }))
  on('tool.register', (_, e) => ({ value: e as never }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('store.get', () => ({ value: undefined }) as never)
  on('store.set', () => ({ value: undefined }) as never)
  on('session.start', (_, e) => ({ cwd: e.cwd }))

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.tool.call({
    tool: 'mcp__workday__update_today',
    events: [{ text: 'Holiday' }, { text: 'Early', time: '00:00' }, { text: 'Bad', time: '25:99' }],
  } as never)

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /00:00/ }))?.text).toContain('✓')
  expect((await ui.find({ type: 'Text', text: /--:--/ }))?.text).not.toContain('✓')
  await ui.unmount()
})

test('auto-refresh is off by default and clamped to 15 minutes', { options: { autoRefresh: 5 } }, async $ => {
  const config = await $.command.run({ command: 'today', args: 'config' } as never)
  expect(config.text).toContain('every 15 min')
})

test('the title line greets by the time of day', async ($, on) => {
  on('store.get', () => ({ value: undefined }) as never)
  on('ui.open', () => ({ value: { isPlaced: true } }))
  await $.command.run({ command: 'today', args: 'demo' } as never)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const greetings = /Good (morning|afternoon|evening)|Hello|Still up|Guten (Morgen|Tag|Abend)|Mahlzeit|Noch wach/
  expect(await ui.find({ type: 'Text', text: greetings })).toBeTruthy()
  await ui.unmount()
})

test('tasks from two trackers name both in the focus card', async ($, on) => {
  on('tool.register', (_, e) => ({ value: e as never }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('store.get', () => ({ value: undefined }) as never)
  on('store.set', () => ({ value: undefined }) as never)

  await $.tool.call({
    tool: 'mcp__workday__update_today',
    tasks: [
      { text: 'One', id: 'ABC-1', source: 'Linear' },
      { text: 'Two', id: 'OPS-2', source: 'Jira' },
      { text: 'Three', id: 'ABC-3', source: 'Linear' },
    ],
  } as never)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /^Linear$/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /^Jira$/ })).toBeTruthy()
  await ui.unmount()
})

test('a tracker name in the focus card links to its list of open items', async ($, on) => {
  on('tool.register', (_, e) => ({ value: e as never }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('store.get', () => ({ value: undefined }) as never)
  on('store.set', () => ({ value: undefined }) as never)

  await $.tool.call({
    tool: 'mcp__workday__update_today',
    tasks: [
      { text: 'One', id: 'ABC-1', source: 'Linear' },
      { text: 'Two', id: 'OPS-2', source: 'Jira' },
    ],
    lists: [
      { source: 'Jira', url: 'https://example.com/jira/mine' },
      { source: 'Linear', url: 'javascript:alert(1)' },
    ],
  } as never)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const hrefs = (await ui.findAll({ type: 'Link' } as never)).map(l => (l.props as { href?: string } | undefined)?.href)
  expect(hrefs).toEqual(['https://example.com/jira/mine'])
  expect(await ui.find({ type: 'Text', text: /Linear/ })).toBeTruthy()
  await ui.unmount()
})

test('refresh on start is on by default', async $ => {
  const config = await $.command.run({ command: 'today', args: 'config' } as never)
  expect(config.text).toMatch(/Refresh on start\s+on/)
})

test('refresh on start can be turned off', { options: { refreshOnStart: false } }, async $ => {
  const config = await $.command.run({ command: 'today', args: 'config' } as never)
  expect(config.text).toMatch(/Refresh on start\s+off/)
})

test('/wrapup asks for commits from the hosting account and from local git', async ($, on) => {
  const prompts: string[] = []
  on('prompt.submit', (_, e) => {
    prompts.push((e as { text: string }).text)
    return { drop: 'captured by the test' } as never
  })
  on('turn.complete', () => ({ text: '' }) as never)
  await $.command.run({ command: 'wrapup', args: '' } as never)
  await $.turn.complete({ answer: '', durationMs: 0, isAborted: false, turnId: 't', reason: 'answer' })
  expect(prompts).toHaveLength(1)
  expect(prompts[0]).toContain('code hosting')
  expect(prompts[0]).toContain('Claude Code sessions today')
})

test('/today asks for readable keys: repo#number for reviews, a site name for monitoring', async ($, on) => {
  const prompts: string[] = []
  on('prompt.submit', (_, e) => {
    prompts.push((e as { text: string }).text)
    return { drop: 'captured by the test' } as never
  })
  on('turn.complete', () => ({ text: '' }) as never)
  on('ui.open', () => ({ value: { isPlaced: false, reason: 'no-surface' } }) as never)
  await $.command.run({ command: 'today', args: '' } as never)
  await $.turn.complete({ answer: '', durationMs: 0, isAborted: false, turnId: 't', reason: 'answer' })
  expect(prompts).toHaveLength(1)
  expect(prompts[0]).toContain('`repo#number`')
  expect(prompts[0]).toContain('leave `id` empty rather than guess')
  expect(prompts[0]).toContain('not an internal numeric ID')
})

test('the tool says so when the pane cannot be saved', async ($, on) => {
  on('tool.register', (_, e) => ({ value: e as never }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('store.get', () => ({ value: undefined }) as never)
  on('store.set', () => {
    throw new Error('disk full')
  })
  const r = await $.tool.call({ tool: 'mcp__workday__update_today', tasks: [{ text: 'One' }] } as never)
  expect(JSON.stringify(r)).toContain('could not be saved')
})
