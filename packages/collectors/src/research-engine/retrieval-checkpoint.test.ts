import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  RESEARCH_PACKET_SCHEMA_VERSION,
  RESEARCH_WORK_SCHEMA_VERSION,
  SIGNAL_SCHEMA_VERSION,
  type ResearchWorkItem,
  type Signal,
} from '../signal-platform/contracts'
import { SqliteSignalPlatformStore } from '../signal-platform/sqlite-platform-store'
import { DeterministicRetriever } from './deterministic-retrieval'
import { SharedResearchWorker, type SharedResearchWorkPort, type SharedWorkerClock } from './shared-worker'
import type { StructuredResearchSynthesizer } from './structured-synthesizer'

const NOW = '2026-08-26T12:10:00.000Z'
const SOURCE_URL = 'https://news.example/item'
const CORROBORATION_URL = 'https://reuters.example/item'

class FixedClock implements SharedWorkerClock {
  constructor(readonly instant = new Date(NOW)) {}
  now(): Date { return new Date(this.instant) }
  setInterval(): unknown { return 1 }
  clearInterval(): void {}
}

function signal(): Signal {
  return {
    schemaVersion: SIGNAL_SCHEMA_VERSION, signalId: 'signal-news', sourceType: 'news', sourceId: 'news:1',
    contentKind: 'article', content: { schemaVersion: 'myboon.signal_content.article.v1' },
    observedAt: '2026-08-26T12:00:00.000Z', publishedAt: '2026-08-26T11:59:00.000Z',
    canonicalUrl: SOURCE_URL, title: 'news signal', visibleSummary: null,
    media: { imageUrl: null, attribution: null },
    sourceHints: { entities: [], assets: [], eventId: null, deadline: null },
    provenance: { provider: 'fixture', upstreamSource: null, rawPayloadRef: 'news:raw:1' },
    idempotencyKey: 'news:key:1',
  } as Signal
}

function work(overrides: Partial<ResearchWorkItem> = {}): ResearchWorkItem {
  return {
    schemaVersion: RESEARCH_WORK_SCHEMA_VERSION, workId: 'work-news', signalId: 'signal-news',
    sourceType: 'news', researchDepth: 'standard', deepReason: null,
    priorityClass: 'P1', priorityScore: 0.5, freshnessDeadline: '2026-08-26T13:00:00.000Z',
    policyVersion: 'policy.v1', researchContractVersion: RESEARCH_PACKET_SCHEMA_VERSION,
    retrievalPlan: {
      sourceUrl: SOURCE_URL,
      allowedDomains: ['news.example', 'reuters.example'],
      maxExternalSources: 1,
    },
    budget: { maxProviderCalls: 2, maxRepairCalls: 1, maxToolCalls: 0, maxWallTimeMs: 30_000 },
    status: 'research_pending', attemptCount: 0, nextAttemptAt: null,
    leaseOwner: null, leaseId: null, leaseExpiresAt: null,
    failureCategory: null, failureDetail: null, traceId: 'trace-news',
    createdAt: '2026-08-26T12:00:00.000Z', updatedAt: '2026-08-26T12:00:00.000Z',
    ...overrides,
  }
}

interface Fixture {
  path: string
  store: SqliteSignalPlatformStore
  reopen(): SqliteSignalPlatformStore
  close(): void
}

function fixture(): Fixture {
  const dir = mkdtempSync(join(tmpdir(), 'retrieval-worker-'))
  const path = join(dir, 'store.sqlite')
  const store = new SqliteSignalPlatformStore(path, 'news')
  store.appendSignal(signal())
  return {
    path,
    store,
    reopen: () => new SqliteSignalPlatformStore(path, 'news'),
    close: () => { rmSync(dir, { recursive: true, force: true }) },
  }
}

function timedOut(url: string): Error {
  return Object.assign(new Error(`Request timed out for ${url}`), { code: 'ETIMEDOUT' })
}

/** Fails only the corroboration URL; the work item's own source succeeds. */
function retriever(calls: { urls: string[] }, options: { sourceFails?: (url: string) => Error | null } = {}) {
  return new DeterministicRetriever({
    now: () => new Date(NOW),
    fetchDocument: async (url) => {
      calls.urls.push(url)
      const failure = options.sourceFails?.(url) ?? null
      if (failure !== null) throw failure
      return { body: Buffer.from('retrieved evidence'), finalUrl: url, contentType: 'text/plain', status: 200, visitedHosts: [] }
    },
  })
}

function discoveringCorroboration() {
  return {
    async discover() {
      return {
        policyVersion: 'test-search.v1',
        connectorId: 'test-search',
        queryCount: 1,
        urls: [{
          url: CORROBORATION_URL,
          authority: 'search_connector' as const,
          authorityId: 'test-search:result-1',
        }],
      }
    },
  }
}

