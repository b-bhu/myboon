import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { SqliteNewsStore } from '../news/sqlite-store'
import { backupNewsStore, verifyNewsBackup } from '../pipeline-store/backup'
import {
  RESEARCH_PACKET_SCHEMA_VERSION,
  RESEARCH_WORK_SCHEMA_VERSION,
  RETRIEVED_EVIDENCE_SCHEMA_VERSION,
  SIGNAL_SCHEMA_VERSION,
  type NewsSignal,
  type ResearchPacketV1,
  type ResearchWorkItem,
  type RetrievedEvidence,
} from './contracts'
import { ImmutableRecordConflictError } from './platform-store'
import { SqliteSignalPlatformStore } from './sqlite-platform-store'
import { runSchedulerStoreContract } from './store-adapter-contract'
import { createPriorityPolicyV1, RulesFirstTriageEngine } from './triage-engine'
import type { RulesFirstTriageInput, TriageDecisionV1 } from './triage-contracts'

const nodeRequire = createRequire(__filename)
const { DatabaseSync } = nodeRequire('node:sqlite') as {
  DatabaseSync: new (path: string) => {
    exec(sql: string): void
    prepare(sql: string): { get(...params: unknown[]): unknown }
    close(): void
  }
}

function signal(overrides: Partial<NewsSignal> = {}): NewsSignal {
  return {
    schemaVersion: SIGNAL_SCHEMA_VERSION,
    signalId: 'signal-1',
    sourceType: 'news',
    sourceId: 'source:article:1',
    contentKind: 'article',
    content: { schemaVersion: 'myboon.signal_content.article.v1' },
    observedAt: '2026-08-26T12:00:00.000Z',
    publishedAt: '2026-08-26T11:55:00.000Z',
    canonicalUrl: 'https://example.com/article',
    title: 'Canonical article',
    visibleSummary: 'Summary',
    media: { imageUrl: null, attribution: 'Example' },
    sourceHints: { entities: [], assets: [], eventId: null, deadline: null },
    provenance: { provider: 'fixture', upstreamSource: 'Example', rawPayloadRef: 'legacy-row-1' },
    idempotencyKey: 'source-key-1',
    ...overrides,
  }
}

function work(overrides: Partial<ResearchWorkItem> = {}): ResearchWorkItem {
  return {
    schemaVersion: RESEARCH_WORK_SCHEMA_VERSION,
    workId: 'work-1',
    signalId: 'signal-1',
    sourceType: 'news',
    researchDepth: 'standard',
    deepReason: null,
    priorityClass: 'P1',
    priorityScore: 0.5,
    freshnessDeadline: '2026-08-26T13:00:00.000Z',
    policyVersion: 'policy-v1',
    researchContractVersion: RESEARCH_PACKET_SCHEMA_VERSION,
    retrievalPlan: { sourceUrl: 'https://example.com/article', allowedDomains: ['example.com'], maxExternalSources: 2 },
    budget: {
      maxProviderCalls: 1, maxRepairCalls: 1, maxInputTokens: 1000,
      maxOutputTokens: 500, maxToolCalls: 0, maxWallTimeMs: 60_000,
    },
    status: 'research_pending',
    attemptCount: 0,
    nextAttemptAt: null,
    leaseOwner: null,
    leaseId: null,
    leaseExpiresAt: null,
    failureCategory: null,
    failureDetail: null,
    traceId: 'trace-1',
    createdAt: '2026-08-26T12:00:00.000Z',
    updatedAt: '2026-08-26T12:00:00.000Z',
    ...overrides,
  }
}

function evidence(overrides: Partial<RetrievedEvidence> = {}): RetrievedEvidence {
  return {
    schemaVersion: RETRIEVED_EVIDENCE_SCHEMA_VERSION,
    evidenceId: 'evidence-1',
    workId: 'work-1',
    requestedUrl: 'https://example.com/article',
    finalUrl: 'https://example.com/article',
    authority: 'source_url',
    authorityId: 'source-1',
    contentHash: 'hash-1',
    contentType: 'text/html',
    httpStatus: 200,
    retrievalMethod: 'safe_http',
    retrievedAt: '2026-08-26T12:02:00.000Z',
    text: 'Evidence text',
    truncated: false,
    byteLength: 13,
    ...overrides,
  }
}

