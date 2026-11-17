# subagent-statusline

A Claude Code mod that brings back `subagentStatusLine`, the setting that
replaced each subagent row under the prompt with the output of a shell command.
Claude Code 2.1.326 marks that setting deprecated in favor of mods.

The compatibility target is the native **2.1.322** command protocol and refresh
lifecycle. The implementation uses public Mods APIs, with no runtime packages
and no separate row renderer.

Source audit: native `n4e` (command input/execution), `oSe` (refresh lifecycle)
and `o4e` (token samples). The tests encode their contracts independently;
the reference source is not required to run them.

The mod hooks `ui.render` on `AgentRow`. On a timer it runs the command once for
all agent rows, passing the same JSON on stdin that Claude Code passed. The
command prints one `{"id": ..., "content": ...}` JSON line per row, and each
`content` becomes that row's body. An empty string hides the entire row; leaving
out a row restores its normal columns. Non-zero exits, spawn errors and timeouts
also restore the normal columns. ANSI sequences and whitespace are preserved.
Claude Code's existing `AgentRow` handles colors, truncation, selection, hover
and click navigation in every terminal mode.

## Where the command comes from

1. A managed-policy `subagentStatusLine` command, if configured. Policy
   `disableAllHooks` blocks execution; `allowManagedHooksOnly` prevents fallback
   to a user command.
2. The mod's `command` option (`pluginConfigs` in `~/.claude/settings.json`,
   or `/config`).
3. Otherwise a `{ "type": "command", "command": "…" }` value under
   `subagentStatusLine` in user settings. Project settings are never read for
   shell commands.

Without a `command` option, a row arriving with a body or hidden flag is left
alone. If every eligible row is owned that way, the command stops. Ownership
is reconsidered on each draw, not latched for the session: another mod hiding
one row cannot permanently turn off the others. An explicit mod command may
replace an inherited body or show an inherited hidden row.

Commands in the mod's own option receive its `CLAUDE_PLUGIN_ROOT` and
`CLAUDE_PLUGIN_DATA`. Legacy commands do not acquire this mod's identity;
commands referencing `${CLAUDE_PLUGIN_ROOT}` or `${CLAUDE_PLUGIN_DATA}` there
are refused. The host remains responsible for workspace trust and plugin
execution permissions.

## Options

| Option      | Default | Meaning                                                        |
| ----------- | ------- | -------------------------------------------------------------- |
| `command`   | `""`    | Shell command, run with `/bin/sh -c`. Empty: use the legacy key. |
| `refreshMs` | `5000`  | Periodic refresh while eligible rows exist, including completed rows. Minimum 1000 ms. |

The first run is debounced by 300 ms. A producer-count or body-width change
restarts that debounce and the periodic timer; a status change alone does not.
Commands have a 5-second timeout and never overlap. Results from an obsolete
refresh are discarded. Timers stop when no eligible rows or command remain,
and when the session ends. A custom `refreshMs` is a mod extension; use the
default for native timing.

The draw hook never writes UI state. Disabling or delegating a row immediately
returns the host's row and schedules any clearing through a zero-delay clock
callback. One root row supplies the shared body width; narrower nested rows
and remote-surface redraws do not repeatedly reset the command timers.

## stdin

```json
{
  "session_id": "…", "transcript_path": "…", "cwd": "…",
  "scratchpad_dir": "…", "prompt_id": "…", "agent_type": "…",
  "columns": 96,
  "tasks": [{
    "id": "…", "name": "…", "type": "local_agent", "agentType": "Explore",
    "status": "running", "description": "…", "label": "…", "startTime": 0,
    "model": "…", "effort": "high", "contextWindowSize": 200000,
    "tokenCount": 0, "tokenSamples": [0], "cwd": "…"
  }]
}
```

Optional fields are omitted when unavailable. `contextWindowSize` is included
only when the agent has a model. `tokenSamples` contains the latest 16 token
counts sampled at actual refreshes, not the host's read-time sampling history.
`columns` is the available row-body width, already excluding the host's prefix
and padding. A task without a cwd uses the session cwd. The command itself runs
in the host's config root when present, otherwise the session cwd.

## Requirements

Claude Code 2.1.326 or later. `plugin.json` declares this as
`"engines": { "claude-code": ">=2.1.326" }`. Builds 2.1.323 to 2.1.325 read
that field and don't load the mod. Builds before 2.1.323 ignore the field.

## Compatibility boundaries

