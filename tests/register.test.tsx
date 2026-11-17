import { expect, test } from 'claude-code/testing'
import { agent, deferred, engine, output, row, textOf } from './engine'

// Integration through the official kit. This file imports no process, fs,
// Bun or test-runner replacement and never invokes a Claude executable.

test('disabling the command clears outside drawing and immediately delegates the row', async ($, on) => {
  const h = engine(on)
  const ui = await $.ui.mount(row())
  await h.clock.advance(300)
  expect(await textOf(ui)).toBe('decorated')
  h.user = {}
  await ui.redraw()
  expect(await textOf(ui)).toBe('engine columns')
  await h.clock.settle()
  expect(h.writes[h.writes.length - 1]).toEqual({})
  await h.clock.advance(10000)
  expect(h.calls).toHaveLength(1)
  h.user = { subagentStatusLine: { type: 'command', command: 'again' } }
  await ui.redraw()
  await h.clock.advance(300)
  expect(await textOf(ui)).toBe('decorated')
  expect(h.calls[1]?.argv).toEqual(['/bin/sh', '-c', 'again'])
})

for (const props of [{ body: 'native' }, { isHidden: true }]) {
  test(`native takeover after publication clears without a draw-time write: ${JSON.stringify(props)}`, async ($, on) => {
    const h = engine(on)
    const ui = await $.ui.mount(row())
    await h.clock.advance(300)
    expect(await textOf(ui)).toBe('decorated')
    for (let i = 0; i < 3; i++) await ui.redraw(row('a', props).props)
    await h.clock.settle()
    expect(await textOf(ui)).toBe('body' in props ? 'native' : 'hidden')
    expect(h.writes[h.writes.length - 1]).toEqual({})
    await h.clock.advance(10000)
    expect(h.calls).toHaveLength(1)
    await ui.redraw(row().props)
    await h.clock.advance(300)
    expect(await textOf(ui)).toBe('decorated')
  })
}

test('another mod hiding one row never disables all rows or latches ownership', async ($, on) => {
  const h = engine(on)
  h.agents.push(agent('b'))
  const a = await $.ui.mount(row())
  const b = await $.ui.mount(row('b', { isHidden: true }))
  await h.clock.advance(300)
  expect(await textOf(a)).toBe('decorated')
  expect(await textOf(b)).toBe('hidden')
  await b.redraw(row('b').props)
  await h.clock.advance(4700)
  expect(h.calls).toHaveLength(2)
  expect(await textOf(a)).toBe('decorated')
})

test('different row widths cannot turn the shared 5-second interval into a 300-ms loop', async ($, on) => {
  const h = engine(on)
  h.agents.push(agent('b', { parentId: 'a' }))
  const a = await $.ui.mount(row())
  const b = await $.ui.mount(row('b', { columns: 50 }))
  for (let i = 0; i < 100; i++) {
    await a.redraw()
    await b.redraw()
    await h.clock.advance(100)
  }
  expect(h.calls.map(call => call.at)).toEqual([300, 5000, 10000])
  expect(h.calls.map(call => JSON.parse(call.init.stdin).columns)).toEqual([90, 90, 90])
})

for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
  test(`stored output and hidden-row restoration delegate to AgentRow on ${surface}`, { options: { command: 'own' } }, async ($, on) => {
    const h = engine(on)
    const ui = await $.ui.mount(row('a', {}, surface))
    await h.clock.advance(300)
    expect(await textOf(ui)).toBe('decorated')
    h.answer = () => output('')
    await h.clock.advance(4700)
    expect(await textOf(ui)).toBe('hidden')
    h.answer = () => output('restored')
    await h.clock.advance(5000)
    expect(await textOf(ui)).toBe('restored')
  })
}

