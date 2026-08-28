import assert from 'node:assert/strict'
import test from 'node:test'

import type { SignalPlatformControlPlaneStatus, SourceControlPlaneStatus } from './control-plane'
import type { FeedV3RuntimeStatusAvailability } from './runtime-status'
import type {
  FeedV3RuntimeConfig,
  FeedV3Source,
  FeedV3WorkerMode,
} from './runtime-config'
import {
  PHASE2_READINESS_CHECK_CODES,
  evaluatePhase2Readiness,
  type Phase2DatabaseProbe,
  type Phase2DatabaseProbeSource,
  type Phase2ReadinessCheckCode,
  type Phase2ReadinessInput,
} from './phase2-readiness'

const NOW = '2026-08-27T12:00:00.000Z'

function setOf(...sources: FeedV3Source[]): Set<FeedV3Source> {
  return new Set(sources)
}

function baseConfig(): FeedV3RuntimeConfig {
  return Object.freeze({
    intakeMode: 'off',
    researchMode: 'active',
    entityMode: 'active',
    activeSources: setOf('news', 'polymarket'),
    shadowSources: setOf(),
    intakeActiveSources: setOf(),
    intakeShadowSources: setOf(),
    researchActiveSources: setOf('news', 'polymarket'),
    researchShadowSources: setOf(),
    entityActiveSources: setOf('news', 'polymarket'),
    entityShadowSources: setOf(),
    legacyResearchDisabledSources: setOf('news', 'polymarket'),
    legacyEntityDisabledSources: setOf('news', 'polymarket'),
    shadowSampleBasisPoints: 0,
    deepResearchEnabled: false,
    triageClassifierEnabled: false,
    triageProviderHealth: 'healthy',
    triageAllowedDepths: new Set<FeedV3RuntimeConfig['triageAllowedDepths'] extends ReadonlySet<infer D> ? D : never>(['light']),
    cutoverReceiptPath: null,
    cutoverPolicy: 'phase1',
  })
}

function config(overrides: Partial<FeedV3RuntimeConfig> = {}): FeedV3RuntimeConfig {
  return { ...baseConfig(), ...overrides }
}

function dbProbe(source: Phase2DatabaseProbeSource, basename = `${source}.db`): Phase2DatabaseProbe {
  return { source, basename, available: true, integrity: 'ok' }
}

function probes(overrides: Partial<Phase2ReadinessInput['databaseProbes']> = {}): Phase2ReadinessInput['databaseProbes'] {
  return {
    news: dbProbe('news'),
    polymarket: dbProbe('polymarket'),
    ...overrides,
  }
}

function route(overrides: Partial<Phase2ReadinessInput['route']> = {}): Phase2ReadinessInput['route'] {
  return {
    provider: 'ollama-cloud',
    model: 'deepseek-v4-flash',
    explicit: true,
    fallbackConfigured: false,
    ...overrides,
  }
}

function credentials(overrides: Partial<Phase2ReadinessInput['credentials']> = {}): Phase2ReadinessInput['credentials'] {
  return {
    tokensApiKeyPresent: true,
    supabaseUrlPresent: true,
    supabaseServiceRoleKeyPresent: true,
    ...overrides,
  }
}

function researchSnapshot(): NonNullable<FeedV3RuntimeStatusAvailability['researchRuntime'] extends infer T ? (T extends { snapshot: infer S } ? NonNullable<S> : never) : never> {
  return {
    schemaVersion: 'myboon.shared_research_runtime_snapshot.v1',
    capturedAt: NOW,
    processId: 1234,
    lifecycleState: 'running',
    runtime: {
      schemaVersion: 'myboon.shared_research_runtime_status.v1',
      mode: 'active',
      sources: ['news', 'polymarket'],
      supportedDepths: ['light'],
      priorityPools: [
        { name: 'urgent', priorities: ['P0', 'P1'] },
        { name: 'background', priorities: ['P2', 'P3'] },
      ],
      sourceFairness: { maxConsecutiveClaimsPerSource: 1 },
      standardSearch: {
        schemaVersion: 'myboon.standard_search_status.v1',
        enabled: false,
        connectorId: null,
        policyVersion: null,
      },
      gateway: {
        schemaVersion: 'myboon.inference_gateway_status.v1',
        hermesProfileConfigured: true,
        investigate: { enabled: false, fallbackEnabled: false },
        routes: [],
      },
      circuits: {
        schemaVersion: 'myboon.inference_circuit_status.v1',
        capturedAt: NOW,
        workloads: [],
      },
      circuitNextProbes: [],
      providerObservation: {
        lastCompletedAt: null, lastSucceededAt: null, workload: null, provider: null,
        model: null, succeeded: null, durationMs: null, providerCalls: 0, repairCalls: 0,
        failureCategory: null,
      },
      deepEnabled: false,
    },
    recovery: { lastRunAt: null, recoveredBySource: {} },
  }
}