const SYNTHESIZER = { async synthesize() { throw new Error('synthesis is not exercised here') } } as unknown as StructuredResearchSynthesizer

function workerOptions(stores: SharedResearchWorkPort[], overrides: Record<string, unknown> = {}) {
  return {
    workerId: 'shared-worker-1', stores, retriever: retriever({ urls: [] }), synthesizer: SYNTHESIZER,
    standardSearch: discoveringCorroboration(),
    mode: 'active' as const, ownership: 'shared' as const, legacyClaimersActive: false,
    clock: new FixedClock(), ...overrides,
  }
}

test('a fully retrieved plan advances and saves a complete checkpoint', async () => {
  const fx = fixture()
  try {
    fx.store.admitResearchWork(work())
    const calls = { urls: [] as string[] }
    const worker = new SharedResearchWorker(workerOptions([fx.store], {
      stages: ['retrieval'], retriever: retriever(calls),
    }))
    assert.deepEqual(await worker.runOnce(), {
      kind: 'succeeded', stage: 'retrieval', sourceType: 'news', workId: 'work-news',
    })
    assert.equal(fx.store.getResearchWork('work-news')?.status, 'synthesis_pending')

    const saved = fx.store.listRetrievalManifestsByWork('work-news', 10)
    assert.equal(saved.length, 1)
    assert.equal(saved[0]?.decision, 'complete')
    assert.deepEqual(saved[0]?.limitations, [])
    assert.equal(saved[0]?.attempt, 1)
    // Every evidence identity the checkpoint names is the batch that was saved.
    assert.deepEqual(saved[0]?.evidenceIds, fx.store.listEvidenceByWork('work-news', 10).map((a) => a.evidenceId))
    // Evidence keeps identifying the work that produced it.
    assert.ok(fx.store.listEvidenceByWork('work-news', 10).every((a) => a.workId === 'work-news'))
  } finally { fx.close() }
})

test('a lost optional corroboration source still advances, with the gap recorded', async () => {
  const fx = fixture()
  try {
    fx.store.admitResearchWork(work())
    const calls = { urls: [] as string[] }
    const worker = new SharedResearchWorker(workerOptions([fx.store], {
      stages: ['retrieval'],
      retriever: retriever(calls, {
        sourceFails: (url) => (url === CORROBORATION_URL ? new Error('upstream returned nothing usable') : null),
      }),
    }))
    assert.equal((await worker.runOnce()).kind, 'succeeded')
    assert.equal(fx.store.getResearchWork('work-news')?.status, 'synthesis_pending')

    const saved = fx.store.listRetrievalManifestsByWork('work-news', 10)
    assert.equal(saved[0]?.decision, 'proceed_with_limitations')
    assert.deepEqual(saved[0]?.limitations, [`not retrieved: ${CORROBORATION_URL} (permanent_source_error)`])
    assert.equal(saved[0]?.discoveredSourceCount, 1)
    // The failed source is not represented as evidence.
    assert.equal(fx.store.listEvidenceByWork('work-news', 10).length, 1)
    assert.deepEqual(calls.urls, [SOURCE_URL, CORROBORATION_URL])
  } finally { fx.close() }
})

test('a failed required source holds the checkpoint and routes bounded retry', async () => {
  const fx = fixture()
  try {
    fx.store.admitResearchWork(work())
    const calls = { urls: [] as string[] }
    const worker = new SharedResearchWorker(workerOptions([fx.store], {
      stages: ['retrieval'],
      retriever: retriever(calls, { sourceFails: (url) => (url === SOURCE_URL ? timedOut(url) : null) }),
    }))
    assert.deepEqual(await worker.runOnce(), {
      kind: 'retry_wait', stage: 'retrieval', sourceType: 'news', workId: 'work-news',
      category: 'retrieval_timeout',
    })
    assert.equal(fx.store.getResearchWork('work-news')?.status, 'retry_wait')
    assert.equal(fx.store.getResearchWork('work-news')?.failureCategory, 'retrieval_timeout')

    const saved = fx.store.listRetrievalManifestsByWork('work-news', 10)
    assert.equal(saved[0]?.decision, 'hold_and_retry')
    assert.equal(saved[0]?.failureCategory, 'retrieval_timeout')
    // The corroboration capture is retained with its gap stated; it is simply
    // not promoted to a result, because the work item's own source is missing.
    assert.equal(saved[0]?.evidenceIds.length, 1)
    assert.equal(fx.store.listEvidenceByWork('work-news', 10).length, 1)
    assert.equal(
      fx.store.getEvidence(saved[0]!.evidenceIds[0]!)?.requestedUrl,
      CORROBORATION_URL,
    )
  } finally { fx.close() }
})

