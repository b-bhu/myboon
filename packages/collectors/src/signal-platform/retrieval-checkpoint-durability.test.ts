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
  type ResearchWorkItem,
  type RetrievedEvidence,
  type Signal,
} from './contracts'
import { ImmutableRecordConflictError } from './platform-store'
import { SqliteSignalPlatformStore } from './sqlite-platform-store'
import {
  assessRetrievalManifest,
  retrievalPlanDigest,
  retrievalPlanId,
  type RetrievalManifestV1,
  type RetrievalPlanIdentityInput,
} from './retrieval-manifest'

const nodeRequire = createRequire(__filename)
const { DatabaseSync } = nodeRequire('node:sqlite') as {
  DatabaseSync: new (path: string) => {
    exec(sql: string): void
    prepare(sql: string): { all(...params: unknown[]): unknown[] }
    close(): void
  }
}

const NOW = '2026-08-26T12:00:00.000Z'
const SOURCE_URL = 'https://news.example/ethena'
const CORROBORATION_URL = 'https://reuters.example/ethena'

function signal(): Signal {
  return {
    schemaVersion: SIGNAL_SCHEMA_VERSION, signalId: 'signal-1', sourceType: 'news',
    sourceId: 'news:source:1', contentKind: 'article',
    content: { schemaVersion: 'myboon.signal_content.article.v1' },
    observedAt: '2026-08-26T11:00:00.000Z', publishedAt: '2026-08-26T10:55:00.000Z',
    canonicalUrl: SOURCE_URL, title: 'Ethena article', visibleSummary: null,
    media: { imageUrl: null, attribution: null },
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
    retrievalPlan: { sourceUrl: SOURCE_URL, allowedDomains: ['news.example'], maxExternalSources: 1 },
    budget: { maxProviderCalls: 2, maxRepairCalls: 1, maxToolCalls: 0, maxWallTimeMs: 30_000 },
    status: 'retrieval_leased', attemptCount: 1, nextAttemptAt: null,
    leaseOwner: 'worker-1', leaseId: 'lease-1', leaseExpiresAt: '2026-08-26T12:05:00.000Z',
    failureCategory: null, failureDetail: null, traceId: 'trace-1',
    createdAt: '2026-08-26T11:30:00.000Z', updatedAt: '2026-08-26T11:59:00.000Z',
    ...overrides,
  }
}

function planIdentity(): RetrievalPlanIdentityInput {
  return {
    workId: 'work-1', researchContractVersion: RESEARCH_PACKET_SCHEMA_VERSION, policyVersion: 'policy.v1',
    sourceUrl: SOURCE_URL, allowedDomains: ['news.example'], maxExternalSources: 1,
    maxSources: 2, maxBytesPerSource: 1_000_000, maxTotalBytes: 3_000_000,
    maxTextCharsPerSource: 100_000, maxRedirects: 3, timeoutMs: 30_000,
    freshnessDeadline: '2026-08-26T18:00:00.000Z',
  }
}

function evidence(id: string, overrides: Partial<RetrievedEvidence> = {}): RetrievedEvidence {
  return {
    schemaVersion: RETRIEVED_EVIDENCE_SCHEMA_VERSION, evidenceId: id, workId: 'work-1',
    requestedUrl: SOURCE_URL, finalUrl: SOURCE_URL, authority: 'source_url', authorityId: 'signal-1',
    contentHash: `hash-${id}`, contentType: 'text/html', httpStatus: 200, retrievalMethod: 'safe_http',
    retrievedAt: NOW, text: 'Body', truncated: false, byteLength: 100,
    ...overrides,
  }
}

const SOURCE = { url: SOURCE_URL, authority: 'source_url' as const, authorityId: 'signal-1' }
const CORROBORATION = {
  url: CORROBORATION_URL, authority: 'search_connector' as const, authorityId: 'connector:result-1',
}

