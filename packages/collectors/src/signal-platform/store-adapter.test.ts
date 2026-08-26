import {
  RESEARCH_PACKET_SCHEMA_VERSION,
  RESEARCH_WORK_SCHEMA_VERSION,
  type ResearchWorkItem,
} from './contracts'
import { runSchedulerStoreContract } from './store-adapter-contract'
import {
  assertLeasedTransition,
  compareResearchWorkPriority,
  leasedStatusFor,
  pendingStatusFor,
  type ResearchWorkStoreAdapter,
} from './store-adapter'

runSchedulerStoreContract({
  async create() {
    const store = new InMemorySchedulerStore()
    return {
      store,
      seed: async (items) => { for (const item of items) store.rows.set(item.workId, structuredClone(item)) },
      read: async (workId) => structuredClone(store.rows.get(workId) ?? null),
      close: async () => undefined,
    }
  },
  makeWork,
})

function makeWork(overrides: Partial<ResearchWorkItem> = {}): ResearchWorkItem {
  return {
    schemaVersion: RESEARCH_WORK_SCHEMA_VERSION,
    workId: 'work',
    signalId: 'signal',
    sourceType: 'news',
    researchDepth: 'standard',
    deepReason: null,
    priorityClass: 'P1',
    priorityScore: 0.5,
    freshnessDeadline: '2026-08-26T13:00:00.000Z',
    policyVersion: 'policy-v1',
    researchContractVersion: RESEARCH_PACKET_SCHEMA_VERSION,
    retrievalPlan: { sourceUrl: 'https://example.com', allowedDomains: ['example.com'], maxExternalSources: 2 },
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
    traceId: 'trace',
    createdAt: '2026-08-26T11:00:00.000Z',
    updatedAt: '2026-08-26T11:00:00.000Z',
    ...overrides,
  }
}

class InMemorySchedulerStore implements ResearchWorkStoreAdapter {
  readonly sourceType = 'news' as const
  readonly rows = new Map<string, ResearchWorkItem>()
  readonly attemptsStarted = new Set<string>()

  async peekSchedulable(input: Parameters<ResearchWorkStoreAdapter['peekSchedulable']>[0]) {
    const stageStatuses = input.stages?.map((stage) => stage === 'retrieval'
      ? 'research_pending' : stage === 'synthesis' ? 'synthesis_pending' : 'entity_pending')
    return [...this.rows.values()]
      .filter((row) => ['research_pending', 'synthesis_pending', 'entity_pending'].includes(row.status))
      .filter((row) => !stageStatuses || stageStatuses.includes(row.status as never))
      .filter((row) => !input.researchDepths || input.researchDepths.includes(row.researchDepth))
      .filter((row) => !input.priorityClasses || input.priorityClasses.includes(row.priorityClass))
      .filter((row) => !row.nextAttemptAt || row.nextAttemptAt <= input.now)
      .filter((row) => row.freshnessDeadline > input.now)
      .sort(compareResearchWorkPriority)
      .slice(0, input.limit)
      .map((row) => structuredClone(row))
  }

  async claimWithLease(input: Parameters<ResearchWorkStoreAdapter['claimWithLease']>[0]) {
    const row = this.rows.get(input.workId)
    if (!row || row.status !== input.expectedStatus || row.leaseId !== null) return null
    const queuedAt = row.updatedAt
    row.status = leasedStatusFor(input.expectedStatus)
    row.leaseOwner = input.leaseOwner
    row.leaseId = input.leaseId
    row.leaseExpiresAt = input.leaseExpiresAt
    row.updatedAt = input.now
    return {
      work: structuredClone(row), leaseOwner: input.leaseOwner, leaseId: input.leaseId,
      leaseExpiresAt: input.leaseExpiresAt, queuedAt,
    }
  }

