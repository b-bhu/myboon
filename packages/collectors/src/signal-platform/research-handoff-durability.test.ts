import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  RESEARCH_PACKET_SCHEMA_VERSION,
  RESEARCH_WORK_SCHEMA_VERSION,
  RETRIEVED_EVIDENCE_SCHEMA_VERSION,
  SIGNAL_SCHEMA_VERSION,
  type ResearchPacketV1,
  type ResearchWorkItem,
  type RetrievedEvidence,
  type Signal,
} from './contracts'
import { ImmutableRecordConflictError } from './platform-store'
import { SqliteSignalPlatformStore } from './sqlite-platform-store'
import {
  NO_RESEARCH_ENTITY_ACTION,
  assessResearchReadiness,
  createBlockedReadiness,
  createReadinessUnknownReadiness,
  createResolvedWithoutNewItemReadiness,
  type ResearchEntityAction,
  type ResearchReadinessV1,
  validateResearchReadiness,
} from './research-readiness'
import { canonicalJson } from './canonical-json'

const NOW = '2026-08-26T12:00:00.000Z'
const ASSESSED_AT = '2026-08-26T12:00:05.000Z'

const nodeRequire = createRequire(__filename)
const { DatabaseSync } = nodeRequire('node:sqlite') as {
  DatabaseSync: new (path: string) => {
    exec(sql: string): void
    prepare(sql: string): { run(...params: unknown[]): unknown }
    close(): void
  }
}

function signal(): Signal {
  return {
    schemaVersion: SIGNAL_SCHEMA_VERSION, signalId: 'signal-1', sourceType: 'news',
    sourceId: 'news:source:1', contentKind: 'article',
    content: { schemaVersion: 'myboon.signal_content.article.v1' },
    observedAt: '2026-08-26T11:00:00.000Z', publishedAt: '2026-08-26T10:55:00.000Z',
    canonicalUrl: 'https://example.com/ethena', title: 'Ethena article',
    visibleSummary: 'Summary', media: { imageUrl: null, attribution: null },
    sourceHints: { entities: [], assets: [], eventId: null, deadline: null },
    provenance: { provider: 'fixture', upstreamSource: null, rawPayloadRef: 'raw-1' },
    idempotencyKey: 'news:key:1',
  } as Signal
}

function work(overrides: Partial<ResearchWorkItem> = {}): ResearchWorkItem {
  return {
    schemaVersion: RESEARCH_WORK_SCHEMA_VERSION, workId: 'work-1', signalId: 'signal-1',
    sourceType: 'news', researchDepth: 'standard', deepReason: null,
    priorityClass: 'P1', priorityScore: 0.5, freshnessDeadline: '2026-08-26T18:00:00.000Z',
    policyVersion: 'policy.v1', researchContractVersion: RESEARCH_PACKET_SCHEMA_VERSION,
    retrievalPlan: { sourceUrl: 'https://example.com/ethena', allowedDomains: ['example.com'], maxExternalSources: 2 },
    budget: { maxProviderCalls: 2, maxRepairCalls: 1, maxToolCalls: 0, maxWallTimeMs: 30_000 },
    status: 'synthesis_leased', attemptCount: 1, nextAttemptAt: null,
    leaseOwner: 'worker-1', leaseId: 'lease-1', leaseExpiresAt: '2026-08-26T12:05:00.000Z',
    failureCategory: null, failureDetail: null, traceId: 'trace-1',
    createdAt: '2026-08-26T11:30:00.000Z', updatedAt: '2026-08-26T11:59:00.000Z',
    ...overrides,
  }
}

function evidence(): RetrievedEvidence {
  return {
    schemaVersion: RETRIEVED_EVIDENCE_SCHEMA_VERSION, evidenceId: 'evidence-1', workId: 'work-1',
    requestedUrl: 'https://example.com/ethena', finalUrl: 'https://example.com/ethena',
    authority: 'source_url', authorityId: 'signal-1', contentHash: 'hash-1',
    contentType: 'text/html', httpStatus: 200, retrievalMethod: 'safe_http',
    retrievedAt: NOW, text: 'Body', truncated: false, byteLength: 100,
  }
}