function manifest(options: {
  attempt?: number
  corroboration?: 'succeeded' | 'failed' | 'skipped'
  recordedAt?: string
} = {}): RetrievalManifestV1 {
  const identity = planIdentity()
  const corroboration = options.corroboration ?? 'succeeded'
  return assessRetrievalManifest({
    work: work(),
    planId: retrievalPlanId(identity),
    planDigest: retrievalPlanDigest(identity),
    planPolicyVersion: 'policy.v1',
    attempt: options.attempt ?? 1,
    plannedSources: [SOURCE, CORROBORATION],
    skippedSources: corroboration === 'skipped' ? [{ ...CORROBORATION, skipReason: 'source_limit' }] : [],
    captures: [
      {
        evidenceId: 'evidence-1', contentHash: 'hash-evidence-1',
        requestedUrl: SOURCE_URL, finalUrl: SOURCE_URL, truncated: false,
      },
      ...(corroboration === 'succeeded' ? [{
        evidenceId: 'evidence-2', contentHash: 'hash-evidence-2',
        requestedUrl: CORROBORATION_URL, finalUrl: CORROBORATION_URL, truncated: false,
      }] : []),
    ],
    failures: corroboration === 'failed'
      ? [{ requestedUrl: CORROBORATION_URL, category: 'retrieval_blocked', retryable: true }]
      : [],
    recordedAt: options.recordedAt ?? NOW,
  })
}

function seeded(manifest: RetrievalManifestV1): RetrievedEvidence[] {
  return manifest.evidenceIds.map((evidenceId) => evidence(
    evidenceId,
    evidenceId === 'evidence-1'
      ? {}
      : { requestedUrl: CORROBORATION_URL, finalUrl: CORROBORATION_URL, authority: 'search_connector' as const, authorityId: 'connector:result-1' },
  ))
}

function store(): { store: SqliteSignalPlatformStore, close(): void } {
  const dir = mkdtempSync(join(tmpdir(), 'retrieval-checkpoint-'))
  const opened = new SqliteSignalPlatformStore(join(dir, 'store.sqlite'), 'news')
  opened.appendSignal(signal())
  opened.admitResearchWork(work())
  return { store: opened, close: () => { opened.close(); rmSync(dir, { recursive: true, force: true }) } }
}

const FENCE = { workId: 'work-1', leaseOwner: 'worker-1', leaseId: 'lease-1' }

test('a complete retrieval checkpoint commits its manifest and evidence batch together', () => {
  const fx = store()
  try {
    const saved = manifest()
    assert.equal(saved.decision, 'complete')
    const result = fx.store.commitRetrievalCheckpoint({ manifest: saved, evidence: seeded(saved), fence: FENCE, now: NOW })
    assert.equal(result.committed, true)
    assert.equal(result.manifest.inserted, true)
    assert.deepEqual(result.evidence.map((entry) => entry.inserted), [true, true])
    assert.equal(result.workStatus, 'retrieval_leased')

    assert.deepEqual(fx.store.getLatestRetrievalManifest('work-1', saved.retrievalPlanId), saved)
    assert.equal(fx.store.listEvidenceByWork('work-1', 10).length, 2)
    // Replaying the identical unit is idempotent, not a second record.
    const replay = fx.store.commitRetrievalCheckpoint({ manifest: saved, evidence: seeded(saved), fence: FENCE, now: NOW })
    assert.equal(replay.committed, true)
    assert.equal(replay.manifest.inserted, false)
    assert.equal(fx.store.listRetrievalManifestsByWork('work-1', 10).length, 1)
    assert.equal(fx.store.listEvidenceByWork('work-1', 10).length, 2)
  } finally { fx.close() }
})

test('a held retrieval checkpoint is retained alongside the earlier partial one', () => {
  const fx = store()
  try {
    const partial = manifest({ corroboration: 'failed' })
    assert.equal(partial.decision, 'proceed_with_limitations')
    const held = assessRetrievalManifest({
      work: work(),
      planId: partial.retrievalPlanId,
      planDigest: partial.retrievalPlanDigest,
      planPolicyVersion: 'policy.v1',
      attempt: 2,
      plannedSources: [SOURCE, CORROBORATION],
      skippedSources: [],
      captures: [],
      failures: [{ requestedUrl: SOURCE_URL, category: 'retrieval_blocked', retryable: true }],
      recordedAt: '2026-08-26T12:01:00.000Z',
    })
    assert.equal(held.decision, 'hold_and_retry')
    assert.equal(fx.store.commitRetrievalCheckpoint({
      manifest: partial, evidence: seeded(partial), fence: FENCE, now: NOW,
    }).committed, true)
    assert.equal(fx.store.commitRetrievalCheckpoint({
      manifest: held, evidence: [], fence: FENCE, now: '2026-08-26T12:01:00.000Z',
    }).committed, true)

    const stored = fx.store.listRetrievalManifestsByWork('work-1', 10)
    // Both checkpoints for the same plan are kept: history is never rewritten.
    assert.deepEqual(stored.map((entry) => entry.decision), ['proceed_with_limitations', 'hold_and_retry'])
    assert.equal(fx.store.getLatestRetrievalManifest('work-1', held.retrievalPlanId)?.manifestId, held.manifestId)
  } finally { fx.close() }
})

