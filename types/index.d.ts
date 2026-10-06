export type Tokens = {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}

export type Bucket = Tokens & { requests: number }

export type RequestRow = {
  t: number
  model: string
  agentId?: string
  tokens: Tokens
  stop?: string | null
  isBackfill?: boolean
}

export type TurnRow = {
  id: string
  startedAt: number
  prompt: string
  durationMs?: number
  requests: number
  tokens: Tokens
  tools: number
  costUsd?: number
  costAtStart?: number
  reason?: string
  isBackfill?: boolean
}

export type ToolStat = {
  calls: number
  errors: number
  denied: number
  totalMs: number
  maxMs: number
  timed: number
}

export type CompactionRow = {
  t: number
  trigger: string
  before?: number
  after?: number
}

export type RateLimitRow = { kind: string; percentUsed: number; resetsAt?: string }

export type Measure = {
  at: number
  startedAt?: number
  costUsd?: number
  contextTokens?: number
  contextWindow: number
  contextPercent?: number
  rateLimits: RateLimitRow[]
}

export type BreakdownCategory = {
  name: string
  tokens: number
  color: string
  kind: string
}

export type Breakdown = {
  at: number
  detail: 'summary' | 'full'
  model: string
  totalTokens: number
  rawMaxTokens: number
  percentage: number
  autoCompactThreshold?: number
  isAutoCompactEnabled: boolean
  categories: BreakdownCategory[]
  memoryFiles: { path: string; type: string; tokens: number }[]
  mcpTools: { name: string; serverName: string; tokens: number; isLoaded: boolean }[]
  skills: { name: string; tokens: number }[]
}

export type RunningTool = { id: string; tool: string; since: number; agentId?: string }

export type Backfill = {
  status: 'pending' | 'done' | 'partial' | 'unavailable'
  note?: string
  sessionId?: string
  liveSince: number
  /** The parser version that read the history; an older one is read again. */
  version?: number
}

export type UsageModel = {
  totals: Bucket
  byModel: Record<string, Bucket>
  byAgent: Record<string, Bucket>
  byTool: Record<string, ToolStat>
  requests: RequestRow[]
  turns: TurnRow[]
  compactions: CompactionRow[]
}

declare module 'claude-code' {
  interface PluginState {
    'usage-mod': {
      usage: UsageModel
      measure: Measure | null
      breakdown: Breakdown | null
      isExpanded: boolean
      isHidden: boolean
      isMenuOpen: boolean
      running: RunningTool[]
      backfill: Backfill | null
      model: string
    }
  }
}
