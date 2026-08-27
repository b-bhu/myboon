import assert from 'node:assert/strict'
import test from 'node:test'
import {
  HermesProviderCircuitBreaker,
  HermesProviderCircuitOpenError,
  HermesService,
} from '../hermes'
import {
  HermesStructuredAdapter,
  InferenceGateway,
  InferenceGatewayError,
  InferenceGatewayStageReadiness,
  mapHermesInferenceError,
  type GenerateStructuredRequest,
  type InferenceBudget,
  type StructuredProviderAdapter,
  type StructuredProviderRequest,
  type StructuredProviderResult,
} from '.'

const PRIMARY = { provider: 'ollama-cloud', model: 'deepseek-v4-flash' }
const FALLBACK = { provider: 'openrouter', model: 'approved-fallback' }

const DEFAULT_BUDGET: InferenceBudget = {
  maxProviderCalls: 2,
  maxRepairCalls: 1,
  maxInputTokens: 10_000,
  maxOutputTokens: 1_000,
  maxWallTimeMs: 1_000,
  maxToolCalls: 0,
}

function valid(value: unknown) {
  if (typeof value === 'object' && value !== null && typeof (value as { answer?: unknown }).answer === 'string') {
    return { valid: true as const, value: value as { answer: string } }
  }
  return { valid: false as const, issues: ['answer must be a string'] }
}

function request(overrides: Partial<GenerateStructuredRequest<{ answer: string }>> = {}): GenerateStructuredRequest<{ answer: string }> {
  return {
    workload: 'research.standard',
    purpose: 'test.structured',
    prompt: 'Return an answer as JSON.',
    promptVersion: 'prompt.v1',
    policyVersion: 'policy.v1',
    budget: { ...DEFAULT_BUDGET },
    validate: valid,
    ...overrides,
  }
}

class QueueAdapter implements StructuredProviderAdapter {
  readonly requests: StructuredProviderRequest[] = []
  constructor(private readonly outcomes: Array<StructuredProviderResult | Error>) {}

  async generate(providerRequest: StructuredProviderRequest): Promise<StructuredProviderResult> {
    this.requests.push(providerRequest)
    const outcome = this.outcomes.shift()
    if (!outcome) throw new Error('Unexpected provider call')
    if (outcome instanceof Error) throw outcome
    return outcome
  }
}

function gateway(adapter: StructuredProviderAdapter, observer?: (value: unknown) => void): InferenceGateway {
  return new InferenceGateway({
    adapter,
    routes: { 'research.standard': { primary: PRIMARY, fallback: FALLBACK } },
    observer,
    estimateTokens: () => 10,
  })
}

function providerError(category: InferenceGatewayError['category'], retryable = true): InferenceGatewayError {
  return new InferenceGatewayError(category, { category, retryable })
}

test('generateStructured succeeds with one tool-less provider call and complete telemetry', async () => {
  const adapter = new QueueAdapter([{
    value: { answer: 'yes' },
    usage: { inputTokens: 12, outputTokens: 3 },
    actualProvider: 'actual-provider',
    actualModel: 'actual-model',
  }])
  const events: unknown[] = []
  const result = await gateway(adapter, (event) => events.push(event)).generateStructured(request())

  assert.deepEqual(result.value, { answer: 'yes' })
  assert.equal(adapter.requests.length, 1)
  assert.equal(adapter.requests[0].mode, 'generateStructured')
  assert.equal('tools' in adapter.requests[0], false)
  assert.equal('toolsets' in adapter.requests[0], false)
  assert.equal(result.telemetry.configuredPrimaryProvider, PRIMARY.provider)
  assert.equal(result.telemetry.actualProvider, 'actual-provider')
  assert.equal(result.telemetry.schemaValid, true)
  assert.equal(result.telemetry.providerCalls, 1)
  assert.equal(result.telemetry.repairCalls, 0)
  assert.equal(result.telemetry.inputTokens, 12)
  assert.equal(result.telemetry.outputTokens, 3)
  assert.equal(result.telemetry.toolCalls, 0)
  assert.equal(result.telemetry.promptVersion, 'prompt.v1')
  assert.equal(result.telemetry.policyVersion, 'policy.v1')
  assert.equal(events.length, 1)
})

