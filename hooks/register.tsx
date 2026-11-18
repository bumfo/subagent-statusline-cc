import type { AgentInfo, EngineInterface, Register, RenderSurface } from 'claude-code'

import type { Decorations } from '../types'

// Stock Claude Code 2.1.326's command protocol and refresh lifecycle, adapted to
// public Mods APIs. AgentRow still owns rendering, selection and navigation.
const DECORATIONS = { plugin: 'subagent-statusline', key: 'decorations' } as const
const INITIAL_MS = 300
// Mod-owned commands tick with the visible row clock. The host owns legacy commands.
const REFRESH_MS = 1000
const TIMEOUT_MS = 5000
const RESET_ATTEMPTS = 3
type Timer = { cancel: () => void }
type Command = { text: string; own: boolean }
type Live = {
  ownCommand: string
  columns: number
  count: number
  generation: number
  scope: number
  busy: boolean
  enabled: boolean
  ended: boolean
  suspendedId?: string
  clear?: Timer
  wake?: Timer
  initial?: Timer
  periodic?: Timer
  listing?: Promise<AgentInfo[]>
  widths: Map<RenderSurface, Map<string, number>>
  samples: Map<string, number[]>
}

export const register: Register = (on, options) => {
  // Per registration, not per module: sessions must not share timers or samples.
  const live: Live = {
    ownCommand: typeof options.command === 'string' ? options.command : '',
    columns: 0,
    count: 0,
    generation: 0,
    scope: 0,
    busy: false,
    enabled: false,
    ended: false,
    widths: new Map(),
    samples: new Map(),
  }

  on('session.start', async ($, e, next) => {
    reset(live)
    live.ended = false
    live.suspendedId = undefined
    await write($, live, {}, live.generation, true)
    await refresh($, live)
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    reset(live)
    live.ended = e.reason !== 'clear' && e.reason !== 'resume'
    live.suspendedId = live.ended ? undefined : e.sessionId
    await write($, live, {}, live.generation, true)
    const result = await next(e)
    if (!live.ended) requestRefresh($, live)
    return result
  })

  // These events restart discovery even if no AgentRow is redrawn. Settings
  // reads of individual sources (including our own) must not create a loop.
  on('settings.read', async ($, e, next) => {
    const result = await next(e)
    if (e.source === undefined) requestRefresh($, live)
    return result
  }).catch((_, e, next) => next(e))
  on('turn.start', ($, e, next) => {
    requestRefresh($, live)
    return next(e)
  })
  on('session.detach', ($, e, next) => {
    live.widths.delete(e.surface)
    requestRefresh($, live)
    return next(e)
  })

  on('ui.render', { component: 'AgentRow' }, async ($, e, next) => {
    // Subscribe even while disabled or delegated: publishing later must redraw
    // an already-mounted row, not wait for unrelated host activity.
    const scope = live.scope
    const { value } = await $.state.get(DECORATIONS)
    // Record the width before the session check: a row drawn between /clear and
    // the new session id still supplies the next session's width.
    if (typeof e.props.columns === 'number' && Number.isFinite(e.props.columns)) {
      let widths = live.widths.get(e.surface)
      if (!widths) live.widths.set(e.surface, widths = new Map())
      widths.set(e.props.id, Math.max(0, e.props.columns))
    }
    if (!await enterSession($, live)) return next(e)
    try {
      await refresh($, live, true)
    } catch (error) {
      $.ui.log(`subagent-statusline: row refresh failed: ${String(error)}`, { to: 'debug' })
    }
    if (scope !== live.scope || !live.enabled || live.ended || live.suspendedId !== undefined) return next(e)
    const body = value && Object.hasOwn(value, e.props.id) ? value[e.props.id] : undefined
    // Do not replace the node: the host's row keeps its pointer, ANSI handling,
    // truncation, hover and click behavior. requestId is not an agent identity.
    return body === undefined ? next(e) : next({
      ...e, props: { ...e.props, body: body === '' ? undefined : body, isHidden: body === '' },
    })
  })
}

function reset(live: Live): void {
  cancel(live)
  live.scope++
  live.wake?.cancel()
  live.wake = undefined
  live.count = 0
  live.enabled = false
  live.samples.clear()
  live.listing = undefined
  // Widths are kept: after /clear or resume no row may redraw, and the first
  // command of the new session must not get columns: 0. refresh() drops the
  // widths of rows that are gone.
}

async function enterSession($: EngineInterface, live: Live): Promise<boolean> {
  if (live.ended) return false
  const ending = live.suspendedId
  if (ending === undefined) return true
  if (await $.session.id() === ending) return false
  // /clear and in-process resume do not emit session.start. Their next session
  // has new timer/sample/measurement ownership, without overlapping old work.
  if (live.suspendedId === ending) {
    reset(live)
    live.suspendedId = undefined
  }
  return !live.ended && live.suspendedId === undefined
}

function requestRefresh($: EngineInterface, live: Live, delay = 0): void {
  if (live.ended || live.wake) return
  live.wake = $.clock.after(delay, () => {
    live.wake = undefined
    void refresh($, live).catch(error => {
      $.ui.log(`subagent-statusline: refresh failed: ${String(error)}`, { to: 'debug' })
    })
  })
}