This mod requires a host exposing `AgentRow` (`columns`, `body`, `isHidden`),
`agent.list`, `session.info`, `process.hookEnv` and the Mods clock APIs. It uses
the host's public agent projection and `hasRow` eligibility, rather than
reconstructing private task state. Only local subagent rows participate, not
main-session workers or teammate rows. Command-hidden rows remain eligible so
later output can restore them. The last row disappearing is noticed at the next
refresh or when an in-flight command settles if no further row is rendered.

Commands currently use `/bin/sh -c` on macOS/Linux. Native Windows shell
selection and private task/model fields are not reimplemented. Host command
output limits and plugin execution policies still apply.

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
   `pluginConfigs` is keyed by plugin ID, `<plugin>@<marketplace>`. Installed
   from this repository, the ID is `subagent-statusline@subagent-statusline-cc`:

   ```json
   "pluginConfigs": {
     "subagent-statusline@subagent-statusline-cc": {
       "options": { "command": "<your subagentStatusLine command>" }
     }
   }
   ```

   > **Installed from another marketplace?** Your plugin ID is
   > `subagent-statusline@<that marketplace>`: use the ID listed for the mod
   > under `enabledPlugins` in `~/.claude/settings.json`, or set `command` in
   > `/config`, which stores it under your ID. Under any other key the mod
   > finds no command, and once `subagentStatusLine` is deleted it stops
   > drawing your rows.

2. Start a new session, run a subagent, and check its row.
3. Back up `~/.claude/settings.json`, then delete the `subagentStatusLine` key.
   Delete it last: until the mod has its own `command`, that key is where the
   mod reads the command from.

To load a working copy without installing it, set
`"CLAUDE_CODE_PLUGIN_DIRS": "/path/to/subagent-statusline-cc"` in the settings
`env`. A plugin loaded that way reads its options from
`pluginConfigs["subagent-statusline"]`, without the `@<marketplace>` part.

## Tests

Binary-free unit tests need Bun 1.3 or newer (a development tool only):

```
bun run test
```

This script runs only `checks/register.unit.ts`. It never invokes Claude, a
shell command, or the network. No install step or generated SDK is needed.
The small mock host rejects state writes during drawing; it supplies commands,
settings, session metadata and fake timers. Each run has a temporary config
directory. Unit files deliberately do not use `.test.ts` names, so the host's
integration runner does not load Bun imports.

Separately, with Claude Code 2.1.326 or newer already installed, run the official
host integration suite yourself:

```
claude plugin test .
```

It is not part of `bun run test`. Files under `tests/` import only the public
`claude-code/testing` kit and local helpers. They never invoke a Claude binary
themselves. Engine-data hooks supply commands/settings while the actual kit
enforces render-time restrictions, state updates and timer callbacks. Cases
cover the reviewed disabling/native-takeover paths, repeated draws, multiple
widths, hidden-row composition, all four surfaces, command input/provenance,
policy precedence, sampling, retained completed rows, failures and cancellation.

Both suites test source-derived contracts and UI delegation, not terminal
pixels. Neither copies the renderer. ANSI integration coverage passes the body
to the kit's own `AgentRow`, not a custom `Text` node that forbids escape codes.

### Native-322 decisions retained after review

These less-obvious behaviors were checked in native source, not inferred from
the previous branch or from rendered output:

| Behavior | Native evidence / integration coverage |
| --- | --- |
| A pending command can delay a new agent's refresh until the next 5-second tick | `oSe` shares a busy ref across effect generations; its 300 ms callback skips while busy. The stale result is discarded. |
| Retained completed rows continue refreshing | `tSe` keeps eligible retained/unevicted terminal tasks; `oSe` stops on an empty producer list, not merely when nothing runs. |
| An empty legacy command is present | `eSe` returns `command` without trimming and `oSe` checks `!== undefined`. An unset command is different. |
| `disableAllHooks` is policy-only for this native status-line path | `n4e` calls `oh`, which reads managed policy. Project commands remain excluded. |
| Samples belong to refreshes | `oSe`/`o4e` keep the latest 16 refresh samples. The newer public `AgentInfo.tokenSamples` has a different sampling lifetime; substituting it would change stdin. |

The public API supplies normalized agent fields rather than every private task
field. Its required `tokenCount`/`cwd` values are used with harmless native
fallbacks for incomplete hosts; extra JSONL ids are rejected. A robust own-property
write preserves data even for a special-looking id without altering a prototype.