test('classify is a first-class tool-less mode with the same validation and repair guarantees', async () => {
  const adapter = new QueueAdapter([
    { value: { wrong: true }, rawOutput: '{"wrong":true}' },
    { value: { answer: 'classified' }, rawOutput: '{"answer":"classified"}' },
  ])
  const result = await gateway(adapter).classify({
    ...request(),
    mode: 'classify',
  })

  assert.equal(result.value.answer, 'classified')
  assert.equal(result.telemetry.mode, 'classify')
  assert.deepEqual(adapter.requests.map((call) => call.mode), ['classify', 'repairStructured'])
  assert.equal(adapter.requests.some((call) => 'tools' in call || 'toolsets' in call), false)
  assert.equal(result.telemetry.providerCalls, 2)
  assert.equal(result.telemetry.repairCalls, 1)
})

test('investigate fails closed without invoking the structured adapter', async () => {
  const adapter = new QueueAdapter([{ value: { answer: 'must not run' } }])
  await assert.rejects(gateway(adapter).investigate({
    workload: 'research.deep',
    purpose: 'test.investigate',
    prompt: 'Investigate',
    promptVersion: 'prompt.v1',
    policyVersion: 'policy.v1',
    budget: { ...DEFAULT_BUDGET, maxToolCalls: 3 },
    allowedCapabilities: ['browser'],
  }), (error: unknown) => {
    assert.ok(error instanceof InferenceGatewayError)
    assert.equal(error.category, 'provider_unavailable')
    assert.equal(error.retryable, false)
    assert.match(error.message, /disabled until a contained investigation worker/)
    return true
  })
  assert.equal(adapter.requests.length, 0)
})

test('unknown workload and unsafe prompt-policy metadata fail before provider invocation', async () => {
  const adapter = new QueueAdapter([{ value: { answer: 'must not run' } }])
  await assert.rejects(gateway(adapter).generateStructured(request({ workload: 'unknown.workload' })), (error: unknown) => {
    assert.ok(error instanceof InferenceGatewayError)
    assert.equal(error.category, 'provider_unavailable')
    assert.equal(error.retryable, false)
    return true
  })
  await assert.rejects(gateway(adapter).generateStructured(request({ policyVersion: ' ' })), (error: unknown) => {
    assert.ok(error instanceof InferenceGatewayError)
    assert.equal(error.category, 'invalid_structured_output')
    return true
  })
  await assert.rejects(gateway(adapter).generateStructured(request({ promptVersion: 'prompt with spaces' })), (error: unknown) => {
    assert.ok(error instanceof InferenceGatewayError)
    assert.equal(error.category, 'invalid_structured_output')
    return true
  })
  assert.equal(adapter.requests.length, 0)
})

test('invalid output permits exactly one explicit repair call', async () => {
  const adapter = new QueueAdapter([
    { value: { nope: true }, rawOutput: '{"nope":true}' },
    { value: { answer: 'repaired' }, rawOutput: '{"answer":"repaired"}' },
  ])
  const result = await gateway(adapter).generateStructured(request())

  assert.deepEqual(result.value, { answer: 'repaired' })
  assert.deepEqual(adapter.requests.map((call) => call.mode), ['generateStructured', 'repairStructured'])
  assert.match(adapter.requests[1].prompt, /Return only the repaired JSON value/)
  assert.match(adapter.requests[1].prompt, /answer must be a string/)
  assert.equal(result.telemetry.providerCalls, 2)
  assert.equal(result.telemetry.repairCalls, 1)
  assert.equal(result.telemetry.calls[0].schemaValid, false)
  assert.equal(result.telemetry.calls[1].schemaValid, true)
})

