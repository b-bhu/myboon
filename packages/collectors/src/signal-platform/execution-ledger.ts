import type {
  ExecutionEventStatus,
  ExecutionStage,
  ExecutionTraceEvent,
  FailureCategory,
  Signal,
} from './contracts'

export interface ExecutionEventAppendResult {
  inserted: boolean
  event: ExecutionTraceEvent
}

export interface ExecutionAggregateQuery {
  sourceType?: Signal['sourceType']
  stage?: ExecutionStage
  since?: string
  until?: string
}

export interface ExecutionAggregateRow {
  eventSchemaVersion: ExecutionTraceEvent['schemaVersion']
  sourceType: Signal['sourceType']
  stage: ExecutionStage
  status: ExecutionEventStatus
  failureCategory: FailureCategory | null
  provider: string | null
  model: string | null
  fallbackProvider: string | null
  fallbackModel: string | null
  fallbackUsed: boolean
  configuredPrimaryProvider: string | null
  configuredPrimaryModel: string | null
  fallbackReason: FailureCategory | null
  outputSchemaValid: boolean | null
  promptVersion: string | null
  policyVersion: string | null
  researchContractVersion: string | null
  eventCount: number
  providerCalls: number
  repairCalls: number
  inputTokens: number
  outputTokens: number
  toolCalls: number
  budgetExceededCount: number
  totalWallTimeMs: number
}

export interface ExecutionAggregateStatus {
  totalEvents: number
  activeEvents: number
  rows: ExecutionAggregateRow[]
}

export interface ExecutionLedger {
  append(event: ExecutionTraceEvent): ExecutionEventAppendResult
  get(eventId: string): ExecutionTraceEvent | null
  listTrace(traceId: string): ExecutionTraceEvent[]
  readAggregateStatus(query?: ExecutionAggregateQuery): ExecutionAggregateStatus
  close(): void
}

export class ExecutionEventConflictError extends Error {
  readonly code = 'EXECUTION_EVENT_CONFLICT'

  constructor(readonly eventId: string) {
    super(`Execution event ${eventId} already exists with a different immutable payload`)
    this.name = 'ExecutionEventConflictError'
  }
}
