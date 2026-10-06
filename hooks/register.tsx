import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, SessionUsage } from 'claude-code'

import type { Backfill, Breakdown, Measure, RunningTool, UsageModel } from '../types'
import {
  addCompaction,
  addRequest,
  addToolCall,
  emptyModel,
  finishTurn,
  foldTranscript,
  projectSlug,
  startTurn,
  sumTokens,
  tokensOf,
} from './collect'
import { band, statusText } from './views'

/** Bumped when the transcript parser changes, so history is read again. */
const BACKFILL_VERSION = 2

const usageA = atom({ plugin: 'session-usage', key: 'usage' } as const, emptyModel())
const measureA = atom({ plugin: 'session-usage', key: 'measure' } as const, null)
const breakdownA = atom({ plugin: 'session-usage', key: 'breakdown' } as const, null)
const expandedA = atom({ plugin: 'session-usage', key: 'isExpanded' } as const, false)
const hiddenA = atom({ plugin: 'session-usage', key: 'isHidden' } as const, false)
const menuA = atom({ plugin: 'session-usage', key: 'isMenuOpen' } as const, false)
const runningA = atom({ plugin: 'session-usage', key: 'running' } as const, [])
const backfillA = atom({ plugin: 'session-usage', key: 'backfill' } as const, null)
const modelA = atom({ plugin: 'session-usage', key: 'model' } as const, '')

type $ = EngineInterface

const toMeasure = (
  at: number,
  u: Pick<SessionUsage, 'context' | 'rateLimits' | 'cost'> & { startedAt?: number },
  previous: Measure | null,
): Measure => ({
  at,
  startedAt: u.startedAt ?? previous?.startedAt,
  costUsd: u.cost?.usd ?? previous?.costUsd,
  contextTokens: u.context.tokens,
  contextWindow: u.context.window,
  contextPercent: u.context.percent,
  rateLimits: u.rateLimits.map(l => ({ kind: l.kind, percentUsed: l.percentUsed, resetsAt: l.resetsAt })),
})

// Set by register from the options; read by the helpers below.
let showStatus = true
// Where the transcript is, once a settings-hook event has said; a guess until then.
let transcriptPath: string | undefined
// When the context breakdown was last counted; it is heavier than the rest, so it runs at most every few seconds.
let breakdownAt = 0
// The refresh timer, and when it last fired: a draw that finds it stale starts it again.
let ticker: { cancel: () => void } | undefined
let tickedAt = 0

const pushStatus = async ($: $) => {
  if (!showStatus) return
  $.ui.status(statusText(await read($, usageA), await read($, measureA)))
}

const refreshMeasure = async ($: $) => {
  const [u, now, prev] = await Promise.all([$.session.usage(), $.clock.now(), read($, measureA)])
  await update($, measureA, () => toMeasure(now, u, prev))
  return u
}

const refreshBreakdown = async ($: $, detail: 'summary' | 'full') => {
  try {
    const u = await $.session.usage({ breakdown: detail })
    const b = u.context.breakdown
    if (!b) return
    const now = await $.clock.now()
    const next: Breakdown = {
      at: now,
      detail,
      model: b.model,
      totalTokens: b.totalTokens,
      rawMaxTokens: b.rawMaxTokens,
      percentage: b.percentage,
      autoCompactThreshold: b.autoCompactThreshold,
      isAutoCompactEnabled: b.isAutoCompactEnabled,
      categories: b.categories.map(c => ({ name: c.name, tokens: c.tokens, color: c.color, kind: c.kind })),
      memoryFiles: b.memoryFiles.map(f => ({ path: f.path, type: f.type, tokens: f.tokens })),
      mcpTools: b.mcpTools.map(t => ({ name: t.name, serverName: t.serverName, tokens: t.tokens, isLoaded: t.isLoaded })),
      skills: (b.skills?.skillFrontmatter ?? []).map(s => ({ name: s.name, tokens: s.tokens })),
    }
    await update($, breakdownA, () => next)
  } catch (error) {
    $.ui.log(`session-usage: context breakdown unavailable (${String(error)})`, { to: 'debug' })
  }
}

/**
 * Brings cost, context and limits up to the moment, and the context breakdown
 * when it is a few seconds old: called on every request, tool result and turn.
 */