function packet(overrides: Partial<ResearchPacketV1> = {}): ResearchPacketV1 {
  return {
    schemaVersion: RESEARCH_PACKET_SCHEMA_VERSION, packetId: 'packet-1', workId: 'work-1',
    signalId: 'signal-1', sourceType: 'news', observedAt: '2026-08-26T11:00:00.000Z',
    sourceSignal: {
      title: 'Ethena article', canonicalUrl: 'https://example.com/ethena',
      publishedAt: '2026-08-26T10:55:00.000Z',
      provenance: { provider: 'fixture', upstreamSource: null, rawPayloadRef: 'raw-1' },
    },
    claims: [{ claimId: 'claim-1', claim: 'Ethena expanded USDe backing.', attributedTo: 'Ethena', evidenceRefs: ['evidence-1'] }],
    verifiedFacts: [],
    unresolvedClaims: [],
    evidence: [{ evidenceId: 'evidence-1', title: 'Ethena article', url: 'https://example.com/ethena', sourceType: 'source_url', observedAt: NOW, note: null }],
    entityHints: [],
    limitations: ['No independent verification.'],
    openQuestions: ['Which partner?'],
    completion: 'partial',
    budgetUsed: { providerCalls: 1, repairCalls: 0, inputTokens: 10, outputTokens: 5, toolCalls: 0, wallTimeMs: 10, budgetExceeded: false },
    execution: {
      provider: 'fixture', model: 'fixture-model', fallbackProvider: null, fallbackModel: null,
      fallbackUsed: false, promptVersion: 'prompt.v1', policyVersion: 'policy.v1',
      traceId: 'trace-1', attempt: 1,
    },
    researchContractVersion: RESEARCH_PACKET_SCHEMA_VERSION,
    createdAt: NOW,
    ...overrides,
  }
}

/** The fenced owner/lease a live synthesis attempt commits under. */
function fence(overrides: Partial<ResearchWorkItem> = {}): {
  workId: string, leaseOwner: string, leaseId: string
} {
  const item = work(overrides)
  return { workId: item.workId, leaseOwner: item.leaseOwner!, leaseId: item.leaseId! }
}

function open(): { store: SqliteSignalPlatformStore, path: string, close(): void } {
  const directory = mkdtempSync(join(tmpdir(), 'myboon-handoff-'))
  const path = join(directory, 'news.sqlite')
  const store = new SqliteSignalPlatformStore(path, 'news')
  return { store, path, close: () => { store.close(); rmSync(directory, { recursive: true, force: true }) } }
}

/**
 * Remove a row the store already appended.
 *
 * This is deliberately not a store capability: it simulates a decision whose
 * described records are not the persisted ones, which is exactly the state the
 * in-transaction linkage guard has to catch.
 */
function deleteStoredRow(path: string, table: string, column: string, value: string): void {
  const db = new DatabaseSync(path)
  try {
    // Foreign keys are off on this throwaway connection so a dependent row can
    // be removed to simulate a decision whose described record is not stored.
    db.exec('PRAGMA foreign_keys = OFF')
    db.prepare(`DELETE FROM ${table} WHERE ${column} = ?`).run(value)
  } finally {
    db.close()
  }
}

function deletePersistedEvidence(path: string, evidenceId: string): void {
  deleteStoredRow(path, 'signal_platform_evidence', 'evidence_id', evidenceId)
}

/** Seed a leased synthesis work item with its persisted evidence. */
function seedLeased(store: SqliteSignalPlatformStore, item: ResearchWorkItem = work()): void {
  store.appendSignal(signal())
  store.admitResearchWork(item)
  store.appendEvidence(evidence())
}

function readinessFor(
  stored: SqliteSignalPlatformStore,
  item: ResearchWorkItem = work(),
  source: ResearchPacketV1 = packet(),
): ResearchReadinessV1 {
  return assessResearchReadiness({
    work: item, signal: signal(), packet: source,
    persistedEvidence: stored.listEvidenceByWork(item.workId, 10),
    assessedAt: ASSESSED_AT,
  })
}

test('the packet, decision, and work status commit together as one transaction', () => {
  const fx = open()
  try {
    seedLeased(fx.store)
    const item = work()
    const source = packet()
    const result = fx.store.commitResearchHandoff({
      packet: source, readiness: readinessFor(fx.store), fence: fence(), now: ASSESSED_AT,
    })
    assert.equal(result.committed, true)
    assert.equal(result.replayed, false)
    assert.equal(result.packet.inserted, true)
    assert.equal(result.readiness.inserted, true)
    assert.equal(result.workStatus, 'entity_pending')
    assert.equal(fx.store.getResearchWork('work-1')?.status, 'entity_pending')
    assert.equal(fx.store.getResearchReadinessByWork('work-1')?.outcome, 'ready_for_entity')
    assert.equal(fx.store.getResearchReadinessByPacket('packet-1')?.workId, 'work-1')
    // The work row carries only the typed outcome, never assessment prose.
    assert.equal(fx.store.getResearchWork('work-1')?.failureDetail, null)
  } finally { fx.close() }
})