test('a second invalid output stops after one repair with typed telemetry', async () => {
  const adapter = new QueueAdapter([
    { value: null, rawOutput: 'not json' },
    { value: { still: 'wrong' }, rawOutput: '{"still":"wrong"}' },
    { value: { answer: 'must not run' } },
  ])

  await assert.rejects(gateway(adapter).generateStructured(request()), (error: unknown) => {
    assert.ok(error instanceof InferenceGatewayError)
    assert.equal(error.category, 'invalid_structured_output')
    assert.equal(error.retryable, false)
    assert.equal(error.telemetry?.providerCalls, 2)
    assert.equal(error.telemetry?.repairCalls, 1)
    assert.equal(error.telemetry?.schemaValid, false)
    return true
  })
  assert.equal(adapter.requests.length, 2)
})

test('a typed provider failure during repair stops immediately', async () => {
  const adapter = new QueueAdapter([
    { value: null, rawOutput: 'bad' },
    providerError('provider_authentication', false),
  ])
  await assert.rejects(gateway(adapter).generateStructured(request()), (error: unknown) => {
    assert.ok(error instanceof InferenceGatewayError)
    assert.equal(error.category, 'provider_authentication')
    assert.equal(error.telemetry?.repairCalls, 1)
    return true
  })
  assert.equal(adapter.requests.length, 2)
})

test('repairStructured performs one repair-only call', async () => {
  const adapter = new QueueAdapter([{ value: { answer: 'fixed' } }])
  const result = await gateway(adapter).repairStructured({
    ...request(),
    mode: 'repairStructured',
    invalidOutput: '{broken',
    validationIssues: ['invalid JSON'],
  })
  assert.deepEqual(result.value, { answer: 'fixed' })
  assert.equal(adapter.requests.length, 1)
  assert.equal(adapter.requests[0].mode, 'repairStructured')
  assert.equal(result.telemetry.providerCalls, 1)
  assert.equal(result.telemetry.repairCalls, 1)
})

test('structured modes reject runtime tool properties and nonzero tool budgets before calling provider', async () => {
  const adapter = new QueueAdapter([{ value: { answer: 'unused' } }])
  const withTools = { ...request(), tools: [] } as unknown as GenerateStructuredRequest<{ answer: string }>
  await assert.rejects(gateway(adapter).generateStructured(withTools), (error: unknown) => {
    assert.ok(error instanceof InferenceGatewayError)
    assert.equal(error.category, 'budget_exceeded')
    assert.equal(error.telemetry?.toolCalls, 0)
    return true
  })
  await assert.rejects(gateway(adapter).generateStructured(request({
    budget: { ...DEFAULT_BUDGET, maxToolCalls: 1 } as unknown as InferenceBudget,
  })), (error: unknown) => {
    assert.ok(error instanceof InferenceGatewayError)
    assert.equal(error.category, 'budget_exceeded')
    return true
  })
  assert.equal(adapter.requests.length, 0)
})

test('Hermes adapter routes its target through oneshot without chat, sessions, or toolsets', async () => {
  const calls: unknown[] = []
  let chatCalls = 0
  const service = {
    async oneshot(value: unknown) {
      calls.push(value)
      return { stdout: 'prefix {"answer":"ok"}', stderr: '' }
    },
    async chat() {
      chatCalls += 1
      throw new Error('chat must not run')
    },
  }
  const adapter = new HermesStructuredAdapter({ service, profile: 'structured-profile' })
  const result = await adapter.generate({
    mode: 'generateStructured', workload: 'x', purpose: 'x', prompt: 'prompt', target: PRIMARY,
    timeoutMs: 100, maxOutputTokens: 100, signal: new AbortController().signal,
  })
  assert.deepEqual(result.value, { answer: 'ok' })
  assert.equal(result.actualProvider, PRIMARY.provider)
  assert.equal(result.actualModel, PRIMARY.model)
  assert.equal(result.actualReasoningEffort, undefined)
  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0], {
    purpose: 'x',
    prompt: 'prompt',
    timeoutMs: 100,
    profile: 'structured-profile',
    provider: PRIMARY.provider,
    model: PRIMARY.model,
  })
  assert.equal(chatCalls, 0)
  assert.equal(JSON.stringify(calls[0]).includes('toolsets'), false)
  assert.equal(JSON.stringify(calls[0]).includes('session'), false)
})

