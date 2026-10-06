import type {
  Bucket,
  CompactionRow,
  RateLimitRow,
  RequestRow,
  ToolStat,
  Tokens,
  TurnRow,
  UsageModel,
} from '../types'

export const MAX_REQUESTS = 400
export const MAX_TURNS = 150

export const zeroTokens = (): Tokens => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 })
export const zeroBucket = (): Bucket => ({ ...zeroTokens(), requests: 0 })

export const emptyModel = (): UsageModel => ({
  totals: zeroBucket(),
  byModel: {},
  byAgent: {},
  byTool: {},
  requests: [],
  turns: [],
  compactions: [],
})

type ApiUsage = {
  input_tokens?: number | null
  output_tokens?: number | null
  cache_read_input_tokens?: number | null
  cache_creation_input_tokens?: number | null
}

export const tokensOf = (u: ApiUsage): Tokens => ({
  input: u.input_tokens ?? 0,
  output: u.output_tokens ?? 0,
  cacheRead: u.cache_read_input_tokens ?? 0,
  cacheWrite: u.cache_creation_input_tokens ?? 0,
})

export const addTokens = <T extends Tokens>(a: T, b: Tokens): T => ({
  ...a,
  input: a.input + b.input,
  output: a.output + b.output,
  cacheRead: a.cacheRead + b.cacheRead,
  cacheWrite: a.cacheWrite + b.cacheWrite,
})

export const sumTokens = (t: Tokens) => t.input + t.output + t.cacheRead + t.cacheWrite
export const promptTokens = (t: Tokens) => t.input + t.cacheRead + t.cacheWrite

/** Share of prompt tokens served from the cache, 0..1. */
export const cacheHitRate = (t: Tokens) => {
  const all = promptTokens(t)
  return all === 0 ? 0 : t.cacheRead / all
}

const bump = (map: Record<string, Bucket>, key: string, t: Tokens) => ({
  ...map,
  [key]: { ...addTokens(map[key] ?? zeroBucket(), t), requests: (map[key]?.requests ?? 0) + 1 },
})

/** Folds one model request into the model; the open turn (last, no duration) gets it too. */
export const addRequest = (m: UsageModel, row: RequestRow): UsageModel => {
  const turns = m.turns.slice()
  const open = turns.at(-1)
  if (open && open.durationMs === undefined && !row.isBackfill) {
    turns[turns.length - 1] = {
      ...open,
      requests: open.requests + 1,
      tokens: addTokens(open.tokens, row.tokens),
    }
  }

  return {
    ...m,
    totals: { ...addTokens(m.totals, row.tokens), requests: m.totals.requests + 1 },
    byModel: bump(m.byModel, row.model || 'unknown', row.tokens),
    byAgent: bump(m.byAgent, row.agentId ?? 'main', row.tokens),
    requests: [...m.requests, row].sort((a, b) => a.t - b.t).slice(-MAX_REQUESTS),
    turns,
  }
}

export const startTurn = (m: UsageModel, turn: TurnRow): UsageModel => ({
  ...m,
  turns: [...m.turns, turn].slice(-MAX_TURNS),
})

export const finishTurn = (
  m: UsageModel,
  id: string,
  fields: { durationMs: number; reason: string; costUsd?: number },
): UsageModel => ({
  ...m,
  turns: m.turns.map(t => (t.id === id ? { ...t, ...fields } : t)),
})

const zeroTool = (): ToolStat => ({ calls: 0, errors: 0, denied: 0, totalMs: 0, maxMs: 0, timed: 0 })

export const addToolCall = (
  m: UsageModel,
  tool: string,
  outcome: { ms?: number; isError?: boolean; isDenied?: boolean },
): UsageModel => {
  const was = m.byTool[tool] ?? zeroTool()
  const ms = outcome.ms
  const turns = m.turns.slice()
  const open = turns.at(-1)
  if (open && open.durationMs === undefined && ms !== undefined) {
    turns[turns.length - 1] = { ...open, tools: open.tools + 1 }
  }

  return {
    ...m,
    turns,
    byTool: {
      ...m.byTool,
      [tool]: {
        calls: was.calls + 1,
        errors: was.errors + (outcome.isError ? 1 : 0),
        denied: was.denied + (outcome.isDenied ? 1 : 0),
        totalMs: was.totalMs + (ms ?? 0),
        maxMs: Math.max(was.maxMs, ms ?? 0),
        timed: was.timed + (ms === undefined ? 0 : 1),
      },
    },
  }
}

/** The rate-limit readings whose window has not reset yet; a reset one no longer says anything. */
export const liveLimits = (rows: readonly RateLimitRow[], now: number) =>
  rows.filter(l => l.resetsAt === undefined || !(Date.parse(l.resetsAt) <= now))

