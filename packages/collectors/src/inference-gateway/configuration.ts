import { HermesService } from '../hermes'
import { InferenceGateway, type InferenceGatewayOptions } from './gateway'
import { InferenceGatewayError } from './errors'
import { HermesStructuredAdapter } from './hermes-adapter'
import type {
  InferenceTelemetryObserver,
  InferenceWorkloadRoute,
  StructuredProviderAdapter,
} from './types'

export const CONFIGURED_INFERENCE_WORKLOADS = [
  'triage.classify',
  'research.synthesis',
  'entity.extract',
  'editor.draft',
  'research.deep',
] as const

export type ConfiguredInferenceWorkload = typeof CONFIGURED_INFERENCE_WORKLOADS[number]

export const INFERENCE_GATEWAY_ENV = Object.freeze({
  hermesProfile: 'INFERENCE_GATEWAY_HERMES_PROFILE',
  primaryProvider: 'INFERENCE_GATEWAY_PRIMARY_PROVIDER',
  primaryModel: 'INFERENCE_GATEWAY_PRIMARY_MODEL',
  openRouterFallbackModel: 'INFERENCE_GATEWAY_OPENROUTER_FALLBACK_MODEL',
  workloadPoliciesJson: 'INFERENCE_GATEWAY_WORKLOAD_POLICIES_JSON',
  deepProvider: 'FEED_V3_DEEP_RESEARCH_PROVIDER',
  deepModel: 'FEED_V3_DEEP_RESEARCH_MODEL',
} as const)

const DEFAULT_PRIMARY_PROVIDER = 'ollama-cloud'
const DEFAULT_PRIMARY_MODEL = 'deepseek-v4-flash'
const OPENROUTER_PROVIDER = 'openrouter'
const MAX_CONFIG_VALUE_CHARS = 200

export interface InferenceGatewayConfiguration {
  hermesProfile?: string
  routes: Readonly<Record<ConfiguredInferenceWorkload, InferenceWorkloadRoute>>
}

export interface InferenceGatewayRouteStatus {
  workload: ConfiguredInferenceWorkload
  primary: Readonly<{ provider: string, model: string }>
  fallback: Readonly<{ provider: string, model: string }> | null
  reasoningEffort: 'low' | 'medium' | 'high'
  maxConcurrency: number
  rateLimit: Readonly<{ maxCalls: number, windowMs: number }>
}

export interface InferenceGatewayStatusSnapshot {
  schemaVersion: 'myboon.inference_gateway_status.v1'
  hermesProfileConfigured: boolean
  investigate: Readonly<{ enabled: boolean, fallbackEnabled: false }>
  routes: readonly InferenceGatewayRouteStatus[]
}

export interface InferenceAdapterFactoryInput {
  service: Pick<HermesService, 'oneshot'>
  profile?: string
  estimateTokens?: (text: string) => number
}

export interface CreateConfiguredInferenceGatewayOptions {
  env?: Readonly<Record<string, string | undefined>>
  serviceFactory?: () => Pick<HermesService, 'oneshot'>
  adapterFactory?: (input: InferenceAdapterFactoryInput) => StructuredProviderAdapter
  observer?: InferenceTelemetryObserver
  estimateTokens?: (text: string) => number
  now?: () => number
}

export interface ConfiguredInferenceGatewayRuntime {
  gateway: InferenceGateway
  configuration: InferenceGatewayConfiguration
  readonly status: InferenceGatewayStatusSnapshot
}

