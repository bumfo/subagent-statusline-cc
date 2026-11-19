import { expect, test as kitTest } from 'claude-code/testing'
import { agent, deferred, engine, output, row, textOf } from './engine'

// Ordinary contract cases exercise a mod-owned command. Legacy ownership is
// tested explicitly below, not simulated as if the host stopped running it.
const test: typeof kitTest = (name: string, ...args: any[]) => args.length === 1
  ? kitTest(name, { options: { command: 'fixture-command' } }, args[0])
  : kitTest(name, args[0], args[1])

// Integration through the official kit. This file imports no process, fs,
// Bun or test-runner replacement and never invokes a Claude executable.

test('disabling the command clears outside drawing and immediately delegates the row', async ($, on) => {
  const h = engine(on)
  const ui = await $.ui.mount(row())
  await h.clock.advance(300)
  expect(await textOf(ui)).toBe('decorated')
  h.policy.disableAllHooks = true
  await ui.redraw()
  expect(await textOf(ui)).toBe('engine columns')
  await h.clock.settle()
  expect(h.writes[h.writes.length - 1]).toEqual({})
  await h.clock.advance(10000)
  expect(h.calls).toHaveLength(1)
  h.policy = {}
  await ui.redraw()
  await h.clock.advance(300)
  expect(await textOf(ui)).toBe('decorated')
  expect(h.calls[1]?.argv).toEqual(['/bin/sh', '-c', 'fixture-command'])
})

for (const props of [{ body: 'native' }, { isHidden: true }]) {
  test(`native takeover after publication clears without a draw-time write: ${JSON.stringify(props)}`, async ($, on) => {
    const h = engine(on)
    const ui = await $.ui.mount(row())
    await h.clock.advance(300)
    expect(await textOf(ui)).toBe('decorated')
    h.policy.subagentStatusLine = { type: 'command', command: 'managed' }
    for (let i = 0; i < 3; i++) await ui.redraw(row('a', props).props)
    await h.clock.settle()
    expect(await textOf(ui)).toBe('body' in props ? 'native' : 'hidden')
    expect(h.writes[h.writes.length - 1]).toEqual({})
    await h.clock.advance(10000)
    expect(h.calls).toHaveLength(1)
    h.policy = {}
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
  await h.clock.advance(700)
  expect(h.calls).toHaveLength(2)
  expect(await textOf(a)).toBe('decorated')
})

test('different row widths cannot turn the shared one-second interval into a 300-ms loop', async ($, on) => {
  const h = engine(on)
  h.agents.push(agent('b', { parentId: 'a' }))
  const a = await $.ui.mount(row())
  const b = await $.ui.mount(row('b', { columns: 50 }))
  for (let i = 0; i < 100; i++) {
    await a.redraw()
    await b.redraw()
    await h.clock.advance(100)
  }
  expect(h.calls.map(call => call.at)).toEqual([300, ...Array.from({ length: 10 }, (_, n) => (n + 1) * 1000)])
  expect(h.calls.map(call => JSON.parse(call.init.stdin).columns)).toEqual(Array(11).fill(90))
})

for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
  test(`stored output and hidden-row restoration delegate to AgentRow on ${surface}`, { options: { command: 'own' } }, async ($, on) => {
    const h = engine(on)
    const ui = await $.ui.mount(row('a', {}, surface))
    await h.clock.advance(300)
    expect(await textOf(ui)).toBe('decorated')
    h.answer = () => output('')
    await h.clock.advance(700)
    expect(await textOf(ui)).toBe('hidden')
    h.answer = () => output('restored')
    await h.clock.advance(1000)
    expect(await textOf(ui)).toBe('restored')
  })
}