test('Hermes-backed gateway invokes primary and fallback CLI targets', async () => {
  const calls: string[][] = []
  const execFileImpl = async (_command: string, args: string[]) => {
    calls.push(args)
    const provider = args[args.indexOf('--provider') + 1]
    if (provider === PRIMARY.provider) {
      throw Object.assign(new Error('rate limited'), { statusCode: 429 })
    }
    return { stdout: '{"answer":"fallback"}', stderr: '' }
  }
  const service = new HermesService({
    command: 'hermes',
    execFileImpl,
    circuitBreaker: new HermesProviderCircuitBreaker({
      failureThreshold: 5, cooldownMs: 1000, logger: () => {},
    }),
  })
  const adapter = new HermesStructuredAdapter({ service, profile: 'gateway-profile' })
  const result = await gateway(adapter).generateStructured(request())

  assert.equal(result.value.answer, 'fallback')
  assert.deepEqual(calls.map((args) => args.slice(0, -2)), [
    ['-p', 'gateway-profile', '--provider', PRIMARY.provider, '-m', PRIMARY.model],
    ['-p', 'gateway-profile', '--provider', FALLBACK.provider, '-m', FALLBACK.model],
  ])
  assert.equal(calls.every((args) => !args.includes('-t') && !args.includes('chat')), true)
  assert.equal(result.telemetry.actualProvider, FALLBACK.provider)
  assert.equal(result.telemetry.actualModel, FALLBACK.model)
})

test('Hermes-backed gateway reaches fallback when the primary target circuit is open', async () => {
  const suffix = `${process.pid}-${Date.now()}`
  const primary = { provider: `primary-open-${suffix}`, model: `model-${suffix}` }
  const fallback = { provider: `fallback-healthy-${suffix}`, model: `model-${suffix}` }
  const calls: string[][] = []
  const execFileImpl = async (_command: string, args: string[]) => {
    calls.push(args)
    const provider = args[args.indexOf('--provider') + 1]
    if (provider === primary.provider) {
      throw Object.assign(new Error('rate limited'), { statusCode: 429 })
    }
    return { stdout: '{"answer":"healthy fallback"}', stderr: '' }
  }
  const service = new HermesService({ command: 'hermes', execFileImpl })
  for (let index = 0; index < 5; index += 1) {
    await assert.rejects(service.oneshot({
      purpose: 'test.open-primary', prompt: 'P', timeoutMs: 500,
      provider: primary.provider, model: primary.model,
    }))
  }
  const inference = new InferenceGateway({
    adapter: new HermesStructuredAdapter({ service }),
    routes: { 'research.standard': { primary, fallback } },
    estimateTokens: () => 10,
  })
  const result = await inference.generateStructured(request())

  assert.equal(result.value.answer, 'healthy fallback')
  assert.equal(calls.filter((args) => args.includes(primary.provider)).length, 5)
  assert.equal(calls.filter((args) => args.includes(fallback.provider)).length, 1)
  assert.equal(result.telemetry.fallbackInvoked, true)
  assert.equal(result.telemetry.fallbackReason, 'circuit_open')
  assert.equal(result.telemetry.providerCalls, 1)
})

test('Hermes errors map timeout, circuit, authentication, and rate categories', () => {
  assert.equal(mapHermesInferenceError(Object.assign(new Error('late'), { code: 'ETIMEDOUT' }), PRIMARY).category, 'provider_timeout')
  const circuit = mapHermesInferenceError(new HermesProviderCircuitOpenError(1234), PRIMARY)
  assert.equal(circuit.category, 'circuit_open')
  assert.equal(circuit.retryAfterMs, 1234)
  assert.equal(mapHermesInferenceError(Object.assign(new Error('denied'), { statusCode: 401 }), PRIMARY).category, 'provider_authentication')
  assert.equal(mapHermesInferenceError(Object.assign(new Error('busy'), { status: 429 }), PRIMARY).category, 'provider_rate_limited')
})

