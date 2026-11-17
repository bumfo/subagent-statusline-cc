import type { AgentInfo, EngineInterface, Register } from 'claude-code'

import type { Decorations } from '../types'

// Claude Code 2.1.322's command protocol and refresh lifecycle, adapted to
// public Mods APIs. AgentRow still owns rendering, selection and navigation.
const DECORATIONS = { plugin: 'subagent-statusline', key: 'decorations' } as const
const INITIAL_MS = 300
const REFRESH_MS = 5000
const TIMEOUT_MS = 5000
type Timer = { cancel: () => void }
type Command = { text: string; own: boolean }
type Live = {
  ownCommand: string
  refreshMs: number
  columns: number
  count: number
  generation: number
  busy: boolean
  enabled: boolean
  ended: boolean
  native: boolean
  clear?: Timer
  initial?: Timer
  periodic?: Timer
  listing?: Promise<AgentInfo[]>
  owned: Set<string>
  widths: Map<string, { columns: number; terminal: boolean }>
  samples: Map<string, number[]>
}

export const register: Register = (on, options) => {
  // Per registration, not per module: sessions must not share timers or samples.
  const live: Live = {
    ownCommand: typeof options.command === 'string' ? options.command : '',
    refreshMs: typeof options.refreshMs === 'number' && Number.isFinite(options.refreshMs)
      ? Math.max(1000, options.refreshMs) : REFRESH_MS,
    columns: 0,
    count: 0,
    generation: 0,
    busy: false,
    enabled: false,
    ended: false,
    native: false,
    owned: new Set(),
    widths: new Map(),
    samples: new Map(),
  }

  on('session.start', async ($, e, next) => {
    cancel(live)
    live.ended = false
    live.native = false
    live.count = 0
    live.enabled = false
    live.samples.clear()
    live.owned.clear()
    live.widths.clear()
    await write($, {})
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    live.ended = true
    cancel(live)
    live.samples.clear()
    await write($, {})
    return next(e)
  })

  on('ui.render', { component: 'AgentRow' }, async ($, e, next) => {
    if (live.ended) return next(e)
    // A body/hidden flag may come from another mod, not only native settings.
    // Delegate this row, never latch ownership for the rest of the session.
    const owned = live.ownCommand.trim() === '' &&
      (e.props.body !== undefined || e.props.isHidden)
    if (owned) live.owned.add(e.props.id)
    else live.owned.delete(e.props.id)
    if (e.props.columns !== undefined &&
      (e.surface === 'terminal' || !live.widths.get(e.props.id)?.terminal)) {
      live.widths.set(e.props.id, {
        columns: Math.max(0, e.props.columns), terminal: e.surface === 'terminal',
      })
    }
    try {
      const rows = await agents($, live)
      const ids = new Set(rows.map(row => row.id))
      for (const id of live.owned) if (!ids.has(id)) live.owned.delete(id)
      for (const id of live.widths.keys()) if (!ids.has(id)) live.widths.delete(id)
      live.native = rows.length > 0 && rows.every(row => live.owned.has(row.id))
      const enabled = rows.length > 0 && !live.native &&
        (await resolveCommand($, live)) !== undefined
      // Native has one viewport width, not the width of the last row drawn.
      // Use the first eligible root's measurement, so nested/narrow rows and
      // other attached surfaces cannot continually reset the shared timers.
      const leader = rows.find(row => !row.parentId || !ids.has(row.parentId))
      const columns = leader ? live.widths.get(leader.id)?.columns ?? live.columns : live.columns
      if (!live.ended) {
        await schedule($, live, rows.length, columns, enabled, true)
      }
    } catch (error) {
      $.ui.log(`subagent-statusline: row refresh failed: ${String(error)}`, { to: 'debug' })
    }
    if (owned || live.native || !live.enabled) return next(e)
    const { value } = await $.state.get(DECORATIONS)
    const body = value && Object.hasOwn(value, e.props.id) ? value[e.props.id] : undefined
    // Do not replace the node: the host's row keeps its pointer, ANSI handling,
    // truncation, hover and click behavior. requestId is not an agent identity.
    return body === undefined ? next(e) : next({
      ...e, props: { ...e.props, body: body === '' ? undefined : body, isHidden: body === '' },
    })
  })
}

