import assert from 'node:assert/strict'
import test from 'node:test'

import type { ResearchWorkItem, Signal } from './contracts'
import { SharedResearchScheduler } from './shared-scheduler'
import type {
  BeginAttemptCommand,
  HeartbeatCommand,
  LeaseCommand,
  LeasedTransitionCommand,
  RecoveryResult,
  ReleaseLeaseCommand,
  ResearchWorkStoreAdapter,
  SchedulerAggregateStatus,
  SchedulerQuery,
  WorkLease,
} from './store-adapter'

const NOW = '2026-08-26T12:00:00.000Z'

class FakeStore implements ResearchWorkStoreAdapter {
  readonly claims: LeaseCommand[] = []
  readonly peeks: SchedulerQuery[] = []
  readonly sourceType: Signal['sourceType']
  failFirstClaim = false

  constructor(sourceType: Signal['sourceType'], readonly work: ResearchWorkItem[]) {
    this.sourceType = sourceType
  }

  async peekSchedulable(query: SchedulerQuery): Promise<ResearchWorkItem[]> {
    this.peeks.push(structuredClone(query))
    return this.work.filter((item) => item.status.endsWith('_pending'))
      .filter((item) => !query.priorityClasses || query.priorityClasses.includes(item.priorityClass))
      .filter((item) => !query.researchDepths || query.researchDepths.includes(item.researchDepth))
      .slice(0, query.limit)
  }

  async claimWithLease(command: LeaseCommand): Promise<WorkLease | null> {
    this.claims.push(command)
    if (this.failFirstClaim) {
      this.failFirstClaim = false
      return null
    }
    const work = this.work.find((item) => item.workId === command.workId && item.status === command.expectedStatus)
    if (work === undefined) return null
    const queuedAt = work.updatedAt
    work.status = command.expectedStatus === 'research_pending'
      ? 'retrieval_leased'
      : command.expectedStatus === 'deep_pending' ? 'deep_leased'
        : command.expectedStatus === 'synthesis_pending' ? 'synthesis_leased' : 'entity_leased'
    work.leaseOwner = command.leaseOwner
    work.leaseId = command.leaseId
    work.leaseExpiresAt = command.leaseExpiresAt
    return {
      work: structuredClone(work), leaseOwner: command.leaseOwner, leaseId: command.leaseId,
      leaseExpiresAt: command.leaseExpiresAt, queuedAt,
    }
  }

  async beginAttempt(_command: BeginAttemptCommand): Promise<boolean> { return true }
  async heartbeatLease(_command: HeartbeatCommand): Promise<boolean> { return true }
  async transitionLeased(_command: LeasedTransitionCommand): Promise<boolean> { return true }
  async releaseLease(_command: ReleaseLeaseCommand): Promise<boolean> { return true }
  async recoverExpiredLeases(_input: { now: string; limit: number }): Promise<RecoveryResult> {
    return { recoveredWorkIds: this.work.map((item) => item.workId) }
  }
  async getSchedulerStatus(_input: { now: string }): Promise<SchedulerAggregateStatus> {
    return { total: this.work.length, byStatus: {}, oldestReadyAt: this.work[0]?.createdAt ?? null, oldestLeaseExpiresAt: null }
  }
}

function makeWork(sourceType: Signal['sourceType'], workId: string, overrides: Partial<ResearchWorkItem> = {}): ResearchWorkItem {
  return {
    schemaVersion: 'myboon.research_work.v1', workId, signalId: `signal-${workId}`, sourceType,
    researchDepth: 'light', deepReason: null, priorityClass: 'P2', priorityScore: 0.5,
    freshnessDeadline: '2026-08-26T13:00:00.000Z', policyVersion: 'triage-v1',
    researchContractVersion: 'myboon.research_packet.v1',
    retrievalPlan: { sourceUrl: 'https://example.com', allowedDomains: ['example.com'], maxExternalSources: 1 },
    budget: { maxProviderCalls: 1, maxRepairCalls: 1, maxInputTokens: 2_000, maxOutputTokens: 500, maxToolCalls: 0, maxWallTimeMs: 30_000 },
    status: 'research_pending', attemptCount: 0, nextAttemptAt: null, leaseOwner: null, leaseId: null,
    leaseExpiresAt: null, failureCategory: null, failureDetail: null, traceId: `trace-${workId}`,
    createdAt: NOW, updatedAt: NOW, ...overrides,
  }
}

