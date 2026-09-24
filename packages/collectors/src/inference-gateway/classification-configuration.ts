import { resolve } from 'node:path'
import { HermesService } from '../hermes'
import { JevSystemOneAdapter, HermesDecisionAdapter } from './classification-adapters'
import { approvedClassificationDefinitions } from './classification-definitions'
import { ClassificationGateway } from './classification-gateway'
import {
  classificationLifecycleFromEnv,
  StaticClassificationRegistry,
  tightenLifecycleMode,
} from './classification-registry'
import { SqliteClassificationControlPlane, SqliteClassificationShadowWriter } from './classification-store'
import type {
  ClassificationDefinition,
  ClassificationLifecycleMode,
  JevClassificationAdapter,
} from './classification-types'
import { InferenceGatewayError } from './errors'

export const CLASSIFICATION_ENV = Object.freeze({
  lifecycleJson: 'CLASSIFICATION_LIFECYCLE_JSON',
  sqlitePath: 'CLASSIFICATION_SQLITE_PATH',
  jevToken: 'JEV_API_TOKEN',
  jevEndpoint: 'JEV_API_ENDPOINT',
  hermesProfile: 'INFERENCE_GATEWAY_HERMES_PROFILE',
  hermesProvider: 'INFERENCE_GATEWAY_PRIMARY_PROVIDER',
  hermesModel: 'INFERENCE_GATEWAY_PRIMARY_MODEL',
} as const)

const APPROVED_HERMES_ROUTES = new Set([
  'ollama-cloud/glm-5.3-flash',
  'ollama-cloud/deepseek-v4-flash',
  'ollama-cloud/deepseek-v4.1-flash',
])
const APPROVED_JEV_ENDPOINT = 'https://api.typesafe.ai/v1/systemone'

export interface ConfiguredClassificationRuntime {
  gateway: ClassificationGateway
  store: SqliteClassificationControlPlane
  close(): void
}

export function createConfiguredClassificationRuntime(options: {
  env?: Readonly<Record<string, string | undefined>>
  hermesService?: Pick<HermesService, 'oneshot'>
  jevAdapter?: JevClassificationAdapter
  now?: () => number
} = {}): ConfiguredClassificationRuntime {
  const env = options.env ?? process.env
  const modes = lifecycleModes(env[CLASSIFICATION_ENV.lifecycleJson])
  const hermesTarget = {
    provider: env[CLASSIFICATION_ENV.hermesProvider]?.trim() || 'ollama-cloud',
    model: env[CLASSIFICATION_ENV.hermesModel]?.trim() || 'deepseek-v4.1-flash',
  }
  if (!APPROVED_HERMES_ROUTES.has(`${hermesTarget.provider}/${hermesTarget.model}`)) {
    throw new Error(`Unapproved classification Hermes route ${hermesTarget.provider}/${hermesTarget.model}`)
  }
  const definitions = approvedClassificationDefinitions(hermesTarget)
  const known = new Set(definitions.map((item) => item.workload))
  for (const workload of modes.keys()) if (!known.has(workload)) throw new Error(`Unknown classification workload ${workload}`)
  for (const definition of definitions) {
    tightenLifecycleMode(
      definition.maximumLifecycleMode,
      modes.get(definition.workload),
      definition.defaultLifecycleMode,
    )
  }
  const configuredEndpoint = env[CLASSIFICATION_ENV.jevEndpoint]?.trim()
  if (configuredEndpoint && configuredEndpoint !== APPROVED_JEV_ENDPOINT) {
    throw new Error('JEV_API_ENDPOINT must be the approved TypeSafe System One endpoint')
  }
  const sqlitePath = resolve(env[CLASSIFICATION_ENV.sqlitePath]?.trim() || '.data/classification.sqlite')
  const store = new SqliteClassificationControlPlane(sqlitePath, { now: options.now })
  // Live requests never enqueue through the control connection's 5-second
  // busy timeout. This separate handoff connection fails immediately on lock
  // contention and the gateway emits a bounded warning without delaying Hermes.
  const shadowWriter = new SqliteClassificationShadowWriter(sqlitePath, { now: options.now })
  const jev = options.jevAdapter ?? (env[CLASSIFICATION_ENV.jevToken]?.trim()
    ? new JevSystemOneAdapter({
      apiToken: env[CLASSIFICATION_ENV.jevToken]!,
      endpoint: configuredEndpoint,
    })
    : new MissingJevAdapter())
  const gateway = new ClassificationGateway({
    registry: new StaticClassificationRegistry(definitions),
    jev,
    hermes: new HermesDecisionAdapter({
      service: options.hermesService ?? new HermesService(),
      profile: env[CLASSIFICATION_ENV.hermesProfile]?.trim() || undefined,
    }),
    capacity: store,
    audit: store,
    shadowOutbox: shadowWriter,
    lifecycleMode: (definition) => modes.get(definition.workload),
    now: options.now,
  })
  return { gateway, store, close: () => { shadowWriter.close(); store.close() } }
}

export function configuredClassificationModes(
  env: Readonly<Record<string, string | undefined>> = process.env,
): ReadonlyMap<string, ClassificationLifecycleMode> {
  return lifecycleModes(env[CLASSIFICATION_ENV.lifecycleJson])
}

function lifecycleModes(raw: string | undefined): Map<string, ClassificationLifecycleMode> {
  if (raw === undefined || raw.trim() === '') return new Map()
  let parsed: unknown
  try { parsed = JSON.parse(raw) } catch { throw new Error('CLASSIFICATION_LIFECYCLE_JSON must be valid JSON') }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('CLASSIFICATION_LIFECYCLE_JSON must be an object')
  }
  return new Map(Object.entries(parsed as Record<string, unknown>).map(([workload, value]) => {
    if (typeof value !== 'string') throw new Error(`Classification lifecycle for ${workload} must be text`)
    return [workload, classificationLifecycleFromEnv(value)!]
  }))
}

class MissingJevAdapter implements JevClassificationAdapter {
  async classify(request: Parameters<JevClassificationAdapter['classify']>[0]): Promise<never> {
    throw new InferenceGatewayError('JEV_API_TOKEN is not configured', {
      category: 'provider_authentication', retryable: false,
      provider: request.target.provider, model: request.target.model,
    })
  }
}

export function classificationModeForDefinition(
  definition: ClassificationDefinition,
  env: Readonly<Record<string, string | undefined>> = process.env,
): ClassificationLifecycleMode | undefined {
  return lifecycleModes(env[CLASSIFICATION_ENV.lifecycleJson]).get(definition.workload)
}
