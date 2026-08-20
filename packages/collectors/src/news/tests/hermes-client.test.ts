import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'
import type { ChildProcess, SpawnOptions } from 'node:child_process'
import { HermesService } from '../../hermes'
import { HermesWorkerClient } from '../hermes-client'

class FakeChildProcess extends EventEmitter {
  readonly stdout = new EventEmitter()
  readonly stderr = new EventEmitter()
  killedWith: string | null = null

  kill(signal?: NodeJS.Signals | number): boolean {
    this.killedWith = signal == null ? 'SIGTERM' : String(signal)
    queueMicrotask(() => this.close(null))
    return true
  }

  writeStdout(value: string): void {
    this.stdout.emit('data', Buffer.from(value))
  }

  writeStderr(value: string): void {
    this.stderr.emit('data', Buffer.from(value))
  }

  close(code: number | null): void {
    this.emit('close', code, null)
  }
}

interface SpawnCall {
  command: string
  args: string[]
  options: SpawnOptions
  child: FakeChildProcess
}

function fakeSpawn(onSpawn?: (child: FakeChildProcess) => void): {
  calls: SpawnCall[]
  spawnProcess: (command: string, args: string[], options: SpawnOptions) => ChildProcess
} {
  const calls: SpawnCall[] = []
  return {
    calls,
    spawnProcess(command, args, options) {
      const child = new FakeChildProcess()
      calls.push({ command, args, options, child })
      onSpawn?.(child)
      return child as unknown as ChildProcess
    },
  }
}

const request = {
  jobId: 'job-1',
  taskType: 'source_aware_research' as const,
  prompt: 'Research this source item and return the required JSON.',
  timeoutMs: 1000,
}

const immediateLimiter = { acquire: async () => ({ release() {} }) }

test('HermesWorkerClient builds the expected command and returns succeeded output', async () => {
  const fake = fakeSpawn((child) => {
    queueMicrotask(() => {
      child.writeStdout('raw stdout')
      child.writeStderr('raw stderr')
      child.close(0)
    })
  })
  const client = new HermesWorkerClient({
    command: 'fake-hermes',
    profile: 'myboon-worker-test',
    toolsets: ['browser', 'web'],
    spawnProcess: fake.spawnProcess,
    limiter: immediateLimiter,
  })

  const result = await client.run(request)

  assert.equal(fake.calls.length, 1)
  assert.equal(fake.calls[0].command, 'fake-hermes')
  assert.deepEqual(fake.calls[0].args, [
    'chat',
    '--profile',
    'myboon-worker-test',
    '--toolsets',
    'browser,web',
    '--source',
    'tool',
    '--quiet',
    '--query',
    request.prompt,
  ])
  assert.equal(fake.calls[0].options.shell, false)
  assert.equal(fake.calls[0].options.detached, process.platform !== 'win32')
  assert.deepEqual(fake.calls[0].options.stdio, ['ignore', 'pipe', 'pipe'])
  assert.equal(result.status, 'succeeded')
  assert.equal(result.stdout, 'raw stdout')
  assert.equal(result.stderr, 'raw stderr')
  assert.equal(result.exitCode, 0)
  assert.equal(result.jobId, request.jobId)
  assert.equal(result.taskType, request.taskType)
  assert.ok(Date.parse(result.startedAt) > 0)
  assert.ok(Date.parse(result.finishedAt) > 0)
  assert.ok(result.durationMs >= 0)
})

test('HermesWorkerClient returns failed for a non-zero exit code', async () => {
  const fake = fakeSpawn((child) => {
    queueMicrotask(() => {
      child.writeStdout('partial output')
      child.writeStderr('command failed')
      child.close(2)
    })
  })
  const client = new HermesWorkerClient({
    command: 'fake-hermes',
    spawnProcess: fake.spawnProcess,
    limiter: immediateLimiter,
  })

  const result = await client.run({
    ...request,
    jobId: 'job-failed',
    taskType: 'source_aware_research',
  })

  assert.equal(result.status, 'failed')
  assert.equal(result.stdout, 'partial output')
  assert.equal(result.stderr, 'command failed')
  assert.equal(result.exitCode, 2)
  assert.equal(result.jobId, 'job-failed')
  assert.equal(result.taskType, 'source_aware_research')
  assert.deepEqual(fake.calls[0].args.slice(0, 5), [
    'chat',
    '--profile',
    'myboonfeed',
    '--toolsets',
    'browser,web',
  ])
})