function packet(overrides: Partial<ResearchPacketV1> = {}): ResearchPacketV1 {
  return {
    schemaVersion: RESEARCH_PACKET_SCHEMA_VERSION,
    packetId: 'packet-1',
    workId: 'work-1',
    signalId: 'signal-1',
    sourceType: 'news',
    observedAt: '2026-08-26T12:00:00.000Z',
    sourceSignal: {
      title: 'Canonical article', canonicalUrl: 'https://example.com/article',
      publishedAt: '2026-08-26T11:55:00.000Z',
      provenance: { provider: 'fixture', upstreamSource: 'Example', rawPayloadRef: 'legacy-row-1' },
    },
    claims: [{ claimId: 'claim-1', claim: 'Claim', attributedTo: null, evidenceRefs: ['evidence-1'] }],
    verifiedFacts: [{ fact: 'Fact', evidenceRefs: ['evidence-1'] }],
    unresolvedClaims: [],
    evidence: [{
      evidenceId: 'evidence-1', title: 'Source', url: 'https://example.com/article',
      sourceType: 'primary', observedAt: '2026-08-26T12:02:00.000Z', note: null,
    }],
    entityHints: [{
      name: 'Example', type: 'organization', role: null, aliases: [], source: 'evidence',
      claimRefs: ['claim-1'], evidenceRefs: ['evidence-1'],
    }],
    limitations: [],
    openQuestions: [],
    completion: 'complete',
    budgetUsed: {
      providerCalls: 1, repairCalls: 0, inputTokens: 100, outputTokens: 50,
      toolCalls: 0, wallTimeMs: 1000, budgetExceeded: false,
    },
    execution: {
      provider: 'fixture', model: 'model', fallbackProvider: null, fallbackModel: null,
      fallbackUsed: false, promptVersion: 'prompt-v1', policyVersion: 'policy-v1',
      traceId: 'trace-1', attempt: 1,
    },
    researchContractVersion: RESEARCH_PACKET_SCHEMA_VERSION,
    createdAt: '2026-08-26T12:05:00.000Z',
    ...overrides,
  }
}

function fixture(name: string): { dir: string; path: string } {
  const dir = mkdtempSync(join(tmpdir(), `signal-platform-${name}-`))
  return { dir, path: join(dir, 'store.sqlite') }
}

async function triageDecision(overrides: Partial<RulesFirstTriageInput> = {}): Promise<TriageDecisionV1> {
  const policy = createPriorityPolicyV1({ policyVersion: 'policy-v1', budgetPolicyVersion: 'budget-v1' })
  const engine = new RulesFirstTriageEngine({ policy })
  return engine.decide({
    signal: signal(), now: '2026-08-26T12:00:00.000Z', sourceAuthorityScore: 0.9,
    officialSource: true, dedupeOutcome: 'new_observation', novelty: 'material', entityCanonOverlap: true,
    materialityTags: ['market_material'], eventDeadline: null, providerHealth: 'healthy',
    capacity: {
      byPriority: {
        P0: { available: 10, reservedAvailable: 2, utilization: 0 },
        P1: { available: 10, reservedAvailable: 2, utilization: 0 },
        P2: { available: 10, reservedAvailable: 1, utilization: 0 },
        P3: { available: 10, reservedAvailable: 0, utilization: 0 },
      },
      byDepth: {
        light: { available: 10, reservedAvailable: 2, utilization: 0 },
        standard: { available: 10, reservedAvailable: 2, utilization: 0 },
        deep: { available: 10, reservedAvailable: 0, utilization: 0 },
      },
    },
    ambiguity: { isAmbiguous: false, reasons: [] }, deepEscalation: null,
    ...overrides,
  })
}

