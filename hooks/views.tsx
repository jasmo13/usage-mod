import type { BoxProps, ButtonProps, ElementConstructor, RenderElement, RenderNode, SvgProps, TextProps } from 'claude-code'

import type { Backfill, Breakdown, Measure, RunningTool, Tokens, UsageModel } from '../types'
import { cacheHitRate, fmtMs, fmtPct, fmtTokens, fmtUsd, rateLabel, shortModel, sumTokens } from './collect'

/* ---------- what the band is drawn from ---------- */

export type Base = {
  Box: ElementConstructor<BoxProps>
  Text: ElementConstructor<TextProps>
  Button: ElementConstructor<ButtonProps>
}

export type Ctx = {
  T: Base
  /** Present on the desktop: bars and sparklines are drawn as small vectors. */
  Svg?: ElementConstructor<SvgProps>
  cols: number
  maxRows: number
  now: number
  usage: UsageModel
  measure: Measure | null
  breakdown: Breakdown | null
  running: RunningTool[]
  backfill: Backfill | null
  model: string
  isExpanded: boolean
  isMenuOpen: boolean
  /** The terminal has a status line under the prompt; the desktop draws none for plugins. */
  isTerminal: boolean
  isStatusShown: boolean
  onMenu: () => unknown
  onExpand: () => unknown
  onStatus: () => unknown
  onHide: () => unknown
  onCopy: () => unknown
}

/* ---------- palette ---------- */

/**
 * A color in both forms: `hex`, mid-tones that read on light and dark
 * backgrounds alike, drawn on every surface so each category keeps a color of
 * its own (the terminal's theme has too few keys, and they repeat); `key`, a
 * theme key, for the translucent track and buffer the terminal cannot draw.
 */
type Paint = { hex: string; key: string }

const P = {
  ember: { hex: '#D97757', key: 'claude' },
  ochre: { hex: '#C9973B', key: 'warning' },
  sage: { hex: '#5E9E7A', key: 'success' },
  slate: { hex: '#6B8FD6', key: 'suggestion' },
  heather: { hex: '#9A84D0', key: 'permission' },
  teal: { hex: '#3E9BA6', key: 'suggestion' },
  sand: { hex: '#B5A486', key: 'inactive' },
  rose: { hex: '#C77DA0', key: 'permission' },
  stone: { hex: '#8A8F98', key: 'inactive' },
  red: { hex: '#D9574F', key: 'error' },
} as const satisfies Record<string, Paint>

const TRACK: Paint = { hex: 'rgba(128,128,128,0.22)', key: 'subtle' }
const TICK_HEX = 'rgba(128,128,128,0.85)'
const BUFFER: Paint = { hex: 'rgba(128,128,128,0.5)', key: 'inactive' }

const KINDS = [
  { key: 'input', label: 'Input', paint: P.slate },
  { key: 'cacheWrite', label: 'Cache write', paint: P.ochre },
  { key: 'cacheRead', label: 'Cache read', paint: P.sage },
  { key: 'output', label: 'Output', paint: P.ember },
] as const

/** /context's categories: a short name and a color of this palette each. */
const CATEGORY: Record<string, { name: string; paint: Paint }> = {
  Messages: { name: 'Messages', paint: P.heather },
  'System tools': { name: 'Tools', paint: P.sand },
  'MCP tools': { name: 'MCP', paint: P.teal },
  Skills: { name: 'Skills', paint: P.ochre },
  'System prompt': { name: 'System', paint: P.slate },
  'Memory files': { name: 'Memory', paint: P.sage },
  'Custom agents': { name: 'Agents', paint: P.rose },
  'MCP server instructions': { name: 'MCP notes', paint: P.teal },
}
const SPARE = [P.rose, P.teal, P.slate, P.sage, P.ochre]

const color = (ctx: Ctx, p: Paint) => (ctx.Svg || p.hex.startsWith('#') ? p.hex : p.key)

/* ---------- layout ---------- */

const GAP = 3
/** Cells kept free so a font a little wider than the estimate never wraps a tile. */
const SLACK = 4
/** Desktop CSS pixels per terminal cell, for sizing a vector to its column. */
const PX = 8

/* ---------- formatting ---------- */

const EIGHTHS = ['', '▏', '▎', '▍', '▌', '▋', '▊', '▉']