test('a lost fence writes nothing: no packet, no decision, no status change', () => {
  const fx = open()
  try {
    seedLeased(fx.store)
    const result = fx.store.commitResearchHandoff({
      packet: packet(), readiness: readinessFor(fx.store), fence: fence({ leaseId: 'lease-stale' }), now: ASSESSED_AT,
    })
    assert.equal(result.committed, false)
    assert.equal(result.packet.inserted, false)
    assert.equal(result.readiness.inserted, false)
    assert.equal(fx.store.listResearchPacketsByWork('work-1', 10).length, 0)
    assert.equal(fx.store.getResearchReadinessByWork('work-1'), null)
    assert.equal(fx.store.getResearchWork('work-1')?.status, 'synthesis_leased')
  } finally { fx.close() }
})

test('an expired lease cannot commit a handoff', () => {
  const fx = open()
  try {
    seedLeased(fx.store)
    // The lease is still owned but has already elapsed at commit time.
    const result = fx.store.commitResearchHandoff({
      packet: packet(), readiness: readinessFor(fx.store), fence: fence(), now: '2026-08-26T13:00:00.000Z',
    })
    assert.equal(result.committed, false)
    assert.equal(fx.store.getResearchReadinessByWork('work-1'), null)
    assert.equal(fx.store.getResearchWork('work-1')?.status, 'synthesis_leased')
  } finally { fx.close() }
})

test('a non-ready outcome keeps its packet and evidence and stays non-claimable', () => {
  const fx = open()
  try {
    seedLeased(fx.store)
    const failed = packet({ completion: 'failed' })
    const readiness = readinessFor(fx.store, work(), failed)
    const result = fx.store.commitResearchHandoff({
      packet: failed, readiness, fence: fence(), now: ASSESSED_AT,
    })
    assert.equal(result.committed, true)
    assert.equal(result.workStatus, 'dead_letter')
    // Artifacts are retained, not discarded, so an operator can inspect them.
    assert.equal(fx.store.listResearchPacketsByWork('work-1', 10).length, 1)
    assert.equal(fx.store.listEvidenceByWork('work-1', 10).length, 1)
    assert.equal(fx.store.getResearchReadinessByWork('work-1')?.outcome, 'failed')
    assert.equal(fx.store.getResearchWork('work-1')?.status, 'dead_letter')
    assert.equal(fx.store.getResearchWork('work-1')?.failureDetail, 'readiness:failed')
    // dead_letter is not schedulable, so there is no hidden retry loop.
    assert.equal(fx.store.getResearchWork('work-1')?.leaseId, null)
  } finally { fx.close() }
})

test('a deliberate no-action result performs no Entity mutation', async () => {
  const fx = open()
  try {
    seedLeased(fx.store)
    const readiness = createResolvedWithoutNewItemReadiness({
      work: work(), signal: signal(), packet: packet(),
      persistedEvidence: [evidence()], assessedAt: ASSESSED_AT,
      reason: 'Already represented by an accepted managed item.',
    })
    const result = fx.store.commitResearchHandoff({
      packet: packet(), readiness, fence: fence(), now: ASSESSED_AT,
    })
    assert.equal(result.committed, true)
    assert.equal(result.workStatus, 'complete')
    assert.equal(fx.store.getResearchWork('work-1')?.status, 'complete')
    assert.deepEqual(fx.store.getResearchReadinessByWork('work-1')?.entityAction, NO_RESEARCH_ENTITY_ACTION)
    // A deliberate no-action result leaves no claimable Entity work.
    const schedulable = await fx.store.peekSchedulable({
      now: ASSESSED_AT, limit: 10, stages: ['entity'],
    })
    assert.deepEqual(schedulable, [])
  } finally { fx.close() }
})

