# subagent-statusline

A Claude Code mod that brings back `subagentStatusLine`: a shell command whose
output replaces each subagent row under the prompt. Claude Code 2.1.326
deprecates that setting in favor of mods.

## Requirements

Claude Code 2.1.326 or later.

## Install

At the prompt of a Claude Code terminal session:

```
/plugin install subagent-statusline --marketplace bumfo/subagent-statusline-cc
```

Answer `y` to add the marketplace, then pick a scope. From a shell:

```
claude plugin install subagent-statusline --marketplace bumfo/subagent-statusline-cc
```

## Setup (required)

The mod does nothing until you set its `command` option. It never runs the
`subagentStatusLine` key from your settings.

1. Set `command` in `/config`, or in `~/.claude/settings.json`:

   ```json
   "pluginConfigs": {
     "subagent-statusline@subagent-statusline-cc": {
       "options": { "command": "<your command>" }
     }
   }
   ```

   The key is the plugin ID, `<plugin>@<marketplace>`. If you installed from
   another marketplace, use the ID listed under `enabledPlugins`, or set the
   option in `/config`, which uses the right key.

2. If you have a `subagentStatusLine` key in `~/.claude/settings.json`, back up
   the file and delete the key. While both are set, Claude Code and the mod both
   run the command.
3. Start a new session, run a subagent, and check its row.

## The command

The command runs with `/bin/sh -c` about once a second while subagent rows are
shown, and 300 ms after a row appears, disappears or changes width. It receives
JSON on stdin, the same input `subagentStatusLine` received:

```json
{
  "session_id": "…", "transcript_path": "…", "cwd": "…",
  "columns": 96,
  "tasks": [{
    "id": "…", "name": "…", "type": "local_agent", "agentType": "Explore",
    "status": "running", "description": "…", "label": "…", "startTime": 0,
    "model": "…", "effort": "high", "contextWindowSize": 200000,
    "tokenCount": 0, "tokenSamples": [0], "cwd": "…"
  }]
}
```

`columns` is the width available for a row's text. `tokenSamples` holds the
token counts from the last 16 runs. Fields that aren't available are left out.

It prints one JSON line per row it wants to change:

```json
{"id": "…", "content": "text for this row"}
```

- `content` replaces the row's text. Colors (ANSI escapes) are kept.
- An empty `content` hides the row.
- A row the command leaves out shows Claude Code's normal text.
- If the command fails, exits non-zero or runs longer than 5 seconds, every row
  shows Claude Code's normal text until the next successful run.

## Notes

- Only subagent rows are changed, not teammate rows.
- An administrator's managed settings take precedence: a managed
  `subagentStatusLine` stays with Claude Code, and managed `disableAllHooks` or
  `allowManagedHooksOnly` stops the mod's command.
- The command has the mod's `CLAUDE_PLUGIN_ROOT` and `CLAUDE_PLUGIN_DATA` set.
- To try a working copy without installing it, set
  `"CLAUDE_CODE_PLUGIN_DIRS": "/path/to/subagent-statusline-cc"` in the
  settings `env`. Its options are then read from
  `pluginConfigs["subagent-statusline"]`.

## Development

```
claude plugin test .   # integration tests, Claude Code's test kit
bun run test           # unit tests (Bun 1.3 or later)
```
