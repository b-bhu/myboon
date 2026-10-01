import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  operatorEvidence,
  operatorPacket,
  operatorSignal,
  operatorWork,
} from '../signal-platform/operator-fixtures.test-support'
import { SqliteSignalPlatformStore } from '../signal-platform/sqlite-platform-store'
import {
  assessResearchReadiness,
  validateResearchReadinessLinkage,
} from '../signal-platform/research-readiness'
import { adaptCanonicalResearchPacket } from './canonical-packet-adapter'
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

test('the concrete port returns the saved readiness plus the linkage it can be validated against', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'entity-handoff-'))
  const store = new SqliteSignalPlatformStore(join(dir, 'news.sqlite'), 'news')
  try {
    // An attributed partial packet, the Ethena shape: valid, useful, and partial.
    const signal = operatorSignal('news', 'handoff')
    const evidence = operatorEvidence('handoff')
    const packet = operatorPacket('news', 'handoff', {
      completion: 'partial',
      claims: [{
        claimId: 'claim-handoff', claim: 'Ethena expanded USDe backing beyond crypto.',
        attributedTo: 'Ethena', evidenceRefs: ['evidence-handoff'],
      }],
      limitations: ['No independent verification of the backing claim.'],
      openQuestions: ['Which US enterprise payments partner is named?'],
    })
    const leased = operatorWork('news', 'handoff', {
      status: 'synthesis_leased', attemptCount: 1,
      leaseOwner: 'research-worker', leaseId: 'research-lease',
      leaseExpiresAt: '2026-08-26T12:05:00.000Z',
    })
    store.appendSignal(signal)
    store.admitResearchWork(leased)
    store.appendEvidence(evidence)

    // The decision is saved through the atomic handoff, never standalone.
    const readiness = assessResearchReadiness({
      work: leased, signal, packet, persistedEvidence: [evidence], assessedAt: '2026-08-26T11:00:00.000Z',
    })
    assert.equal(readiness.outcome, 'ready_for_entity')
    const commit = store.commitResearchHandoff({
      packet, readiness,
      fence: { workId: leased.workId, leaseOwner: 'research-worker', leaseId: 'research-lease' },
      now: '2026-08-26T11:00:00.000Z',
    })
    assert.equal(commit.committed, true)
    assert.equal(commit.workStatus, 'entity_pending')

    const port = new SqliteEntityPacketWorkPort(store)
    const context = await port.readHandoffContext('work-handoff')

    // The saved decision and every record it describes come back in one read.
    assert.equal(context.readiness?.readinessId, readiness.readinessId)
    assert.equal(context.readiness?.outcome, 'ready_for_entity')
    assert.equal(context.readiness?.entityAction.kind, 'entity_item')
    assert.equal(context.work?.workId, 'work-handoff')
    assert.equal(context.work?.status, 'entity_pending')
    assert.equal(context.signal?.signalId, 'signal-handoff')
    assert.deepEqual(context.persistedEvidence.map((item) => item.evidenceId), ['evidence-handoff'])

    // The returned linkage genuinely validates the decision, so the Entity
    // adapter can consume it rather than re-judge sufficiency.
    assert.equal(validateResearchReadinessLinkage({
      readiness: context.readiness!, work: context.work!, signal: context.signal!,
      packet, persistedEvidence: context.persistedEvidence,
    }), null)
    const adapted = adaptCanonicalResearchPacket(packet, undefined, {
      work: context.work!, signal: context.signal!,
      persistedEvidence: context.persistedEvidence, readiness: context.readiness,
    })
    assert.equal(adapted.context.completion, 'partial')
    assert.equal(adapted.context.adapter_version, 'myboon.entity_packet_adapter.v2')
    assert.equal((adapted.context.research_readiness as typeof readiness).outcome, 'ready_for_entity')
  } finally {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the concrete port reports no readiness for a packet saved before the decision existed', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'entity-handoff-legacy-'))
  const store = new SqliteSignalPlatformStore(join(dir, 'news.sqlite'), 'news')
  try {
    store.appendSignal(operatorSignal('news', 'legacy'))
    store.admitResearchWork(operatorWork('news', 'legacy', { status: 'entity_pending' }))
    store.appendResearchPacket(operatorPacket('news', 'legacy', { completion: 'partial' }))
    const port = new SqliteEntityPacketWorkPort(store)

    const context = await port.readHandoffContext('work-legacy')
    // D1: an old incomplete packet with no saved decision reports none, so the
    // worker falls back to the legacy rule instead of auto-admitting it.
    assert.equal(context.readiness, null)
    assert.equal(context.work?.workId, 'work-legacy')
  } finally {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
