import assert from 'node:assert/strict'
import test from 'node:test'
import { HermesOrphanSweeper, type ProcessSnapshotRow } from './orphan-sweeper'

const row = (overrides: Partial<ProcessSnapshotRow>): ProcessSnapshotRow => ({
  pid: 100,
  ppid: 1,
  pgid: 100,
  ageMs: 20 * 60_000,
  command: '/usr/local/bin/hermes chat --query test',
  ...overrides,
})

test('kills an aged Hermes invocation with no workspace owner', async () => {
  let snapshot = [row({})]
  const signals: Array<[number, NodeJS.Signals]> = []
  const sweeper = new HermesOrphanSweeper({
    maxAgeMs: 10_000,
    killGraceMs: 1,
    workspaceRoot: '/srv/myboon',
    ownProcessGroupId: 999,
    listProcesses: async () => snapshot,
    signalGroup: (pgid, signal) => {
      signals.push([pgid, signal])
      snapshot = []
    },
    wait: async () => {},
  })

  const result = await sweeper.sweep()
  assert.deepEqual(result.staleHermesGroups, [100])
  assert.deepEqual(signals, [[100, 'SIGTERM']])
})

test('does not touch an aged Hermes invocation owned by a workspace worker', async () => {
  const snapshot = [
    row({ pid: 100, ppid: 50, pgid: 100 }),
    row({ pid: 50, ppid: 1, pgid: 50, command: 'node /srv/myboon/src/news/run-news.ts' }),
  ]
  const signals: Array<[number, NodeJS.Signals]> = []
  const sweeper = new HermesOrphanSweeper({
    maxAgeMs: 10_000,
    workspaceRoot: '/srv/myboon',
    listProcesses: async () => snapshot,
    signalGroup: (pgid, signal) => signals.push([pgid, signal]),
    wait: async () => {},
  })

  const result = await sweeper.sweep()
  assert.deepEqual(result.staleHermesGroups, [])
  assert.deepEqual(signals, [])
})

test('closes browser lifecycle before terminating a stale browser group', async () => {
  let snapshot = [row({
    command: '/usr/bin/chromium --user-data-dir=/tmp/agent-browser-chrome-old',
  })]
  const events: string[] = []
  const sweeper = new HermesOrphanSweeper({
    maxAgeMs: 10_000,
    killGraceMs: 1,
    ownProcessGroupId: 999,
    listProcesses: async () => snapshot,
    closeBrowserSessions: async () => { events.push('close') },
    signalGroup: (_pgid, signal) => {
      events.push(signal)
      snapshot = []
    },
    wait: async () => {},
  })

  const result = await sweeper.sweep()
  assert.equal(result.browserCloseAttempted, true)
  assert.deepEqual(events, ['close', 'SIGTERM'])
})

test('skips stale browser cleanup while a workspace-owned Hermes call is live', async () => {
  const snapshot = [
    row({ pid: 100, ppid: 50, pgid: 100, ageMs: 1_000 }),
    row({ pid: 50, ppid: 1, pgid: 50, ageMs: 30_000, command: 'node /srv/myboon/src/news/run-news.ts' }),
    row({ pid: 200, ppid: 1, pgid: 200, command: '/usr/bin/chrome --user-data-dir=/tmp/agent-browser-chrome-old' }),
  ]
  let closed = false
  const signals: Array<[number, NodeJS.Signals]> = []
  const sweeper = new HermesOrphanSweeper({
    maxAgeMs: 10_000,
    workspaceRoot: '/srv/myboon',
    listProcesses: async () => snapshot,
    closeBrowserSessions: async () => { closed = true },
    signalGroup: (pgid, signal) => signals.push([pgid, signal]),
    wait: async () => {},
  })

  const result = await sweeper.sweep()
  assert.equal(result.browserCleanupSkipped, true)
  assert.equal(closed, false)
  assert.deepEqual(signals, [])
})

test('owner marker protects an aged detached browser daemon', async () => {
  const snapshot = [row({
    pid: 200,
    pgid: 200,
    command: '/opt/agent-browser/bin/agent-browser-linux-x64',
  })]
  const signals: Array<[number, NodeJS.Signals]> = []
  const sweeper = new HermesOrphanSweeper({
    maxAgeMs: 10_000,
    listProcesses: async () => snapshot,
    protectedBrowserPids: () => new Set([200]),
    signalGroup: (pgid, signal) => signals.push([pgid, signal]),
    wait: async () => {},
  })

  const result = await sweeper.sweep()
  assert.deepEqual(result.staleBrowserGroups, [])
  assert.deepEqual(signals, [])
})

test('escalates to SIGKILL when the process group survives grace', async () => {
  let reads = 0
  const snapshot = [row({})]
  const signals: Array<[number, NodeJS.Signals]> = []
  const sweeper = new HermesOrphanSweeper({
    maxAgeMs: 10_000,
    killGraceMs: 1,
    ownProcessGroupId: 999,
    listProcesses: async () => {
      reads += 1
      return reads <= 2 ? snapshot : []
    },
    signalGroup: (pgid, signal) => signals.push([pgid, signal]),
    wait: async () => {},
  })

  const result = await sweeper.sweep()
  assert.deepEqual(signals, [[100, 'SIGTERM'], [100, 'SIGKILL']])
  assert.deepEqual(result.killedGroups, [100])
})
