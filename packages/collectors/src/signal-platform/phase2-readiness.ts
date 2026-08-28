import {
  assertPhase1CutoverPolicy,
} from './phase1-cutover'
import type {
  SignalPlatformControlPlaneStatus,
  SourceControlPlaneStatus,
} from './control-plane'
import type { FeedV3RuntimeStatusAvailability } from './runtime-status'
import type { FeedV3RuntimeConfig, FeedV3Source } from './runtime-config'

export const PHASE2_READINESS_SCHEMA_VERSION = 'myboon.feed_v3_phase2_readiness.v1' as const

export type Phase2ReadinessMode = 'preflight' | 'runtime'
export type Phase2ReadinessStatus = 'pass' | 'warn' | 'block'
export type Phase2DatabaseProbeSource = 'news' | 'polymarket'

/** Expected Phase 2 route facts. Values are checked verbatim and never surfaced in messages. */
export const PHASE2_EXPECTED_PROVIDER = 'ollama-cloud' as const
export const PHASE2_EXPECTED_MODEL = 'deepseek-v4-flash' as const
export const PHASE2_EXPECTED_SOURCES: readonly FeedV3Source[] = Object.freeze(['news', 'polymarket'])

export const PHASE2_READINESS_CHECK_CODES = Object.freeze({
  phase1ResearchPolicy: 'PHASE1_RESEARCH_POLICY',
  phase1EntityPolicy: 'PHASE1_ENTITY_POLICY',
  configResearchSourcesExact: 'CONFIG_RESEARCH_SOURCES_EXACT',
  configEntitySourcesExact: 'CONFIG_ENTITY_SOURCES_EXACT',
  dbProbeAvailableNews: 'DB_PROBE_AVAILABLE_NEWS',
  dbProbeAvailablePolymarket: 'DB_PROBE_AVAILABLE_POLYMARKET',
  dbIntegrityNews: 'DB_INTEGRITY_NEWS',
  dbIntegrityPolymarket: 'DB_INTEGRITY_POLYMARKET',
  dbBasenamesDistinct: 'DB_BASENAMES_DISTINCT',
  routeProviderModel: 'ROUTE_PROVIDER_MODEL',
  routeFallback: 'ROUTE_FALLBACK',
  credentialsPresent: 'CREDENTIALS_PRESENT',
  preflightResearchSnapshot: 'PREFLIGHT_RESEARCH_SNAPSHOT',
  preflightEntitySnapshot: 'PREFLIGHT_ENTITY_SNAPSHOT',
  maxCostCeiling: 'MAX_COST_CEILING',
  controlPlaneAvailability: 'CONTROL_PLANE_AVAILABILITY',
  sourceStatusNews: 'SOURCE_STATUS_NEWS',
  sourceStatusPolymarket: 'SOURCE_STATUS_POLYMARKET',
  alertsConfigured: 'ALERTS_CONFIGURED',
  alertItemsNone: 'ALERT_ITEMS_NONE',
  researchSnapshotCurrent: 'RESEARCH_SNAPSHOT_CURRENT',
  researchLifecycleRunning: 'RESEARCH_LIFECYCLE_RUNNING',
  researchModeActive: 'RESEARCH_MODE_ACTIVE',
  researchSourcesExact: 'RESEARCH_SOURCES_EXACT',
  researchCircuitClosed: 'RESEARCH_CIRCUIT_CLOSED',
  entitySnapshotCurrent: 'ENTITY_SNAPSHOT_CURRENT',
  entityModeActive: 'ENTITY_MODE_ACTIVE',
  entityLifecycleRunning: 'ENTITY_LIFECYCLE_RUNNING',
  entityDesiredRunning: 'ENTITY_DESIRED_RUNNING',
  entityControlOk: 'ENTITY_CONTROL_OK',
  entityCircuitClosed: 'ENTITY_CIRCUIT_CLOSED',
  deadLettersNews: 'DEAD_LETTERS_NEWS',
  deadLettersPolymarket: 'DEAD_LETTERS_POLYMARKET',
  recentFailuresNews: 'RECENT_FAILURES_NEWS',
  recentFailuresPolymarket: 'RECENT_FAILURES_POLYMARKET',
  costCoverageAvailable: 'COST_COVERAGE_AVAILABLE',
  telemetryCoverageRate: 'TELEMETRY_COVERAGE_RATE',
  costWithinCeiling: 'COST_WITHIN_CEILING',
} as const)