test('a no-new-item result that owes an attachment stays claimable with its target preserved', async () => {
  const fx = open()
  try {
    seedLeased(fx.store)
    const readiness = createResolvedWithoutNewItemReadiness({
      work: work(), signal: signal(), packet: packet(),
      persistedEvidence: [evidence()], assessedAt: ASSESSED_AT,
      reason: 'Already covered, but the source must still be attached.',
      owedAttachment: { targetId: 'managed-item-42' },
    })
    const result = fx.store.commitResearchHandoff({
      packet: packet(), readiness, fence: fence(), now: ASSESSED_AT,
    })
    assert.equal(result.committed, true)
    // The owed action is preserved rather than collapsed into the no-item result.
    assert.equal(result.workStatus, 'entity_pending')
    const saved = fx.store.getResearchReadinessByWork('work-1')
    assert.equal(saved?.outcome, 'resolved_without_new_item')
    // The owed action is preserved rather than collapsed into the no-item result.
    const action: ResearchEntityAction | undefined = saved?.entityAction
    assert.equal(action?.kind, 'evidence_attachment')
    assert.equal(action?.targetId, 'managed-item-42')
    // It remains claimable, so the Entity stage schedules it. Whether the
    // attachment is actually performed is the Entity processor's concern.
    const schedulable = await fx.store.peekSchedulable({
      now: ASSESSED_AT, limit: 10, stages: ['entity'],
    })
    assert.deepEqual(schedulable.map((row: ResearchWorkItem) => row.workId), ['work-1'])
  } finally { fx.close() }
})

test('a ready result creates exactly one claimable Entity action', async () => {
  const fx = open()
  try {
    seedLeased(fx.store)
    fx.store.commitResearchHandoff({
      packet: packet(), readiness: readinessFor(fx.store), fence: fence(), now: ASSESSED_AT,
    })
    const schedulable = await fx.store.peekSchedulable({
      now: ASSESSED_AT, limit: 10, stages: ['entity'],
    })
    assert.deepEqual(schedulable.map((row: ResearchWorkItem) => row.workId), ['work-1'])
  } finally { fx.close() }
})

test('replaying the same handoff is idempotent and cannot fork a second decision', () => {
  const fx = open()
  try {
    seedLeased(fx.store)
    const readiness = readinessFor(fx.store)
    const first = fx.store.commitResearchHandoff({
      packet: packet(), readiness, fence: fence(), now: ASSESSED_AT,
    })
    assert.equal(first.committed, true)
    // Re-entry with the same lease fence no longer matches the moved status.
    const second = fx.store.commitResearchHandoff({
      packet: packet(), readiness, fence: fence(), now: ASSESSED_AT,
    })
    assert.equal(second.committed, false)
    assert.equal(second.readiness.inserted, false)
    assert.equal(fx.store.listResearchPacketsByWork('work-1', 10).length, 1)
    const saved = fx.store.getResearchReadinessByWork('work-1')
    assert.ok(saved)
    assert.equal(canonicalJson(saved), canonicalJson(readiness))
  } finally { fx.close() }
})

test('a saved decision can never be forked or overwritten by a later atomic attempt', async () => {
  const fx = open()
  try {
    seedLeased(fx.store)
    const committed = readinessFor(fx.store)
    const first = fx.store.commitResearchHandoff({
      packet: packet(), readiness: committed, fence: fence(), now: ASSESSED_AT,
    })
    assert.equal(first.committed, true)
    assert.equal(first.replayed, false)

    // A contradicting decision for the same work can only be attempted through an
    // atomic handoff, and the atomic handoff is fenced: once the winning decision
    // has moved the work off `synthesis_leased`, no second decision can land.
    const conflicting = createReadinessUnknownReadiness({
      work: work(), signal: signal(), packet: packet(), persistedEvidence: [evidence()],
      assessedAt: '2026-08-26T12:30:00.000Z', reason: 'A later assessor disagreed.',
    })
    assert.notEqual(canonicalJson(conflicting), canonicalJson(committed))
    const second = fx.store.commitResearchHandoff({
      packet: packet(), readiness: conflicting, fence: fence(), now: '2026-08-26T12:30:00.000Z',
    })
    assert.equal(second.committed, false)
    // The bridge finds nothing left to promote, for the same reason.
    assert.equal(
      fx.store.promoteResearchReadyWithReadiness({
        workId: 'work-1', readiness: conflicting, now: '2026-08-26T12:30:00.000Z',
      }),
      null,
    )
    // The winning decision is byte-identical and was never replaced.
    assert.equal(
      canonicalJson(fx.store.getResearchReadinessByWork('work-1')), canonicalJson(committed),
    )
    assert.equal(fx.store.listResearchPacketsByWork('work-1', 10).length, 1)
    assert.equal(fx.store.getResearchWork('work-1')?.status, 'entity_pending')
  } finally { fx.close() }
})

