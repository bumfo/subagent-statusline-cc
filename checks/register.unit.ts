import { describe, expect, test } from 'bun:test'
import { agent, deferred, flush, host, output, row, type Result } from './host'

describe('command input and execution', () => {
  test('exact complete input, body width, shell, cwd, timeout and hook environment', async () => {
    const h = host()
    h.agents.push(agent('b', {
      name: undefined, model: undefined, effort: undefined, tokenCount: undefined,
      cwd: undefined, label: '', taskStatus: 'completed',
    }))
    await h.start()
    await h.clock.advance(300)
    expect(h.input()).toEqual({
      session_id: 'session-1', transcript_path: '/transcripts/session.jsonl', cwd: '/session-cwd',
      scratchpad_dir: '/scratch', prompt_id: 'prompt-1', agent_type: 'main', columns: 90,
      tasks: [{
        id: 'a', name: 'agent-a', type: 'local_agent', agentType: 'Explore', status: 'running',
        description: 'task a', label: 'doing a', startTime: 1000, model: 'claude-opus-5-5',
        effort: 'high', contextWindowSize: 1000000, tokenCount: 1234, tokenSamples: [1234], cwd: '/worktree',
      }, {
        id: 'b', type: 'local_agent', agentType: 'Explore', status: 'completed',
        description: 'task b', label: 'task b', startTime: 1000, tokenCount: 0, tokenSamples: [0], cwd: '/session-cwd',
      }],
    })
    expect(h.calls[0]).toEqual({ at: 300, argv: ['/bin/sh', '-c', 'fixture-command'], init: {
      cwd: '/config-root', timeoutMs: 5000, stdin: JSON.stringify(h.input()), env: {
        CLAUDE_PROJECT_DIR: '/project', CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: 'session-1',
        CLAUDE_PLUGIN_ROOT: '/plugin', CLAUDE_PLUGIN_DATA: '/plugin-data',
      },
    } })
    expect(h.env.CLAUDE_PLUGIN_ROOT).toBe('/plugin') // Never mutate the host environment.
  })

  test('optional session fields are omitted and command cwd falls back', async () => {
    const h = host()
    h.info = { transcriptPath: '' }
    await h.start()
    await h.clock.advance(300)
    expect(Object.keys(h.input())).toEqual(['session_id', 'transcript_path', 'cwd', 'columns', 'tasks'])
    expect(h.calls[0]!.init.cwd).toBe('/session-cwd')
  })

  test('only host-eligible local subagents participate, including completed rows', async () => {
    const h = host()
    h.agents = [agent('done', { taskStatus: 'completed' }), agent('hidden', { hasRow: false }),
      agent('main', { type: 'main-session' }), agent('team', { kind: 'in_process_teammate' })]
    await h.start()
    await h.clock.advance(300)
    expect(h.input().tasks.map((task: { id: string }) => task.id)).toEqual(['done'])
  })

  test('raw own command and plugin ownership are preserved', async () => {
    const h = host({ command: '  echo "${CLAUDE_PLUGIN_ROOT}"  ' })
    await h.start()
    await h.clock.advance(300)
    expect(h.calls[0]!.argv[2]).toBe('  echo "${CLAUDE_PLUGIN_ROOT}"  ')
    expect(h.calls[0]!.init.env).toEqual(h.env)
    expect(h.settingsReads.every(source => source === 'policy')).toBe(true)
  })

  test.each(['${CLAUDE_PLUGIN_ROOT}', '${CLAUDE_PLUGIN_DATA}', '$CLAUDE_PLUGIN_ROOT', '$CLAUDE_PLUGIN_DATA'])('legacy %s belongs to the host, not a second runner', async variable => {
    const h = host({ command: '' })
    h.user.subagentStatusLine = { type: 'command', command: `echo "${variable}"` }
    await h.start()
    await h.clock.advance(10000)
    expect(h.calls).toHaveLength(0)
  })

  test.each([undefined, null, {}, { type: 'prompt', command: 'no' }, { type: 'command', command: 42 }])(
    'missing or invalid legacy config never spawns: %j', async config => {
      const h = host({ command: '' })
      h.user.subagentStatusLine = config
      await h.start()
      await h.clock.advance(5000)
      expect(h.calls).toHaveLength(0)
    },
  )

  test('empty legacy command remains host-owned', async () => {
    const h = host({ command: ' ' })
    h.user.subagentStatusLine = { type: 'command', command: '' }
    await h.start()
    await h.clock.advance(300)
    expect(h.calls).toHaveLength(0)
  })

  test('policy overrides options and user settings; project settings are never read', async () => {
    const h = host({ command: 'own' })
    h.policy = { allowManagedHooksOnly: true, subagentStatusLine: { type: 'command', command: 'policy-command' } }
    await h.start()
    await h.clock.advance(300)
    expect(h.calls).toHaveLength(0)
    expect(h.settingsReads.every(source => source === 'policy')).toBe(true)
  })

  test.each([{ disableAllHooks: true }, { allowManagedHooksOnly: true }])('policy disables non-managed command: %j', async policy => {
    const h = host({ command: 'own' })
    h.policy = policy
    await h.start()
    await h.clock.advance(5000)
    expect(h.calls).toHaveLength(0)
  })
})