test('input preserves all fields, command environment and body width', async ($, on) => {
  const h = engine(on)
  await $.ui.mount(row())
  await h.clock.advance(300)
  expect(h.calls).toHaveLength(1)
  const call = h.calls[0]!
  expect(call.argv).toEqual(['/bin/sh', '-c', 'fixture-command'])
  expect(call.init.cwd).toBe('/config-root')
  expect(call.init.timeoutMs).toBe(5000)
  expect(call.init.env).toEqual({ CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: 'session-1', CLAUDE_PROJECT_DIR: '/project', CLAUDE_PLUGIN_ROOT: '/plugin', CLAUDE_PLUGIN_DATA: '/plugin-data' })
  expect(JSON.parse(call.init.stdin)).toEqual({
    session_id: 'session-1', transcript_path: '/transcripts/session-1.jsonl', cwd: '/session-cwd',
    scratchpad_dir: '/scratch', prompt_id: 'prompt-1', agent_type: 'main', columns: 90,
    tasks: [{ id: 'a', name: 'agent-a', type: 'local_agent', agentType: 'Explore',
      status: 'running', description: 'task a', label: 'doing a', startTime: 1000,
      model: 'claude-opus-5-5', effort: 'high', contextWindowSize: 1000000,
      tokenCount: 1234, tokenSamples: [1234], cwd: '/worktree' }],
  })
})

test('skips an already-busy debounce, drops stale results and uses the next periodic refresh', async ($, on) => {
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
  await h.clock.advance(700)
  expect(h.calls.map(call => call.at)).toEqual([300, 1300])
  expect(JSON.parse(h.calls[1]!.init.stdin).tasks).toHaveLength(2)
  expect(await textOf(ui)).toBe('fresh')
})

test('retained completed rows keep refreshing; eviction stops the timer', async ($, on) => {
  const h = engine(on)
  const ui = await $.ui.mount(row())
  await h.clock.advance(300)
  h.agents = [agent('a', { status: 'completed', taskStatus: 'completed' })]
  await ui.redraw(row('a', h.agents[0]).props)
  await h.clock.advance(1700)
  expect(h.calls.map(call => call.at)).toEqual([300, 1000, 2000])
  expect(JSON.parse(h.calls[2]!.init.stdin).tasks[0].status).toBe('completed')
  h.agents = []
  await h.clock.advance(15000)
  expect(h.calls).toHaveLength(3)
  expect(await textOf(ui)).toBe('engine columns')
})

