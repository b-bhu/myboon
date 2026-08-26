import assert from 'node:assert/strict'
import test from 'node:test'
import { EventEmitter } from 'node:events'
import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process'
import {
  HermesProviderCircuitBreaker,
  HermesProviderCircuitOpenError,
  HermesService,
  type HermesCallRecord,
} from './service'

interface RecordedExec {
  command: string
  args: string[]
  options: { timeout?: number, maxBuffer?: number }
}

function fakeExec(response: { stdout?: string, stderr?: string, error?: Error }) {
  const calls: RecordedExec[] = []
  const impl = async (command: string, args: string[], options: { timeout?: number, maxBuffer?: number }) => {
    calls.push({ command, args, options })
    if (response.error) throw response.error
    return { stdout: response.stdout ?? '', stderr: response.stderr ?? '' }
  }
  return { calls, impl }
}

class FakeChild extends EventEmitter {
  stdout = new EventEmitter()
  stderr = new EventEmitter()
  killedWith: string | null = null
  signals: string[] = []
  kill(signal?: string): boolean {
    this.killedWith = signal ?? 'SIGTERM'
    this.signals.push(this.killedWith)
    return true
  }
}

function fakeSpawn(script?: (child: FakeChild) => void) {
  const calls: Array<{ command: string, args: string[], options?: SpawnOptions }> = []
  const children: FakeChild[] = []
  const impl = (command: string, args: string[], options?: SpawnOptions) => {
    calls.push({ command, args, options })
    const child = new FakeChild()
    children.push(child)
    if (script) setImmediate(() => script(child))
    return child as unknown as ChildProcess
  }
  return { calls, children, impl }
}

test('oneshot and chat acquire independent structured and browser pools', async () => {
  let structuredAcquires = 0
  let browserAcquires = 0
  const { impl: execImpl } = fakeExec({ stdout: 'ok' })
  const { impl: spawnImpl } = fakeSpawn((child) => child.emit('close', 0))
  const service = new HermesService({
    command: 'hermes',
    execFileImpl: execImpl,
    spawnImpl,
    structuredLimiter: {
      acquire: async () => {
        structuredAcquires += 1
        return { release() {} }
      },
    },
    browserLimiter: {
      acquire: async () => {
        browserAcquires += 1
        return { release() {} }
      },
    },
  })

  await service.oneshot({ purpose: 'test.structured-pool', prompt: 'P', timeoutMs: 1000 })
  await service.chat({ purpose: 'test.browser-pool', prompt: 'Q', timeoutMs: 1000 })

  assert.equal(structuredAcquires, 1)
  assert.equal(browserAcquires, 1)
})

// ---------------------------------------------------------------- oneshot ---

test('oneshot builds --ignore-rules, -t and -z args in the legacy order', async () => {
  const { calls, impl } = fakeExec({ stdout: 'ok' })
  const service = new HermesService({ command: 'hermes', execFileImpl: impl })

  await service.oneshot({ purpose: 'test.args', prompt: 'PROMPT', timeoutMs: 1000, toolsets: 'browser,web', ignoreRules: true })

  assert.deepEqual(calls[0].args, ['--ignore-rules', '-t', 'browser,web', '-z', 'PROMPT'])
  assert.equal(calls[0].command, 'hermes')
  assert.equal(calls[0].options.timeout, 1000)
})

test('oneshot omits optional flags when not requested', async () => {
  const { calls, impl } = fakeExec({ stdout: 'ok' })
  const service = new HermesService({ command: 'hermes', execFileImpl: impl })

  await service.oneshot({ purpose: 'test.bare', prompt: 'P', timeoutMs: 500 })

  assert.deepEqual(calls[0].args, ['-z', 'P'])
})