test('provider call and repair budgets stop additional calls', async () => {
  const noCalls = new QueueAdapter([{ value: { answer: 'unused' } }])
  await assert.rejects(gateway(noCalls).generateStructured(request({
    budget: { ...DEFAULT_BUDGET, maxProviderCalls: 0 },
  })), (error: unknown) => error instanceof InferenceGatewayError && error.category === 'budget_exceeded')
  assert.equal(noCalls.requests.length, 0)

  const noRepair = new QueueAdapter([{ value: null }, { value: { answer: 'unused' } }])
  await assert.rejects(gateway(noRepair).generateStructured(request({
    budget: { ...DEFAULT_BUDGET, maxRepairCalls: 0 },
  })), (error: unknown) => error instanceof InferenceGatewayError && error.category === 'invalid_structured_output')
  assert.equal(noRepair.requests.length, 1)
})

test('input and output token budgets are enforced', async () => {
  const inputAdapter = new QueueAdapter([{ value: { answer: 'unused' } }])
  await assert.rejects(gateway(inputAdapter).generateStructured(request({
    budget: { ...DEFAULT_BUDGET, maxInputTokens: 9 },
  })), (error: unknown) => error instanceof InferenceGatewayError && error.category === 'budget_exceeded')
  assert.equal(inputAdapter.requests.length, 0)

  const outputAdapter = new QueueAdapter([{
    value: { answer: 'too expensive' }, usage: { inputTokens: 10, outputTokens: 11 },
  }])
  await assert.rejects(gateway(outputAdapter).generateStructured(request({
    budget: { ...DEFAULT_BUDGET, maxOutputTokens: 10 },
  })), (error: unknown) => {
    assert.ok(error instanceof InferenceGatewayError)
    assert.equal(error.category, 'budget_exceeded')
    assert.equal(error.telemetry?.outputTokens, 11)
    return true
  })
})

test('wall-time budget aborts an adapter which does not settle', async () => {
  let aborted = false
  const adapter: StructuredProviderAdapter = {
    generate(providerRequest) {
      providerRequest.signal.addEventListener('abort', () => { aborted = true })
      return new Promise(() => undefined)
    },
  }
  await assert.rejects(gateway(adapter).generateStructured(request({
    budget: { ...DEFAULT_BUDGET, maxWallTimeMs: 10 },
  })), (error: unknown) => error instanceof InferenceGatewayError && error.category === 'budget_exceeded')
  assert.equal(aborted, true)
})

test('retryable primary failure invokes one fallback and records its reason', async () => {
  const adapter = new QueueAdapter([
    providerError('provider_timeout'),
    { value: { answer: 'fallback' } },
  ])
  const result = await gateway(adapter).generateStructured(request())
  assert.deepEqual(adapter.requests.map((call) => call.target.provider), [PRIMARY.provider, FALLBACK.provider])
  assert.equal(result.telemetry.fallbackInvoked, true)
  assert.equal(result.telemetry.fallbackReason, 'provider_timeout')
  assert.equal(result.telemetry.actualProvider, FALLBACK.provider)
})

test('a real primary deadline reserves wall time for the configured fallback', async () => {
  const calls: StructuredProviderRequest[] = []
  const adapter: StructuredProviderAdapter = {
    async generate(providerRequest) {
      calls.push(providerRequest)
      if (providerRequest.target.provider === PRIMARY.provider) {
        // Simulate an adapter which returns late instead of rejecting at its
        // requested per-attempt timeout. The gateway still enforces the slice.
        await new Promise((resolve) => setTimeout(resolve, providerRequest.timeoutMs + 5))
        return { value: { answer: 'late primary must be discarded' } }
      }
      return { value: { answer: 'fallback after real timeout' } }
    },
  }
  const result = await gateway(adapter).generateStructured(request({
    budget: { ...DEFAULT_BUDGET, maxWallTimeMs: 80 },
  }))

  assert.deepEqual(calls.map((call) => call.target.provider), [PRIMARY.provider, FALLBACK.provider])
  assert.ok(calls[0]!.timeoutMs > 0 && calls[0]!.timeoutMs < 80)
  assert.ok(calls[1]!.timeoutMs > 0)
  assert.equal(result.telemetry.fallbackReason, 'provider_timeout')
  assert.equal(result.value.answer, 'fallback after real timeout')
})

