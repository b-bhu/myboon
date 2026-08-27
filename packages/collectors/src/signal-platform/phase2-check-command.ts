import { basename, isAbsolute, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { realpathSync } from 'node:fs'

import {
  INFERENCE_GATEWAY_ENV,
  loadInferenceGatewayConfiguration,
} from '../inference-gateway/configuration'
import { assertPhase1CutoverPolicy } from './phase1-cutover'
import {
  evaluatePhase2Readiness,
  type Phase2DatabaseProbe,
  type Phase2DatabaseProbeSource,
  type Phase2ReadinessReport,
} from './phase2-readiness'
import { parseControlPlaneAlertPolicy } from './control-plane'
import { loadFeedV3RuntimeConfig } from './runtime-config'
import { readFeedV3RuntimeStatusAvailability } from './runtime-status'
import { readSqliteControlPlaneStatus } from './status-sqlite-composition'

interface ReadOnlySqliteDatabase {
  prepare(sql: string): { get(): unknown }
  close(): void
}

const nodeRequire = createRequire(__filename)
const { DatabaseSync } = nodeRequire('node:sqlite') as {
  DatabaseSync: new (
    path: string,
    options: { readOnly: true; open: true },
  ) => ReadOnlySqliteDatabase
}

export const PHASE2_CHECK_MODE_FLAG = '--mode' as const
export const PHASE2_CHECK_COST_FLAG = '--max-cost-usd-micros-per-packet' as const

export interface Phase2CheckArguments {
  mode: 'preflight' | 'runtime'
  maxCostUsdMicrosPerCompletedPacket?: number
}

export class Phase2CheckArgumentError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'Phase2CheckArgumentError'
  }
}

export interface Phase2CheckPorts {
  probeDatabase?: (
    path: string,
    source: Phase2DatabaseProbeSource,
  ) => Promise<Phase2DatabaseProbe> | Phase2DatabaseProbe
  readControlPlane?: typeof readSqliteControlPlaneStatus
  readRuntime?: typeof readFeedV3RuntimeStatusAvailability
  now?: () => Date
}

export interface RunPhase2CheckInput {
  args: readonly string[]
  env: Readonly<Record<string, string | undefined>>
  packageDirectory?: string
}

export function parsePhase2CheckArguments(args: readonly string[]): Phase2CheckArguments {
  const normalized = args[0] === '--' ? args.slice(1) : args
  let mode: Phase2CheckArguments['mode'] | undefined
  let maxCost: number | undefined
  const seen = new Set<string>()

  for (let index = 0; index < normalized.length; index += 2) {
    const flag = normalized[index]
    const value = normalized[index + 1]
    if (value === undefined || value.startsWith('--')) {
      throw new Phase2CheckArgumentError(`missing value for ${flag ?? 'argument'}`)
    }
    if (flag !== PHASE2_CHECK_MODE_FLAG && flag !== PHASE2_CHECK_COST_FLAG) {
      throw new Phase2CheckArgumentError(`unknown argument: ${flag}`)
    }
    if (seen.has(flag)) throw new Phase2CheckArgumentError(`duplicate argument: ${flag}`)
    seen.add(flag)

    if (flag === PHASE2_CHECK_MODE_FLAG) {
      if (value !== 'preflight' && value !== 'runtime') {
        throw new Phase2CheckArgumentError('mode must be preflight or runtime')
      }
      mode = value
    } else {
      const parsed = Number(value)
      if (!Number.isSafeInteger(parsed) || parsed <= 0) {
        throw new Phase2CheckArgumentError('cost ceiling must be a positive integer')
      }
      maxCost = parsed
    }
  }

  if (!mode) throw new Phase2CheckArgumentError('--mode is required')
  if (mode === 'runtime' && maxCost === undefined) {
    throw new Phase2CheckArgumentError(`${PHASE2_CHECK_COST_FLAG} is required in runtime mode`)
  }
  if (mode === 'preflight' && maxCost !== undefined) {
    throw new Phase2CheckArgumentError(`${PHASE2_CHECK_COST_FLAG} is only valid in runtime mode`)
  }
  return { mode, ...(maxCost === undefined ? {} : { maxCostUsdMicrosPerCompletedPacket: maxCost }) }
}

/**
 * Compose the strict Phase 2 report using read-only ports only. The Phase 1
 * policy is checked before any filesystem or SQLite dependency is opened.
 */