test('oneshot routes profile, provider, and model before the prompt and records requested metadata', async () => {
  const records: HermesCallRecord[] = []
  const { calls, impl } = fakeExec({ stdout: 'ok' })
  const service = new HermesService({ command: 'hermes', execFileImpl: impl, observer: (record) => records.push(record) })

  await service.oneshot({
    purpose: 'test.routed',
    prompt: 'PROMPT',
    timeoutMs: 500,
    ignoreRules: true,
    profile: 'structured',
    provider: 'openrouter',
    model: 'provider/model-v1',
  })

  assert.deepEqual(calls[0].args, [
    '--ignore-rules',
    '-p', 'structured',
    '--provider', 'openrouter',
    '-m', 'provider/model-v1',
    '-z', 'PROMPT',
  ])
  assert.equal(records[0].requestedProfile, 'structured')
  assert.equal(records[0].requestedProvider, 'openrouter')
  assert.equal(records[0].requestedModel, 'provider/model-v1')
  assert.equal(JSON.stringify(records[0]).includes('PROMPT'), false)
})

test('oneshot rejects empty, untrimmed, control-bearing, and oversized route values', async () => {
  const { calls, impl } = fakeExec({ stdout: 'unused' })
  const service = new HermesService({ command: 'hermes', execFileImpl: impl })
  const base = { purpose: 'test.invalid-route', prompt: 'P', timeoutMs: 500 }

  await assert.rejects(service.oneshot({ ...base, provider: '' }), /provider must be a non-empty trimmed value/)
  await assert.rejects(service.oneshot({ ...base, model: ' leading' }), /model must be a non-empty trimmed value/)
  await assert.rejects(service.oneshot({ ...base, profile: 'bad\nprofile' }), /profile must not contain control characters/)
  await assert.rejects(service.oneshot({ ...base, model: 'm'.repeat(201) }), /model must be at most 200 characters/)
  assert.equal(calls.length, 0)
})

test('production oneshot uses a dedicated process group and captures output', async () => {
  const { calls, impl } = fakeSpawn((child) => {
    child.stdout.emit('data', Buffer.from('{"ok":true}'))
    child.stderr.emit('data', Buffer.from('warning'))
    child.emit('close', 0)
  })
  const service = new HermesService({ command: 'hermes', spawnImpl: impl })

  const result = await service.oneshot({
    purpose: 'test.oneshot-process-group',
    prompt: 'P',
    timeoutMs: 1000,
  })

  assert.deepEqual(calls[0].args, ['-z', 'P'])
  assert.equal(calls[0].options?.detached, process.platform !== 'win32')
  assert.deepEqual(result, { stdout: '{"ok":true}', stderr: 'warning' })
})

test('production oneshot timeout gives Hermes grace then kills the process group', async () => {
  const { children, impl } = fakeSpawn()
  const service = new HermesService({
    command: 'hermes',
    spawnImpl: impl,
    processGroupKillGraceMs: 5,
  })

  await assert.rejects(
    service.oneshot({ purpose: 'test.oneshot-timeout', prompt: 'P', timeoutMs: 20 }),
    (error: Error & { killed?: boolean, signal?: string }) => {
      assert.equal(error.killed, true)
      assert.equal(error.signal, 'SIGTERM')
      return true
    },
  )
  assert.deepEqual(children[0].signals, ['SIGTERM', 'SIGKILL'])
})

test('production oneshot timeout leaves no real process-group descendant', {
  skip: process.platform === 'win32',
}, async () => {
  let groupPid: number | null = null
  const spawnImpl = (_command: string, _args: string[], options: SpawnOptions) => {
    const child = spawn('/bin/bash', [
      '-c',
      "trap 'exit 0' TERM; (trap '' TERM; while :; do sleep 1; done) >/dev/null 2>&1 & wait",
    ], options)
    groupPid = child.pid ?? null
    return child
  }
  const service = new HermesService({
    command: 'ignored',
    spawnImpl,
    limiter: { acquire: async () => ({ release() {} }) },
    processGroupKillGraceMs: 20,
  })

  await assert.rejects(
    service.oneshot({ purpose: 'test.oneshot-real-group-cleanup', prompt: 'P', timeoutMs: 30 }),
  )
  let groupAlive = false
  if (groupPid) {
    try {
      process.kill(-groupPid, 0)
      groupAlive = true
    } catch {
      groupAlive = false
    }
  }
  assert.equal(groupAlive, false)
})

