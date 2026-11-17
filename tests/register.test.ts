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
    expect(h.calls[0]).toEqual({ at: 300, argv: ['/bin/sh', '-c', 'legacy-command'], init: {
      cwd: '/config-root', timeoutMs: 5000, stdin: JSON.stringify(h.input()), env: {
        CLAUDE_PROJECT_DIR: '/project', CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: 'session-1',
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
    expect(h.settingsReads).toEqual(['policy', 'policy'])
  })

  test.each(['${CLAUDE_PLUGIN_ROOT}', '${CLAUDE_PLUGIN_DATA}'])('unowned legacy %s is refused', async variable => {
    const h = host()
    h.user.subagentStatusLine = { type: 'command', command: `echo "${variable}"` }
    await h.start()
    await h.clock.advance(10000)
    expect(h.calls).toHaveLength(0)
  })

  test.each([undefined, null, {}, { type: 'prompt', command: 'no' }, { type: 'command', command: 42 }])(
    'missing or invalid legacy config never spawns: %j', async config => {
      const h = host()
      h.user.subagentStatusLine = config
      await h.start()
      await h.clock.advance(5000)
      expect(h.calls).toHaveLength(0)
    },
  )

  test('empty legacy command is valid, unlike an unset command', async () => {
    const h = host({ command: ' ' })
    h.user.subagentStatusLine = { type: 'command', command: '' }
    await h.start()
    await h.clock.advance(300)
    expect(h.calls[0]!.argv).toEqual(['/bin/sh', '-c', ''])
  })

  test('policy overrides options and user settings; project settings are never read', async () => {
    const h = host({ command: 'own' })
    h.policy = { allowManagedHooksOnly: true, subagentStatusLine: { type: 'command', command: 'policy-command' } }
    await h.start()
    await h.clock.advance(300)
    expect(h.calls[0]!.argv[2]).toBe('policy-command')
    expect(h.settingsReads).toEqual(['policy', 'policy'])
    expect(h.calls[0]!.init.env).not.toHaveProperty('CLAUDE_PLUGIN_ROOT')
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
    await Promise.all([h.draw(row()), h.draw(row('b'))])
    expect(h.listReads).toBe(1)
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
    h.user = {}
    await h.draw()
    expect(h.clock.timers.size).toBe(0)
    expect(h.decorations).toEqual({})
    h.user = { subagentStatusLine: { type: 'command', command: 'new' } }
    await h.draw()
    await h.clock.advance(300)
    expect(h.calls[1]!.argv[2]).toBe('new')
    expect(h.input().tasks[0].tokenSamples).toEqual([1234, 1234])
  })

  test('no command means no idle polling, even with eligible rows', async () => {
    const h = host()
    h.user = {}
    await h.start()
    await h.clock.advance(60000)
    expect(h.clock.timers.size).toBe(0)
    expect(h.calls).toHaveLength(0)
  })

  test('periodic refresh picks up a changed command without an extra immediate run', async () => {
    const h = host()
    await h.start()
    await h.clock.advance(300)
    h.user.subagentStatusLine = { type: 'command', command: 'replacement' }
    await h.draw()
    await h.clock.advance(300)
    expect(h.calls).toHaveLength(1)
    await h.clock.advance(4400)
    expect(h.calls[1]!.argv[2]).toBe('replacement')
    h.user = {}
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

  test.each([NaN, Infinity, 'invalid'])('invalid refresh option uses 5 s: %s', async refreshMs => {
    const h = host({ refreshMs })
    await h.start()
    await h.clock.advance(5000)
    expect(h.calls.map(call => call.at)).toEqual([300, 5000])
  })

  test('custom interval is bounded to at least one second', async () => {
    const h = host({ refreshMs: -5 })
    await h.start()
    await h.clock.advance(1000)
    expect(h.calls.map(call => call.at)).toEqual([300, 1000])
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
    const h = host()
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
    expect(h.writes).toBe(1)
  })

  test('nonterminal surface passes through without scheduling commands', async () => {
    const h = host()
    const event = { ...row(), surface: 'web' }
    await h.draw(event)
    await h.clock.advance(10000)
    expect(h.calls).toHaveLength(0)
    expect(h.forwarded.at(-1)).toBe(event)
  })
})
