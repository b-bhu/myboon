import type {
  BudgetUsage,
  DeepEscalationReason,
  PriorityClass,
  ResearchBudget,
  ResearchDepth,
  ResearchExecution,
  RetrievalPlan,
  WorkStatus,
} from '../contracts'

/**
 * Legacy rows do not contain these canonical queue fields. Callers must make
 * every migration decision explicitly; adapters intentionally have no hidden
 * environment- or time-dependent defaults.
 */
export interface LegacyWorkMigrationPolicy {
  policyVersion: string
  researchDepth: ResearchDepth
  deepReason: DeepEscalationReason | null
  priorityClass: PriorityClass
  priorityScore: number
  freshnessDeadline: string
  retrievalPlan: RetrievalPlan
  budget: ResearchBudget
  status: WorkStatus
  attemptCount: number
  nextAttemptAt: string | null
  leaseOwner: string | null
  leaseId: string | null
  leaseExpiresAt: string | null
  failureCategory: null
  failureDetail: string | null
  traceId: string
  createdAt: string
  updatedAt: string
}

/** Fields absent from the legacy research result and therefore policy-owned. */
export interface LegacyPacketMigrationPolicy {
  budgetUsed: BudgetUsage
  execution: ResearchExecution
  createdAt: string
}
