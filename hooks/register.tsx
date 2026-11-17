import type { AgentInfo, EngineInterface, Register } from 'claude-code'

import type { Decorations } from '../types'

// subagentStatusLine, as Claude Code 2.1.326 ran it, rebuilt on AgentRow:
// one shell run for every agent row, the legacy JSON on stdin, one
// {"id","content"} JSON line per row on stdout, each `content` drawn as that
// row's body. Rows the command leaves out keep the engine's own columns.

const DECORATIONS = {
  plugin: 'subagent-statusline',
  key: 'decorations',
} as const

/** How often the timer looks at the agent list. A run happens only when due. */
const POLL_MS = 1000
/** The engine's own time limit for this command. */
const RUN_TIMEOUT_MS = 5000
/** The engine's own refresh interval for this command. */
const DEFAULT_REFRESH_MS = 5000

type Timer = { cancel: () => void }

// Module variables start over on a reload; each is rebuilt by the next draw
// or tick. What a drawing reads is in $.state.
const live = {
  ownCommand: '',
  refreshMs: DEFAULT_REFRESH_MS,
  columns: undefined as number | undefined,
  timer: undefined as Timer | undefined,
  isBusy: false,
  lastKey: '',
  lastRunAt: 0,
  // Set once a row arrives with `body` already filled while this mod has no
  // command of its own: the engine still runs subagentStatusLine itself.
  isEngineDrawing: false,
}

export const register: Register = (on, options) => {
  live.ownCommand =
    typeof options.command === 'string' ? options.command.trim() : ''
  live.refreshMs = Math.max(
    POLL_MS,
    typeof options.refreshMs === 'number'
      ? options.refreshMs
      : DEFAULT_REFRESH_MS,
  )

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    start($)

    return started
  })

  on('ui.render', { component: 'AgentRow' }, async ($, e, next) => {
    if (typeof e.props.columns === 'number') live.columns = e.props.columns
    // The mod can load mid-session, after session.start has run.
    if (live.timer === undefined) start($)

    if (e.props.body !== undefined && live.ownCommand === '') {
      live.isEngineDrawing = true
      return next(e)
    }

    const { value } = await $.state.get(DECORATIONS)
    const body = value?.[e.requestId]

    return body === undefined
      ? next(e)
      : next({ ...e, props: { ...e.props, body } })
  })
}

function start($: EngineInterface): void {
  if (live.timer !== undefined) return
  live.timer = $.clock.every(POLL_MS, () => {
    void tick($)
  })
}

async function tick($: EngineInterface): Promise<void> {
  if (live.isBusy) return
  live.isBusy = true
  try {
    await refresh($)
  } catch (error) {
    $.ui.log(`subagent-statusline: tick failed: ${String(error)}`, {
      to: 'debug',
    })
  } finally {
    live.isBusy = false
  }
}

async function refresh($: EngineInterface): Promise<void> {
  const agents = (await $.agent.list()).filter(agent => agent.hasRow)
  if (agents.length === 0) {
    live.lastKey = ''
    await write($, {})
    return
  }

  // The engine still runs subagentStatusLine itself: the rows are its own.
  if (live.ownCommand === '' && live.isEngineDrawing) {
    await write($, {})
    return
  }

  // A row coming or going, a width change or an agent finishing runs the
  // command at once, so the finished agent's row gets its last update.
  const rows = agents.map(agent => `${agent.id}:${agent.taskStatus}`).join(',')
  const key = `${live.columns ?? ''}|${rows}`
  const now = await $.clock.now()
  const isLive = agents.some(
    agent => agent.taskStatus === 'running' || agent.taskStatus === 'pending',
  )
  const isDue =
    key !== live.lastKey || (isLive && now - live.lastRunAt >= live.refreshMs)
  if (!isDue) return

  live.lastKey = key
  live.lastRunAt = now
  const command = await resolveCommand($)
  if (command === undefined) {
    await write($, {})
    return
  }

  const decorations = await run($, command, agents)
  if (decorations !== undefined) await write($, decorations)
}

async function resolveCommand(
  $: EngineInterface,
): Promise<string | undefined> {
  if (live.ownCommand !== '') return live.ownCommand

  // The user's own settings file only: a project's settings could otherwise
  // hand this mod a shell command to run.
  const legacy = await $.settings.read({
    key: 'subagentStatusLine',
    source: 'user',
  })
  if (
    isRecord(legacy) &&
    legacy.type === 'command' &&
    typeof legacy.command === 'string' &&
    legacy.command.trim() !== ''
  ) {
    return legacy.command
  }

  return undefined
}

/** Runs the command once for every row; undefined when it could not run. */
async function run(
  $: EngineInterface,
  command: string,
  agents: AgentInfo[],
): Promise<Decorations | undefined> {
  const [sessionId, info, cwd, env] = await Promise.all([
    $.session.id(),
    $.session.info(),
    $.session.cwd(),
    $.process.hookEnv(),
  ])
  const input = {
    session_id: sessionId,
    transcript_path: info.transcriptPath,
    cwd,
    columns: live.columns ?? 0,
    tasks: agents.map(agent => ({
      id: agent.id,
      name: agent.name,
      type: agent.kind,
      agentType: agent.type,
      status: agent.taskStatus,
      description: agent.description,
      label: agent.label || agent.description,
      startTime: agent.startTime,
      model: agent.model,
      effort: agent.effort,
      contextWindowSize: agent.contextWindowSize,
      tokenCount: agent.tokenCount,
      tokenSamples: agent.tokenSamples,
      cwd: agent.cwd,
    })),
  }

  let result
  try {
    result = await $.process.run(['/bin/sh', '-c', command], {
      env,
      stdin: JSON.stringify(input),
      timeoutMs: RUN_TIMEOUT_MS,
    })
  } catch (error) {
    $.ui.log(`subagent-statusline: command did not run: ${String(error)}`, {
      to: 'debug',
    })
    return undefined
  }

  if (result.exitCode !== 0) {
    $.ui.log(
      `subagent-statusline: command exited ${result.exitCode}: ${result.stderr.slice(0, 500)}`,
      { to: 'debug' },
    )
    return {}
  }

  return parse($, result.stdout, new Set(agents.map(agent => agent.id)))
}

function parse(
  $: EngineInterface,
  stdout: string,
  ids: ReadonlySet<string>,
): Decorations {
  const decorations: Decorations = {}
  for (const line of stdout.split('\n')) {
    if (line.trim() === '') continue
    let row: unknown
    try {
      row = JSON.parse(line)
    } catch {
      $.ui.log(`subagent-statusline: non-JSON line: ${line.slice(0, 200)}`, {
        to: 'debug',
      })
      continue
    }
    if (
      !isRecord(row) ||
      typeof row.id !== 'string' ||
      typeof row.content !== 'string'
    ) {
      $.ui.log(
        `subagent-statusline: line is not {id, content}: ${line.slice(0, 200)}`,
        { to: 'debug' },
      )
      continue
    }
    if (ids.has(row.id)) decorations[row.id] = row.content
  }

  return decorations
}

async function write(
  $: EngineInterface,
  decorations: Decorations,
): Promise<void> {
  const { value = {} } = await $.state.get(DECORATIONS)
  if (isSame(value, decorations)) return
  await $.state.set(DECORATIONS, decorations)
}

function isSame(a: Decorations, b: Decorations): boolean {
  const keys = Object.keys(a)
  if (keys.length !== Object.keys(b).length) return false

  return keys.every(key => a[key] === b[key])
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