test('route readiness becomes blocked only when every configured target circuit is open', async () => {
  const primaryOpen = new InferenceGatewayError('primary open', {
    category: 'circuit_open', retryable: true, retryAfterMs: 5_000,
  })
  const fallbackOpen = new InferenceGatewayError('fallback open', {
    category: 'circuit_open', retryable: true, retryAfterMs: 7_000,
  })
  const inference = gateway(new QueueAdapter([primaryOpen, fallbackOpen]))
  await assert.rejects(inference.generateStructured(request()), InferenceGatewayError)

  const readiness = inference.checkReadiness('research.standard')
  assert.equal(readiness.ready, false)
  if (!readiness.ready) {
    assert.equal(readiness.category, 'circuit_open')
    assert.equal(readiness.blockedTargets.length, 2)
    assert.ok(readiness.retryAfterMs > 0)
  }
  const workerReadiness = new InferenceGatewayStageReadiness(inference, 'research.standard')
  assert.deepEqual(await workerReadiness.checkStage('retrieval'), { ready: true })
  assert.equal((await workerReadiness.checkStage('synthesis')).ready, false)
  const snapshot = inference.circuitStatusSnapshot()
  assert.equal(snapshot.schemaVersion, 'myboon.inference_circuit_status.v1')
  assert.equal(snapshot.workloads[0]?.ready, false)
  assert.deepEqual(snapshot.workloads[0]?.targets.map((target) => ({
    provider: target.provider, circuitOpen: target.circuitOpen,
  })), [
    { provider: PRIMARY.provider, circuitOpen: true },
    { provider: FALLBACK.provider, circuitOpen: true },
  ])
  assert.equal(JSON.stringify(snapshot).includes('prompt'), false)
})

test('authentication does not fallback and a failing fallback has no deeper fallback', async () => {
  const auth = new QueueAdapter([providerError('provider_authentication', false), { value: { answer: 'unused' } }])
  await assert.rejects(gateway(auth).generateStructured(request()), (error: unknown) => {
    assert.ok(error instanceof InferenceGatewayError)
    assert.equal(error.category, 'provider_authentication')
    assert.equal(error.telemetry?.fallbackInvoked, false)
    return true
  })
  assert.equal(auth.requests.length, 1)

  const failingFallback = new QueueAdapter([
    providerError('provider_unavailable'),
    providerError('provider_rate_limited'),
    { value: { answer: 'must not run' } },
  ])
  await assert.rejects(gateway(failingFallback).generateStructured(request({
    budget: { ...DEFAULT_BUDGET, maxProviderCalls: 3 },
  })), (error: unknown) => {
    assert.ok(error instanceof InferenceGatewayError)
    assert.equal(error.category, 'provider_rate_limited')
    assert.equal(error.telemetry?.providerCalls, 2)
    assert.equal(error.telemetry?.fallbackReason, 'provider_unavailable')
    return true
  })
  assert.equal(failingFallback.requests.length, 2)
})

test('investigate route never exposes a configured fallback', () => {
  const adapter = new QueueAdapter([])
  const inference = gateway(adapter)
  assert.deepEqual(inference.resolveRoute('research.standard', 'investigate'), { primary: PRIMARY })
  assert.deepEqual(inference.resolveRoute('research.standard', 'generateStructured'), {
    primary: PRIMARY,
    fallback: FALLBACK,
  })
})

test('repair after fallback remains on fallback and never bounces to primary', async () => {
  const adapter = new QueueAdapter([
    providerError('circuit_open'),
    { value: null, rawOutput: 'bad fallback output' },
    { value: { answer: 'repaired on fallback' } },
  ])
  const result = await gateway(adapter).generateStructured(request({
    budget: { ...DEFAULT_BUDGET, maxProviderCalls: 2 },
  }))
  assert.deepEqual(adapter.requests.map((call) => call.target.provider), [
    PRIMARY.provider,
    FALLBACK.provider,
    FALLBACK.provider,
  ])
  assert.equal(result.telemetry.providerCalls, 2)
  assert.equal(result.telemetry.repairCalls, 1)
})