export function loadInferenceGatewayConfiguration(
  env: Readonly<Record<string, string | undefined>> = process.env,
): InferenceGatewayConfiguration {
  const primaryProvider = configuredValue(
    'primary provider',
    env[INFERENCE_GATEWAY_ENV.primaryProvider],
    DEFAULT_PRIMARY_PROVIDER,
  )
  const primaryModel = configuredValue(
    'primary model',
    env[INFERENCE_GATEWAY_ENV.primaryModel],
    DEFAULT_PRIMARY_MODEL,
  )
  const hermesProfile = optionalConfiguredValue(
    'Hermes profile',
    env[INFERENCE_GATEWAY_ENV.hermesProfile],
  )
  // The fallback is deliberately opt-in. Merely having OpenRouter credentials
  // in the environment never enables it and credentials are never read here.
  const fallbackModel = optionalConfiguredValue(
    'approved OpenRouter fallback model',
    env[INFERENCE_GATEWAY_ENV.openRouterFallbackModel],
  )
  const primary = Object.freeze({ provider: primaryProvider, model: primaryModel })
  const fallback = fallbackModel
    ? Object.freeze({ provider: OPENROUTER_PROVIDER, model: fallbackModel })
    : undefined
  if (fallback
    && fallback.provider === primary.provider
    && fallback.model === primary.model) {
    throw configurationError('Primary and fallback provider/model routes must differ')
  }

  const policies = workloadPolicies(env[INFERENCE_GATEWAY_ENV.workloadPoliciesJson])
  const deepProvider = env[INFERENCE_GATEWAY_ENV.deepProvider]?.trim() || undefined
  const deepModel = env[INFERENCE_GATEWAY_ENV.deepModel]?.trim() || undefined
  if ((deepProvider === undefined) !== (deepModel === undefined)) throw configurationError('Deep provider and model must be configured together')
  const deepPrimary = deepProvider && deepModel
    ? Object.freeze({ provider: safeValue('deep provider', deepProvider), model: safeValue('deep model', deepModel) }) : primary
  const routes = Object.fromEntries(CONFIGURED_INFERENCE_WORKLOADS.map((workload) => [
    workload,
    Object.freeze({ primary: workload === 'research.deep' ? deepPrimary : primary, ...(fallback && workload !== 'research.deep' ? { fallback } : {}), ...policies[workload] }),
  ])) as unknown as Record<ConfiguredInferenceWorkload, InferenceWorkloadRoute>

  return Object.freeze({
    ...(hermesProfile ? { hermesProfile } : {}),
    routes: Object.freeze(routes),
  })
}

export function inferenceGatewayStatus(
  configuration: InferenceGatewayConfiguration,
  investigateEnabled = false,
): InferenceGatewayStatusSnapshot {
  return Object.freeze({
    schemaVersion: 'myboon.inference_gateway_status.v1',
    hermesProfileConfigured: configuration.hermesProfile !== undefined,
    investigate: Object.freeze({ enabled: investigateEnabled, fallbackEnabled: false }),
    routes: Object.freeze(CONFIGURED_INFERENCE_WORKLOADS.map((workload) => {
      const route = configuration.routes[workload]
      return Object.freeze({
        workload,
        primary: Object.freeze({ ...route.primary }),
        fallback: workload !== 'research.deep' && route.fallback ? Object.freeze({ ...route.fallback }) : null,
        reasoningEffort: route.reasoningEffort!,
        maxConcurrency: route.maxConcurrency!,
        rateLimit: Object.freeze({ ...route.rateLimit! }),
      })
    })),
  })
}

export function createInferenceGatewayFromConfiguration(
  configuration: InferenceGatewayConfiguration,
  options: Omit<CreateConfiguredInferenceGatewayOptions, 'env'> = {},
): InferenceGateway {
  validateConfiguration(configuration)
  const service = options.serviceFactory?.() ?? new HermesService()
  const adapter = options.adapterFactory?.({
    service,
    profile: configuration.hermesProfile,
    estimateTokens: options.estimateTokens,
  }) ?? new HermesStructuredAdapter({
    service,
    profile: configuration.hermesProfile,
    estimateTokens: options.estimateTokens,
  })
  const gatewayOptions: InferenceGatewayOptions = {
    adapter,
    routes: configuration.routes,
    observer: options.observer,
    estimateTokens: options.estimateTokens,
    now: options.now,
  }
  return new InferenceGateway(gatewayOptions)
}

export function createConfiguredInferenceGateway(
  options: CreateConfiguredInferenceGatewayOptions = {},
): ConfiguredInferenceGatewayRuntime {
  const configuration = loadInferenceGatewayConfiguration(options.env)
  const gateway = createInferenceGatewayFromConfiguration(configuration, options)
  return Object.freeze({
    gateway, configuration,
    get status() { return inferenceGatewayStatus(configuration, gateway.investigationEnabled) },
  })
}

