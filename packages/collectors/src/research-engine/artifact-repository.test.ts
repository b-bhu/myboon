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
  type NewsSignal,
  type PolymarketSignal,
  type ResearchWorkItem,
  type RetrievedEvidence,
} from '../signal-platform/contracts'
import { SqliteSignalPlatformStore } from '../signal-platform/sqlite-platform-store'
import { artifactRef, linkArtifact, resolveArtifactUsage } from './artifact-repository'

const START = '2026-09-01T12:00:00.000Z'
const CAPTURED = '2026-09-01T12:02:00.000Z'
const LINKED = '2026-09-01T12:04:00.000Z'
const nodeRequire = createRequire(__filename)
const { DatabaseSync } = nodeRequire('node:sqlite') as {
  DatabaseSync: new (path: string) => {
    exec(sql: string): void
    prepare(sql: string): { run(...params: unknown[]): unknown }
    close(): void
  }
}

function newsSignal(entity = 'Acme'): NewsSignal {
  return {
    schemaVersion: SIGNAL_SCHEMA_VERSION,
    signalId: 'news-signal', sourceType: 'news', sourceId: 'news:article:1',
    contentKind: 'article', content: { schemaVersion: 'myboon.signal_content.article.v1' },
    observedAt: START, publishedAt: START, canonicalUrl: 'https://example.com/article',
    title: 'Acme article', visibleSummary: 'A new product',
    media: { imageUrl: null, attribution: 'Example' },
    sourceHints: { entities: [entity], assets: [], eventId: null, deadline: null },
    provenance: { provider: 'fixture', upstreamSource: 'Example', rawPayloadRef: 'row-1' },
    idempotencyKey: 'news-key',
  }
}

function marketSignal(entity = 'acme'): PolymarketSignal {
  return {
    schemaVersion: SIGNAL_SCHEMA_VERSION,
    signalId: 'market-signal', sourceType: 'polymarket', sourceId: 'polymarket:market:1',
    contentKind: 'market_event',
    content: { schemaVersion: 'myboon.signal_content.market_event.v1', marketId: 'market-1', candidateType: 'odds_spike' },
    observedAt: START, publishedAt: null, canonicalUrl: 'https://polymarket.com/event/example',
    title: 'Acme market', visibleSummary: 'Odds moved',
    media: { imageUrl: null, attribution: 'Polymarket' },
    sourceHints: { entities: [entity], assets: [], eventId: null, deadline: null },
    provenance: { provider: 'polymarket', upstreamSource: 'markets', rawPayloadRef: 'candidate-1' },
    idempotencyKey: 'market-key',
  }
}

function work(sourceType: ResearchWorkItem['sourceType']): ResearchWorkItem {
  const isNews = sourceType === 'news'
  return {
    schemaVersion: RESEARCH_WORK_SCHEMA_VERSION,
    workId: isNews ? 'news-work' : 'market-work',
    signalId: isNews ? 'news-signal' : 'market-signal',
    sourceType, researchDepth: 'standard', deepReason: null,
    priorityClass: 'P1', priorityScore: 0.5,
    freshnessDeadline: '2026-09-01T13:00:00.000Z',
    policyVersion: 'policy-v1', researchContractVersion: RESEARCH_PACKET_SCHEMA_VERSION,
    retrievalPlan: {
      sourceUrl: isNews ? 'https://example.com/article' : 'https://polymarket.com/event/example',
      allowedDomains: isNews ? ['example.com'] : ['polymarket.com'], maxExternalSources: 2,
    },
    budget: { maxProviderCalls: 1, maxRepairCalls: 1, maxToolCalls: 0, maxWallTimeMs: 60_000 },
    status: 'research_pending', attemptCount: 0, nextAttemptAt: null,
    leaseOwner: null, leaseId: null, leaseExpiresAt: null,
    failureCategory: null, failureDetail: null, traceId: isNews ? 'news-trace' : 'market-trace',
    createdAt: START, updatedAt: START,
  }
}

function evidence(): RetrievedEvidence {
  return {
    schemaVersion: RETRIEVED_EVIDENCE_SCHEMA_VERSION,
    evidenceId: 'news-capture', workId: 'news-work',
    requestedUrl: 'https://example.com/article', finalUrl: 'https://example.com/article',
    authority: 'source_url', authorityId: 'news-signal', contentHash: 'content-sha256',
    contentType: 'text/html', httpStatus: 200, retrievalMethod: 'safe_http',
    retrievedAt: CAPTURED, text: 'A new product was announced.', truncated: false, byteLength: 28,
  }
}

function stores() {
  const directory = mkdtempSync(join(tmpdir(), 'artifact-repository-'))
  const newsPath = join(directory, 'news.sqlite')
  const marketPath = join(directory, 'market.sqlite')
  const owner = new SqliteSignalPlatformStore(newsPath, 'news')
  const consumer = new SqliteSignalPlatformStore(marketPath, 'polymarket')
  owner.appendSignal(newsSignal())
  owner.admitResearchWork(work('news'))
  owner.appendEvidence(evidence())
  consumer.appendSignal(marketSignal())
  consumer.admitResearchWork(work('polymarket'))
  return { directory, newsPath, owner, consumer }
}

