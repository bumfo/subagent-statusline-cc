import type { AgentInfo, EngineInterface, Register, RenderSurface } from 'claude-code'

import type { Decorations } from '../types'

// Stock Claude Code 2.1.326's subagentStatusLine command protocol, on public mod
// APIs. AgentRow still draws the rows and owns selection and navigation.
//
// One worker does all the work. Hooks only record what changed and wake it.
// The worker's jobs run one at a time from a queue, and every state write
// happens inside a job, so writes land in the order the jobs ran. Running the
// command is the one step outside the queue; its output is published by a
// later job, which drops it if anything changed while the command ran.

const DECORATIONS = { plugin: 'subagent-statusline', key: 'decorations' } as const
/** Delay of the first run after the row count or width changes. */
const INITIAL_MS = 300
/** The mod's own command runs every second, as often as stock rows update. */
const REFRESH_MS = 1000
const TIMEOUT_MS = 5000
/** After /clear or resume, how often and how many times to check the session id. */
const SESSION_POLL_MS = 300
const SESSION_POLLS = 10

type Timer = { cancel: () => void }
type Job = () => Promise<void>
type Ending = {
  id: string
  reason: string
  /** True while the session.end hook runs. */
  isActive: boolean
  /** A main-loop turn started after a resume. */
  isTurnSeen: boolean
  polls: number
}
type Live = {
  ownCommand: string
  /** The session the worker runs for; undefined until confirmed. */
  session?: string
  ending?: Ending
  isExited: boolean
  /** Bumped by every change that makes a running or queued command stale. */
  epoch: number
  count: number
  columns: number
  isEnabled: boolean
  isBusy: boolean
  initial?: Timer
  periodic?: Timer
  poll?: Timer
  wake?: Timer
  isRefreshQueued: boolean
  queue: Promise<void>
  rowIds: string
  widths: Map<RenderSurface, Map<string, number>>
  samples: Map<string, number[]>
  shown?: Decorations
}

export const register: Register = (on, options) => {
  // Per registration, not per module: sessions never share timers or samples.
  const live: Live = {
    ownCommand: typeof options.command === 'string' ? options.command : '',
    isExited: false,
    epoch: 0,
    count: 0,
    columns: 0,
    isEnabled: false,
    isBusy: false,
    isRefreshQueued: false,
    queue: Promise.resolve(),
    rowIds: '',
    widths: new Map(),
    samples: new Map(),
  }
  // Without its own command the mod does nothing at all: every hook passes on.
  const isOff = live.ownCommand.trim() === ''

  on('session.start', async ($, e, next) => {
    if (isOff) return next(e)
    stop(live)
    live.session = undefined
    live.ending = undefined
    live.isExited = false
    void enqueue($, live, () => publish($, live, {}))
    requestRefresh($, live)
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    if (isOff) return next(e)
    stop(live)
    live.session = undefined
    live.isExited = e.reason !== 'clear' && e.reason !== 'resume'
    live.ending = live.isExited ? undefined
      : { id: e.sessionId, reason: e.reason, isActive: true, isTurnSeen: false, polls: 0 }
    void enqueue($, live, () => publish($, live, {}))
    try {
      return await next(e)
    } finally {
      if (live.ending) live.ending.isActive = false
      requestRefresh($, live)
    }
  })

  // Settings changes, new turns and a surface going away can change what runs,
  // without any row being drawn again.
  on('settings.read', async ($, e, next) => {
    const result = await next(e)
    if (e.source === undefined && !isOff) requestRefresh($, live)
    return result
  }).catch((_, e, next) => next(e))
  on('turn.start', ($, e, next) => {
    if (isOff) return next(e)
    // A main-loop turn after a resume means the session goes on, even under the
    // same id. A subagent's turn says nothing about which session is live.
    if (e.agentId === undefined && live.ending?.reason === 'resume' && !live.ending.isActive) {
      live.ending.isTurnSeen = true
    }
    requestRefresh($, live)
    return next(e)
  })
  on('session.detach', ($, e, next) => {
    if (isOff) return next(e)
    live.widths.delete(e.surface)
    requestRefresh($, live)
    return next(e)
  })

  on('ui.render', { component: 'AgentRow' }, async ($, e, next) => {
    if (isOff) return next(e)
    // Reading the state subscribes the row, so a later publish redraws it.
    const { value } = await $.state.get(DECORATIONS)
    const { id, columns, rowIds } = e.props
    let isChanged = false
    if (typeof columns === 'number' && Number.isFinite(columns)) {
      let widths = live.widths.get(e.surface)
      if (!widths) live.widths.set(e.surface, widths = new Map())
      if (widths.get(id) !== Math.max(0, columns)) {
        // A new width makes output computed for the old one stale.
        widths.set(id, Math.max(0, columns))
        live.epoch++
        isChanged = true
      }
    }
    const ids = [...rowIds].sort().join('\n')
    if (ids !== live.rowIds) {
      // Rows came or went: output computed for the old rows is stale.
      live.rowIds = ids
      live.epoch++
      isChanged = true
    }
    if (isChanged) requestRefresh($, live)

    if (live.session === undefined || !live.isEnabled) return next(e)
    const body = value && Object.hasOwn(value, id) ? value[id] : undefined
    // The host's row is kept: only its body and visibility change.
    return body === undefined ? next(e) : next({
      ...e, props: { ...e.props, body: body === '' ? undefined : body, isHidden: body === '' },
    })
  })
}