test('a conflicting packet rolls the whole handoff back, leaving no orphaned decision', () => {
  const fx = open()
  try {
    seedLeased(fx.store)
    // A packet is already durable for this work under a different payload, which
    // is exactly the immutable-conflict case the append guard exists for.
    fx.store.appendResearchPacket(packet({ limitations: ['Already saved.'] }))
    // Only the budget usage differs, so this reaches the immutable-conflict
    // guard rather than being rejected earlier as a linkage mismatch.
    const base = packet()
    const conflictingPacket = packet({
      ...base,
      budgetUsed: { ...base.budgetUsed, outputTokens: base.budgetUsed.outputTokens + 1 },
    })
    assert.throws(
      () => fx.store.commitResearchHandoff({
        packet: conflictingPacket, readiness: readinessFor(fx.store), fence: fence(), now: ASSESSED_AT,
      }),
      (error: unknown) => error instanceof ImmutableRecordConflictError && error.recordType === 'packet',
    )
    // The decision was appended before the conflict was raised, so this proves
    // the whole unit rolled back: no orphaned readiness, no moved work status.
    assert.equal(fx.store.getResearchReadinessByWork('work-1'), null)
    assert.equal(fx.store.getResearchReadinessByPacket('packet-1'), null)
    assert.equal(fx.store.getResearchWork('work-1')?.status, 'synthesis_leased')
    // The originally saved packet is untouched.
    assert.deepEqual(fx.store.listResearchPacketsByWork('work-1', 10)[0]?.limitations, ['Already saved.'])
  } finally { fx.close() }
})

test('a readiness is never persisted without its atomic work-status handoff', () => {
  const fx = open()
  try {
    seedLeased(fx.store)
    const readiness = readinessFor(fx.store)
    // There is no public standalone readiness write on the store, so the only
    // reachable path to a saved decision is the atomic handoff.
    assert.equal('appendResearchReadiness' in fx.store, false)
    assert.equal(fx.store.getResearchReadinessByWork('work-1'), null)
    fx.store.commitResearchHandoff({
      packet: packet(), readiness, fence: fence(), now: ASSESSED_AT,
    })
    // A saved decision always has the work status that admits it.
    assert.ok(fx.store.getResearchReadinessByWork('work-1'))
    assert.equal(fx.store.getResearchWork('work-1')?.status, 'entity_pending')
  } finally { fx.close() }
})

test('readiness and packet linkage is validated before anything is written', () => {
  const fx = open()
  try {
    seedLeased(fx.store)
    const readiness = readinessFor(fx.store)
    assert.throws(() => fx.store.commitResearchHandoff({
      packet: packet({ packetId: 'packet-other' }), readiness, fence: fence(), now: ASSESSED_AT,
    }), /does not match its packet linkage/)
    assert.throws(() => fx.store.commitResearchHandoff({
      packet: packet(), readiness, fence: { workId: 'work-other', leaseOwner: 'worker-1', leaseId: 'lease-1' }, now: ASSESSED_AT,
    }), /does not match the fenced work item/)
    assert.equal(fx.store.listResearchPacketsByWork('work-1', 10).length, 0)
    assert.equal(fx.store.getResearchReadinessByWork('work-1'), null)
  } finally { fx.close() }
})

test('a blocked decision and its bounded retry deadline commit together', async () => {
  const fx = open()
  try {
    seedLeased(fx.store)
    const blocked = createBlockedReadiness({
      work: work(), signal: signal(), packet: packet(), persistedEvidence: [evidence()],
      assessedAt: ASSESSED_AT, reason: 'A usable source was missing.',
      failureCategory: 'retrieval_timeout', blockedDependency: 'primary source host',
    })
    const deadline = '2026-08-26T12:00:30.000Z'
    const result = fx.store.commitResearchHandoff({
      packet: packet(), readiness: blocked, fence: fence(), now: ASSESSED_AT,
      retry: { attemptCount: 1, maxAttempts: 3, expired: false, nextAttemptAt: deadline },
    })
    assert.equal(result.committed, true)
    // blocked is not successful completion: it waits for its bounded retry.
    assert.equal(result.workStatus, 'retry_wait')
    const saved = fx.store.getResearchWork('work-1')
    // The retry deadline is persisted in the same transaction as the decision,
    // so the saved readiness is never left disconnected from its work status.
    assert.equal(saved?.status, 'retry_wait')
    assert.equal(saved?.nextAttemptAt, deadline)
    assert.equal(saved?.retryTargetStatus, 'synthesis_pending')
    assert.equal(saved?.failureCategory, 'retrieval_timeout')
    assert.equal(saved?.failureDetail, 'readiness:blocked')
    // Artifacts are retained for operator triage.
    assert.equal(fx.store.getResearchReadinessByWork('work-1')?.outcome, 'blocked')
    assert.equal(fx.store.listResearchPacketsByWork('work-1', 10).length, 1)
    assert.equal(fx.store.listEvidenceByWork('work-1', 10).length, 1)
    // retry_wait is not claimable, so no hidden loop is created.
    assert.deepEqual(await fx.store.peekSchedulable({
      now: ASSESSED_AT, limit: 10, stages: ['entity', 'synthesis'],
    }), [])
  } finally { fx.close() }
})

