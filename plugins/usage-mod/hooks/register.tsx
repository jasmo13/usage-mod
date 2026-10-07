import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, SessionUsage } from 'claude-code'

import type { Backfill, Breakdown, Measure, RateLimitRow, RunningTool } from '../types'
import {
  addCompaction,
  addRequest,
  addToolCall,
  emptyModel,
  finishTurn,
  liveLimits,
  parseUsage,
  projectSlug,
  shortModel,
  startTurn,
  sumTokens,
  tokensOf,
  transcriptFolder,
} from './collect'
import { band, bandFigures, copiedMeasure, rowsOf, statusLine } from './views'

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
/** The store keys holding whether the details are shown and the band hidden: chosen from the menu or /usage-mod, kept for every chat. */
const DETAILS_KEY = 'details'
const HIDDEN_KEY = 'hidden'
/** Said when the band is hidden, from the menu or /usage-mod. */
const HIDDEN_TOAST = 'Usage band hidden; /usage-mod shows it again.'
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
 * The usage service /usage reads: the account's session and weekly limits as
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
 * Brings the session and weekly limit meters up to the usage service's figures: from
 * another chat's answer under a minute old, else by asking it with the
 * session's own login (held by the engine; none for an API key or a
 * third-party provider, and then replies' readings stand).
 */
const pollLimits = async ($: $, isAfterTurn = false, isNow = false) => {
  const now = await $.clock.now()
  // Asked for now (a copy): straight to the service, whatever the pace.
  if (!isNow && now - polledAt < (isAfterTurn && pollGap === POLL_MS ? MIN_POLL_MS : pollGap)) return
  polledAt = now
  let rows: RateLimitRow[] | undefined
  let takenAt = now
  if (!isAfterTurn && !isNow) {
    const shared = await sharedAnswer($)
    if (shared && now - shared.at < SHARE_MS) {
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
  await showService($, rows, takenAt, now)
}

/** The usage service's last answer, kept by whichever chat asked: when it was taken and the limits it gave. */
const sharedAnswer = async ($: $) => {
  const kept = (await $.store.get(SERVICE_KEY).catch(() => undefined)) as { at?: number; rateLimits?: RateLimitRow[] } | undefined
  return kept?.at !== undefined && Array.isArray(kept.rateLimits) ? { at: kept.at, rateLimits: kept.rateLimits } : undefined
}

/** Shows the usage service's figures, taken at `takenAt` by this chat or another. */
const showService = async ($: $, rows: readonly RateLimitRow[], takenAt: number, now: number) => {
  fromService = true
  serviceAt = takenAt
  const live = liveLimits(rows, now)
  await update($, measureA, was => (was ? { ...was, rateLimits: live } : was))
  await rememberLimits($, live)
}

/**
 * Takes another chat's answer from the usage service the moment it is kept, rather than at this
 * chat's next ask: the limits are the account's, so a reply in any chat moves them in all.
 */
const adoptShared = async ($: $) => {
  const shared = await sharedAnswer($)
  if (!shared || (fromService && shared.at <= serviceAt)) return
  const now = await $.clock.now()
  if (now - shared.at > STALE_MS) return
  polledAt = now
  await showService($, shared.rateLimits, shared.at, now)
}

/**
 * What one chat changes that every chat shows (a slash command such as /autocompact or /login, a setting,
 * a Copy JSON's fresh reading), noted in the store, whose files every chat watches: the others read
 * everything again at once. A chat passes over its own notes, and reading again never writes one.
 */
const NUDGE_KEY = 'changed'
let nudgeSeen = 0
const nudgeOthers = async ($: $) => {
  const [at, by] = await Promise.all([$.clock.now(), $.session.id()])
  nudgeSeen = Math.max(nudgeSeen, at)
  await $.store.set(NUDGE_KEY, { at, by }).catch(() => undefined)
}

// Where the transcript is, once a settings-hook event has said; a guess until then.
let transcriptPath: string | undefined
// When the context breakdown was last counted, whether a count is running, and whether another is owed once it ends.
let breakdownAt = 0
let isCounting = false
let isOwed = false
// The count running now, and the history being read, for a copy to wait on.
let counting: Promise<void> | undefined
let backfilling: Promise<void> | undefined
// Whether a copy is checking everything before it copies.
let isCopying = false
// The refresh timer, and when it last fired: a draw that finds it stale starts it again.
let ticker: { cancel: () => void } | undefined
let tickedAt = 0
let isTicking = false

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
  counting = countBreakdown($, now)
  await counting
}

const countBreakdown = async ($: $, now: number) => {
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
    counting = undefined
    if (isOwed) {
      isOwed = false
      void refreshBreakdown($, true)
    }
  }
}