/** A block meter: `width` cells, filled to `frac` with eighth-cell precision. */
export const textBar = (frac: number, width: number) => {
  const f = Math.max(0, Math.min(1, frac)) * width
  const full = Math.floor(f)
  const part = EIGHTHS[Math.round((f - full) * 8)] ?? ''
  const filled = '█'.repeat(full) + (full < width ? part : '')
  return { filled, rest: '░'.repeat(Math.max(0, width - [...filled].length)) }
}

/**
 * When a limit resets, as the app's panel writes it, longest first for the row
 * to pick from: the time left for the session limit ("Resets in 2 hr 37 min"),
 * the local day and time for the weekly ones ("Resets Wed 4:00 AM").
 */
const fmtReset = (kind: string, iso: string | undefined, now: number): string[] => {
  // To the nearest minute, as the panel does: the service gives 09:59:59.965 for a 10:00 reset.
  const at = iso === undefined ? NaN : Math.round(Date.parse(iso) / 60_000) * 60_000
  if (!Number.isFinite(at)) return []
  if (at <= now) return ['Resetting']
  if (kind === 'five_hour') {
    // Partial minutes count up, as the panel does: 2 hr 16 min 30 s left reads "2 hr 17 min".
    const mins = Math.max(1, Math.ceil((at - now) / 60_000))
    const h = Math.floor(mins / 60)
    const m = mins % 60
    const span = h === 0 ? `${m} min` : m === 0 ? `${h} hr` : `${h} hr ${m} min`
    return [`Resets in ${span}`, span, h === 0 ? `${m}m` : `${h}h ${`${m}`.padStart(2, '0')}m`]
  }
  const when = new Date(at).toLocaleString('en-US', { weekday: 'short', hour: 'numeric', minute: '2-digit' })
  return [`Resets ${when}`, when]
}

/** A token count: one place always in the terminal, as the app writes it elsewhere. */
const tok = (ctx: Ctx, n: number) => fmtTokens(n, ctx.isTerminal)

