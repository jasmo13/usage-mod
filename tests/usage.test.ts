import type { RenderElement } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

import { cacheHitRate, emptyModel, foldTranscript, projectSlug, sumTokens } from '../hooks/collect'
import { textBar } from '../hooks/views'

const BAND_PROPS = {
  hasSurvey: false,
  isWorking: false,
  maxRows: 20,
  bodyColumns: 120,
  scroll: { offset: 0, bodyRows: 20 },
  view: {},
}

const USAGE = {
  startedAt: 0,
  context: { window: 200_000, tokens: 50_000, percent: 25 },
  rateLimits: [{ kind: 'five_hour', percentUsed: 12.5, resetsAt: '2030-01-01T00:00:00Z' }],
  cost: { usd: 0.5 },
}

const USAGE_ROW = {
  input_tokens: 10,
  output_tokens: 500,
  cache_read_input_tokens: 40_000,
  cache_creation_input_tokens: 2_000,
}

test('the transcript folds once per API message, before the live cut-off', async () => {
  const row = (id: string, ts: string, extra: object = {}) =>
    JSON.stringify({
      type: 'assistant',
      timestamp: ts,
      message: { id, model: 'claude-opus-5-5', usage: USAGE_ROW, content: [], ...extra },
    })
  const jsonl = [
    JSON.stringify({ type: 'user', timestamp: '2026-01-01T00:00:00Z', uuid: 'u1', message: { role: 'user', content: 'hello there' } }),
    row('m1', '2026-01-01T00:00:01Z', { content: [{ type: 'tool_use', id: 't1', name: 'Read' }] }),
    row('m1', '2026-01-01T00:00:01Z', { content: [{ type: 'text', text: 'x' }] }),
    JSON.stringify({ type: 'user', timestamp: '2026-01-01T00:00:02Z', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', is_error: true }] } }),
    row('m2', '2026-01-01T00:00:03Z'),
    row('m3', '2030-01-01T00:00:00Z'),
  ].join('\n')
  const m = foldTranscript(emptyModel(), jsonl, { before: Date.parse('2027-01-01T00:00:00Z') })
  expect(m.totals.requests).toBe(2)
  expect(m.totals.output).toBe(1000)
  expect(m.byTool.Read).toMatchObject({ calls: 1, errors: 1 })
  expect(m.turns).toHaveLength(1)
  expect(m.turns[0]).toMatchObject({ prompt: 'hello there', requests: 2, tools: 1 })
  expect(cacheHitRate(m.totals)).toBeGreaterThan(0.9)
  expect(sumTokens(m.totals)).toBe(2 * (10 + 500 + 40_000 + 2_000))
})

test('helpers: slug and text bars', async () => {
  expect(projectSlug('C:\\Users\\me\\New folder (4)')).toBe('C--Users-me-New-folder--4-')
  const bar = textBar(0.5, 10)
  expect(bar.filled).toBe('█████')
  expect(bar.rest).toBe('░░░░░')
})

test('a desktop prompt keeps its words when the app prepends a reminder', async () => {
  const jsonl = [
    JSON.stringify({
      type: 'user',
      timestamp: '2026-01-01T00:00:00Z',
      uuid: 'u1',
      message: { role: 'user', content: [{ type: 'text', text: '<system-reminder>x</system-reminder>' }, { type: 'text', text: 'build a mod' }] },
    }),
    JSON.stringify({ type: 'user', timestamp: '2026-01-01T00:00:01Z', isCompactSummary: true, message: { role: 'user', content: 'This session is being continued' } }),
  ].join('\n')
  const m = foldTranscript(emptyModel(), jsonl, { before: Date.parse('2027-01-01T00:00:00Z') })
  expect(m.turns.map(t => t.prompt)).toEqual(['build a mod'])
})

test('live events fill the band on the terminal and the desktop', { options: { statusLine: true } }, async ($, on) => {
  const clock = mock.clock(on, { now: 1_000 })
  // What the engine draws once the band passes, and its toasts.
  on('ui.render', (_$, e) => h(_$.ui.resolve(e).Box, {}) as RenderElement)
  on('ui.toast', () => ({ value: undefined }))
  on('session.usage', () => ({ value: USAGE }))
  on('session.measure', (_$, e) => ({ changed: e.changed }))
  const statuses: (string | undefined)[] = []
  on('ui.status', (_$, e) => {
    statuses.push(e.text)
    return { value: undefined }
  })
  on('turn.step', async function* (_$, e) {
    return {
      turnId: e.turnId,
      index: e.index,
      answer: 'ok',
      toolUses: [],
      stopReason: 'end_turn' as const,
      usage: { ...USAGE_ROW, model: 'claude-opus-5-5' },
    }
  })
  on('tool.call', async () => {
    await clock.sleep(250)
    return { result: 'done', text: 'done' }
  })

  for await (const _ of $.turn.step({ turnId: 't1', index: 0, model: 'claude-opus-5-5', messageCount: 1 })) {
    // drain
  }
  const call = $.tool.call({ tool: 'Read', file_path: 'a.txt' })
  await clock.advance(250)
  await call
  await $.session.measure({ context: USAGE.context, rateLimits: USAGE.rateLimits, cost: USAGE.cost, changed: ['cost'] })

  expect(statuses.at(-1)).toBe('$0.500 · 43k tok · ctx 25% · 5-hour 13%')

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'session-usage', surface, component: 'AbovePrompt', props: BAND_PROPS })
    expect(await ui.find({ text: /\$0\.500/ }), `${surface}: cost`).toBeDefined()
    expect(await ui.find({ text: /^43k$/ }), `${surface}: tokens`).toBeDefined()
    expect(await ui.find({ text: /5-hour/ }), `${surface}: rate limit`).toBeDefined()
    expect(await ui.find({ text: /cached/ }), `${surface}: cache`).toBeDefined()
    const svgs = await ui.findAll({ type: 'Svg' })
    if (surface === 'desktop') {
      // Capsule meters drawn without a background, so they sit on the app's light or dark.
      expect(svgs.length, 'desktop vectors').toBeGreaterThan(0)
      expect(svgs.every(v => !String(v.props.source).includes('#fff'))).toBe(true)
    } else {
      expect(svgs).toHaveLength(0)
    }
    expect(await ui.find({ text: /Read/ }), `${surface}: tools hidden until Show details`).toBeUndefined()
    expect(await ui.find({ text: /Copy JSON/ }), `${surface}: menu closed`).toBeUndefined()

    await ui.press({ key: 'menu' })
    expect(await ui.find({ text: /Copy JSON/ }), `${surface}: menu open`).toBeDefined()
    expect(await ui.find({ text: /5-hour/ }), `${surface}: the menu covers no meter`).toBeDefined()
    await ui.press({ key: 'details' })
    expect(await ui.find({ text: /Copy JSON/ }), `${surface}: menu closes after a choice`).toBeUndefined()
    expect(await ui.find({ text: /Read/ }), `${surface}: tools in details`).toBeDefined()
    expect(await ui.find({ text: /^Activity$/ }), `${surface}: activity`).toBeDefined()
    expect(await ui.find({ text: /^Cache write$/ }), `${surface}: token rows`).toBeDefined()
    await ui.press({ key: 'menu' })
    await ui.press({ key: 'details' })
    await ui.unmount()
  }

  const ui = await $.ui.mount({ plugin: 'session-usage', surface: 'terminal', component: 'AbovePrompt', props: BAND_PROPS })
  await ui.press({ key: 'menu' })
  await ui.press({ key: 'hide' })
  expect(await ui.find({ text: /\$0\.500/ }), 'hidden band').toBeUndefined()
  await ui.unmount()
})

