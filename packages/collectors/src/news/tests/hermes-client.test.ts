import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'
import type { ChildProcess, SpawnOptions } from 'node:child_process'
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