test('oneshot returns stdout and stderr on success', async () => {
  const { impl } = fakeExec({ stdout: '{"a":1}', stderr: 'warning' })
  const service = new HermesService({ command: 'hermes', execFileImpl: impl })

  const result = await service.oneshot({ purpose: 'test.ok', prompt: 'P', timeoutMs: 500 })

  assert.equal(result.stdout, '{"a":1}')
  assert.equal(result.stderr, 'warning')
})

test('oneshot rethrows the underlying error unchanged so call sites keep their own error semantics', async () => {
  const original = Object.assign(new Error('spawn hermes ENOENT'), { code: 'ENOENT', stderr: 'boom' })
  const { impl } = fakeExec({ error: original })
  const service = new HermesService({ command: 'hermes', execFileImpl: impl })

  await assert.rejects(
    service.oneshot({ purpose: 'test.err', prompt: 'P', timeoutMs: 500 }),
    (error: Error & { code?: string, stderr?: string }) => {
      assert.equal(error, original)
      assert.equal(error.code, 'ENOENT')
      assert.equal(error.stderr, 'boom')
      return true
    }
  )
})

test('oneshot per-call command override wins over the instance command', async () => {
  const { calls, impl } = fakeExec({ stdout: '' })
  const service = new HermesService({ command: 'hermes', execFileImpl: impl })

  await service.oneshot({ purpose: 'test.override', prompt: 'P', timeoutMs: 500, commandOverride: 'custom-hermes' })

  assert.equal(calls[0].command, 'custom-hermes')
})

test('oneshot notifies the observer with a succeeded record', async () => {
  const records: HermesCallRecord[] = []
  const { impl } = fakeExec({ stdout: 'out', stderr: 'err' })
  const service = new HermesService({ command: 'hermes', execFileImpl: impl, observer: (record) => records.push(record) })

  await service.oneshot({ purpose: 'polymarket.researcher.planner', prompt: 'PROMPT', timeoutMs: 500 })

  assert.equal(records.length, 1)
  assert.equal(records[0].purpose, 'polymarket.researcher.planner')
  assert.equal(records[0].mode, 'oneshot')
  assert.equal(records[0].status, 'succeeded')
  assert.equal(records[0].promptChars, 'PROMPT'.length)
  assert.equal(records[0].stdoutChars, 3)
  assert.equal(records[0].stderrChars, 3)
  assert.equal(records[0].error, null)
})

test('oneshot records a failed call before rethrowing', async () => {
  const records: HermesCallRecord[] = []
  const { impl } = fakeExec({ error: new Error('exit 1') })
  const service = new HermesService({ command: 'hermes', execFileImpl: impl, observer: (record) => records.push(record) })

  await assert.rejects(service.oneshot({ purpose: 'test.fail', prompt: 'P', timeoutMs: 500 }))

  assert.equal(records[0].status, 'failed')
  assert.equal(records[0].error, 'exit 1')
})

test('oneshot records a killed subprocess as timed_out', async () => {
  const records: HermesCallRecord[] = []
  const timeoutError = Object.assign(new Error('timeout'), { killed: true, signal: 'SIGTERM' })
  const { impl } = fakeExec({ error: timeoutError })
  const service = new HermesService({ command: 'hermes', execFileImpl: impl, observer: (record) => records.push(record) })

  await assert.rejects(service.oneshot({ purpose: 'test.timeout', prompt: 'P', timeoutMs: 500 }))

  assert.equal(records[0].status, 'timed_out')
})

test('an observer that throws does not break the call', async () => {
  const { impl } = fakeExec({ stdout: 'ok' })
  const service = new HermesService({
    command: 'hermes',
    execFileImpl: impl,
    observer: () => { throw new Error('observer bug') },
  })

  const result = await service.oneshot({ purpose: 'test.observer-throws', prompt: 'P', timeoutMs: 500 })
  assert.equal(result.stdout, 'ok')
})

