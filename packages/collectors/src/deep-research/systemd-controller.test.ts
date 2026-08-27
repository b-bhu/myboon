import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'
import type { ChildProcess, SpawnOptions } from 'node:child_process'
import { NodeSystemdController } from './systemd-controller'

test('node systemd controller uses argv-only exec/spawn calls with shell disabled', async () => {
  const execCalls: Array<{ command: string, args: readonly string[] }> = []
  const spawnCalls: Array<{ command: string, args: readonly string[], options: SpawnOptions }> = []
  const execFileImpl = (async (command: string, args: readonly string[]) => {
    execCalls.push({ command, args })
    return { stdout: '', stderr: '' }
  }) as never
  const child = Object.assign(new EventEmitter(), {
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
  })
  const spawnImpl = (command: string, args: string[], options: SpawnOptions) => {
    spawnCalls.push({ command, args, options })
    return child as unknown as ChildProcess
  }
  const controller = new NodeSystemdController({ execFileImpl, spawnImpl })

  assert.equal(await controller.isAvailable(), true)
  controller.spawnTransient(['--wait', '--unit=safe.service', '--', '/worker'], {
    cwd: '/run/myboon/job', env: { PATH: '/usr/bin' },
  })
  await controller.killUnit('safe.service', 'TERM')
  assert.equal(await controller.isUnitActive('safe.service'), true)

  assert.deepEqual(execCalls.slice(0, 3), [
    { command: 'systemd-run', args: ['--version'] },
    { command: 'systemctl', args: ['--version'] },
    { command: 'systemctl', args: ['show', '--property=Version', '--value'] },
  ])
  assert.deepEqual(execCalls[3], {
    command: 'systemctl',
    args: ['kill', '--kill-who=all', '--signal=TERM', 'safe.service'],
  })
  assert.equal(spawnCalls[0].command, 'systemd-run')
  assert.equal(spawnCalls[0].options.shell, false)
  assert.deepEqual(spawnCalls[0].args, ['--wait', '--unit=safe.service', '--', '/worker'])
})
