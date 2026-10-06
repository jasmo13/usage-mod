import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, SessionUsage } from 'claude-code'

import type { Backfill, Breakdown, Measure, RateLimitRow, RunningTool, UsageModel } from '../types'
import {
  addCompaction,
  addRequest,
  addToolCall,
  emptyModel,
  finishTurn,
  liveLimits,
  parseUsage,
  projectSlug,
  startTurn,
  sumTokens,
  tokensOf,
  transcriptFolder,
} from './collect'
import { band, statusText } from './views'

/** Bumped when the transcript parser changes, so history is read again. */
const BACKFILL_VERSION = 2

const usageA = atom({ plugin: 'usage-mod', key: 'usage' } as const, emptyModel())
const measureA = atom({ plugin: 'usage-mod', key: 'measure' } as const, null)
const breakdownA = atom({ plugin: 'usage-mod', key: 'breakdown' } as const, null)
const expandedA = atom({ plugin: 'usage-mod', key: 'isExpanded' } as const, false)
const hiddenA = atom({ plugin: 'usage-mod', key: 'isHidden' } as const, false)
const menuA = atom({ plugin: 'usage-mod', key: 'isMenuOpen' } as const, false)
const runningA = atom({ plugin: 'usage-mod', key: 'running' } as const, [])
const backfillA = atom({ plugin: 'usage-mod', key: 'backfill' } as const, null)
const modelA = atom({ plugin: 'usage-mod', key: 'model' } as const, '')
const statusA = atom({ plugin: 'usage-mod', key: 'isStatusShown' } as const, false)

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
  // The usage service's reading wins while it is fresh; otherwise a reply's, and
  // before this chat's first reply the last one kept (this chat's, or another's).
  rateLimits:
    isReplyNewest(at) && u.rateLimits.length > 0
      ? u.rateLimits.map(l => ({ kind: l.kind, percentUsed: l.percentUsed, resetsAt: l.resetsAt }))
      : liveLimits(previous?.rateLimits ?? [], at),
})

/** The store key holding whether the terminal's status line carries the usage too: chosen from the band's menu, kept for every chat. */
const STATUS_KEY = 'statusLine'
/** The store key holding the last rate-limit reading, which belongs to the account rather than one chat. */
const LIMITS_KEY = 'rateLimits'
let savedLimits = ''
// Whether this load has looked for a kept reading yet.
let hasRecalled = false

/** Keeps the latest reading for the next chat to start from; written only when it changes. */
const rememberLimits = async ($: $, rows: readonly Pick<SessionUsage['rateLimits'][number], 'kind' | 'percentUsed' | 'resetsAt'>[]) => {
  if (rows.length === 0) return
  const value = rows.map(l => ({ kind: l.kind, percentUsed: l.percentUsed, resetsAt: l.resetsAt }))
  const text = JSON.stringify(value)
  if (text === savedLimits) return
  savedLimits = text
  await $.store.set(LIMITS_KEY, value).catch(() => undefined)
}

/** A new chat has no reading until its first reply: show the last one kept, if its window is still open. */
const recallLimits = async ($: $) => {
  const m = await read($, measureA)
  if (!m || m.rateLimits.length > 0) return
  const kept = await $.store.get(LIMITS_KEY).catch(() => undefined)
  if (!Array.isArray(kept)) return
  const rows = liveLimits(kept as RateLimitRow[], await $.clock.now())
  if (rows.length > 0) await update($, measureA, was => (was && was.rateLimits.length === 0 ? { ...was, rateLimits: rows } : was))
}

/**
 * The usage service /usage reads: the account's 5-hour and 7-day figures as
 * they stand, rather than as the last reply reported them.
 */