test('HermesWorkerClient kills the process and returns timed_out on timeout', async () => {
  const fake = fakeSpawn()
  const client = new HermesWorkerClient({
    command: 'fake-hermes',
    spawnProcess: fake.spawnProcess,
    limiter: immediateLimiter,
  })

  const result = await client.run({
    ...request,
    jobId: 'job-timeout',
    timeoutMs: 1,
  })

  assert.equal(result.status, 'timed_out')
  assert.equal(result.exitCode, null)
  assert.equal(fake.calls[0].child.killedWith, 'SIGTERM')
})

test('HermesWorkerClient uses direct article read plus structured Hermes without browser tools', async () => {
  const execCalls: Array<{ command: string, args: string[] }> = []
  const service = new HermesService({
    command: 'fake-hermes',
    limiter: { acquire: async () => ({ release() {} }) },
    execFileImpl: async (command, args) => {
      execCalls.push({ command, args })
      return { stdout: '{"ok":true}', stderr: '' }
    },
  })
  const client = new HermesWorkerClient({
    service,
    reader: {
      read: async () => ({
        status: 'succeeded',
        content: 'The complete article content supplied as untrusted evidence.',
        finalUrl: 'https://news.example/final',
        contentType: 'text/html',
        source: 'html-fallback',
        httpStatus: 200,
        truncated: false,
        browserLaunched: false,
        fallbackAllowed: true,
        durationMs: 4,
        error: null,
      }),
    },
  })

  const result = await client.run({
    ...request,
    sourceUrl: 'https://news.example/article',
  })

  assert.equal(result.status, 'succeeded')
  assert.equal(result.executionMode, 'agent_browser_read')
  assert.equal(result.sourceReadStatus, 'succeeded')
  assert.equal(execCalls.length, 1)
  assert.equal(execCalls[0].command, 'fake-hermes')
  assert.deepEqual(execCalls[0].args.slice(0, 2), ['--ignore-rules', '-z'])
  assert.equal(execCalls[0].args.includes('chat'), false)
  assert.match(execCalls[0].args.at(-1) ?? '', /untrusted_source_document/)
})

test('HermesWorkerClient falls back to browser chat when direct read fails', async () => {
  const fake = fakeSpawn((child) => {
    queueMicrotask(() => child.close(0))
  })
  const client = new HermesWorkerClient({
    command: 'fake-hermes',
    spawnProcess: fake.spawnProcess,
    limiter: immediateLimiter,
    reader: {
      read: async () => ({
        status: 'failed',
        content: '',
        finalUrl: null,
        contentType: null,
        source: null,
        httpStatus: null,
        truncated: false,
        browserLaunched: null,
        fallbackAllowed: true,
        durationMs: 3,
        error: 'blocked by origin',
      }),
    },
  })

  const result = await client.run({
    ...request,
    sourceUrl: 'https://news.example/article',
  })

  assert.equal(result.status, 'succeeded')
  assert.equal(result.executionMode, 'hermes_browser_fallback')
  assert.equal(result.sourceReadStatus, 'failed')
  assert.equal(result.sourceReadError, 'blocked by origin')
  assert.equal(fake.calls[0].args[0], 'chat')
})

test('HermesWorkerClient never sends an unsafe source URL to browser fallback', async () => {
  const fake = fakeSpawn()
  const client = new HermesWorkerClient({
    command: 'fake-hermes',
    spawnProcess: fake.spawnProcess,
    limiter: immediateLimiter,
    reader: {
      read: async () => ({
        status: 'failed',
        content: '',
        finalUrl: null,
        contentType: null,
        source: null,
        httpStatus: null,
        truncated: false,
        browserLaunched: null,
        fallbackAllowed: false,
        durationMs: 1,
        error: 'Article URL resolved to a non-public address',
      }),
    },
  })

  const result = await client.run({ ...request, sourceUrl: 'http://127.0.0.1/private' })

  assert.equal(result.status, 'failed')
  assert.equal(fake.calls.length, 0)
})
