# Renders the README screenshots with sample data: vhs docs/demo.tape
# Run from the repo root. Pick TZ so it is a weekday morning there.
# Uses /today demo, so no real data shows up.
Output docs/demo.gif
# docs/today.png is today-full.png cropped to the pane:
#   ffmpeg -i docs/today-full.png -vf crop=598:570:783:18 docs/today.png
Set Shell zsh
Set FontSize 16
Set Width 1400
Set Height 800
Set Padding 20
Set Theme "Catppuccin Mocha"

Hide
# A clean environment and these flags keep other plugins, MCP servers and the status line out of the shot.
# Add your own installed plugins to enabledPlugins with false.
Type `unset CLAUDE_CODE_PLUGIN_DIRS; TZ=Pacific/Kiritimati LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8 claude --plugin-dir . --strict-mcp-config --permission-mode default --settings '{"enabledPlugins":{"mattpocock-skills@mattpocock":false,"warp@claude-code-warp":false}}'` Enter
Sleep 4s
# Trust dialog, if this folder is new to Claude Code: pick "Yes".
Down Enter
Sleep 6s
Show

Type "/today demo" Sleep 500ms Enter
Sleep 2s
Screenshot docs/today-full.png
Sleep 1s

Type "/today config" Sleep 500ms Enter
Sleep 2s
Screenshot docs/config-full.png
Escape
Sleep 1s
Hide
Type "/today demo off" Sleep 500ms Enter
Sleep 1s