test('a blocked decision with no bounded retry left becomes a held terminal row', async () => {
  const fx = open()
  try {
    seedLeased(fx.store)
    const blocked = createBlockedReadiness({
      work: work(), signal: signal(), packet: packet(), persistedEvidence: [evidence()],
      assessedAt: ASSESSED_AT, reason: 'A usable source was missing.',
      failureCategory: 'retrieval_timeout',
    })
    // Attempts are exhausted, so the existing policy leaves an explicit
    // non-claimable held result instead of retrying indefinitely.
    const result = fx.store.commitResearchHandoff({
      packet: packet(), readiness: blocked, fence: fence(), now: ASSESSED_AT,
      retry: { attemptCount: 3, maxAttempts: 3, expired: false, nextAttemptAt: null },
    })
    assert.equal(result.committed, true)
    assert.equal(result.workStatus, 'dead_letter')
    const saved = fx.store.getResearchWork('work-1')
    assert.equal(saved?.status, 'dead_letter')
    assert.equal(saved?.nextAttemptAt, null)
    assert.equal(saved?.retryTargetStatus, null)
    assert.equal(saved?.leaseId, null)
    assert.equal(saved?.failureCategory, 'retrieval_timeout')
    // The decision and its artifacts survive for operator inspection.
    assert.equal(fx.store.getResearchReadinessByWork('work-1')?.outcome, 'blocked')
    assert.equal(fx.store.listResearchPacketsByWork('work-1', 10).length, 1)
    assert.deepEqual(await fx.store.peekSchedulable({
      now: ASSESSED_AT, limit: 10, stages: ['entity', 'synthesis'],
    }), [])
  } finally { fx.close() }
})

test('a failed decision follows its own classified retryability', async () => {
  const fx = open()
  try {
    seedLeased(fx.store)
    const failed = packet({ completion: 'failed' })
    const readiness = readinessFor(fx.store, work(), failed)
    // invalid_structured_output is not retryable, so even with attempts left the
    // existing policy dead-letters rather than re-running synthesis.
    assert.equal(readiness.failureCategory, 'invalid_structured_output')
    const result = fx.store.commitResearchHandoff({
      packet: failed, readiness, fence: fence(), now: ASSESSED_AT,
      retry: { attemptCount: 1, maxAttempts: 3, expired: false, nextAttemptAt: ASSESSED_AT },
    })
    assert.equal(result.committed, true)
    assert.equal(result.workStatus, 'dead_letter')
    assert.equal(fx.store.getResearchWork('work-1')?.nextAttemptAt, null)
  } finally { fx.close() }
})

test('a failed decision with a retryable cause waits instead of dead-lettering', async () => {
  const fx = open()
  try {
    seedLeased(fx.store)
    // A transient storage fault classified as retryable must follow the existing
    // retry path, proving failed outcomes respect their classified retryability
    // in both directions rather than always terminating.
    const retryableFailure = validateResearchReadiness({
      ...readinessFor(fx.store, work(), packet({ completion: 'failed' })),
      failureCategory: 'storage_transient',
    })
    const result = fx.store.commitResearchHandoff({
      packet: packet({ completion: 'failed' }), readiness: retryableFailure,
      fence: fence(), now: ASSESSED_AT,
      retry: { attemptCount: 1, maxAttempts: 3, expired: false, nextAttemptAt: '2026-08-26T12:00:20.000Z' },
    })
    assert.equal(result.committed, true)
    assert.equal(result.workStatus, 'retry_wait')
    assert.equal(fx.store.getResearchWork('work-1')?.nextAttemptAt, '2026-08-26T12:00:20.000Z')
    assert.equal(fx.store.getResearchReadinessByWork('work-1')?.outcome, 'failed')
  } finally { fx.close() }
})