test('immutable canonical artifacts are idempotent, collision-safe, linked, and queryable', async () => {
  const temp = fixture('artifacts')
  const store = new SqliteSignalPlatformStore(temp.path, 'news')
  try {
    assert.equal(store.appendSignal(signal()).inserted, true)
    assert.equal(store.appendSignal(structuredClone(signal())).inserted, false)
    assert.throws(() => store.appendSignal(signal({ title: 'Collision' })), ImmutableRecordConflictError)
    assert.throws(() => store.appendSignal(signal({ signalId: 'other-id' })), ImmutableRecordConflictError)

    const decision = await triageDecision()
    assert.equal(store.appendTriageDecision(decision).inserted, true)
    assert.equal(store.appendTriageDecision(structuredClone(decision)).inserted, false)
    assert.throws(() => store.appendTriageDecision({ ...decision, priorityScore: 0.2 }), ImmutableRecordConflictError)
    assert.equal(store.getTriageDecision(decision.decisionId)?.signalId, 'signal-1')
    assert.equal(store.listTriageDecisionsBySignal('signal-1', 10).length, 1)

    assert.equal(store.admitResearchWork(work()).inserted, true)
    assert.equal(store.admitResearchWork(structuredClone(work())).inserted, false)
    assert.throws(() => store.admitResearchWork(work({ priorityScore: 0.9 })), ImmutableRecordConflictError)

    assert.equal(store.appendEvidence(evidence()).inserted, true)
    assert.equal(store.appendEvidence(structuredClone(evidence())).inserted, false)
    assert.throws(() => store.appendEvidence(evidence({ text: 'different' })), ImmutableRecordConflictError)

    assert.equal(store.appendResearchPacket(packet()).inserted, true)
    assert.equal(store.appendResearchPacket(structuredClone(packet())).inserted, false)
    assert.throws(() => store.appendResearchPacket(packet({ completion: 'partial' })), ImmutableRecordConflictError)
    assert.throws(() => store.appendResearchPacket(packet({ packetId: 'packet-bad', signalId: 'wrong' })), /linkage/)

    assert.equal(store.findSignalByIdempotencyKey('source-key-1')?.signalId, 'signal-1')
    assert.equal(store.listResearchWorkBySignal('signal-1', 10).length, 1)
    assert.equal(store.listEvidenceByWork('work-1', 10).length, 1)
    assert.equal(store.listResearchPacketsByWork('work-1', 10).length, 1)
    assert.equal(store.listResearchPacketsBySignal('signal-1', 10).length, 1)
    assert.equal(store.listResearchPacketsByTrace('trace-1', 10).length, 1)
  } finally {
    store.close()
    rmSync(temp.dir, { recursive: true, force: true })
  }
})