const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage'
/** How often an open band asks it, and how long one chat's answer serves every other (so many open chats still ask about four times a minute). */
const POLL_MS = 15_000
const SHARE_MS = 14_000
/** After a turn, ask again sooner, but never more than this often. */
const MIN_POLL_MS = 5_000
const SERVICE_KEY = 'serviceLimits'
/** When it stops answering, ask less often, doubling up to this. */
const MAX_POLL_MS = 300_000
/** A service reading older than this gives way to a newer one from a reply. */
const STALE_MS = 60_000
// Whether the service has answered this load, and when the reading shown was taken.
let fromService = false
let serviceAt = 0
// When this load last asked (or took another chat's answer), and how long until it asks again.
let polledAt = 0
let pollGap = POLL_MS
// Replies' last reading, and when it changed: 0 while it is the one found at load, whose age is unknown.
let replyText: string | undefined
let replyAt = 0

/** Notes a reading from replies, so a newer one can take over from a stale service reading. */
const noteReply = (rows: readonly RateLimitRow[], now: number) => {
  if (rows.length === 0) return
  const text = JSON.stringify(rows.map(l => [l.kind, l.percentUsed, l.resetsAt]))
  if (replyText !== undefined && text !== replyText) replyAt = now
  replyText = text
}

/** Whether replies' reading is the one to show: no service answer, or a stale one with a newer reply since. */
const isReplyNewest = (now: number) => !fromService || (now - serviceAt > STALE_MS && replyAt > serviceAt)

/**
 * Brings the 5-hour and 7-day meters up to the usage service's figures: from
 * another chat's answer under a minute old, else by asking it with the
 * session's own login (held by the engine; none for an API key or a
 * third-party provider, and then replies' readings stand).
 */
const pollLimits = async ($: $, isAfterTurn = false) => {
  const now = await $.clock.now()
  if (now - polledAt < (isAfterTurn && pollGap === POLL_MS ? MIN_POLL_MS : pollGap)) return
  polledAt = now
  let rows: RateLimitRow[] | undefined
  let takenAt = now
  if (!isAfterTurn) {
    const shared = (await $.store.get(SERVICE_KEY).catch(() => undefined)) as { at?: number; rateLimits?: RateLimitRow[] } | undefined
    if (shared?.at !== undefined && now - shared.at < SHARE_MS && Array.isArray(shared.rateLimits)) {
      rows = shared.rateLimits
      takenAt = shared.at
    }
  }
  if (!rows) {
    const auth = await $.session.authorize().catch(() => null)
    if (!auth) return
    const failed = (why: string) => {
      pollGap = Math.min(pollGap * 2, MAX_POLL_MS)
      $.ui.log(`usage-mod: usage service ${why}; asking again in ${pollGap / 1000}s`, { to: 'debug' })
    }
    try {
      const res = await $.http.fetch(USAGE_URL, { auth: auth.handle, headers: { 'anthropic-beta': 'oauth-2025-04-20' } })
      rows = res.ok ? parseUsage(res.text) : []
      if (rows.length === 0) return failed(`gave no limits (HTTP ${res.status})`)
    } catch (error) {
      return failed(`unavailable (${String(error).slice(0, 120)})`)
    }
    pollGap = POLL_MS
    await $.store.set(SERVICE_KEY, { at: now, rateLimits: rows }).catch(() => undefined)
  }
  fromService = true
  serviceAt = takenAt
  const live = liveLimits(rows, now)
  await update($, measureA, was => (was ? { ...was, rateLimits: live } : was))
  await rememberLimits($, live)
}

// Where the transcript is, once a settings-hook event has said; a guess until then.
let transcriptPath: string | undefined
// When the context breakdown was last counted, whether a count is running, and whether another is owed once it ends.
let breakdownAt = 0
let isCounting = false
let isOwed = false
// The refresh timer, and when it last fired: a draw that finds it stale starts it again.
let ticker: { cancel: () => void } | undefined
let tickedAt = 0

