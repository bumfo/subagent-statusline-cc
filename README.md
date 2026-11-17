# subagent-statusline

A Claude Code mod that brings back `subagentStatusLine`, the setting that
replaced each subagent row under the prompt with the output of a shell command.
Claude Code 2.1.326 marks that setting deprecated in favor of mods.

The mod hooks `ui.render` on `AgentRow`. On a timer it runs the command once for
all agent rows, passing the same JSON on stdin that Claude Code passed. The
command prints one `{"id": ..., "content": ...}` JSON line per row, and each
`content` becomes that row's body. Rows the command leaves out, and every row
after a non-zero exit, keep Claude Code's own columns.

## Where the command comes from

1. The mod's `command` option (`pluginConfigs` in `~/.claude/settings.json`,
   or `/config`).
2. Otherwise `subagentStatusLine.command` in `~/.claude/settings.json`. Only the
   user settings file is read; project settings are ignored.

While Claude Code still runs `subagentStatusLine` itself and the mod has no
`command` option, the mod leaves the rows to Claude Code and runs nothing.

## Options

| Option      | Default | Meaning                                                        |
| ----------- | ------- | -------------------------------------------------------------- |
| `command`   | `""`    | Shell command, run with `/bin/sh -c`. Empty: use the legacy key. |
| `refreshMs` | `5000`  | How often the command reruns while an agent is running.          |

The command also reruns within a second of a row appearing or disappearing, or
the terminal width changing.

## stdin

```json
{
  "session_id": "…", "transcript_path": "…", "cwd": "…",
  "columns": 96,
  "tasks": [{
    "id": "…", "name": "…", "type": "local_agent", "agentType": "Explore",
    "status": "running", "description": "…", "label": "…", "startTime": 0,
    "model": "…", "effort": "high", "contextWindowSize": 200000,
    "tokenCount": 0, "tokenSamples": [], "cwd": "…"
  }]
}
```

## Install

Load the folder in every session and give the mod the command, in
`~/.claude/settings.json`:

```json
{
  "env": { "CLAUDE_CODE_PLUGIN_DIRS": "/path/to/subagent-statusline-cc" },
  "pluginConfigs": {
    "subagent-statusline": { "options": { "command": "<your subagentStatusLine command>" } }
  }
}
```

Start a new session, check that the rows still look right, then delete the
`subagentStatusLine` key. Delete it last: until the mod has its own `command`,
that key is where the mod reads the command from.

The folder is also a marketplace (`claude plugin marketplace add <folder>`,
then `claude plugin install subagent-statusline@subagent-statusline-cc`). With
that install, set `command` from the install screen or `/config`, since the
`pluginConfigs` key for an installed plugin can differ from the one above.

## Tests

```
claude plugin validate .
claude plugin test .
```