// ------------------------------------------------------------- structured ---

test('structured extracts JSON from stdout', async () => {
  const { impl } = fakeExec({ stdout: 'preamble {"plan": "x"} trailer' })
  const service = new HermesService({ command: 'hermes', execFileImpl: impl })

  const result = await service.structured<{ plan: string }>({ purpose: 'test.structured', prompt: 'P', timeoutMs: 500 })

  assert.deepEqual(result.value, { plan: 'x' })
  assert.equal(result.stdout, 'preamble {"plan": "x"} trailer')
})

test('structured returns value null when stdout has no JSON, without throwing', async () => {
  const { impl } = fakeExec({ stdout: 'sorry, no json today' })
  const service = new HermesService({ command: 'hermes', execFileImpl: impl })

  const result = await service.structured({ purpose: 'test.nojson', prompt: 'P', timeoutMs: 500 })

  assert.equal(result.value, null)
})

// ------------------------------------------------------------------- chat ---

test('chat builds the chat-mode argument list', async () => {
  const { calls, impl } = fakeSpawn((child) => child.emit('close', 0))
  const service = new HermesService({ command: 'hermes', spawnImpl: impl })

  await service.chat({ purpose: 'news.worker', prompt: 'QUERY', timeoutMs: 1000, profile: 'myboonfeed', toolsets: ['browser', 'web'] })

  assert.deepEqual(calls[0].args, ['chat', '--profile', 'myboonfeed', '--toolsets', 'browser,web', '--source', 'tool', '--quiet', '--query', 'QUERY'])
  assert.equal(calls[0].options?.detached, process.platform !== 'win32')
})

test('chat omits profile and toolsets when not provided', async () => {
  const { calls, impl } = fakeSpawn((child) => child.emit('close', 0))
  const service = new HermesService({ command: 'hermes', spawnImpl: impl })

  await service.chat({ purpose: 'news.worker', prompt: 'Q', timeoutMs: 1000 })

  assert.deepEqual(calls[0].args, ['chat', '--source', 'tool', '--quiet', '--query', 'Q'])
})

test('chat resolves succeeded with captured stdout on exit 0', async () => {
  const { impl } = fakeSpawn((child) => {
    child.stdout.emit('data', Buffer.from('hello '))
    child.stdout.emit('data', Buffer.from('world'))
    child.emit('close', 0)
  })
  const service = new HermesService({ command: 'hermes', spawnImpl: impl })

  const result = await service.chat({ purpose: 'news.worker', prompt: 'Q', timeoutMs: 1000 })

  assert.equal(result.status, 'succeeded')
  assert.equal(result.stdout, 'hello world')
  assert.equal(result.exitCode, 0)
})

test('chat resolves failed on a non-zero exit code', async () => {
  const { impl } = fakeSpawn((child) => {
    child.stderr.emit('data', Buffer.from('broken'))
    child.emit('close', 3)
  })
  const service = new HermesService({ command: 'hermes', spawnImpl: impl })

  const result = await service.chat({ purpose: 'news.worker', prompt: 'Q', timeoutMs: 1000 })

  assert.equal(result.status, 'failed')
  assert.equal(result.exitCode, 3)
  assert.equal(result.stderr, 'broken')
})

test('chat resolves failed and appends the message to stderr on spawn error', async () => {
  const { impl } = fakeSpawn((child) => {
    child.stderr.emit('data', Buffer.from('partial'))
    child.emit('error', new Error('spawn hermes ENOENT'))
  })
  const service = new HermesService({ command: 'hermes', spawnImpl: impl })

  const result = await service.chat({ purpose: 'news.worker', prompt: 'Q', timeoutMs: 1000 })

  assert.equal(result.status, 'failed')
  assert.equal(result.stderr, 'partial\nspawn hermes ENOENT')
  assert.equal(result.exitCode, null)
})

