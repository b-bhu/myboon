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
] as const

export type ConfiguredInferenceWorkload = typeof CONFIGURED_INFERENCE_WORKLOADS[number]

export const INFERENCE_GATEWAY_ENV = Object.freeze({
  hermesProfile: 'INFERENCE_GATEWAY_HERMES_PROFILE',
  primaryProvider: 'INFERENCE_GATEWAY_PRIMARY_PROVIDER',
  primaryModel: 'INFERENCE_GATEWAY_PRIMARY_MODEL',
  openRouterFallbackModel: 'INFERENCE_GATEWAY_OPENROUTER_FALLBACK_MODEL',
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
}

export interface InferenceGatewayStatusSnapshot {
  schemaVersion: 'myboon.inference_gateway_status.v1'
  hermesProfileConfigured: boolean
  investigate: Readonly<{ enabled: false, fallbackEnabled: false }>
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
  status: InferenceGatewayStatusSnapshot
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

  const routes = Object.fromEntries(CONFIGURED_INFERENCE_WORKLOADS.map((workload) => [
    workload,
    Object.freeze({ primary, ...(fallback ? { fallback } : {}) }),
  ])) as unknown as Record<ConfiguredInferenceWorkload, InferenceWorkloadRoute>

  return Object.freeze({
    ...(hermesProfile ? { hermesProfile } : {}),
    routes: Object.freeze(routes),
  })
}

export function inferenceGatewayStatus(
  configuration: InferenceGatewayConfiguration,
): InferenceGatewayStatusSnapshot {
  return Object.freeze({
    schemaVersion: 'myboon.inference_gateway_status.v1',
    hermesProfileConfigured: configuration.hermesProfile !== undefined,
    investigate: Object.freeze({ enabled: false, fallbackEnabled: false }),
    routes: Object.freeze(CONFIGURED_INFERENCE_WORKLOADS.map((workload) => {
      const route = configuration.routes[workload]
      return Object.freeze({
        workload,
        primary: Object.freeze({ ...route.primary }),
        fallback: route.fallback ? Object.freeze({ ...route.fallback }) : null,
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
  return Object.freeze({
    gateway: createInferenceGatewayFromConfiguration(configuration, options),
    configuration,
    status: inferenceGatewayStatus(configuration),
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