/** The windows the band draws a meter for. */
const LIMIT_KINDS = ['five_hour', 'seven_day'] as const

/**
 * Reads the usage service's answer (`{ five_hour: { utilization, resets_at }, ... }`)
 * as rate-limit rows: the windows the band draws, each with a percentage; an
 * answer of any other shape gives none.
 */
export const parseUsage = (text: string): RateLimitRow[] => {
  let body: unknown
  try {
    body = JSON.parse(text)
  } catch {
    return []
  }
  if (!body || typeof body !== 'object') return []
  const rows: RateLimitRow[] = []
  for (const kind of LIMIT_KINDS) {
    const w = (body as Record<string, { utilization?: unknown; resets_at?: unknown } | null | undefined>)[kind]
    if (!w || typeof w.utilization !== 'number' || !Number.isFinite(w.utilization)) continue
    const reset = typeof w.resets_at === 'string' ? Date.parse(w.resets_at) : NaN
    rows.push({
      kind,
      percentUsed: Math.round(w.utilization * 10) / 10,
      resetsAt: Number.isFinite(reset) ? new Date(reset).toISOString() : undefined,
    })
  }
  return rows
}

export const addCompaction = (m: UsageModel, row: CompactionRow): UsageModel => ({
  ...m,
  compactions: [...m.compactions, row].slice(-50),
})

/** Cumulative cost per turn, oldest first, from turns that recorded one. */
export const costSeries = (turns: readonly TurnRow[]) => {
  let total = 0
  return turns
    .filter(t => t.costUsd !== undefined)
    .map(t => {
      total += t.costUsd ?? 0
      return { t: t.startedAt + (t.durationMs ?? 0), total }
    })
}

/* ---------- transcript backfill ---------- */

type Row = {
  type?: string
  timestamp?: string
  isMeta?: boolean
  isSidechain?: boolean
  isCompactSummary?: boolean
  uuid?: string
  message?: {
    id?: string
    model?: string
    role?: string
    stop_reason?: string | null
    usage?: ApiUsage
    content?: unknown
  }
}

type ToolUseBlock = { type: 'tool_use'; name: string; id: string }
type ToolResultBlock = { type: 'tool_result'; tool_use_id: string; is_error?: boolean }

const isToolUse = (b: unknown): b is ToolUseBlock =>
  typeof b === 'object' && b !== null && (b as { type?: string }).type === 'tool_use'
const isToolResult = (b: unknown): b is ToolResultBlock =>
  typeof b === 'object' && b !== null && (b as { type?: string }).type === 'tool_result'

/** Engine-written text a prompt row can carry: command echoes, reminders, notices. */
const SYSTEM_TEXT = /^\s*<(local-command|command-name|command-message|command-args|system-reminder|task-notification)/

/** The person's own words in a user row; reminders the app prepends are dropped. */
const promptText = (content: unknown): string | undefined => {
  if (typeof content === 'string') return SYSTEM_TEXT.test(content) ? undefined : content
  if (!Array.isArray(content)) return undefined
  if (content.some(isToolResult)) return undefined
  const text = content
    .filter((b): b is { type: 'text'; text: string } => (b as { type?: string })?.type === 'text')
    .map(b => b.text)
    .filter(t => !SYSTEM_TEXT.test(t))
    .join(' ')
  return text.trim() || undefined
}

/**
 * Folds a transcript JSONL file into the model one line at a time, so a file
 * read in pieces is never held whole: each assistant API message once (a
 * message is written as one row per content block, all carrying the same
 * usage), tool uses and their error results, and user prompts as turns. Rows
 * at or after `before` (ms) are left to the live hooks. `done` adds it all to
 * the model.
 */
