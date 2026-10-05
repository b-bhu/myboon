import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { createRequire } from 'node:module'
import {
  CanonicalSourceSignalIntake,
  emptySourceIntakeReport,
  type SourceSignalIntakePort,
  type SourceSignalIntakeResult,
} from '../../signal-platform/source-intake'
import { ImmutableRecordConflictError } from '../../signal-platform/platform-store'
import { SqliteSignalPlatformStore } from '../../signal-platform/sqlite-platform-store'
import { drainSourceDeliveries, sourceDeliveryDigest } from '../../signal-platform/source-delivery-outbox'
import { createActiveSourceTriageIntake } from '../../signal-platform/active-triage'
import { backupNewsStore, restoreNewsStore } from '../../pipeline-store/backup'
import { adaptLiveNewsSignal } from '../../signal-platform/adapters/news-live'
import type { NewsSignal } from '../../signal-platform/contracts'
import { fingerprintNewsCandidate } from '../fingerprint'
import { ingestDiscoveredNewsCandidates, type DiscoveredNewsCandidate } from '../ingestion'
import { SqliteNewsStore } from '../sqlite-store'
import type { NewsCandidateObservationInput } from '../store'
import type { NewsCandidate } from '../types'
import { TEST_NEWS_SOURCE, TEST_NEWS_SOURCE_URL, testNewsCandidate } from './fixtures'

const nodeRequire = createRequire(__filename)
const { DatabaseSync } = nodeRequire('node:sqlite') as {
  DatabaseSync: new (path: string) => {
    exec(sql: string): void
    close(): void
  }
}

const observedAt = '2026-08-26T12:00:00.000Z'
const ARTICLE_URL = 'https://example.com/filing'

function discovery(overrides: { url?: string; headline?: string } = {}): DiscoveredNewsCandidate {
  return {
    source: TEST_NEWS_SOURCE,
    sourceUrl: TEST_NEWS_SOURCE_URL,
    candidate: testNewsCandidate({
      headline: overrides.headline ?? 'Filing appears in public records',
      article_url: overrides.url ?? ARTICLE_URL,
    }),
    observedAt,
  }
}

/** Exact validated adapted payload the store is expected to freeze. */
function signalFor(
  item: DiscoveredNewsCandidate,
  overrides: { headline?: string; url?: string } = {},
): NewsSignal {
  const candidate: NewsCandidate = {
    ...item.candidate,
    headline: overrides.headline ?? item.candidate.headline,
    article_url: overrides.url ?? item.candidate.article_url,
  }
  return adaptLiveNewsSignal({
    discovery: { ...item, candidate },
    fingerprint: fingerprintNewsCandidate(
      TEST_NEWS_SOURCE.sourceId,
      TEST_NEWS_SOURCE_URL.urlId,
      candidate,
    ),
    materialChange: false,
  })
}

function observationInput(
  item: DiscoveredNewsCandidate,
  signal?: NewsSignal,
): NewsCandidateObservationInput {
  return {
    source: item.source,
    sourceUrl: item.sourceUrl,
    candidate: item.candidate,
    fingerprint: fingerprintNewsCandidate(
      item.source.sourceId,
      item.sourceUrl.urlId,
      item.candidate,
    ),
    dedupeOutcome: 'new_candidate',
    observedAt: item.observedAt,
    ...(signal ? { deliverySignal: signal } : {}),
  }
}

