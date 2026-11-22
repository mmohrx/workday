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
    events: [{ text: 'Weekly', time: '10:00', source: 'Outlook' }],
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

  await $.command.run({ command: 'today', args: 'demo' })
  let ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  for (const t of [/TIMELINE/, /FOCUS/, /HEADS-UP/, /WORKDAY/, /DEMO/, /\+ 2 more/]) {
    expect(await ui.find({ type: 'Text', text: t })).toBeTruthy()
  }
  await ui.unmount()

  await $.command.run({ command: 'today', args: 'hide focus' })
  ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /FOCUS/ })).toBeFalsy()
  expect(await ui.find({ type: 'Text', text: /hidden: focus/ })).toBeTruthy()
  await ui.unmount()

  await $.command.run({ command: 'today', args: 'demo off' })
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

  await $.command.run({ command: 'today', args: 'off' })
  expect(store.get('open-on-start')).toBe(false)
  await $.command.run({ command: 'today', args: 'on' })
  expect(store.get('open-on-start')).toBe(true)
})

test('settings change how many items show', { options: { focusCount: 2, maxAlerts: 1 } }, async ($, on) => {
  on('store.get', () => ({ value: undefined }) as never)
  on('ui.open', () => ({ value: { isPlaced: true } }))

  const config = await $.command.run({ command: 'today', args: 'config' })
  expect(config.text).toContain('2 tasks')

  await $.command.run({ command: 'today', args: 'demo' })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /\+ 3 more/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /\+ 2 more/ })).toBeTruthy()
  await ui.unmount()
})

test('a card color can be set, a bad one is ignored', { options: { palette: 'pastel', colorFocus: '#ff8800', colorHeadsUp: 'not-a-color' } }, async $ => {
  const config = await $.command.run({ command: 'today', args: 'config' })
  expect(config.text).toContain('focus #ff8800')
  expect(config.text).toContain('heads-up #fca5a5')
  expect(config.text).toContain('pastel')
})