test('latest checkpoint follows attempt sequence rather than wall-clock ordering', () => {
  const fx = store()
  try {
    const first = manifest({ attempt: 1, recordedAt: '2026-08-26T12:02:00.000Z' })
    const second = manifest({ attempt: 2, recordedAt: '2026-08-26T12:01:00.000Z' })
    assert.equal(fx.store.commitRetrievalCheckpoint({
      manifest: first, evidence: seeded(first), fence: FENCE, now: NOW,
    }).committed, true)
    assert.equal(fx.store.commitRetrievalCheckpoint({
      manifest: second, evidence: seeded(second), fence: FENCE, now: NOW,
    }).committed, true)
    // System clock correction cannot cause the older attempt to eclipse the
    // newer immutable checkpoint.
    assert.equal(fx.store.getLatestRetrievalManifest('work-1', second.retrievalPlanId)?.manifestId, second.manifestId)
  } finally { fx.close() }
})

test('an interrupted checkpoint rolls back the evidence batch and leaves no manifest', () => {
  const fx = store()
  try {
    const saved = manifest()
    // The second artifact is refused after the first insert, so the whole unit
    // must roll back: an evidence cache must never survive on its own.
    const tampered = { ...seeded(saved)[1]!, byteLength: -1 }
    assert.throws(
      () => fx.store.commitRetrievalCheckpoint({
        manifest: saved, evidence: [seeded(saved)[0]!, tampered], fence: FENCE, now: NOW,
      }),
    )
    assert.deepEqual(fx.store.listEvidenceByWork('work-1', 10), [])
    assert.deepEqual(fx.store.listRetrievalManifestsByWork('work-1', 10), [])
    assert.equal(fx.store.getLatestRetrievalManifest('work-1', saved.retrievalPlanId), null)
    // The work row is untouched, so a later attempt can retry cleanly.
    assert.equal(fx.store.getResearchWork('work-1')?.status, 'retrieval_leased')
  } finally { fx.close() }
})

test('a conflicting manifest identity is rejected rather than rewritten', () => {
  const fx = store()
  try {
    const saved = manifest()
    assert.equal(fx.store.commitRetrievalCheckpoint({
      manifest: saved, evidence: seeded(saved), fence: FENCE, now: NOW,
    }).committed, true)
    // Same work, plan, attempt, and policy version: the identity is the same, so
    // a different payload under it is a hard conflict.
    const conflicting = { ...saved, reason: 'a different verdict for the same execution' }
    assert.throws(
      () => fx.store.commitRetrievalCheckpoint({
        manifest: conflicting, evidence: seeded(conflicting), fence: FENCE, now: NOW,
      }),
      (error: unknown) => error instanceof ImmutableRecordConflictError
        && error.recordType === 'manifest' && error.identity === saved.manifestId,
    )
    assert.deepEqual(fx.store.listRetrievalManifestsByWork('work-1', 10), [saved])
  } finally { fx.close() }
})

test('a checkpoint that does not match the stored evidence is refused before any write', () => {
  const fx = store()
  try {
    const saved = manifest()
    assert.throws(
      () => fx.store.commitRetrievalCheckpoint({
        manifest: saved,
        evidence: [evidence('evidence-1', { contentHash: 'different-bytes' })],
        fence: FENCE,
        now: NOW,
      }),
      /does not match its recorded content hash/,
    )
    // A manifest may not claim an artifact that is neither in the batch nor
    // already persisted: a checkpoint is never synthesized from a partial cache.
    assert.throws(
      () => fx.store.commitRetrievalCheckpoint({
        manifest: saved,
        evidence: [evidence('evidence-1')],
        fence: FENCE,
        now: NOW,
      }),
      /evidence that is not persisted for this work item: evidence-2/,
    )
    assert.deepEqual(fx.store.listEvidenceByWork('work-1', 10), [])
    assert.deepEqual(fx.store.listRetrievalManifestsByWork('work-1', 10), [])
  } finally { fx.close() }
})

