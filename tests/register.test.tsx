import type { AgentInfo, On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

const LEGACY = 'legacy-cmd'
const OWN = 'own-cmd'

function agent(id: string, extra: Partial<AgentInfo> = {}): AgentInfo {
  return {
    id,
    description: `task ${id}`,
    type: 'Explore',
    status: 'running',
    kind: 'local_agent',
    taskStatus: 'running',
    label: `doing ${id}`,
    startTime: 1000,
    cwd: '/repo',
    model: 'claude-opus-5-5',
    tokenCount: 1234,
    tokenSamples: [1000, 1234],
    hasRow: true,
    name: `agent-${id}`,
    ...extra,
  }
}

const AGENTS = [agent('a1'), agent('a2'), agent('a3', { hasRow: false })]

type Run = { argv: readonly string[]; stdin: string | undefined }

/** Stands for the engine beneath the mod; returns the runs the mod made. */
function engine(
  on: On,
  answer: { exitCode: number; stdout: string },
  legacy: unknown = { type: 'command', command: LEGACY },
  agents: AgentInfo[] = AGENTS,
): Run[] {
  const runs: Run[] = []
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('agent.list', () => ({ value: agents }))
  on('session.id', () => ({ value: 'sess-1' }))
  on('session.cwd', () => ({ value: '/repo' }))
  on('session.info', () => ({
    value: { transcriptPath: '/t/sess-1.jsonl' } as never,
  }))
  on('process.hookEnv', () => ({ value: { CLAUDE_PROJECT_DIR: '/repo' } }))
  on('settings.read', (_, e) => {
    // Only the user's own file may supply the command.
    if (e.source !== 'user') throw new Error(`read ${String(e.source)} settings`)
    return { value: legacy === null ? {} : { subagentStatusLine: legacy } }
  })
  on('process.run', (_, e) => {
    runs.push({ argv: e.argv, stdin: e.init?.stdin })
    return {
      value: {
        ...answer,
        stderr: 'boom',
        isStdoutTruncated: false,
        isStderrTruncated: false,
      },
    }
  })
  // The engine's own row: its body when one is set, else its own columns.
  on('ui.render', { component: 'AgentRow' }, ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>{e.props.body ?? 'engine columns'}</Text>
  })

  return runs
}

function row(id: string, body?: string) {
  const info = AGENTS.find(one => one.id === id) ?? agent(id)
  return {
    plugin: 'subagent-statusline',
    surface: 'terminal',
    component: 'AgentRow',
    requestId: id,
    props: {
      ...info,
      rowIds: ['a1', 'a2'] as string[],
      columns: 90,
      isHidden: false,
      ...(body === undefined ? {} : { body }),
    },
  } as const
}

async function textOf(ui: { find: (q: { type: 'Text' }) => Promise<{ text?: string } | undefined> }) {
  return (await ui.find({ type: 'Text' }))?.text
}

test('one run serves every row, each body matched by id', async ($, on) => {
  const clock = mock.clock(on)
  const runs = engine(on, {
    exitCode: 0,
    stdout: [
      JSON.stringify({ id: 'a2', content: 'second row' }),
      'not json',
      JSON.stringify({ id: 'a1', content: 'first row' }),
      JSON.stringify({ id: 'a1' }),
      JSON.stringify({ id: 'zz', content: 'no such row' }),
      '',
    ].join('\n'),
  })

  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  const first = await $.ui.mount(row('a1'))
  const second = await $.ui.mount(row('a2'))
  expect(await textOf(first)).toBe('engine columns')

  await clock.advance(1000)

  expect(runs.length).toBe(1)
  expect(runs[0]?.argv).toEqual(['/bin/sh', '-c', LEGACY])
  expect(await textOf(first)).toBe('first row')
  expect(await textOf(second)).toBe('second row')

  // The legacy stdin: rows only, the engine's field names, the row width.
  const input = JSON.parse(runs[0]?.stdin ?? '{}')
  expect(input.session_id).toBe('sess-1')
  expect(input.cwd).toBe('/repo')
  expect(input.transcript_path).toBe('/t/sess-1.jsonl')
  expect(input.columns).toBe(90)
  expect(input.tasks.map((t: { id: string }) => t.id)).toEqual(['a1', 'a2'])
  expect(input.tasks[0]).toEqual({
    id: 'a1',
    name: 'agent-a1',
    type: 'local_agent',
    agentType: 'Explore',
    status: 'running',
    description: 'task a1',
    label: 'doing a1',
    startTime: 1000,
    model: 'claude-opus-5-5',
    tokenCount: 1234,
    tokenSamples: [1000, 1234],
    cwd: '/repo',
  })

  // Nothing changed: no run until the refresh interval has passed.
  await clock.advance(3000)
  expect(runs.length).toBe(1)
  await clock.advance(2000)
  expect(runs.length).toBe(2)

  await first.unmount()
  await second.unmount()
})