test('chat kills the child and resolves timed_out when the timeout elapses', async () => {
  const { children, impl } = fakeSpawn() // child never closes
  const service = new HermesService({ command: 'hermes', spawnImpl: impl, processGroupKillGraceMs: 5 })

  const result = await service.chat({ purpose: 'news.worker', prompt: 'Q', timeoutMs: 20 })

  assert.equal(result.status, 'timed_out')
  assert.equal(children[0].killedWith, 'SIGKILL')
  assert.equal(result.exitCode, null)
})

test('chat still sends group SIGKILL when the Hermes parent closes after SIGTERM', async () => {
  const { children, impl } = fakeSpawn((child) => {
    const kill = child.kill.bind(child)
    child.kill = (signal?: string) => {
      const result = kill(signal)
      if ((signal ?? 'SIGTERM') === 'SIGTERM') queueMicrotask(() => child.emit('close', null))
      return result
    }
  })
  const service = new HermesService({ command: 'hermes', spawnImpl: impl, processGroupKillGraceMs: 5 })

  const result = await service.chat({ purpose: 'news.worker', prompt: 'Q', timeoutMs: 20 })

  assert.equal(result.status, 'timed_out')
  assert.deepEqual(children[0].signals, ['SIGTERM', 'SIGKILL'])
  assert.equal(result.exitCode, null)
})

test('chat timeout leaves no real process-group descendant after the parent exits on SIGTERM', {
  skip: process.platform === 'win32',
}, async () => {
  let groupPid: number | null = null
  const spawnImpl = (_command: string, _args: string[], options: SpawnOptions) => {
    const child = spawn('/bin/bash', [
      '-c',
      "trap 'exit 0' TERM; (trap '' TERM; while :; do sleep 1; done) >/dev/null 2>&1 & wait",
    ], options)
    groupPid = child.pid ?? null
    return child
  }
  const service = new HermesService({
    command: 'ignored',
    spawnImpl,
    limiter: { acquire: async () => ({ release() {} }) },
    processGroupKillGraceMs: 20,
  })

  const result = await service.chat({ purpose: 'test.real-group-cleanup', prompt: 'Q', timeoutMs: 30 })
  let groupAlive = false
  if (groupPid) {
    try {
      process.kill(-groupPid, 0)
      groupAlive = true
    } catch {
      groupAlive = false
    }
  }

  assert.equal(result.status, 'timed_out')
  assert.equal(groupAlive, false)
})

test('chat deletes only the exact source-tagged Hermes session reported by the completed call', async () => {
  const { calls: execCalls, impl: execImpl } = fakeExec({ stdout: 'Deleted session' })
  const { impl } = fakeSpawn((child) => {
    child.stdout.emit('data', Buffer.from('{"ok":true}'))
    child.stderr.emit('data', Buffer.from('\nsession_id: 20260819_063000_abcd1234\n'))
    child.emit('close', 0)
  })
  const service = new HermesService({ command: 'hermes', spawnImpl: impl, execFileImpl: execImpl })

  const result = await service.chat({
    purpose: 'news.worker.research',
    prompt: 'Q',
    timeoutMs: 1000,
    profile: 'myboonfeed',
  })

  assert.equal(result.sessionId, '20260819_063000_abcd1234')
  assert.equal(result.sessionDeleted, true)
  assert.deepEqual(execCalls[0].args, [
    '--profile',
    'myboonfeed',
    'sessions',
    'delete',
    '20260819_063000_abcd1234',
    '--yes',
  ])
})

test('chat keeps a successful result when exact session cleanup fails', async () => {
  const { impl: execImpl } = fakeExec({ error: new Error('session db busy') })
  const { impl } = fakeSpawn((child) => {
    child.stderr.emit('data', Buffer.from('\nsession_id: 20260819_063001_dcba4321\n'))
    child.emit('close', 0)
  })
  const service = new HermesService({ command: 'hermes', spawnImpl: impl, execFileImpl: execImpl })

  const result = await service.chat({ purpose: 'news.worker.research', prompt: 'Q', timeoutMs: 1000 })

  assert.equal(result.status, 'succeeded')
  assert.equal(result.sessionDeleted, false)
})

