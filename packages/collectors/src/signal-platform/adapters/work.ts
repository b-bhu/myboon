import {
  RESEARCH_PACKET_SCHEMA_VERSION,
  RESEARCH_WORK_SCHEMA_VERSION,
  type ResearchWorkItem,
  type Signal,
} from '../contracts'
import { validateResearchWorkItem } from '../validation'
import type { LegacyWorkMigrationPolicy } from './migration-policy'
import { stableContractId } from './identity'

export function legacySignalToResearchWork(
  signal: Signal,
  policy: LegacyWorkMigrationPolicy,
): ResearchWorkItem {
  return validateResearchWorkItem({
    schemaVersion: RESEARCH_WORK_SCHEMA_VERSION,
    workId: stableContractId('work', signal.sourceType, signal.signalId, policy.policyVersion),
    signalId: signal.signalId,
    sourceType: signal.sourceType,
    researchDepth: policy.researchDepth,
    deepReason: policy.deepReason,
    priorityClass: policy.priorityClass,
    priorityScore: policy.priorityScore,
    freshnessDeadline: policy.freshnessDeadline,
    policyVersion: policy.policyVersion,
    researchContractVersion: RESEARCH_PACKET_SCHEMA_VERSION,
    retrievalPlan: policy.retrievalPlan,
    budget: policy.budget,
    status: policy.status,
    attemptCount: policy.attemptCount,
    nextAttemptAt: policy.nextAttemptAt,
    leaseOwner: policy.leaseOwner,
    leaseId: policy.leaseId,
    leaseExpiresAt: policy.leaseExpiresAt,
    failureCategory: policy.failureCategory,
    failureDetail: policy.failureDetail,
    traceId: policy.traceId,
    createdAt: policy.createdAt,
    updatedAt: policy.updatedAt,
    migration: {
      kind: 'legacy_row',
      policyVersion: policy.policyVersion,
    },
  })
}