/** Cancels the timers and makes any running or queued command output stale. */
function stop(live: Live): void {
  live.epoch++
  live.initial?.cancel()
  live.periodic?.cancel()
  live.poll?.cancel()
  live.initial = live.periodic = live.poll = undefined
  live.count = 0
  live.isEnabled = false
  live.samples.clear()
}

function enqueue($: EngineInterface, live: Live, job: Job): Promise<void> {
  live.queue = live.queue.then(job).catch(error => {
    $.ui.log(`subagent-statusline: ${String(error)}`, { to: 'debug' })
  })
  return live.queue
}

/**
 * Queues one refresh, from a timer so it never runs inside the dispatch that
 * asked for it (a row draw may not write state).
 */
function requestRefresh($: EngineInterface, live: Live): void {
  if (live.isExited || live.wake || live.isRefreshQueued) return
  live.wake = $.clock.after(0, () => {
    live.wake = undefined
    live.isRefreshQueued = true
    void enqueue($, live, async () => {
      live.isRefreshQueued = false
      await refresh($, live)
    })
  })
}

/** Confirms which session is live. False while waiting for one. */
async function confirmSession($: EngineInterface, live: Live): Promise<boolean> {
  if (live.isExited) return false
  if (live.session !== undefined) return true
  const ending = live.ending
  if (ending?.isActive) return false
  const id = await $.session.id()
  if (ending && id === ending.id) {
    // After /clear, wait for the new session's id. After a resume, the same
    // session goes on once a main-loop turn starts or the polls run out.
    const isSameSession = ending.reason === 'resume' &&
      (ending.isTurnSeen || ending.polls >= SESSION_POLLS)
    if (!isSameSession) {
      if (ending.polls < SESSION_POLLS && !live.poll) {
        ending.polls++
        live.poll = $.clock.after(SESSION_POLL_MS, () => {
          live.poll = undefined
          requestRefresh($, live)
        })
      }
      return false
    }
  }
  live.session = id
  live.ending = undefined
  return true
}

/** Runs inside a job: lists the rows, reads the policy, starts or stops the timers. */
async function refresh($: EngineInterface, live: Live): Promise<void> {
  if (!await confirmSession($, live)) return
  const rows = await agents($)
  const isEnabled = await isCommandAllowed($)
  const ids = new Set(rows.map(row => row.id))
  for (const widths of live.widths.values())
    for (const id of widths.keys()) if (!ids.has(id)) widths.delete(id)
  await schedule($, live, rows.length, columnsFor(live, rows), isEnabled)
}

/**
 * The width sent to the command: on the first surface, terminal first, that
 * measured a listed row, a top-level row's width. Kept when nothing is measured.
 */
function columnsFor(live: Live, rows: AgentInfo[]): number {
  const ids = new Set(rows.map(row => row.id))
  const surfaces = [...live.widths.keys()].sort((a, b) =>
    a === 'terminal' ? -1 : b === 'terminal' ? 1 : a.localeCompare(b))
  for (const surface of surfaces) {
    const widths = live.widths.get(surface)!
    const row = rows.find(row => (!row.parentId || !ids.has(row.parentId)) && widths.has(row.id)) ??
      rows.find(row => widths.has(row.id))
    if (row) return widths.get(row.id)!
  }
  return live.columns
}

/** Runs inside a job. Restarts the timers when the count, width or permission changed. */
async function schedule(
  $: EngineInterface, live: Live, count: number, columns: number, isEnabled: boolean,
): Promise<void> {
  if (live.count === count && live.columns === columns && live.isEnabled === isEnabled) return
  live.epoch++
  live.initial?.cancel()
  live.periodic?.cancel()
  live.initial = live.periodic = undefined
  live.count = count
  live.columns = columns
  live.isEnabled = isEnabled
  if (count === 0) live.samples.clear()
  if (count === 0 || !isEnabled) {
    await publish($, live, {})
    return
  }
  live.initial = $.clock.after(INITIAL_MS, () => tick($, live))
  live.periodic = $.clock.every(REFRESH_MS, () => tick($, live))
}

/** A timer firing. Skipped while the command is still running. */
function tick($: EngineInterface, live: Live): void {
  if (live.isBusy || live.session === undefined) return
  live.isBusy = true
  void runOnce($, live).finally(() => { live.isBusy = false })
}

