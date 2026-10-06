# Session usage

A Claude Code plugin that shows a live usage band above the prompt. It works in the Claude desktop app's Code tab and in the terminal.

## What it shows

The top of the band has three meters, each an orange bar with its percentage:

- **Context window**: how full this chat's context is.
- **5-hour limit** and **7-day limit**: how much of your plan's usage limits you've used, with the time left until each one resets.

Choose **Show details** to see more:

- **Context window**: what's taking up the context (system prompt, tools, memory files, messages), plus the compaction buffer and free space.
- **Tokens**: input, output, cache writes and cache reads for the whole chat, and how much was served from cache.
- **Activity**: turns, tool calls, the most-used tools, and tokens for the current or last turn.

The band appears in every chat as soon as it opens. It reads the chat's history, so a chat you come back to shows its full totals before you send anything.

### Where the limits come from

When you're signed in with a Claude account, the band asks Anthropic's usage service for your current limits. It does this every 15 seconds, and again about 5 seconds after each reply. Open chats share one answer, so having several open doesn't multiply the requests. The numbers match what the desktop app shows.

If the usage service doesn't answer, the band falls back to the limits reported with Claude's replies. A new chat shows the last reading it saw until fresh numbers arrive.

## Using it

- **⋯** (or `m`) opens the band's menu:
  - **Show details** / **Hide details** (`d`)
  - **Copy JSON** (`c`) copies everything the band knows about this chat.
  - **Hide band** (`h`)
- `/session-usage` shows or hides the band.

### Settings

| Setting | Default | What it does |
| --- | --- | --- |
| Usage in the status line | Off | Also shows cost, tokens, context and limits in the status line. |

## Installing

Add the plugin to a plugin marketplace with this repository as its source:

```json
{
  "name": "session-usage",
  "source": { "source": "url", "url": "https://github.com/jasmo13/session-usage.git" },
  "description": "A live usage band above the prompt."
}
```

Then install it:

```bash
claude plugin install session-usage@<marketplace>
```

To try it from a local copy in the terminal without installing:

```bash
claude --plugin-dir path/to/session-usage
```

The plugin uses Claude Code's function-hook plugin API, and it was built and tested on Claude Code 2.1.288.

### Updating

Releases come from `main`. After a new version is merged, update with:

```bash
claude plugin marketplace update <marketplace>
```

```bash
claude plugin update session-usage@<marketplace>
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

To release, bump `version` in `.claude-plugin/plugin.json` in the same pull request.
