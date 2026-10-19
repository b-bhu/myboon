import assert from 'node:assert/strict'
import test from 'node:test'
import type { HermesCallRecord, HermesOneshotRequest } from '../hermes'
import { DEFAULT_HERMES_PROFILE } from '../hermes'
import {
  CONFIGURED_INFERENCE_WORKLOADS,
  HermesStructuredAdapter,
  INFERENCE_GATEWAY_ENV,
  InferenceGatewayError,
  createConfiguredInferenceGateway,
  inferenceGatewayStatus,
  loadInferenceGatewayConfiguration,
  type InferenceBudget,
} from '.'
import { hermesCallLogObserver } from './configuration'

const BUDGET: InferenceBudget = {
  maxProviderCalls: 2,
  maxRepairCalls: 1,
  maxInputTokens: 1_000,
  maxOutputTokens: 100,
  maxWallTimeMs: 1_000,
  maxToolCalls: 0,
}

function valid(value: unknown) {
  return typeof value === 'object' && value !== null && (value as { ok?: unknown }).ok === true
    ? { valid: true as const, value: value as { ok: true } }
    : { valid: false as const, issues: ['ok must be true'] }
}

test('configuration defaults every registered workload to the approved primary with fallback disabled', () => {
  const configuration = loadInferenceGatewayConfiguration({})

  assert.equal(configuration.hermesProfile, DEFAULT_HERMES_PROFILE)
  assert.deepEqual(Object.keys(configuration.routes), CONFIGURED_INFERENCE_WORKLOADS)
  for (const route of Object.values(configuration.routes)) {
    assert.deepEqual(route.primary, { provider: 'ollama-cloud', model: 'glm-5.3-flash' })
    assert.equal(route.fallback, undefined)
  }
})

test('OpenRouter fallback is enabled only by an explicit approved model value', () => {
  const explicit = loadInferenceGatewayConfiguration({
    [INFERENCE_GATEWAY_ENV.hermesProfile]: 'myboon-structured',
    [INFERENCE_GATEWAY_ENV.openRouterFallbackModel]: 'openai/gpt-5-mini',
  })
  for (const route of Object.values(explicit.routes)) {
    if (route === explicit.routes['research.deep']) assert.equal(route.fallback, undefined)
    else assert.deepEqual(route.fallback, { provider: 'openrouter', model: 'openai/gpt-5-mini' })
  }
  assert.equal(explicit.hermesProfile, 'myboon-structured')

  const credentialsOnly = loadInferenceGatewayConfiguration({
    OPENROUTER_API_KEY: 'secret-that-must-not-enable-routing',
  })
  assert.equal(Object.values(credentialsOnly.routes).some((route) => route.fallback), false)
})

test('configuration rejects blank or unsafe values and duplicate primary/fallback targets', () => {
  assert.throws(
    () => loadInferenceGatewayConfiguration({ [INFERENCE_GATEWAY_ENV.primaryModel]: '' }),
    (error: unknown) => error instanceof InferenceGatewayError && error.retryable === false,
  )
  assert.throws(
    () => loadInferenceGatewayConfiguration({ [INFERENCE_GATEWAY_ENV.hermesProfile]: 'unsafe profile' }),
    InferenceGatewayError,
  )
  assert.throws(() => loadInferenceGatewayConfiguration({
    [INFERENCE_GATEWAY_ENV.primaryProvider]: 'openrouter',
    [INFERENCE_GATEWAY_ENV.primaryModel]: 'same/model',
    [INFERENCE_GATEWAY_ENV.openRouterFallbackModel]: 'same/model',
  }), /Primary and fallback provider\/model routes must differ/)
})

test('status snapshot is route-only, redacted, and marks investigate disabled without fallback', () => {
  const secret = 'sk-super-secret-value'
  const configuration = loadInferenceGatewayConfiguration({
    [INFERENCE_GATEWAY_ENV.hermesProfile]: 'private-profile-name',
    [INFERENCE_GATEWAY_ENV.openRouterFallbackModel]: 'approved/model',
    OPENROUTER_API_KEY: secret,
    OLLAMA_API_KEY: secret,
  })
  const status = inferenceGatewayStatus(configuration)
  const serialized = JSON.stringify(status)

  assert.equal(status.hermesProfileConfigured, true)
  assert.deepEqual(status.investigate, { enabled: false, fallbackEnabled: false })
  assert.equal(status.routes.length, 5)
  assert.equal(serialized.includes(secret), false)
  assert.equal(serialized.includes('private-profile-name'), false)
  assert.equal(serialized.includes('API_KEY'), false)
})

test('the failed-call observer logs routing and failure class without command, profile, or process output', () => {
  const lines: string[] = []
  const observer = hermesCallLogObserver((line) => lines.push(line))
  const record: HermesCallRecord = {
    purpose: 'test.classify',
    mode: 'oneshot',
    command: '/secret/path',
    requestedProfile: 'secret-profile',
    requestedProvider: 'p',
    requestedModel: 'm',
    status: 'failed',
    startedAt: '2026-10-19T00:00:00.000Z',
    finishedAt: '2026-10-19T00:00:01.000Z',
    durationMs: 12,
    promptChars: 3,
    stdoutChars: 8,
    stderrChars: 40,
    exitCode: null,
    exitSignal: null,
    failureClass: 'exit_126',
    error: 'spawn /secret/path ENOENT',
  }

  observer(record)

  assert.equal(lines.length, 1)
  const parsed = JSON.parse(lines[0]!) as Record<string, unknown>
  assert.equal(parsed.event, 'hermes_call_failed')
  assert.equal(parsed.purpose, 'test.classify')
  assert.equal(parsed.mode, 'oneshot')
  assert.equal(parsed.status, 'failed')
  assert.equal(parsed.provider, 'p')
  assert.equal(parsed.model, 'm')
  assert.equal(parsed.exitCode, null)
  assert.equal(parsed.exitSignal, null)
  assert.equal(parsed.failureClass, 'exit_126')
  assert.equal(lines[0]!.includes('/secret/path'), false)
  assert.equal(lines[0]!.includes('spawn'), false)
  assert.equal(lines[0]!.includes('secret-profile'), false)

  observer({ ...record, status: 'succeeded' })
  assert.equal(lines.length, 1)
})