test('a short band keeps the headline rows', async ($, on) => {
  mock.clock(on, { now: 1_000 })
  on('session.usage', () => ({ value: USAGE }))
  const ui = await $.ui.mount({
    plugin: 'session-usage',
    surface: 'desktop',
    component: 'AbovePrompt',
    props: { ...BAND_PROPS, maxRows: 1, bodyColumns: 60 },
  })
  expect(await ui.find({ text: /0 tok/ })).toBeDefined()
  expect(await ui.find({ text: /cached/ })).toBeUndefined()
  await ui.unmount()
})

test('the context tile measures against compaction', async ($, on) => {
  mock.clock(on, { now: 1_000 })
  const breakdown = {
    model: 'claude-opus-5-5',
    totalTokens: 50_000,
    // A 100k compaction window on a 200k model, compacting at 80k.
    rawMaxTokens: 100_000,
    percentage: 50,
    autoCompactThreshold: 80_000,
    isAutoCompactEnabled: true,
    categories: [{ name: 'Messages', tokens: 40_000, color: 'x', kind: 'used' }],
    memoryFiles: [],
    mcpTools: [],
  }
  on('ui.render', (_$, e) => h(_$.ui.resolve(e).Box, {}) as RenderElement)
  on('session.usage', () => ({ value: { ...USAGE, context: { ...USAGE.context, breakdown } } as never }))
  on('session.measure', (_$, e) => ({ changed: e.changed }))
  await $.session.measure({ context: USAGE.context, rateLimits: USAGE.rateLimits, cost: USAGE.cost, changed: ['context'] })
  const ui = await $.ui.mount({ plugin: 'session-usage', surface: 'desktop', component: 'AbovePrompt', props: BAND_PROPS })
  // Showing the details reads the breakdown, and with it where compaction starts.
  await ui.press({ key: 'menu' })
  await ui.press({ key: 'details' })
  expect(await ui.find({ text: /^Context window$/ })).toBeDefined()
  expect(await ui.find({ text: /^50%$/ }), '50k of the 100k compaction window').toBeDefined()
  expect(await ui.find({ text: /30k left/ })).toBeDefined()
  expect(await ui.find({ text: /50k \/ 100k \(50%\)/ }), 'the whole window in the details').toBeDefined()
  await ui.unmount()

  // A band of 12 rows still shows the details, with fewer rows in each, on either surface.
  for (const surface of ['desktop', 'terminal'] as const) {
    const short = await $.ui.mount({ plugin: 'session-usage', surface, component: 'AbovePrompt', props: { ...BAND_PROPS, maxRows: 12 } })
    expect(await short.find({ text: /^Free space$/ }), `${surface}: details in 12 rows`).toBeDefined()
    expect(await short.find({ text: /^Cache read$/ }), `${surface}: token rows in 12 rows`).toBeDefined()
    expect(await short.find({ text: /^50%$/ }), `${surface}: context against its window`).toBeDefined()
    expect(await short.find({ text: /30k left/ }), `${surface}: tokens until compaction`).toBeDefined()
    if (surface === 'terminal') expect(await short.find({ text: /╋/ }), 'terminal: compaction tick').toBeDefined()
    await short.unmount()
  }
})