test('empty and unset legacy commands never start a duplicate runner', { options: { command: '' } }, async ($, on) => {
  const h = engine(on)
  h.user = { subagentStatusLine: { type: 'command', command: '' } }
  const ui = await $.ui.mount(row())
  await h.clock.advance(300)
  expect(h.calls).toHaveLength(0)
  h.user = {}
  await ui.redraw()
  await h.clock.advance(10000)
  expect(h.calls).toHaveLength(0)
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

test('status-line disableAllHooks gate is policy-only, not user settings', async ($, on) => {
  const h = engine(on)
  h.user.disableAllHooks = true
  await $.ui.mount(row())
  await h.clock.advance(300)
  expect(h.calls).toHaveLength(1)
})

test('policy command overrides the mod option and is delegated to the host', { options: { command: 'own' } }, async ($, on) => {
  const h = engine(on)
  h.policy = { subagentStatusLine: { type: 'command', command: 'policy' } }
  await $.ui.mount(row())
  await h.clock.advance(300)
  expect(h.calls).toHaveLength(0)
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

test('samples actual refreshes, not unrelated host reads; keeps the latest 16', async ($, on) => {
  const h = engine(on)
  const ui = await $.ui.mount(row())
  await h.clock.advance(300)
  for (let i = 1; i <= 18; i++) {
    h.agents[0]!.tokenCount = i
    h.agents[0]!.tokenSamples = [99999]
    await ui.redraw()
    await h.clock.advance(i === 1 ? 700 : 1000)
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
    await h.clock.advance(700)
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

for (const reason of ['clear', 'resume'] as const) {
  test(`${reason} restarts under a new session id without another session.start`, async ($, on) => {
    const h = engine(on)
    const ui = await $.ui.mount(row())
    await h.clock.advance(300)
    await $.session.end({ reason, sessionId: 'session-1', resume: { id: 'session-1' } })
    await h.clock.advance(300)
    expect(h.calls).toHaveLength(1)
    h.sessionId = 'session-2'
    h.answer = () => output('new session')
    await h.clock.advance(600)
    expect(h.calls).toHaveLength(2)
    expect(JSON.parse(h.calls[1]!.init.stdin).session_id).toBe('session-2')
    expect(JSON.parse(h.calls[1]!.init.stdin).tasks[0].tokenSamples).toEqual([1234])
    expect(await textOf(ui)).toBe('new session')
  })
}

test('legacy execution is delegated before any native body and while another row first appears', { options: { command: '' } }, async ($, on) => {
  const h = engine(on)
  const a = await $.ui.mount(row())
  await h.clock.advance(10000)
  expect(h.calls).toHaveLength(0)
  await a.redraw(row('a', { body: 'host output' }).props)
  h.agents.push(agent('b'))
  const b = await $.ui.mount(row('b'))
  await h.clock.advance(10000)
  expect(await textOf(a)).toBe('host output')
  expect(await textOf(b)).toBe('engine columns')
  expect(h.calls).toHaveLength(0)
})

test('managed command ownership wins over an explicit mod option before the native body arrives', async ($, on) => {
  const h = engine(on)
  h.policy.subagentStatusLine = { type: 'command', command: 'managed' }
  const ui = await $.ui.mount(row())
  await h.clock.advance(10000)
  expect(h.calls).toHaveLength(0)
  await ui.redraw(row('a', { body: 'managed output' }).props)
  expect(await textOf(ui)).toBe('managed output')
})

test('a disabled mounted row subscribes and shows newly enabled output without a manual redraw', {
  options: { command: 'fixture-command' },
  plugins: [{ name: 'settings-refresh-fixture', register(on) {
    on('session.stop', async ($, e, next) => {
      await $.settings.read()
      return next(e)
    })
  } }],
}, async ($, on) => {
  const h = engine(on)
  on('session.stop', (_, e) => ({ isTurnRunning: e.isTurnRunning }))
  h.policy.disableAllHooks = true
  const ui = await $.ui.mount(row())
  expect(await textOf(ui)).toBe('engine columns')
  h.policy = {}
  await $.session.stop({ isTurnRunning: false })
  await h.clock.advance(300)
  expect(await textOf(ui)).toBe('decorated')
})

test('session start and a later turn discover rows without any UI mount', async ($, on) => {
  const h = engine(on)
  await $.session.start({ cwd: '/session-cwd', surface: 'terminal', isInteractive: true })
  await h.clock.advance(300)
  expect(h.calls).toHaveLength(1)
  h.agents = []
  await h.clock.advance(700)
  h.agents = [agent('b')]
  await $.turn.start({ text: '', turnId: 'turn-2', agentId: 'b' })
  await h.clock.advance(300)
  expect(h.calls).toHaveLength(2)
  expect(JSON.parse(h.calls[1]!.init.stdin).tasks[0].id).toBe('b')
})

test('desktop/vscode redraws use one stable measured root even when the first root has no width', async ($, on) => {
  const h = engine(on)
  h.agents.push(agent('b'))
  const desktop = await $.ui.mount(row('b', { columns: 81 }, 'desktop'))
  const vscode = await $.ui.mount(row('b', { columns: 55 }, 'vscode'))
  for (let i = 0; i < 100; i++) {
    await desktop.redraw()
    await vscode.redraw()
    await h.clock.advance(100)
  }
  expect(h.calls.map(call => call.at)).toEqual([300, ...Array.from({ length: 10 }, (_, n) => (n + 1) * 1000)])
  expect(h.calls.map(call => JSON.parse(call.init.stdin).columns)).toEqual(Array(11).fill(81))
})

for (const boundary of ['read', 'set'] as const) {
  test(`clear invalidates a publication paused inside state.${boundary}`, async ($, on) => {
    const h = engine(on)
    const pending = deferred<void>()
    let armed = false
    if (boundary === 'read') on('state.get', { plugin: 'subagent-statusline', key: 'decorations' }, async (_, e, next) => {
      const result = await next(e)
      if (armed) { armed = false; await pending.promise }
      return result
    })
    else on('state.set', { plugin: 'subagent-statusline', key: 'decorations' }, async (_, e, next) => {
      if (armed && e.value.a === 'stale') { armed = false; await pending.promise }
      return next(e)
    })
    h.answer = () => { armed = true; return output('stale') }
    const ui = await $.ui.mount(row())
    await h.clock.advance(300)
    await $.session.end({ reason: 'clear', sessionId: 'session-1', resume: { id: 'session-1' } })
    h.sessionId = 'session-2'
    pending.resolve()
    await h.clock.settle()
    expect(await textOf(ui)).toBe('engine columns')
    h.answer = () => output('fresh')
    await h.clock.advance(5000)
    expect(await textOf(ui)).toBe('fresh')
  })
}

test('clear and resume keep the measured width, including a row drawn before the new id', async ($, on) => {
  const h = engine(on)
  const ui = await $.ui.mount(row('a', { columns: 72 }))
  await h.clock.advance(300)
  await $.session.end({ reason: 'clear', sessionId: 'session-1', resume: { id: 'session-1' } })
  h.sessionId = 'session-2'
  await h.clock.advance(600)
  expect(h.calls).toHaveLength(2)
  expect(JSON.parse(h.calls[1]!.init.stdin).columns).toBe(72)
  await $.session.end({ reason: 'resume', sessionId: 'session-2', resume: { id: 'session-2' } })
  await ui.redraw(row('a', { columns: 64 }).props)
  h.sessionId = 'session-3'
  await h.clock.advance(600)
  expect(h.calls).toHaveLength(3)
  expect(JSON.parse(h.calls[2]!.init.stdin).columns).toBe(64)
})

test('a clear while a tick reads settings does not start the old command', async ($, on) => {
  const h = engine(on)
  await $.ui.mount(row())
  await h.clock.advance(300)
  expect(h.calls).toHaveLength(1)
  const pending = deferred<void>()
  h.policyGate = pending.promise
  await h.clock.advance(700) // The periodic tick waits in its policy read.
  await $.session.end({ reason: 'clear', sessionId: 'session-1', resume: { id: 'session-1' } })
  h.sessionId = 'session-2'
  pending.resolve()
  await h.clock.settle()
  expect(h.calls).toHaveLength(1)
  await h.clock.advance(600)
  expect(h.calls).toHaveLength(2)
  expect(JSON.parse(h.calls[1]!.init.stdin).session_id).toBe('session-2')
})

test('a delayed clear does not erase output published after the command is enabled again', async ($, on) => {
  const h = engine(on)
  const stall = deferred<void>()
  let armed = false
  on('state.set', { plugin: 'subagent-statusline', key: 'decorations' }, async (_, e, next) => {
    if (armed && Object.keys(e.value).length === 0) { armed = false; await stall.promise }
    return next(e)
  })
  const ui = await $.ui.mount(row())
  await h.clock.advance(300)
  expect(await textOf(ui)).toBe('decorated')
  armed = true
  h.policy.disableAllHooks = true
  await ui.redraw() // The clear runs from a timer and stalls inside state.set.
  await h.clock.settle()
  h.policy = {}
  h.answer = () => output('fresh')
  await ui.redraw()
  await h.clock.advance(300)
  expect(await textOf(ui)).toBe('fresh')
  stall.resolve()
  await h.clock.settle()
  expect(await textOf(ui)).toBe('fresh')
})

test('a resume that keeps the same session id resumes without a new turn, with bounded polling', async ($, on) => {
  const h = engine(on)
  const ui = await $.ui.mount(row())
  await h.clock.advance(300)
  await $.session.end({ reason: 'resume', sessionId: 'session-1', resume: { id: 'session-1' } })
  await h.clock.advance(300)
  expect(h.calls).toHaveLength(1)
  h.answer = () => output('resumed')
  await h.clock.advance(4000)
  expect(h.calls.length).toBeGreaterThan(1)
  expect(await textOf(ui)).toBe('resumed')
  expect(h.idReads).toBeLessThan(20)
})

test('a subagent turn while /clear is still ending does not restart the command', async ($, on) => {
  const h = engine(on)
  const stall = deferred<void>()
  let armed = false
  on('state.set', { plugin: 'subagent-statusline', key: 'decorations' }, async (_, e, next) => {
    if (armed && Object.keys(e.value).length === 0) { armed = false; await stall.promise }
    return next(e)
  })
  await $.ui.mount(row())
  await h.clock.advance(300)
  armed = true
  const ending = $.session.end({ reason: 'clear', sessionId: 'session-1', resume: { id: 'session-1' } })
  await h.clock.settle()
  await $.turn.start({ text: '', turnId: 'turn-child', agentId: 'a' })
  await h.clock.advance(2000)
  expect(h.calls).toHaveLength(1)
  stall.resolve()
  await ending
  h.sessionId = 'session-2'
  await h.clock.advance(600)
  expect(h.calls).toHaveLength(2)
  expect(JSON.parse(h.calls[1]!.init.stdin).session_id).toBe('session-2')
})

test('a delayed clear does not erase identical output published after re-enabling', async ($, on) => {
  const h = engine(on)
  const stall = deferred<void>()
  let armed = false
  on('state.set', { plugin: 'subagent-statusline', key: 'decorations' }, async (_, e, next) => {
    if (armed && Object.keys(e.value).length === 0) { armed = false; await stall.promise }
    return next(e)
  })
  const ui = await $.ui.mount(row())
  await h.clock.advance(300)
  armed = true
  h.policy.disableAllHooks = true
  await ui.redraw()
  await h.clock.settle()
  h.policy = {}
  await ui.redraw()
  await h.clock.advance(300)
  stall.resolve()
  await h.clock.settle()
  expect(await textOf(ui)).toBe('decorated')
})

test('a delayed clear landing during a publication does not win', async ($, on) => {
  const h = engine(on)
  const clearStall = deferred<void>()
  const publishStall = deferred<void>()
  let clearArmed = false
  let publishArmed = false
  on('state.set', { plugin: 'subagent-statusline', key: 'decorations' }, async (_, e, next) => {
    if (clearArmed && Object.keys(e.value).length === 0) { clearArmed = false; await clearStall.promise }
    else if (publishArmed && e.value.a === 'fresh') { publishArmed = false; await publishStall.promise }
    return next(e)
  })
  const ui = await $.ui.mount(row())
  await h.clock.advance(300)
  clearArmed = true
  h.policy.disableAllHooks = true
  await ui.redraw()
  await h.clock.settle()
  h.policy = {}
  h.answer = () => output('fresh')
  publishArmed = true
  await ui.redraw()
  await h.clock.advance(300)
  clearStall.resolve()
  await h.clock.settle()
  publishStall.resolve()
  await h.clock.settle()
  expect(await textOf(ui)).toBe('fresh')
})

test('without a command, row draws read no state', { options: { command: '' } }, async ($, on) => {
  engine(on)
  let reads = 0
  on('state.get', { plugin: 'subagent-statusline', key: 'decorations' }, (_, e, next) => { reads++; return next(e) })
  const ui = await $.ui.mount(row())
  const before = reads
  for (let i = 0; i < 50; i++) await ui.redraw()
  expect(reads - before).toBe(0)
  expect(await textOf(ui)).toBe('engine columns')
})