test('native 322 input preserves all fields, command environment and body width', async ($, on) => {
  const h = engine(on)
  await $.ui.mount(row())
  await h.clock.advance(300)
  expect(h.calls).toHaveLength(1)
  const call = h.calls[0]!
  expect(call.argv).toEqual(['/bin/sh', '-c', 'legacy-command'])
  expect(call.init.cwd).toBe('/config-root')
  expect(call.init.timeoutMs).toBe(5000)
  expect(call.init.env).toEqual({ CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: 'session-1', CLAUDE_PROJECT_DIR: '/project' })
  expect(JSON.parse(call.init.stdin)).toEqual({
    session_id: 'session-1', transcript_path: '/transcripts/session-1.jsonl', cwd: '/session-cwd',
    scratchpad_dir: '/scratch', prompt_id: 'prompt-1', agent_type: 'main', columns: 90,
    tasks: [{ id: 'a', name: 'agent-a', type: 'local_agent', agentType: 'Explore',
      status: 'running', description: 'task a', label: 'doing a', startTime: 1000,
      model: 'claude-opus-5-5', effort: 'high', contextWindowSize: 1000000,
      tokenCount: 1234, tokenSamples: [1234], cwd: '/worktree' }],
  })
})

test('native 322 skips an already-busy debounce, drops stale results and uses the next periodic refresh', async ($, on) => {
  const h = engine(on)
  const pending = deferred<ReturnType<typeof output>>()
  h.answer = () => pending.promise
  const ui = await $.ui.mount(row())
  await h.clock.advance(300)
  h.agents.push(agent('b'))
  await ui.redraw({ ...row().props, rowIds: ['a', 'b'] })
  await h.clock.advance(300)
  expect(h.calls).toHaveLength(1)
  h.answer = () => output('fresh')
  pending.resolve(output('stale'))
  await h.clock.settle()
  expect(await textOf(ui)).toBe('engine columns')
  await h.clock.advance(4700)
  expect(h.calls.map(call => call.at)).toEqual([300, 5300])
  expect(JSON.parse(h.calls[1]!.init.stdin).tasks).toHaveLength(2)
  expect(await textOf(ui)).toBe('fresh')
})

test('native 322 retained completed rows keep refreshing; eviction stops the timer', async ($, on) => {
  const h = engine(on)
  const ui = await $.ui.mount(row())
  await h.clock.advance(300)
  h.agents = [agent('a', { status: 'completed', taskStatus: 'completed' })]
  await ui.redraw(row('a', h.agents[0]).props)
  await h.clock.advance(9700)
  expect(h.calls.map(call => call.at)).toEqual([300, 5000, 10000])
  expect(JSON.parse(h.calls[2]!.init.stdin).tasks[0].status).toBe('completed')
  h.agents = []
  await h.clock.advance(15000)
  expect(h.calls).toHaveLength(3)
  expect(await textOf(ui)).toBe('engine columns')
})

test('native 322 empty legacy command is present, while an unset command never runs', async ($, on) => {
  const h = engine(on)
  h.user = { subagentStatusLine: { type: 'command', command: '' } }
  const ui = await $.ui.mount(row())
  await h.clock.advance(300)
  expect(h.calls[0]?.argv).toEqual(['/bin/sh', '-c', ''])
  h.user = {}
  await ui.redraw()
  await h.clock.advance(10000)
  expect(h.calls).toHaveLength(1)
})

for (const policy of [{ disableAllHooks: true }, { allowManagedHooksOnly: true }]) {
  test(`managed hook restrictions stop the command: ${JSON.stringify(policy)}`, { options: { command: 'own' } }, async ($, on) => {
    const h = engine(on)
    h.policy = policy
    await $.ui.mount(row())
    await h.clock.advance(10000)
    expect(h.calls).toHaveLength(0)
  })
}

test('native 322 status-line disableAllHooks gate is policy-only, not user settings', async ($, on) => {
  const h = engine(on)
  h.user.disableAllHooks = true
  await $.ui.mount(row())
  await h.clock.advance(300)
  expect(h.calls).toHaveLength(1)
})

test('policy command overrides the mod option without acquiring mod provenance', { options: { command: 'own' } }, async ($, on) => {
  const h = engine(on)
  h.policy = { subagentStatusLine: { type: 'command', command: 'policy' } }
  await $.ui.mount(row())
  await h.clock.advance(300)
  expect(h.calls[0]?.argv[2]).toBe('policy')
  expect(h.calls[0]?.init.env.CLAUDE_PLUGIN_ROOT).toBe(undefined)
  expect(h.reads.every(source => source === 'policy')).toBe(true)
})

