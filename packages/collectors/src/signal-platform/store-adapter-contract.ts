import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { ResearchWorkItem } from './contracts'
import { compareResearchWorkPriority, type ResearchWorkStoreAdapter } from './store-adapter'

export interface SchedulerStoreContractHarness {
  create(): Promise<{
    store: ResearchWorkStoreAdapter
    seed(items: ResearchWorkItem[]): Promise<void>
    read(workId: string): Promise<ResearchWorkItem | null>
    close(): Promise<void>
  }>
  makeWork(overrides?: Partial<ResearchWorkItem>): ResearchWorkItem
}

/** Reusable contract suite for SQLite, Supabase, or test store adapters. */
export function runSchedulerStoreContract(harness: SchedulerStoreContractHarness): void {
  describe('ResearchWorkStoreAdapter contract', () => {
    it('uses one global priority order across source adapter heads', () => {
      const rows = [
        harness.makeWork({ workId: 'news-low', sourceType: 'news', priorityClass: 'P2' }),
        harness.makeWork({ workId: 'poly-high', sourceType: 'polymarket', priorityClass: 'P0' }),
      ].sort(compareResearchWorkPriority)
      assert.deepEqual(rows.map((row) => row.workId), ['poly-high', 'news-low'])
    })

    it('allows exactly one compare-and-swap lease winner', async () => {
      const fixture = await harness.create()
      try {
        const queued = harness.makeWork({ workId: 'race' })
        await fixture.seed([queued])
        const command = {
          workId: 'race', expectedStatus: 'research_pending' as const,
          leaseExpiresAt: '2026-08-26T12:01:00.000Z', now: '2026-08-26T12:00:00.000Z',
        }
        const [first, second] = await Promise.all([
          fixture.store.claimWithLease({ ...command, leaseOwner: 'a', leaseId: 'lease-a' }),
          fixture.store.claimWithLease({ ...command, leaseOwner: 'b', leaseId: 'lease-b' }),
        ])
        assert.equal(Number(first !== null) + Number(second !== null), 1)
        assert.equal((first ?? second)?.queuedAt, queued.updatedAt)
        assert.equal((await fixture.read('race'))?.attemptCount, 0)
      } finally {
        await fixture.close()
      }
    })

    it('fences heartbeat and transition by owner and lease id', async () => {
      const fixture = await harness.create()
      try {
        await fixture.seed([harness.makeWork({ workId: 'fenced' })])
        const lease = await fixture.store.claimWithLease({
          workId: 'fenced', expectedStatus: 'research_pending', leaseOwner: 'worker', leaseId: 'lease-1',
          leaseExpiresAt: '2026-08-26T12:01:00.000Z', now: '2026-08-26T12:00:00.000Z',
        })
        assert.ok(lease)
        assert.equal(await fixture.store.heartbeatLease({
          workId: 'fenced', leaseOwner: 'worker', leaseId: 'stale',
          leaseExpiresAt: '2026-08-26T12:02:00.000Z', now: '2026-08-26T12:00:30.000Z',
        }), false)
        assert.equal(await fixture.store.transitionLeased({
          workId: 'fenced', leaseOwner: 'worker', leaseId: 'stale', expectedStatus: 'retrieval_leased',
          nextStatus: 'synthesis_pending', now: '2026-08-26T12:00:30.000Z', attemptDelta: 1,
        }), false)
        assert.equal((await fixture.read('fenced'))?.status, 'retrieval_leased')
      } finally {
        await fixture.close()
      }
    })

    it('records provider execution start once per lease', async () => {
      const fixture = await harness.create()
      try {
        await fixture.seed([harness.makeWork({ workId: 'attempt' })])
        await fixture.store.claimWithLease({
          workId: 'attempt', expectedStatus: 'research_pending', leaseOwner: 'worker', leaseId: 'attempt-lease',
          leaseExpiresAt: '2026-08-26T12:01:00.000Z', now: '2026-08-26T12:00:00.000Z',
        })
        const begin = {
          workId: 'attempt', expectedStatus: 'retrieval_leased' as const,
          leaseOwner: 'worker', leaseId: 'attempt-lease', now: '2026-08-26T12:00:10.000Z',
        }
        assert.equal(await fixture.store.beginAttempt(begin), true)
        assert.equal(await fixture.store.beginAttempt({ ...begin, now: '2026-08-26T12:00:20.000Z' }), false)
        assert.equal((await fixture.read('attempt'))?.attemptCount, 1)
      } finally {
        await fixture.close()
      }
    })

    it('releases and recovers leases without spending attempts', async () => {
      const fixture = await harness.create()
      try {
        await fixture.seed([
          harness.makeWork({ workId: 'release' }),
          harness.makeWork({ workId: 'expire' }),
        ])
        for (const workId of ['release', 'expire']) {
          await fixture.store.claimWithLease({
            workId, expectedStatus: 'research_pending', leaseOwner: 'worker', leaseId: `lease-${workId}`,
            leaseExpiresAt: workId === 'expire' ? '2026-08-26T11:59:00.000Z' : '2026-08-26T12:01:00.000Z',
            now: '2026-08-26T11:58:00.000Z',
          })
        }
        assert.equal(await fixture.store.releaseLease({
          workId: 'release', leaseOwner: 'worker', leaseId: 'lease-release',
          expectedStatus: 'retrieval_leased', targetStatus: 'research_pending', now: '2026-08-26T11:59:30.000Z',
        }), true)
        const recovered = await fixture.store.recoverExpiredLeases({ now: '2026-08-26T12:00:00.000Z', limit: 10 })
        assert.deepEqual(recovered.recoveredWorkIds, ['expire'])
        assert.equal((await fixture.read('release'))?.attemptCount, 0)
        assert.equal((await fixture.read('expire'))?.attemptCount, 0)
      } finally {
        await fixture.close()
      }
    })
  })
}