test('two independent connections cannot double claim and stale completion is fenced', async () => {
  const temp = fixture('cas')
  const first = new SqliteSignalPlatformStore(temp.path, 'news')
  const second = new SqliteSignalPlatformStore(temp.path, 'news')
  try {
    first.appendSignal(signal())
    first.admitResearchWork(work())
    const base = {
      workId: 'work-1', expectedStatus: 'research_pending' as const,
      leaseExpiresAt: '2026-08-26T12:05:00.000Z', now: '2026-08-26T12:01:00.000Z',
    }
    const [leaseA, leaseB] = await Promise.all([
      first.claimWithLease({ ...base, leaseOwner: 'worker-a', leaseId: 'lease-a' }),
      second.claimWithLease({ ...base, leaseOwner: 'worker-b', leaseId: 'lease-b' }),
    ])
    assert.equal(Number(leaseA !== null) + Number(leaseB !== null), 1)
    const winner = leaseA ? first : second
    const loser = leaseA ? second : first
    const owner = leaseA ? 'worker-a' : 'worker-b'
    const leaseId = leaseA ? 'lease-a' : 'lease-b'
    assert.equal(await loser.transitionLeased({
      workId: 'work-1', expectedStatus: 'retrieval_leased', leaseOwner: 'stale', leaseId: 'stale',
      nextStatus: 'synthesis_pending', now: '2026-08-26T12:02:00.000Z', attemptDelta: 1,
    }), false)
    assert.equal(await winner.beginAttempt({
      workId: 'work-1', expectedStatus: 'retrieval_leased', leaseOwner: owner, leaseId,
      now: '2026-08-26T12:02:00.000Z',
    }), true)
    assert.equal(await winner.beginAttempt({
      workId: 'work-1', expectedStatus: 'retrieval_leased', leaseOwner: owner, leaseId,
      now: '2026-08-26T12:02:01.000Z',
    }), false)
    assert.equal(await winner.heartbeatLease({
      workId: 'work-1', leaseOwner: owner, leaseId,
      now: '2026-08-26T12:03:00.000Z', leaseExpiresAt: '2026-08-26T12:08:00.000Z',
    }), true)
    assert.equal(await winner.transitionLeased({
      workId: 'work-1', expectedStatus: 'retrieval_leased', leaseOwner: owner, leaseId,
      nextStatus: 'synthesis_pending', now: '2026-08-26T12:04:00.000Z', attemptDelta: 0,
    }), true)
    assert.equal(second.getResearchWork('work-1')?.attemptCount, 1)
    const synthesisLease = await second.claimWithLease({
      workId: 'work-1', expectedStatus: 'synthesis_pending', leaseOwner: 'synth-worker', leaseId: 'synth-lease',
      now: '2026-08-26T12:04:10.000Z', leaseExpiresAt: '2026-08-26T12:09:10.000Z',
    })
    assert.ok(synthesisLease)
    assert.equal(await second.transitionLeased({
      workId: 'work-1', expectedStatus: 'synthesis_leased', leaseOwner: 'synth-worker', leaseId: 'synth-lease',
      nextStatus: 'research_ready', now: '2026-08-26T12:05:00.000Z', attemptDelta: 1,
    }), true)
    assert.equal(first.promoteResearchReady('work-1', '2026-08-26T12:05:01.000Z'), true)
    assert.equal(second.promoteResearchReady('work-1', '2026-08-26T12:05:02.000Z'), false)
    assert.equal(first.getResearchWork('work-1')?.status, 'entity_pending')
  } finally {
    first.close()
    second.close()
    rmSync(temp.dir, { recursive: true, force: true })
  }
})

test('priority ordering, circuit-open invariant, expired recovery, and aggregate age are durable', async () => {
  const temp = fixture('scheduler')
  const store = new SqliteSignalPlatformStore(temp.path, 'news')
  try {
    for (const [id, priorityClass, score, deadline, createdAt] of [
      ['low', 'P2', 0.9, '2026-08-26T12:40:00.000Z', '2026-08-26T11:00:00.000Z'],
      ['high-later', 'P0', 0.9, '2026-08-26T12:30:00.000Z', '2026-08-26T11:02:00.000Z'],
      ['high-urgent', 'P0', 0.1, '2026-08-26T12:20:00.000Z', '2026-08-26T11:03:00.000Z'],
    ] as const) {
      store.appendSignal(signal({ signalId: `signal-${id}`, idempotencyKey: `key-${id}` }))
      store.admitResearchWork(work({
        workId: `work-${id}`, signalId: `signal-${id}`, priorityClass,
        priorityScore: score, freshnessDeadline: deadline, createdAt, updatedAt: createdAt,
      }))
    }
    const ready = await store.peekSchedulable({ now: '2026-08-26T12:10:00.000Z', limit: 10 })
    assert.deepEqual(ready.map((row) => row.workId), ['work-high-urgent', 'work-high-later', 'work-low'])
    const lease = await store.claimWithLease({
      workId: 'work-high-urgent', expectedStatus: 'research_pending', leaseOwner: 'worker', leaseId: 'circuit-lease',
      now: '2026-08-26T12:10:00.000Z', leaseExpiresAt: '2026-08-26T12:11:00.000Z',
    })
    assert.ok(lease)
    assert.equal(await store.transitionLeased({
      workId: 'work-high-urgent', expectedStatus: 'retrieval_leased', leaseOwner: 'worker', leaseId: 'circuit-lease',
      nextStatus: 'retry_wait', failureCategory: 'circuit_open', nextAttemptAt: '2026-08-26T12:15:00.000Z',
      now: '2026-08-26T12:10:30.000Z', attemptDelta: 0,
    }), true)
    assert.equal(store.getResearchWork('work-high-urgent')?.attemptCount, 0)
    assert.equal(store.getResearchWork('work-high-urgent')?.retryTargetStatus, 'research_pending')

    await store.claimWithLease({
      workId: 'work-high-later', expectedStatus: 'research_pending', leaseOwner: 'dead-worker', leaseId: 'expired-lease',
      now: '2026-08-26T12:10:00.000Z', leaseExpiresAt: '2026-08-26T12:11:00.000Z',
    })
    const recovered = await store.recoverExpiredLeases({ now: '2026-08-26T12:12:00.000Z', limit: 10 })
    assert.deepEqual(recovered.recoveredWorkIds, ['work-high-later'])
    assert.equal(store.getResearchWork('work-high-later')?.status, 'research_pending')
    assert.equal(store.getResearchWork('work-high-later')?.attemptCount, 0)
    const due = await store.recoverExpiredLeases({ now: '2026-08-26T12:16:00.000Z', limit: 10 })
    assert.deepEqual(due.recoveredWorkIds, ['work-high-urgent'])
    assert.equal(store.getResearchWork('work-high-urgent')?.status, 'research_pending')
    assert.equal(store.getResearchWork('work-high-urgent')?.failureCategory, null)
    const status = await store.getSchedulerStatus({ now: '2026-08-26T12:12:00.000Z' })
    assert.equal(status.total, 3)
    assert.equal(status.oldestReadyAt, '2026-08-26T11:00:00.000Z')
  } finally {
    store.close()
    rmSync(temp.dir, { recursive: true, force: true })
  }
})