test('configured runtime passes profile and actual primary/fallback targets through Hermes oneshot', async () => {
  const calls: HermesOneshotRequest[] = []
  let adapterFactoryProfile: string | undefined
  const service = {
    async oneshot(request: HermesOneshotRequest) {
      calls.push(request)
      if (request.provider === 'primary-provider') {
        throw Object.assign(new Error('rate limited'), { statusCode: 429 })
      }
      return { stdout: '{"ok":true}', stderr: '' }
    },
  }
  const runtime = createConfiguredInferenceGateway({
    env: {
      [INFERENCE_GATEWAY_ENV.hermesProfile]: 'structured-profile',
      [INFERENCE_GATEWAY_ENV.primaryProvider]: 'primary-provider',
      [INFERENCE_GATEWAY_ENV.primaryModel]: 'primary-model',
      [INFERENCE_GATEWAY_ENV.openRouterFallbackModel]: 'approved-fallback',
    },
    serviceFactory: () => service,
    adapterFactory: (input) => {
      adapterFactoryProfile = input.profile
      return new HermesStructuredAdapter(input)
    },
    estimateTokens: () => 10,
  })
  const result = await runtime.gateway.generateStructured({
    workload: 'research.synthesis',
    purpose: 'test.configured',
    prompt: 'Return JSON',
    promptVersion: 'prompt.v1',
    policyVersion: 'policy.v1',
    budget: BUDGET,
    validate: valid,
  })

  assert.equal(adapterFactoryProfile, 'structured-profile')
  assert.deepEqual(calls.map((call) => ({
    profile: call.profile,
    provider: call.provider,
    model: call.model,
  })), [
    { profile: 'structured-profile', provider: 'primary-provider', model: 'primary-model' },
    { profile: 'structured-profile', provider: 'openrouter', model: 'approved-fallback' },
  ])
  assert.equal(result.telemetry.actualProvider, 'openrouter')
  assert.equal(result.telemetry.actualModel, 'approved-fallback')
  assert.equal(result.telemetry.fallbackInvoked, true)
})

test('configured structured gateway rejects unknown workloads and investigate remains fail-closed', async () => {
  let calls = 0
  const runtime = createConfiguredInferenceGateway({
    env: {},
    serviceFactory: () => ({
      async oneshot() {
        calls += 1
        return { stdout: '{"ok":true}', stderr: '' }
      },
    }),
  })
  await assert.rejects(runtime.gateway.generateStructured({
    workload: 'not.registered',
    purpose: 'test.unknown',
    prompt: 'Generate',
    promptVersion: 'prompt.v1',
    policyVersion: 'policy.v1',
    budget: BUDGET,
    validate: valid,
  }), (error: unknown) => error instanceof InferenceGatewayError && error.category === 'provider_unavailable')
  await assert.rejects(runtime.gateway.investigate({
    workload: 'research.deep',
    purpose: 'test.deep',
    prompt: 'Investigate',
    promptVersion: 'prompt.v1',
    policyVersion: 'policy.v1',
    budget: { ...BUDGET, maxToolCalls: 2 },
    allowedCapabilities: ['browser'],
  }), (error: unknown) => error instanceof InferenceGatewayError && error.retryable === false)
  assert.equal(calls, 0)
})

test('configured status derives investigate availability from the live gateway', () => {
  const runtime = createConfiguredInferenceGateway({ env: {}, adapterFactory: () => ({ generate: async () => ({ value: {} }) }), serviceFactory: () => ({ oneshot: async () => ({ stdout: '{}', stderr: '' }) }) })
  assert.equal(runtime.status.investigate.enabled, false)
  runtime.gateway.attachInvestigationPort({ execute: async () => ({
    value: {}, usage: { providerCalls: 0, inputTokens: 0, outputTokens: 0, toolCalls: 0, wallTimeMs: 0 },
  }) })
  assert.equal(runtime.status.investigate.enabled, true)
})

test('configuration validates explicit workload reasoning, concurrency, and rate policy', () => {
  const validPolicy = JSON.stringify({
    'research.synthesis': { reasoningEffort: 'high', maxConcurrency: 2, rateLimit: { maxCalls: 3, windowMs: 1_000 } },
  })
  const configured = loadInferenceGatewayConfiguration({ [INFERENCE_GATEWAY_ENV.workloadPoliciesJson]: validPolicy })
  assert.equal(configured.routes['research.synthesis'].reasoningEffort, 'high')
  for (const policy of [
    { reasoningEffort: 'extreme', maxConcurrency: 2, rateLimit: { maxCalls: 3, windowMs: 1_000 } },
    { reasoningEffort: 'low', maxConcurrency: 0, rateLimit: { maxCalls: 3, windowMs: 1_000 } },
    { reasoningEffort: 'low', maxConcurrency: 2, rateLimit: { maxCalls: 0, windowMs: 1_000 } },
  ]) assert.throws(() => loadInferenceGatewayConfiguration({
    [INFERENCE_GATEWAY_ENV.workloadPoliciesJson]: JSON.stringify({ 'research.synthesis': policy }),
  }), InferenceGatewayError)
})