test('evidence keeps its producer work identity and is never re-homed onto a consumer', () => {
  const fx = store()
  try {
    const saved = manifest({ corroboration: 'succeeded' })
    const rehomed = seeded(saved).map((artifact) => ({ ...artifact, workId: 'consumer-work' }))
    assert.throws(
      () => fx.store.commitRetrievalCheckpoint({ manifest: saved, evidence: rehomed, fence: FENCE, now: NOW }),
      /originates from consumer-work, not work-1/,
    )
    assert.deepEqual(fx.store.listEvidenceByWork('work-1', 10), [])
    assert.deepEqual(fx.store.listRetrievalManifestsByWork('work-1', 10), [])
  } finally { fx.close() }
})

test('a lost lease fence writes neither the manifest nor its evidence', () => {
  const fx = store()
  try {
    const saved = manifest()
    const lost = fx.store.commitRetrievalCheckpoint({
      manifest: saved, evidence: seeded(saved), fence: { ...FENCE, leaseId: 'stale-lease' }, now: NOW,
    })
    assert.equal(lost.committed, false)
    assert.deepEqual(lost.evidence, [])
    assert.deepEqual(fx.store.listEvidenceByWork('work-1', 10), [])
    assert.deepEqual(fx.store.listRetrievalManifestsByWork('work-1', 10), [])
  } finally { fx.close() }
})

test('another source store cannot persist a foreign source manifest', () => {
  const fx = store()
  const polymarket = new SqliteSignalPlatformStore(
    join(mkdtempSync(join(tmpdir(), 'retrieval-foreign-')), 'poly.sqlite'), 'polymarket',
  )
  try {
    assert.throws(
      () => polymarket.commitRetrievalCheckpoint({
        manifest: manifest(), evidence: [], fence: FENCE, now: NOW,
      }),
      /cannot persist news/,
    )
  } finally { fx.close(); polymarket.close() }
})

test('a pre-checkpoint database migrates additively and invents no historical manifest', () => {
  const dir = mkdtempSync(join(tmpdir(), 'retrieval-migration-'))
  const path = join(dir, 'store.sqlite')
  // Build the schema an older build produced: everything except the retrieval
  // checkpoint table, with an evidence cache that predates any manifest.
  const older = new SqliteSignalPlatformStore(path, 'news')
  older.appendSignal(signal())
  older.admitResearchWork(work())
  older.appendEvidence(evidence('legacy-evidence'))
  older.close()
  const before = new DatabaseSync(path)
  before.exec('DROP TABLE signal_platform_retrieval_manifests;')
  before.close()

  const opened = new SqliteSignalPlatformStore(path, 'news')
  const reader = new DatabaseSync(path)
  try {
    // The pre-existing evidence row is left exactly as it was, and no manifest
    // is fabricated to explain it: the old cache is simply not a checkpoint.
    assert.deepEqual(
      reader.prepare('SELECT work_id, content_hash FROM signal_platform_evidence').all()
        .map((row) => ({ ...(row as Record<string, unknown>) })),
      [{ work_id: 'work-1', content_hash: 'hash-legacy-evidence' }],
    )
    assert.deepEqual(opened.listEvidenceByWork('work-1', 10).map((artifact) => artifact.evidenceId), ['legacy-evidence'])
    assert.deepEqual(opened.listRetrievalManifestsByWork('work-1', 10), [])
    assert.equal(opened.getLatestRetrievalManifest('work-1', retrievalPlanId(planIdentity())), null)
    assert.deepEqual(
      reader.prepare('SELECT manifest_id FROM signal_platform_retrieval_manifests').all(),
      [],
    )
    // Existing readers keep working; only the checkpoint table is new.
    assert.equal(opened.getResearchWork('work-1')?.status, 'retrieval_leased')
    assert.equal(opened.getSignal('signal-1')?.signalId, 'signal-1')
  } finally {
    reader.close()
    opened.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