test('globally merges bounded store heads by priority, freshness, score, and age', async () => {
  const news = new FakeStore('news', [makeWork('news', 'news-p2')])
  const polymarket = new FakeStore('polymarket', [makeWork('polymarket', 'poly-p0', { priorityClass: 'P0' })])
  const scheduler = new SharedResearchScheduler([news, polymarket])

  const result = await scheduler.peekGlobal({ now: NOW, limit: 2 })
  assert.deepEqual(result.map((item) => item.workId), ['poly-p0', 'news-p2'])
})

test('claim retries the next globally eligible item after a store loses CAS', async () => {
  const news = new FakeStore('news', [makeWork('news', 'news-p0', { priorityClass: 'P0' })])
  const polymarket = new FakeStore('polymarket', [makeWork('polymarket', 'poly-p1', { priorityClass: 'P1' })])
  news.failFirstClaim = true
  const scheduler = new SharedResearchScheduler([news, polymarket], { createLeaseId: () => 'lease-test' })

  const lease = await scheduler.claimNext({ now: NOW, leaseOwner: 'worker-1', leaseTtlMs: 60_000 })
  assert.equal(lease?.work.workId, 'poly-p1')
  assert.equal(news.claims.length, 1)
  assert.equal(polymarket.claims.length, 1)
  assert.equal(lease?.leaseExpiresAt, '2026-08-26T12:01:00.000Z')
})

test('priority filter preserves reserved-class claim capacity', async () => {
  const news = new FakeStore('news', [
    makeWork('news', 'news-p2', { priorityClass: 'P2' }),
    makeWork('news', 'news-p0', { priorityClass: 'P0' }),
  ])
  const scheduler = new SharedResearchScheduler([news], { perStorePeekLimit: 1, createLeaseId: () => 'lease-urgent' })

  const lease = await scheduler.claimNext({
    now: NOW, leaseOwner: 'urgent-worker', leaseTtlMs: 30_000, priorityClasses: ['P0'],
  })
  assert.equal(lease?.work.workId, 'news-p0')
  assert.equal(news.claims.length, 1)
  assert.deepEqual(news.peeks[0]?.priorityClasses, ['P0'])
})

test('global scheduler propagates research depth capabilities to store heads', async () => {
  const news = new FakeStore('news', [
    makeWork('news', 'standard-ahead', { researchDepth: 'standard', priorityClass: 'P0' }),
    makeWork('news', 'light-supported', { researchDepth: 'light', priorityClass: 'P3' }),
  ])
  const scheduler = new SharedResearchScheduler([news], { perStorePeekLimit: 1 })
  const rows = await scheduler.peekGlobal({ now: NOW, limit: 1, researchDepths: ['light'] })
  assert.deepEqual(rows.map((row) => row.workId), ['light-supported'])
  assert.deepEqual(news.peeks[0]?.researchDepths, ['light'])
})

test('rejects duplicate source adapters and aggregates status/recovery', async () => {
  const news = new FakeStore('news', [makeWork('news', 'news-1')])
  const polymarket = new FakeStore('polymarket', [makeWork('polymarket', 'poly-1')])
  assert.throws(() => new SharedResearchScheduler([news, new FakeStore('news', [])]), /Duplicate/)

  const scheduler = new SharedResearchScheduler([news, polymarket])
  assert.deepEqual(await scheduler.recoverExpiredLeases({ now: NOW, limitPerStore: 10 }), {
    news: ['news-1'], polymarket: ['poly-1'],
  })
  const status = await scheduler.getStatus({ now: NOW })
  assert.equal(status.total, 2)
  assert.deepEqual(Object.keys(status.bySource).sort(), ['news', 'polymarket'])
})
