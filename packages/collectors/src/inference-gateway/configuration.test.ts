import assert from 'node:assert/strict'
import test from 'node:test'
import type { HermesOneshotRequest } from '../hermes'
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

  assert.equal(configuration.hermesProfile, undefined)
  assert.deepEqual(Object.keys(configuration.routes), CONFIGURED_INFERENCE_WORKLOADS)
  for (const route of Object.values(configuration.routes)) {
    assert.deepEqual(route.primary, { provider: 'ollama-cloud', model: 'deepseek-v4-flash' })
    assert.equal(route.fallback, undefined)
  }
})

test('OpenRouter fallback is enabled only by an explicit approved model value', () => {
  const explicit = loadInferenceGatewayConfiguration({
    [INFERENCE_GATEWAY_ENV.hermesProfile]: 'myboon-structured',
    [INFERENCE_GATEWAY_ENV.openRouterFallbackModel]: 'openai/gpt-5-mini',
  })
  for (const route of Object.values(explicit.routes)) {
    assert.deepEqual(route.fallback, { provider: 'openrouter', model: 'openai/gpt-5-mini' })
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
  assert.equal(status.routes.length, 4)
  assert.equal(serialized.includes(secret), false)
  assert.equal(serialized.includes('private-profile-name'), false)
  assert.equal(serialized.includes('API_KEY'), false)
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

test('configured gateway rejects unknown workloads and investigate remains fail-closed', async () => {
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
  await assert.rejects(runtime.gateway.classify({
    workload: 'not.registered',
    purpose: 'test.unknown',
    prompt: 'Classify',
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