  async heartbeatLease(input: Parameters<ResearchWorkStoreAdapter['heartbeatLease']>[0]) {
    const row = this.rows.get(input.workId)
    if (!row || row.leaseOwner !== input.leaseOwner || row.leaseId !== input.leaseId
      || !row.status.endsWith('_leased') || (row.leaseExpiresAt ?? '') <= input.now) return false
    row.leaseExpiresAt = input.leaseExpiresAt
    row.updatedAt = input.now
    return true
  }

  async beginAttempt(input: Parameters<ResearchWorkStoreAdapter['beginAttempt']>[0]) {
    const row = this.rows.get(input.workId)
    if (!row || row.status !== input.expectedStatus || row.leaseOwner !== input.leaseOwner
      || row.leaseId !== input.leaseId || (row.leaseExpiresAt ?? '') <= input.now
      || this.attemptsStarted.has(input.leaseId)) return false
    row.attemptCount += 1
    row.updatedAt = input.now
    this.attemptsStarted.add(input.leaseId)
    return true
  }

  async transitionLeased(input: Parameters<ResearchWorkStoreAdapter['transitionLeased']>[0]) {
    assertLeasedTransition(input)
    const row = this.rows.get(input.workId)
    if (!row || row.status !== input.expectedStatus || row.leaseOwner !== input.leaseOwner
      || row.leaseId !== input.leaseId || (row.leaseExpiresAt ?? '') <= input.now) return false
    row.status = input.nextStatus
    row.attemptCount += input.attemptDelta ?? 0
    row.nextAttemptAt = input.nextAttemptAt ?? null
    row.failureCategory = input.failureCategory ?? null
    row.failureDetail = input.failureDetail ?? null
    row.leaseOwner = null
    row.leaseId = null
    row.leaseExpiresAt = null
    row.updatedAt = input.now
    return true
  }

  async releaseLease(input: Parameters<ResearchWorkStoreAdapter['releaseLease']>[0]) {
    if (pendingStatusFor(input.expectedStatus) !== input.targetStatus) return false
    const row = this.rows.get(input.workId)
    if (!row || row.status !== input.expectedStatus || row.leaseOwner !== input.leaseOwner || row.leaseId !== input.leaseId) return false
    row.status = input.targetStatus
    row.leaseOwner = null
    row.leaseId = null
    row.leaseExpiresAt = null
    row.updatedAt = input.now
    return true
  }

  async recoverExpiredLeases(input: Parameters<ResearchWorkStoreAdapter['recoverExpiredLeases']>[0]) {
    const expired = [...this.rows.values()]
      .filter((row) => row.status.endsWith('_leased') && (row.leaseExpiresAt ?? '') <= input.now)
      .sort((a, b) => (a.leaseExpiresAt ?? '').localeCompare(b.leaseExpiresAt ?? ''))
      .slice(0, input.limit)
    for (const row of expired) {
      row.status = pendingStatusFor(row.status as 'retrieval_leased' | 'deep_leased' | 'synthesis_leased' | 'entity_leased')
      row.leaseOwner = null
      row.leaseId = null
      row.leaseExpiresAt = null
      row.updatedAt = input.now
    }
    return { recoveredWorkIds: expired.map((row) => row.workId) }
  }

  async getSchedulerStatus(input: Parameters<ResearchWorkStoreAdapter['getSchedulerStatus']>[0]) {
    const rows = [...this.rows.values()]
    const byStatus: Record<string, number> = {}
    for (const row of rows) byStatus[row.status] = (byStatus[row.status] ?? 0) + 1
    const ready = rows.filter((row) => row.status.endsWith('_pending') && row.freshnessDeadline > input.now)
    const leased = rows.filter((row) => row.status.endsWith('_leased'))
    return {
      total: rows.length,
      byStatus,
      oldestReadyAt: ready.sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0]?.createdAt ?? null,
      oldestLeaseExpiresAt: leased.sort((a, b) => (a.leaseExpiresAt ?? '').localeCompare(b.leaseExpiresAt ?? ''))[0]?.leaseExpiresAt ?? null,
    }
  }
}