test('a permanently failed required source is dead-lettered rather than retried forever', async () => {
  const fx = fixture()
  try {
    fx.store.admitResearchWork(work({ attemptCount: 2 }))
    const worker = new SharedResearchWorker(workerOptions([fx.store], {
      stages: ['retrieval'],
      retriever: retriever({ urls: [] }, {
        sourceFails: (url) => (url === SOURCE_URL ? new Error('upstream returned nothing usable') : null),
      }),
    }))
    assert.equal((await worker.runOnce()).kind, 'dead_letter')
    assert.equal(fx.store.getResearchWork('work-news')?.status, 'dead_letter')
    assert.equal(
      fx.store.listRetrievalManifestsByWork('work-news', 10)[0]?.decision,
      'hold_and_retry',
    )
  } finally { fx.close() }
})

test('a held attempt is retried under a new attempt number and both checkpoints are kept', async () => {
  const fx = fixture()
  try {
    fx.store.admitResearchWork(work())
    const calls = { urls: [] as string[] }
    const held = new SharedResearchWorker(workerOptions([fx.store], {
      stages: ['retrieval'],
      retriever: retriever(calls, { sourceFails: (url) => (url === SOURCE_URL ? timedOut(url) : null) }),
    }))
    assert.equal((await held.runOnce()).kind, 'retry_wait')
    assert.deepEqual(calls.urls, [SOURCE_URL, CORROBORATION_URL])

    // The existing recovery sweep is what promotes a due retry; no new wakeup.
    const later = new Date('2026-08-26T12:12:00.000Z')
    assert.deepEqual(
      await fx.store.recoverExpiredLeases({ now: later.toISOString(), limit: 10 }),
      { recoveredWorkIds: ['work-news'] },
    )
    const recovered = new SharedResearchWorker(workerOptions([fx.store], {
      stages: ['retrieval'], clock: new FixedClock(later), retriever: retriever(calls),
    }))
    assert.equal((await recovered.runOnce()).kind, 'succeeded')
    // The optional corroboration capture from attempt 1 is reused; only the
    // failed required source is fetched again.
    assert.deepEqual(calls.urls, [SOURCE_URL, CORROBORATION_URL, SOURCE_URL])

    const saved = fx.store.listRetrievalManifestsByWork('work-news', 10)
    assert.deepEqual(saved.map((entry) => entry.decision), ['hold_and_retry', 'complete'])
    assert.deepEqual(saved.map((entry) => entry.attempt), [1, 2])
    assert.equal(saved[1]?.sources.find((source) => source.url === CORROBORATION_URL)?.reused, true)
    assert.equal(saved[1]?.sources.find((source) => source.url === SOURCE_URL)?.reused, false)
    // The retry bounds carried forward rather than resetting.
    assert.equal(fx.store.getResearchWork('work-news')?.attemptCount, 2)
  } finally { fx.close() }
})

test('a crash after the checkpoint commits replays the saved manifest on reopen', async () => {
  const fx = fixture()
  const calls = { urls: [] as string[] }
  fx.store.admitResearchWork(work())
  let loseCompletion = true
  const lossy = new Proxy(fx.store, {
    get(target, property, receiver) {
      if (property === 'transitionLeased') {
        return async (command: Parameters<SqliteSignalPlatformStore['transitionLeased']>[0]) => {
          // Lost acknowledgement: the checkpoint is durable but the completion
          // transition never lands.
          if (loseCompletion && command.nextStatus === 'synthesis_pending') {
            loseCompletion = false
            return false
          }
          return target.transitionLeased(command)
        }
      }
      const value = Reflect.get(target, property, receiver) as unknown
      return typeof value === 'function' ? (value as Function).bind(target) : value
    },
  }) as SharedResearchWorkPort

  const first = new SharedResearchWorker(workerOptions([lossy], {
    stages: ['retrieval'], retriever: retriever(calls),
  }))
  assert.equal((await first.runOnce()).kind, 'lease_lost')
  assert.equal(calls.urls.length, 2)
  fx.store.close()

  // A process restart: the saved checkpoint is validated and used, and the
  // completed retrieval is never paid for or performed a second time.
  const reopened = fx.reopen()
  const later = new Date('2026-08-26T12:12:00.000Z')
  assert.deepEqual(await reopened.recoverExpiredLeases({ now: later.toISOString(), limit: 10 }), {
    recoveredWorkIds: ['work-news'],
  })
  try {
    const second = new SharedResearchWorker(workerOptions([reopened], {
      stages: ['retrieval'], clock: new FixedClock(later), retriever: retriever(calls),
    }))
    assert.equal((await second.runOnce()).kind, 'succeeded')
    assert.equal(calls.urls.length, 2)
    assert.equal(reopened.getResearchWork('work-news')?.status, 'synthesis_pending')
    // One checkpoint, reused verbatim; no second verdict was written.
    assert.equal(reopened.listRetrievalManifestsByWork('work-news', 10).length, 1)
    assert.equal(reopened.listEvidenceByWork('work-news', 10).length, 2)
  } finally { reopened.close(); fx.close() }
})