test('chat throws on a non-positive timeout', async () => {
  const service = new HermesService({ command: 'hermes', spawnImpl: fakeSpawn().impl })
  assert.throws(() => service.chat({ purpose: 'news.worker', prompt: 'Q', timeoutMs: 0 }))
})

test('chat notifies the observer with mode chat and duration fields', async () => {
  const records: HermesCallRecord[] = []
  const { impl } = fakeSpawn((child) => {
    child.stdout.emit('data', Buffer.from('out'))
    child.emit('close', 0)
  })
  const service = new HermesService({ command: 'hermes', spawnImpl: impl, observer: (record) => records.push(record) })

  await service.chat({ purpose: 'news.worker.research', prompt: 'QUERY', timeoutMs: 1000 })

  assert.equal(records.length, 1)
  assert.equal(records[0].mode, 'chat')
  assert.equal(records[0].status, 'succeeded')
  assert.equal(records[0].purpose, 'news.worker.research')
  assert.equal(records[0].stdoutChars, 3)
  assert.ok(records[0].durationMs >= 0)
})

// -------------------------------------------------------- provider circuit ---

test('chat circuit trips after the configured number of retryable failures and then fails fast', async () => {
  const transitions: string[] = []
  const circuitBreaker = new HermesProviderCircuitBreaker({
    failureThreshold: 3,
    cooldownMs: 1000,
    logger: (message) => transitions.push(message),
  })
  const { calls, impl } = fakeSpawn((child) => {
    child.stderr.emit('data', Buffer.from('HTTP 429: too many requests'))
    child.emit('close', 1)
  })
  const service = new HermesService({ command: 'hermes', spawnImpl: impl, circuitBreaker })

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const result = await service.chat({ purpose: 'test.circuit.trip', prompt: 'Q', timeoutMs: 1000 })
    assert.equal(result.status, 'failed')
  }

  assert.equal(calls.length, 3)
  assert.throws(
    () => service.chat({ purpose: 'test.circuit.open', prompt: 'Q', timeoutMs: 1000 }),
    HermesProviderCircuitOpenError,
  )
  assert.equal(calls.length, 3)
  assert.deepEqual(transitions, ['[hermes] provider circuit open; next probe in 1s'])
})

test('a successful chat resets the consecutive retryable-failure count', async () => {
  const circuitBreaker = new HermesProviderCircuitBreaker({
    failureThreshold: 3,
    cooldownMs: 1000,
    logger: () => {},
  })
  let invocation = 0
  const { calls, impl } = fakeSpawn((child) => {
    invocation += 1
    if (invocation === 3) {
      child.emit('close', 0)
      return
    }
    child.stderr.emit('data', Buffer.from('connection reset by peer'))
    child.emit('close', 1)
  })
  const service = new HermesService({ command: 'hermes', spawnImpl: impl, circuitBreaker })

  for (let attempt = 0; attempt < 6; attempt += 1) {
    await service.chat({ purpose: 'test.circuit.reset', prompt: 'Q', timeoutMs: 1000 })
  }

  assert.equal(calls.length, 6)
  assert.throws(
    () => service.chat({ purpose: 'test.circuit.reset-open', prompt: 'Q', timeoutMs: 1000 }),
    HermesProviderCircuitOpenError,
  )
})

test('chat counts connection errors and timeouts as retryable provider failures', async () => {
  let invocation = 0
  const circuitBreaker = new HermesProviderCircuitBreaker({
    failureThreshold: 2,
    cooldownMs: 1000,
    logger: () => {},
  })
  const { impl } = fakeSpawn((child) => {
    invocation += 1
    if (invocation === 1) child.emit('error', new Error('connect ECONNRESET'))
    // The second child deliberately remains open until the timeout path kills it.
  })
  const service = new HermesService({
    command: 'hermes',
    spawnImpl: impl,
    circuitBreaker,
    processGroupKillGraceMs: 1,
  })

  assert.equal(
    (await service.chat({ purpose: 'test.circuit.connection', prompt: 'Q', timeoutMs: 20 })).status,
    'failed',
  )
  assert.equal(
    (await service.chat({ purpose: 'test.circuit.timeout', prompt: 'Q', timeoutMs: 20 })).status,
    'timed_out',
  )
  assert.throws(
    () => service.chat({ purpose: 'test.circuit.connection-timeout-open', prompt: 'Q', timeoutMs: 20 }),
    HermesProviderCircuitOpenError,
  )
})