/**
 * The main loop's model, as `/model` shows it: read when the session starts, on a switch, and
 * every tick, so a switch shows before the next reply rather than with it. The window
 * and where compaction starts can change with the model (200k, 1M), so a new one counts the
 * context again, details shown or not: the Context window meter reads them too.
 */
const syncModel = async ($: $) => {
  const m = await $.session.model().catch(() => undefined)
  if (!m || shortModel(m) === shortModel(await read($, modelA))) return
  await update($, modelA, () => m)
  await refreshMeasure($).catch(() => undefined)
  void refreshBreakdown($, true)
}

/**
 * Brings the model, cost, context and limits up to the moment, and the context breakdown
 * while the details show it: called every tick and on every request, tool result and turn.
 */
const syncLive = async ($: $) => {
  await syncModel($)
  await refreshMeasure($).catch(() => undefined)
  await pollLimits($).catch(() => undefined)
  if (await read($, expandedA)) await refreshBreakdown($)
}

/**
 * Everything the band shows, read again before a copy, each from where it comes: the model, cost and
 * context, the limits from the usage service itself, the context counted exactly (after any count already
 * running, which may predate the press), and the history, should it still be loading.
 */
const checkAll = async ($: $) => {
  const asked = await $.clock.now()
  await syncModel($).catch(() => undefined)
  await refreshMeasure($).catch(() => undefined)
  await pollLimits($, false, true).catch(() => undefined)
  // Done once a count begun since the press has finished, whoever began it.
  for (;;) {
    while (counting) await counting
    if (breakdownAt >= asked) break
    await refreshBreakdown($, true)
  }
  await backfilling
}

/** How often the band redraws and reads cost, context, the model and the window (the limits keep their own pace). */
const TICK_MS = 1000

/**
 * The choices made in any chat, kept for every chat: a fresh install shows the band, its details tucked away,
 * and no status line. Read again each tick and whenever another chat writes the store, so a chat already open
 * (the desktop keeps several) follows a change made in another.
 */
const syncChoices = async ($: $) => {
  const chosen = async (key: string) => (await $.store.get(key).catch(() => undefined)) === true
  const [isStatusShown, isExpanded, isHidden] = await Promise.all([chosen(STATUS_KEY), chosen(DETAILS_KEY), chosen(HIDDEN_KEY)])
  // Written only on a change, so the band draws again only when one came from elsewhere.
  if ((await read($, statusA)) !== isStatusShown) await update($, statusA, () => isStatusShown)
  if ((await read($, hiddenA)) !== isHidden) await update($, hiddenA, () => isHidden)
  if ((await read($, expandedA)) !== isExpanded) {
    await update($, expandedA, () => isExpanded)
    if (isExpanded) void refreshBreakdown($, true)
  }
}

/**
 * The window and where compaction starts, by the quick local estimate: counted exactly again when
 * either moved, however it was moved (/autocompact, a model or a setting changed where no hook hears it).
 */
const checkWindow = async ($: $) => {
  if (isCounting) return
  const b = (await $.session.usage({ breakdown: 'summary' }).catch(() => undefined))?.context.breakdown
  const shown = await read($, breakdownA)
  if (!b || !shown) return
  const moved =
    b.rawMaxTokens !== shown.rawMaxTokens || b.autoCompactThreshold !== shown.autoCompactThreshold || b.isAutoCompactEnabled !== shown.isAutoCompactEnabled
  if (moved) await refreshBreakdown($, true)
}

/**
 * The store changed, in this chat or another: the choices read again, another chat's answer from the
 * usage service taken, and, on another chat's note, everything read again. One at a time; a change
 * heard meanwhile runs it once more after.
 */
let isHearing = false
let isHeardAgain = false
const hearStore = async ($: $) => {
  if (isHearing) return void (isHeardAgain = true)
  isHearing = true
  try {
    do {
      isHeardAgain = false
      await syncChoices($)
      await adoptShared($)
      const note = (await $.store.get(NUDGE_KEY).catch(() => undefined)) as { at?: number; by?: string } | undefined
      if (note?.at === undefined || note.at <= nudgeSeen) continue
      nudgeSeen = note.at
      if (note.by === (await $.session.id())) continue
      await syncModel($)
      await refreshMeasure($).catch(() => undefined)
      await checkWindow($)
      $.ui.invalidate('ui.render')
    } while (isHeardAgain)
  } finally {
    isHearing = false
  }
}

/**
 * Keeps the band in step with the chat whether or not anything is happening
 * (durations, countdowns, cost and context all move between events). Replaces
 * any timer already running, so a new chat or a restart never runs two.
 */