export type Phase2ReadinessCheckCode = typeof PHASE2_READINESS_CHECK_CODES[keyof typeof PHASE2_READINESS_CHECK_CODES]

export interface Phase2DatabaseProbe {
  source: Phase2DatabaseProbeSource
  /** Sanitized basename only. Never an absolute path. Never echoed in messages. */
  basename: string
  available: boolean
  integrity: 'ok' | 'failed'
  /** Optional bounded error code. Never the raw error text. */
  code?: string
}

export interface Phase2RouteFacts {
  provider: string
  model: string
  explicit: boolean
  fallbackConfigured: boolean
}

/** Credential presence booleans only. Values are never surfaced. */
export interface Phase2CredentialPresence {
  tokensApiKeyPresent: boolean
  supabaseUrlPresent: boolean
  supabaseServiceRoleKeyPresent: boolean
}

export interface Phase2ReadinessInput {
  mode: Phase2ReadinessMode
  generatedAt: string
  config: FeedV3RuntimeConfig
  databaseProbes: Readonly<Record<Phase2DatabaseProbeSource, Phase2DatabaseProbe>>
  /** Compared from resolved paths by the read-only CLI before paths are redacted. */
  databasePathsDistinct: boolean
  route: Phase2RouteFacts
  credentials: Phase2CredentialPresence
  controlPlane?: SignalPlatformControlPlaneStatus | null
  runtime?: FeedV3RuntimeStatusAvailability | null
  /** Required and must be a positive integer when mode is runtime. */
  maxCostUsdMicrosPerCompletedPacket?: number
}

export interface Phase2ReadinessCheck {
  code: Phase2ReadinessCheckCode
  status: Phase2ReadinessStatus
  message: string
}

export interface Phase2ReadinessReport {
  schemaVersion: typeof PHASE2_READINESS_SCHEMA_VERSION
  mode: Phase2ReadinessMode
  generatedAt: string
  ready: boolean
  checks: readonly Phase2ReadinessCheck[]
}

/**
 * Pure Phase 2 readiness evaluator. It accepts only already-materialized,
 * sanitized inputs and never touches the filesystem, environment, network,
 * SQLite, or process state. It reuses the existing Phase 1 cutover policy as a
 * fail-closed predicate for both research and entity.
 *
 * Every message is a bounded, generic string that never contains secrets,
 * absolute paths, raw errors, prompts, IDs, or environment names.
 */