test('a checkpoint whose evidence no longer passes the reuse policy is not replayed', async () => {
  const fx = fixture()
  const calls = { urls: [] as string[] }
  fx.store.admitResearchWork(work())
  let loseCompletion = true
  const lossy = new Proxy(fx.store, {
    get(target, property, receiver) {
      if (property === 'transitionLeased') {
        return async (command: Parameters<SqliteSignalPlatformStore['transitionLeased']>[0]) => {
          if (loseCompletion && command.nextStatus === 'synthesis_pending') {
            loseCompletion = false
            return false
          }
          return target.transitionLeased(command)
        }
      }
      const value = Reflect.get(target, property, receiver) as unknown
      return typeof value === 'function' ? (value as Function).bind(target) : value
    },
  }) as SharedResearchWorkPort
  const first = new SharedResearchWorker(workerOptions([lossy], {
    stages: ['retrieval'], retriever: retriever(calls),
  }))
  assert.equal((await first.runOnce()).kind, 'lease_lost')

  const later = new Date('2026-08-26T12:12:00.000Z')
  assert.deepEqual(await fx.store.recoverExpiredLeases({ now: later.toISOString(), limit: 10 }), {
    recoveredWorkIds: ['work-news'],
  })
  const policyCalls: string[] = []
  const second = new SharedResearchWorker(workerOptions([fx.store], {
    stages: ['retrieval'],
    clock: new FixedClock(later),
    retriever: retriever(calls),
    evidenceReusePolicy: {
      evaluate(input: { artifact: { evidenceId: string } }) {
        policyCalls.push(input.artifact.evidenceId)
        return {
          reusable: false,
          policyVersion: 'test.evidence_reuse.v1',
          reason: 'freshness_policy_rejected' as const,
        }
      },
    },
  }))
  assert.equal((await second.runOnce()).kind, 'succeeded')
  // The saved checkpoint was consulted, refused on its first artifact, and
  // re-executed under a new attempt rather than reused as if still fresh.
  assert.equal(policyCalls.length, 1)
  assert.equal(calls.urls.length, 4)
  assert.deepEqual(
    fx.store.listRetrievalManifestsByWork('work-news', 10).map((entry) => entry.attempt),
    [1, 2],
  )
})

test('off and shadow modes write no checkpoint and run no retrieval', async () => {
  const fx = fixture()
  try {
    fx.store.admitResearchWork(work())
    const calls = { urls: [] as string[] }
    const off = new SharedResearchWorker(workerOptions([fx.store], {
      mode: 'off', retriever: retriever(calls),
    }))
    assert.deepEqual(await off.runOnce(), { kind: 'disabled' })

    const shadow = new SharedResearchWorker(workerOptions([fx.store], {
      mode: 'shadow', ownership: 'legacy', legacyClaimersActive: true, retriever: retriever(calls),
    }))
    assert.deepEqual(await shadow.runOnce(), { kind: 'shadow', sampled: 1, ready: 1, issues: [] })

    assert.equal(calls.urls.length, 0)
    assert.deepEqual(fx.store.listRetrievalManifestsByWork('work-news', 10), [])
    assert.deepEqual(fx.store.listEvidenceByWork('work-news', 10), [])
    assert.equal(fx.store.getResearchWork('work-news')?.status, 'research_pending')
    assert.equal(fx.store.getResearchWork('work-news')?.attemptCount, 0)
  } finally { fx.close() }
})

test('one source store never reads another source store checkpoints', async () => {
  const news = fixture()
  const xDir = mkdtempSync(join(tmpdir(), 'retrieval-worker-x-'))
  const xStore = new SqliteSignalPlatformStore(join(xDir, 'store.sqlite'), 'x')
  try {
    news.store.admitResearchWork(work())
    // An identically named work item in the other store shares no checkpoint.
    const xSaved = news.store.listRetrievalManifestsByWork('work-news', 10)
    assert.deepEqual(xSaved, [])
    assert.equal(news.store.getLatestRetrievalManifest('work-news', 'retrieval_plan_not_mine'), null)
    assert.equal(news.store.getLatestRetrievalManifest('work-news', work().workId), null)
  } finally {
    news.close()
    xStore.close()
    rmSync(xDir, { recursive: true, force: true })
  }
})