function entitySnapshot(): NonNullable<FeedV3RuntimeStatusAvailability['entityRuntime'] extends infer T ? (T extends { snapshot: infer S } ? NonNullable<S> : never) : never> {
  return {
    schemaVersion: 'myboon.shared_entity_runtime_health.v1',
    capturedAt: NOW,
    processId: 1234,
    mode: 'active',
    lifecycleState: 'running',
    desiredState: 'running',
    controlStatus: 'ok',
    route: {
      workload: 'entity.extract',
      lastCompletedAt: null, lastSucceededAt: null, provider: null, model: null,
      succeeded: null, durationMs: null,
    },
    circuit: {
      capturedAt: NOW,
      workload: 'entity.extract',
      ready: true,
      targets: [],
    },
  }
}

function runtime(overrides: Partial<FeedV3RuntimeStatusAvailability> = {}): FeedV3RuntimeStatusAvailability {
  return {
    researchRuntime: { availability: 'current', snapshot: researchSnapshot() },
    entityRuntime: { availability: 'current', snapshot: entitySnapshot() },
    ...overrides,
  }
}

function sourceStatus(): SourceControlPlaneStatus {
  return {
    sourceType: 'news',
    availability: 'available',
    error: null,
    total: 0,
    byStatus: {},
    byStage: {
      triage: { total: 0, byStatus: {} },
      retrieval: { total: 0, byStatus: {} },
      deep: { total: 0, byStatus: {} },
      synthesis: { total: 0, byStatus: {} },
      entity: { total: 0, byStatus: {} },
      unassigned: { total: 0, byStatus: {} },
    },
    counts: { ready: 0, retry: 0, deadLetter: 0, expired: 0, leased: 0, unfinished: 0 },
    oldestReadyAt: null,
    oldestReadyAgeMs: null,
    oldestLeaseExpiresAt: null,
    oldestLeaseExpiresInMs: null,
    intake: {
      availability: 'available',
      signals: 0, observations: 0, deduplicatedObservations: 0,
      deduplicationRate: 0, triageDecisions: 0, admittedWorkItems: 0,
      triageOutcomes: {},
    },
    attempts: { availability: 'available', totalAttempts: 0, attemptedItems: 0, maxAttemptCount: 0 },
    recentFailures: [],
    activity: { windowStart: NOW, arrivals: 0, admissions: 0, completions: 0 },
    queueAge: [],
    deadLetters: { total: 0, oldestAt: null, oldestAgeMs: null, byFailureCategory: [] },
    artifacts: { researchPackets: 0, entityMemoryHandoffs: 0 },
    endToEndLatency: null,
    sqliteSize: null,
    sqliteStoreId: null,
    sqliteWriteErrors: { availability: 'available', value: 0, measuredCount: 0, reason: null },
  }
}

function controlPlane(overrides: Partial<SignalPlatformControlPlaneStatus> = {}): SignalPlatformControlPlaneStatus {
  const base = {
    schemaVersion: 'myboon.control_plane_status.v1' as const,
    generatedAt: NOW,
    availability: 'available' as const,
    errors: [],
    sources: { news: sourceStatus(), polymarket: sourceStatus() },
    execution: {
      availability: 'available' as const,
      error: null,
      perCompletedPacket: {
        executionTelemetryPackets: 10,
        canonicalPackets: 10,
        telemetryCoverageRate: 1,
        costUsdMicros: { availability: 'available', value: 500, measuredCount: 10, reason: null },
      },
    },
    alerts: { availability: 'available', reason: null, items: [] },
  }
  return { ...base, ...overrides } as unknown as SignalPlatformControlPlaneStatus
}