export function evaluatePhase2Readiness(input: Phase2ReadinessInput): Phase2ReadinessReport {
  const mode = validateMode(input.mode)
  const checks: Phase2ReadinessCheck[] = []
  const add = (check: Phase2ReadinessCheck): void => { checks.push(check) }
  const pass = (code: Phase2ReadinessCheckCode, message: string): void => {
    add({ code, status: 'pass', message })
  }
  const warn = (code: Phase2ReadinessCheckCode, message: string): void => {
    add({ code, status: 'warn', message })
  }
  const block = (code: Phase2ReadinessCheckCode, message: string): void => {
    add({ code, status: 'block', message })
  }

  // --- Phase 1 cutover policy for both research and entity (both modes). ---
  assertCutover(add, input.config, 'research')
  assertCutover(add, input.config, 'entity')

  // --- Exact active sources for both stages (both modes). ---
  exactSources(add, 'CONFIG_RESEARCH_SOURCES_EXACT', input.config.researchActiveSources, 'research')
  exactSources(add, 'CONFIG_ENTITY_SOURCES_EXACT', input.config.entityActiveSources, 'entity')

  // --- Sanitized database probes (both modes). ---
  const newsProbe = input.databaseProbes?.news
  const polyProbe = input.databaseProbes?.polymarket
  if (!newsProbe || !polyProbe) {
    block('DB_PROBE_AVAILABLE_NEWS', 'database probe results are incomplete')
  } else {
    probeChecks(add, newsProbe)
    probeChecks(add, polyProbe)
    const newsBasename = newsProbe.basename?.trim()
    const polyBasename = polyProbe.basename?.trim()
    if (!newsBasename || !polyBasename || input.databasePathsDistinct !== true) {
      block('DB_BASENAMES_DISTINCT', 'database paths must be present and distinct')
    } else {
      pass('DB_BASENAMES_DISTINCT', 'database paths are distinct')
    }
  }

  // --- Route facts (both modes). ---
  const route = input.route
  if (!route || route.explicit !== true
    || route.provider !== PHASE2_EXPECTED_PROVIDER || route.model !== PHASE2_EXPECTED_MODEL) {
    block('ROUTE_PROVIDER_MODEL', 'inference route provider and model do not match the Phase 2 requirement')
  } else {
    pass('ROUTE_PROVIDER_MODEL', 'inference route provider and model are as required')
  }
  if (!route || route.fallbackConfigured !== false) {
    block('ROUTE_FALLBACK', 'inference fallback must be disabled')
  } else {
    pass('ROUTE_FALLBACK', 'inference fallback is disabled')
  }

  // --- Credential presence booleans (both modes). ---
  const credentials = input.credentials
  if (!credentials
    || credentials.tokensApiKeyPresent !== true
    || credentials.supabaseUrlPresent !== true
    || credentials.supabaseServiceRoleKeyPresent !== true) {
    block('CREDENTIALS_PRESENT', 'required credentials are not all present')
  } else {
    pass('CREDENTIALS_PRESENT', 'required credentials are present')
  }

  if (mode === 'preflight') {
    preflightRuntimeSnapshots(add, input.runtime)
  } else {
    runtimeChecks(add, input)
  }

  return {
    schemaVersion: PHASE2_READINESS_SCHEMA_VERSION,
    mode,
    generatedAt: input.generatedAt,
    ready: checks.every((check) => check.status !== 'block'),
    checks: Object.freeze(checks),
  }
}

function assertCutover(
  add: (check: Phase2ReadinessCheck) => void,
  config: FeedV3RuntimeConfig,
  stage: 'research' | 'entity',
): void {
  const code = stage === 'research'
    ? PHASE2_READINESS_CHECK_CODES.phase1ResearchPolicy
    : PHASE2_READINESS_CHECK_CODES.phase1EntityPolicy
  try {
    assertPhase1CutoverPolicy(config, stage)
    add({ code, status: 'pass', message: `Phase 1 cutover policy is satisfied for ${stage}` })
  } catch {
    add({ code, status: 'block', message: `Phase 1 cutover policy is not satisfied for ${stage}` })
  }
}

function exactSources(
  add: (check: Phase2ReadinessCheck) => void,
  code: Phase2ReadinessCheckCode,
  sources: ReadonlySet<FeedV3Source> | undefined,
  stage: string,
): void {
  const expected = new Set<string>(PHASE2_EXPECTED_SOURCES)
  const hasExact = !!sources && sources.size === expected.size && [...sources].every((source) => expected.has(source))
  if (hasExact) {
    add({ code, status: 'pass', message: `${stage} active sources are exactly news and polymarket` })
  } else {
    add({ code, status: 'block', message: `${stage} active sources must be exactly news and polymarket` })
  }
}

function probeChecks(
  add: (check: Phase2ReadinessCheck) => void,
  probe: Phase2DatabaseProbe,
): void {
  const label = probe.source
  const availableCode = probe.source === 'news'
    ? PHASE2_READINESS_CHECK_CODES.dbProbeAvailableNews
    : PHASE2_READINESS_CHECK_CODES.dbProbeAvailablePolymarket
  const integrityCode = probe.source === 'news'
    ? PHASE2_READINESS_CHECK_CODES.dbIntegrityNews
    : PHASE2_READINESS_CHECK_CODES.dbIntegrityPolymarket
  if (probe.available !== true) {
    add({ code: availableCode, status: 'block', message: `${label} database probe is unavailable` })
  } else {
    add({ code: availableCode, status: 'pass', message: `${label} database probe is available` })
  }
  if (probe.integrity !== 'ok') {
    add({ code: integrityCode, status: 'block', message: `${label} database integrity is not ok` })
  } else {
    add({ code: integrityCode, status: 'pass', message: `${label} database integrity is ok` })
  }
}