const startTicker = async ($: $) => {
  ticker?.cancel()
  isTicking = false
  tickedAt = await $.clock.now()
  ticker = $.clock.every(TICK_MS, () => {
    // A tick still running when the next comes (a slow read) lets that one pass rather than pile up.
    if (isTicking) return
    isTicking = true
    void (async () => {
      tickedAt = await $.clock.now()
      await syncChoices($)
      // A hidden band with the status line off has nothing to keep fresh; the line alone still counts down.
      if ((await read($, hiddenA)) && !(await read($, statusA))) return
      await syncLive($)
      await checkWindow($)
      $.ui.invalidate('ui.render')
    })()
      .catch(error => $.ui.log(`usage-mod: refresh failed (${String(error)})`, { to: 'debug' }))
      .finally(() => (isTicking = false))
  })
}

/** Starts the timer again when it has gone quiet: called while drawing. */
const ensureTicker = async ($: $, now: number) => {
  if (!ticker || now - tickedAt > TICK_MS * 3) await startTicker($)
}

/** Claude Code's configuration directory: ~/.claude unless CLAUDE_CONFIG_DIR moves it. */
const configDir = async ($: $) =>
  (await $.env.get('CLAUDE_CONFIG_DIR')) ?? `${(await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME')) ?? '~'}/.claude`

/** Whether a path is one of the store's files, written with either slash and in any case, as Windows allows. */
const isStoreFile = (path: string) => /\/plugins\/store\/usage-mod_[^/]*\.json$/.test(path.replace(/\\/g, '/').toLowerCase())

/**
 * The store's files, one per place the plugin was installed from (usage-mod_<source>-<hash>.json),
 * for the session to watch: a choice written in any chat reaches every other at once, rather
 * than on the next tick. A fresh install has none until something is kept, so one is kept first.
 */
const findStoreFiles = async ($: $) => {
  const dir = `${await configDir($)}/plugins/store`
  const list = async () =>
    (await $.fs.list(dir).catch(() => [])).filter(f => f.name.startsWith('usage-mod_') && f.name.endsWith('.json')).map(f => `${dir}/${f.name}`)
  let files = await list()
  if (files.length === 0) {
    await $.store.set(HIDDEN_KEY, (await $.store.get(HIDDEN_KEY)) === true)
    files = await list()
  }
  return files
}