test('an unassessed legacy partial packet is never auto-admitted', async () => {
  const fx = open()
  try {
    seedLeased(fx.store)
    // D1: an old incomplete packet without a saved decision is readiness_unknown,
    // held and never auto-admitted.
    const unknown = createReadinessUnknownReadiness({
      work: work(), signal: signal(), packet: packet(), persistedEvidence: [evidence()],
      assessedAt: ASSESSED_AT, reason: 'Saved before the readiness contract existed.',
    })
    const result = fx.store.commitResearchHandoff({
      packet: packet(), readiness: unknown, fence: fence(), now: ASSESSED_AT,
      retry: { attemptCount: 0, maxAttempts: 3, expired: false, nextAttemptAt: ASSESSED_AT },
    })
    assert.equal(result.committed, true)
    // Held with no automatic historical re-assessment: no retry is scheduled.
    assert.equal(result.workStatus, 'dead_letter')
    const saved = fx.store.getResearchWork('work-1')
    assert.equal(saved?.status, 'dead_letter')
    assert.equal(saved?.nextAttemptAt, null)
    assert.equal(fx.store.getResearchReadinessByWork('work-1')?.outcome, 'readiness_unknown')
    assert.deepEqual(await fx.store.peekSchedulable({
      now: ASSESSED_AT, limit: 10, stages: ['entity'],
    }), [])
  } finally { fx.close() }
})

test('a decision assessed against a signal the store no longer holds is rejected with no writes', () => {
  const fx = open()
  try {
    seedLeased(fx.store)
    const readiness = readinessFor(fx.store)
    // The decision was assessed against a persisted signal. Removing that row
    // makes the decision's described record untrue, so the handoff must reject
    // rather than save a decision whose signal is not the stored one.
    deleteStoredRow(fx.path, 'signal_platform_signals', 'signal_id', 'signal-1')
    assert.equal(fx.store.getSignal('signal-1'), null)
    assert.throws(
      () => fx.store.commitResearchHandoff({
        packet: packet(), readiness, fence: fence(), now: ASSESSED_AT,
      }),
      /references signal signal-1 that is not stored for news/,
    )
    // Nothing was written: no packet, no decision, and the fenced status stands.
    assert.equal(fx.store.listResearchPacketsByWork('work-1', 10).length, 0)
    assert.equal(fx.store.getResearchReadinessByWork('work-1'), null)
    assert.equal(fx.store.getResearchWork('work-1')?.status, 'synthesis_leased')
  } finally { fx.close() }
})

test('a decision whose retained provenance differs from the stored packet is rejected', () => {
  const fx = open()
  try {
    seedLeased(fx.store)
    const readiness = readinessFor(fx.store)
    // Identities all line up, so only the retained packet provenance is wrong.
    const mismatched = validateResearchReadiness({
      ...readiness,
      limitations: ['A limitation the stored packet never carried.'],
    })
    assert.throws(
      () => fx.store.commitResearchHandoff({
        packet: packet(), readiness: mismatched, fence: fence(), now: ASSESSED_AT,
      }),
      /does not retain the packet limitations and open questions/,
    )
    assert.equal(fx.store.listResearchPacketsByWork('work-1', 10).length, 0)
    assert.equal(fx.store.getResearchReadinessByWork('work-1'), null)
    assert.equal(fx.store.getResearchWork('work-1')?.status, 'synthesis_leased')
  } finally { fx.close() }
})

test('a decision citing evidence that is not persisted for the work is rejected with no writes', () => {
  const fx = open()
  try {
    seedLeased(fx.store)
    const readiness = readinessFor(fx.store)
    // The decision was assessed while `evidence-1` was persisted. Removing the
    // persisted row behind it makes the saved claim untrue, so the handoff must
    // reject rather than persist a decision describing absent evidence.
    assert.equal(fx.store.listEvidenceByWork('work-1', 10).length, 1)
    deletePersistedEvidence(fx.path, 'evidence-1')
    assert.equal(fx.store.listEvidenceByWork('work-1', 10).length, 0)
    assert.throws(
      () => fx.store.commitResearchHandoff({
        packet: packet(), readiness, fence: fence(), now: ASSESSED_AT,
      }),
      /references evidence that is not persisted for this work item: evidence-1/,
    )
    assert.equal(fx.store.listResearchPacketsByWork('work-1', 10).length, 0)
    assert.equal(fx.store.getResearchReadinessByWork('work-1'), null)
    assert.equal(fx.store.getResearchWork('work-1')?.status, 'synthesis_leased')
  } finally { fx.close() }
})