function preflightRuntimeSnapshots(
  add: (check: Phase2ReadinessCheck) => void,
  runtime: FeedV3RuntimeStatusAvailability | null | undefined,
): void {
  const research = runtime?.researchRuntime
  const researchOk = research?.availability === 'current' && research.snapshot !== null
  add({
    code: PHASE2_READINESS_CHECK_CODES.preflightResearchSnapshot,
    status: researchOk ? 'pass' : 'warn',
    message: researchOk
      ? 'research runtime snapshot is present'
      : 'research runtime snapshot is missing or stale',
  })
  const entity = runtime?.entityRuntime
  const entityOk = entity?.availability === 'current' && entity.snapshot !== null
  add({
    code: PHASE2_READINESS_CHECK_CODES.preflightEntitySnapshot,
    status: entityOk ? 'pass' : 'warn',
    message: entityOk
      ? 'entity runtime snapshot is present'
      : 'entity runtime snapshot is missing or stale',
  })
}

function runtimeChecks(
  add: (check: Phase2ReadinessCheck) => void,
  input: Phase2ReadinessInput,
): void {
  const maxCost = input.maxCostUsdMicrosPerCompletedPacket
  const hasValidCeiling = Number.isSafeInteger(maxCost) && (maxCost as number) > 0
  if (!hasValidCeiling) {
    add({
      code: PHASE2_READINESS_CHECK_CODES.maxCostCeiling,
      status: 'block',
      message: 'a positive integer cost ceiling is required in runtime mode',
    })
  }

  const controlPlane = input.controlPlane ?? null
  if (!controlPlane) {
    add({
      code: PHASE2_READINESS_CHECK_CODES.controlPlaneAvailability,
      status: 'block',
      message: 'control-plane status is missing',
    })
  } else {
    if (controlPlane.availability !== 'available') {
      add({
        code: PHASE2_READINESS_CHECK_CODES.controlPlaneAvailability,
        status: 'block',
        message: 'control-plane is not available',
      })
    } else {
      add({
        code: PHASE2_READINESS_CHECK_CODES.controlPlaneAvailability,
        status: 'pass',
        message: 'control-plane is available',
      })
    }
    sourceRuntimeChecks(add, controlPlane, 'news')
    sourceRuntimeChecks(add, controlPlane, 'polymarket')
    alertRuntimeChecks(add, controlPlane)
    costRuntimeChecks(add, controlPlane, hasValidCeiling ? (maxCost as number) : null)
  }

  const runtime = input.runtime ?? null
  researchSnapshotChecks(add, runtime)
  entitySnapshotChecks(add, runtime)
}

function sourceRuntimeChecks(
  add: (check: Phase2ReadinessCheck) => void,
  controlPlane: SignalPlatformControlPlaneStatus,
  source: Phase2DatabaseProbeSource,
): void {
  const availabilityCode = source === 'news'
    ? PHASE2_READINESS_CHECK_CODES.sourceStatusNews
    : PHASE2_READINESS_CHECK_CODES.sourceStatusPolymarket
  const deadLettersCode = source === 'news'
    ? PHASE2_READINESS_CHECK_CODES.deadLettersNews
    : PHASE2_READINESS_CHECK_CODES.deadLettersPolymarket
  const recentFailuresCode = source === 'news'
    ? PHASE2_READINESS_CHECK_CODES.recentFailuresNews
    : PHASE2_READINESS_CHECK_CODES.recentFailuresPolymarket

  const status: SourceControlPlaneStatus | undefined = controlPlane.sources?.[source]
  if (!status || status.availability !== 'available') {
    add({ code: availabilityCode, status: 'block', message: `${source} source status is not available` })
  } else {
    add({ code: availabilityCode, status: 'pass', message: `${source} source status is available` })
    const deadLettersZero = status.deadLetters?.total === 0
    add({
      code: deadLettersCode,
      status: deadLettersZero ? 'pass' : 'block',
      message: deadLettersZero ? `${source} has zero dead letters` : `${source} has dead letters`,
    })
    const recentFailuresNone = Array.isArray(status.recentFailures) && status.recentFailures.length === 0
    add({
      code: recentFailuresCode,
      status: recentFailuresNone ? 'pass' : 'block',
      message: recentFailuresNone ? `${source} has no recent failures` : `${source} has recent failures`,
    })
  }
}

