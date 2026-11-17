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

At the prompt of a Claude Code terminal session:

```
/plugin install subagent-statusline --marketplace bumfo/subagent-statusline-cc
```

Answer `y` to add the marketplace, then pick a scope. From a shell:

```
claude plugin install subagent-statusline --marketplace bumfo/subagent-statusline-cc
```

From a local clone instead:

```
claude plugin marketplace add /path/to/subagent-statusline-cc
claude plugin install subagent-statusline@subagent-statusline-cc
```

## Moving off `subagentStatusLine`

1. Copy your `subagentStatusLine.command` into the mod's `command` option.
   `pluginConfigs` is keyed by plugin id, `<plugin>@<marketplace>`:

   ```json
   "pluginConfigs": {
     "subagent-statusline@subagent-statusline-cc": {
       "options": { "command": "<your subagentStatusLine command>" }
     }
   }
   ```

2. Start a new session, run a subagent, and check its row.
3. Back up `~/.claude/settings.json`, then delete the `subagentStatusLine` key.
   Delete it last: until the mod has its own `command`, that key is where the
   mod reads the command from.

To load a working copy without installing it, set
`"CLAUDE_CODE_PLUGIN_DIRS": "/path/to/subagent-statusline-cc"` in the settings
`env`. A plugin loaded that way reads its options from
`pluginConfigs["subagent-statusline"]`, without the `@<marketplace>` part.

## Tests

```
claude plugin validate .
claude plugin test .
```
