import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { PlatformFailure } from '../signal-platform/failures'
import {
  EntityShadowObservationConflictError,
  SqliteEntityShadowObservationStore,
} from './sqlite-shadow-observation-store'

const NOW = '2026-08-26T12:00:00.000Z'

test('SQLite shadow observations are durable, idempotent, separate, and redacted', () => {
  const directory = mkdtempSync(join(tmpdir(), 'myboon-entity-shadow-observations-'))
  const path = join(directory, 'shadow.sqlite')
  try {
    let clock = NOW
    const first = new SqliteEntityShadowObservationStore(path, () => new Date(clock))
    const observation = {
      sourceType: 'news' as const,
      workId: 'work-1',
      packetId: null,
      outcome: 'rejected' as const,
      error: new PlatformFailure({
        category: 'storage_transient',
        message: 'Authorization: Bearer secret raw evidence text',
        retryable: true,
      }),
      executionEvent: null,
    }
    const inserted = first.append(observation)
    clock = '2026-08-26T12:05:00.000Z'
    const replay = first.append(observation)
    assert.equal(inserted.inserted, true)
    assert.equal(replay.inserted, false)
    assert.equal(replay.value.observedAt, NOW)
    assert.doesNotMatch(JSON.stringify(inserted.value), /Bearer|secret|raw evidence/i)
    first.close()

    const reopened = new SqliteEntityShadowObservationStore(path)
    assert.deepEqual(reopened.get(inserted.value.observationId), inserted.value)
    assert.deepEqual(reopened.listByWork('work-1'), [inserted.value])
    assert.throws(() => reopened.append({
      ...observation,
      error: new PlatformFailure({
        category: 'storage_transient', message: 'different semantics', retryable: false,
      }),
    }), (
      error: unknown,
    ) => error instanceof EntityShadowObservationConflictError)
    reopened.close()
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
