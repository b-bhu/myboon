export const ENTITY_CATALOG_MAINTENANCE_PROMPT_VERSION = 'entity.catalog.maintenance.v1' as const

export type EntityCatalogMaintenanceMode = 'dry_run' | 'apply'
export type EntityCatalogMaintenanceTrigger = 'manual' | 'scheduled'
export type EntityCatalogMaintenanceScope = 'full_catalog' | 'incremental'
export type EntityCatalogMaintenanceRunStatus = 'running' | 'completed' | 'partial' | 'failed'

export interface EntityCatalogRecentMemory {
  title: string
  memoryType: string
  source: string
  observedAt: string
}

/**
 * The complete allowlist that may cross the Entity-maintenance inference
 * boundary. It intentionally has no memory body, memory summary, evidence,
 * metrics, arbitrary context, or Entity metadata.
 */
export interface EntityCatalogProfile {
  id: string
  slug: string
  name: string
  type: string
  aliases: string[]
  summary: string | null
  status: string
  showInCarousel: boolean
  tags: string[]
  createdAt: string
  updatedAt: string
  /** Latest Entity-row or memory-row update, used only for incremental scheduling. */
  changedAt: string
  memoryCount: number
  sourceCount: number
  firstMemoryAt: string | null
  lastMemoryAt: string | null
  recentMemories: EntityCatalogRecentMemory[]
}

export type EntityCandidateSignalKind =
  | 'exact_name'
  | 'name_alias'
  | 'shared_alias'
  | 'similar_name'
  | 'similar_slug'
  | 'memory_title_overlap'

export interface EntityCandidateSignal {
  kind: EntityCandidateSignalKind
  label?: string
  score?: number
}

export interface EntityMaintenanceCandidate {
  pairKey: string
  left: EntityCatalogProfile
  right: EntityCatalogProfile
  signals: EntityCandidateSignal[]
}

export type EntityIdentityDecision =
  | 'same_entity'
  | 'different_entities'
  | 'unsure'
  | 'polluted_alias'

export interface EntityIdentityJudgment {
  pairKey: string
  decision: EntityIdentityDecision
  confidence: number
  reason: string
  pollutedEntityId: string | null
  pollutedAlias: string | null
}

export interface EntityIdentityJudge {
  judge(candidates: readonly EntityMaintenanceCandidate[]): Promise<EntityIdentityJudgment[]>
}

export type EntityMaintenanceRecommendedAction =
  | 'merge'
  | 'keep_separate'
  | 'review'
  | 'quarantine_alias'

export interface EntityMaintenanceFindingInput {
  runId: string
  pairKey: string
  leftEntityId: string
  rightEntityId: string
  decision: EntityIdentityDecision
  recommendedAction: EntityMaintenanceRecommendedAction
  confidence: number
  canonicalEntityId: string | null
  pollutedEntityId: string | null
  pollutedAlias: string | null
  reason: string
  candidateSignals: EntityCandidateSignal[]
  profileSnapshot: { left: EntityCatalogProfile, right: EntityCatalogProfile }
  autoApplyEligible: boolean
}

export interface BeginEntityMaintenanceRunInput {
  trigger: EntityCatalogMaintenanceTrigger
  mode: EntityCatalogMaintenanceMode
  scope: EntityCatalogMaintenanceScope
  provider: string
  model: string
  promptVersion: string
  leaseMs: number
}

export interface EntityMaintenanceRunRecord {
  id: string
  status: EntityCatalogMaintenanceRunStatus
}

export interface CompleteEntityMaintenanceRunInput {
  status: Extract<EntityCatalogMaintenanceRunStatus, 'completed' | 'partial'>
  catalogCount: number
  candidateCount: number
  reviewedCount: number
  mergeProposalCount: number
  aliasQuarantineCount: number
  uncertainCount: number
  summary: Record<string, unknown>
}

export interface EntityCatalogMaintenanceStore {
  beginRun(input: BeginEntityMaintenanceRunInput): Promise<EntityMaintenanceRunRecord>
  latestCompletedRun(): Promise<{ startedAt: string } | null>
  heartbeatRun(runId: string, leaseMs: number): Promise<void>
  listProfiles(scope: EntityCatalogMaintenanceScope, changedSince?: string): Promise<EntityCatalogProfile[]>
  saveFindings(findings: readonly EntityMaintenanceFindingInput[]): Promise<void>
  completeRun(runId: string, input: CompleteEntityMaintenanceRunInput): Promise<void>
  failRun(runId: string, error: string): Promise<void>
}

export interface EntityCatalogMaintenanceRunResult extends CompleteEntityMaintenanceRunInput {
  runId: string
  mode: EntityCatalogMaintenanceMode
  scope: EntityCatalogMaintenanceScope
}