test('a chat whose transcript is over the read limit still loads its history', async ($, on) => {
  const clock = mock.clock(on, { now: Date.parse('2027-01-01T00:00:00Z') })
  on('session.usage', () => ({ value: USAGE }))
  on('session.id', () => ({ value: 's1' }))
  on('session.root', () => ({ value: '/proj' }))
  on('session.cwd', () => ({ value: '/proj' }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  const logs: string[] = []
  on('ui.log', (_$, e) => {
    logs.push(e.text)
    return { value: undefined }
  })
  on('ui.status', () => ({ value: undefined }))
  const env: Record<string, string> = { CLAUDE_CONFIG_DIR: '/cfg', OS: 'Windows_NT' }
  on('env.get', (_$, e) => ({ value: env[e.name] }))
  // The engine hands a hook the path made absolute for this machine.
  const isTranscript = (path: string | undefined) => path?.replace(/\\/g, '/').endsWith('/cfg/projects/-proj/s1.jsonl') === true
  on('fs.exists', (_$, e) => ({ value: isTranscript(e.path) }))
  // Past what one read may copy: the engine refuses it.
  on('fs.stat', () => ({ value: { kind: 'file' as const, size: 9_000_000, mtimeMs: 0, isLink: false } }))
  on('fs.read', () => {
    throw new Error('over 4 MiB')
  })
  const row = JSON.stringify({ type: 'assistant', timestamp: '2026-01-01T00:00:00Z', message: { id: 'm1', model: 'claude-opus-5-5', usage: USAGE_ROW } })
  const spawned: { argv: readonly string[]; env?: Readonly<Record<string, string>> }[] = []
  on('process.spawn', async function* (_$, e) {
    spawned.push({ argv: e.argv, env: e.env })
    // A row cut across two pieces.
    yield { stream: 'stdout' as const, text: `{"type":"other"}\n${row.slice(0, 40)}` }
    yield { stream: 'stdout' as const, text: `${row.slice(40)}\n` }
    return { value: { code: 0, signal: null } }
  })

  await $.session.start({ cwd: '/proj', surface: 'desktop', isInteractive: true })
  await clock.advance(100)
  expect(logs).toEqual([])
  expect(spawned).toHaveLength(1)
  expect(spawned[0]?.argv[0]).toBe('powershell.exe')
  expect(isTranscript(spawned[0]?.env?.SESSION_USAGE_FILE), 'the path rides the environment, unquoted').toBe(true)

  const ui = await $.ui.mount({ plugin: 'session-usage', surface: 'desktop', component: 'AbovePrompt', props: BAND_PROPS })
  expect(await ui.find({ text: /^43k$/ }), 'history tokens before any turn').toBeDefined()
  await ui.unmount()
})

test('a new chat shows the last rate-limit reading until its first reply', async ($, on) => {
  const clock = mock.clock(on, { now: Date.parse('2029-12-31T23:00:00Z') })
  const kept = [
    { kind: 'five_hour', percentUsed: 40, resetsAt: '2030-01-01T00:00:00Z' },
    // Reset already: says nothing about now.
    { kind: 'seven_day', percentUsed: 90, resetsAt: '2029-12-01T00:00:00Z' },
  ]
  on('store.get', () => ({ value: kept }))
  on('store.set', () => ({ value: undefined }))
  let usage: typeof USAGE = { ...USAGE, rateLimits: [] }
  on('session.usage', () => ({ value: usage }))
  const ui = await $.ui.mount({ plugin: 'session-usage', surface: 'desktop', component: 'AbovePrompt', props: BAND_PROPS })
  await clock.advance(2_000)
  expect(await ui.find({ text: /5-hour/ }), 'kept reading').toBeDefined()
  expect(await ui.find({ text: /^40%$/ }), 'its figure').toBeDefined()
  expect(await ui.find({ text: /7-day/ }), 'a reset window is dropped').toBeUndefined()
  // The first reply's own reading takes over.
  usage = { ...USAGE, rateLimits: [{ kind: 'five_hour', percentUsed: 55, resetsAt: '2030-01-01T00:00:00Z' }] }
  await clock.advance(2_000)
  expect(await ui.find({ text: /^55%$/ }), 'live reading').toBeDefined()
  await ui.unmount()
})

test('an idle band keeps refreshing with no events', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000 })
  let usage = USAGE
  on('session.usage', () => ({ value: usage }))
  const ui = await $.ui.mount({ plugin: 'session-usage', surface: 'desktop', component: 'AbovePrompt', props: BAND_PROPS })
  await clock.advance(2_000)
  expect(await ui.find({ text: /\$0\.500/ }), 'first reading').toBeDefined()
  // Cost moves with no turn, tool or measure event to announce it.
  usage = { ...USAGE, cost: { usd: 0.9 } }
  await clock.advance(2_000)
  expect(await ui.find({ text: /\$0\.900/ }), 'read again while idle').toBeDefined()
  await ui.unmount()
})