function alertRuntimeChecks(
  add: (check: Phase2ReadinessCheck) => void,
  controlPlane: SignalPlatformControlPlaneStatus,
): void {
  const alerts = controlPlane.alerts
  if (!alerts || alerts.availability !== 'available') {
    add({
      code: PHASE2_READINESS_CHECK_CODES.alertsConfigured,
      status: 'block',
      message: 'control-plane alert policy is not configured',
    })
  } else {
    add({
      code: PHASE2_READINESS_CHECK_CODES.alertsConfigured,
      status: 'pass',
      message: 'control-plane alert policy is configured',
    })
    const noItems = Array.isArray(alerts.items) && alerts.items.length === 0
    add({
      code: PHASE2_READINESS_CHECK_CODES.alertItemsNone,
      status: noItems ? 'pass' : 'block',
      message: noItems ? 'no control-plane alerts are active' : 'control-plane alerts are active',
    })
  }
}

function costRuntimeChecks(
  add: (check: Phase2ReadinessCheck) => void,
  controlPlane: SignalPlatformControlPlaneStatus,
  ceiling: number | null,
): void {
  const coverage = controlPlane.execution?.perCompletedPacket?.costUsdMicros
  const value = coverage?.value ?? null
  const coverageAvailable = coverage?.availability === 'available'
    && value !== null
    && Number.isFinite(value)
    && value >= 0
  if (!coverageAvailable) {
    add({
      code: PHASE2_READINESS_CHECK_CODES.costCoverageAvailable,
      status: 'block',
      message: 'per-packet cost coverage is not available',
    })
  } else {
    add({
      code: PHASE2_READINESS_CHECK_CODES.costCoverageAvailable,
      status: 'pass',
      message: 'per-packet cost coverage is available',
    })
  }
  const rate = controlPlane.execution?.perCompletedPacket?.telemetryCoverageRate
  if (rate !== 1) {
    add({
      code: PHASE2_READINESS_CHECK_CODES.telemetryCoverageRate,
      status: 'block',
      message: 'per-packet telemetry coverage rate is not complete',
    })
  } else {
    add({
      code: PHASE2_READINESS_CHECK_CODES.telemetryCoverageRate,
      status: 'pass',
      message: 'per-packet telemetry coverage rate is complete',
    })
  }
  if (ceiling !== null && coverageAvailable && (value as number) <= ceiling) {
    add({
      code: PHASE2_READINESS_CHECK_CODES.costWithinCeiling,
      status: 'pass',
      message: 'per-packet cost is within the ceiling',
    })
  } else if (ceiling !== null) {
    add({
      code: PHASE2_READINESS_CHECK_CODES.costWithinCeiling,
      status: 'block',
      message: 'per-packet cost exceeds the ceiling or is not measurable',
    })
  }
}