const syncLive = async ($: $) => {
  await refreshMeasure($).catch(() => undefined)
  await pushStatus($)
  const now = await $.clock.now()
  if (now - breakdownAt >= 4000) {
    breakdownAt = now
    await refreshBreakdown($, 'summary')
  }
}

/** How often the band redraws; cost, context and limits are read every other tick. */
const TICK_MS = 1000

/**
 * Keeps the band in step with the chat whether or not anything is happening
 * (durations, countdowns, cost and context all move between events). Replaces
 * any timer already running, so a new chat or a restart never runs two.
 */
const startTicker = async ($: $) => {
  ticker?.cancel()
  tickedAt = await $.clock.now()
  let ticks = 0
  ticker = $.clock.every(TICK_MS, () => {
    ticks += 1
    void (async () => {
      tickedAt = await $.clock.now()
      if (await read($, hiddenA)) return
      if (ticks % 2 === 0) await syncLive($)
      $.ui.invalidate('ui.render')
    })().catch(error => $.ui.log(`session-usage: refresh failed (${String(error)})`, { to: 'debug' }))
  })
}

/** Starts the timer again when it has gone quiet: called while drawing. */
const ensureTicker = async ($: $, now: number) => {
  if (!ticker || now - tickedAt > TICK_MS * 3) await startTicker($)
}

/** Finds this session's transcript: the path a settings hook was given, else ~/.claude/projects/<slug>/<id>.jsonl. */
const findTranscript = async ($: $, sessionId: string) => {
  if (transcriptPath && (await $.fs.exists(transcriptPath))) return transcriptPath
  const configDir =
    (await $.env.get('CLAUDE_CONFIG_DIR')) ??
    `${(await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME')) ?? '~'}/.claude`
  const projects = `${configDir}/projects`
  for (const dir of [await $.session.root(), await $.session.cwd()]) {
    const guess = `${projects}/${projectSlug(dir)}/${sessionId}.jsonl`
    if (await $.fs.exists(guess)) return guess
  }
  try {
    for (const entry of await $.fs.list(projects)) {
      if (entry.kind !== 'dir') continue
      const guess = `${projects}/${entry.name}/${sessionId}.jsonl`
      if (await $.fs.exists(guess)) return guess
    }
  } catch {
    // no projects folder
  }
  return undefined
}

/** Reads what happened before this mod started counting, once per session. */
const backfill = async ($: $) => {
  const was = await read($, backfillA)
  if (was && was.status !== 'pending' && was.version === BACKFILL_VERSION) return
  const sessionId = await $.session.id()
  const liveSince = was?.liveSince ?? (await $.clock.now())
  const set = (b: Backfill) => update($, backfillA, () => b)
  await set({ status: 'pending', sessionId, liveSince, version: BACKFILL_VERSION })
  const path = await findTranscript($, sessionId)
  if (!path) {
    await set({ status: 'unavailable', sessionId, liveSince, version: BACKFILL_VERSION, note: 'History: transcript not found; counting from when the mod loaded.' })
    return
  }
  let main: string
  try {
    main = await $.fs.read(path)
  } catch (error) {
    await set({
      status: 'unavailable',
      sessionId,
      liveSince,
      version: BACKFILL_VERSION,
      note: `History: transcript could not be read (${String(error).slice(0, 80)}); counting from when the mod loaded.`,
    })
    return
  }
  let model = foldTranscript(emptyModel(), main, { before: liveSince })
  let skipped = 0
  const subDir = `${path.replace(/\.jsonl$/, '')}/subagents`
  try {
    if (await $.fs.exists(subDir)) {
      for (const entry of await $.fs.list(subDir)) {
        if (!entry.name.endsWith('.jsonl')) continue
        try {
          const text = await $.fs.read(`${subDir}/${entry.name}`)
          const agentId = entry.name.replace(/^agent-/, '').replace(/\.jsonl$/, '')
          model = foldTranscript(model, text, { before: liveSince, agentId })
        } catch {
          skipped += 1
        }
      }
    }
  } catch {
    // no subagent transcripts
  }
  // Merge: history first, then whatever the live hooks counted meanwhile.
  await update($, usageA, live => {
    let merged = model
    for (const r of live.requests.filter(r => !r.isBackfill)) merged = addRequest(merged, r)
    const liveTurns = live.turns.filter(t => !t.isBackfill)
    merged = { ...merged, turns: [...merged.turns, ...liveTurns].slice(-150) }
    for (const [tool, s] of Object.entries(live.byTool)) {
      const had = merged.byTool[tool]
      merged = {
        ...merged,
        byTool: {
          ...merged.byTool,
          [tool]: had
            ? {
                calls: had.calls + s.calls,
                errors: had.errors + s.errors,
                denied: had.denied + s.denied,
                totalMs: had.totalMs + s.totalMs,
                maxMs: Math.max(had.maxMs, s.maxMs),
                timed: had.timed + s.timed,
              }
            : s,
        },
      }
    }
    return { ...merged, compactions: [...merged.compactions, ...live.compactions] }
  })
  await set({
    status: skipped ? 'partial' : 'done',
    sessionId,
    liveSince,
    version: BACKFILL_VERSION,
    note: skipped ? `History: ${skipped} subagent transcript(s) could not be read.` : undefined,
  })
  await pushStatus($)
}

