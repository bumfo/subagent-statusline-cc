import type { AgentInfo, On, RenderPropsOf, RenderSurface } from 'claude-code'
import { mock } from 'claude-code/testing'

export const agent = (id = 'a', extra: Partial<AgentInfo> = {}): AgentInfo => ({
  id, name: `agent-${id}`, description: `task ${id}`, type: 'Explore',
  kind: 'local_agent', status: 'running', taskStatus: 'running', label: `doing ${id}`,
  startTime: 1000, cwd: '/worktree', model: 'claude-opus-5-5', effort: 'high',
  contextWindowSize: 1000000, tokenCount: 1234, tokenSamples: [1000, 1234],
  hasRow: true, ...extra,
})
export const output = (content = 'decorated', id = 'a') => ({
  exitCode: 0, stderr: '', stdout: JSON.stringify({ id, content }),
  isStdoutTruncated: false, isStderrTruncated: false,
})
export const row = (id = 'a', props: Partial<RenderPropsOf['AgentRow']> = {}, surface: RenderSurface = 'terminal') => ({
  plugin: 'subagent-statusline', surface, component: 'AgentRow' as const,
  requestId: `render-${surface}-${id}`,
  props: { ...agent(id), rowIds: [id], columns: 90, isHidden: false, ...props },
})

/** Hooks underneath the mod supply engine data, never replace its state/clock/
 * render enforcement. A forbidden draw-time write fails the real test kit. */
export function engine(on: On) {
  const clock = mock.clock(on)
  const fixture = {
    clock, agents: [agent()], policy: {} as Record<string, unknown>,
    user: { subagentStatusLine: { type: 'command', command: 'legacy-command' } } as Record<string, unknown>,
    calls: [] as { at: number; argv: readonly string[]; init: Record<string, any> }[],
    reads: [] as string[], forwarded: [] as RenderPropsOf['AgentRow'][],
    writes: [] as unknown[],
    sessionId: 'session-1',
    core: false,
    policyGate: undefined as Promise<void> | undefined,
    idReads: 0,
    logs: [] as string[],
    answer: (() => output()) as () => ReturnType<typeof output> | Promise<ReturnType<typeof output>>,
  }
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.end', (_, e) => ({ sessionId: e.sessionId }))
  on('turn.start', () => ({ turnId: 'turn-1' }))
  on('agent.list', () => ({ value: fixture.agents }))
  on('session.id', () => { fixture.idReads++; return { value: fixture.sessionId } })
  on('session.cwd', () => ({ value: '/session-cwd' }))
  on('session.info', () => ({ value: {
    transcriptPath: '/transcripts/session-1.jsonl', scratchpadDir: '/scratch',
    promptId: 'prompt-1', agentType: 'main', configRoot: '/config-root',
  } }))
  on('process.hookEnv', () => ({ value: {
    CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: 'session-1', CLAUDE_PROJECT_DIR: '/project',
    CLAUDE_PLUGIN_ROOT: '/plugin', CLAUDE_PLUGIN_DATA: '/plugin-data',
  } }))
  on('settings.read', (_, e) => {
    fixture.reads.push(e.source ?? 'merged')
    const gate = fixture.policyGate
    if (e.source === 'policy' && gate) {
      // One policy read waits for the test to open the gate.
      fixture.policyGate = undefined
      return gate.then(() => ({ value: fixture.policy }))
    }
    if (e.source === 'policy') return { value: fixture.policy }
    if (e.source === 'user') return { value: fixture.user }
    if (e.source === undefined) return { value: { ...fixture.user, ...fixture.policy } }
    throw new Error(`Unexpected settings source: ${String(e.source)}`)
  })
  on('process.run', async (_, e) => {
    fixture.calls.push({ at: clock.now(), argv: e.argv, init: e.init ?? {} })
    return { value: await fixture.answer() }
  })
  on('ui.log', (_, e) => { fixture.logs.push(e.text); return { value: undefined } })
  on('state.set', { plugin: 'subagent-statusline', key: 'decorations' }, (_, e, next) => {
    fixture.writes.push(e.value)
    return next(e)
  })
  on('ui.render', { component: 'AgentRow' }, ($, e, next) => {
    fixture.forwarded.push(e.props)
    if (fixture.core) return next(e)
    const { Text } = $.ui.resolve(e)
    return <Text>{e.props.isHidden ? 'hidden' : e.props.body ?? 'engine columns'}</Text>
  })
  return fixture
}

export async function textOf(ui: { find: (query: { type: 'Text' }) => Promise<{ text?: string } | undefined> }) {
  return (await ui.find({ type: 'Text' }))?.text
}

export function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}