function validateConfiguration(configuration: InferenceGatewayConfiguration): void {
  if (configuration.hermesProfile !== undefined) safeValue('Hermes profile', configuration.hermesProfile)
  const configuredWorkloads = Object.keys(configuration.routes)
  for (const workload of configuredWorkloads) {
    if (!(CONFIGURED_INFERENCE_WORKLOADS as readonly string[]).includes(workload)) {
      throw configurationError(`Unknown configured inference workload ${workload}`)
    }
  }
  for (const workload of CONFIGURED_INFERENCE_WORKLOADS) {
    const route = configuration.routes[workload]
    if (!route) throw configurationError(`Missing route for workload ${workload}`)
    safeValue(`${workload} primary provider`, route.primary.provider)
    safeValue(`${workload} primary model`, route.primary.model)
    if (!route.fallback) continue
    safeValue(`${workload} fallback provider`, route.fallback.provider)
    safeValue(`${workload} fallback model`, route.fallback.model)
    if (route.fallback.provider !== OPENROUTER_PROVIDER) {
      throw configurationError(`Fallback provider for workload ${workload} must be ${OPENROUTER_PROVIDER}`)
    }
    if (route.primary.provider === route.fallback.provider
      && route.primary.model === route.fallback.model) {
      throw configurationError(`Primary and fallback routes must differ for workload ${workload}`)
    }
  }
  for (const workload of CONFIGURED_INFERENCE_WORKLOADS) validatePolicy(workload, configuration.routes[workload])
}

function workloadPolicies(raw: string | undefined): Record<ConfiguredInferenceWorkload, Pick<InferenceWorkloadRoute, 'reasoningEffort' | 'maxConcurrency' | 'rateLimit'>> {
  const defaults = Object.fromEntries(CONFIGURED_INFERENCE_WORKLOADS.map((workload) => [workload, {
    reasoningEffort: 'low' as const, maxConcurrency: 4, rateLimit: { maxCalls: 60, windowMs: 60_000 },
  }])) as Record<ConfiguredInferenceWorkload, Pick<InferenceWorkloadRoute, 'reasoningEffort' | 'maxConcurrency' | 'rateLimit'>>
  if (raw === undefined) return defaults
  let parsed: unknown
  try { parsed = JSON.parse(raw) } catch { throw configurationError('Workload policies must be valid JSON') }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw configurationError('Workload policies must be an object')
  for (const [workload, policy] of Object.entries(parsed as Record<string, unknown>)) {
    if (!(CONFIGURED_INFERENCE_WORKLOADS as readonly string[]).includes(workload)) throw configurationError(`Unknown workload policy ${workload}`)
    if (!policy || typeof policy !== 'object' || Array.isArray(policy)) throw configurationError(`Invalid workload policy ${workload}`)
    const value = policy as Record<string, unknown>
    const keys = Object.keys(value).sort()
    if (keys.join(',') !== 'maxConcurrency,rateLimit,reasoningEffort') throw configurationError(`Invalid workload policy keys for ${workload}`)
    const rate = value.rateLimit as Record<string, unknown>
    const route = {
      reasoningEffort: value.reasoningEffort as InferenceWorkloadRoute['reasoningEffort'],
      maxConcurrency: value.maxConcurrency as number,
      rateLimit: rate as unknown as { maxCalls: number, windowMs: number },
    }
    validatePolicy(workload, route)
    defaults[workload as ConfiguredInferenceWorkload] = route
  }
  return defaults
}

function validatePolicy(workload: string, route: Pick<InferenceWorkloadRoute, 'reasoningEffort' | 'maxConcurrency' | 'rateLimit'>): void {
  if (!route.reasoningEffort || !['low', 'medium', 'high'].includes(route.reasoningEffort)) throw configurationError(`Invalid reasoning effort for ${workload}`)
  if (!Number.isInteger(route.maxConcurrency) || route.maxConcurrency! <= 0 || route.maxConcurrency! > 1_000) throw configurationError(`Invalid maxConcurrency for ${workload}`)
  if (!route.rateLimit || !Number.isInteger(route.rateLimit.maxCalls) || route.rateLimit.maxCalls <= 0 || route.rateLimit.maxCalls > 1_000_000
    || !Number.isInteger(route.rateLimit.windowMs) || route.rateLimit.windowMs <= 0 || route.rateLimit.windowMs > 86_400_000) {
    throw configurationError(`Invalid rateLimit for ${workload}`)
  }
}

function configuredValue(name: string, value: string | undefined, fallback: string): string {
  return value === undefined ? fallback : safeValue(name, value)
}

function optionalConfiguredValue(name: string, value: string | undefined): string | undefined {
  return value === undefined ? undefined : safeValue(name, value)
}

function safeValue(name: string, value: string): string {
  if (value.length > MAX_CONFIG_VALUE_CHARS
    || !/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(value)) {
    throw configurationError(`${name} must be a non-empty safe value of at most ${MAX_CONFIG_VALUE_CHARS} characters`)
  }
  return value
}

function configurationError(message: string): InferenceGatewayError {
  return new InferenceGatewayError(message, {
    category: 'provider_unavailable',
    retryable: false,
  })
}
