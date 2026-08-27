import { readFileSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'
import { redactControlPlaneValue } from './control-plane-format'
import type { FailureCategory, PriorityClass, ResearchDepth, Signal } from './contracts'
import type { CutoverStage } from './cutover-receipt'

export const ROLLBACK_REHEARSAL_SCHEMA_VERSION = 'myboon.feed_v3_rollback_rehearsal.v1' as const
export const LIVE_SOAK_EVIDENCE_SCHEMA_VERSION = 'myboon.feed_v3_live_soak_evidence.v1' as const
export const PROVIDER_OUTAGE_EVIDENCE_SCHEMA_VERSION = 'myboon.feed_v3_provider_outage_rehearsal.v1' as const

export interface RollbackRehearsalEvidenceV1 {
  schemaVersion: typeof ROLLBACK_REHEARSAL_SCHEMA_VERSION
  artifactId: string
  rehearsedAt: string
  sourceType: Signal['sourceType']
  stage: CutoverStage
  inputSnapshotSha256: string
  outputSnapshotSha256: string
  elapsedMs: number
  maximumRollbackMs: number
  before: { canonicalOwnerActive: boolean; legacyOwnerActive: boolean; queueRows: number; leasedRows: number }
  after: { canonicalOwnerActive: boolean; legacyOwnerActive: boolean; queueRows: number; leasedRows: number }
  queueIntegrityVerified: boolean
  manualSqlRepairs: number
  passed: boolean
  failures: string[]
}

export interface LiveSoakEvidenceV1 {
  schemaVersion: typeof LIVE_SOAK_EVIDENCE_SCHEMA_VERSION
  artifactId: string
  startedAt: string
  finishedAt: string
  durationMs: number
  sourceTypes: Signal['sourceType'][]
  inputSnapshotSha256: string
  statusSamplesSha256: string
  pm2SnapshotSha256: string
  processes: Array<{
    processNameSha256: string; restartDelta: number; uptimeMs: number
    onlineAtEnd: boolean; expectedOnline: boolean
  }>
  queueFreshness: Array<{
    sourceType: Signal['sourceType']; priorityClass: PriorityClass; researchDepth: ResearchDepth
    sampleCount: number; p50Ms: number; p95Ms: number; p99Ms: number; oldestMs: number
  }>
  typedFailures: Array<{ category: FailureCategory; count: number }>
  providers: Array<{
    sourceType: Signal['sourceType']; stage: 'research' | 'entity'; provider: string
    terminalCalls: number; succeededCalls: number; p95LatencyMs: number
  }>
  circuits: Array<{
    sourceType: Signal['sourceType']; stage: 'research' | 'entity'; provider: string
    state: 'closed' | 'open' | 'half_open'; nextProbeAt: string | null
  }>
  sqlite: Array<{
    database: 'news' | 'pipeline'; mainBytesStart: number; mainBytesEnd: number
    walBytesStart: number; walBytesEnd: number; shmBytesStart: number; shmBytesEnd: number
    writeErrorsDelta: number
  }>
  orphanAudit: {
    artifactSha256: string; passed: boolean; suspectedOrphans: number
    unregisteredArtifacts: number; incomplete: boolean
  }
  handoffs: {
    admitted: number; researchPackets: number; entityWorkCompletions: number
    entityMemoryRows: number; deadLetters: number
    latencySampleCount: number; p50Ms: number; p95Ms: number; p99Ms: number
  }
  manualSqlRepairs: number
  boundedState: {
    hermesSessionsStart: number; hermesSessionsEnd: number
    temporaryArtifactsStart: number; temporaryArtifactsEnd: number
  }
  thresholds: {
    maximumRestartDelta: number; maximumQueueP95Ms: number; minimumProviderSuccessRate: number
    maximumProviderP95LatencyMs: number; maximumSqliteGrowthBytes: number
    minimumMemoryHandoffRate: number; maximumDeadLetterRate: number; maximumBoundedStateGrowth: number
  }
  passed: boolean
  failures: string[]
}

export interface ProviderOutageRehearsalEvidenceV1 {
  schemaVersion: typeof PROVIDER_OUTAGE_EVIDENCE_SCHEMA_VERSION
  artifactId: string
  sourceType: Signal['sourceType']
  stage: 'research' | 'entity'
  failureCategory: Extract<FailureCategory, 'provider_timeout' | 'provider_rate_limited' | 'provider_unavailable'>
  startedAt: string
  circuitOpenedAt: string
  probeAllowedAt: string
  recoveredAt: string
  finishedAt: string
  configuredCooldownMs: number
  cohortSha256: string
  statusSamplesSha256: string
  traceSamplesSha256: string
  cohortSize: number
  duringOpen: {
    pendingItems: number
    claimedItems: number
    terminalFailures: number
    attemptDelta: number
    providerCalls: number
  }
  probe: { calls: number; succeeded: boolean }
  afterRecovery: {
    pendingItems: number
    retryingItems: number
    completedItems: number
    deadLetterItems: number
    duplicateArtifacts: number
    terminalOutageFailures: number
  }
  manualSqlRepairs: number
  passed: boolean
  failures: string[]
}

export type OperationalEvidence = RollbackRehearsalEvidenceV1 | LiveSoakEvidenceV1 | ProviderOutageRehearsalEvidenceV1

export function validateRollbackRehearsalEvidence(value: unknown): RollbackRehearsalEvidenceV1 {
  const record = object(value)
  literal(record.schemaVersion, ROLLBACK_REHEARSAL_SCHEMA_VERSION, 'schemaVersion')
  const result: RollbackRehearsalEvidenceV1 = {
    schemaVersion: ROLLBACK_REHEARSAL_SCHEMA_VERSION,
    artifactId: text(record.artifactId, 'artifactId'),
    rehearsedAt: timestamp(record.rehearsedAt, 'rehearsedAt'),
    sourceType: source(record.sourceType),
    stage: stage(record.stage),
    inputSnapshotSha256: digest(record.inputSnapshotSha256, 'inputSnapshotSha256'),
    outputSnapshotSha256: digest(record.outputSnapshotSha256, 'outputSnapshotSha256'),
    elapsedMs: integer(record.elapsedMs, 'elapsedMs'),
    maximumRollbackMs: positiveInteger(record.maximumRollbackMs, 'maximumRollbackMs'),
    before: ownership(record.before, 'before'),
    after: ownership(record.after, 'after'),
    queueIntegrityVerified: bool(record.queueIntegrityVerified, 'queueIntegrityVerified'),
    manualSqlRepairs: integer(record.manualSqlRepairs, 'manualSqlRepairs'),
    passed: bool(record.passed, 'passed'),
    failures: strings(record.failures, 'failures'),
  }
  const derivedFailures = [
    ...(result.elapsedMs > result.maximumRollbackMs ? ['rollback exceeded maximum duration'] : []),
    ...(result.before.canonicalOwnerActive !== true || result.before.legacyOwnerActive !== false
      ? ['pre-rollback ownership snapshot is invalid'] : []),
    ...(result.after.canonicalOwnerActive !== false || result.after.legacyOwnerActive !== true
      ? ['post-rollback ownership snapshot is invalid'] : []),
    ...(result.before.queueRows !== result.after.queueRows ? ['queue row count changed during rollback'] : []),
    ...(result.after.leasedRows !== 0 ? ['leased work remains after rollback'] : []),
    ...(!result.queueIntegrityVerified ? ['queue integrity was not verified'] : []),
    ...(result.manualSqlRepairs !== 0 ? ['manual SQL repairs were required'] : []),
  ]
  assertTruthfulPass(result.passed, result.failures, derivedFailures)
  return result
}

export function validateLiveSoakEvidence(value: unknown): LiveSoakEvidenceV1 {
  const record = object(value)
  literal(record.schemaVersion, LIVE_SOAK_EVIDENCE_SCHEMA_VERSION, 'schemaVersion')
  const startedAt = timestamp(record.startedAt, 'startedAt')
  const finishedAt = timestamp(record.finishedAt, 'finishedAt')
  const result: LiveSoakEvidenceV1 = {
    schemaVersion: LIVE_SOAK_EVIDENCE_SCHEMA_VERSION,
    artifactId: text(record.artifactId, 'artifactId'),
    startedAt,
    finishedAt,
    durationMs: positiveInteger(record.durationMs, 'durationMs'),
    sourceTypes: sources(record.sourceTypes),
    inputSnapshotSha256: digest(record.inputSnapshotSha256, 'inputSnapshotSha256'),
    statusSamplesSha256: digest(record.statusSamplesSha256, 'statusSamplesSha256'),
    pm2SnapshotSha256: digest(record.pm2SnapshotSha256, 'pm2SnapshotSha256'),
    processes: processEvidence(record.processes),
    queueFreshness: queueEvidence(record.queueFreshness),
    typedFailures: typedFailures(record.typedFailures),
    providers: providers(record.providers),
    circuits: circuits(record.circuits),
    sqlite: sqliteEvidence(record.sqlite),
    orphanAudit: orphanEvidence(record.orphanAudit),
    handoffs: handoffEvidence(record.handoffs),
    manualSqlRepairs: integer(record.manualSqlRepairs, 'manualSqlRepairs'),
    boundedState: boundedStateEvidence(record.boundedState),
    thresholds: soakThresholds(record.thresholds),
    passed: bool(record.passed, 'passed'),
    failures: strings(record.failures, 'failures'),
  }
  if (Date.parse(finishedAt) - Date.parse(startedAt) !== result.durationMs) {
    throw new Error('durationMs must exactly match startedAt/finishedAt')
  }
  if (!result.processes.some((process) => process.expectedOnline)) {
    throw new Error('processes must include at least one expected-online process')
  }
  if (!result.sourceTypes.every((sourceType) => result.queueFreshness.some((row) => row.sourceType === sourceType))) {
    throw new Error('queueFreshness must cover every sourceType')
  }
  if (result.providers.some((row) => row.succeededCalls > row.terminalCalls)) {
    throw new Error('provider succeededCalls cannot exceed terminalCalls')
  }
  if (result.handoffs.entityWorkCompletions > result.handoffs.researchPackets
    || result.handoffs.researchPackets > result.handoffs.admitted) {
    throw new Error('handoff counts must be monotonically bounded by admissions')
  }
  if (result.handoffs.entityMemoryRows < result.handoffs.entityWorkCompletions) {
    throw new Error('entityMemoryRows cannot be below successful entity work completions')
  }
  if (!(result.handoffs.p50Ms <= result.handoffs.p95Ms && result.handoffs.p95Ms <= result.handoffs.p99Ms)) {
    throw new Error('handoff latency percentiles must be ordered')
  }
  const handoffRate = result.handoffs.admitted === 0 ? 0
    : result.handoffs.entityWorkCompletions / result.handoffs.admitted
  const deadLetterRate = result.handoffs.admitted === 0 ? (result.handoffs.deadLetters === 0 ? 0 : 1)
    : result.handoffs.deadLetters / result.handoffs.admitted
  const sqliteGrowth = result.sqlite.reduce((sum, item) => sum
    + Math.max(0, item.mainBytesEnd - item.mainBytesStart)
    + Math.max(0, item.walBytesEnd - item.walBytesStart)
    + Math.max(0, item.shmBytesEnd - item.shmBytesStart), 0)
  const boundedGrowth = Math.max(
    0, result.boundedState.hermesSessionsEnd - result.boundedState.hermesSessionsStart,
  ) + Math.max(
    0, result.boundedState.temporaryArtifactsEnd - result.boundedState.temporaryArtifactsStart,
  )
  const derivedFailures = [
    ...(result.durationMs < 24 * 60 * 60_000 ? ['duration is less than 24 hours'] : []),
    ...(result.processes.some((item) => item.expectedOnline && !item.onlineAtEnd)
      ? ['expected PM2 process was not online at end'] : []),
    ...(result.processes.some((item) => item.restartDelta > result.thresholds.maximumRestartDelta)
      ? ['PM2 restart delta exceeded threshold'] : []),
    ...(result.queueFreshness.some((item) => item.p95Ms > result.thresholds.maximumQueueP95Ms)
      ? ['queue p95 freshness exceeded threshold'] : []),
    ...(!hasStageCoverage(result.sourceTypes, result.providers) ? ['provider source/stage coverage is incomplete'] : []),
    ...(!hasStageCoverage(result.sourceTypes, result.circuits) ? ['circuit source/stage coverage is incomplete'] : []),
    ...(result.providers.some((item) => item.terminalCalls === 0
      || item.succeededCalls / item.terminalCalls < result.thresholds.minimumProviderSuccessRate)
      ? ['provider success rate was below threshold'] : []),
    ...(result.providers.some((item) => item.p95LatencyMs > result.thresholds.maximumProviderP95LatencyMs)
      ? ['provider p95 latency exceeded threshold'] : []),
    ...(result.circuits.some((item) => item.state !== 'closed') ? ['provider circuit remained non-closed'] : []),
    ...(result.sqlite.some((item) => item.writeErrorsDelta > 0) ? ['SQLite write errors were observed'] : []),
    ...(sqliteGrowth > result.thresholds.maximumSqliteGrowthBytes ? ['SQLite growth exceeded threshold'] : []),
    ...(!result.orphanAudit.passed || result.orphanAudit.incomplete
      || result.orphanAudit.suspectedOrphans > 0 || result.orphanAudit.unregisteredArtifacts > 0
      ? ['orphan audit did not pass cleanly'] : []),
    ...(handoffRate < result.thresholds.minimumMemoryHandoffRate ? ['memory handoff rate was below threshold'] : []),
    ...(deadLetterRate > result.thresholds.maximumDeadLetterRate ? ['dead-letter rate exceeded threshold'] : []),
    ...(result.manualSqlRepairs > 0 ? ['manual SQL repairs were required'] : []),
    ...(boundedGrowth > result.thresholds.maximumBoundedStateGrowth ? ['bounded state growth exceeded threshold'] : []),
  ]
  assertTruthfulPass(result.passed, result.failures, derivedFailures)
  return result
}

export function validateProviderOutageRehearsalEvidence(value: unknown): ProviderOutageRehearsalEvidenceV1 {
  const record = object(value)
  literal(record.schemaVersion, PROVIDER_OUTAGE_EVIDENCE_SCHEMA_VERSION, 'schemaVersion')
  const during = object(record.duringOpen)
  const probe = object(record.probe)
  const after = object(record.afterRecovery)
  const result: ProviderOutageRehearsalEvidenceV1 = {
    schemaVersion: PROVIDER_OUTAGE_EVIDENCE_SCHEMA_VERSION,
    artifactId: text(record.artifactId, 'artifactId'),
    sourceType: source(record.sourceType),
    stage: outageStage(record.stage),
    failureCategory: outageCategory(record.failureCategory),
    startedAt: timestamp(record.startedAt, 'startedAt'),
    circuitOpenedAt: timestamp(record.circuitOpenedAt, 'circuitOpenedAt'),
    probeAllowedAt: timestamp(record.probeAllowedAt, 'probeAllowedAt'),
    recoveredAt: timestamp(record.recoveredAt, 'recoveredAt'),
    finishedAt: timestamp(record.finishedAt, 'finishedAt'),
    configuredCooldownMs: positiveInteger(record.configuredCooldownMs, 'configuredCooldownMs'),
    cohortSha256: digest(record.cohortSha256, 'cohortSha256'),
    statusSamplesSha256: digest(record.statusSamplesSha256, 'statusSamplesSha256'),
    traceSamplesSha256: digest(record.traceSamplesSha256, 'traceSamplesSha256'),
    cohortSize: positiveInteger(record.cohortSize, 'cohortSize'),
    duringOpen: {
      pendingItems: integer(during.pendingItems, 'duringOpen.pendingItems'),
      claimedItems: integer(during.claimedItems, 'duringOpen.claimedItems'),
      terminalFailures: integer(during.terminalFailures, 'duringOpen.terminalFailures'),
      attemptDelta: integer(during.attemptDelta, 'duringOpen.attemptDelta'),
      providerCalls: integer(during.providerCalls, 'duringOpen.providerCalls'),
    },
    probe: {
      calls: integer(probe.calls, 'probe.calls'),
      succeeded: bool(probe.succeeded, 'probe.succeeded'),
    },
    afterRecovery: {
      pendingItems: integer(after.pendingItems, 'afterRecovery.pendingItems'),
      retryingItems: integer(after.retryingItems, 'afterRecovery.retryingItems'),
      completedItems: integer(after.completedItems, 'afterRecovery.completedItems'),
      deadLetterItems: integer(after.deadLetterItems, 'afterRecovery.deadLetterItems'),
      duplicateArtifacts: integer(after.duplicateArtifacts, 'afterRecovery.duplicateArtifacts'),
      terminalOutageFailures: integer(after.terminalOutageFailures, 'afterRecovery.terminalOutageFailures'),
    },
    manualSqlRepairs: integer(record.manualSqlRepairs, 'manualSqlRepairs'),
    passed: bool(record.passed, 'passed'),
    failures: strings(record.failures, 'failures'),
  }
  const start = Date.parse(result.startedAt)
  const opened = Date.parse(result.circuitOpenedAt)
  const probeAt = Date.parse(result.probeAllowedAt)
  const recovered = Date.parse(result.recoveredAt)
  const finished = Date.parse(result.finishedAt)
  if (!(start <= opened && opened <= probeAt && probeAt <= recovered && recovered <= finished)) {
    throw new Error('provider outage timestamps must be ordered')
  }
  if (probeAt - opened < result.configuredCooldownMs) {
    throw new Error('probeAllowedAt precedes the configured circuit cooldown')
  }
  const afterCount = result.afterRecovery.pendingItems + result.afterRecovery.retryingItems
    + result.afterRecovery.completedItems + result.afterRecovery.deadLetterItems
  const derivedFailures = [
    ...(result.configuredCooldownMs < 10 * 60_000 || result.configuredCooldownMs > 15 * 60_000
      ? ['configured cooldown is outside the reviewed 10-15 minute range'] : []),
    ...(result.duringOpen.pendingItems !== result.cohortSize ? ['outage cohort was not fully pending while open'] : []),
    ...(result.duringOpen.claimedItems !== 0 ? ['work was claimed while the provider circuit was open'] : []),
    ...(result.duringOpen.terminalFailures !== 0 ? ['terminal failures were created while the circuit was open'] : []),
    ...(result.duringOpen.attemptDelta !== 0 ? ['attempt counters changed while the circuit was open'] : []),
    ...(result.duringOpen.providerCalls !== 0 ? ['provider calls occurred while the circuit was open'] : []),
    ...(result.probe.calls !== 1 ? ['half-open recovery did not allow exactly one probe'] : []),
    ...(!result.probe.succeeded ? ['half-open recovery probe did not succeed'] : []),
    ...(afterCount !== result.cohortSize ? ['post-recovery cohort cardinality changed'] : []),
    ...(result.afterRecovery.completedItems === 0 ? ['no cohort work completed after recovery'] : []),
    ...(result.afterRecovery.duplicateArtifacts !== 0 ? ['recovery created duplicate artifacts'] : []),
    ...(result.afterRecovery.terminalOutageFailures !== 0 ? ['outage produced terminal cohort failures'] : []),
    ...(result.manualSqlRepairs !== 0 ? ['manual SQL repairs were required'] : []),
  ]
  assertTruthfulPass(result.passed, result.failures, derivedFailures)
  return result
}

export function readOperationalEvidence(input: {
  kind: 'rollback' | 'live-soak' | 'provider-outage'
  inputPath: string
}): OperationalEvidence {
  if (!isAbsolute(input.inputPath)) throw new Error('--input must be an absolute path')
  const value = JSON.parse(readFileSync(resolve(input.inputPath), 'utf8')) as unknown
  if (input.kind === 'rollback') return validateRollbackRehearsalEvidence(value)
  if (input.kind === 'live-soak') return validateLiveSoakEvidence(value)
  return validateProviderOutageRehearsalEvidence(value)
}

export function formatOperationalEvidenceJson(value: OperationalEvidence): string {
  return JSON.stringify(redactControlPlaneValue(value), null, 2)
}

function assertTruthfulPass(passed: boolean, declared: string[], derived: string[]): void {
  if (passed && (declared.length > 0 || derived.length > 0)) {
    throw new Error(`Evidence cannot pass: ${[...declared, ...derived].join('; ')}`)
  }
  if (!passed && declared.length === 0 && derived.length === 0) {
    throw new Error('Failed evidence must declare or derive at least one failure')
  }
}

function outageStage(value: unknown): ProviderOutageRehearsalEvidenceV1['stage'] {
  if (value !== 'research' && value !== 'entity') throw new Error('stage must be research or entity')
  return value
}
function outageCategory(value: unknown): ProviderOutageRehearsalEvidenceV1['failureCategory'] {
  if (value !== 'provider_timeout' && value !== 'provider_rate_limited' && value !== 'provider_unavailable') {
    throw new Error('failureCategory must be a retryable provider outage category')
  }
  return value
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('evidence must be an object')
  return value as Record<string, unknown>
}
function literal(value: unknown, expected: string, field: string): void {
  if (value !== expected) throw new Error(`${field} must be ${expected}`)
}
function text(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${field} must be non-empty`)
  return value.trim()
}
function timestamp(value: unknown, field: string): string {
  const result = text(value, field)
  if (!Number.isFinite(Date.parse(result))) throw new Error(`${field} must be a timestamp`)
  return result
}
function integer(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw new Error(`${field} must be a non-negative safe integer`)
  return Number(value)
}
function positiveInteger(value: unknown, field: string): number {
  const result = integer(value, field)
  if (result === 0) throw new Error(`${field} must be positive`)
  return result
}
function bool(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`${field} must be boolean`)
  return value
}
function strings(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || !item.trim())) {
    throw new Error(`${field} must be an array of non-empty strings`)
  }
  return value.map((item) => String(item).trim())
}
function sources(value: unknown): Signal['sourceType'][] {
  const allowed = new Set<Signal['sourceType']>(['news', 'polymarket', 'market_calendar', 'x'])
  if (!Array.isArray(value) || value.length === 0 || value.some((item) => !allowed.has(item as Signal['sourceType']))) {
    throw new Error('sourceTypes must contain known sources')
  }
  return [...new Set(value as Signal['sourceType'][])]
}
function unit(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`${field} must be between 0 and 1`)
  }
  return value
}

function digest(value: unknown, field: string): string {
  const result = text(value, field)
  if (!/^[a-f0-9]{64}$/.test(result)) throw new Error(`${field} must be lowercase SHA-256`)
  return result
}
function source(value: unknown): Signal['sourceType'] {
  return sources([value])[0]!
}
function stage(value: unknown): CutoverStage {
  if (value !== 'research' && value !== 'entity') throw new Error('stage must be research or entity')
  return value
}
function ownership(value: unknown, field: string): RollbackRehearsalEvidenceV1['before'] {
  const row = object(value)
  return {
    canonicalOwnerActive: bool(row.canonicalOwnerActive, `${field}.canonicalOwnerActive`),
    legacyOwnerActive: bool(row.legacyOwnerActive, `${field}.legacyOwnerActive`),
    queueRows: integer(row.queueRows, `${field}.queueRows`),
    leasedRows: integer(row.leasedRows, `${field}.leasedRows`),
  }
}
function processEvidence(value: unknown): LiveSoakEvidenceV1['processes'] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 100) throw new Error('processes must contain 1-100 rows')
  const result = value.map((item, index) => {
    const row = object(item)
    return {
      processNameSha256: digest(row.processNameSha256, `processes[${index}].processNameSha256`),
      restartDelta: integer(row.restartDelta, `processes[${index}].restartDelta`),
      uptimeMs: integer(row.uptimeMs, `processes[${index}].uptimeMs`),
      onlineAtEnd: bool(row.onlineAtEnd, `processes[${index}].onlineAtEnd`),
      expectedOnline: bool(row.expectedOnline, `processes[${index}].expectedOnline`),
    }
  })
  if (new Set(result.map((item) => item.processNameSha256)).size !== result.length) {
    throw new Error('processes contain duplicate name hashes')
  }
  return result
}
function queueEvidence(value: unknown): LiveSoakEvidenceV1['queueFreshness'] {
  if (!Array.isArray(value) || value.length === 0) throw new Error('queueFreshness must be non-empty')
  return value.map((item, index) => {
    const row = object(item)
    const priorityClass = row.priorityClass
    const researchDepth = row.researchDepth
    if (!['P0', 'P1', 'P2', 'P3'].includes(String(priorityClass))) throw new Error(`queueFreshness[${index}].priorityClass is invalid`)
    if (!['light', 'standard', 'deep'].includes(String(researchDepth))) throw new Error(`queueFreshness[${index}].researchDepth is invalid`)
    const result = {
      sourceType: source(row.sourceType), priorityClass: priorityClass as PriorityClass,
      researchDepth: researchDepth as ResearchDepth,
      sampleCount: positiveInteger(row.sampleCount, `queueFreshness[${index}].sampleCount`),
      p50Ms: integer(row.p50Ms, `queueFreshness[${index}].p50Ms`),
      p95Ms: integer(row.p95Ms, `queueFreshness[${index}].p95Ms`),
      p99Ms: integer(row.p99Ms, `queueFreshness[${index}].p99Ms`),
      oldestMs: integer(row.oldestMs, `queueFreshness[${index}].oldestMs`),
    }
    if (!(result.p50Ms <= result.p95Ms && result.p95Ms <= result.p99Ms && result.p99Ms <= result.oldestMs)) {
      throw new Error(`queueFreshness[${index}] percentiles must be ordered`)
    }
    return result
  })
}
function typedFailures(value: unknown): LiveSoakEvidenceV1['typedFailures'] {
  if (!Array.isArray(value)) throw new Error('typedFailures must be an array')
  const allowed = new Set<FailureCategory>([
    'provider_unavailable', 'provider_rate_limited', 'provider_timeout', 'provider_authentication',
    'circuit_open', 'retrieval_timeout', 'retrieval_blocked', 'retrieval_unsafe_url', 'budget_exceeded',
    'invalid_structured_output', 'schema_version_mismatch', 'permanent_source_error',
    'entity_resolution_failed', 'storage_transient', 'storage_permanent',
  ])
  return value.map((item, index) => {
    const row = object(item)
    const category = text(row.category, `typedFailures[${index}].category`) as FailureCategory
    if (!allowed.has(category)) throw new Error(`typedFailures[${index}].category is not typed`)
    return { category, count: integer(row.count, `typedFailures[${index}].count`) }
  })
}
function providers(value: unknown): LiveSoakEvidenceV1['providers'] {
  if (!Array.isArray(value) || value.length === 0) throw new Error('providers must be non-empty')
  return value.map((item, index) => {
    const row = object(item)
    return {
      sourceType: source(row.sourceType), stage: stage(row.stage), provider: text(row.provider, `providers[${index}].provider`),
      terminalCalls: positiveInteger(row.terminalCalls, `providers[${index}].terminalCalls`),
      succeededCalls: integer(row.succeededCalls, `providers[${index}].succeededCalls`),
      p95LatencyMs: integer(row.p95LatencyMs, `providers[${index}].p95LatencyMs`),
    }
  })
}
function circuits(value: unknown): LiveSoakEvidenceV1['circuits'] {
  if (!Array.isArray(value) || value.length === 0) throw new Error('circuits must be non-empty')
  return value.map((item, index) => {
    const row = object(item)
    const state = row.state
    if (state !== 'closed' && state !== 'open' && state !== 'half_open') throw new Error(`circuits[${index}].state is invalid`)
    return {
      sourceType: source(row.sourceType), stage: stage(row.stage), provider: text(row.provider, `circuits[${index}].provider`),
      state, nextProbeAt: row.nextProbeAt === null ? null : timestamp(row.nextProbeAt, `circuits[${index}].nextProbeAt`),
    }
  })
}
function sqliteEvidence(value: unknown): LiveSoakEvidenceV1['sqlite'] {
  if (!Array.isArray(value) || value.length !== 2) throw new Error('sqlite must contain news and pipeline measurements')
  const result = value.map((item, index) => {
    const row = object(item); const database = row.database
    if (database !== 'news' && database !== 'pipeline') throw new Error(`sqlite[${index}].database is invalid`)
    return {
      database: database as 'news' | 'pipeline',
      mainBytesStart: integer(row.mainBytesStart, `sqlite[${index}].mainBytesStart`),
      mainBytesEnd: integer(row.mainBytesEnd, `sqlite[${index}].mainBytesEnd`),
      walBytesStart: integer(row.walBytesStart, `sqlite[${index}].walBytesStart`),
      walBytesEnd: integer(row.walBytesEnd, `sqlite[${index}].walBytesEnd`),
      shmBytesStart: integer(row.shmBytesStart, `sqlite[${index}].shmBytesStart`),
      shmBytesEnd: integer(row.shmBytesEnd, `sqlite[${index}].shmBytesEnd`),
      writeErrorsDelta: integer(row.writeErrorsDelta, `sqlite[${index}].writeErrorsDelta`),
    }
  })
  if (new Set(result.map((item) => item.database)).size !== 2) throw new Error('sqlite measurements must be unique')
  return result
}
function orphanEvidence(value: unknown): LiveSoakEvidenceV1['orphanAudit'] {
  const row = object(value)
  return {
    artifactSha256: digest(row.artifactSha256, 'orphanAudit.artifactSha256'),
    passed: bool(row.passed, 'orphanAudit.passed'), suspectedOrphans: integer(row.suspectedOrphans, 'orphanAudit.suspectedOrphans'),
    unregisteredArtifacts: integer(row.unregisteredArtifacts, 'orphanAudit.unregisteredArtifacts'),
    incomplete: bool(row.incomplete, 'orphanAudit.incomplete'),
  }
}
function handoffEvidence(value: unknown): LiveSoakEvidenceV1['handoffs'] {
  const row = object(value)
  return {
    admitted: positiveInteger(row.admitted, 'handoffs.admitted'), researchPackets: integer(row.researchPackets, 'handoffs.researchPackets'),
    entityWorkCompletions: integer(row.entityWorkCompletions, 'handoffs.entityWorkCompletions'),
    entityMemoryRows: integer(row.entityMemoryRows, 'handoffs.entityMemoryRows'),
    latencySampleCount: positiveInteger(row.latencySampleCount, 'handoffs.latencySampleCount'),
    deadLetters: integer(row.deadLetters, 'handoffs.deadLetters'),
    p50Ms: integer(row.p50Ms, 'handoffs.p50Ms'), p95Ms: integer(row.p95Ms, 'handoffs.p95Ms'), p99Ms: integer(row.p99Ms, 'handoffs.p99Ms'),
  }
}
function boundedStateEvidence(value: unknown): LiveSoakEvidenceV1['boundedState'] {
  const row = object(value)
  return {
    hermesSessionsStart: integer(row.hermesSessionsStart, 'boundedState.hermesSessionsStart'),
    hermesSessionsEnd: integer(row.hermesSessionsEnd, 'boundedState.hermesSessionsEnd'),
    temporaryArtifactsStart: integer(row.temporaryArtifactsStart, 'boundedState.temporaryArtifactsStart'),
    temporaryArtifactsEnd: integer(row.temporaryArtifactsEnd, 'boundedState.temporaryArtifactsEnd'),
  }
}
function soakThresholds(value: unknown): LiveSoakEvidenceV1['thresholds'] {
  const row = object(value)
  return {
    maximumRestartDelta: integer(row.maximumRestartDelta, 'thresholds.maximumRestartDelta'),
    maximumQueueP95Ms: positiveInteger(row.maximumQueueP95Ms, 'thresholds.maximumQueueP95Ms'),
    minimumProviderSuccessRate: unit(row.minimumProviderSuccessRate, 'thresholds.minimumProviderSuccessRate'),
    maximumProviderP95LatencyMs: positiveInteger(row.maximumProviderP95LatencyMs, 'thresholds.maximumProviderP95LatencyMs'),
    maximumSqliteGrowthBytes: integer(row.maximumSqliteGrowthBytes, 'thresholds.maximumSqliteGrowthBytes'),
    minimumMemoryHandoffRate: unit(row.minimumMemoryHandoffRate, 'thresholds.minimumMemoryHandoffRate'),
    maximumDeadLetterRate: unit(row.maximumDeadLetterRate, 'thresholds.maximumDeadLetterRate'),
    maximumBoundedStateGrowth: integer(row.maximumBoundedStateGrowth, 'thresholds.maximumBoundedStateGrowth'),
  }
}

function hasStageCoverage(
  sourcesToCover: Signal['sourceType'][],
  values: Array<{ sourceType: Signal['sourceType']; stage: 'research' | 'entity' }>,
): boolean {
  return sourcesToCover.every((sourceType) => (['research', 'entity'] as const).every(
    (stageName) => values.some((value) => value.sourceType === sourceType && value.stage === stageName),
  ))
}
