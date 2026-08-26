import { InferenceGatewayError } from './errors'
import type {
  ClassifyRequest,
  ContainedInvestigationPort,
  GenerateStructuredRequest,
  InferenceBudget,
  InferenceCallRecord,
  InferenceFailureCategory,
  InferenceMode,
  InferenceProviderTarget,
  InferenceResult,
  InferenceTelemetry,
  InferenceTelemetryObserver,
  InferenceWorkloadRoute,
  InvestigateRequest,
  RepairStructuredRequest,
  StructuredOutputValidation,
  StructuredProviderAdapter,
  StructuredProviderResult,
} from './types'

export interface InferenceGatewayOptions {
  adapter: StructuredProviderAdapter
  routes: Readonly<Record<string, InferenceWorkloadRoute>>
  observer?: InferenceTelemetryObserver
  estimateTokens?: (text: string) => number
  now?: () => number
  /** Absent until the contained Phase 6 worker is explicitly configured. */
  investigationPort?: ContainedInvestigationPort
}

interface ExecutionRequest<T> {
  workload: string
  purpose: string
  prompt: string
  promptVersion: string
  policyVersion: string
  budget: InferenceBudget
  validate(value: unknown): StructuredOutputValidation<T>
}

interface MutableTelemetry {
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
  budgetExceeded: boolean
  failureCategory: InferenceFailureCategory | null
  calls: InferenceCallRecord[]
}

interface AttemptResult {
  result: StructuredProviderResult
  callIndex: number
}

const FALLBACK_FAILURES = new Set<InferenceFailureCategory>([
  'provider_unavailable',
  'provider_rate_limited',
  'provider_timeout',
  'circuit_open',
])

function stableOutput(value: unknown): string {
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

function repairPrompt(originalPrompt: string, invalidOutput: unknown, issues?: readonly string[]): string {
  const issueText = issues?.length ? issues.map((issue) => `- ${issue}`).join('\n') : '- Output was malformed or failed schema validation.'
  return [
    'Repair the candidate response so it satisfies the original structured-output request.',
    'Return only the repaired JSON value. Do not use tools, browse, or add commentary.',
    '',
    'Original request:',
    originalPrompt,
    '',
    'Validation issues:',
    issueText,
    '',
    'Candidate response:',
    stableOutput(invalidOutput),
  ].join('\n')
}

function assertNonNegativeInteger(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new InferenceGatewayError(`${name} must be a non-negative integer`, {
      category: 'budget_exceeded', retryable: false,
    })
  }
}

function assertBudget(budget: InferenceBudget): void {
  assertNonNegativeInteger('maxProviderCalls', budget.maxProviderCalls)
  assertNonNegativeInteger('maxRepairCalls', budget.maxRepairCalls)
  assertNonNegativeInteger('maxInputTokens', budget.maxInputTokens)
  assertNonNegativeInteger('maxOutputTokens', budget.maxOutputTokens)
  assertNonNegativeInteger('maxWallTimeMs', budget.maxWallTimeMs)
  if (budget.maxToolCalls !== 0) {
    throw new InferenceGatewayError('Structured inference requires maxToolCalls=0', {
      category: 'budget_exceeded', retryable: false,
    })
  }
}

function assertToolLess(request: object): void {
  const unsafe = request as Record<string, unknown>
  for (const property of ['tools', 'toolsets', 'toolDefinitions', 'toolChoice', 'allowedCapabilities']) {
    if (Object.prototype.hasOwnProperty.call(unsafe, property)) {
      throw new InferenceGatewayError(`Structured inference rejects tool-bearing property ${property}`, {
        category: 'budget_exceeded', retryable: false,
      })
    }
  }
}

function safeValidation<T>(
  validate: (value: unknown) => StructuredOutputValidation<T>,
  value: unknown,
): StructuredOutputValidation<T> {
  try {
    return validate(value)
  } catch (error) {
    return { valid: false, issues: [error instanceof Error ? error.message : String(error)] }
  }
}

function targetIsValid(target: InferenceProviderTarget): boolean {
  return safeConfigValue(target.provider) && safeConfigValue(target.model)
}

function safeConfigValue(value: string): boolean {
  return value.length <= 200
    && /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(value)
}