test('after cooldown exactly one recovery probe runs and success closes the circuit', async () => {
  let now = 0
  const transitions: string[] = []
  const circuitBreaker = new HermesProviderCircuitBreaker({
    failureThreshold: 1,
    cooldownMs: 100,
    now: () => now,
    logger: (message) => transitions.push(message),
  })
  const { calls, children, impl } = fakeSpawn((child) => {
    if (calls.length === 1) {
      child.stderr.emit('data', Buffer.from('HTTP 429'))
      child.emit('close', 1)
    }
  })
  const service = new HermesService({ command: 'hermes', spawnImpl: impl, circuitBreaker })

  await service.chat({ purpose: 'test.circuit.initial-failure', prompt: 'Q', timeoutMs: 1000 })
  now = 100
  const probe = service.chat({ purpose: 'test.circuit.probe', prompt: 'Q', timeoutMs: 1000 })
  assert.throws(
    () => service.chat({ purpose: 'test.circuit.concurrent-probe', prompt: 'Q', timeoutMs: 1000 }),
    HermesProviderCircuitOpenError,
  )
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.equal(calls.length, 2)
  children[1].emit('close', 0)
  assert.equal((await probe).status, 'succeeded')

  const afterRecovery = service.chat({ purpose: 'test.circuit.after-recovery', prompt: 'Q', timeoutMs: 1000 })
  await new Promise<void>((resolve) => setImmediate(resolve))
  children[2].emit('close', 0)
  assert.equal((await afterRecovery).status, 'succeeded')
  assert.deepEqual(transitions, [
    '[hermes] provider circuit open; next probe in 1s',
    '[hermes] provider circuit probe',
    '[hermes] provider circuit closed',
  ])
})

test('a failed half-open probe reopens the circuit and extends the cooldown', async () => {
  let now = 0
  const transitions: string[] = []
  let invocation = 0
  const circuitBreaker = new HermesProviderCircuitBreaker({
    failureThreshold: 1,
    cooldownMs: 100,
    now: () => now,
    logger: (message) => transitions.push(message),
  })
  const { impl } = fakeSpawn((child) => {
    invocation += 1
    if (invocation <= 2) {
      child.stderr.emit('data', Buffer.from('socket hang up'))
      child.emit('close', 1)
      return
    }
    child.emit('close', 0)
  })
  const service = new HermesService({ command: 'hermes', spawnImpl: impl, circuitBreaker })

  await service.chat({ purpose: 'test.circuit.open-first', prompt: 'Q', timeoutMs: 1000 })
  now = 100
  await service.chat({ purpose: 'test.circuit.failed-probe', prompt: 'Q', timeoutMs: 1000 })
  now = 199
  assert.throws(
    () => service.chat({ purpose: 'test.circuit.cooldown-extended', prompt: 'Q', timeoutMs: 1000 }),
    HermesProviderCircuitOpenError,
  )
  now = 200
  assert.equal(
    (await service.chat({ purpose: 'test.circuit.second-probe', prompt: 'Q', timeoutMs: 1000 })).status,
    'succeeded',
  )
  assert.deepEqual(transitions, [
    '[hermes] provider circuit open; next probe in 1s',
    '[hermes] provider circuit probe',
    '[hermes] provider circuit open; next probe in 1s',
    '[hermes] provider circuit probe',
    '[hermes] provider circuit closed',
  ])
})

