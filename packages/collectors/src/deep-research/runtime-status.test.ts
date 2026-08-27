import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { AtomicDeepResearchRuntimeStatusFile, deepResearchRuntimeSnapshot } from './runtime-status'

test('deep runtime status publishes an atomic private redacted snapshot', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'deep-runtime-status-'))
  try {
    const path = join(dir, 'status.json')
    const snapshot = deepResearchRuntimeSnapshot({ enabled: true, audit: {
      auditedAt: '2026-08-26T12:00:00.000Z', activeExecutions: 2, suspectedOrphans: 1,
      unregisteredArtifacts: [{ kind: 'sandbox_executor', identifier: 'pid:9' }],
      incomplete: true, errors: ['sandbox_executor_inspection_failed'],
    }, now: () => new Date('2026-08-26T12:00:01.000Z') })
    await new AtomicDeepResearchRuntimeStatusFile(path).write(snapshot)
    assert.equal(statSync(path).mode & 0o777, 0o600)
    assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), snapshot)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