describe('native refresh lifecycle', () => {
  test('initial 300 ms debounce and anchored 5 s interval; shared across row draws', async () => {
    const h = host()
    h.agents.push(agent('b'))
    await h.event('session.start')
    const reads = h.listReads
    await Promise.all([h.draw(row()), h.draw(row('b'))])
    expect(h.listReads - reads).toBe(1)
    await h.clock.advance(299)
    expect(h.calls).toHaveLength(0)
    await h.clock.advance(1)
    expect(h.calls.map(call => call.at)).toEqual([300])
    await h.clock.advance(4699)
    expect(h.calls).toHaveLength(1)
    await h.clock.advance(1)
    expect(h.calls.map(call => call.at)).toEqual([300, 5000])
    await h.clock.advance(5000)
    expect(h.calls.map(call => call.at)).toEqual([300, 5000, 10000])
  })

  test('completion and same-count identity changes do not reset timer; retained rows still refresh', async () => {
    const h = host()
    await h.start()
    await h.clock.advance(300)
    h.agents = [agent('b', { taskStatus: 'completed' })]
    await h.draw(row('b'))
    await h.clock.advance(300)
    expect(h.calls).toHaveLength(1)
    await h.clock.advance(9400)
    expect(h.calls.map(call => call.at)).toEqual([300, 5000, 10000])
    expect(h.input().tasks[0].tokenSamples).toEqual([1234, 1234])
    expect(h.input().tasks[0].status).toBe('completed')
  })

  test('count and width changes restart both timers; narrow width clamps at zero', async () => {
    const h = host()
    await h.start()
    await h.clock.advance(200)
    h.agents.push(agent('b'))
    await h.draw()
    await h.clock.advance(200)
    await h.draw(row('a', { columns: -4 }))
    await h.clock.advance(299)
    expect(h.calls).toHaveLength(0)
    await h.clock.advance(1)
    expect(h.calls[0]!.at).toBe(700)
    expect(h.input().columns).toBe(0)
    await h.clock.advance(4700)
    expect(h.calls.map(call => call.at)).toEqual([700, 5400])
  })

  test('collects at most 16 samples on actual runs, not host reads', async () => {
    const h = host()
    await h.start()
    await h.clock.advance(300)
    for (let i = 1; i <= 18; i++) {
      h.agents[0]!.tokenCount = i
      await h.draw()
      await h.clock.advance(i === 1 ? 4700 : 5000)
    }
    expect(h.input().tasks[0].tokenSamples).toEqual(Array.from({ length: 16 }, (_, i) => i + 3))
  })

  test('removal clears history, decorations and timers, then reappearance starts fresh', async () => {
    const h = host()
    await h.start()
    await h.clock.advance(300)
    h.agents = []
    await h.clock.advance(4700) // No draw for the last removed row.
    expect(h.decorations).toEqual({})
    expect(h.clock.timers.size).toBe(0)
    h.agents = [agent()]
    await h.draw()
    await h.clock.advance(300)
    expect(h.input().tasks[0].tokenSamples).toEqual([1234])
  })

  test('no timer or process is created for zero eligible rows', async () => {
    const h = host()
    h.agents = []
    await h.start()
    await h.clock.advance(60000)
    expect(h.clock.timers.size).toBe(0)
    expect(h.calls).toHaveLength(0)
  })

  test('disabling config stops timers, re-enabling keeps existing sample history', async () => {
    const h = host()
    await h.start()
    await h.clock.advance(300)
    h.policy.disableAllHooks = true
    await h.draw()
    expect(h.forwarded.at(-1)!.props).not.toHaveProperty('body')
    await h.clock.advance(0)
    expect(h.clock.timers.size).toBe(0)
    expect(h.decorations).toEqual({})
    h.policy = {}
    await h.draw()
    await h.clock.advance(300)
    expect(h.calls[1]!.argv[2]).toBe('fixture-command')
    expect(h.input().tasks[0].tokenSamples).toEqual([1234, 1234])
  })

  test('no command means no idle polling, even with eligible rows', async () => {
    const h = host({ command: '' })
    h.user = {}
    await h.start()
    await h.clock.advance(60000)
    expect(h.clock.timers.size).toBe(0)
    expect(h.calls).toHaveLength(0)
  })

  test('periodic refresh rechecks policy without an unrelated draw', async () => {
    const h = host()
    await h.start()
    await h.clock.advance(300)
    h.user.subagentStatusLine = { type: 'command', command: 'does-not-override-own' }
    await h.draw()
    await h.clock.advance(300)
    expect(h.calls).toHaveLength(1)
    await h.clock.advance(4400)
    expect(h.calls[1]!.argv[2]).toBe('fixture-command')
    h.policy.disableAllHooks = true
    await h.clock.advance(5000)
    expect(h.calls).toHaveLength(2)
    expect(h.clock.timers.size).toBe(0)
    expect(h.decorations).toEqual({})
  })

  test('overlapping timer firings skip samples and never overlap commands', async () => {
    const h = host()
    const pending = deferred<Result>()
    h.answer = () => pending.promise
    await h.start()
    await h.clock.advance(15000)
    expect(h.calls).toHaveLength(1)
    pending.resolve(output())
    await flush()
    h.answer = () => output()
    await h.clock.advance(5000)
    expect(h.calls).toHaveLength(2)
    expect(h.input().tasks[0].tokenSamples).toEqual([1234, 1234])
  })

  test('resize discards an in-flight result and later refresh uses the new width', async () => {
    const h = host()
    const pending = deferred<Result>()
    h.answer = () => pending.promise
    await h.start()
    await h.clock.advance(300)
    await h.draw(row('a', { columns: 40 }))
    pending.resolve(output('stale'))
    await flush()
    expect(h.decorations).toEqual({})
    h.answer = () => output('fresh')
    await h.clock.advance(300)
    expect(h.decorations).toEqual({ a: 'fresh' })
    expect(h.input().columns).toBe(40)
  })

  test('session end cancels timers and prevents stale publication or redraw restart', async () => {
    const h = host()
    const pending = deferred<Result>()
    h.answer = () => pending.promise
    await h.start()
    await h.clock.advance(300)
    await h.event('session.end')
    pending.resolve(output('stale'))
    await flush()
    await h.draw()
    await h.clock.advance(60000)
    expect(h.decorations).toEqual({})
    expect(h.clock.timers.size).toBe(0)
    expect(h.calls).toHaveLength(1)
  })

  test('rows removed during a command clear immediately when it settles', async () => {
    const h = host()
    const pending = deferred<Result>()
    h.answer = () => pending.promise
    await h.start()
    await h.clock.advance(300)
    h.agents = []
    pending.resolve(output('gone'))
    await flush()
    expect(h.decorations).toEqual({})
    expect(h.clock.timers.size).toBe(0)
  })

  test('mid-session load works and separate registrations never share state', async () => {
    const a = host({ command: 'first' })
    const b = host({ command: 'second' })
    b.answer = () => output('second')
    await a.draw()
    await b.start()
    await a.clock.advance(300)
    await b.clock.advance(300)
    expect(a.calls[0]!.argv[2]).toBe('first')
    expect(b.calls[0]!.argv[2]).toBe('second')
    expect(a.decorations).toEqual({ a: 'decorated' })
    expect(b.decorations).toEqual({ a: 'second' })
  })

  test.each([1000, 10000])('obsolete saved refresh interval %s does not change the native command timer', async refreshMs => {
    const h = host({ refreshMs })
    await h.start()
    await h.clock.advance(5000)
    expect(h.calls.map(call => call.at)).toEqual([300, 5000])
  })

  test('the installation form offers the command but no timer setting', async () => {
    const manifest = await Bun.file(new URL('../.claude-plugin/plugin.json', import.meta.url)).json()
    expect(Object.keys(manifest.userConfig)).toEqual(['command'])
  })
})