function baseInput(overrides: Partial<Phase2ReadinessInput> = {}): Phase2ReadinessInput {
  return {
    mode: 'preflight',
    generatedAt: NOW,
    config: config(),
    databaseProbes: probes(),
    databasePathsDistinct: true,
    route: route(),
    credentials: credentials(),
    controlPlane: null,
    runtime: null,
    ...overrides,
  }
}

function codes(checks: readonly { code: Phase2ReadinessCheckCode; status: string }[]): Record<Phase2ReadinessCheckCode, string> {
  const result = {} as Record<Phase2ReadinessCheckCode, string>
  for (const check of checks) result[check.code] = check.status
  return result
}

function withOpenResearchCircuit(): ReturnType<typeof researchSnapshot> {
  const snapshot = researchSnapshot()
  return {
    ...snapshot,
    runtime: {
      ...snapshot.runtime,
      circuits: {
        schemaVersion: 'myboon.inference_circuit_status.v1',
        capturedAt: NOW,
        workloads: [
          { workload: 'research.synthesis', ready: false, targets: [
            { provider: 'ollama-cloud', model: 'deepseek-v4-flash', circuitOpen: true, retryAfterMs: 1000 },
          ] },
        ],
      },
    },
  }
}

test('preflight happy path is ready with all checks passing', () => {
  const report = evaluatePhase2Readiness(baseInput({
    runtime: runtime(),
  }))
  assert.equal(report.schemaVersion, 'myboon.feed_v3_phase2_readiness.v1')
  assert.equal(report.mode, 'preflight')
  assert.equal(report.ready, true)
  const status = codes(report.checks)
  assert.equal(status.PHASE1_RESEARCH_POLICY, 'pass')
  assert.equal(status.PHASE1_ENTITY_POLICY, 'pass')
  assert.equal(status.PREFLIGHT_RESEARCH_SNAPSHOT, 'pass')
  assert.equal(status.PREFLIGHT_ENTITY_SNAPSHOT, 'pass')
  assert.ok(!report.checks.some((check) => check.status === 'block'))
})

test('preflight reports missing runtime snapshots as warnings only and stays ready', () => {
  const report = evaluatePhase2Readiness(baseInput({
    runtime: {
      researchRuntime: { availability: 'missing', snapshot: null },
      entityRuntime: { availability: 'missing', snapshot: null },
    },
  }))
  const status = codes(report.checks)
  assert.equal(status.PREFLIGHT_RESEARCH_SNAPSHOT, 'warn')
  assert.equal(status.PREFLIGHT_ENTITY_SNAPSHOT, 'warn')
  assert.equal(report.ready, true)
  assert.ok(!report.checks.some((check) => check.status === 'block'))
})

test('preflight stale runtime snapshot is a warning, never reported healthy', () => {
  const stale = runtime()
  stale.researchRuntime = { availability: 'stale', snapshot: researchSnapshot() }
  const report = evaluatePhase2Readiness(baseInput({ runtime: stale }))
  assert.equal(codes(report.checks).PREFLIGHT_RESEARCH_SNAPSHOT, 'warn')
  assert.equal(report.ready, true)
})

test('phase1 cutover policy failure blocks for research', () => {
  const report = evaluatePhase2Readiness(baseInput({
    config: config({ cutoverPolicy: 'full' }),
  }))
  assert.equal(codes(report.checks).PHASE1_RESEARCH_POLICY, 'block')
  assert.equal(report.ready, false)
})

test('phase1 cutover policy failure blocks for entity', () => {
  const report = evaluatePhase2Readiness(baseInput({
    config: config({
      legacyEntityDisabledSources: setOf('news'),
    }),
  }))
  assert.equal(codes(report.checks).PHASE1_ENTITY_POLICY, 'block')
  assert.equal(report.ready, false)
})

test('exact source mismatch blocks', () => {
  const report = evaluatePhase2Readiness(baseInput({
    config: config({ researchActiveSources: setOf('news') }),
  }))
  assert.equal(codes(report.checks).CONFIG_RESEARCH_SOURCES_EXACT, 'block')
  assert.equal(report.ready, false)
})