function cancel(live: Live): void {
  live.generation++
  live.initial?.cancel()
  live.periodic?.cancel()
  live.clear?.cancel()
  live.clear = undefined
  live.initial = undefined
  live.periodic = undefined
}

async function agents($: EngineInterface, live: Live): Promise<AgentInfo[]> {
  // Concurrent row draws share one read. hasRow is the host's producer
  // eligibility, including retained/completed and command-hidden rows.
  const listing = (live.listing ??= $.agent.list().then(rows => rows.filter(
    row => row.hasRow && row.kind === 'local_agent' && row.type !== 'main-session',
  )))
  try {
    return await listing
  } finally {
    if (live.listing === listing) live.listing = undefined
  }
}

async function schedule(
  $: EngineInterface,
  live: Live,
  count: number,
  columns: number,
  enabled = live.enabled,
  drawing = false,
): Promise<void> {
  // Refresh inputs are producer count and width, not identities/status.
  if (live.count === count && live.columns === columns && live.enabled === enabled) return
  cancel(live)
  live.count = count
  live.columns = columns
  live.enabled = enabled
  if (count === 0) live.samples.clear()
  if (count === 0 || !enabled) {
    if (!drawing) {
      await write($, {})
      return
    }
    // schedule is also reached while drawing. State writes there are denied:
    // return the native row immediately, then clear from a timer context.
    live.clear = $.clock.after(0, () => {
      live.clear = undefined
      void write($, {}).catch(error => {
        $.ui.log(`subagent-statusline: clear failed: ${String(error)}`, { to: 'debug' })
      })
    })
    return
  }
  const generation = live.generation
  live.initial = $.clock.after(INITIAL_MS, () => { void tick($, live, generation) })
  live.periodic = $.clock.every(live.refreshMs, () => { void tick($, live, generation) })
}

async function tick($: EngineInterface, live: Live, generation: number): Promise<void> {
  if (live.busy || live.ended || live.native || generation !== live.generation) return
  live.busy = true
  try {
    const rows = await agents($, live)
    if (live.ended || live.native || generation !== live.generation) return
    if (rows.length !== live.count) {
      await schedule($, live, rows.length, live.columns)
      return
    }
    sample(live, rows)
    const columns = live.columns
    const command = await resolveCommand($, live)
    if (command === undefined) {
      if (!live.ended && !live.native && generation === live.generation) {
        await schedule($, live, rows.length, columns, false)
      }
      return
    }
    const decorations = await run($, live, command, rows, columns)
    if (!live.ended && !live.native && generation === live.generation) await write($, decorations)
  } catch (error) {
    // Unexpected host failures retain the last successful result.
    $.ui.log(`subagent-statusline: tick failed: ${String(error)}`, { to: 'debug' })
  } finally {
    live.busy = false
    // Rows can disappear while the shell runs, without another AgentRow draw.
    try {
      if (!live.ended && !live.native && (await agents($, live)).length === 0) {
        await schedule($, live, 0, live.columns)
      }
    } catch (error) {
      $.ui.log(`subagent-statusline: cleanup failed: ${String(error)}`, { to: 'debug' })
    }
  }
}

function sample(live: Live, rows: AgentInfo[]): void {
  const ids = new Set(rows.map(row => row.id))
  for (const row of rows) {
    const history = live.samples.get(row.id) ?? []
    history.push(row.tokenCount ?? 0)
    if (history.length > 16) history.splice(0, history.length - 16)
    live.samples.set(row.id, history)
  }
  for (const id of live.samples.keys()) if (!ids.has(id)) live.samples.delete(id)
}

