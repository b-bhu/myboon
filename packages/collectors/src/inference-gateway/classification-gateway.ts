import { createHash, randomUUID } from 'node:crypto'
import { canonicalJson } from '../signal-platform/canonical-json'
import { InferenceGatewayError } from './errors'
import { tightenLifecycleMode } from './classification-registry'
import type {
  ClassificationAttemptCall,
  ClassificationAttemptRecord,
  ClassificationAuditSink,
  ClassificationCapacityCoordinator,
  ClassificationDefinition,
  ClassificationLifecycleMode,
  ClassificationPolicyOutcomeRecord,
  ClassificationRegistry,
  ClassificationRequest,
  ClassificationResult,
  HermesClassificationAdapter,
  JevAnswer,
  JevClassificationAdapter,
  JevQuestion,
} from './classification-types'
import type { InferenceFailureCategory, InferenceProviderTarget } from './types'

export interface ClassificationGatewayOptions {
  registry: ClassificationRegistry
  jev: JevClassificationAdapter
  hermes: HermesClassificationAdapter
  capacity: ClassificationCapacityCoordinator
  audit: ClassificationAuditSink
  lifecycleMode?: (definition: ClassificationDefinition) => ClassificationLifecycleMode | undefined
  now?: () => number
}

export class ClassificationDoubleFailureError extends InferenceGatewayError {
  constructor(
    readonly decisionId: string,
    readonly jevFailure: string | null,
    cause: InferenceGatewayError,
  ) {
    super('Classification primary and fallback both failed', {
      category: cause.category,
      retryable: cause.retryable,
      retryAfterMs: cause.retryAfterMs,
      provider: cause.provider,
      model: cause.model,
      telemetry: cause.telemetry,
      providerResponseReceived: cause.providerResponseReceived,
      cause,
    })
    this.name = 'ClassificationDoubleFailureError'
  }
}

/** A caller must reconcile its durable reservation instead of retrying this dispatch. */
export class ClassificationOutcomeUnknownError extends InferenceGatewayError {
  constructor(readonly decisionId: string, cause: InferenceGatewayError) {
    super('Classification dispatch outcome is unknown; preserve its reservation and hold for reconciliation', {
      category: cause.category,
      retryable: false,
      provider: cause.provider,
      model: cause.model,
      cause,
    })
    this.name = 'ClassificationOutcomeUnknownError'
  }
}

export class ClassificationGateway {
  private readonly registry: ClassificationRegistry
  private readonly jev: JevClassificationAdapter
  private readonly hermes: HermesClassificationAdapter
  private readonly capacity: ClassificationCapacityCoordinator
  private readonly audit: ClassificationAuditSink
  private readonly lifecycleMode: (definition: ClassificationDefinition) => ClassificationLifecycleMode | undefined
  private readonly now: () => number

  constructor(options: ClassificationGatewayOptions) {
    this.registry = options.registry
    this.jev = options.jev
    this.hermes = options.hermes
    this.capacity = options.capacity
    this.audit = options.audit
    this.lifecycleMode = options.lifecycleMode ?? (() => undefined)
    this.now = options.now ?? Date.now
  }