test('database probe failures block', () => {
  const report = evaluatePhase2Readiness(baseInput({
    databaseProbes: probes({
      news: { source: 'news', basename: 'news.db', available: false, integrity: 'ok' },
      polymarket: { source: 'polymarket', basename: 'poly.db', available: true, integrity: 'failed' },
    }),
  }))
  const status = codes(report.checks)
  assert.equal(status.DB_PROBE_AVAILABLE_NEWS, 'block')
  assert.equal(status.DB_INTEGRITY_POLYMARKET, 'block')
  assert.equal(report.ready, false)
})

test('identical resolved database paths block', () => {
  const report = evaluatePhase2Readiness(baseInput({
    databasePathsDistinct: false,
  }))
  assert.equal(codes(report.checks).DB_BASENAMES_DISTINCT, 'block')
  assert.equal(report.ready, false)
})

test('route provider/model and fallback failures block', () => {
  const report = evaluatePhase2Readiness(baseInput({
    route: route({ provider: 'other-provider', fallbackConfigured: true }),
  }))
  const status = codes(report.checks)
  assert.equal(status.ROUTE_PROVIDER_MODEL, 'block')
  assert.equal(status.ROUTE_FALLBACK, 'block')
  assert.equal(report.ready, false)
})

test('missing credential presence blocks', () => {
  const report = evaluatePhase2Readiness(baseInput({
    credentials: credentials({ supabaseServiceRoleKeyPresent: false }),
  }))
  assert.equal(codes(report.checks).CREDENTIALS_PRESENT, 'block')
  assert.equal(report.ready, false)
})

test('runtime happy path is ready', () => {
  const report = evaluatePhase2Readiness(baseInput({
    mode: 'runtime',
    controlPlane: controlPlane(),
    runtime: runtime(),
    maxCostUsdMicrosPerCompletedPacket: 1000,
  }))
  assert.equal(report.ready, true)
  assert.equal(codes(report.checks).CONTROL_PLANE_AVAILABILITY, 'pass')
  assert.equal(codes(report.checks).SOURCE_STATUS_NEWS, 'pass')
  assert.equal(codes(report.checks).SOURCE_STATUS_POLYMARKET, 'pass')
  assert.equal(codes(report.checks).ALERTS_CONFIGURED, 'pass')
  assert.equal(codes(report.checks).ALERT_ITEMS_NONE, 'pass')
  assert.equal(codes(report.checks).RESEARCH_SNAPSHOT_CURRENT, 'pass')
  assert.equal(codes(report.checks).ENTITY_SNAPSHOT_CURRENT, 'pass')
  assert.equal(codes(report.checks).COST_COVERAGE_AVAILABLE, 'pass')
  assert.equal(codes(report.checks).TELEMETRY_COVERAGE_RATE, 'pass')
  assert.equal(codes(report.checks).COST_WITHIN_CEILING, 'pass')
  assert.ok(!report.checks.some((check) => check.status === 'block'))
})

test('runtime stale or missing snapshots block', () => {
  const staleRuntime = runtime()
  staleRuntime.researchRuntime = { availability: 'stale', snapshot: researchSnapshot() }
  staleRuntime.entityRuntime = { availability: 'missing', snapshot: null }
  const report = evaluatePhase2Readiness(baseInput({
    mode: 'runtime',
    controlPlane: controlPlane(),
    runtime: staleRuntime,
    maxCostUsdMicrosPerCompletedPacket: 1000,
  }))
  const status = codes(report.checks)
  assert.equal(status.RESEARCH_SNAPSHOT_CURRENT, 'block')
  assert.equal(status.ENTITY_SNAPSHOT_CURRENT, 'block')
  assert.equal(report.ready, false)
})