test('malformed structured output does not increment the provider circuit', async () => {
  let invocation = 0
  const calls: RecordedExec[] = []
  const execFileImpl = async (command: string, args: string[], options: { timeout?: number, maxBuffer?: number }) => {
    invocation += 1
    calls.push({ command, args, options })
    if (invocation === 1 || invocation === 3) {
      throw Object.assign(new Error('HTTP 429'), { statusCode: 429 })
    }
    return { stdout: invocation === 2 ? 'not-json' : '{"ok":true}', stderr: '' }
  }
  const circuitBreaker = new HermesProviderCircuitBreaker({
    failureThreshold: 2,
    cooldownMs: 1000,
    logger: () => {},
  })
  const service = new HermesService({ command: 'hermes', execFileImpl, circuitBreaker })

  await assert.rejects(service.oneshot({ purpose: 'test.circuit.structured-429-1', prompt: 'Q', timeoutMs: 1000 }))
  const malformed = await service.structured({ purpose: 'test.circuit.malformed', prompt: 'Q', timeoutMs: 1000 })
  assert.equal(malformed.value, null)
  await assert.rejects(service.oneshot({ purpose: 'test.circuit.structured-429-2', prompt: 'Q', timeoutMs: 1000 }))
  const success = await service.structured<{ ok: boolean }>({ purpose: 'test.circuit.still-closed', prompt: 'Q', timeoutMs: 1000 })

  assert.deepEqual(success.value, { ok: true })
  assert.equal(calls.length, 4)
})

test('oneshot and chat share the same provider circuit', async () => {
  const retryable = Object.assign(new Error('Error code: 429'), { statusCode: 429 })
  const { impl: execFileImpl } = fakeExec({ error: retryable })
  const { calls: spawnCalls, impl: spawnImpl } = fakeSpawn((child) => child.emit('close', 0))
  const circuitBreaker = new HermesProviderCircuitBreaker({
    failureThreshold: 1,
    cooldownMs: 1000,
    logger: () => {},
  })
  const service = new HermesService({ command: 'hermes', execFileImpl, spawnImpl, circuitBreaker })

  await assert.rejects(service.oneshot({ purpose: 'test.circuit.oneshot-trip', prompt: 'Q', timeoutMs: 1000 }))
  assert.throws(
    () => service.chat({ purpose: 'test.circuit.chat-fast-fail', prompt: 'Q', timeoutMs: 1000 }),
    HermesProviderCircuitOpenError,
  )
  assert.equal(spawnCalls.length, 0)
})

test('production structured circuits isolate provider-model targets and success resets only its target', async () => {
  const suffix = `${process.pid}-${Date.now()}`
  const openProvider = `open-${suffix}`
  const resetProvider = `reset-${suffix}`
  const model = `model-${suffix}`
  const invocations = new Map<string, number>()
  const execFileImpl = async (_command: string, args: string[]) => {
    const provider = args[args.indexOf('--provider') + 1]
    const count = (invocations.get(provider) ?? 0) + 1
    invocations.set(provider, count)
    if (provider === openProvider) throw Object.assign(new Error('HTTP 429'), { statusCode: 429 })
    if (provider === resetProvider && (count <= 4 || (count >= 6 && count <= 9))) {
      throw Object.assign(new Error('HTTP 429'), { statusCode: 429 })
    }
    return { stdout: '{"ok":true}', stderr: '' }
  }
  const service = new HermesService({ command: 'hermes', execFileImpl })
  const call = (provider: string) => service.oneshot({
    purpose: 'test.target-circuit', prompt: 'P', timeoutMs: 500, provider, model,
  })

  for (let index = 0; index < 5; index += 1) await assert.rejects(call(openProvider))
  await assert.rejects(call(openProvider), HermesProviderCircuitOpenError)

  for (let index = 0; index < 4; index += 1) await assert.rejects(call(resetProvider))
  await call(resetProvider)
  for (let index = 0; index < 4; index += 1) await assert.rejects(call(resetProvider))
  await call(resetProvider)

  // Success on resetProvider neither probes nor closes openProvider.
  await assert.rejects(call(openProvider), HermesProviderCircuitOpenError)
  assert.equal(invocations.get(openProvider), 5)
  assert.equal(invocations.get(resetProvider), 10)
})