test('structured admission enforces concurrency and a windowed request rate', async () => {
  let releaseFirst!: () => void
  const entered = new Promise<void>((resolve) => { releaseFirst = resolve })
  let calls = 0
  const inference = new InferenceGateway({
    adapter: {
      async generate() {
        calls += 1
        if (calls === 1) await entered
        return { value: { answer: 'ok' } }
      },
    },
    routes: { 'research.standard': { primary: PRIMARY, maxConcurrency: 1, rateLimit: { maxCalls: 2, windowMs: 100 } } },
    estimateTokens: () => 1,
  })
  const first = inference.generateStructured(request())
  await new Promise((resolve) => setImmediate(resolve))
  await assert.rejects(inference.generateStructured(request()), (error: unknown) =>
    error instanceof InferenceGatewayError && error.category === 'provider_rate_limited')
  releaseFirst()
  await first
  assert.equal(calls, 1)

  let now = 1_000
  const rateLimited = new InferenceGateway({
    adapter: { generate: async () => ({ value: { answer: 'ok' } }) },
    routes: { 'research.standard': { primary: PRIMARY, rateLimit: { maxCalls: 1, windowMs: 100 } } },
    estimateTokens: () => 1, now: () => now,
  })
  await rateLimited.generateStructured(request())
  await assert.rejects(rateLimited.generateStructured(request()), (error: unknown) =>
    error instanceof InferenceGatewayError && error.category === 'provider_rate_limited')
  now += 101
  await rateLimited.generateStructured(request())
})

test('reasoning policy reaches the adapter while Hermes-compatible actual reasoning remains unmeasured', async () => {
  let observed: StructuredProviderRequest | undefined
  const inference = new InferenceGateway({
    adapter: { generate: async (call) => { observed = call; return { value: { answer: 'ok' } } } },
    routes: { 'research.standard': { primary: PRIMARY, reasoningEffort: 'low' } },
    estimateTokens: () => 1,
  })
  const result = await inference.generateStructured(request())
  assert.equal(observed?.reasoningEffort, 'low')
  assert.equal(result.telemetry.configuredReasoningEffort, 'low')
  assert.equal(result.telemetry.actualReasoningEffort, null)
})

test('monetary budget requires measured cost and never guesses it', async () => {
  const measured = new InferenceGateway({
    adapter: { generate: async () => ({ value: { answer: 'ok' }, costUsdMicros: 7 }) },
    routes: { 'research.standard': { primary: PRIMARY } }, estimateTokens: () => 1,
  })
  const success = await measured.generateStructured(request({ budget: { ...DEFAULT_BUDGET, maxCostUsdMicros: 7 } }))
  assert.equal(success.telemetry.costUsdMicros, 7)

  for (const costUsdMicros of [undefined, 8]) {
    const inference = new InferenceGateway({
      adapter: { generate: async () => ({ value: { answer: 'ok' }, ...(costUsdMicros === undefined ? {} : { costUsdMicros }) }) },
      routes: { 'research.standard': { primary: PRIMARY } }, estimateTokens: () => 1,
    })
    await assert.rejects(inference.generateStructured(request({ budget: { ...DEFAULT_BUDGET, maxCostUsdMicros: 7 } })),
      (error: unknown) => error instanceof InferenceGatewayError && error.category === 'budget_exceeded')
  }
})

test('contained investigation attachment is composition-only before the first admission', () => {
  const inference = new InferenceGateway({ adapter: new QueueAdapter([]), routes: { 'research.deep': { primary: PRIMARY } } })
  inference.checkReadiness('research.deep')
  assert.throws(() => inference.attachInvestigationPort({ execute: async () => ({
    value: {}, usage: { providerCalls: 0, inputTokens: 0, outputTokens: 0, toolCalls: 0, wallTimeMs: 0 },
  }) }), (error: unknown) => error instanceof InferenceGatewayError && error.retryable === false)
  assert.equal(inference.investigationEnabled, false)
})