async function withTempDb<T>(fn: (path: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'news-outbox-'))
  try {
    return await fn(join(dir, 'news.sqlite'))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

/** Observe-mode intake over the same SQLite file, as the collector composes it. */
function observeIntake(path: string): {
  intake: SourceSignalIntakePort
  canonical: SqliteSignalPlatformStore
} {
  const canonical = new SqliteSignalPlatformStore(path, 'news')
  return {
    canonical,
    intake: new CanonicalSourceSignalIntake({ mode: 'observe', store: canonical }),
  }
}

/** Fails the first `failuresBeforeSuccess` attempts, then delegates. */
class FlakyIntake implements SourceSignalIntakePort {
  readonly mode = 'observe' as const
  attempts = 0

  constructor(
    private readonly inner: SourceSignalIntakePort,
    private readonly failuresBeforeSuccess: number,
  ) {}

  async ingest(signal: Parameters<SourceSignalIntakePort['ingest']>[0]) {
    this.attempts += 1
    if (this.attempts <= this.failuresBeforeSuccess) {
      throw new Error('canonical platform store is unavailable at 10.0.0.5')
    }
    return this.inner.ingest(signal)
  }

  async retryUntriaged(limit: number) {
    return this.inner.retryUntriaged?.(limit) ?? emptySourceIntakeReport(this.mode)
  }
}

for (const loseAcknowledgement of [false, true]) {
  test(`active News delivery reports saved decision/work once${loseAcknowledgement ? ' when acknowledgement is lost' : ''}`, async () => {
    await withTempDb(async (path) => {
      const store = new SqliteNewsStore(path)
      const canonical = new SqliteSignalPlatformStore(path, 'news')
      const bucket = { available: 100, reservedAvailable: 10, utilization: 0 }
      const intake = createActiveSourceTriageIntake({
        store: canonical,
        providerHealth: 'healthy',
        clock: () => observedAt,
        allowedDepths: ['light', 'standard'],
        capacity: { snapshot: () => ({
          byPriority: { P0: { ...bucket }, P1: { ...bucket }, P2: { ...bucket }, P3: { ...bucket } },
          byDepth: { light: { ...bucket }, standard: { ...bucket }, deep: { ...bucket } },
        }) },
      })
      const item = discovery({ headline: 'Quarterly earnings guidance rises' })
      item.candidate.published_at = observedAt
      const originalAck = store.markSourceDeliveryDelivered.bind(store)
      let lostAck = false
      store.markSourceDeliveryDelivered = async (signalId) => {
        if (loseAcknowledgement && !lostAck) {
          lostAck = true
          throw new Error('simulated interruption after confirmed canonical writes')
        }
        await originalAck(signalId)
      }
      try {
        const first = await ingestDiscoveredNewsCandidates({ store, discoveries: [item], signalIntake: intake })
        assert.equal(first.delivery.insertedDecisions, 1)
        assert.equal(first.delivery.admittedWorkItems, 1)
        assert.equal(first.canonicalIntake.insertedDecisions, 1)
        assert.equal(first.canonicalIntake.admittedWorkItems, 1)
        assert.equal(first.delivery.failures.length, loseAcknowledgement ? 1 : 0)

        const repeated = await ingestDiscoveredNewsCandidates({ store, discoveries: [item], signalIntake: intake })
        assert.equal(repeated.delivery.insertedDecisions, 0)
        assert.equal(repeated.delivery.admittedWorkItems, 0)
        assert.equal(repeated.canonicalIntake.insertedDecisions, 0)
        assert.equal(repeated.canonicalIntake.admittedWorkItems, 0)
        assert.equal(repeated.drainedBeforeFeed.duplicateDeliveries, loseAcknowledgement ? 1 : 0)
        assert.deepEqual(await store.listPendingSourceDeliveries(10), [])
        const state = await canonical.readWorkObservability({ now: observedAt, recentFailureSince: observedAt, failureLimit: 10 })
        assert.equal(state.signalCount, 1)
        assert.equal(state.triageDecisionCount, 1)
        assert.ok(state.queueAge)
        assert.equal(state.queueAge.filter((row) => row.status === 'research_pending').reduce((count, row) => count + row.count, 0), 1)
      } finally {
        canonical.close()
        store.close()
      }
    })
  })
}

test('pre-migration observations gain no obligations and are never replayed', async () => {
  await withTempDb(async (path) => {
    const item = discovery()
    const fingerprint = fingerprintNewsCandidate(
      item.source.sourceId,
      item.sourceUrl.urlId,
      item.candidate,
    )
    const legacy = new DatabaseSync(path)
    legacy.exec(`
      CREATE TABLE news_candidate_observations (
        id TEXT PRIMARY KEY,
        source_run_id TEXT,
        source_id TEXT NOT NULL,
        source_name TEXT NOT NULL,
        url_id TEXT NOT NULL,
        url_label TEXT NOT NULL,
        source_url TEXT NOT NULL,
        canonical_article_url TEXT NOT NULL,
        headline TEXT NOT NULL,
        visible_summary TEXT,
        published_at TEXT,
        observed_at TEXT NOT NULL,
        headline_hash TEXT NOT NULL,
        summary_hash TEXT,
        content_hash TEXT NOT NULL,
        article_identity_key TEXT NOT NULL,
        observation_dedupe_key TEXT NOT NULL UNIQUE,
        dedupe_outcome TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending_research',
        raw_candidate TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      INSERT INTO news_candidate_observations (
        id, source_id, source_name, url_id, url_label, source_url, canonical_article_url,
        headline, observed_at, headline_hash, summary_hash, content_hash,
        article_identity_key, observation_dedupe_key, dedupe_outcome
      ) VALUES (
        'legacy-row', '${item.source.sourceId}', '${item.source.sourceName}', '${item.sourceUrl.urlId}', '${item.sourceUrl.label}',
        '${item.sourceUrl.url}', '${fingerprint.canonicalArticleUrl}',
        '${item.candidate.headline}', '${observedAt}', '${fingerprint.headlineHash}', '${fingerprint.summaryHash}',
        '${fingerprint.contentHash}', '${fingerprint.articleIdentityKey}', '${fingerprint.observationDedupeKey}', 'new_candidate'
      );
    `)
    legacy.close()

    const store = new SqliteNewsStore(path)
    const { intake, canonical } = observeIntake(path)
    try {
      assert.equal(
        (await store.fetchPriorObservations('news_feed:articles', [ARTICLE_URL])).length,
        1,
      )
      assert.deepEqual(await store.listPendingSourceDeliveries(10), [])

      // An unchanged feed must not enqueue anything nor replay the historic row.
      const result = await ingestDiscoveredNewsCandidates({
        store,
        discoveries: [item],
        signalIntake: intake,
      })
      assert.equal(result.candidatesUnchanged, 1)
      assert.equal(result.delivery.attempted, 0)
      assert.deepEqual(await store.listPendingSourceDeliveries(10), [])
      assert.equal(canonical.getSignal(signalFor(discovery()).signalId), null)
    } finally {
      canonical.close()
      store.close()
    }
  })
})

test('a failed delivery stays pending and an unchanged next feed retries the frozen payload', async () => {
  await withTempDb(async (path) => {
    const store = new SqliteNewsStore(path)
    const { intake: healthy, canonical } = observeIntake(path)
    const flaky = new FlakyIntake(healthy, 1)
    try {
      const item = discovery()
      const frozen = signalFor(item)
      const first = await ingestDiscoveredNewsCandidates({
        store,
        discoveries: [item],
        signalIntake: flaky,
      })
      assert.equal(first.candidateObservationsInserted, 1)
      assert.equal(first.delivery.failures.length, 1)
      assert.deepEqual(first.delivery.failures[0], {
        signalId: frozen.signalId,
        sourceType: 'news',
        code: 'SOURCE_SIGNAL_INTAKE_FAILED',
      })

      const [pending] = await store.listPendingSourceDeliveries(10)
      assert.ok(pending)
      assert.equal(pending.attemptCount, 1)
      assert.equal(pending.lastErrorCode, 'SOURCE_SIGNAL_INTAKE_FAILED')
      assert.deepEqual(pending.signal, frozen)
      // Redacted: the provider/database text never reaches the obligation row.
      assert.equal(JSON.stringify(pending).includes('10.0.0.5'), false)

      // Same unchanged feed: legacy ingestion continues and the older
      // obligation is retried from its frozen payload, not a new poll.
      const second = await ingestDiscoveredNewsCandidates({
        store,
        discoveries: [discovery()],
        signalIntake: flaky,
      })
      assert.equal(second.candidatesUnchanged, 1)
      assert.equal(second.drainedBeforeFeed.delivered, 1)
      assert.deepEqual(await store.listPendingSourceDeliveries(10), [])
      assert.ok(canonical.getSignal(frozen.signalId))
    } finally {
      canonical.close()
      store.close()
    }
  })
})

test('reopening the store recovers pending obligations and delivers them', async () => {
  await withTempDb(async (path) => {
    const first = new SqliteNewsStore(path)
    const { intake: healthy } = observeIntake(path)
    await ingestDiscoveredNewsCandidates({
      store: first,
      discoveries: [discovery()],
      signalIntake: new FlakyIntake(healthy, 1),
    })
    first.close()

    const reopened = new SqliteNewsStore(path)
    const { intake, canonical } = observeIntake(path)
    try {
      assert.equal((await reopened.listPendingSourceDeliveries(10)).length, 1)
      const drained = await ingestDiscoveredNewsCandidates({
        store: reopened,
        discoveries: [discovery()],
        signalIntake: intake,
      })
      assert.equal(drained.drainedBeforeFeed.delivered, 1)
      assert.deepEqual(await reopened.listPendingSourceDeliveries(10), [])
    } finally {
      canonical.close()
      reopened.close()
    }
  })
})

test('intake success followed by a lost acknowledgement replays idempotently', async () => {
  await withTempDb(async (path) => {
    const store = new SqliteNewsStore(path)
    const { intake, canonical } = observeIntake(path)
    try {
      const originalAck = store.markSourceDeliveryDelivered.bind(store)
      let loseFirstAck = true
      store.markSourceDeliveryDelivered = async (signalId) => {
        if (loseFirstAck) {
          loseFirstAck = false
          throw new Error('simulated interruption before source acknowledgement')
        }
        await originalAck(signalId)
      }

      const first = await ingestDiscoveredNewsCandidates({
        store,
        discoveries: [discovery()],
        signalIntake: intake,
      })
      assert.equal(first.delivery.failures.length, 1)
      const [pending] = await store.listPendingSourceDeliveries(10)
      assert.ok(pending)
      assert.ok(canonical.getSignal(pending.signalId), 'canonical intake succeeded before the source ack failed')
      assert.equal(pending.payloadDigest, sourceDeliveryDigest(pending.signal))

      const replay = await ingestDiscoveredNewsCandidates({
        store,
        discoveries: [discovery()],
        signalIntake: intake,
      })
      assert.equal(replay.drainedBeforeFeed.duplicateDeliveries, 1)
      assert.equal(replay.drainedBeforeFeed.failures.length, 0)
      assert.deepEqual(await store.listPendingSourceDeliveries(10), [])
      // Canonical stable identity keeps the exact replay idempotent.
      assert.equal(canonical.getSignal(pending.signalId)?.signalId, pending.signalId)
      const observability = await canonical.readWorkObservability({
        now: observedAt,
        recentFailureSince: '2026-08-01T00:00:00.000Z',
        failureLimit: 10,
      })
      assert.equal(observability.signalCount, 1)
    } finally {
      canonical.close()
      store.close()
    }
  })
})

test('off intake neither enqueues nor replays, and observations still persist', async () => {
  await withTempDb(async (path) => {
    const store = new SqliteNewsStore(path)
    const canonical = new SqliteSignalPlatformStore(path, 'news')
    const off = new CanonicalSourceSignalIntake({ mode: 'off', store: canonical })
    try {
      const result = await ingestDiscoveredNewsCandidates({
        store,
        discoveries: [discovery()],
        signalIntake: off,
      })
      assert.equal(result.candidateObservationsInserted, 1)
      assert.equal(result.delivery.attempted, 0)
      assert.deepEqual(await store.listPendingSourceDeliveries(10), [])

      const active = new CanonicalSourceSignalIntake({ mode: 'observe', store: canonical })
      const second = await ingestDiscoveredNewsCandidates({
        store,
        discoveries: [discovery()],
        signalIntake: active,
      })
      assert.equal(second.candidateObservationsInserted, 0)
      assert.equal(second.delivery.attempted, 0)
      assert.deepEqual(await store.listPendingSourceDeliveries(10), [])
      assert.equal(canonical.getSignal(signalFor(discovery()).signalId), null)
    } finally {
      canonical.close()
      store.close()
    }
  })
})

test('a mid-batch failure rolls back the observation and its obligation together', async () => {
  const store = new SqliteNewsStore(':memory:')
  try {
    const conflicting = discovery({ url: 'https://example.com/conflict' })
    const firstPayload = signalFor(conflicting)
    const conflictingSignal: NewsSignal = { ...firstPayload, title: 'rewritten payload' }
    await store.insertCandidateObservations([observationInput(conflicting, firstPayload)])

    const good = discovery({ url: 'https://example.com/good' })
    await assert.rejects(
      store.insertCandidateObservations([
        observationInput(good, signalFor(good)),
        observationInput(conflicting, conflictingSignal),
      ]),
      ImmutableRecordConflictError,
    )

    // The good row from the rolled-back batch left no trace, and the existing
    // obligation was not duplicated or mutated by the failed transaction.
    assert.deepEqual(await store.fetchPriorObservations(
      TEST_NEWS_SOURCE.sourceId,
      ['https://example.com/good'],
    ), [])
    const pending = await store.listPendingSourceDeliveries(10)
    assert.equal(pending.length, 1)
    assert.equal(pending[0]?.payloadDigest, sourceDeliveryDigest(firstPayload))
  } finally {
    store.close()
  }
})

test('reusing a signal id with a different canonical payload is a hard conflict', async () => {
  const store = new SqliteNewsStore(':memory:')
  try {
    const item = discovery()
    const first = signalFor(item)
    const second: NewsSignal = { ...first, title: 'different payload under the same id' }
    assert.equal(first.signalId, second.signalId)
    assert.notEqual(sourceDeliveryDigest(first), sourceDeliveryDigest(second))

    await store.insertCandidateObservations([observationInput(item, first)])
    await assert.rejects(
      store.insertCandidateObservations([observationInput(item, second)]),
      ImmutableRecordConflictError,
    )
    // The same payload again is idempotent rather than a conflict.
    await store.insertCandidateObservations([observationInput(item, first)])
    const laterPoll: NewsSignal = { ...first, observedAt: '2026-08-27T12:00:00.000Z' }
    await store.insertCandidateObservations([observationInput(item, laterPoll)])
    const [pending] = await store.listPendingSourceDeliveries(10)
    assert.equal(pending?.payloadDigest, sourceDeliveryDigest(first))
    assert.equal(pending?.signal.observedAt, first.observedAt, 'the first frozen observation time is retained')
  } finally {
    store.close()
  }
})

test('an invalid adapted payload is refused rather than frozen', async () => {
  const store = new SqliteNewsStore(':memory:')
  try {
    const item = discovery()
    const invalid = { ...signalFor(item), sourceType: 'polymarket' as const } as unknown as NewsSignal
    await assert.rejects(store.insertCandidateObservations([observationInput(item, invalid)]))
    assert.deepEqual(await store.listPendingSourceDeliveries(10), [])
    assert.deepEqual(await store.fetchPriorObservations(
      TEST_NEWS_SOURCE.sourceId,
      [ARTICLE_URL],
    ), [])
  } finally {
    store.close()
  }
})

test('outbox does not acknowledge a mismatched or off intake result', async () => {
  const store = new SqliteNewsStore(':memory:')
  try {
    const item = discovery()
    const signal = signalFor(item)
    await store.insertCandidateObservations([observationInput(item, signal)])
    const invalidAck: SourceSignalIntakePort = {
      mode: 'observe',
      async ingest(): Promise<SourceSignalIntakeResult> {
        return {
          mode: 'off',
          signalId: 'different-signal',
          signalInserted: false,
          decisionInserted: false,
          workInserted: false,
          decision: null,
          work: null,
          recovered: false,
          held: null,
        }
      },
    }

    const result = await drainSourceDeliveries({ store, intake: invalidAck })
    assert.equal(result.failures.length, 1)
    assert.deepEqual((await store.listPendingSourceDeliveries(10)).map((row) => row.signalId), [signal.signalId])
  } finally {
    store.close()
  }
})

test('News backup and restore retain pending source delivery obligations', async () => {
  await withTempDb(async (path) => {
    const expected = signalFor(discovery())
    const source = new SqliteNewsStore(path)
    try {
      await source.insertCandidateObservations([observationInput(discovery(), expected)])
    } finally {
      source.close()
    }

    const backup = await backupNewsStore({
      sourcePath: path,
      backupDir: join(dirname(path), 'backups'),
    })
    assert.equal(backup.tableCounts.news_source_delivery_outbox, 1)
    const targetPath = join(dirname(path), 'restored', 'news.sqlite')
    await restoreNewsStore({ backupPath: backup.path, targetPath })

    const restored = new SqliteNewsStore(targetPath)
    try {
      const [pending] = await restored.listPendingSourceDeliveries(10)
      assert.equal(pending?.signal.signalId, expected.signalId)
      assert.equal(pending?.payloadDigest, sourceDeliveryDigest(expected))
    } finally {
      restored.close()
    }
  })
})