test('the bridge rejects a decision that does not describe the stored packet', async () => {
  const fx = open()
  try {
    seedLeased(fx.store)
    // Reproduce the legacy shape: a durable packet and a research_ready row.
    fx.store.appendResearchPacket(packet())
    const released = await fx.store.transitionLeased({
      ...fence(), expectedStatus: 'synthesis_leased', nextStatus: 'research_ready',
      now: ASSESSED_AT, attemptDelta: 0,
    })
    assert.equal(released, true)
    const saved = fx.store.getResearchWork('work-1')!
    const readiness = assessResearchReadiness({
      work: saved, signal: signal(), packet: packet(),
      persistedEvidence: fx.store.listEvidenceByWork('work-1', 10), assessedAt: ASSESSED_AT,
    })
    // The bridge must not trust a caller-supplied decision merely because a
    // packet row exists, so a decision whose evidence is no longer persisted
    // is refused before any decision or status write.
    deletePersistedEvidence(fx.path, 'evidence-1')
    assert.throws(
      () => fx.store.promoteResearchReadyWithReadiness({ workId: 'work-1', readiness, now: ASSESSED_AT }),
      /does not match its stored records/,
    )
    // No decision was saved and the work row is untouched.
    assert.equal(fx.store.getResearchReadinessByWork('work-1'), null)
    assert.equal(fx.store.getResearchWork('work-1')?.status, 'research_ready')
    assert.equal(fx.store.listResearchPacketsByWork('work-1', 10).length, 1)
  } finally { fx.close() }
})

test('the bounded bridge promotes a saved research_ready result without erasing it', async () => {
  const fx = open()
  try {
    seedLeased(fx.store)
    // Reproduce a handoff saved before the atomic transition existed: the
    // packet is durable and the work is parked at research_ready.
    fx.store.appendResearchPacket(packet())
    const released = await fx.store.transitionLeased({
      ...fence(), expectedStatus: 'synthesis_leased', nextStatus: 'research_ready',
      now: ASSESSED_AT, attemptDelta: 0,
    })
    assert.equal(released, true)
    const saved = fx.store.getResearchWork('work-1')!
    assert.equal(saved.status, 'research_ready')
    const readiness = assessResearchReadiness({
      work: saved, signal: signal(), packet: packet(),
      persistedEvidence: fx.store.listEvidenceByWork('work-1', 10), assessedAt: ASSESSED_AT,
    })
    // A long-elapsed freshness deadline must not erase the saved result.
    const result = fx.store.promoteResearchReadyWithReadiness({
      workId: 'work-1', readiness, now: '2026-09-30T00:00:00.000Z',
    })
    assert.ok(result)
    assert.equal(result.committed, true)
    assert.equal(result.workStatus, 'entity_pending')
    assert.equal(fx.store.getResearchWork('work-1')?.status, 'entity_pending')
    // The immutable packet and its evidence are untouched.
    assert.equal(fx.store.listResearchPacketsByWork('work-1', 10).length, 1)
    assert.equal(fx.store.listEvidenceByWork('work-1', 10).length, 1)
    assert.equal(fx.store.getResearchReadinessByWork('work-1')?.outcome, 'ready_for_entity')
    // A second bridge finds nothing to promote.
    assert.equal(
      fx.store.promoteResearchReadyWithReadiness({ workId: 'work-1', readiness, now: '2026-09-30T00:00:01.000Z' }),
      null,
    )
  } finally { fx.close() }
})

test('the bridge refuses to assess a packet on its own', () => {
  const fx = open()
  try {
    seedLeased(fx.store)
    // Work is still leased, so the bridge has nothing saved to replay.
    const readiness = readinessFor(fx.store)
    assert.equal(
      fx.store.promoteResearchReadyWithReadiness({ workId: 'work-1', readiness, now: ASSESSED_AT }),
      null,
    )
    assert.equal(fx.store.getResearchReadinessByWork('work-1'), null)
  } finally { fx.close() }
})