const refreshMeasure = async ($: $) => {
  const [u, now, prev] = await Promise.all([$.session.usage(), $.clock.now(), read($, measureA)])
  noteReply(u.rateLimits, now)
  await update($, measureA, () => toMeasure(now, u, prev))
  if (isReplyNewest(now)) await rememberLimits($, u.rateLimits)
  if (!hasRecalled) {
    hasRecalled = true
    await recallLimits($).catch(() => undefined)
  }
  return u
}

/**
 * The context breakdown is counted exactly, as the app's panel and /context
 * count it: the quick estimate gets the total right but splits it between
 * categories loosely. An exact count asks the token-count service, so it runs
 * when something changed (a load, a turn, a compaction, the details opening)
 * and otherwise at most every half minute while the details are open.
 */
const BREAKDOWN_MS = 30_000

const refreshBreakdown = async ($: $, isForced = false) => {
  const now = await $.clock.now()
  if (isCounting) {
    isOwed ||= isForced
    return
  }
  if (!isForced && now - breakdownAt < BREAKDOWN_MS) return
  isCounting = true
  breakdownAt = now
  try {
    let detail: 'summary' | 'full' = 'full'
    let u = await $.session.usage({ breakdown: 'full' }).catch(() => undefined)
    if (!u?.context.breakdown) {
      // The exact count failed (offline, say): the estimate beats an empty section.
      detail = 'summary'
      u = await $.session.usage({ breakdown: 'summary' })
    }
    const b = u.context.breakdown
    if (!b) return
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
    $.ui.log(`usage-mod: context breakdown unavailable (${String(error)})`, { to: 'debug' })
  } finally {
    isCounting = false
    if (isOwed) {
      isOwed = false
      void refreshBreakdown($, true)
    }
  }
}

/**
 * Brings cost, context and limits up to the moment, and the context breakdown
 * while the details show it: called on every request, tool result and turn.
 */
const syncLive = async ($: $) => {
  await refreshMeasure($).catch(() => undefined)
  await pollLimits($).catch(() => undefined)
  if (await read($, expandedA)) await refreshBreakdown($)
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
    })().catch(error => $.ui.log(`usage-mod: refresh failed (${String(error)})`, { to: 'debug' }))
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

/** The engine refuses a `$.fs.read` over 4 MiB; a long chat's transcript is past it. */
const READ_LIMIT = 4 * 1024 * 1024

/**
 * Hands each line of a text file to `onLine`. A file under the read limit is
 * read at once; a larger one is streamed through a child that prints it
 * (PowerShell on Windows, given the path in its environment so nothing needs
 * quoting; `cat` elsewhere), so it is never held whole.
 */
