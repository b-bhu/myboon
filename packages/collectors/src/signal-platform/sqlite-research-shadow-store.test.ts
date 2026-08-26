import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  SHADOW_RESEARCH_EVALUATOR_VERSION,
  SHADOW_RESEARCH_RESULT_SCHEMA_VERSION,
  shadowResearchEvaluationId,
  type ShadowResearchResult,
} from '../research-engine/shadow-evaluator'
import { RESEARCH_PACKET_SCHEMA_VERSION, RESEARCH_WORK_SCHEMA_VERSION, type ResearchWorkItem } from './contracts'
import { ShadowResearchResultConflictError, SqliteResearchShadowStore } from './sqlite-research-shadow-store'

const WORK = {
  schemaVersion: RESEARCH_WORK_SCHEMA_VERSION,
  workId: 'work-shadow-store', signalId: 'signal-shadow-store', sourceType: 'news',
  researchDepth: 'light', deepReason: null, priorityClass: 'P1', priorityScore: 0.5,
  freshnessDeadline: '2026-08-26T13:00:00.000Z', policyVersion: 'policy.v1',
  researchContractVersion: RESEARCH_PACKET_SCHEMA_VERSION,
  retrievalPlan: { sourceUrl: 'https://news.example/item', allowedDomains: ['news.example'], maxExternalSources: 0 },
  budget: {
    maxProviderCalls: 2, maxRepairCalls: 1, maxInputTokens: 100, maxOutputTokens: 100,
    maxToolCalls: 0, maxWallTimeMs: 10_000,
  },
  status: 'research_pending', attemptCount: 0, nextAttemptAt: null,
  leaseOwner: null, leaseId: null, leaseExpiresAt: null, failureCategory: null, failureDetail: null,
  traceId: 'trace-shadow-store', createdAt: '2026-08-26T12:00:00.000Z', updatedAt: '2026-08-26T12:00:00.000Z',
} satisfies ResearchWorkItem

function skipped(): ShadowResearchResult {
  return {
    schemaVersion: SHADOW_RESEARCH_RESULT_SCHEMA_VERSION,
    evaluationId: shadowResearchEvaluationId(WORK),
    evaluatorVersion: SHADOW_RESEARCH_EVALUATOR_VERSION,
    workId: WORK.workId, signalId: WORK.signalId, sourceType: WORK.sourceType,
    researchDepth: WORK.researchDepth, researchContractVersion: WORK.researchContractVersion,
    policyVersion: WORK.policyVersion, traceId: WORK.traceId,
    status: 'skipped', skipReason: 'circuit_open', failureCategory: 'circuit_open',
    evidence: [], packet: null,
    providerCalls: 0, repairCalls: 0, inputTokens: 0, outputTokens: 0, toolCalls: 0, wallTimeMs: 0,
    startedAt: '2026-08-26T12:10:00.000Z', finishedAt: '2026-08-26T12:10:00.000Z',
  }
}

test('SQLite shadow results are immutable and idempotent by deterministic evaluation identity', () => {
  const dir = mkdtempSync(join(tmpdir(), 'shadow-result-store-'))
  const store = new SqliteResearchShadowStore(join(dir, 'shadow.sqlite'))
  try {
    const result = skipped()
    assert.equal(store.append(result).inserted, true)
    assert.equal(store.append(structuredClone(result)).inserted, false)
    assert.deepEqual(store.get(result.evaluationId), result)
    assert.deepEqual(store.listByWork(WORK.workId), [result])
    assert.throws(
      () => store.append({ ...result, finishedAt: '2026-08-26T12:11:00.000Z', wallTimeMs: 60_000 }),
      ShadowResearchResultConflictError,
    )
  } finally {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
