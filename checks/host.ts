import type { AgentInfo, EngineInterface } from 'claude-code'
import { register } from '../hooks/register'
import type { Decorations } from '../types'

export function agent(id = 'a', extra: Partial<AgentInfo> = {}): AgentInfo {
  return {
    id, name: `agent-${id}`, description: `task ${id}`, type: 'Explore',
    kind: 'local_agent', status: 'running', taskStatus: 'running',
    label: `doing ${id}`, startTime: 1000, cwd: '/worktree',
    model: 'claude-opus-5-5', effort: 'high', contextWindowSize: 1000000,
    tokenCount: 1234, tokenSamples: [999, 1234], hasRow: true, ...extra,
  }
}

export function row(id = 'a', props: Record<string, unknown> = {}) {
  return {
    plugin: 'subagent-statusline', surface: 'terminal', component: 'AgentRow',
    requestId: `render-${id}`, props: {
      ...agent(id), rowIds: [id], columns: 90, isHidden: false, ...props,
    },
  }
}
type Row = ReturnType<typeof row>
type Handler = ($: EngineInterface, event: Row, next: (event: Row) => unknown) => Promise<unknown>
export type Result = { exitCode: number; stdout: string; stderr: string }
export type Run = {
  at: number
  argv: readonly string[]
  init: { cwd: string; env: Record<string, string>; stdin: string; timeoutMs: number }
}
export const output = (content = 'decorated', id = 'a'): Result => ({
  exitCode: 0, stderr: '', stdout: JSON.stringify({ id, content }),
})
export async function flush() {
  // Drain nested public-API promises without real timers or subprocesses.
  for (let i = 0; i < 80; i++) await Promise.resolve()
}
export function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

class Clock {
  now = 0
  timers = new Set<{ at: number; ms?: number; callback: () => void }>()
  after = (ms: number, callback: () => void) => this.add(ms, callback)
  every = (ms: number, callback: () => void) => this.add(ms, callback, ms)
  private add(delay: number, callback: () => void, ms?: number) {
    const timer = { at: this.now + delay, callback, ms }
    this.timers.add(timer)
    return { cancel: () => { this.timers.delete(timer) } }
  }
  async advance(ms: number) {
    const end = this.now + ms
    for (;;) {
      const timer = [...this.timers].sort((a, b) => a.at - b.at)[0]
      if (!timer || timer.at > end) break
      this.now = timer.at
      if (timer.ms === undefined) this.timers.delete(timer)
      else timer.at += timer.ms
      timer.callback()
      await flush()
    }
    this.now = end
    await flush()
  }
}

/** Only public host contracts; no Claude executable, generated SDK or shell. */
export function host(options: Record<string, unknown> = {}) {
  const callbacks = new Map<string, Handler>()
  const h = {
    clock: new Clock(), agents: [agent()], calls: [] as Run[],
    settingsReads: [] as string[], user: { subagentStatusLine: { type: 'command', command: 'legacy-command' } } as Record<string, unknown>,
    policy: {} as Record<string, unknown>,
    info: {
      transcriptPath: '/transcripts/session.jsonl', scratchpadDir: '/scratch',
      promptId: 'prompt-1', agentType: 'main', configRoot: '/config-root',
    } as {
      transcriptPath: string; scratchpadDir?: string; promptId?: string
      agentType?: string; configRoot?: string
    },
    env: {
      CLAUDE_PROJECT_DIR: '/project', CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: 'session-1',
      CLAUDE_PLUGIN_ROOT: '/plugin', CLAUDE_PLUGIN_DATA: '/plugin-data',
    },
    decorations: {} as Decorations, writes: 0, listReads: 0, drawing: 0,
    logs: [] as string[], listError: undefined as Error | undefined,
    settingsError: undefined as Error | undefined,
    hookError: undefined as Error | undefined,
    answer: (() => output()) as (call: Run) => Result | Promise<Result>,
    coreNode: Object.freeze({ host: 'AgentRow', identity: Symbol('host row') }),
    forwarded: [] as Row[],
    api: undefined as unknown as EngineInterface,
    async event(name: string) {
      const event = row()
      return callbacks.get(name)?.(h.api, event, e => e)
    },
    async draw(event = row()) {
      h.drawing++
      try {
        return await callbacks.get('ui.render')!(h.api, event, e => {
          h.forwarded.push(e)
          return h.coreNode
        })
      } finally { h.drawing-- }
    },
    async start() { await h.event('session.start'); await h.draw() },
    input(index = h.calls.length - 1) { return JSON.parse(h.calls[index]!.init.stdin) },
  }
  h.api = {
    agent: { list: async () => {
      h.listReads++
      if (h.listError) throw h.listError
      return h.agents
    } },
    clock: h.clock,
    session: {
      id: async () => 'session-1', cwd: async () => '/session-cwd',
      info: async () => h.info,
    },
    settings: { read: async ({ source }: { source: string }) => {
      if (h.settingsError) throw h.settingsError
      h.settingsReads.push(source)
      if (source === 'policy') return h.policy
      if (source === 'user') return h.user
      throw new Error(`Unexpected settings source: ${source}`)
    } },
    process: {
      hookEnv: async () => { if (h.hookError) throw h.hookError; return h.env },
      run: async (argv: Run['argv'], init: Run['init']) => {
        const call = { at: h.clock.now, argv, init }
        h.calls.push(call)
        return h.answer(call)
      },
    },
    state: {
      get: async () => ({ value: h.decorations }),
      set: async (_: unknown, value: Decorations) => {
        if (h.drawing) throw new Error('state.set: denied while drawing')
        h.writes++; h.decorations = value
      },
    },
    ui: { log: (message: string) => { h.logs.push(message) } },
  } as unknown as EngineInterface
  register(((name: string, ...args: unknown[]) => {
    callbacks.set(name, args[args.length - 1] as Handler)
  }) as Parameters<typeof register>[0], options)
  return h
}
