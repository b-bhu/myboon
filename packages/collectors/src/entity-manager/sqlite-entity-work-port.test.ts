import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  operatorPacket,
  operatorSignal,
  operatorWork,
} from '../signal-platform/operator-fixtures.test-support'
import { SqliteSignalPlatformStore } from '../signal-platform/sqlite-platform-store'
import { SqliteEntityPacketWorkPort } from './sqlite-entity-work-port'

test('SQLite Entity work port reads the canonical packet and delegates fenced lease operations', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'entity-work-port-'))
  const store = new SqliteSignalPlatformStore(join(dir, 'news.sqlite'), 'news')
  try {
    store.appendSignal(operatorSignal('news', 'entity'))
    store.admitResearchWork(operatorWork('news', 'entity', { status: 'entity_pending' }))
    store.appendResearchPacket(operatorPacket('news', 'entity'))
    const port = new SqliteEntityPacketWorkPort(store)

    const pending = await port.peekSchedulable({
      now: '2026-08-26T12:00:00.000Z', limit: 1, stages: ['entity'],
    })
    assert.deepEqual(pending.map((item) => item.workId), ['work-entity'])
    assert.equal((await port.readResearchPacket('work-entity'))?.packetId, 'packet-entity')

    const lease = await port.claimWithLease({
      workId: 'work-entity', expectedStatus: 'entity_pending', leaseOwner: 'entity-worker',
      leaseId: 'entity-lease', leaseExpiresAt: '2026-08-26T12:01:00.000Z',
      now: '2026-08-26T12:00:00.000Z',
    })
    assert.equal(lease?.work.status, 'entity_leased')
    assert.equal(lease?.queuedAt, '2026-08-26T11:00:00.000Z')
    assert.equal(await port.transitionLeased({
      workId: 'work-entity', leaseOwner: 'entity-worker', leaseId: 'entity-lease',
      expectedStatus: 'entity_leased', nextStatus: 'complete', attemptDelta: 1,
      now: '2026-08-26T12:00:10.000Z',
    }), true)
  } finally {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