test('additive initialization preserves unrelated legacy rows and close is idempotent', () => {
  const temp = fixture('legacy')
  const raw = new DatabaseSync(temp.path)
  raw.exec(`CREATE TABLE legacy_owned (id TEXT PRIMARY KEY, value TEXT NOT NULL);
    INSERT INTO legacy_owned (id, value) VALUES ('legacy-1', 'keep-me');`)
  raw.close()
  const store = new SqliteSignalPlatformStore(temp.path, 'news')
  store.appendSignal(signal())
  store.close()
  store.close()
  assert.throws(() => store.getSignal('signal-1'), /closed/)
  const verify = new DatabaseSync(temp.path)
  try {
    const row = verify.prepare(`SELECT value FROM legacy_owned WHERE id = ?`).get('legacy-1') as { value: string }
    assert.equal(row.value, 'keep-me')
  } finally {
    verify.close()
    rmSync(temp.dir, { recursive: true, force: true })
  }
})

test('news database backup inventory includes every initialized canonical platform table', async () => {
  const temp = fixture('backup')
  const legacy = new SqliteNewsStore(temp.path)
  legacy.close()
  const store = new SqliteSignalPlatformStore(temp.path, 'news')
  try {
    store.appendSignal(signal())
    store.appendTriageDecision(await triageDecision())
    store.admitResearchWork(work())
    store.appendEvidence(evidence())
    store.appendResearchPacket(packet())
  } finally {
    store.close()
  }
  try {
    const backup = await backupNewsStore({ sourcePath: temp.path, backupDir: join(temp.dir, 'backups') })
    assert.equal(backup.tableCounts.signal_platform_signals, 1)
    assert.equal(backup.tableCounts.signal_platform_triage_decisions, 1)
    assert.equal(backup.tableCounts.signal_platform_research_work, 1)
    assert.equal(backup.tableCounts.signal_platform_evidence, 1)
    assert.equal(backup.tableCounts.signal_platform_research_packets, 1)
    assert.equal((await verifyNewsBackup(backup.path, backup.sourceTableCounts)).ok, true)
  } finally {
    rmSync(temp.dir, { recursive: true, force: true })
  }
})

runSchedulerStoreContract({
  async create() {
    const temp = fixture('conformance')
    const store = new SqliteSignalPlatformStore(temp.path, 'news')
    return {
      store,
      seed: async (items) => {
        for (const item of items) {
          store.appendSignal(signal({
            signalId: item.signalId,
            idempotencyKey: `key-${item.signalId}`,
          }))
          store.admitResearchWork(item)
        }
      },
      read: async (workId) => store.getResearchWork(workId),
      close: async () => {
        store.close()
        rmSync(temp.dir, { recursive: true, force: true })
      },
    }
  },
  makeWork: work,
})
