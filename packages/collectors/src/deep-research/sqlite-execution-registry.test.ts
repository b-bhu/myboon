import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { SqliteSignalPlatformStore } from '../signal-platform/sqlite-platform-store'
import {
  SqliteDeepResearchExecutionRegistry,
  auditDeepResearchOrphans,
} from './sqlite-execution-registry'
import type { DeepResearchExecutionMetadata } from './types'

const METADATA: DeepResearchExecutionMetadata = {
  jobId: 'job-1', workId: 'work-1', traceId: 'trace-1', sourceType: 'news', unitName: 'myboon-deep-work-1.service',
  startedAt: '2026-08-26T12:00:00.000Z', deadlineAt: '2026-08-26T12:05:00.000Z',
  tempPath: '/tmp/myboon-deep-1', profilePath: '/tmp/myboon-deep-1/profile',
}

test('SQLite registry persists active execution metadata and registration is idempotent', () => {
  const dir = mkdtempSync(join(tmpdir(), 'deep-registry-'))
  const path = join(dir, 'registry.sqlite')
  try {
    const first = new SqliteDeepResearchExecutionRegistry(path)
    first.register(METADATA)
    first.register(METADATA)
    first.close()
    const readOnly = new SqliteDeepResearchExecutionRegistry(path, { readOnly: true })
    assert.deepEqual(readOnly.list(), [METADATA])
    assert.throws(() => readOnly.unregister(METADATA.unitName), /readonly|read-only/i)
    readOnly.close()
    const reopened = new SqliteDeepResearchExecutionRegistry(path)
    assert.deepEqual(reopened.list(), [METADATA])
    assert.throws(() => reopened.register({ ...METADATA, workId: 'different' }), /Conflicting/)
    reopened.unregister(METADATA.unitName)
    assert.deepEqual(reopened.list(), [])
    reopened.close()
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('orphan audit is read-only and reports active, filesystem, and deadline state', async () => {
  const registry = { list: () => [METADATA] }
  const snapshot = await auditDeepResearchOrphans({
    registry,
    systemd: { isUnitActive: async () => true },
    pathExists: async () => true,
    now: () => new Date('2026-08-26T12:06:00.000Z'),
  })
  assert.equal(snapshot.registeredExecutions, 1)
  assert.deepEqual(snapshot.entries[0], {
    metadata: METADATA, unitActive: true, tempPathPresent: true,
    deadlineExpired: true, auditError: null,
  })
  assert.deepEqual(registry.list(), [METADATA])
})

test('read-only source-local audit treats an absent registry table as empty without creating it', () => {
  const dir = mkdtempSync(join(tmpdir(), 'deep-source-local-audit-'))
  const path = join(dir, 'news.sqlite')
  try {
    const canonical = new SqliteSignalPlatformStore(path, 'news')
    canonical.close()
    const registry = new SqliteDeepResearchExecutionRegistry(path, { readOnly: true })
    assert.deepEqual(registry.list(), [])
    registry.close()
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