test('cross-source link persists an owner pin and consumer usage without changing the producer work', () => {
  const fx = stores()
  try {
    const usage = linkArtifact({ owner: fx.owner, consumer: fx.consumer,
      artifactId: 'news-capture', consumerWorkId: 'market-work', now: LINKED })
    assert.equal(usage.decision, 'background_only')
    assert.equal(usage.reason, 'relevant_context')
    assert.equal(usage.ref.ownerStoreId, fx.owner.artifactStoreId())
    assert.notEqual(usage.ref.ownerStoreId, fx.consumer.artifactStoreId())
    assert.equal(fx.owner.getArtifactPin(usage.pinId!)?.consumerWorkId, 'market-work')
    assert.equal(fx.consumer.listArtifactUsagesByWork('market-work', 10).length, 1)
    assert.equal(resolveArtifactUsage(fx.owner, usage)?.workId, 'news-work')
    const replay = linkArtifact({ owner: fx.owner, consumer: fx.consumer,
      artifactId: 'news-capture', consumerWorkId: 'market-work', now: '2026-09-01T12:05:00.000Z' })
    assert.deepEqual(replay, usage)
    assert.equal(fx.consumer.listArtifactUsagesByWork('market-work', 10).length, 1)
    const storeId = fx.owner.artifactStoreId()
    fx.owner.close()
    const reopened = new SqliteSignalPlatformStore(fx.newsPath, 'news')
    try {
      assert.equal(reopened.artifactStoreId(), storeId)
      assert.equal(resolveArtifactUsage(reopened, usage)?.workId, 'news-work')
    } finally { reopened.close() }
  } finally {
    fx.owner.close()
    fx.consumer.close()
    rmSync(fx.directory, { recursive: true, force: true })
  }
})

test('unrelated capture is recorded as rejected and never obtains a retention pin', () => {
  const fx = stores()
  try {
    const unrelated = marketSignal('Different entity')
    // The consumer's immutable signal is replaced only in this fixture before linking.
    fx.consumer.close()
    const isolatedPath = join(fx.directory, 'unrelated.sqlite')
    const consumer = new SqliteSignalPlatformStore(isolatedPath, 'polymarket')
    try {
      consumer.appendSignal(unrelated)
      consumer.admitResearchWork(work('polymarket'))
      const usage = linkArtifact({ owner: fx.owner, consumer,
        artifactId: 'news-capture', consumerWorkId: 'market-work', now: LINKED })
      assert.equal(usage.decision, 'rejected')
      assert.equal(usage.reason, 'unrelated')
      assert.equal(usage.pinId, null)
      assert.equal(resolveArtifactUsage(fx.owner, usage), null)
      assert.equal(consumer.listArtifactUsagesByWork('market-work', 10).length, 1)
    } finally { consumer.close() }
  } finally {
    fx.owner.close()
    rmSync(fx.directory, { recursive: true, force: true })
  }
})

test('pin and resolution reject changed digests and missing owner receipts', () => {
  const fx = stores()
  try {
    const ref = artifactRef(fx.owner.artifactStoreId(), 'news', evidence())
    assert.throws(() => fx.owner.pinArtifact({ ...ref, digest: 'wrong' },
      fx.consumer.artifactStoreId(), 'market-work', LINKED), /does not match/)
    const usage = linkArtifact({ owner: fx.owner, consumer: fx.consumer,
      artifactId: 'news-capture', consumerWorkId: 'market-work', now: LINKED })
    assert.equal(resolveArtifactUsage(fx.owner, { ...usage, pinId: 'missing' }), null)
    assert.equal(resolveArtifactUsage(fx.owner, {
      ...usage, ref: { ...usage.ref, digest: 'changed' },
    }), null)
  } finally {
    fx.owner.close()
    fx.consumer.close()
    rmSync(fx.directory, { recursive: true, force: true })
  }
})

test('owner retention pin prevents deleting a capture still referenced by another store', () => {
  const fx = stores()
  try {
    linkArtifact({ owner: fx.owner, consumer: fx.consumer,
      artifactId: 'news-capture', consumerWorkId: 'market-work', now: LINKED })
    const db = new DatabaseSync(fx.newsPath)
    try {
      db.exec('PRAGMA foreign_keys = ON')
      assert.throws(() => db.prepare('DELETE FROM signal_platform_evidence WHERE evidence_id = ?')
        .run('news-capture'), /FOREIGN KEY/)
    } finally { db.close() }
    assert.equal(fx.owner.getEvidence('news-capture')?.workId, 'news-work')
  } finally {
    fx.owner.close()
    fx.consumer.close()
    rmSync(fx.directory, { recursive: true, force: true })
  }
})