  /**
   * Validate all caller-owned classification input before a durable caller
   * reserves a paid attempt. This deliberately performs no provider work.
   *
   * The dispatch path repeats these checks because callers may use classify()
   * directly. Keeping this as a public preflight lets a durable reservation
   * fence local input failures before it records a dispatch intent.
   */
  preflight(request: ClassificationRequest): void {
    assertPublicRequest(request)
    const definition = this.registry.resolve(request.workload, request.decisionVersion)
    const validated = safeValidateState(definition, request.state)
    if (!validated.valid) throw invalidInput(validated.issues.join('; '))
    let state: unknown
    try { state = structuredClone(validated.value) } catch { throw invalidInput('Classification state must be cloneable data') }
    let stateJson: string
    try { stateJson = canonicalJson(state) } catch { throw invalidInput('Classification state must be acyclic JSON data') }
    if (Buffer.byteLength(stateJson) > definition.budget.maxStateBytes) throw invalidInput('Classification state exceeds registry budget')
    const mode = tightenLifecycleMode(
      definition.maximumLifecycleMode,
      this.lifecycleMode(definition),
      definition.defaultLifecycleMode,
    )
    const samplingKey = { workload: request.workload, decisionVersion: request.decisionVersion, stableDecisionKey: request.trace.stableDecisionKey }
    if (definition.requiresJev && (mode === 'disabled'
      || (mode === 'canary' && !selectedForPercent(samplingKey, definition.canaryPercent)))) {
      throw new InferenceGatewayError('This classification workload requires an explicitly active Jev lifecycle', {
        category: 'provider_unavailable', retryable: false,
        provider: definition.jevTarget.provider, model: definition.jevTarget.model,
      })
    }
    try {
      if (mode === 'disabled' || (mode === 'canary' && !selectedForPercent(samplingKey, definition.canaryPercent))) {
        definition.renderHermes(validated.value)
      } else {
        definition.questions(validated.value)
      }
    } catch (error) {
      throw invalidInput(`Classification registry failed to prepare dispatch: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  async classify<TDecision = unknown>(request: ClassificationRequest): Promise<ClassificationResult<TDecision>> {
    assertPublicRequest(request)
    const definition = this.registry.resolve(request.workload, request.decisionVersion)
    const validated = safeValidateState(definition, request.state)
    if (!validated.valid) throw invalidInput(validated.issues.join('; '))
    let state: unknown
    try { state = structuredClone(validated.value) } catch { throw invalidInput('Classification state must be cloneable data') }
    let stateJson: string
    try { stateJson = canonicalJson(state) } catch { throw invalidInput('Classification state must be acyclic JSON data') }
    const stateBytes = Buffer.byteLength(stateJson)
    if (stateBytes > definition.budget.maxStateBytes) throw invalidInput('Classification state exceeds registry budget')
    const stateDigest = digest(stateJson)
    const decisionId = newDecisionId()
    const deadlineMs = tightenedDeadline(definition.budget.deadlineMs, request.tighterDeadlineMs)
    const mode = tightenLifecycleMode(
      definition.maximumLifecycleMode,
      this.lifecycleMode(definition),
      definition.defaultLifecycleMode,
    )
    const samplingKey = { workload: request.workload, decisionVersion: request.decisionVersion, stableDecisionKey: request.trace.stableDecisionKey }

    // Placement and story relationships are System One decisions.  A disabled
    // lifecycle is an actionable hold for their caller, never permission to
    // substitute Hermes prose generation for a typed Jev decision.
    if (definition.requiresJev && (mode === 'disabled'
      || (mode === 'canary' && !selectedForPercent(samplingKey, definition.canaryPercent)))) {
      throw new InferenceGatewayError('This classification workload requires an explicitly active Jev lifecycle', {
        category: 'provider_unavailable', retryable: false,
        provider: definition.jevTarget.provider, model: definition.jevTarget.model,
      })
    }

    if (mode === 'disabled' || (mode === 'canary' && !selectedForPercent(samplingKey, definition.canaryPercent))) {
      return this.runHermes<TDecision>(definition, state, decisionId, stateDigest, request.trace.stableDecisionKey, deadlineMs, null)
    }
    return this.runJevWithFallback<TDecision>(
      definition, state, decisionId, stateDigest, request.trace.stableDecisionKey, deadlineMs,
      request,
    )
  }

  async recordPolicyOutcome(input: Omit<ClassificationPolicyOutcomeRecord, 'schemaVersion' | 'recordedAt'>): Promise<void> {
    await this.audit.recordPolicyOutcome({
      schemaVersion: 'myboon.classification_policy_outcome.v1',
      ...input,
      recordedAt: new Date(this.now()).toISOString(),
    })
  }

  private async runJevWithFallback<TDecision>(
    definition: ClassificationDefinition,
    state: unknown,
    decisionId: string,
    stateDigest: string,
    stableDecisionKey: string,
    deadlineMs: number,
    dispatchPolicy: Pick<ClassificationRequest, 'maxProviderCalls' | 'holdOnUnknownOutcome'>,
  ): Promise<ClassificationResult<TDecision>> {
    const startedAt = this.now()
    const startedAtIso = new Date(startedAt).toISOString()
    const calls: ClassificationAttemptCall[] = []
    let providerResponseReceived = false
    let answers: Readonly<Record<string, JevAnswer>> | null = null
    let jevFailure: string | null = null
    let primaryFailure: InferenceGatewayError | null = null
    try {
      // Single-call and hold-on-unknown requests can use the full deadline.
      // The ordinary two-call path reserves a slice for timeout fallback.
      const primaryDeadline = dispatchPolicy.maxProviderCalls === 1 || dispatchPolicy.holdOnUnknownOutcome === true
        ? deadlineMs : Math.max(1, Math.floor(deadlineMs / 2))
      const result = await this.callJev(definition, state, primaryDeadline, 'live')
      providerResponseReceived = true
      answers = result.response.answers
      const decoded = safeDecodeJev(definition, answers, state)
      const accepted = decoded.valid ? safeAcceptJev(definition, answers, decoded.value, state) : {
        accepted: false, reason: decoded.issues.join('; '),
      }
      calls.push(providerCall(result.response, accepted.accepted ? 'succeeded' : 'not_accepted', null))
      if (decoded.valid && accepted.accepted) {
        const finishedAt = this.now()
        const record = attemptRecord({
          decisionId, executionMode: 'authoritative', attemptNumber: 1, definition, stateDigest, stableDecisionKey,
          configuredPrimary: definition.jevTarget, configuredFallback: definition.hermesTarget,
          actualProvider: result.response.actualProvider, actualModel: result.response.actualModel,
          fallbackUsed: false, fallbackReason: null, decision: decoded.value, answers, calls,
          failure: null, startedAt, finishedAt, startedAtIso,
        })
        await this.audit.recordAttempt(record)
        return resultEnvelope<TDecision>(record, decoded.value, result.response.usage)
      }
      jevFailure = accepted.reason
    } catch (error) {
      const failure = mapFailure(error, definition.jevTarget)
      primaryFailure = failure
      providerResponseReceived ||= failure.providerResponseReceived
      jevFailure = failure.category
      if (calls.length === 0) calls.push(failedCall(definition.jevTarget, failure, Math.max(0, this.now() - startedAt)))
    }

    // The caller's durable reservation is authoritative over internal fallback.
    // Transport failures cannot establish non-execution or absence of charges.
    const unknownDispatch = primaryFailure !== null
      && dispatchPolicy.holdOnUnknownOutcome === true
      && (primaryFailure.category === 'provider_timeout' || primaryFailure.category === 'provider_unavailable')
    if (unknownDispatch || dispatchPolicy.maxProviderCalls === 1 || definition.requiresJev) {
      const failure = unknownDispatch
        ? new ClassificationOutcomeUnknownError(decisionId, primaryFailure!)
        : definition.requiresJev
          ? primaryFailure ?? new InferenceGatewayError(`Required Jev decision was rejected: ${jevFailure ?? 'invalid typed answer'}`, {
            category: 'invalid_structured_output', retryable: false,
            provider: definition.jevTarget.provider, model: definition.jevTarget.model,
            providerResponseReceived,
          })
        : new InferenceGatewayError('Classification fallback exceeds the reserved provider-call allowance', {
          category: 'budget_exceeded', retryable: false,
          provider: definition.jevTarget.provider, model: definition.jevTarget.model,
          providerResponseReceived,
          cause: primaryFailure ?? undefined,
        })
      const finishedAt = this.now()
      await this.audit.recordAttempt(attemptRecord({
        decisionId, executionMode: 'authoritative', attemptNumber: 1, definition, stateDigest, stableDecisionKey,
        configuredPrimary: definition.jevTarget, configuredFallback: definition.hermesTarget,
        actualProvider: definition.jevTarget.provider, actualModel: definition.jevTarget.model,
        fallbackUsed: false, fallbackReason: jevFailure, decision: null, answers, calls,
        failure, startedAt, finishedAt, startedAtIso,
      }))
      throw failure
    }

    try {
      const remainingMs = deadlineMs - Math.max(0, this.now() - startedAt)
      if (remainingMs <= 0) throw new InferenceGatewayError('Classification logical deadline exhausted before fallback', {
        category: 'provider_timeout', retryable: true,
        provider: definition.hermesTarget.provider, model: definition.hermesTarget.model,
      })
      const hermes = await this.callHermes(definition, state, remainingMs)
      providerResponseReceived = true
      const validated = safeValidateHermes(definition, hermes.response.value, state)
      if (!validated.valid) {
        throw new InferenceGatewayError(`Hermes classification output is invalid: ${validated.issues.join('; ')}`, {
          category: 'invalid_structured_output', retryable: false,
          provider: hermes.response.actualProvider, model: hermes.response.actualModel,
        })
      }
      calls.push(providerCall(hermes.response, 'succeeded', null))
      const finishedAt = this.now()
      const record = attemptRecord({
        decisionId, executionMode: 'authoritative', attemptNumber: 1, definition, stateDigest, stableDecisionKey,
        configuredPrimary: definition.jevTarget, configuredFallback: definition.hermesTarget,
        actualProvider: hermes.response.actualProvider, actualModel: hermes.response.actualModel,
        fallbackUsed: true, fallbackReason: jevFailure, decision: validated.value, answers, calls,
        failure: null, startedAt, finishedAt, startedAtIso,
      })
      await this.audit.recordAttempt(record)
      return resultEnvelope<TDecision>(record, validated.value, hermes.response.usage)
    } catch (error) {
      const failure = mapFailure(error, definition.hermesTarget)
      calls.push(failedCall(definition.hermesTarget, failure, Math.max(0, this.now() - startedAt)))
      const finishedAt = this.now()
      await this.audit.recordAttempt(attemptRecord({
        decisionId, executionMode: 'authoritative', attemptNumber: 1, definition, stateDigest, stableDecisionKey,
        configuredPrimary: definition.jevTarget, configuredFallback: definition.hermesTarget,
        actualProvider: failure.provider ?? definition.hermesTarget.provider,
        actualModel: failure.model ?? definition.hermesTarget.model,
        fallbackUsed: true, fallbackReason: jevFailure, decision: null, answers, calls,
        failure, startedAt, finishedAt, startedAtIso,
      }))
      throw new ClassificationDoubleFailureError(decisionId, jevFailure,
        providerResponseReceived ? withProviderResponse(failure) : failure)
    }
  }

  private async runHermes<TDecision>(
    definition: ClassificationDefinition,
    state: unknown,
    decisionId: string,
    stateDigest: string,
    stableDecisionKey: string,
    deadlineMs: number,
    fallbackReason: string | null,
  ): Promise<ClassificationResult<TDecision>> {
    const startedAt = this.now()
    const startedAtIso = new Date(startedAt).toISOString()
    const calls: ClassificationAttemptCall[] = []
    let providerResponseReceived = false
    try {
      const result = await this.callHermes(definition, state, deadlineMs)
      providerResponseReceived = true
      const validated = safeValidateHermes(definition, result.response.value, state)
      if (!validated.valid) throw new InferenceGatewayError(validated.issues.join('; '), {
        category: 'invalid_structured_output', retryable: false,
        provider: result.response.actualProvider, model: result.response.actualModel,
      })
      calls.push(providerCall(result.response, 'succeeded', null))
      const finishedAt = this.now()
      const record = attemptRecord({
        decisionId, executionMode: 'authoritative', attemptNumber: 1, definition, stateDigest, stableDecisionKey,
        configuredPrimary: definition.hermesTarget, configuredFallback: null,
        actualProvider: result.response.actualProvider, actualModel: result.response.actualModel,
        fallbackUsed: false, fallbackReason, decision: validated.value, answers: null, calls,
        failure: null, startedAt, finishedAt, startedAtIso,
      })
      await this.audit.recordAttempt(record)
      return resultEnvelope<TDecision>(record, validated.value, result.response.usage)
    } catch (error) {
      const failure = mapFailure(error, definition.hermesTarget)
      calls.push(failedCall(definition.hermesTarget, failure, Math.max(0, this.now() - startedAt)))
      const finishedAt = this.now()
      await this.audit.recordAttempt(attemptRecord({
        decisionId, executionMode: 'authoritative', attemptNumber: 1, definition, stateDigest, stableDecisionKey,
        configuredPrimary: definition.hermesTarget, configuredFallback: null,
        actualProvider: failure.provider ?? definition.hermesTarget.provider,
        actualModel: failure.model ?? definition.hermesTarget.model,
        fallbackUsed: false, fallbackReason, decision: null, answers: null, calls,
        failure, startedAt, finishedAt, startedAtIso,
      }))
      throw new ClassificationDoubleFailureError(decisionId, null,
        providerResponseReceived ? withProviderResponse(failure) : failure)
    }
  }

  private async callJev(
    definition: ClassificationDefinition,
    state: unknown,
    deadlineMs: number,
    mode: 'live',
  ) {
    let questions: Readonly<Record<string, JevQuestion>>
    try { questions = definition.questions(state) } catch (error) {
      throw new InferenceGatewayError('Classification registry failed to build Jev questions', {
        category: 'invalid_structured_output', retryable: false, cause: error,
      })
    }
    const lease = this.capacity.acquire({ workload: definition.workload, target: definition.jevTarget, mode, policy: definition.capacity })
    let providerResponseReceived = false
    try {
      const response = await withDeadline(deadlineMs, (signal) => this.jev.classify({
        workload: definition.workload,
        decisionVersion: definition.decisionVersion,
        state,
        questions,
        target: definition.jevTarget,
        deadlineMs,
        signal,
      }), definition.jevTarget)
      providerResponseReceived = true
      assertUsage(response.usage, definition)
      lease.release({ success: true, retryableFailure: false })
      return { response }
    } catch (error) {
      const failure = mapFailure(error, definition.jevTarget)
      lease.release({ success: false, retryableFailure: failure.retryable })
      throw providerResponseReceived ? withProviderResponse(failure) : failure
    }
  }

  private async callHermes(definition: ClassificationDefinition, state: unknown, deadlineMs: number) {
    let prompt: string
    try { prompt = definition.renderHermes(state) } catch (error) {
      throw new InferenceGatewayError('Classification registry failed to render the Hermes definition', {
        category: 'invalid_structured_output', retryable: false, cause: error,
      })
    }
    const lease = this.capacity.acquire({ workload: definition.workload, target: definition.hermesTarget, mode: 'live', policy: definition.capacity })
    let providerResponseReceived = false
    try {
      const response = await withDeadline(deadlineMs, (signal) => this.hermes.classify({
        workload: definition.workload,
        decisionVersion: definition.decisionVersion,
        prompt,
        target: definition.hermesTarget,
        deadlineMs,
        signal,
      }), definition.hermesTarget)
      providerResponseReceived = true
      assertUsage(response.usage, definition)
      lease.release({ success: true, retryableFailure: false })
      return { response }
    } catch (error) {
      const failure = mapFailure(error, definition.hermesTarget)
      lease.release({ success: false, retryableFailure: failure.retryable })
      throw providerResponseReceived ? withProviderResponse(failure) : failure
    }
  }
}

function assertPublicRequest(request: ClassificationRequest): void {
  if (!request || typeof request !== 'object') throw invalidInput('Classification request must be an object')
  const keys = Object.keys(request as unknown as Record<string, unknown>).sort()
  if (keys.some((key) => !['decisionVersion', 'state', 'tighterDeadlineMs', 'trace', 'workload', 'maxProviderCalls', 'holdOnUnknownOutcome'].includes(key))) {
    throw invalidInput('Classification request contains caller-owned policy fields')
  }
  if (request.maxProviderCalls !== undefined && request.maxProviderCalls !== 1 && request.maxProviderCalls !== 2) {
    throw invalidInput('maxProviderCalls must tighten the existing one-or-two-provider path')
  }
  if (request.holdOnUnknownOutcome !== undefined && typeof request.holdOnUnknownOutcome !== 'boolean') {
    throw invalidInput('holdOnUnknownOutcome must be boolean')
  }
  for (const [field, value] of [['workload', request.workload], ['decisionVersion', request.decisionVersion], ['stableDecisionKey', request.trace?.stableDecisionKey]]) {
    if (typeof value !== 'string' || value.length < 1 || value.length > 200 || value.includes('\0')) throw invalidInput(`Invalid ${field}`)
  }
  if (!request.trace || typeof request.trace !== 'object' || Array.isArray(request.trace)) throw invalidInput('Invalid trace')
  const traceKeys = Object.keys(request.trace).sort()
  if (traceKeys.some((key) => !['correlationIds', 'stableDecisionKey'].includes(key))) throw invalidInput('Trace contains unsupported fields')
  if (request.trace.correlationIds !== undefined) {
    const entries = Object.entries(request.trace.correlationIds)
    if (entries.length > 20 || entries.some(([key, value]) => !key || key.length > 100 || typeof value !== 'string' || value.length > 200)) {
      throw invalidInput('Invalid correlation IDs')
    }
  }
}

function safeValidateState(definition: ClassificationDefinition, value: unknown) {
  try { return definition.validateState(value) } catch (error) {
    return { valid: false as const, issues: [error instanceof Error ? error.message : String(error)] }
  }
}

function safeDecodeJev(definition: ClassificationDefinition, answers: Readonly<Record<string, JevAnswer>>, state: unknown) {
  try { return definition.decodeJev(answers, state) } catch (error) {
    return { valid: false as const, issues: [error instanceof Error ? error.message : String(error)] }
  }
}

function safeValidateHermes(definition: ClassificationDefinition, value: unknown, state: unknown) {
  try { return definition.validateHermes(value, state) } catch (error) {
    return { valid: false as const, issues: [error instanceof Error ? error.message : String(error)] }
  }
}

function safeAcceptJev(
  definition: ClassificationDefinition,
  answers: Readonly<Record<string, JevAnswer>>,
  decision: unknown,
  state: unknown,
): { accepted: boolean, reason: string } {
  try { return definition.acceptJev(answers, decision, state) } catch (error) {
    return { accepted: false, reason: `registry acceptance policy failed: ${error instanceof Error ? error.message : String(error)}` }
  }
}

function invalidInput(message: string): InferenceGatewayError {
  return new InferenceGatewayError(message, { category: 'invalid_structured_output', retryable: false })
}

function digest(value: string): string { return createHash('sha256').update(value).digest('hex') }

function newDecisionId(): string { return `classification_${randomUUID()}` }

function tightenedDeadline(maximum: number, requested: number | undefined): number {
  if (requested === undefined) return maximum
  if (!Number.isInteger(requested) || requested <= 0) throw invalidInput('tighterDeadlineMs must be positive')
  if (requested > maximum) throw invalidInput('tighterDeadlineMs cannot enlarge the registry deadline')
  return requested
}

function selectedForPercent(key: { workload: string, decisionVersion: string, stableDecisionKey: string }, percent: number): boolean {
  if (percent <= 0) return false
  if (percent >= 100) return true
  const value = Number.parseInt(digest(canonicalJson({
    workload: key.workload,
    decisionVersion: key.decisionVersion,
    stableDecisionKey: key.stableDecisionKey,
  })).slice(0, 8), 16) / 0x1_0000_0000
  return value * 100 < percent
}

async function withDeadline<T>(
  deadlineMs: number,
  call: (signal: AbortSignal) => Promise<T>,
  target: InferenceProviderTarget,
): Promise<T> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), deadlineMs)
  try {
    return await call(controller.signal)
  } catch (error) {
    if (controller.signal.aborted && !(error instanceof InferenceGatewayError)) {
      throw new InferenceGatewayError('Classification provider timed out', {
        category: 'provider_timeout', retryable: true,
        provider: target.provider, model: target.model, cause: error,
      })
    }
    throw error
  } finally { clearTimeout(timer) }
}

function mapFailure(error: unknown, target: InferenceProviderTarget): InferenceGatewayError {
  return error instanceof InferenceGatewayError ? error : new InferenceGatewayError('Classification provider failed', {
    category: 'provider_unavailable', retryable: true,
    provider: target.provider, model: target.model, cause: error,
  })
}

function withProviderResponse(error: InferenceGatewayError): InferenceGatewayError {
  return new InferenceGatewayError(error.message, {
    category: error.category,
    retryable: error.retryable,
    retryAfterMs: error.retryAfterMs,
    provider: error.provider,
    model: error.model,
    telemetry: error.telemetry,
    providerResponseReceived: true,
    cause: error.cause,
  })
}

function assertUsage(usage: { inputTokens: number; outputTokens: number; costUsdMicros?: number }, definition: ClassificationDefinition): void {
  if (!Number.isInteger(usage.inputTokens) || usage.inputTokens < 0 || usage.inputTokens > definition.budget.maxInputTokens
    || !Number.isInteger(usage.outputTokens) || usage.outputTokens < 0 || usage.outputTokens > definition.budget.maxOutputTokens
    || (definition.budget.maxCostUsdMicros !== undefined
      && (!Number.isInteger(usage.costUsdMicros) || usage.costUsdMicros! > definition.budget.maxCostUsdMicros))) {
    throw new InferenceGatewayError(`Classification provider exceeded registry budget (input ${usage.inputTokens}/${definition.budget.maxInputTokens}, output ${usage.outputTokens}/${definition.budget.maxOutputTokens})`, {
      category: 'budget_exceeded', retryable: false,
    })
  }
}

function providerCall(
  response: { actualProvider: string; actualModel: string; durationMs: number; usage: { inputTokens: number; outputTokens: number; costUsdMicros?: number } },
  status: ClassificationAttemptCall['status'],
  failureCategory: InferenceFailureCategory | null,
): ClassificationAttemptCall {
  return Object.freeze({
    provider: response.actualProvider, model: response.actualModel, status, failureCategory,
    durationMs: response.durationMs, inputTokens: response.usage.inputTokens,
    outputTokens: response.usage.outputTokens, costUsdMicros: response.usage.costUsdMicros ?? null,
  })
}

function failedCall(target: InferenceProviderTarget, failure: InferenceGatewayError, durationMs: number): ClassificationAttemptCall {
  return Object.freeze({
    provider: failure.provider ?? target.provider, model: failure.model ?? target.model,
    status: 'failed' as const, failureCategory: failure.category, durationMs,
    inputTokens: 0, outputTokens: 0, costUsdMicros: null,
  })
}

function attemptRecord(input: {
  decisionId: string
  executionMode: 'authoritative'
  attemptNumber: number
  definition: ClassificationDefinition
  stateDigest: string
  stableDecisionKey: string
  configuredPrimary: InferenceProviderTarget
  configuredFallback: InferenceProviderTarget | null
  actualProvider: string | null
  actualModel: string | null
  fallbackUsed: boolean
  fallbackReason: string | null
  decision: unknown | null
  answers: Readonly<Record<string, JevAnswer>> | null
  calls: ClassificationAttemptCall[]
  failure: InferenceGatewayError | null
  startedAt: number
  finishedAt: number
  startedAtIso: string
}): ClassificationAttemptRecord {
  return Object.freeze({
    schemaVersion: 'myboon.classification_attempt.v2' as const,
    decisionId: input.decisionId, executionMode: input.executionMode, attemptNumber: input.attemptNumber,
    workload: input.definition.workload, decisionVersion: input.definition.decisionVersion,
    stateDigest: input.stateDigest, stableDecisionKey: input.stableDecisionKey,
    configuredPrimary: Object.freeze({ ...input.configuredPrimary }),
    configuredFallback: input.configuredFallback ? Object.freeze({ ...input.configuredFallback }) : null,
    actualProvider: input.actualProvider, actualModel: input.actualModel,
    fallbackUsed: input.fallbackUsed, fallbackReason: input.fallbackReason,
    status: input.failure ? 'failed' as const : 'succeeded' as const,
    failureCategory: input.failure?.category ?? null,
    ...(input.failure ? { failureDetail: input.failure.message } : {}),
    decision: input.decision,
    answers: input.answers,
    calls: Object.freeze([...input.calls]),
    startedAt: input.startedAtIso,
    finishedAt: new Date(input.finishedAt).toISOString(),
    durationMs: Math.max(0, input.finishedAt - input.startedAt),
  })
}

function resultEnvelope<T>(
  record: ClassificationAttemptRecord,
  value: unknown,
  usage: { inputTokens: number; outputTokens: number; costUsdMicros?: number },
): ClassificationResult<T> {
  return Object.freeze({
    decisionId: record.decisionId, workload: record.workload, decisionVersion: record.decisionVersion,
    value: value as T, configuredPrimary: record.configuredPrimary,
    configuredFallback: record.configuredFallback,
    actualProvider: record.actualProvider!, actualModel: record.actualModel!,
    fallbackUsed: record.fallbackUsed, fallbackReason: record.fallbackReason,
    answers: record.fallbackUsed ? null : record.answers,
    usage: Object.freeze({ ...usage }), durationMs: record.durationMs,
  })
}

export class InMemoryClassificationPorts implements ClassificationCapacityCoordinator, ClassificationAuditSink {
  readonly attempts: ClassificationAttemptRecord[] = []
  readonly outcomes: ClassificationPolicyOutcomeRecord[] = []
  acquire(): { token: string; release(): void } { return { token: randomUUID(), release() {} } }
  recordAttempt(value: ClassificationAttemptRecord): void { this.attempts.push(value) }
  recordPolicyOutcome(value: ClassificationPolicyOutcomeRecord): void { this.outcomes.push(value) }
}