test('runtime lifecycle/mode/source/circuit failures block', () => {
  const badResearch = researchSnapshot()
  badResearch.lifecycleState = 'draining'
  badResearch.runtime.mode = 'shadow'
  badResearch.runtime.sources = ['news']
  const badEntity = entitySnapshot()
  badEntity.desiredState = 'draining'
  badEntity.controlStatus = 'unavailable'
  const report = evaluatePhase2Readiness(baseInput({
    mode: 'runtime',
    controlPlane: controlPlane(),
    runtime: {
      researchRuntime: { availability: 'current', snapshot: badResearch },
      entityRuntime: { availability: 'current', snapshot: badEntity },
    },
    maxCostUsdMicrosPerCompletedPacket: 1000,
  }))
  const status = codes(report.checks)
  assert.equal(status.RESEARCH_LIFECYCLE_RUNNING, 'block')
  assert.equal(status.RESEARCH_MODE_ACTIVE, 'block')
  assert.equal(status.RESEARCH_SOURCES_EXACT, 'block')
  assert.equal(status.ENTITY_DESIRED_RUNNING, 'block')
  assert.equal(status.ENTITY_CONTROL_OK, 'block')
  assert.equal(report.ready, false)
})

test('runtime open circuit targets block for research and entity', () => {
  const openEntity = entitySnapshot()
  openEntity.circuit.targets = [
    { provider: 'ollama-cloud', model: 'deepseek-v4-flash', circuitOpen: true, nextProbeAt: null },
  ]
  const report = evaluatePhase2Readiness(baseInput({
    mode: 'runtime',
    controlPlane: controlPlane(),
    runtime: {
      researchRuntime: { availability: 'current', snapshot: withOpenResearchCircuit() },
      entityRuntime: { availability: 'current', snapshot: openEntity },
    },
    maxCostUsdMicrosPerCompletedPacket: 1000,
  }))
  const status = codes(report.checks)
  assert.equal(status.RESEARCH_CIRCUIT_CLOSED, 'block')
  assert.equal(status.ENTITY_CIRCUIT_CLOSED, 'block')
  assert.equal(report.ready, false)
})

test('runtime duplicate/extra active source in snapshot blocks', () => {
  const dupResearch = researchSnapshot()
  dupResearch.runtime.sources = ['news', 'polymarket', 'news']
  const report = evaluatePhase2Readiness(baseInput({
    mode: 'runtime',
    controlPlane: controlPlane(),
    runtime: { researchRuntime: { availability: 'current', snapshot: dupResearch }, entityRuntime: runtime().entityRuntime },
    maxCostUsdMicrosPerCompletedPacket: 1000,
  }))
  assert.equal(codes(report.checks).RESEARCH_SOURCES_EXACT, 'block')
  assert.equal(report.ready, false)
})

test('runtime missing or partial cost blocks', () => {
  const cp = controlPlane()
  cp.execution.perCompletedPacket.costUsdMicros = { availability: 'unavailable', value: null, measuredCount: 0, reason: 'nope' }
  const report = evaluatePhase2Readiness(baseInput({
    mode: 'runtime',
    controlPlane: cp,
    runtime: runtime(),
    maxCostUsdMicrosPerCompletedPacket: 1000,
  }))
  const status = codes(report.checks)
  assert.equal(status.COST_COVERAGE_AVAILABLE, 'block')
  assert.equal(report.ready, false)
})

test('runtime over-ceiling cost blocks', () => {
  const cp = controlPlane()
  cp.execution.perCompletedPacket.costUsdMicros = { availability: 'available', value: 2000, measuredCount: 10, reason: null }
  const report = evaluatePhase2Readiness(baseInput({
    mode: 'runtime',
    controlPlane: cp,
    runtime: runtime(),
    maxCostUsdMicrosPerCompletedPacket: 1000,
  }))
  const status = codes(report.checks)
  assert.equal(status.COST_COVERAGE_AVAILABLE, 'pass')
  assert.equal(status.COST_WITHIN_CEILING, 'block')
  assert.equal(report.ready, false)
})

test('runtime incomplete telemetry coverage rate blocks', () => {
  const cp = controlPlane()
  cp.execution.perCompletedPacket.telemetryCoverageRate = 0.5
  const report = evaluatePhase2Readiness(baseInput({
    mode: 'runtime',
    controlPlane: cp,
    runtime: runtime(),
    maxCostUsdMicrosPerCompletedPacket: 1000,
  }))
  assert.equal(codes(report.checks).TELEMETRY_COVERAGE_RATE, 'block')
  assert.equal(report.ready, false)
})