describe('AgentRow output delegation', () => {
  test.each(['default', 'fullscreen', 'focus'])('preserves the shared renderer and interaction metadata in %s mode', async mode => {
    const h = host()
    await h.start()
    await h.clock.advance(300)
    const event = row('a', { presentation: mode, isSelected: true, isHovered: true, color: 'cyan' })
    expect(await h.draw(event)).toBe(h.coreNode)
    expect(h.forwarded.at(-1)).toEqual({ ...event, props: { ...event.props, body: 'decorated', isHidden: false } })
  })

  test('JSONL preserves ANSI, whitespace and last duplicate, ignoring unrelated/malformed rows', async () => {
    const h = host()
    const body = '  \x1b[31mred\x1b[0m \x1b]8;;https://example.invalid\x07link\x1b]8;;\x07\nnext  '
    h.answer = () => ({ exitCode: 0, stderr: '', stdout: [
      output('old').stdout, 'not json', 'null', '[]', '{"id":"a"}', '{"id":"a","content":42}',
      output('unknown', 'missing').stdout, output(body).stdout, '',
    ].join('\n') })
    await h.start()
    await h.clock.advance(300)
    expect(h.decorations).toEqual({ a: body })
    const event = row('a', { selection: { isSelected: true }, futureProp: { untouched: true } })
    expect(await h.draw(event)).toBe(h.coreNode)
    expect(h.forwarded.at(-1)).toEqual({ ...event, props: { ...event.props, body, isHidden: false } })
    expect(h.forwarded.at(-1)!.props.rowIds).toBe(event.props.rowIds)
    expect(h.forwarded.at(-1)!.requestId).toBe('render-a') // Lookup uses props.id instead.
    expect(event.props).not.toHaveProperty('body')
  })

  test('empty content hides the whole row but remains eligible for subsequent restoration', async () => {
    const h = host()
    h.answer = () => output('')
    await h.start()
    await h.clock.advance(300)
    await h.draw()
    expect(h.forwarded.at(-1)!.props).toMatchObject({ isHidden: true, body: undefined })
    h.answer = () => output('restored')
    await h.clock.advance(4700)
    await h.draw()
    expect(h.forwarded.at(-1)!.props).toMatchObject({ isHidden: false, body: 'restored' })
  })

  test('missing output returns the original event and host node unchanged', async () => {
    const h = host()
    h.answer = () => output('unknown', 'unknown')
    await h.start()
    await h.clock.advance(300)
    const event = row()
    expect(await h.draw(event)).toBe(h.coreNode)
    expect(h.forwarded.at(-1)).toBe(event)
  })

  test.each(['nonzero', 'spawn', 'timeout'])('%s failure clears old decoration and restores default columns', async failure => {
    const h = host()
    await h.start()
    await h.clock.advance(300)
    h.answer = () => {
      if (failure !== 'nonzero') throw new Error(failure)
      return { exitCode: 7, stderr: 'failure', stdout: output('must not show').stdout }
    }
    await h.clock.advance(4700)
    const event = row()
    await h.draw(event)
    expect(h.decorations).toEqual({})
    expect(h.forwarded.at(-1)).toBe(event)
  })

  test('unexpected host read failure preserves the last successful decoration', async () => {
    const h = host()
    await h.start()
    await h.clock.advance(300)
    h.settingsError = new Error('host unavailable')
    await h.clock.advance(4700)
    expect(h.decorations).toEqual({ a: 'decorated' })
    h.listError = new Error('list unavailable')
    await h.draw()
    expect(h.forwarded.at(-1)!.props).toHaveProperty('body', 'decorated')
  })

  test.each([{ body: 'native' }, { isHidden: true }])('native ownership prevents duplicate execution: %j', async props => {
    const h = host({ command: '' })
    await h.start()
    const event = row('a', props)
    await h.draw(event)
    await h.clock.advance(10000)
    expect(h.calls).toHaveLength(0)
    expect(h.clock.timers.size).toBe(0)
    expect(h.forwarded.at(-1)).toBe(event)
  })

  test('explicit command may replace a native body or restore a native-hidden row', async () => {
    const h = host({ command: 'own' })
    const event = row('a', { isHidden: true, body: 'native' })
    await h.draw(event)
    await h.clock.advance(300)
    await h.draw(event)
    expect(h.forwarded.at(-1)!.props).toMatchObject({ isHidden: false, body: 'decorated' })
  })

  test('unchanged output does not publish redundant UI state', async () => {
    const h = host()
    await h.start()
    await h.clock.advance(10000)
    expect(h.calls).toHaveLength(3)
    expect(h.writes).toBe(2) // Forced session reset, then one changed output.
  })

  test('nonterminal surfaces use the same command and host row', async () => {
    const h = host()
    const event = { ...row(), surface: 'desktop' }
    await h.draw(event)
    await h.clock.advance(300)
    await h.draw(event)
    expect(h.calls).toHaveLength(1)
    expect(h.forwarded.at(-1)!.props.body).toBe('decorated')
    expect(h.writes).toBe(1)
  })

  test('native takeover after publication clears outside drawing and recovers', async () => {
    const h = host()
    await h.start()
    await h.clock.advance(300)
    h.policy.subagentStatusLine = { type: 'command', command: 'managed' }
    await h.draw(row('a', { body: 'native' }))
    await h.clock.advance(0)
    expect(h.decorations).toEqual({})
    await h.draw(row('a', { body: 'native' }))
    expect(h.logs).toEqual([])
    h.policy = {}
    await h.draw(row())
    await h.clock.advance(300)
    expect(h.decorations).toEqual({ a: 'decorated' })
  })

  test('mixed widths do not restart the shared clock on every draw', async () => {
    const h = host()
    h.agents.push(agent('b', { parentId: 'a' }))
    await h.start()
    for (let i = 0; i < 100; i++) {
      await h.draw(row('a', { columns: 90 }))
      await h.draw(row('b', { columns: 50 }))
      await h.clock.advance(100)
    }
    expect(h.calls.map(call => call.at)).toEqual([300, 5000, 10000])
    expect(h.calls.map(call => JSON.parse(call.init.stdin).columns)).toEqual([90, 90, 90])
  })

  test('one other-mod hidden row cannot latch off the whole session', async () => {
    const h = host()
    h.agents.push(agent('b'))
    await h.start()
    await h.draw(row('b', { isHidden: true }))
    await h.clock.advance(300)
    expect(h.calls).toHaveLength(1)
    await h.draw(row('b', { isHidden: false }))
    await h.clock.advance(4700)
    expect(h.calls).toHaveLength(2)
  })
})