export const readLines = async ($: $, path: string, onLine: (line: string) => void) => {
  const { size } = await $.fs.stat(path)
  if (size < READ_LIMIT) {
    for (const line of (await $.fs.read(path)).split('\n')) onLine(line)
    return
  }
  const isWindows = (await $.env.get('OS')) === 'Windows_NT'
  const reader = $.process.spawn(
    isWindows
      ? {
          argv: [
            'powershell.exe',
            '-NoProfile',
            '-NonInteractive',
            '-Command',
            '[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false); [Console]::Out.Write([IO.File]::ReadAllText($env:USAGE_MOD_FILE))',
          ],
          env: { USAGE_MOD_FILE: path },
        }
      : { argv: ['cat', path] },
  )
  let rest = ''
  let errors = ''
  for await (const { stream, text } of reader) {
    if (stream === 'stderr') {
      errors += text
      continue
    }
    const lines = (rest + text).split('\n')
    rest = lines.pop() ?? ''
    for (const line of lines) onLine(line)
  }
  onLine(rest)
  const { code } = await reader.result
  if (code !== 0) throw new Error(errors.trim().slice(0, 120) || `reader exited with ${code}`)
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
  const main = transcriptFolder({ before: liveSince })
  try {
    await readLines($, path, main.line)
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
  let model = main.done(emptyModel())
  let skipped = 0
  const subDir = `${path.replace(/\.jsonl$/, '')}/subagents`
  try {
    if (await $.fs.exists(subDir)) {
      for (const entry of await $.fs.list(subDir)) {
        if (!entry.name.endsWith('.jsonl')) continue
        try {
          const agentId = entry.name.replace(/^agent-/, '').replace(/\.jsonl$/, '')
          const sub = transcriptFolder({ before: liveSince, agentId })
          await readLines($, `${subDir}/${entry.name}`, sub.line)
          model = sub.done(model)
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
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const result = await next(e)
    await $.command.register({
      name: 'usage-mod',
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
    const isStatusShown = (await $.store.get(STATUS_KEY).catch(() => undefined)) === true
    await update($, statusA, () => isStatusShown)
    try {
      const m = await $.session.model()
      await update($, modelA, () => m)
    } catch {
      // model unknown
    }
    await refreshMeasure($).catch(() => undefined)
    // Work that may take a while runs off the session's start.
    $.clock.after(50, () => {
      void backfill($).catch(error => $.ui.log(`usage-mod: history not loaded (${String(error)})`, { to: 'debug' }))
      void refreshBreakdown($, true)
    })
    await startTicker($)
    return result
  })

  on('command.run', { command: 'usage-mod' }, async $ => {
    const isHidden = await update($, hiddenA, was => !was)
    // Shown again, the band starts with its details hidden and the menu closed.
    await update($, expandedA, () => false)
    await update($, menuA, () => false)
    if (!isHidden) {
      void refreshMeasure($).then(() => refreshBreakdown($, true))
      await ensureTicker($, await $.clock.now())
    }
    return { text: isHidden ? 'Usage band hidden; /usage-mod shows it again.' : 'Usage band shown above the prompt.' }
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
    $.clock.after(10, () => {
      void syncLive($).then(() => pollLimits($, true))
      void refreshBreakdown($, true)
    })
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
    noteReply(e.rateLimits, now)
    await update($, measureA, prev => toMeasure(now, e, prev))
    if (isReplyNewest(now)) await rememberLimits($, e.rateLimits)
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
      $.clock.after(10, () => void refreshBreakdown($, true))
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

  // The status line rides at the end of the dim hint line under the prompt, which only the terminal draws.
  // ($.ui.status would pin it among the engine's notices, under a warning sign.)
  on('ui.render', { component: 'PromptHint' }, async ($, e, next) => {
    if (e.surface !== 'terminal' || !(await read($, statusA))) return next(e)
    const [usage, measure, breakdown] = await Promise.all([read($, usageA), read($, measureA), read($, breakdownA)])
    const text = statusText(usage as UsageModel, measure as Measure | null, breakdown as Breakdown | null)
    return next({ ...e, props: { ...e.props, tail: e.props.tail ? `${e.props.tail} · ${text}` : ` · ${text}` } })
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey || (await read($, hiddenA))) return next(e)
    const [usage, measure, breakdown, isExpanded, isMenuOpen, isStatusShown, running, backfillState, model, now] = await Promise.all([
      read($, usageA),
      read($, measureA),
      read($, breakdownA),
      read($, expandedA),
      read($, menuA),
      read($, statusA),
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
      isTerminal: surface === 'terminal',
      isStatusShown,
      onMenu: () => update($, menuA, was => !was),
      onExpand: async () => {
        await update($, menuA, () => false)
        const isOpen = await update($, expandedA, was => !was)
        if (isOpen) void refreshBreakdown($, true)
      },
      onStatus: async () => {
        await update($, menuA, () => false)
        const isShown = await update($, statusA, was => !was)
        await $.store.set(STATUS_KEY, isShown).catch(() => undefined)
      },
      onHide: async () => {
        await update($, menuA, () => false)
        await update($, hiddenA, () => true)
        $.ui.toast('Usage band hidden; /usage-mod shows it again.')
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
