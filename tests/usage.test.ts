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