function assertRequestInputs(request: ExecutionRequest<unknown>): void {
  for (const [name, value] of [
    ['workload', request.workload],
    ['purpose', request.purpose],
    ['promptVersion', request.promptVersion],
    ['policyVersion', request.policyVersion],
  ] as const) {
    if (!safeConfigValue(value)) {
      throw new InferenceGatewayError(`${name} must be a non-empty safe value of at most 200 characters`, {
        category: 'invalid_structured_output', retryable: false,
      })
    }
  }
  if (!request.prompt.trim() || request.prompt.includes('\0')) {
    throw new InferenceGatewayError('prompt must be non-empty and contain no NUL characters', {
      category: 'invalid_structured_output', retryable: false,
    })
  }
  if (typeof request.validate !== 'function') {
    throw new InferenceGatewayError('validate must be a function', {
      category: 'invalid_structured_output', retryable: false,
    })
  }
}

export class InferenceGateway {
  private readonly adapter: StructuredProviderAdapter
  private readonly routes: Readonly<Record<string, InferenceWorkloadRoute>>
  private readonly observer: InferenceTelemetryObserver | null
  private readonly estimateTokens: (text: string) => number
  private readonly now: () => number
  private readonly investigationPort: ContainedInvestigationPort | null

  constructor(options: InferenceGatewayOptions) {
    this.adapter = options.adapter
    this.routes = options.routes
    this.observer = options.observer ?? null
    this.estimateTokens = options.estimateTokens ?? ((text) => Math.ceil(text.length / 4))
    this.now = options.now ?? Date.now
    this.investigationPort = options.investigationPort ?? null
  }

  /** Investigation always receives only its primary route, even if configured otherwise. */
  resolveRoute(workload: string, mode: InferenceMode): InferenceWorkloadRoute {
    const configured = this.routes[workload]
    if (!configured || !targetIsValid(configured.primary)) {
      throw new InferenceGatewayError(`No valid inference route configured for workload ${workload}`, {
        category: 'provider_unavailable', retryable: false,
      })
    }
    if (configured.fallback && !targetIsValid(configured.fallback)) {
      throw new InferenceGatewayError(`Invalid fallback inference route configured for workload ${workload}`, {
        category: 'provider_unavailable', retryable: false,
      })
    }
    if (configured.fallback
      && configured.primary.provider === configured.fallback.provider
      && configured.primary.model === configured.fallback.model) {
      throw new InferenceGatewayError(`Primary and fallback routes must differ for workload ${workload}`, {
        category: 'provider_unavailable', retryable: false,
      })
    }
    return {
      primary: { ...configured.primary },
      ...(mode !== 'investigate' && configured.fallback && targetIsValid(configured.fallback)
        ? { fallback: { ...configured.fallback } }
        : {}),
    }
  }

  classify<T>(request: ClassifyRequest<T>): Promise<InferenceResult<T>> {
    return this.execute('classify', request)
  }

  generateStructured<T>(request: GenerateStructuredRequest<T>): Promise<InferenceResult<T>> {
    return this.execute('generateStructured', request)
  }

  repairStructured<T>(request: RepairStructuredRequest<T>): Promise<InferenceResult<T>> {
    return this.execute('repairStructured', request, request.invalidOutput, request.validationIssues)
  }

  async investigate<T = unknown>(request: InvestigateRequest): Promise<T> {
    if (!this.investigationPort) {
      throw new InferenceGatewayError(
        'Investigate mode is disabled until a contained investigation worker is configured',
        { category: 'provider_unavailable', retryable: false },
      )
    }
    // Investigation never resolves a structured provider route, so there is
    // no gateway fallback path to switch providers mid-flight.
    return this.investigationPort.execute(request) as Promise<T>
  }