describe('reviewed lifecycle boundaries', () => {
  test.each(['clear', 'resume'])('%s recovers under the new session id without session.start or a draw', async reason => {
    const h = host()
    await h.start()
    await h.clock.advance(300)
    await h.event('session.end', { reason })
    await h.clock.advance(300)
    expect(h.calls).toHaveLength(1) // Never restart in the ending session.
    h.sessionId = 'session-2'
    h.agents = [agent('b')]
    h.answer = () => output('new session', 'b')
    await h.clock.advance(600)
    expect(h.calls).toHaveLength(2)
    expect(h.input().session_id).toBe('session-2')
    expect(h.input().tasks[0].tokenSamples).toEqual([1234])
    expect(h.decorations).toEqual({ b: 'new session' })
  })

  test('legacy command is never duplicated before its first native body arrives', async () => {
    const h = host({ command: '' })
    await h.start()
    await h.clock.advance(10000)
    expect(h.calls).toHaveLength(0)
    await h.draw(row('a', { body: 'host output' }))
    h.agents.push(agent('b'))
    await h.draw(row('b'))
    await h.clock.advance(10000)
    expect(h.calls).toHaveLength(0)
  })

  test('disabled rows still subscribe; a settings event restarts refresh without a draw', async () => {
    const h = host()
    h.policy.disableAllHooks = true
    await h.start()
    expect(h.stateReads).toBeGreaterThan(1)
    h.policy = {}
    await h.event('settings.read')
    await h.clock.advance(300)
    expect(h.decorations).toEqual({ a: 'decorated' })
  })

  test('session start discovers existing rows without a draw', async () => {
    const h = host()
    await h.event('session.start')
    await h.clock.advance(300)
    expect(h.calls).toHaveLength(1)
  })

  test('a turn discovers newly appearing rows without a draw', async () => {
    const h = host()
    h.agents = []
    await h.event('session.start')
    h.agents = [agent()]
    await h.event('turn.start')
    await h.clock.advance(300)
    expect(h.calls).toHaveLength(1)
  })

  test('desktop and vscode widths cannot flap the debounce; measured roots beat missing widths', async () => {
    const h = host()
    h.agents.push(agent('b'))
    await h.event('session.start')
    for (let i = 0; i < 100; i++) {
      await h.draw({ ...row('b', { columns: 81 }), surface: 'desktop' })
      await h.draw({ ...row('b', { columns: 55 }), surface: 'vscode' })
      await h.clock.advance(100)
    }
    expect(h.calls.map(call => call.at)).toEqual([300, 5000, 10000])
    expect(h.calls.map(call => JSON.parse(call.init.stdin).columns)).toEqual([81, 81, 81])
    await h.event('session.detach', { surface: 'desktop' })
    await h.clock.advance(300)
    expect(h.input().columns).toBe(55)
  })

  test.each(['read', 'set'])('clear rejects stale output delayed inside state.%s', async boundary => {
    const h = host()
    const pending = deferred<void>()
    await h.start()
    if (boundary === 'read') h.beforeRead = async () => { h.beforeRead = undefined; await pending.promise }
    else h.beforeSet = async value => { if (value.a) { h.beforeSet = undefined; await pending.promise } }
    await h.clock.advance(300)
    await h.event('session.end', { reason: 'clear' })
    h.sessionId = 'session-2'
    pending.resolve()
    await flush()
    expect(h.decorations).toEqual({})
    h.answer = () => output('fresh')
    await h.clock.advance(300)
    expect(h.decorations).toEqual({ a: 'fresh' })
    expect(h.input().tasks[0].tokenSamples).toEqual([1234])
  })

  test('a clear retries when an already-dispatched publication wins its CAS', async () => {
    const h = host()
    const publish = deferred<void>()
    const clearRead = deferred<void>()
    await h.start()
    h.beforeSet = async value => { if (value.a) { h.beforeSet = undefined; await publish.promise } }
    await h.clock.advance(300)
    h.beforeRead = async () => { h.beforeRead = undefined; await clearRead.promise }
    const clearing = h.event('session.end', { reason: 'clear' })
    await flush()
    publish.resolve()
    await flush()
    clearRead.resolve()
    await clearing
    expect(h.decorations).toEqual({})
  })
})

