# workday

A Today pane for Claude Code, plus a `/wrapup` command for the end of the day.

`/today` asks Claude to look through your calendar, tracker, monitoring and inbox and puts the result in a pane next to the chat: today's events, the tasks on your plate, and anything that needs you now. `/wrapup` writes a short end-of-day report from the same sources and your git log.

It doesn't care which tools you use. The mod only says what to look for, and Claude uses whatever is connected in your session: Linear or Jira, Outlook or Google Calendar, Sentry, GitHub. If a source isn't connected, it's skipped. Neither command changes anything; they only read.

## Commands

| Command | What it does |
|---|---|
| `/today` | Gather fresh data and show the pane |
| `/today on` / `off` | Open the pane at the start of every session, or keep it closed |
| `/today show` / `hide` | Show or hide the pane for now |
| `/today hide focus` | Hide one card (`workday`, `timeline`, `focus`, `heads-up`). It stays hidden in later sessions until you `show` it |
| `/today demo` | Fill the pane with sample data so you can see every state. Good for screenshots |
| `/today demo off` | Back to your own data |
| `/today config` | Print the current settings |
| `/wrapup [note]` | End-of-day report: done, still open, first thing tomorrow, rough time blocks for time tracking |

With `/today on`, a new session shows the last data you gathered that day. It doesn't fetch on its own, since that would cost a request every time you start Claude. Press Refresh when you want new data.

Claude Code only opens a pane by itself in terminals at least 144 columns wide. In a narrower window, use `/today show`.

## Settings

Set these in `/config`.

| Setting | Default | |
|---|---|---|
| Workday start / end | 09:00 / 18:00 | Range of the progress bar |
| Focus: tasks shown | 3 | Tasks listed before "+ N more" |
| Tasks fetched | 7 | Most tasks `/today` will gather |
| Heads-up: items shown | 5 | Items listed before "+ N more" |
| Timeline: events shown | 8 | Starts with the last event before now |
| Preferred sources | empty | For example "Jira, Teams". Empty means whatever is connected |
| Palette | theme | `theme` follows your Claude Code theme, light or dark. `pastel` and `mono` are fixed |
| Color: Workday / Timeline / Focus / Heads-up | empty | A hex value like `#ff8800` or a theme name like `success`. Overrides the palette for that card |

Reports come out in whatever language you use with Claude.

## Install

In a Claude Code terminal session:

```
/plugin install workday --marketplace mmohrx/workday
```

From a shell:

```
claude plugin install workday --marketplace mmohrx/workday
```

In the desktop app: click + next to the prompt box, then Plugins, Add marketplace with `mmohrx/workday`, then Add plugin.

Answer `y` to add the marketplace, then pick a scope. User scope means every session.

The repository is private for now. To install, you need read access on GitHub and a git login for github.com on your machine: an SSH key, or `gh auth login` followed by `gh auth setup-git`.

## Credits

The card layout and the segmented bars borrow from [claude-flightdeck](https://github.com/scasella/claude-flightdeck) (MIT).

## License

MIT
