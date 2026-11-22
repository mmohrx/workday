# workday

A Claude Code mod: a Today pane (`/today`) and an end-of-day report (`/wrapup`). The whole mod is `hooks/register.tsx`; its state types are in `types/index.d.ts`.

## Rules

- **No tool names in the code.** The prompts say *what* to gather (calendar, tracker, monitoring, inbox, git), never Linear, Jira, Outlook and so on. Claude picks whatever is connected. Tool names may appear in examples inside descriptions, nowhere else.
- **Read only.** `/today` and `/wrapup` must never ask Claude to change anything in the user's tools.
- **No requests nobody asked for.** Nothing calls `$.prompt.submit` on its own (session start, timers). Only `/today`, `/wrapup` and the Refresh button do.
- **English** for code, comments, UI text and README. Reports follow the user's language; the prompts say so.
- **Colors come from the palette** (`PALETTES`, `C` in `register`). Use theme keys in the `theme` palette so light and dark themes both work. No color literals in the render code.
- **Links are `https` only.** `toItems` drops anything else; keep it that way.
- **Changing `Snapshot` or another stored shape:** bump the atom's `shape` tag (`snapshot-3` → `snapshot-4`), or the pane reads old data in the new shape after a reload.
- **New setting:** add it to `userConfig` in `.claude-plugin/plugin.json`, to `/today config`, and to the Settings table in the README.
- **New command or argument:** add it to `HELP` and the Commands table in the README.
- User-facing text (README, `/config` descriptions, command replies, pane text) goes through the humanizer skill before a release.

## Checks

Run all three before committing; all must pass.

```
claude plugin validate .
claude plugin test .
tsc -p .
```

`tsc -p .` needs `.claude-plugin/types/`, which Claude Code writes when it loads the mod from a folder it watches. To load this folder directly: `claude --plugin-dir .`

Tests live in `tests/`. Every stored value and every command gets a test; mock `store.get`/`store.set` at the top of a test, before the first call on `$`.

## Releases

Bump `version` in `.claude-plugin/plugin.json`, commit, push. Users get it with `claude plugin update workday`.
