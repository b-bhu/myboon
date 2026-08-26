export type InferenceMode =
  | 'classify'
  | 'generateStructured'
  | 'repairStructured'
  | 'investigate'

export type InferenceFailureCategory =
  | 'provider_unavailable'
  | 'provider_rate_limited'
  | 'provider_timeout'
  | 'provider_authentication'
  | 'circuit_open'
  | 'retrieval_timeout'
  | 'retrieval_blocked'
  | 'retrieval_unsafe_url'
  | 'budget_exceeded'
  | 'invalid_structured_output'
  | 'schema_version_mismatch'
  | 'permanent_source_error'
  | 'entity_resolution_failed'
  | 'storage_transient'
  | 'storage_permanent'

export interface InferenceProviderTarget {
  provider: string
  model: string
}

export interface InferenceWorkloadRoute {
  primary: InferenceProviderTarget
  fallback?: InferenceProviderTarget
}

export type InferenceRouteReadiness =
  | { ready: true }
  | {
    ready: false
    category: 'circuit_open'
    retryAfterMs: number
    blockedTargets: readonly InferenceProviderTarget[]
  }

export interface InferenceCircuitTargetStatus {
  provider: string
  model: string
  circuitOpen: boolean
  retryAfterMs: number | null
}

export interface InferenceCircuitStatusSnapshot {
  schemaVersion: 'myboon.inference_circuit_status.v1'
  capturedAt: string
  workloads: Array<{
    workload: string
    ready: boolean
    targets: InferenceCircuitTargetStatus[]
  }>
}

/**
 * Every limit is enforced by the gateway. Structured modes deliberately make
 * the zero-tool requirement a literal rather than an arbitrary number.
 */
export interface InferenceBudget {
  maxProviderCalls: number
  maxRepairCalls: number
  maxInputTokens: number
  maxOutputTokens: number
  maxWallTimeMs: number
  maxToolCalls: 0
}

export interface InferenceUsage {
  inputTokens: number
  outputTokens: number
}

export interface StructuredProviderRequest {
  mode: 'classify' | 'generateStructured' | 'repairStructured'
  workload: string
  purpose: string
  prompt: string
  target: InferenceProviderTarget
  timeoutMs: number
  maxOutputTokens: number
  signal: AbortSignal
}

export interface StructuredProviderResult {
  value: unknown
  rawOutput?: string
  usage?: Partial<InferenceUsage>
  /** Providers which know the actual route may override configured metadata. */
  actualProvider?: string
  actualModel?: string
}

export interface StructuredProviderAdapter {
  generate(request: StructuredProviderRequest): Promise<StructuredProviderResult>
}

export type StructuredOutputValidation<T> =
  | { valid: true, value: T }
  | { valid: false, issues?: readonly string[] }

export type StructuredOutputValidator<T> = (value: unknown) => StructuredOutputValidation<T>

interface StructuredRequestBase<T> {
  workload: string
  purpose: string
  prompt: string
  promptVersion: string
  policyVersion: string
  budget: InferenceBudget
  validate: StructuredOutputValidator<T>
}

/** There is intentionally no tools/toolsets property on structured requests. */
export interface ClassifyRequest<T> extends StructuredRequestBase<T> {
  mode?: 'classify'
}

/** There is intentionally no tools/toolsets property on structured requests. */
export interface GenerateStructuredRequest<T> extends StructuredRequestBase<T> {
  mode?: 'generateStructured'
}

/** There is intentionally no tools/toolsets property on structured requests. */
export interface RepairStructuredRequest<T> extends StructuredRequestBase<T> {
  mode?: 'repairStructured'
  invalidOutput: unknown
  validationIssues?: readonly string[]
}

export interface InvestigateRequest {
  mode?: 'investigate'
  workload: string
  purpose: string
  prompt: string
  promptVersion: string
  policyVersion: string
  budget: Omit<InferenceBudget, 'maxToolCalls'> & { maxToolCalls: number }
  allowedCapabilities: readonly string[]
  /** Opaque to the gateway; a configured contained port owns validation. */
  job?: unknown
  signal?: AbortSignal
}

export interface ContainedInvestigationPort {
  execute(request: InvestigateRequest): Promise<unknown>
}

export interface InferenceRequestByMode<T = unknown> {
  classify: ClassifyRequest<T>
  generateStructured: GenerateStructuredRequest<T>
  repairStructured: RepairStructuredRequest<T>
  investigate: InvestigateRequest
}

export interface InferenceCallRecord {
  mode: 'classify' | 'generateStructured' | 'repairStructured'
  provider: string
  model: string
  durationMs: number
  status: 'succeeded' | 'failed'
  failureCategory: InferenceFailureCategory | null
  schemaValid: boolean | null
  inputTokens: number
  outputTokens: number
}

export interface InferenceTelemetry {
  workload: string
  purpose: string
  mode: 'classify' | 'generateStructured' | 'repairStructured'
  promptVersion: string
  policyVersion: string
  configuredPrimaryProvider: string
  configuredPrimaryModel: string
  actualProvider: string | null
  actualModel: string | null
  fallbackInvoked: boolean
  fallbackReason: InferenceFailureCategory | null
  schemaValid: boolean | null
  providerCalls: number
  repairCalls: number
  inputTokens: number
  outputTokens: number
  toolCalls: 0
  durationMs: number
  budgetExceeded: boolean
  failureCategory: InferenceFailureCategory | null
  calls: readonly InferenceCallRecord[]
}

export interface InferenceResult<T> {
  value: T
  telemetry: InferenceTelemetry
}

export type InferenceTelemetryObserver = (event: InferenceTelemetry) => void