test('a body the engine already set is left alone, and nothing runs', async ($, on) => {
  const clock = mock.clock(on)
  const runs = engine(on, {
    exitCode: 0,
    stdout: JSON.stringify({ id: 'a1', content: 'from the mod' }),
  })

  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount(row('a1', 'from the engine'))
  await clock.advance(6000)

  expect(runs.length).toBe(0)
  expect(await textOf(ui)).toBe('from the engine')
  await ui.unmount()
})

test('a failing command leaves the engine its rows', async ($, on) => {
  const clock = mock.clock(on)
  const runs = engine(on, {
    exitCode: 2,
    stdout: JSON.stringify({ id: 'a1', content: 'should not show' }),
  })

  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount(row('a1'))
  await clock.advance(1000)

  expect(runs.length).toBe(1)
  expect(await textOf(ui)).toBe('engine columns')
  await ui.unmount()
})

test('no command anywhere: nothing runs', async ($, on) => {
  const clock = mock.clock(on)
  const runs = engine(on, { exitCode: 0, stdout: '' }, null)

  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount(row('a1'))
  await clock.advance(6000)

  expect(runs.length).toBe(0)
  expect(await textOf(ui)).toBe('engine columns')
  await ui.unmount()
})

test(
  'its own command wins over the legacy key and over the engine body',
  { options: { command: OWN } },
  async ($, on) => {
    const clock = mock.clock(on)
    const runs = engine(on, {
      exitCode: 0,
      stdout: JSON.stringify({ id: 'a1', content: 'from the mod' }),
    })

    await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
    const ui = await $.ui.mount(row('a1', 'from the engine'))
    await clock.advance(1000)

    expect(runs.length).toBe(1)
    expect(runs[0]?.argv).toEqual(['/bin/sh', '-c', OWN])
    expect(await textOf(ui)).toBe('from the mod')
    await ui.unmount()
  },
)

test('a mod loaded mid-session starts its timer from the first row', async ($, on) => {
  const clock = mock.clock(on)
  const runs = engine(on, {
    exitCode: 0,
    stdout: JSON.stringify({ id: 'a1', content: 'first row' }),
  })

  // No session.start: the row's draw starts the timer.
  const ui = await $.ui.mount(row('a1'))
  await clock.advance(1000)

  expect(runs.length).toBe(1)
  expect(await textOf(ui)).toBe('first row')
  await ui.unmount()
})

test('an agent finishing runs the command at once', async ($, on) => {
  const clock = mock.clock(on)
  const agents = [agent('a1')]
  const runs = engine(
    on,
    { exitCode: 0, stdout: JSON.stringify({ id: 'a1', content: 'row' }) },
    undefined,
    agents,
  )

  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount(row('a1'))
  await clock.advance(1000)
  expect(runs.length).toBe(1)

  agents[0] = agent('a1', { status: 'completed', taskStatus: 'completed' })
  await clock.advance(1000)
  expect(runs.length).toBe(2)
  expect(JSON.parse(runs[1]?.stdin ?? '{}').tasks[0].status).toBe('completed')

  // Nothing running: no more periodic runs.
  await clock.advance(20000)
  expect(runs.length).toBe(2)
  await ui.unmount()
})