test('mod options override inherited bodies and carry their own command provenance', { options: { command: 'own' } }, async ($, on) => {
  const h = engine(on)
  const ui = await $.ui.mount(row('a', { body: 'other', isHidden: true }))
  await h.clock.advance(300)
  expect(await textOf(ui)).toBe('decorated')
  expect(h.calls[0]?.init.env.CLAUDE_PLUGIN_ROOT).toBe('/plugin')
  expect(h.calls[0]?.init.env.CLAUDE_PLUGIN_DATA).toBe('/plugin-data')
})

test('the mod option needs no legacy native setting, including after session start', { options: { command: 'own' } }, async ($, on) => {
  const h = engine(on)
  h.user = {}
  await $.session.start({ cwd: '/session-cwd', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount(row())
  await h.clock.advance(300)
  expect(await textOf(ui)).toBe('decorated')
  expect(h.calls[0]?.argv[2]).toBe('own')
})

test('native 322 samples actual refreshes, not unrelated host reads; keeps the latest 16', async ($, on) => {
  const h = engine(on)
  const ui = await $.ui.mount(row())
  await h.clock.advance(300)
  for (let i = 1; i <= 18; i++) {
    h.agents[0]!.tokenCount = i
    h.agents[0]!.tokenSamples = [99999]
    await ui.redraw()
    await h.clock.advance(i === 1 ? 4700 : 5000)
  }
  expect(JSON.parse(h.calls[18]!.init.stdin).tasks[0].tokenSamples).toEqual(
    Array.from({ length: 16 }, (_, i) => i + 3),
  )
})

for (const failure of ['exit', 'spawn', 'timeout']) {
  test(`${failure} failure removes a previously published body`, async ($, on) => {
    const h = engine(on)
    const ui = await $.ui.mount(row())
    await h.clock.advance(300)
    h.answer = () => {
      if (failure !== 'exit') throw new Error(failure)
      return { ...output('incorrect'), exitCode: 2 }
    }
    await h.clock.advance(4700)
    expect(await textOf(ui)).toBe('engine columns')
  })
}

test('JSONL preserves ANSI and whitespace, ignores malformed rows and takes the last duplicate', async ($, on) => {
  const h = engine(on)
  h.core = true
  const content = '  \u001b[31mred\u001b[0m  '
  h.answer = () => ({ ...output(), stdout: [
    output('old').stdout, 'invalid', '{"id":"a"}', output('unrelated', 'unknown').stdout,
    output(content).stdout, '',
  ].join('\n') })
  const ui = await $.ui.mount(row())
  await h.clock.advance(300)
  await ui.drawn()
  expect(await ui.keepsBeneath()).toBe(true)
  expect(h.forwarded[h.forwarded.length - 1]?.body).toBe(content)
})

test('session end prevents late publication and future redraws from restarting timers', async ($, on) => {
  const h = engine(on)
  const pending = deferred<ReturnType<typeof output>>()
  h.answer = () => pending.promise
  const ui = await $.ui.mount(row())
  await h.clock.advance(300)
  await $.session.end({ reason: 'other', sessionId: 'session-1', resume: { id: 'session-1' } })
  pending.resolve(output('stale'))
  await h.clock.settle()
  await ui.redraw()
  await h.clock.advance(10000)
  expect(h.calls).toHaveLength(1)
  expect(await textOf(ui)).toBe('engine columns')
})

test('task removal while a command is in flight leaves no stale state or continued polling', async ($, on) => {
  const h = engine(on)
  const pending = deferred<ReturnType<typeof output>>()
  h.answer = () => pending.promise
  const ui = await $.ui.mount(row())
  await h.clock.advance(300)
  h.agents = []
  pending.resolve(output('gone'))
  await h.clock.settle()
  expect(await textOf(ui)).toBe('engine columns')
  await h.clock.advance(10000)
  expect(h.calls).toHaveLength(1)
})