/** Each limit's name as the app's panel gives it, then shorter ones for tight rows. */
const LIMIT_NAMES: Record<string, string[]> = {
  five_hour: ['Session limit', 'Session', '5h'],
  seven_day: ['Weekly · all models', 'Weekly', '7d'],
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

/**
 * The context against its window: the breakdown's, which is the compaction
 * window where one is set (300k of a 1M model) and the model's limit where not.
 * `left` counts to where compaction runs, `tick` marks it on the window.
 */
const compaction = (m: Measure | null, b: Breakdown | null) => {
  if (!b || !b.rawMaxTokens) return undefined
  const window = b.rawMaxTokens
  const tokens = m?.contextTokens ?? b.totalTokens
  const at = b.isAutoCompactEnabled ? b.autoCompactThreshold : undefined
  return {
    window,
    tokens,
    at,
    pct: (tokens / window) * 100,
    left: Math.max(0, (at ?? window) - tokens),
    tick: at ? at / window : undefined,
  }
}

const sessionStart = (ctx: Ctx) => ctx.measure?.startedAt ?? ctx.usage.requests[0]?.t ?? ctx.usage.turns[0]?.startedAt

/* ---------- vectors (desktop) ---------- */

type Segment = { key: string; value: number; paint: Paint }

const svgDoc = (w: number, h: number, body: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">${body}</svg>`

/**
 * A capsule bar: the segments as separate rounded pills with a hairline gap
 * between them, on a translucent track; `tick` marks a fraction of the whole.
 */
const capsuleSvg = (segments: readonly Segment[], total: number, w: number, h: number, tick?: number) => {
  const r = h / 2
  const shown = segments.filter(s => s.value > 0)
  const gap = shown.length > 1 ? 2 : 0
  let x = 0
  const pills = shown.map((s, i) => {
    const width = Math.max(h, (s.value / Math.max(total, 1)) * w)
    const drawn = Math.max(1, Math.min(w - x, width - (i < shown.length - 1 ? gap : 0)))
    const rect = `<rect x="${x.toFixed(1)}" y="0" width="${drawn.toFixed(1)}" height="${h}" rx="${Math.min(r, drawn / 2).toFixed(1)}" fill="${s.paint.hex}"/>`
    x += width
    return rect
  })
  const track = `<rect x="0" y="0" width="${w}" height="${h}" rx="${r}" fill="${TRACK.hex}"/>`
  const mark =
    tick !== undefined && tick > 0 && tick < 1
      ? `<rect x="${(tick * w - 0.75).toFixed(1)}" y="0" width="1.5" height="${h}" fill="${TICK_HEX}"/>`
      : ''
  return svgDoc(w, h, track + pills.join('') + mark)
}

/** Splits `width` cells among the segments by value; any value shows as at least one cell. */
const allot = (segments: readonly Segment[], total: number, width: number) => {
  const cells = segments.map(s => ({ ...s, n: total > 0 && s.value > 0 ? Math.max(1, Math.round((s.value / total) * width)) : 0 }))
  const over = cells.reduce((a, c) => a + c.n, 0) - width
  if (over > 0) {
    const biggest = cells.reduce((a, c) => (c.n > a.n ? c : a), cells[0]!)
    biggest.n = Math.max(1, biggest.n - over)
  }
  return cells
}

const bar = (
  ctx: Ctx,
  key: string,
  segments: readonly Segment[],
  total: number,
  cells: number,
  opts: { height?: number; tick?: number; alt: string },
) => {
  const { Box, Text } = ctx.T
  const S = ctx.Svg
  if (S) {
    const w = cells * PX
    const tall = opts.height ?? 6
    return (
      <Box key={key} width={cells} height={1} flexShrink={0} alignItems="center">
        <S key={`${key}-svg`} source={capsuleSvg(segments, total, w, tall, opts.tick)} alt={opts.alt} width={w} height={tall} />
      </Box>
    )
  }
  // The terminal: one glyph per cell in its segment's theme color, the tick as a taller mark.
  const glyphs: { ch: string; color: string }[] = []
  for (const c of allot(segments, total, cells)) for (let i = 0; i < c.n; i++) glyphs.push({ ch: '━', color: color(ctx, c.paint) })
  while (glyphs.length < cells) glyphs.push({ ch: '━', color: TRACK.key })
  glyphs.length = cells
  if (opts.tick !== undefined && opts.tick > 0 && opts.tick < 1) glyphs[Math.min(cells - 1, Math.round(opts.tick * cells))] = { ch: '╋', color: 'inactive' }
  const runs = glyphs.reduce<{ ch: string; color: string; n: number }[]>((acc, g) => {
    const last = acc.at(-1)
    if (last && last.ch === g.ch && last.color === g.color) last.n += 1
    else acc.push({ ...g, n: 1 })
    return acc
  }, [])
  return (
    <Box key={key} flexDirection="row" width={cells} flexShrink={0}>
      {runs.map((r, i) => (
        <Text key={`${key}-${i}`} color={r.color}>
          {r.ch.repeat(r.n)}
        </Text>
      ))}
    </Box>
  )
}

/* ---------- rows ---------- */

const keep = (items: readonly (RenderNode | null)[]) => items.filter((x): x is RenderNode => x !== null)

/** A swatch, a name at the left; an amount and a share right-aligned in fixed columns. */
const row = (ctx: Ctx, key: string, width: number, name: string, amount: RenderNode, opts: { paint?: Paint; share?: string; isDim?: boolean } = {}) => {
  const { Box, Text } = ctx.T
  return (
    <Box key={key} flexDirection="row" width={width}>
      <Box flexGrow={1} flexShrink={1}>
        <Text wrap="truncate">
          {opts.paint ? <Text color={color(ctx, opts.paint)}>■ </Text> : null}
          <Text dimColor={opts.isDim}>{name}</Text>
        </Text>
      </Box>
      <Box flexShrink={0} justifyContent="flex-end" paddingLeft={1}>
        <Text>{amount}</Text>
      </Box>
      {opts.share !== undefined ? (
        <Box width={6} flexShrink={0} justifyContent="flex-end">
          <Text bold>{opts.share}</Text>
        </Box>
      ) : null}
    </Box>
  )
}

/** A section: a bold heading with a faint aside at its right, then as many of its rows as `limit` leaves room for. */
const section = (
  ctx: Ctx,
  key: string,
  title: string,
  aside: string | undefined,
  width: number,
  limit: number,
  rows: readonly (RenderNode | null)[],
) => {
  const { Box, Text } = ctx.T
  return (
    <Box key={key} flexDirection="column" width={width} flexShrink={0}>
      <Box flexDirection="row" justifyContent="space-between" columnGap={2}>
        <Box flexShrink={0}>
          <Text bold>{title}</Text>
        </Box>
        {aside ? (
          <Text dimColor wrap="truncate">
            {aside}
          </Text>
        ) : null}
      </Box>
      {keep(rows).slice(0, Math.max(0, limit - 1))}
    </Box>
  )
}

const share = (n: number, total: number) => {
  if (total <= 0) return '—'
  const p = (n / total) * 100
  return p >= 99.95 ? '100%' : `${p.toFixed(1)}%`
}

const wholePct = (p: number | undefined) => (p === undefined ? '—' : `${Math.round(p)}%`)

/* ---------- the meters: always shown ---------- */

/**
 * One meter as the usage panel draws it: the name at the left, a detail and the
 * percentage at the right, a thin bar the full width beneath.
 */
type Meter = {
  key: string
  /** Longest first; the band takes the longest that fits. */
  labels: readonly string[]
  details: readonly string[]
  pct: number | undefined
  tick?: number
  alt: string
}

const fitsBeside = (label: string, detail: string, pct: string, width: number) =>
  label.length + (detail ? detail.length + 2 : 0) + pct.length + 2 <= width

/** Whether the meter's full name and detail sit side by side at `width`, as on the app's panel. */
const fitsInline = (m: Meter, width: number) => fitsBeside(m.labels[0] ?? '', m.details[0] ?? '', wholePct(m.pct), width)

/**
 * The longest label and detail that fit `width`. Beside each other: a readable
 * name first, then the detail; the last-resort label ("5h") only when nothing
 * else fits. With the detail on a line of its own: each the longest that fits.
 */
const fit = (m: Meter, width: number, isBelow: boolean) => {
  const pct = wholePct(m.pct)
  const names = m.labels.length > 1 ? m.labels.slice(0, -1) : m.labels
  const tiny = m.labels.length > 1 ? m.labels.slice(-1) : []
  if (isBelow) {
    const label = [...names, ...tiny].find(l => fitsBeside(l, '', pct, width)) ?? m.labels.at(-1) ?? ''
    return { label, detail: m.details.find(d => d.length <= width) ?? '', pct }
  }
  const tries = [names, tiny].flatMap(group => [
    ...group.flatMap(label => m.details.map(detail => ({ label, detail }))),
    ...group.map(label => ({ label, detail: '' })),
  ])
  const chosen = tries.find(t => fitsBeside(t.label, t.detail, pct, width)) ?? { label: m.labels.at(-1) ?? '', detail: '' }
  return { ...chosen, pct }
}

const meter = (ctx: Ctx, m: Meter, width: number, isBelow: boolean) => {
  const { Box, Text } = ctx.T
  const { label, detail, pct } = fit(m, width, isBelow)
  const p = m.pct ?? 0
  return (
    <Box key={m.key} flexDirection="column" width={width} flexShrink={0}>
      <Box flexDirection="row" justifyContent="space-between" columnGap={1}>
        <Text wrap="truncate">{label}</Text>
        <Text>
          <Text dimColor>{detail && !isBelow ? `${detail}  ` : ''}</Text>
          <Text bold>
            {pct}
          </Text>
        </Text>
      </Box>
      {bar(ctx, `${m.key}-bar`, [{ key: 'used', value: p, paint: P.ember }], 100, width, {
        height: 5,
        tick: m.tick,
        alt: m.alt,
      })}
      {isBelow && detail ? (
        <Text dimColor wrap="truncate">
          {detail}
        </Text>
      ) : null}
    </Box>
  )
}

const meters = (ctx: Ctx): Meter[] => {
  const m = ctx.measure
  const c = compaction(ctx.measure, ctx.breakdown)
  const out: Meter[] = [
    c
      ? {
          key: 'context',
          labels: ['Context window', 'Context'],
          details: c.at ? [`${tok(ctx, c.left)} until auto-compact`, `${tok(ctx, c.left)} left`, tok(ctx, c.left)] : [`${tok(ctx, c.left)} left`, tok(ctx, c.left)],
          pct: c.pct,
          tick: c.tick,
          alt: `Context ${wholePct(c.pct)} of ${tok(ctx, c.window)}, ${tok(ctx, c.left)} tokens ${c.at ? 'until compaction' : 'left'}`,
        }
      : {
          // Before the breakdown arrives: the status line's figures.
          key: 'context',
          labels: ['Context window', 'Context'],
          details: m?.contextTokens === undefined ? [] : [tok(ctx, m.contextTokens)],
          pct: m?.contextPercent,
          alt: `Context ${m?.contextPercent ?? 0}% full`,
        },
  ]
  for (const l of m?.rateLimits ?? []) {
    const labels = LIMIT_NAMES[l.kind] ?? [`${rateLabel(l.kind)} limit`, rateLabel(l.kind)]
    out.push({
      key: `rl-${l.kind}`,
      labels,
      details: fmtReset(l.kind, l.resetsAt, ctx.now),
      pct: l.percentUsed,
      alt: `${labels[0]} ${wholePct(l.percentUsed)} used`,
    })
  }
  return out
}

const SESSION_W = 24

/** Cost and time over tokens and cache, at the left of the meters; shorter forms where narrow. */
const sessionBlock = (ctx: Ctx, width: number) => {
  const { Box, Text } = ctx.T
  const t = ctx.usage.totals
  const started = sessionStart(ctx)
  const cost = fmtUsd(ctx.measure?.costUsd)
  const time = started ? fmtMs(Math.max(0, ctx.now - started)) : ''
  const tokens = tok(ctx, sumTokens(t))
  const cached = t.requests ? ` · ${fmtPct(cacheHitRate(t) * 100)} cached` : ''
  const tail = [` tokens${cached}`, ' tokens', ' tok', ''].find(x => tokens.length + x.length <= width) ?? ''
  return (
    <Box key="session" flexDirection="column" width={width} flexShrink={0}>
      <Text wrap="truncate">
        <Text bold color={color(ctx, P.ember)}>
          {cost}
        </Text>
        <Text dimColor>{time && cost.length + 2 + time.length <= width ? `  ${time}` : ''}</Text>
      </Text>
      <Text wrap="truncate">
        <Text bold>{tokens}</Text>
        <Text dimColor>{tail}</Text>
      </Text>
    </Box>
  )
}

const menuOptions = (ctx: Ctx) => [
  { key: 'copy', label: 'Copy JSON', hotkey: 'c', onPress: ctx.onCopy },
  { key: 'details', label: ctx.isExpanded ? 'Hide details' : 'Show details', hotkey: 'd', onPress: ctx.onExpand },
  ...(ctx.isTerminal
    ? [{ key: 'status', label: ctx.isStatusShown ? 'Hide status line' : 'Show status line', hotkey: 's', onPress: ctx.onStatus }]
    : []),
  { key: 'hide', label: 'Hide band', hotkey: 'h', onPress: ctx.onHide },
]

/** "opus-5-5" as "Opus 5.5". */
const modelName = (id: string) =>
  shortModel(id).replace(/^([a-z]+)-(\d+)-(\d+)$/, (_, name: string, major: string, minor: string) => `${name[0]!.toUpperCase()}${name.slice(1)} ${major}.${minor}`)

/** The title line: the band's name and model at the left, ⋯ and its open options at the right. */
const titleRow = (ctx: Ctx) => {
  const { Box, Text, Button } = ctx.T
  return (
    <Box key="title" flexDirection="row" justifyContent="space-between" alignItems="center" columnGap={2} marginBottom={1}>
      <Text wrap="truncate">
        <Text bold>Session usage</Text>
        <Text dimColor>{ctx.model ? `  ${modelName(ctx.model)}` : ''}</Text>
      </Text>
      <Box flexDirection="row" flexShrink={0} columnGap={1}>
        {ctx.isMenuOpen
          ? menuOptions(ctx).map(o => <Button key={o.key} label={o.label} hotkey={o.hotkey} onPress={() => o.onPress()} />)
          : null}
        {/* "⋯" is drawn one column wide by some terminals and laid out as two, which leaves a gap: plain dots there. */}
        <Button key="menu" label={ctx.Svg ? '⋯' : '...'} hotkey="m" variant={ctx.isMenuOpen ? 'primary' : undefined} onPress={() => ctx.onMenu()} />
      </Box>
    </Box>
  )
}

/**
 * The session, then the meters sharing the rest of the width. Where a meter's
 * full name and detail ("Session limit", "Resets in 2 hr 37 min") will not sit
 * side by side, every meter takes its detail onto a line under its bar, given
 * the row to spare: the rows the head takes are returned with it.
 */
const headRow = (ctx: Ctx, canGrow: boolean) => {
  const { Box } = ctx.T
  const all = meters(ctx)
  const width = Math.max(10, Math.min(40, Math.floor((ctx.cols - SLACK - SESSION_W - GAP * all.length) / all.length)))
  const isBelow = canGrow && all.some(m => m.details.length > 0 && !fitsInline(m, width))
  return {
    rows: isBelow ? 3 : 2,
    node: (
      <Box key="head" flexDirection="row" columnGap={GAP}>
        {sessionBlock(ctx, SESSION_W)}
        {all.map(m => meter(ctx, m, width, isBelow))}
      </Box>
    ),
  }
}

/* ---------- the detail: shown with Show details ---------- */

/**
 * What fills the window: the largest categories named, the rest as Other, the
 * compaction reserve and what is free. Where rows are short the smaller
 * categories fold into Other first, then the reserve goes, then more fold.
 */
const windowSection = (ctx: Ctx, width: number, limit: number) => {
  const b = ctx.breakdown
  const c = compaction(ctx.measure, ctx.breakdown)
  if (!b || !c) return section(ctx, 'window', 'Context window', undefined, width, limit, [row(ctx, 'w-wait', width, 'Counted after the next reply', '', { isDim: true })])
  const used = b.categories.filter(x => x.kind === 'used' && x.tokens > 0).sort((x, y) => y.tokens - x.tokens)
  const reserve = b.categories.filter(x => x.kind === 'buffer').reduce((a, x) => a + x.tokens, 0)
  const free = b.categories.filter(x => x.kind === 'free').reduce((a, x) => a + x.tokens, 0)
  const room = limit - 2
  let shown = Math.min(4, used.length)
  let hasReserve = reserve > 0
  const need = () => shown + (used.length > shown ? 1 : 0) + (hasReserve ? 1 : 0) + 1
  while (need() > room && shown > 2) shown -= 1
  if (need() > room) hasReserve = false
  while (need() > room && shown > 1) shown -= 1
  const named = used.slice(0, shown).map((x, i) => ({
    key: x.name,
    name: CATEGORY[x.name]?.name ?? x.name,
    value: x.tokens,
    paint: CATEGORY[x.name]?.paint ?? SPARE[i % SPARE.length]!,
  }))
  const rest = used.slice(shown).reduce((a, x) => a + x.tokens, 0)
  const parts = rest > 0 ? [...named, { key: 'other', name: 'Other', value: rest, paint: P.stone }] : named
  const full = `${tok(ctx, c.tokens)} / ${tok(ctx, c.window)} (${wholePct(c.pct)})`
  const aside = 'Context window'.length + 2 + full.length <= width ? full : `${tok(ctx, c.tokens)} / ${tok(ctx, c.window)}`
  return section(ctx, 'window', 'Context window', aside, width, limit, [
    bar(ctx, 'window-bar', parts, c.window, width, { height: 5, tick: c.tick, alt: 'What fills the context window' }),
    ...parts.map(p => row(ctx, `w-${p.key}`, width, p.name, tok(ctx, p.value), { paint: p.paint, share: share(p.value, c.window) })),
    hasReserve ? row(ctx, 'w-reserve', width, 'Compaction buffer', tok(ctx, reserve), { paint: BUFFER, share: share(reserve, c.window), isDim: true }) : null,
    row(ctx, 'w-free', width, 'Free space', tok(ctx, free), { paint: TRACK, share: share(free, c.window), isDim: true }),
  ])
}

const tokenSection = (ctx: Ctx, width: number, limit: number) => {
  const t: Tokens = ctx.usage.totals
  const all = sumTokens(t)
  return section(ctx, 'tokens', 'Tokens', `${fmtPct(cacheHitRate(t) * 100)} from cache`, width, limit, [
    bar(ctx, 'token-bar', KINDS.map(k => ({ key: k.key, value: t[k.key], paint: k.paint })), all, width, { height: 5, alt: 'Tokens by kind' }),
    ...KINDS.map(k => row(ctx, `k-${k.key}`, width, k.label, tok(ctx, t[k.key]), { paint: k.paint, share: share(t[k.key], all) })),
  ])
}

/** The session's counts, then the running turn or else the last one. */
const activitySection = (ctx: Ctx, width: number, limit: number) => {
  const { Text } = ctx.T
  const u = ctx.usage
  const tools = Object.entries(u.byTool).sort((a, b) => b[1].calls - a[1].calls)
  const calls = tools.reduce((a, [, s]) => a + s.calls, 0)
  const errors = tools.reduce((a, [, s]) => a + s.errors, 0)
  const agents = Object.keys(u.byAgent).filter(a => a !== 'main').length
  const open = u.turns.at(-1)?.durationMs === undefined ? u.turns.at(-1) : undefined
  const turn = open ?? u.turns.filter(t => t.durationMs !== undefined).at(-1)
  const running = ctx.running.at(-1)
  const which = open ? 'This turn' : 'Last turn'
  return section(ctx, 'activity', 'Activity', plural(u.turns.length, 'turn'), width, limit, [
    row(ctx, 'a-req', width, 'Requests', `${u.totals.requests}`),
    row(
      ctx,
      'a-tools',
      width,
      'Tool calls',
      <Text>
        {`${calls}`}
        {errors ? <Text color={color(ctx, P.red)}>{` · ${errors} failed`}</Text> : null}
      </Text>,
    ),
    calls ? row(ctx, 'a-top', width, 'Most used', tools.slice(0, 3).map(([n]) => n.replace(/^mcp__/, '')).join(', '), { isDim: false }) : null,
    agents ? row(ctx, 'a-agents', width, 'Subagents', `${agents}`) : null,
    turn
      ? row(ctx, 'a-turn', width, which, `${fmtMs(open ? ctx.now - open.startedAt : (turn.durationMs ?? 0))} · ${plural(turn.requests, 'request')}`)
      : null,
    turn
      ? row(
          ctx,
          'a-turn-cost',
          width,
          'Turn tokens',
          <Text>
            {tok(ctx, sumTokens(turn.tokens))}
            {turn.costUsd !== undefined ? <Text color={color(ctx, P.ember)}>{` · ${fmtUsd(turn.costUsd)}`}</Text> : null}
          </Text>,
        )
      : null,
    running ? row(ctx, 'a-run', width, 'Running', <Text color={color(ctx, P.slate)}>{`${running.tool} ${fmtMs(ctx.now - running.since)}`}</Text>) : null,
  ])
}

const historyNote = (ctx: Ctx) => {
  const { Text } = ctx.T
  const bf = ctx.backfill
  return bf && bf.status !== 'done' && bf.note ? (
    <Text key="note" dimColor wrap="truncate">
      {bf.note}
    </Text>
  ) : null
}

/* ---------- the band ---------- */

/** One line for when the band has almost no room. */
const summaryLine = (ctx: Ctx) => {
  const { Text } = ctx.T
  const m = ctx.measure
  const comp = compaction(ctx.measure, ctx.breakdown)
  return (
    <Text wrap="truncate">
      <Text bold color={color(ctx, P.ember)}>
        {fmtUsd(m?.costUsd)}
      </Text>
      {`   ${tok(ctx, sumTokens(ctx.usage.totals))} tok`}
      {comp ? `   context ${wholePct(comp.pct)} of ${tok(ctx, comp.window)}` : m?.contextPercent !== undefined ? `   context ${fmtPct(m.contextPercent)}` : ''}
      {(m?.rateLimits ?? []).map(l => `   ${rateLabel(l.kind)} ${wholePct(l.percentUsed)}`).join('')}
    </Text>
  )
}

const COL_GAP = 4

export const band = (ctx: Ctx): RenderElement => {
  const { Box } = ctx.T
  if (ctx.maxRows < 4) return <Box flexDirection="column">{summaryLine(ctx)}</Box>

  // The title and its blank line, then the meters; the details get the rows left.
  let head = headRow(ctx, ctx.maxRows >= 5)
  // Asked for, the details always show: the meters give up their row beneath first,
  // then the band runs taller than its rows and the engine scrolls it.
  if (ctx.isExpanded && ctx.maxRows - 2 - head.rows < 5) head = headRow(ctx, false)
  const kept: RenderNode[] = [titleRow(ctx), head.node]
  let left = ctx.maxRows - 2 - head.rows
  if (ctx.isExpanded) {
    left = Math.max(left, 5)
    const inner = ctx.cols - SLACK
    // Three sections side by side where they have room for their rows, else two with Activity beneath.
    const isWide = Math.floor((inner - COL_GAP * 2) / 3) >= 26
    const n = isWide ? 3 : 2
    const colW = Math.max(24, Math.min(48, Math.floor((inner - COL_GAP * (n - 1)) / n)))
    const limit = Math.min(9, left - 1)
    const sections = [windowSection(ctx, colW, limit), tokenSection(ctx, colW, limit)]
    if (isWide) sections.push(activitySection(ctx, colW, limit))
    kept.push(
      <Box key="sections" flexDirection="row" columnGap={COL_GAP} marginTop={1}>
        {sections}
      </Box>,
    )
    left -= 1 + limit
    if (!isWide && left >= 3) {
      const below = Math.min(8, left - 1)
      kept.push(
        <Box key="activity" marginTop={1}>
          {activitySection(ctx, Math.min(inner, colW * 2 + COL_GAP), below)}
        </Box>,
      )
      left -= 1 + below
    }
    const note = historyNote(ctx)
    if (note && left >= 1) kept.push(note)
  }
  return <Box flexDirection="column">{kept}</Box>
}

/**
 * The status line's parts, the cost first: what the band shows, on one line,
 * for a terminal that keeps the line and hides the band. A part's note goes in parentheses after it.
 * `level` condenses it for a narrow terminal: 0 is everything in full; 1 shortens the notes;
 * 2 shortens the names as well; 3 drops the notes; 4 drops the tokens too.
 */
const statusParts = (u: UsageModel, m: Measure | null, b: Breakdown | null, now: number, level = 0) => {
  const parts: { text: string; note?: string }[] = [
    // Whole cents: a bill is never a fraction of one.
    { text: m?.costUsd === undefined ? '—' : `$${m.costUsd.toFixed(2)}` },
  ]
  if (level < 4) parts.push({ text: `${fmtTokens(sumTokens(u.totals), true)} tokens` })
  const named = (full: string, short: string, pct: string) => `${level < 2 ? full : short}: ${pct}`
  const noted = (full: string | undefined, short: string | undefined) => (level >= 3 ? undefined : level === 0 ? full : short ?? full)
  // Against the same window as the band's Context window meter, once the breakdown has counted it.
  const c = compaction(m, b)
  if (c) {
    const left = `${fmtTokens(c.left, true)} left`
    parts.push({ text: named('Context window', 'Context', wholePct(c.pct)), note: noted(c.at ? `${fmtTokens(c.left, true)} until auto-compact` : left, left) })
  } else if (m?.contextPercent !== undefined) parts.push({ text: named('Context window', 'Context', fmtPct(m.contextPercent)) })
  for (const l of m?.rateLimits ?? []) {
    const [reset, span] = fmtReset(l.kind, l.resetsAt, now)
    const lower = reset && `${reset[0]!.toLowerCase()}${reset.slice(1)}`
    // Named in full; the band's "Weekly · all models" would read as two parts between the line's dots.
    parts.push({ text: named(`${rateLabel(l.kind)} limit`, rateLabel(l.kind), wholePct(l.percentUsed)), note: noted(lower, span ?? lower) })
  }
  return parts
}

const joinParts = (parts: { text: string; note?: string }[]) => parts.map(p => (p.note ? `${p.text} (${p.note})` : p.text)).join(' · ')

/** The fullest wording that fits `width` cells; the most condensed, cut at the edge, where none does. */
const fitParts = (u: UsageModel, m: Measure | null, b: Breakdown | null, now: number, width = Infinity) => {
  let parts = statusParts(u, m, b, now)
  for (let level = 1; level <= 4 && joinParts(parts).length > width; level++) parts = statusParts(u, m, b, now, level)
  return parts
}

/** The one-line summary the status line shows, condensed to fit `width` cells when given. */
export const statusText = (u: UsageModel, m: Measure | null, b: Breakdown | null, now: number, width?: number) =>
  joinParts(fitParts(u, m, b, now, width))

/** The same summary drawn for the terminal: the cost in the band's orange, the dots and notes gray, the rest in the text color. */
export const statusLine = (T: Base, u: UsageModel, m: Measure | null, b: Breakdown | null, now: number, width?: number) => {
  const { Text } = T
  const [cost, ...rest] = fitParts(u, m, b, now, width)
  return (
    <Text wrap="truncate">
      <Text color={P.ember.hex}>{cost!.text}</Text>
      {rest.map((p, i) => [
        <Text key={`dot${i}`} dimColor>{' · '}</Text>,
        p.text,
        p.note ? <Text key={`note${i}`} dimColor>{` (${p.note})`}</Text> : null,
      ])}
    </Text>
  )
}