test('runtime missing alert policy blocks', () => {
  const cp = controlPlane()
  cp.alerts = { availability: 'unavailable', reason: 'not configured', items: [] }
  const report = evaluatePhase2Readiness(baseInput({
    mode: 'runtime',
    controlPlane: cp,
    runtime: runtime(),
    maxCostUsdMicrosPerCompletedPacket: 1000,
  }))
  assert.equal(codes(report.checks).ALERTS_CONFIGURED, 'block')
  assert.equal(report.ready, false)
})

test('runtime active alert items block', () => {
  const cp = controlPlane()
  cp.alerts = { availability: 'available', reason: null, items: [{
    code: 'QUEUE_AGE_SLO_EXCEEDED', sourceType: 'news', stage: 'triage', provider: null,
    queueAgeMs: 5000, message: 'queue age', suggestedCommand: 'cmd',
  }] }
  const report = evaluatePhase2Readiness(baseInput({
    mode: 'runtime',
    controlPlane: cp,
    runtime: runtime(),
    maxCostUsdMicrosPerCompletedPacket: 1000,
  }))
  const status = codes(report.checks)
  assert.equal(status.ALERTS_CONFIGURED, 'pass')
  assert.equal(status.ALERT_ITEMS_NONE, 'block')
  assert.equal(report.ready, false)
})

test('runtime source partial/corrupt status blocks', () => {
  const cp = controlPlane()
  const badNews = sourceStatus()
  badNews.availability = 'partial'
  cp.sources = { news: badNews as SignalPlatformControlPlaneStatus['sources']['news'], polymarket: cp.sources.polymarket }
  const report = evaluatePhase2Readiness(baseInput({
    mode: 'runtime',
    controlPlane: cp,
    runtime: runtime(),
    maxCostUsdMicrosPerCompletedPacket: 1000,
  }))
  const status = codes(report.checks)
  assert.equal(status.SOURCE_STATUS_NEWS, 'block')
  assert.equal(status.SOURCE_STATUS_POLYMARKET, 'pass')
  assert.equal(report.ready, false)
})

test('runtime dead letters and recent failures block', () => {
  const cp = controlPlane()
  const news = sourceStatus()
  news.deadLetters = { total: 3, oldestAt: NOW, oldestAgeMs: 100, byFailureCategory: [] }
  const poly = sourceStatus()
  poly.recentFailures = [{ category: 'provider_timeout', count: 1, lastOccurredAt: NOW }]
  cp.sources = { news: news as SignalPlatformControlPlaneStatus['sources']['news'], polymarket: poly as SignalPlatformControlPlaneStatus['sources']['polymarket'] }
  const report = evaluatePhase2Readiness(baseInput({
    mode: 'runtime',
    controlPlane: cp,
    runtime: runtime(),
    maxCostUsdMicrosPerCompletedPacket: 1000,
  }))
  const status = codes(report.checks)
  assert.equal(status.DEAD_LETTERS_NEWS, 'block')
  assert.equal(status.RECENT_FAILURES_POLYMARKET, 'block')
  assert.equal(report.ready, false)
})

test('runtime requires positive integer cost ceiling', () => {
  const report = evaluatePhase2Readiness(baseInput({
    mode: 'runtime',
    controlPlane: controlPlane(),
    runtime: runtime(),
    maxCostUsdMicrosPerCompletedPacket: 0,
  }))
  assert.equal(codes(report.checks).MAX_COST_CEILING, 'block')
  assert.equal(report.ready, false)
})

test('output is deterministic and redacted', () => {
  const input = baseInput({
    mode: 'runtime',
    controlPlane: controlPlane(),
    runtime: runtime(),
    maxCostUsdMicrosPerCompletedPacket: 1000,
  })
  const first = evaluatePhase2Readiness(input)
  const second = evaluatePhase2Readiness(input)
  assert.deepEqual(first, second)
  const serialized = JSON.stringify(first)
  for (const forbidden of ['/home', 'ollama-cloud', 'deepseek-v4-flash', '.db', 'sk-', 'secret', 'authorization']) {
    assert.ok(!serialized.includes(forbidden), `output leaked: ${forbidden}`)
  }
})