export const transcriptFolder = (options: { before: number; agentId?: string }) => {
  const seen = new Set<string>()
  const toolNames = new Map<string, string>()
  const toolTimes: number[] = []
  const errored = new Set<string>()
  const prompts: TurnRow[] = []
  const reqs: RequestRow[] = []

  const line = (text: string) => {
    if (!text.trim()) return
    let row: Row
    try {
      row = JSON.parse(text) as Row
    } catch {
      return
    }
    const t = row.timestamp ? Date.parse(row.timestamp) : NaN
    if (!Number.isFinite(t) || t >= options.before) return
    const msg = row.message
    if (!msg) return

    if (row.type === 'assistant' && msg.usage) {
      const id = msg.id ?? row.uuid ?? `${t}`
      if (Array.isArray(msg.content)) {
        for (const b of msg.content) {
          if (!isToolUse(b) || toolNames.has(b.id)) continue
          toolNames.set(b.id, b.name)
          if (!options.agentId) toolTimes.push(t)
        }
      }
      if (seen.has(id)) return
      seen.add(id)
      if (msg.model === '<synthetic>') return
      reqs.push({
        t,
        model: msg.model ?? 'unknown',
        agentId: options.agentId,
        tokens: tokensOf(msg.usage),
        stop: msg.stop_reason ?? null,
        isBackfill: true,
      })
    } else if (row.type === 'user') {
      if (Array.isArray(msg.content)) {
        for (const b of msg.content) if (isToolResult(b) && b.is_error) errored.add(b.tool_use_id)
      }
      if (options.agentId || row.isMeta || row.isSidechain || row.isCompactSummary) return
      const text = promptText(msg.content)
      if (text) {
        prompts.push({
          id: row.uuid ?? `bf-${t}`,
          startedAt: t,
          prompt: text.replace(/\s+/g, ' ').trim().slice(0, 120),
          requests: 0,
          tokens: zeroTokens(),
          tools: 0,
          isBackfill: true,
        })
      }
    }
  }

  const done = (m: UsageModel): UsageModel => {
    let model = m
    for (const r of reqs) model = addRequest(model, r)
    for (const [id, name] of toolNames) model = addToolCall(model, name, { isError: errored.has(id) })

    if (prompts.length > 0) {
      // Assign each backfilled request to the prompt it followed; a turn's
      // duration is up to its last request.
      const filled = prompts.map((p, i) => {
        const end = prompts[i + 1]?.startedAt ?? options.before
        const mine = reqs.filter(r => r.t >= p.startedAt && r.t < end)
        const tokens = mine.reduce((acc, r) => addTokens(acc, r.tokens), zeroTokens())
        const last = mine.at(-1)?.t ?? p.startedAt
        const tools = toolTimes.filter(x => x >= p.startedAt && x < end).length
        return {
          ...p,
          requests: mine.length,
          tokens,
          tools,
          durationMs: Math.max(0, last - p.startedAt),
          reason: 'answer',
        }
      })
      model = { ...model, turns: [...filled, ...model.turns].sort((a, b) => a.startedAt - b.startedAt).slice(-MAX_TURNS) }
    }

    return model
  }

  return { line, done }
}

/** Folds a whole transcript held as text; see `transcriptFolder`. */
export const foldTranscript = (
  m: UsageModel,
  jsonl: string,
  options: { before: number; agentId?: string },
): UsageModel => {
  const folder = transcriptFolder(options)
  for (const line of jsonl.split('\n')) folder.line(line)
  return folder.done(m)
}

/** The folder name Claude Code keeps a project's transcripts under. */
export const projectSlug = (cwd: string) => cwd.replace(/[^A-Za-z0-9]/g, '-')

/* ---------- formatting ---------- */

export const fmtTokens = (n: number) => {
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`
  if (n >= 1e6) return `${(n / 1e6).toFixed(n >= 1e7 ? 1 : 2)}M`
  if (n >= 1e3) return `${(n / 1e3).toFixed(n >= 1e4 ? 0 : 1)}k`
  return `${Math.round(n)}`
}

export const fmtUsd = (n: number | undefined) =>
  n === undefined ? '—' : n >= 100 ? `$${n.toFixed(0)}` : n >= 1 ? `$${n.toFixed(2)}` : `$${n.toFixed(3)}`

export const fmtMs = (ms: number) => {
  if (ms < 1000) return `${Math.round(ms)}ms`
  const s = ms / 1000
  if (s < 60) return `${s.toFixed(s < 10 ? 1 : 0)}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${Math.round(s % 60)}s`
  return `${Math.floor(m / 60)}h ${m % 60}m`
}

export const fmtPct = (n: number) => `${n >= 10 || n === 0 ? Math.round(n) : n.toFixed(1)}%`

export const fmtClock = (t: number) => {
  const d = new Date(t)
  const hh = `${d.getHours()}`.padStart(2, '0')
  const mm = `${d.getMinutes()}`.padStart(2, '0')
  return `${hh}:${mm}`
}

export const fmtUntil = (iso: string | undefined, now: number) => {
  if (!iso) return ''
  const ms = Date.parse(iso) - now
  if (!Number.isFinite(ms)) return ''
  if (ms <= 0) return 'resetting'
  return `resets in ${fmtMs(ms)}`
}

export const shortModel = (id: string) =>
  id
    .replace(/^claude-/, '')
    .replace(/-\d{8}$/, '')
    .replace(/\[.*\]$/, '')

export const rateLabel = (kind: string) =>
  kind === 'five_hour' ? '5-hour' : kind === 'seven_day' ? '7-day' : kind === 'spend_limit' ? 'Spend' : kind.replace(/_/g, ' ')