export async function runPhase2Check(
  input: RunPhase2CheckInput,
  ports: Phase2CheckPorts = {},
): Promise<Phase2ReadinessReport> {
  const parsed = parsePhase2CheckArguments(input.args)
  const generatedAt = (ports.now?.() ?? new Date()).toISOString()
  const config = loadFeedV3RuntimeConfig(input.env)
  const packageDirectory = resolve(input.packageDirectory ?? resolve(__dirname, '..', '..'))
  const newsPath = databasePath(input.env.NEWS_SQLITE_PATH, '.data/news.sqlite', packageDirectory)
  const pipelinePath = databasePath(input.env.PIPELINE_SQLITE_PATH, '.data/pipeline.sqlite', packageDirectory)
  const databasePathsDistinct = canonicalPathIdentity(newsPath) !== canonicalPathIdentity(pipelinePath)
  const gateway = loadInferenceGatewayConfiguration(input.env)
  const researchRoute = gateway.routes['research.synthesis']
  const entityRoute = gateway.routes['entity.extract']
  const explicitRoute = nonBlank(input.env[INFERENCE_GATEWAY_ENV.primaryProvider])
    && nonBlank(input.env[INFERENCE_GATEWAY_ENV.primaryModel])
  const routeMatches = researchRoute.primary.provider === entityRoute.primary.provider
    && researchRoute.primary.model === entityRoute.primary.model
  const route = {
    provider: routeMatches ? researchRoute.primary.provider : '',
    model: routeMatches ? researchRoute.primary.model : '',
    explicit: explicitRoute,
    fallbackConfigured: researchRoute.fallback !== undefined || entityRoute.fallback !== undefined,
  }
  const credentials = {
    tokensApiKeyPresent: nonBlank(input.env.TOKENS_API_KEY),
    supabaseUrlPresent: nonBlank(input.env.SUPABASE_URL),
    supabaseServiceRoleKeyPresent: nonBlank(input.env.SUPABASE_SERVICE_ROLE_KEY),
  }

  let policyReady = true
  try {
    assertPhase1CutoverPolicy(config, 'research')
    assertPhase1CutoverPolicy(config, 'entity')
  } catch {
    policyReady = false
  }

  const unavailable = (source: Phase2DatabaseProbeSource): Phase2DatabaseProbe => ({
    source,
    basename: source === 'news' ? basename(newsPath) : basename(pipelinePath),
    available: false,
    integrity: 'failed',
    code: 'policy_blocked',
  })

  if (!policyReady || !databasePathsDistinct) return evaluatePhase2Readiness({
    mode: parsed.mode,
    generatedAt,
    config,
    databaseProbes: { news: unavailable('news'), polymarket: unavailable('polymarket') },
    databasePathsDistinct,
    route,
    credentials,
    controlPlane: null,
    runtime: null,
    maxCostUsdMicrosPerCompletedPacket: parsed.maxCostUsdMicrosPerCompletedPacket,
  })

  const probe = ports.probeDatabase ?? probeSqliteDatabaseReadOnly
  const [newsProbe, polymarketProbe, runtime] = await Promise.all([
    Promise.resolve(probe(newsPath, 'news')),
    Promise.resolve(probe(pipelinePath, 'polymarket')),
    readRuntimeAvailability(input.env, packageDirectory, ports.readRuntime),
  ])

  let controlPlane = null
  if (parsed.mode === 'runtime') {
    const policy = input.env.FEED_V3_STATUS_ALERT_POLICY_JSON?.trim()
      ? parseControlPlaneAlertPolicy(JSON.parse(input.env.FEED_V3_STATUS_ALERT_POLICY_JSON))
      : null
    try {
      controlPlane = await (ports.readControlPlane ?? readSqliteControlPlaneStatus)({
        newsPath,
        pipelinePath,
        now: generatedAt,
        alertPolicy: policy,
        activityWindowMs: positiveInteger(
          input.env.FEED_V3_STATUS_ACTIVITY_WINDOW_MS,
          30 * 60_000,
          'activity window',
        ),
      })
    } catch {
      controlPlane = null
    }
  }

  return evaluatePhase2Readiness({
    mode: parsed.mode,
    generatedAt,
    config,
    databaseProbes: { news: newsProbe, polymarket: polymarketProbe },
    databasePathsDistinct,
    route,
    credentials,
    controlPlane,
    runtime,
    maxCostUsdMicrosPerCompletedPacket: parsed.maxCostUsdMicrosPerCompletedPacket,
  })
}

/** Opens an existing SQLite file read-only and performs a bounded integrity check. */
export function probeSqliteDatabaseReadOnly(
  path: string,
  source: Phase2DatabaseProbeSource,
): Phase2DatabaseProbe {
  let database: ReadOnlySqliteDatabase | null = null
  try {
    database = new DatabaseSync(path, { readOnly: true, open: true })
    const row = database.prepare('PRAGMA quick_check').get() as Record<string, unknown> | undefined
    const integrity = row && Object.values(row)[0] === 'ok' ? 'ok' : 'failed'
    return {
      source,
      basename: basename(path).slice(0, 120),
      available: true,
      integrity,
      ...(integrity === 'ok' ? {} : { code: 'integrity_failed' }),
    }
  } catch {
    return {
      source,
      basename: basename(path).slice(0, 120),
      available: false,
      integrity: 'failed',
      code: 'unavailable',
    }
  } finally {
    database?.close()
  }
}

async function readRuntimeAvailability(
  env: Readonly<Record<string, string | undefined>>,
  packageDirectory: string,
  reader: typeof readFeedV3RuntimeStatusAvailability = readFeedV3RuntimeStatusAvailability,
) {
  try {
    return await reader({
      researchPath: databasePath(
        env.FEED_V3_RESEARCH_RUNTIME_STATUS_PATH,
        '.data/feed-v3-research-runtime-status.json',
        packageDirectory,
      ),
      researchStaleAfterMs: positiveInteger(
        env.FEED_V3_RESEARCH_RUNTIME_STATUS_STALE_MS,
        60_000,
        'research runtime stale threshold',
      ),
      entityPath: databasePath(
        env.FEED_V3_ENTITY_RUNTIME_STATUS_PATH,
        '.data/feed-v3-entity-runtime-status.json',
        packageDirectory,
      ),
      entityStaleAfterMs: positiveInteger(
        env.FEED_V3_ENTITY_RUNTIME_STATUS_STALE_MS,
        60_000,
        'entity runtime stale threshold',
      ),
    })
  } catch {
    return null
  }
}

function databasePath(value: string | undefined, fallback: string, packageDirectory: string): string {
  const configured = value?.trim() || fallback
  return isAbsolute(configured) ? resolve(configured) : resolve(packageDirectory, configured)
}

function canonicalPathIdentity(path: string): string {
  try { return realpathSync.native(path) } catch { return resolve(path) }
}

function nonBlank(value: string | undefined): boolean {
  return typeof value === 'string' && value.trim().length > 0
}

function positiveInteger(raw: string | undefined, fallback: number, label: string): number {
  if (raw === undefined) return fallback
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${label} must be a positive integer`)
  return value
}