async function resolveCommand($: EngineInterface, live: Live): Promise<Command | undefined> {
  // Policy wins. Never execute a command supplied by project settings.
  const policy = await $.settings.read({ source: 'policy' })
  if (policy.disableAllHooks === true) return
  let legacy: unknown = policy.subagentStatusLine
  if (legacy === undefined && policy.allowManagedHooksOnly !== true) {
    if (live.ownCommand.trim() !== '') return { text: live.ownCommand, own: true }
    const user = await $.settings.read({ source: 'user' })
    legacy = user.subagentStatusLine
  }
  if (!isRecord(legacy) || legacy.type !== 'command' || typeof legacy.command !== 'string') return
  // Legacy commands have no plugin owner; do not give them this mod's identity.
  if (legacy.command.includes('${CLAUDE_PLUGIN_ROOT}') || legacy.command.includes('${CLAUDE_PLUGIN_DATA}')) return
  return { text: legacy.command, own: false }
}

async function run(
  $: EngineInterface,
  live: Live,
  command: Command,
  rows: AgentInfo[],
  columns: number,
): Promise<Decorations> {
  const [sessionId, info, cwd, hookEnv] = await Promise.all([
    $.session.id(), $.session.info(), $.session.cwd(), $.process.hookEnv(),
  ])
  const input = {
    session_id: sessionId, transcript_path: info.transcriptPath, cwd,
    ...(info.scratchpadDir !== undefined && { scratchpad_dir: info.scratchpadDir }),
    ...(info.promptId !== undefined && { prompt_id: info.promptId }),
    ...(info.agentType !== undefined && { agent_type: info.agentType }),
    // Public AgentRow.columns is already the body width: don't subtract twice.
    columns,
    tasks: rows.map(row => ({
      id: row.id, name: row.name, type: row.kind, agentType: row.type,
      status: row.taskStatus, description: row.description,
      label: row.label || row.description, startTime: row.startTime,
      model: row.model, effort: row.effort,
      contextWindowSize: row.model ? row.contextWindowSize : undefined,
      tokenCount: row.tokenCount ?? 0, tokenSamples: live.samples.get(row.id) ?? [],
      cwd: row.cwd ?? cwd,
    })),
  }
  const env = { ...hookEnv }
  if (!command.own) {
    delete env.CLAUDE_PLUGIN_ROOT
    delete env.CLAUDE_PLUGIN_DATA
  }
  let result
  try {
    result = await $.process.run(['/bin/sh', '-c', command.text], {
      cwd: info.configRoot ?? cwd, env, stdin: JSON.stringify(input), timeoutMs: TIMEOUT_MS,
    })
  } catch (error) {
    // process.run throws for spawn failures/timeouts. Like nonzero exits, these
    // failures must restore the host's default columns.
    $.ui.log(`subagent-statusline: command did not run: ${String(error)}`, { to: 'debug' })
    return {}
  }
  if (result.exitCode !== 0) {
    $.ui.log(`subagent-statusline: command exited ${result.exitCode}: ${result.stderr.slice(0, 500)}`, { to: 'debug' })
    return {}
  }
  return parse($, result.stdout, new Set(rows.map(row => row.id)))
}

function parse($: EngineInterface, stdout: string, ids: ReadonlySet<string>): Decorations {
  const decorations: Decorations = {}
  for (const line of stdout.split('\n')) {
    if (line.trim() === '') continue
    let row: unknown
    try {
      row = JSON.parse(line)
    } catch {
      $.ui.log(`subagent-statusline: non-JSON line: ${line.slice(0, 200)}`, { to: 'debug' })
      continue
    }
    if (!isRecord(row) || typeof row.id !== 'string' || typeof row.content !== 'string') {
      $.ui.log(`subagent-statusline: line is not {id, content}: ${line.slice(0, 200)}`, { to: 'debug' })
      continue
    }
    if (ids.has(row.id)) Object.defineProperty(decorations, row.id, {
      value: row.content, enumerable: true, writable: true, configurable: true,
    })
  }
  return decorations
}

async function write($: EngineInterface, decorations: Decorations): Promise<void> {
  const { value = {} } = await $.state.get(DECORATIONS)
  const keys = Object.keys(value)
  if (keys.length === Object.keys(decorations).length && keys.every(key =>
    Object.hasOwn(decorations, key) && value[key] === decorations[key],
  )) return
  await $.state.set(DECORATIONS, decorations)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