async function refresh($: EngineInterface, live: Live, drawing = false): Promise<void> {
  // Without its own command the mod never runs anything: skip the agent list
  // and settings reads that every row draw would otherwise make.
  if (live.ownCommand.trim() === '') return
  if (!await enterSession($, live)) {
    if (!live.ended) requestRefresh($, live, INITIAL_MS)
    return
  }
  const generation = live.generation
  const rows = await agents($, live)
  const command = await resolveCommand($, live)
  if (live.ended) return
  if (generation !== live.generation) {
    // Timers restarted meanwhile (a tick saw a new row count). Run again so a
    // width measured by this draw is not lost.
    requestRefresh($, live)
    return
  }
  const ids = new Set(rows.map(row => row.id))
  for (const widths of live.widths.values())
    for (const id of widths.keys()) if (!ids.has(id)) widths.delete(id)
  // Surfaces are tried in a fixed order, terminal first. On the first surface
  // that measured any listed row, a top-level row's width wins. A redraw on
  // another surface, or a row with no measurement, leaves the width unchanged.
  let columns = live.columns
  const surfaces = [...live.widths.keys()].sort((a, b) =>
    a === 'terminal' ? -1 : b === 'terminal' ? 1 : a.localeCompare(b),
  )
  for (const surface of surfaces) {
    const widths = live.widths.get(surface)!
    const leader = rows.find(row => (!row.parentId || !ids.has(row.parentId)) && widths.has(row.id)) ??
      rows.find(row => widths.has(row.id))
    if (leader) { columns = widths.get(leader.id)!; break }
  }
  // Legacy/policy commands belong to the native host, even before its first
  // asynchronous body arrives. Only a resolved mod-owned command is ours.
  await schedule($, live, rows.length, columns, command?.own === true, drawing)
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
    const generation = live.generation
    if (!drawing) {
      await write($, live, {}, generation, true)
      return
    }
    // schedule is also reached while drawing. State writes there are denied:
    // return the native row immediately, then clear from a timer context.
    live.clear = $.clock.after(0, () => {
      live.clear = undefined
      void write($, live, {}, generation, true).catch(error => {
        $.ui.log(`subagent-statusline: clear failed: ${String(error)}`, { to: 'debug' })
      })
    })
    return
  }
  const generation = live.generation
  live.initial = $.clock.after(INITIAL_MS, () => { void tick($, live, generation) })
  live.periodic = $.clock.every(REFRESH_MS, () => { void tick($, live, generation) })
}

async function tick($: EngineInterface, live: Live, generation: number): Promise<void> {
  if (live.busy || live.ended || live.suspendedId !== undefined || generation !== live.generation) return
  live.busy = true
  try {
    const rows = await agents($, live)
    if (live.ended || generation !== live.generation) return
    if (rows.length !== live.count) {
      await schedule($, live, rows.length, live.columns)
      return
    }
    sample(live, rows)
    const columns = live.columns
    const command = await resolveCommand($, live)
    // A /clear or restart during the settings read makes this refresh obsolete:
    // it must not start the command, not only have its output dropped.
    if (live.ended || generation !== live.generation) return
    if (command?.own !== true) {
      await schedule($, live, rows.length, columns, false)
      return
    }
    const decorations = await run($, live, command, rows, columns, generation)
    if (decorations !== undefined) await write($, live, decorations, generation)
  } catch (error) {
    // Unexpected host failures retain the last successful result.
    $.ui.log(`subagent-statusline: tick failed: ${String(error)}`, { to: 'debug' })
  } finally {
    live.busy = false
    // Rows can disappear while the shell runs, without another AgentRow draw.
    try {
      if (!live.ended && generation === live.generation && (await agents($, live)).length === 0) {
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
  return { text: legacy.command, own: false }
}

async function run(
  $: EngineInterface,
  live: Live,
  command: Command,
  rows: AgentInfo[],
  columns: number,
  generation: number,
): Promise<Decorations | undefined> {
  const [sessionId, info, cwd, hookEnv] = await Promise.all([
    $.session.id(), $.session.info(), $.session.cwd(), $.process.hookEnv(),
  ])
  // Checked again after these reads, right before the spawn: an obsolete run
  // would pair the old rows with the new session's id and paths.
  if (live.ended || generation !== live.generation) return undefined
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
  // Only the mod's own command reaches here (tick checks command.own), so it
  // runs with the mod's CLAUDE_PLUGIN_ROOT and CLAUDE_PLUGIN_DATA.
  let result
  try {
    result = await $.process.run(['/bin/sh', '-c', command.text], {
      cwd: info.configRoot ?? cwd, env: hookEnv, stdin: JSON.stringify(input), timeoutMs: TIMEOUT_MS,
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

async function write($: EngineInterface, live: Live, decorations: Decorations, generation: number, force = false): Promise<void> {
  const { value = {}, version } = await $.state.get(DECORATIONS)
  if (generation !== live.generation) return
  const keys = Object.keys(value)
  if (!force && keys.length === Object.keys(decorations).length && keys.every(key =>
    Object.hasOwn(decorations, key) && value[key] === decorations[key],
  )) return
  // A publication writes only over the version it read, so it misses once a
  // reset has written.
  if (!force) {
    await $.state.set(DECORATIONS, decorations, { ifVersion: version })
    return
  }
  // A reset writes even an already-empty value, so the version advances and a
  // delayed publication misses. It is versioned too: a reset delayed inside
  // the host must miss once a newer generation has published. When an older
  // publication that was already inside the host beats it, it tries again over
  // that write's version while its own generation is still current.
  let current = version
  for (let attempt = 0; attempt < RESET_ATTEMPTS; attempt++) {
    const result = await $.state.set(DECORATIONS, decorations, { ifVersion: current })
    if (result.isSet || generation !== live.generation) return
    current = result.version
  }
  // Every attempt missed and no newer generation exists: write without a
  // version rather than leave old output in place.
  await $.state.set(DECORATIONS, decorations)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