async function runOnce($: EngineInterface, live: Live): Promise<void> {
  const epoch = live.epoch
  let plan: Plan | undefined
  await enqueue($, live, async () => { plan = await prepare($, live, epoch) })
  if (!plan) return
  const { sessionId } = plan
  // A session end or row change between the job and this line still stops it.
  if (live.epoch !== epoch || live.session !== sessionId) return
  const decorations = await execute($, plan)
  await enqueue($, live, async () => {
    if (live.epoch !== epoch || live.session !== sessionId) return
    await publish($, live, decorations)
    // Rows can go away while the command runs, with no row drawn again.
    if ((await agents($)).length === 0) await schedule($, live, 0, live.columns, live.isEnabled)
  })
}

type Plan = {
  sessionId: string
  rows: AgentInfo[]
  input: unknown
  command: string
  cwd: string
  env: Record<string, string>
}

/** Runs inside a job: everything the command needs, or nothing if it is stale. */
async function prepare($: EngineInterface, live: Live, epoch: number): Promise<Plan | undefined> {
  const isCurrent = () => live.epoch === epoch && live.session !== undefined
  if (!isCurrent()) return
  const rows = await agents($)
  if (!isCurrent()) return
  if (rows.length !== live.count) {
    await refresh($, live)
    return
  }
  if (!await isCommandAllowed($)) {
    await schedule($, live, live.count, live.columns, false)
    return
  }
  const [sessionId, info, cwd, env] = await Promise.all([
    $.session.id(), $.session.info(), $.session.cwd(), $.process.hookEnv(),
  ])
  if (!isCurrent() || sessionId !== live.session) return
  sample(live, rows)
  return {
    sessionId, rows, command: live.ownCommand, cwd: info.configRoot ?? cwd, env,
    input: {
      session_id: sessionId, transcript_path: info.transcriptPath, cwd,
      ...(info.scratchpadDir !== undefined && { scratchpad_dir: info.scratchpadDir }),
      ...(info.promptId !== undefined && { prompt_id: info.promptId }),
      ...(info.agentType !== undefined && { agent_type: info.agentType }),
      // AgentRow's columns is already the body width.
      columns: live.columns,
      tasks: rows.map(row => ({
        id: row.id, name: row.name, type: row.kind, agentType: row.type,
        status: row.taskStatus, description: row.description,
        label: row.label || row.description, startTime: row.startTime,
        model: row.model, effort: row.effort,
        contextWindowSize: row.model ? row.contextWindowSize : undefined,
        tokenCount: row.tokenCount ?? 0, tokenSamples: live.samples.get(row.id) ?? [],
        cwd: row.cwd ?? cwd,
      })),
    },
  }
}

/** Runs the command outside the queue. Any failure restores the stock rows. */
async function execute($: EngineInterface, plan: Plan): Promise<Decorations> {
  let result
  try {
    result = await $.process.run(['/bin/sh', '-c', plan.command], {
      cwd: plan.cwd, env: plan.env, stdin: JSON.stringify(plan.input), timeoutMs: TIMEOUT_MS,
    })
  } catch (error) {
    $.ui.log(`subagent-statusline: command did not run: ${String(error)}`, { to: 'debug' })
    return {}
  }
  if (result.exitCode !== 0) {
    $.ui.log(`subagent-statusline: command exited ${result.exitCode}: ${result.stderr.slice(0, 500)}`, { to: 'debug' })
    return {}
  }
  return parse($, result.stdout, new Set(plan.rows.map(row => row.id)))
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

async function agents($: EngineInterface): Promise<AgentInfo[]> {
  // hasRow includes retained completed rows and rows the command hid.
  return (await $.agent.list()).filter(row =>
    row.hasRow && row.kind === 'local_agent' && row.type !== 'main-session')
}

/**
 * Managed policy decides. A managed subagentStatusLine stays with Claude Code;
 * disableAllHooks and allowManagedHooksOnly stop the mod's command.
 */
async function isCommandAllowed($: EngineInterface): Promise<boolean> {
  const policy = await $.settings.read({ source: 'policy' })
  return policy.disableAllHooks !== true && policy.allowManagedHooksOnly !== true &&
    policy.subagentStatusLine === undefined
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
    if (ids.has(row.id)) decorations[row.id] = row.content
  }
  return decorations
}

/** Runs inside a job, so writes land in queue order. Skips an unchanged value. */
async function publish($: EngineInterface, live: Live, decorations: Decorations): Promise<void> {
  if (live.shown && sameDecorations(live.shown, decorations)) return
  await $.state.set(DECORATIONS, decorations)
  live.shown = decorations
}

function sameDecorations(a: Decorations, b: Decorations): boolean {
  const keys = Object.keys(a)
  return keys.length === Object.keys(b).length &&
    keys.every(key => Object.hasOwn(b, key) && a[key] === b[key])
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