function researchSnapshotChecks(
  add: (check: Phase2ReadinessCheck) => void,
  runtime: FeedV3RuntimeStatusAvailability | null | undefined,
): void {
  const research = runtime?.researchRuntime
  const current = research?.availability === 'current' && research.snapshot !== null
  if (!current) {
    add({
      code: PHASE2_READINESS_CHECK_CODES.researchSnapshotCurrent,
      status: 'block',
      message: 'research runtime snapshot is missing, stale, or invalid',
    })
    return
  }
  add({
    code: PHASE2_READINESS_CHECK_CODES.researchSnapshotCurrent,
    status: 'pass',
    message: 'research runtime snapshot is current',
  })
  const snapshot = research.snapshot
  const lifecycleRunning = snapshot.lifecycleState === 'running'
  add({
    code: PHASE2_READINESS_CHECK_CODES.researchLifecycleRunning,
    status: lifecycleRunning ? 'pass' : 'block',
    message: lifecycleRunning ? 'research lifecycle is running' : 'research lifecycle is not running',
  })
  const modeActive = snapshot.runtime?.mode === 'active'
  add({
    code: PHASE2_READINESS_CHECK_CODES.researchModeActive,
    status: modeActive ? 'pass' : 'block',
    message: modeActive ? 'research runtime mode is active' : 'research runtime mode is not active',
  })
  const sources = snapshot.runtime?.sources ?? []
  const expected = new Set<string>(PHASE2_EXPECTED_SOURCES)
  const exact = sources.length === expected.size
    && new Set(sources).size === sources.length
    && sources.every((source) => expected.has(source))
  add({
    code: PHASE2_READINESS_CHECK_CODES.researchSourcesExact,
    status: exact ? 'pass' : 'block',
    message: exact
      ? 'research runtime sources are exactly news and polymarket'
      : 'research runtime sources must be exactly news and polymarket',
  })
  const circuits = snapshot.runtime?.circuits?.workloads ?? []
  const open = circuits.some((workload) => (workload?.targets ?? []).some((target) => target?.circuitOpen === true))
  add({
    code: PHASE2_READINESS_CHECK_CODES.researchCircuitClosed,
    status: open ? 'block' : 'pass',
    message: open ? 'a research circuit target is open' : 'no research circuit target is open',
  })
}

function entitySnapshotChecks(
  add: (check: Phase2ReadinessCheck) => void,
  runtime: FeedV3RuntimeStatusAvailability | null | undefined,
): void {
  const entity = runtime?.entityRuntime
  const current = entity?.availability === 'current' && entity.snapshot !== null
  if (!current) {
    add({
      code: PHASE2_READINESS_CHECK_CODES.entitySnapshotCurrent,
      status: 'block',
      message: 'entity runtime snapshot is missing, stale, or invalid',
    })
    return
  }
  add({
    code: PHASE2_READINESS_CHECK_CODES.entitySnapshotCurrent,
    status: 'pass',
    message: 'entity runtime snapshot is current',
  })
  const snapshot = entity.snapshot
  const modeActive = snapshot.mode === 'active'
  add({
    code: PHASE2_READINESS_CHECK_CODES.entityModeActive,
    status: modeActive ? 'pass' : 'block',
    message: modeActive ? 'entity runtime mode is active' : 'entity runtime mode is not active',
  })
  const lifecycleRunning = snapshot.lifecycleState === 'running'
  add({
    code: PHASE2_READINESS_CHECK_CODES.entityLifecycleRunning,
    status: lifecycleRunning ? 'pass' : 'block',
    message: lifecycleRunning ? 'entity lifecycle is running' : 'entity lifecycle is not running',
  })
  const desiredRunning = snapshot.desiredState === 'running'
  add({
    code: PHASE2_READINESS_CHECK_CODES.entityDesiredRunning,
    status: desiredRunning ? 'pass' : 'block',
    message: desiredRunning ? 'entity desired state is running' : 'entity desired state is not running',
  })
  const controlOk = snapshot.controlStatus === 'ok'
  add({
    code: PHASE2_READINESS_CHECK_CODES.entityControlOk,
    status: controlOk ? 'pass' : 'block',
    message: controlOk ? 'entity control status is ok' : 'entity control status is not ok',
  })
  const targets = snapshot.circuit?.targets ?? []
  const open = targets.some((target) => target?.circuitOpen === true)
  add({
    code: PHASE2_READINESS_CHECK_CODES.entityCircuitClosed,
    status: open ? 'block' : 'pass',
    message: open ? 'an entity circuit target is open' : 'no entity circuit target is open',
  })
}

function validateMode(value: string): Phase2ReadinessMode {
  if (value === 'preflight' || value === 'runtime') return value
  throw new TypeError(`Unsupported Phase 2 readiness mode: ${String(value)}`)
}