  private async execute<T>(
    mode: 'classify' | 'generateStructured' | 'repairStructured',
    request: ExecutionRequest<T>,
    invalidOutput?: unknown,
    validationIssues?: readonly string[],
  ): Promise<InferenceResult<T>> {
    const startedAt = this.now()
    let route: InferenceWorkloadRoute
    try {
      route = this.resolveRoute(request.workload, mode)
    } catch (error) {
      throw error
    }
    const state: MutableTelemetry = {
      workload: request.workload,
      purpose: request.purpose,
      mode,
      promptVersion: request.promptVersion,
      policyVersion: request.policyVersion,
      configuredPrimaryProvider: route.primary.provider,
      configuredPrimaryModel: route.primary.model,
      actualProvider: null,
      actualModel: null,
      fallbackInvoked: false,
      fallbackReason: null,
      schemaValid: null,
      providerCalls: 0,
      repairCalls: 0,
      inputTokens: 0,
      outputTokens: 0,
      toolCalls: 0,
      budgetExceeded: false,
      failureCategory: null,
      calls: [],
    }

    const finish = (failureCategory: InferenceFailureCategory | null): InferenceTelemetry => {
      state.failureCategory = failureCategory
      state.budgetExceeded = failureCategory === 'budget_exceeded'
      const event: InferenceTelemetry = Object.freeze({
        ...state,
        durationMs: Math.max(0, this.now() - startedAt),
        calls: Object.freeze(state.calls.map((call) => Object.freeze({ ...call }))),
      })
      try {
        this.observer?.(event)
      } catch {
        // Telemetry must not alter inference behavior.
      }
      return event
    }

    const budgetError = (message: string): InferenceGatewayError => new InferenceGatewayError(message, {
      category: 'budget_exceeded', retryable: false,
      provider: state.actualProvider ?? undefined,
      model: state.actualModel ?? undefined,
    })

    const remainingWallTime = (): number => request.budget.maxWallTimeMs - (this.now() - startedAt)

    const callTarget = async (
      callMode: 'classify' | 'generateStructured' | 'repairStructured',
      prompt: string,
      target: InferenceProviderTarget,
    ): Promise<AttemptResult> => {
      if (state.providerCalls >= request.budget.maxProviderCalls) {
        throw budgetError('Provider call budget exhausted')
      }
      if (callMode === 'repairStructured' && (
        state.repairCalls >= request.budget.maxRepairCalls || state.repairCalls >= 1
      )) {
        throw budgetError('Repair call budget exhausted')
      }
      const timeoutMs = Math.floor(remainingWallTime())
      if (timeoutMs <= 0) throw budgetError('Wall-time budget exhausted')

      const estimatedInput = this.estimateTokens(prompt)
      if (!Number.isInteger(estimatedInput) || estimatedInput < 0) {
        throw new Error('estimateTokens must return a non-negative integer')
      }
      if (state.inputTokens + estimatedInput > request.budget.maxInputTokens) {
        throw budgetError('Input-token budget exhausted')
      }
      const remainingOutput = request.budget.maxOutputTokens - state.outputTokens
      if (remainingOutput <= 0) throw budgetError('Output-token budget exhausted')

      state.providerCalls += 1
      if (callMode === 'repairStructured') state.repairCalls += 1
      state.inputTokens += estimatedInput
      state.actualProvider = target.provider
      state.actualModel = target.model
      const callStartedAt = this.now()
      const record: InferenceCallRecord = {
        mode: callMode,
        provider: target.provider,
        model: target.model,
        durationMs: 0,
        status: 'failed',
        failureCategory: null,
        schemaValid: null,
        inputTokens: estimatedInput,
        outputTokens: 0,
      }
      const callIndex = state.calls.push(record) - 1
      const controller = new AbortController()
      let timer: NodeJS.Timeout | undefined

      try {
        const deadline = new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            controller.abort()
            reject(budgetError('Wall-time budget exhausted during provider call'))
          }, timeoutMs)
        })
        const result = await Promise.race([
          this.adapter.generate({
            mode: callMode,
            workload: request.workload,
            purpose: request.purpose,
            prompt,
            target,
            timeoutMs,
            maxOutputTokens: remainingOutput,
            signal: controller.signal,
          }),
          deadline,
        ])
        const actualProvider = result.actualProvider ?? target.provider
        const actualModel = result.actualModel ?? target.model
        state.actualProvider = actualProvider
        state.actualModel = actualModel
        record.provider = actualProvider
        record.model = actualModel

        const reportedInput = result.usage?.inputTokens ?? estimatedInput
        const rawForEstimate = result.rawOutput ?? stableOutput(result.value)
        const reportedOutput = result.usage?.outputTokens ?? this.estimateTokens(rawForEstimate)
        if (!Number.isInteger(reportedInput) || reportedInput < 0 || !Number.isInteger(reportedOutput) || reportedOutput < 0) {
          throw new Error('Provider usage must contain non-negative integer token counts')
        }
        state.inputTokens += reportedInput - estimatedInput
        state.outputTokens += reportedOutput
        record.inputTokens = reportedInput
        record.outputTokens = reportedOutput
        record.status = 'succeeded'
        record.durationMs = Math.max(0, this.now() - callStartedAt)

        if (state.inputTokens > request.budget.maxInputTokens) throw budgetError('Provider exceeded input-token budget')
        if (state.outputTokens > request.budget.maxOutputTokens) throw budgetError('Provider exceeded output-token budget')
        if (remainingWallTime() < 0) throw budgetError('Provider exceeded wall-time budget')
        return { result, callIndex }
      } catch (error) {
        record.durationMs = Math.max(0, this.now() - callStartedAt)
        const mapped = error instanceof InferenceGatewayError
          ? new InferenceGatewayError(error.message, {
            category: error.category,
            retryable: error.retryable,
            retryAfterMs: error.retryAfterMs,
            provider: error.provider ?? target.provider,
            model: error.model ?? target.model,
            cause: error.cause ?? error,
          })
          : new InferenceGatewayError('Structured provider adapter failed', {
            category: 'provider_unavailable', retryable: true,
            provider: target.provider, model: target.model, cause: error,
          })
        state.actualProvider = mapped.provider ?? target.provider
        state.actualModel = mapped.model ?? target.model
        record.provider = state.actualProvider
        record.model = state.actualModel
        record.failureCategory = mapped.category
        if (mapped.category === 'circuit_open') {
          // Hermes rejects before reaching a provider when its circuit is open.
          // Keep the refusal observable without charging provider/repair/token budgets.
          state.providerCalls -= 1
          if (callMode === 'repairStructured') state.repairCalls -= 1
          state.inputTokens -= estimatedInput
          record.inputTokens = 0
        }
        throw mapped
      } finally {
        if (timer) clearTimeout(timer)
      }
    }

    const callWithFallback = async (
      callMode: 'classify' | 'generateStructured' | 'repairStructured',
      prompt: string,
    ): Promise<AttemptResult> => {
      // Once a logical request moves to fallback it stays there. Never bounce
      // back to primary or build a nested fallback chain for a repair.
      if (state.fallbackInvoked && route.fallback) {
        return callTarget(callMode, prompt, route.fallback)
      }
      try {
        return await callTarget(callMode, prompt, route.primary)
      } catch (error) {
        const mapped = error as InferenceGatewayError
        const canFallback = route.fallback
          && !state.fallbackInvoked
          && mapped instanceof InferenceGatewayError
          && mapped.retryable
          && FALLBACK_FAILURES.has(mapped.category)
          && state.providerCalls < request.budget.maxProviderCalls
          && (callMode !== 'repairStructured' || state.repairCalls < Math.min(1, request.budget.maxRepairCalls))
        if (!canFallback || !route.fallback) throw error
        state.fallbackInvoked = true
        state.fallbackReason = mapped.category
        return callTarget(callMode, prompt, route.fallback)
      }
    }

    try {
      assertRequestInputs(request)
      assertToolLess(request)
      assertBudget(request.budget)

      const firstPrompt = mode === 'repairStructured'
        ? repairPrompt(request.prompt, invalidOutput, validationIssues)
        : request.prompt
      const first = await callWithFallback(mode, firstPrompt)
      const firstValidation = safeValidation(request.validate, first.result.value)
      state.calls[first.callIndex].schemaValid = firstValidation.valid
      state.schemaValid = firstValidation.valid
      if (firstValidation.valid) {
        return { value: firstValidation.value, telemetry: finish(null) }
      }

      if (mode !== 'repairStructured'
        && request.budget.maxRepairCalls > state.repairCalls
        && state.repairCalls < 1
        && state.providerCalls < request.budget.maxProviderCalls) {
        const repair = await callWithFallback(
          'repairStructured',
          repairPrompt(
            request.prompt,
            first.result.rawOutput ?? first.result.value,
            firstValidation.issues,
          ),
        )
        const repairedValidation = safeValidation(request.validate, repair.result.value)
        state.calls[repair.callIndex].schemaValid = repairedValidation.valid
        state.schemaValid = repairedValidation.valid
        if (repairedValidation.valid) {
          return { value: repairedValidation.value, telemetry: finish(null) }
        }
      }

      throw new InferenceGatewayError('Provider output failed structured validation', {
        category: 'invalid_structured_output', retryable: false,
        provider: state.actualProvider ?? undefined,
        model: state.actualModel ?? undefined,
      })
    } catch (error) {
      const mapped = error instanceof InferenceGatewayError
        ? error
        : new InferenceGatewayError('Inference gateway failed', {
          category: 'provider_unavailable', retryable: true, cause: error,
          provider: state.actualProvider ?? undefined,
          model: state.actualModel ?? undefined,
        })
      const telemetry = finish(mapped.category)
      throw mapped.withTelemetry(telemetry)
    }
  }
}