describe('merge-review fixes', () => {
  test('a width measured while a tick restarts the timers is applied', async () => {
    const h = host()
    await h.start()
    await h.clock.advance(300)
    expect(h.input().columns).toBe(90)
    const gate = deferred<void>()
    h.beforeSettings = async () => { h.beforeSettings = undefined; await gate.promise }
    const drawing = h.draw(row('a', { columns: 40 }))
    await flush()
    h.agents.push(agent('b'))
    await h.clock.advance(4700) // The periodic tick sees two rows and restarts the timers.
    gate.resolve()
    await drawing
    await h.clock.advance(300)
    expect(h.calls.map(call => call.at)).toEqual([300, 5300])
    expect(h.input().columns).toBe(40)
  })

  test('a non-finite width is ignored instead of restarting the timers on every draw', async () => {
    const h = host()
    await h.event('session.start')
    for (let i = 0; i < 20; i++) {
      await h.draw(row('a', { columns: Number.NaN }))
      await h.clock.advance(100)
    }
    expect(h.calls.map(call => call.at)).toEqual([300])
  })

  test('clear keeps the last measured width for the new session', async () => {
    const h = host()
    await h.start()
    await h.clock.advance(300)
    await h.event('session.end', { reason: 'clear' })
    await h.draw(row('a', { columns: 64 })) // Drawn before the new session id is visible.
    h.sessionId = 'session-2'
    await h.clock.advance(600)
    expect(h.calls).toHaveLength(2)
    expect(h.input().columns).toBe(64)
  })

  test('a clear lands even if another writer moves the version before every write', async () => {
    const h = host()
    await h.start()
    await h.clock.advance(300)
    expect(h.decorations).toEqual({ a: 'decorated' })
    h.beforeSet = async () => { h.version++ }
    await h.event('session.end', { reason: 'clear' })
    expect(h.decorations).toEqual({})
  }, 1000)

  test('without its own command the mod reads no agents or settings', async () => {
    const h = host({ command: '' })
    await h.start()
    await h.draw(row('a', { body: 'host output' }))
    await h.event('turn.start')
    await h.event('settings.read')
    await h.clock.advance(10000)
    expect(h.listReads).toBe(0)
    expect(h.settingsReads).toEqual([])
    expect(h.calls).toHaveLength(0)
  })
})
