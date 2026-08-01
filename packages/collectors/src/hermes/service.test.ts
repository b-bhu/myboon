import assert from 'node:assert/strict'
import test from 'node:test'
import { EventEmitter } from 'node:events'
import type { ChildProcess } from 'node:child_process'
import { HermesService, type HermesCallRecord } from './service'

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
  kill(signal?: string): boolean {
    this.killedWith = signal ?? 'SIGTERM'
    return true
  }
}

function fakeSpawn(script?: (child: FakeChild) => void) {
  const calls: Array<{ command: string, args: string[] }> = []
  const children: FakeChild[] = []
  const impl = (command: string, args: string[]) => {
    calls.push({ command, args })
    const child = new FakeChild()
    children.push(child)
    if (script) setImmediate(() => script(child))
    return child as unknown as ChildProcess
  }
  return { calls, children, impl }
}

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

  assert.deepEqual(calls[0].args, ['chat', '--profile', 'myboonfeed', '--toolsets', 'browser,web', '--quiet', '--query', 'QUERY'])
})

test('chat omits profile and toolsets when not provided', async () => {
  const { calls, impl } = fakeSpawn((child) => child.emit('close', 0))
  const service = new HermesService({ command: 'hermes', spawnImpl: impl })

  await service.chat({ purpose: 'news.worker', prompt: 'Q', timeoutMs: 1000 })

  assert.deepEqual(calls[0].args, ['chat', '--quiet', '--query', 'Q'])
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
  const service = new HermesService({ command: 'hermes', spawnImpl: impl })

  const result = await service.chat({ purpose: 'news.worker', prompt: 'Q', timeoutMs: 20 })

  assert.equal(result.status, 'timed_out')
  assert.equal(children[0].killedWith, 'SIGTERM')
  assert.equal(result.exitCode, null)
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
