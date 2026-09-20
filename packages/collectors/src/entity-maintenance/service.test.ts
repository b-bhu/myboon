import assert from 'node:assert/strict'
import test from 'node:test'
import type {
  BeginEntityMaintenanceRunInput,
  CompleteEntityMaintenanceRunInput,
  EntityCatalogMaintenanceScope,
  EntityCatalogMaintenanceStore,
  EntityCatalogProfile,
  EntityIdentityJudge,
  EntityMaintenanceFindingInput,
} from './contracts'
import { EntityCatalogMaintenanceService } from './service'
import { maintenanceProfile } from './test-helpers'

class FakeStore implements EntityCatalogMaintenanceStore {
  findings: EntityMaintenanceFindingInput[] = []
  completion: CompleteEntityMaintenanceRunInput | null = null
  failed: string | null = null
  beginInputs: BeginEntityMaintenanceRunInput[] = []
  heartbeats = 0

  constructor(readonly profiles: EntityCatalogProfile[]) {}

  async beginRun(input: BeginEntityMaintenanceRunInput) {
    this.beginInputs.push(input)
    return { id: 'run-1', status: 'running' as const }
  }
  async hasCompletedFullCatalogRun() { return false }
  async latestCompletedRun() { return null }
  async heartbeatRun() { this.heartbeats += 1 }
  async listProfiles(_scope: EntityCatalogMaintenanceScope) { return this.profiles }
  async saveFindings(findings: readonly EntityMaintenanceFindingInput[]) { this.findings.push(...findings) }
  async completeRun(_runId: string, input: CompleteEntityMaintenanceRunInput) { this.completion = input }
  async failRun(_runId: string, error: string) { this.failed = error }
}

test('full-catalogue dry run persists proposals and performs zero mutations', async () => {
  const store = new FakeStore([
    maintenanceProfile({ id: 'acme-old', name: 'Acme', memoryCount: 20, sourceCount: 3, createdAt: '2026-01-01T00:00:00.000Z' }),
    maintenanceProfile({ id: 'acme-new', name: 'ACME', memoryCount: 1, sourceCount: 1, createdAt: '2026-09-01T00:00:00.000Z' }),
    maintenanceProfile({ id: 'other', name: 'Other Subject' }),
  ])
  const judge: EntityIdentityJudge = {
    async judge(candidates) {
      return candidates.map((candidate) => ({
        pairKey: candidate.pairKey,
        decision: 'same_entity' as const,
        confidence: 0.999,
        reason: 'Canonical names are equal and types match.',
        pollutedEntityId: null,
        pollutedAlias: null,
      }))
    },
  }
  const service = new EntityCatalogMaintenanceService({
    store, judge, provider: 'ollama-cloud', model: 'glm-5.3-flash', batchSize: 1,
  })
  const result = await service.run({ trigger: 'manual', scope: 'full_catalog' })

  assert.equal(result.status, 'completed')
  assert.equal(result.catalogCount, 3)
  assert.equal(result.candidateCount, 1)
  assert.equal(result.mergeProposalCount, 1)
  assert.equal(store.findings[0]?.canonicalEntityId, 'acme-old')
  assert.equal(store.findings[0]?.autoApplyEligible, true)
  assert.equal(store.completion?.summary.mutationCount, 0)
  assert.equal(store.failed, null)
})

test('invalid Hermes batch is recorded as a partial run, not converted into a guessed finding', async () => {
  const store = new FakeStore([
    maintenanceProfile({ id: 'one', name: 'Duplicate' }),
    maintenanceProfile({ id: 'two', name: 'DUPLICATE' }),
  ])
  const service = new EntityCatalogMaintenanceService({
    store,
    judge: { async judge() { throw new Error('malformed model output') } },
    provider: 'ollama-cloud',
    model: 'glm-5.3-flash',
  })
  const result = await service.run({ trigger: 'scheduled' })

  assert.equal(result.status, 'partial')
  assert.equal(result.reviewedCount, 0)
  assert.equal(store.findings.length, 0)
  assert.equal(store.completion?.summary.failedBatchCount, 1)
})

test('analysis service rejects apply mode before claiming a run', async () => {
  const store = new FakeStore([])
  const service = new EntityCatalogMaintenanceService({
    store,
    judge: { async judge() { return [] } },
    provider: 'ollama-cloud',
    model: 'glm-5.3-flash',
  })
  await assert.rejects(
    service.run({ trigger: 'manual', mode: 'apply' }),
    /supports dry_run mode only/,
  )
  assert.equal(store.beginInputs.length, 0)
})

test('incremental inference still has the full catalogue as its matching universe', async () => {
  const store = new FakeStore([
    maintenanceProfile({ id: 'old', name: 'Acme', changedAt: '2026-09-01T00:00:00.000Z' }),
    maintenanceProfile({ id: 'new', name: 'ACME', changedAt: '2026-09-20T00:00:00.000Z' }),
    maintenanceProfile({ id: 'unchanged-a', name: 'Other', changedAt: '2026-09-01T00:00:00.000Z' }),
    maintenanceProfile({ id: 'unchanged-b', name: 'OTHER', changedAt: '2026-09-01T00:00:00.000Z' }),
  ])
  let judgedPairKeys: string[] = []
  const service = new EntityCatalogMaintenanceService({
    store,
    judge: {
      async judge(candidates) {
        judgedPairKeys = candidates.map((candidate) => candidate.pairKey)
        return candidates.map((candidate) => ({
          pairKey: candidate.pairKey,
          decision: 'unsure' as const,
          confidence: 0.5,
          reason: 'Needs review.',
          pollutedEntityId: null,
          pollutedAlias: null,
        }))
      },
    },
    provider: 'ollama-cloud',
    model: 'glm-5.3-flash',
  })
  const result = await service.run({
    trigger: 'scheduled', scope: 'incremental', changedSince: '2026-09-19T00:00:00.000Z',
  })

  assert.deepEqual(judgedPairKeys, ['new:old'])
  assert.equal(result.catalogCount, 4)
  assert.equal(result.candidateCount, 1)
})

test('shutdown interruption fails the lease and leaves the run retryable', async () => {
  const store = new FakeStore([
    maintenanceProfile({ id: 'one', name: 'Duplicate' }),
    maintenanceProfile({ id: 'two', name: 'DUPLICATE' }),
  ])
  const controller = new AbortController()
  let releaseJudge!: () => void
  let markStarted!: () => void
  const judgeStarted = new Promise<void>((resolve) => { markStarted = resolve })
  const judgeReleased = new Promise<void>((resolve) => { releaseJudge = resolve })
  const service = new EntityCatalogMaintenanceService({
    store,
    judge: {
      async judge(candidates) {
        markStarted()
        await judgeReleased
        return candidates.map((candidate) => ({
          pairKey: candidate.pairKey,
          decision: 'unsure' as const,
          confidence: 0.5,
          reason: 'Would normally require review.',
          pollutedEntityId: null,
          pollutedAlias: null,
        }))
      },
    },
    provider: 'ollama-cloud',
    model: 'glm-5.3-flash',
  })

  const run = service.run({ trigger: 'scheduled', signal: controller.signal })
  await judgeStarted
  controller.abort()
  releaseJudge()

  await assert.rejects(run, /interrupted by shutdown/)
  assert.match(store.failed ?? '', /interrupted by shutdown/)
  assert.equal(store.findings.length, 0)
  assert.equal(store.completion, null)
})
