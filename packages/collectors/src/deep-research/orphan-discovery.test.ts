import assert from 'node:assert/strict'
import test from 'node:test'
import { discoverDeepResearchOrphans } from './orphan-discovery'
import type { DeepResearchExecutionMetadata } from './types'

const registered: DeepResearchExecutionMetadata = {
  jobId: 'job-1', workId: 'work-1', traceId: 'trace-1', sourceType: 'news',
  unitName: 'myboon-deep-registered.service', startedAt: '2026-08-26T11:00:00.000Z',
  deadlineAt: '2026-08-26T11:30:00.000Z', tempPath: '/scratch/myboon-deep-registered',
  profilePath: '/profiles/myboon-deep-registered',
}

test('bounded orphan discovery reports unregistered units, roots, and sandbox executors without command prose', async () => {
  const snapshot = await discoverDeepResearchOrphans({
    registered: [registered], tempRoots: ['/scratch'], profileRoots: ['/profiles'],
    sandboxExecutables: ['/opt/deep-worker'], limit: 10,
    inspector: {
      listTransientUnits: async () => [registered.unitName, 'myboon-deep-unregistered.service', 'myboon-deep-dotted_work.service'],
      listRootEntries: async (root) => root === '/scratch'
        ? ['myboon-deep-registered', 'myboon-deep-stale'] : ['myboon-deep-profile-stale'],
      listSandboxExecutors: async () => [
        { pid: 10, argv: `/opt/deep-worker ${registered.tempPath}/job.json` },
        { pid: 11, argv: '/opt/deep-worker --secret must-not-persist' },
      ],
    },
    now: () => new Date('2026-08-26T12:00:00.000Z'),
  })
  assert.equal(snapshot.activeExecutions, 1)
  assert.equal(snapshot.suspectedOrphans, 6)
  assert.deepEqual(snapshot.unregisteredArtifacts.map((item) => item.kind).sort(), [
    'profile_directory', 'sandbox_executor', 'temp_directory', 'transient_unit', 'transient_unit',
  ])
  assert.doesNotMatch(JSON.stringify(snapshot), /secret|\/opt\/deep-worker|\/scratch/)
})

test('denied inspection is incomplete and redacted instead of claiming a clean audit', async () => {
  const snapshot = await discoverDeepResearchOrphans({
    registered: [], tempRoots: ['/scratch'], profileRoots: ['/profiles'], sandboxExecutables: ['/worker'], limit: 5,
    inspector: {
      listTransientUnits: async () => { throw new Error('permission denied: credential') },
      listRootEntries: async () => { throw new Error('EACCES /private') },
      listSandboxExecutors: async () => { throw new Error('denied') },
    },
  })
  assert.equal(snapshot.incomplete, true)
  assert.deepEqual([...snapshot.errors].sort(), [
    'profile_directory_inspection_failed', 'sandbox_executor_inspection_failed',
    'temp_directory_inspection_failed', 'transient_unit_inspection_failed',
  ])
  assert.doesNotMatch(JSON.stringify(snapshot), /credential|\/private/)
})

test('one physical workspace/profile root is scanned once without flagging a registered nested profile', async () => {
  let rootScans = 0
  const nested = { ...registered, profilePath: `${registered.tempPath}/profile` }
  const snapshot = await discoverDeepResearchOrphans({
    registered: [nested], tempRoots: ['/scratch'], profileRoots: ['/scratch'],
    sandboxExecutables: [], limit: 5,
    inspector: {
      listTransientUnits: async () => [nested.unitName],
      listRootEntries: async () => { rootScans += 1; return ['myboon-deep-registered'] },
      listSandboxExecutors: async () => [],
    },
    now: () => new Date('2026-08-26T11:10:00.000Z'),
  })
  assert.equal(rootScans, 1)
  assert.equal(snapshot.suspectedOrphans, 0)
  assert.deepEqual(snapshot.unregisteredArtifacts, [])
})