/** Finds this session's transcript: the path a settings hook was given, else ~/.claude/projects/<slug>/<id>.jsonl. */
const findTranscript = async ($: $, sessionId: string) => {
  if (transcriptPath && (await $.fs.exists(transcriptPath))) return transcriptPath
  const projects = `${await configDir($)}/projects`
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
const readLines =async ($: $, path: string, onLine: (line: string) => void) => {
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
    // A new chat has no transcript until its first message, and nothing before the mod to count.
    const m = await read($, measureA)
    if (!m?.costUsd) return void (await set({ status: 'done', sessionId, liveSince, version: BACKFILL_VERSION }))
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
      await update($, menuA, () => false)
    }
    await syncChoices($)
    await syncModel($)
    await refreshMeasure($).catch(() => undefined)
    // Work that may take a while runs off the session's start.
    $.clock.after(50, () => {
      backfilling = backfill($).catch(error => $.ui.log(`usage-mod: history not loaded (${String(error)})`, { to: 'debug' }))
      void refreshBreakdown($, true)
    })
    await startTicker($)
    return result
  })

  on('command.run', { command: 'usage-mod' }, async $ => {
    const isHidden = await update($, hiddenA, was => !was)
    await $.store.set(HIDDEN_KEY, isHidden).catch(() => undefined)
    // Shown again, the band keeps its details as they were chosen, with the menu closed.
    await update($, menuA, () => false)
    if (!isHidden) {
      void refreshMeasure($).then(() => refreshBreakdown($, true))
      await ensureTicker($, await $.clock.now())
    }
    // Said as a notification, as the menu says it, rather than as a line in the transcript.
    $.ui.toast(isHidden ? HIDDEN_TOAST : 'Usage band shown.')
    return {}
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
  // The store's files are watched for the session, so a choice made in another chat shows here at once.
  on('classic.SessionStart', async ($, e, next) => {
    transcriptPath = e.transcript_path || transcriptPath
    const result = await next(e)
    const files = await findStoreFiles($).catch(() => [])
    return files.length > 0 ? { ...result, watchPaths: [...(result.watchPaths ?? []), ...files] } : result
  })
  on('classic.FileChanged', ($, e, next) => {
    // Known by name, so a hot reload (which keeps the watch but forgets everything here) still hears it.
    if (isStoreFile(e.file_path)) void hearStore($).catch(() => undefined)
    return next(e)
  })
  // /model, the picker or the SDK: the band names the new model at once, not after its first reply.
  on('classic.PostModelSwitch', ($, e, next) => {
    void syncModel($).catch(() => undefined)
    return next(e)
  })
  // Every slash command, once it has run: many move what the band shows (/model, /fast, /autocompact,
  // /config, /compact, /clear, /mcp, /reload-plugins, /init, /output-style, /login), and new ones come
  // with new releases, so the model, cost, context, its breakdown and the limits are all read again.
  on('command.run', async ($, e, next) => {
    const result = await next(e)
    void (async () => {
      await nudgeOthers($)
      await syncModel($)
      await refreshMeasure($)
      await pollLimits($, true)
      await refreshBreakdown($, true)
    })().catch(() => undefined)
    return result
  })
  // A setting that moves the window or where compaction starts (auto-compact in /config, a settings file
  // edited) is counted again once the change is in, so the meter follows it before the next reply. One set
  // here reaches the other chats by a note; an edited settings file reaches each chat by itself.
  on('config.set', ($, e, next) => {
    $.clock.after(10, () => {
      void refreshBreakdown($, true)
      void nudgeOthers($)
    })
    return next(e)
  })
  on('classic.ConfigChange', ($, e, next) => {
    $.clock.after(10, () => void refreshBreakdown($, true))
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

  // The status line: a line of its own under the hint line below the prompt, which only the terminal draws.
  // ($.ui.status would pin it among the engine's notices, under a warning sign.)
  on('ui.render', { component: 'PromptHint' }, async ($, e, next) => {
    if (e.surface !== 'terminal' || !(await read($, statusA))) return next(e)
    const [usage, measure, breakdown, now] = await Promise.all([read($, usageA), read($, measureA), read($, breakdownA), $.clock.now()])
    const T = $.ui.resolve(e)
    // The engine's own line stays as it draws it, its pills live; the terminal draws it first, whatever the order here.
    const hint = await next(e)
    // The line sits two cells in from each edge; below that it condenses rather than cut off.
    const width = e.viewport ? e.viewport.columns - 4 : undefined
    return (
      <T.Box flexDirection="column">
        {hint}
        {statusLine(T, usage, measure, breakdown, now, width)}
      </T.Box>
    )
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
    // The slot holds one tree, so the bands of the plugins beneath this one are drawn above it, then a
    // blank row and a rule, rather than replaced; this band keeps the rows they leave.
    const others = await next(e)
    const otherRows = rowsOf(others)
    const own = band({
      T,
      Svg: surface !== 'terminal' && 'Svg' in T ? T.Svg : undefined,
      cols: e.props.bodyColumns,
      maxRows: otherRows === 0 ? e.props.maxRows : Math.max(1, e.props.maxRows - otherRows - 2),
      now,
      usage: usage,
      measure: measure,
      breakdown: breakdown,
      running: running,
      backfill: backfillState,
      model: model,
      isExpanded,
      isMenuOpen,
      isTerminal: surface === 'terminal',
      isStatusShown,
      onMenu: () => update($, menuA, was => !was),
      onExpand: async () => {
        await update($, menuA, () => false)
        const isOpen = await update($, expandedA, was => !was)
        await $.store.set(DETAILS_KEY, isOpen).catch(() => undefined)
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
        await $.store.set(HIDDEN_KEY, true).catch(() => undefined)
        $.ui.toast(HIDDEN_TOAST)
      },
      onCopy: async () => {
        await update($, menuA, () => false)
        // A second press while the first is still checking copies nothing more.
        if (isCopying) return
        isCopying = true
        try {
          await checkAll($)
        } finally {
          isCopying = false
        }
        // What the copy just read fresh, the other chats read too.
        void nudgeOthers($)
        const [u, m, b, running, model, now] = await Promise.all([
          read($, usageA),
          read($, measureA),
          read($, breakdownA),
          read($, runningA),
          read($, modelA),
          $.clock.now(),
        ])
        const figures = bandFigures({ now, usage: u, measure: m, breakdown: b, running, model })
        const text = JSON.stringify(
          { generatedAt: new Date(now).toISOString(), sessionId: await $.session.id(), band: figures, measure: copiedMeasure(m, b), ...u, totals: { ...u.totals, all: sumTokens(u.totals) }, breakdown: b },
          null,
          2,
        )
        const copied = await $.ui.copy({ text, surface })
        $.ui.toast(copied.isCopied ? 'Usage JSON copied.' : `Could not copy: ${copied.reason}`)
      },
    })
    if (otherRows === 0) return own
    return (
      <T.Box flexDirection="column">
        {others}
        {/* A rule wider than any band, clipped to one row, so it never wraps or ends in an ellipsis. */}
        <T.Box key="rule" marginTop={1} height={1} overflow="hidden">
          <T.Box width={1000} flexShrink={0}>
            <T.Text dimColor>{'─'.repeat(500)}</T.Text>
          </T.Box>
        </T.Box>
        {own}
      </T.Box>
    )
  })
}
