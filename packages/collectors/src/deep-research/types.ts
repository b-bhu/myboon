import type {
  DeepEscalationReason,
  ResearchWorkItem,
  RetrievedEvidence,
  Signal,
} from '../signal-platform/contracts'

export const DEEP_RESEARCH_JOB_SCHEMA_VERSION = 'myboon.deep_research_job.v1' as const
export const DEEP_RESEARCH_RESULT_SCHEMA_VERSION = 'myboon.deep_research_result.v1' as const
export const DEEP_RESEARCH_USAGE_SCHEMA_VERSION = 'myboon.deep_research_usage.v1' as const
export const DEEP_RESEARCH_FETCHED_EVIDENCE_SCHEMA_VERSION = 'myboon.deep_research_fetched_evidence.v1' as const

export type DeepResearchCapability =
  | 'browser_navigation'
  | 'registered_search'
  | 'http_fetch'

export interface DeepResearchBudget {
  maxProviderCalls: number
  maxInputTokens: number
  maxOutputTokens: number
  maxToolCalls: number
  maxBrowserNavigations: number
  maxSearchQueries: number
  maxHttpFetches: number
  maxWallTimeMs: number
  maxOutputBytes: number
  cpuQuotaPercent: number
  memoryMaxBytes: number
  tasksMax: number
}

export interface DeepResearchEscalation {
  reason: DeepEscalationReason
  unresolvedQuestion: string
  supportingEvidenceRefs: string[]
}

export interface DeepResearchJob {
  schemaVersion: typeof DEEP_RESEARCH_JOB_SCHEMA_VERSION
  jobId: string
  signal: Signal
  workItem: ResearchWorkItem
  evidence: RetrievedEvidence[]
  escalation: DeepResearchEscalation
  approvedDomains: string[]
  capabilities: DeepResearchCapability[]
  budget: DeepResearchBudget
}

export interface DeepResearchExecutionMetadata {
  jobId: string
  workId: string
  traceId: string
  sourceType: Signal['sourceType']
  unitName: string
  startedAt: string
  deadlineAt: string
  tempPath: string
  profilePath: string
}

/** Written by the trusted contained worker runtime, never by model stdout. */
export interface DeepResearchMeasuredUsage {
  schemaVersion: typeof DEEP_RESEARCH_USAGE_SCHEMA_VERSION
  providerCalls: number
  inputTokens: number
  outputTokens: number
  toolCalls: number
  browserNavigations: number
  searchQueries: number
  httpFetches: number
}

export interface DeepResearchFetchedEvidence {
  resultRef: string
  title: string
  url: string
  observedAt: string | null
  note: string | null
  contentHash: string
  retrievalMethod: DeepResearchCapability
}

/** Written by the trusted contained runtime, never accepted from model stdout. */
export interface DeepResearchFetchedEvidenceManifest {
  schemaVersion: typeof DEEP_RESEARCH_FETCHED_EVIDENCE_SCHEMA_VERSION
  jobId: string
  workId: string
  traceId: string
  results: DeepResearchFetchedEvidence[]
}

export interface DeepResearchResult {
  schemaVersion: typeof DEEP_RESEARCH_RESULT_SCHEMA_VERSION
  jobId: string
  workId: string
  traceId: string
  unitName: string
  status: 'succeeded' | 'failed'
  stdout: string
  stderr: string
  exitCode: number | null
  signal: NodeJS.Signals | null
  startedAt: string
  finishedAt: string
  durationMs: number
  capabilities: DeepResearchCapability[]
  fetchedEvidence: DeepResearchFetchedEvidence[]
  budgetUsed: {
    providerCalls: number
    inputTokens: number
    outputTokens: number
    toolCalls: number
    browserNavigations: number
    searchQueries: number
    httpFetches: number
    wallTimeMs: number
    outputBytes: number
  }
}

export type DeepResearchErrorCategory =
  | 'containment_disabled'
  | 'unsupported_platform'
  | 'systemd_unavailable'
  | 'invalid_job'
  | 'budget_exceeded'
  | 'timed_out'
  | 'cancelled'
  | 'execution_failed'
  | 'containment_cleanup_failed'
