# Usage mod

A Claude Code plugin that shows a live usage band above the prompt. It works in the Claude desktop app's Code tab and in the terminal.

## What it shows

The top of the band has three meters, each an orange bar with its percentage. They're named and worded as in the app's usage panel:

| Meter | Shows | Example |
| --- | --- | --- |
| **Context window** | How full this chat's context is, and how much room is left before it's compacted | 75k until auto-compact · 64% |
| **Session limit** | How much of your plan's 5-hour limit you've used, and the time left until it resets | Resets in 2 hr 37 min · 13% |
| **Weekly · all models** | How much of your weekly limit you've used, and the day and time it resets, in your local time | Resets Wed 4:00 AM · 12% |

The model next to the band's name, and the Context window's size and auto-compact point, follow a switch with `/model` or the model picker straight away, before the new model's first reply. After any slash command (`/autocompact`, `/config`, `/fast`, `/compact`, `/clear` and the rest) the band reads the model, cost, context, window and limits again as soon as the command finishes, and a change in a settings file shows straight away too. Cost, context, the model and the window are also read every second, so a change made any other way shows within a second.

Reset times are rounded to the nearest minute, and the time left for the session limit counts a partial minute as a whole one, as the app does. The meters, and the details under them, share the band's full width, out to its right edge. When the band is too narrow for the full wording beside a meter's name, the wording moves to a line under the bar, and on very narrow bands it shortens ("2 hr 37 min", "Weekly").

Choose **Show details** to see more:

- **Context window**: what's taking up the context. The largest categories (messages, tools, MCP tools, skills, system prompt and so on) get their own rows, the rest are added together as Other, and the compaction buffer and free space follow. Each category has its own color on the desktop and in the terminal.
- **Tokens**: input, output, cache writes and cache reads for the whole chat, and how much was served from cache.
- **Activity**: turns, tool calls, the most-used tools, and tokens for the current or last turn.

The details are hidden until you choose Show details. When the band is short, as in a small fullscreen terminal, the sections list fewer rows, and the band scrolls if it still doesn't fit.

The band appears in every chat as soon as it opens. It reads the chat's history, so a chat you come back to shows its full totals before you send anything. If a chat that has already cost something has no history to read, the details end with a note saying the counts start from when the plugin loaded. A new chat has nothing earlier to count, so it shows no note.

### Matching the app's panel

The band's figures are meant to match the app's usage panel exactly:

- **Context breakdown:** counted the way the panel counts it, not estimated. Counting exactly asks Anthropic's token-count service, so the band recounts when the chat opens, after each turn or compaction, and when you open the details; otherwise at most every 30 seconds, and only while the details are open.
- **Percentages:** rounded to the nearest whole number.
- **Token counts:** one decimal place at most, and none when it's a zero: "134.5k", "15.8k", "33k", "62.4M". 
- **Costs:** always to the cent: "$0.26", "$123.40".

### Where the limits come from

When you're signed in with a Claude account, the band asks Anthropic's usage service for your current limits, the same figures the app shows. It does this every 15 seconds, and again about 5 seconds after each reply. Open chats share one answer, so having several open doesn't multiply the requests.

The limits also arrive with each of Claude's replies, and the band shows whichever reading is newest. If the usage service's last answer is more than a minute old and a reply has brought a newer reading since, the band shows the reply's. While the service isn't answering, the band asks less often: after 30 seconds, then a minute, and so on up to every 5 minutes.

A new chat shows the last reading it saw until fresh numbers arrive. Without a Claude account login (for example, signed in with an API key or another token), there's no usage service to ask, and the limit meters show only what replies report, which may be nothing.

## Using it

- **⋯** (or `m`) opens the band's menu. In the terminal the button reads **...**:
  - **Show details** / **Hide details** (`d`)
  - **Copy JSON** (`c`) copies everything the band knows about this chat. It checks everything again first, then copies once all of it is current: the model, cost and context, your limits straight from Anthropic's usage service, an exact count of the context, and the chat's history if that's still loading. So it can take a moment. It opens with `band`: what the band shows, under the band's own names (`contextWindow`, `sessionLimit`, `weeklyLimit`, `compactionBuffer`, `freeSpace` and so on), as whole numbers rather than "60.8k". Its percentages are the band's, including the Context window's. The raw figures follow, with the limits under the same names, and the turns include the prompt that started each one.
  - **Show status line** / **Hide status line** (`s`), in the terminal only: a line of its own under the hint line below the prompt with what the band shows, so it can stand in for the band when the band is hidden. For example: `$0.26 · 61.1k tokens · Context window: 20% (205.9k until auto-compact) · Session limit: 16% (resets in 1 hr 56 min) · Weekly limit: 12% (resets Wed 4:00 AM)`. The cost is in orange, the dots and the notes in parentheses in gray. In a narrower terminal it condenses to fit, a step at a time: shorter notes (`205.9k left`, `1 hr 56 min`, `Wed 4:00 AM`), then shorter names (`Context`, `Session`, `Weekly`), then no notes, then no token count. It's off until you choose it. The desktop app doesn't draw that line, so its menu leaves this out.
  - **Hide band** (`h`)
- `/usage-mod` shows or hides the band.

Every choice here is kept for every chat, new or old, until you change it again. Chats already open, whether desktop chats or other terminals, follow the change within a second. A fresh install shows the band with its details hidden and, in the terminal, no status line.

## Installing

This repository is its own plugin marketplace, so two commands install it, whether or not you've added a marketplace before. In a terminal:

```bash
claude plugin marketplace add jasmo13/usage-mod
```

```bash
claude plugin install usage-mod@usage-mod
```

Then open a new chat, or restart the desktop app; the band shows above the prompt. You need to be able to read this repository on GitHub: while it's private, that means being signed in to GitHub as someone with access, the same as for `git clone`.

To try it from a local copy in the terminal without installing:

```bash
claude --plugin-dir path/to/usage-mod
```

The plugin uses Claude Code's function-hook plugin API, and it was built and tested on Claude Code 2.1.288.

### Updating

Releases come from `main`. After a new version is merged, update with:

```bash
claude plugin marketplace update usage-mod
```

```bash
claude plugin update usage-mod@usage-mod
```

Then reopen your chats or restart the app.

## Developing

| Path | Contents |
| --- | --- |
| `hooks/register.tsx` | Hooks: collecting usage, reading history, checking limits, drawing the band |
| `hooks/collect.ts` | Pure functions that turn events and transcripts into usage totals |
| `hooks/views.tsx` | The band's layout for the desktop app and the terminal |
| `types/index.d.ts` | Types for the values the plugin keeps between reloads |
| `tests/usage.test.ts` | Tests |

Before opening a pull request, run:

```bash
claude plugin test .
```

```bash
npx -p typescript tsc -p .
```

```bash
claude plugin validate .
```

In the same pull request:

- Update this README whenever a change adds a feature or changes what the band shows or how it behaves.
- To release, bump `version` in `.claude-plugin/plugin.json`.

## License

[MIT](LICENSE)