export const register: Register = (on, options) => {
  showStatus = options.statusLine === true

  on('session.start', async ($, e, next) => {
    const result = await next(e)
    await $.command.register({
      name: 'session-usage',
      description: 'Show or hide the usage band above the prompt',
    })
    const bf = await read($, backfillA)
    if (!bf || bf.version !== BACKFILL_VERSION) {
      // First load, or history read by an older parser: count everything again from the transcript.
      const liveSince = await $.clock.now()
      await update($, usageA, () => emptyModel())
      await update($, backfillA, () => ({ status: 'pending', liveSince, version: BACKFILL_VERSION }) as Backfill)
      // A new chat opens the band with its details tucked away; Show details opens them.
      await update($, expandedA, () => false)
      await update($, menuA, () => false)
    }
    if (!showStatus) $.ui.status(undefined)
    try {
      const m = await $.session.model()
      await update($, modelA, () => m)
    } catch {
      // model unknown
    }
    await refreshMeasure($).catch(() => undefined)
    await pushStatus($)
    // Work that may take a while runs off the session's start.
    $.clock.after(50, () => {
      void backfill($).catch(error => $.ui.log(`session-usage: history not loaded (${String(error)})`, { to: 'debug' }))
      void refreshBreakdown($, 'summary')
    })
    await startTicker($)
    return result
  })

  on('command.run', { command: 'session-usage' }, async $ => {
    const isHidden = await update($, hiddenA, was => !was)
    // Shown again, the band starts with its details hidden and the menu closed.
    await update($, expandedA, () => false)
    await update($, menuA, () => false)
    if (!isHidden) {
      void refreshMeasure($).then(() => refreshBreakdown($, 'summary'))
      await ensureTicker($, await $.clock.now())
    }
    return { text: isHidden ? 'Usage band hidden; /session-usage shows it again.' : 'Usage band shown above the prompt.' }
  })

  // Every settings-hook event names the transcript; the first one tells us where history lives.
  on('classic.UserPromptSubmit', ($, e, next) => {
    transcriptPath = e.transcript_path || transcriptPath
    return next(e)
  })
  on('classic.Stop', ($, e, next) => {
    transcriptPath = e.transcript_path || transcriptPath
    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    const [now, u] = await Promise.all([$.clock.now(), $.session.usage().catch(() => undefined)])
    await update($, usageA, m =>
      startTurn(m, {
        id: e.turnId,
        startedAt: now,
        prompt: e.text.replace(/\s+/g, ' ').trim().slice(0, 120),
        requests: 0,
        tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        tools: 0,
        costAtStart: u?.cost?.usd,
      }),
    )
    void syncLive($)
    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    const result = yield* next(e)
    if (result.usage) {
      const usage = result.usage
      const now = await $.clock.now()
      await update($, usageA, m =>
        addRequest(m, {
          t: now,
          model: usage.model,
          agentId: e.agentId,
          tokens: tokensOf(usage),
          stop: result.stopReason,
        }),
      )
      if (!e.agentId) await update($, modelA, () => usage.model)
      void syncLive($)
    }
    return result
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId !== undefined) return result
    const u = await refreshMeasure($).catch(() => undefined)
    const after = u?.cost?.usd
    await update($, usageA, m => {
      const turn = m.turns.find(t => t.id === e.turnId)
      const costUsd = after !== undefined && turn?.costAtStart !== undefined ? Math.max(0, after - turn.costAtStart) : undefined
      return finishTurn(m, e.turnId, { durationMs: e.durationMs, reason: e.reason, costUsd })
    })
    await pushStatus($)
    breakdownAt = 0
    $.clock.after(10, () => void syncLive($))
    return result
  })

  on('tool.call', async ($, e, next) => {
    const since = await $.clock.now()
    const running: RunningTool = { id: e.tool_use_id, tool: String(e.tool), since, agentId: e.agentId }
    await update($, runningA, list => [...list.filter(r => r.id !== running.id), running])
    let outcome: { isError?: boolean; isDenied?: boolean } = { isError: true }
    try {
      const ran = await next(e)
      outcome = { isError: ran.isError === true, isDenied: ran.deny !== undefined }
      return ran
    } finally {
      const ms = (await $.clock.now()) - since
      await update($, runningA, list => list.filter(r => r.id !== running.id))
      await update($, usageA, m => addToolCall(m, running.tool, { ms, ...outcome }))
      void syncLive($)
    }
  })

  on('session.measure', async ($, e, next) => {
    const now = await $.clock.now()
    await update($, measureA, prev => toMeasure(now, e, prev))
    await pushStatus($)
    return next(e)
  })

  on('session.compact', async ($, e, next) => {
    const result = await next(e)
    if (result.skip === undefined && e.trigger !== 'precompute') {
      const now = await $.clock.now()
      const usage = result.usage
      await update($, usageA, m => {
        const withRow = addCompaction(m, { t: now, trigger: e.trigger, before: result.tokensBefore, after: result.tokensAfter })
        return usage ? addRequest(withRow, { t: now, model: 'compaction', agentId: e.agentId, tokens: tokensOf(usage), stop: null }) : withRow
      })
      $.clock.after(10, () => void refreshBreakdown($, 'summary'))
    }
    return result
  })

  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear') {
      // A /clear starts the count over, as /cost does.
      const now = await $.clock.now()
      await update($, usageA, () => emptyModel())
      await update($, breakdownA, () => null)
      await update($, runningA, () => [])
      await update($, backfillA, () => ({ status: 'done', liveSince: now }) as Backfill)
      transcriptPath = undefined
    }
    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey || (await read($, hiddenA))) return next(e)
    const [usage, measure, breakdown, isExpanded, isMenuOpen, running, backfillState, model, now] = await Promise.all([
      read($, usageA),
      read($, measureA),
      read($, breakdownA),
      read($, expandedA),
      read($, menuA),
      read($, runningA),
      read($, backfillA),
      read($, modelA),
      $.clock.now(),
    ])
    await ensureTicker($, now)
    const surface = e.surface
    const T = $.ui.resolve(e)
    return band({
      T,
      Svg: surface !== 'terminal' && 'Svg' in T ? T.Svg : undefined,
      cols: e.props.bodyColumns,
      maxRows: e.props.maxRows,
      now,
      usage: usage as UsageModel,
      measure: measure as Measure | null,
      breakdown: breakdown as Breakdown | null,
      running: running as RunningTool[],
      backfill: backfillState as Backfill | null,
      model: model as string,
      isExpanded,
      isMenuOpen,
      onMenu: () => update($, menuA, was => !was),
      onExpand: async () => {
        await update($, menuA, () => false)
        const isOpen = await update($, expandedA, was => !was)
        if (isOpen) void refreshBreakdown($, 'summary')
      },
      onHide: async () => {
        await update($, menuA, () => false)
        await update($, hiddenA, () => true)
        $.ui.toast('Usage band hidden; /session-usage shows it again.')
      },
      onCopy: async () => {
        await update($, menuA, () => false)
        const [u, m, b] = await Promise.all([read($, usageA), read($, measureA), read($, breakdownA)])
        const text = JSON.stringify(
          { generatedAt: new Date(await $.clock.now()).toISOString(), sessionId: await $.session.id(), measure: m, ...u, totals: { ...u.totals, all: sumTokens(u.totals) }, breakdown: b },
          null,
          2,
        )
        const copied = await $.ui.copy({ text, surface })
        $.ui.toast(copied.isCopied ? 'Usage JSON copied.' : `Could not copy: ${copied.reason}`)
      },
    })
  })
}
