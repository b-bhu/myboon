import { isAbsolute, resolve } from 'node:path'
import { redactControlPlaneValue } from './control-plane-format'
import type { FailureCategory, PriorityClass, ResearchDepth, Signal } from './contracts'
import type { CutoverStage } from './cutover-receipt'
import {
  assertPolicyUsable,
  type LiveLoadEvidenceThresholdsV1,
  type LiveSoakEvidenceThresholdsV1,
  type OperationalEvidencePolicyV1,
  type ProviderOutageEvidenceThresholdsV1,
  type RollbackEvidenceThresholdsV1,
  validateOperationalEvidencePolicy,
} from './operational-evidence-policy'

export const ROLLBACK_REHEARSAL_SCHEMA_VERSION = 'myboon.feed_v3_rollback_rehearsal.v1' as const
export const LIVE_LOAD_EVIDENCE_SCHEMA_VERSION = 'myboon.feed_v3_live_load_evidence.v1' as const
export const LIVE_SOAK_EVIDENCE_SCHEMA_VERSION = 'myboon.feed_v3_live_soak_evidence.v1' as const
export const PROVIDER_OUTAGE_EVIDENCE_SCHEMA_VERSION = 'myboon.feed_v3_provider_outage_rehearsal.v1' as const
export const MINIMUM_LIVE_SOAK_MS = 24 * 60 * 60_000

export interface RawArtifactReferenceV1 {
  artifactPath: string
  artifactSha256: string
}

interface PolicyBoundEvidenceV1 {
  policyId: string
  policySha256: string
}

export interface RollbackRehearsalEvidenceV1 extends PolicyBoundEvidenceV1 {
  schemaVersion: typeof ROLLBACK_REHEARSAL_SCHEMA_VERSION
  artifactId: string
  rehearsedAt: string
  sourceType: Signal['sourceType']
  stage: CutoverStage
  rawArtifacts: { inputSnapshot: RawArtifactReferenceV1; outputSnapshot: RawArtifactReferenceV1 }
  elapsedMs: number
  before: { canonicalOwnerActive: boolean; legacyOwnerActive: boolean; queueRows: number; leasedRows: number }
  after: { canonicalOwnerActive: boolean; legacyOwnerActive: boolean; queueRows: number; leasedRows: number }
  queueIntegrityVerified: boolean
  manualSqlRepairs: number
  passed: boolean
  failures: string[]
}

export interface LiveLoadEvidenceV1 extends PolicyBoundEvidenceV1 {
  schemaVersion: typeof LIVE_LOAD_EVIDENCE_SCHEMA_VERSION
  artifactId: string
  startedAt: string
  finishedAt: string
  durationMs: number
  sourceTypes: Signal['sourceType'][]
  rawArtifacts: {
    arrivalSamples: RawArtifactReferenceV1
    statusSamples: RawArtifactReferenceV1
    traceSamples: RawArtifactReferenceV1
  }
  baselineAdmittedArrivalsPerSecond: number
  measuredAdmittedArrivalsPerSecond: number
  offeredItems: number
  admittedItems: number
  completedItems: number
  queueP95Ms: number
  maximumQueueDepth: number
  terminalFailures: number
  duplicateArtifacts: number
  sqliteWriteErrors: number
  passed: boolean
  failures: string[]
}

export interface LiveSoakEvidenceV1 extends PolicyBoundEvidenceV1 {
  schemaVersion: typeof LIVE_SOAK_EVIDENCE_SCHEMA_VERSION
  artifactId: string
  startedAt: string
  finishedAt: string
  durationMs: number
  sourceTypes: Signal['sourceType'][]
  rawArtifacts: {
    inputSnapshot: RawArtifactReferenceV1
    statusSamples: RawArtifactReferenceV1
    pm2Snapshot: RawArtifactReferenceV1
    orphanAudit: RawArtifactReferenceV1
  }
  sampling: { statusSampleCount: number; firstSampleAt: string; lastSampleAt: string; maximumGapMs: number }
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
  orphanAudit: { passed: boolean; suspectedOrphans: number; unregisteredArtifacts: number; incomplete: boolean }
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
  passed: boolean
  failures: string[]
}

export interface ProviderOutageRehearsalEvidenceV1 extends PolicyBoundEvidenceV1 {
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
  rawArtifacts: {
    cohort: RawArtifactReferenceV1
    statusSamples: RawArtifactReferenceV1
    traceSamples: RawArtifactReferenceV1
  }
  cohortSize: number
  outageInjection: { attemptedItems: number; retryableFailures: number; providerCalls: number }
  duringOpen: {
    observationCount: number; observationDurationMs: number
    pendingItems: number; claimedItems: number; terminalFailures: number; attemptDelta: number; providerCalls: number
  }
  probe: { calls: number; succeeded: boolean }
  afterRecovery: {
    pendingItems: number; retryingItems: number; completedItems: number; deadLetterItems: number
    duplicateArtifacts: number; terminalOutageFailures: number
  }
  manualSqlRepairs: number
  passed: boolean
  failures: string[]
}

export type OperationalEvidence = RollbackRehearsalEvidenceV1 | LiveLoadEvidenceV1
  | LiveSoakEvidenceV1 | ProviderOutageRehearsalEvidenceV1

export function validateRollbackRehearsalEvidence(
  value: unknown,
  policy: OperationalEvidencePolicyV1,
): RollbackRehearsalEvidenceV1 {
  policy = validateOperationalEvidencePolicy(policy)
  const record = exactObject(value, [
    'schemaVersion', 'artifactId', 'policyId', 'policySha256', 'rehearsedAt', 'sourceType', 'stage',
    'rawArtifacts', 'elapsedMs', 'before', 'after', 'queueIntegrityVerified', 'manualSqlRepairs', 'passed', 'failures',
  ], 'evidence')
  literal(record.schemaVersion, ROLLBACK_REHEARSAL_SCHEMA_VERSION, 'schemaVersion')
  const raw = exactObject(record.rawArtifacts, ['inputSnapshot', 'outputSnapshot'], 'rawArtifacts')
  const result: RollbackRehearsalEvidenceV1 = {
    schemaVersion: ROLLBACK_REHEARSAL_SCHEMA_VERSION,
    artifactId: text(record.artifactId, 'artifactId'),
    ...policyBinding(record, policy),
    rehearsedAt: timestamp(record.rehearsedAt, 'rehearsedAt'),
    sourceType: source(record.sourceType),
    stage: stage(record.stage),
    rawArtifacts: {
      inputSnapshot: artifactReference(raw.inputSnapshot, 'rawArtifacts.inputSnapshot'),
      outputSnapshot: artifactReference(raw.outputSnapshot, 'rawArtifacts.outputSnapshot'),
    },
    elapsedMs: integer(record.elapsedMs, 'elapsedMs'),
    before: ownership(record.before, 'before'),
    after: ownership(record.after, 'after'),
    queueIntegrityVerified: bool(record.queueIntegrityVerified, 'queueIntegrityVerified'),
    manualSqlRepairs: integer(record.manualSqlRepairs, 'manualSqlRepairs'),
    passed: bool(record.passed, 'passed'),
    failures: strings(record.failures, 'failures'),
  }
  assertPolicyUsable({ policy, kind: 'rollback', observedAt: result.rehearsedAt })
  const thresholds = policy.thresholds as RollbackEvidenceThresholdsV1
  const derivedFailures = [
    ...(result.elapsedMs > thresholds.maximumRollbackMs ? ['rollback exceeded reviewed maximum duration'] : []),
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

export function validateLiveLoadEvidence(value: unknown, policy: OperationalEvidencePolicyV1): LiveLoadEvidenceV1 {
  policy = validateOperationalEvidencePolicy(policy)
  const record = exactObject(value, [
    'schemaVersion', 'artifactId', 'policyId', 'policySha256', 'startedAt', 'finishedAt', 'durationMs',
    'sourceTypes', 'rawArtifacts', 'baselineAdmittedArrivalsPerSecond', 'measuredAdmittedArrivalsPerSecond',
    'offeredItems', 'admittedItems', 'completedItems', 'queueP95Ms', 'maximumQueueDepth', 'terminalFailures',
    'duplicateArtifacts', 'sqliteWriteErrors', 'passed', 'failures',
  ], 'evidence')
  literal(record.schemaVersion, LIVE_LOAD_EVIDENCE_SCHEMA_VERSION, 'schemaVersion')
  const raw = exactObject(record.rawArtifacts, ['arrivalSamples', 'statusSamples', 'traceSamples'], 'rawArtifacts')
  const startedAt = timestamp(record.startedAt, 'startedAt')
  const finishedAt = timestamp(record.finishedAt, 'finishedAt')
  const result: LiveLoadEvidenceV1 = {
    schemaVersion: LIVE_LOAD_EVIDENCE_SCHEMA_VERSION,
    artifactId: text(record.artifactId, 'artifactId'), ...policyBinding(record, policy), startedAt, finishedAt,
    durationMs: positiveInteger(record.durationMs, 'durationMs'), sourceTypes: sources(record.sourceTypes),
    rawArtifacts: {
      arrivalSamples: artifactReference(raw.arrivalSamples, 'rawArtifacts.arrivalSamples'),
      statusSamples: artifactReference(raw.statusSamples, 'rawArtifacts.statusSamples'),
      traceSamples: artifactReference(raw.traceSamples, 'rawArtifacts.traceSamples'),
    },
    baselineAdmittedArrivalsPerSecond: positiveNumber(record.baselineAdmittedArrivalsPerSecond, 'baselineAdmittedArrivalsPerSecond'),
    measuredAdmittedArrivalsPerSecond: positiveNumber(record.measuredAdmittedArrivalsPerSecond, 'measuredAdmittedArrivalsPerSecond'),
    offeredItems: positiveInteger(record.offeredItems, 'offeredItems'), admittedItems: positiveInteger(record.admittedItems, 'admittedItems'),
    completedItems: integer(record.completedItems, 'completedItems'), queueP95Ms: integer(record.queueP95Ms, 'queueP95Ms'),
    maximumQueueDepth: integer(record.maximumQueueDepth, 'maximumQueueDepth'),
    terminalFailures: integer(record.terminalFailures, 'terminalFailures'),
    duplicateArtifacts: integer(record.duplicateArtifacts, 'duplicateArtifacts'),
    sqliteWriteErrors: integer(record.sqliteWriteErrors, 'sqliteWriteErrors'),
    passed: bool(record.passed, 'passed'), failures: strings(record.failures, 'failures'),
  }
  assertExactDuration(startedAt, finishedAt, result.durationMs)
  assertPolicyUsable({ policy, kind: 'live-load', observedAt: result.finishedAt })
  if (result.admittedItems > result.offeredItems || result.completedItems > result.admittedItems) {
    throw new Error('live-load item counts must be monotonically bounded by offeredItems')
  }
  const rateFromCounts = result.admittedItems / (result.durationMs / 1_000)
  if (Math.abs(rateFromCounts - result.measuredAdmittedArrivalsPerSecond) > 1e-9) {
    throw new Error('measuredAdmittedArrivalsPerSecond must exactly derive from admittedItems and durationMs')
  }
  const thresholds = policy.thresholds as LiveLoadEvidenceThresholdsV1
  const arrivalMultiplier = result.measuredAdmittedArrivalsPerSecond / result.baselineAdmittedArrivalsPerSecond
  const completionRatio = result.completedItems / result.admittedItems
  const derivedFailures = [
    ...(result.durationMs < thresholds.minimumDurationMs ? ['live load duration was below reviewed minimum'] : []),
    ...(arrivalMultiplier < Math.max(2, thresholds.minimumArrivalMultiplier)
      ? ['measured admitted arrival rate was below two-times baseline'] : []),
    ...(completionRatio < thresholds.minimumCompletionRatio ? ['completion ratio was below reviewed threshold'] : []),
    ...(result.queueP95Ms > thresholds.maximumQueueP95Ms ? ['queue p95 exceeded reviewed threshold'] : []),
    ...(result.maximumQueueDepth > thresholds.maximumQueueDepth ? ['maximum queue depth exceeded reviewed threshold'] : []),
    ...(result.terminalFailures > thresholds.maximumTerminalFailures ? ['terminal failures exceeded reviewed threshold'] : []),
    ...(result.duplicateArtifacts > thresholds.maximumDuplicateArtifacts ? ['duplicate artifacts exceeded reviewed threshold'] : []),
    ...(result.sqliteWriteErrors > thresholds.maximumSqliteWriteErrors ? ['SQLite write errors exceeded reviewed threshold'] : []),
  ]
  assertTruthfulPass(result.passed, result.failures, derivedFailures)
  return result
}

export function validateLiveSoakEvidence(value: unknown, policy: OperationalEvidencePolicyV1): LiveSoakEvidenceV1 {
  policy = validateOperationalEvidencePolicy(policy)
  const record = exactObject(value, [
    'schemaVersion', 'artifactId', 'policyId', 'policySha256', 'startedAt', 'finishedAt', 'durationMs',
    'sourceTypes', 'rawArtifacts', 'sampling', 'processes', 'queueFreshness', 'typedFailures', 'providers',
    'circuits', 'sqlite', 'orphanAudit', 'handoffs', 'manualSqlRepairs', 'boundedState', 'passed', 'failures',
  ], 'evidence')
  literal(record.schemaVersion, LIVE_SOAK_EVIDENCE_SCHEMA_VERSION, 'schemaVersion')
  const raw = exactObject(record.rawArtifacts, ['inputSnapshot', 'statusSamples', 'pm2Snapshot', 'orphanAudit'], 'rawArtifacts')
  const startedAt = timestamp(record.startedAt, 'startedAt')
  const finishedAt = timestamp(record.finishedAt, 'finishedAt')
  const result: LiveSoakEvidenceV1 = {
    schemaVersion: LIVE_SOAK_EVIDENCE_SCHEMA_VERSION, artifactId: text(record.artifactId, 'artifactId'),
    ...policyBinding(record, policy), startedAt, finishedAt, durationMs: positiveInteger(record.durationMs, 'durationMs'),
    sourceTypes: sources(record.sourceTypes),
    rawArtifacts: {
      inputSnapshot: artifactReference(raw.inputSnapshot, 'rawArtifacts.inputSnapshot'),
      statusSamples: artifactReference(raw.statusSamples, 'rawArtifacts.statusSamples'),
      pm2Snapshot: artifactReference(raw.pm2Snapshot, 'rawArtifacts.pm2Snapshot'),
      orphanAudit: artifactReference(raw.orphanAudit, 'rawArtifacts.orphanAudit'),
    },
    sampling: samplingEvidence(record.sampling), processes: processEvidence(record.processes),
    queueFreshness: queueEvidence(record.queueFreshness), typedFailures: typedFailures(record.typedFailures),
    providers: providers(record.providers), circuits: circuits(record.circuits), sqlite: sqliteEvidence(record.sqlite),
    orphanAudit: orphanEvidence(record.orphanAudit), handoffs: handoffEvidence(record.handoffs),
    manualSqlRepairs: integer(record.manualSqlRepairs, 'manualSqlRepairs'),
    boundedState: boundedStateEvidence(record.boundedState), passed: bool(record.passed, 'passed'),
    failures: strings(record.failures, 'failures'),
  }
  assertExactDuration(startedAt, finishedAt, result.durationMs)
  assertPolicyUsable({ policy, kind: 'live-soak', observedAt: result.finishedAt })
  if (!result.processes.some((process) => process.expectedOnline)) throw new Error('processes must include an expected-online process')
  if (!result.sourceTypes.every((sourceType) => result.queueFreshness.some((row) => row.sourceType === sourceType))) {
    throw new Error('queueFreshness must cover every sourceType')
  }
  if (result.providers.some((row) => row.succeededCalls > row.terminalCalls)) throw new Error('provider succeededCalls cannot exceed terminalCalls')
  if (result.handoffs.entityWorkCompletions > result.handoffs.researchPackets || result.handoffs.researchPackets > result.handoffs.admitted) {
    throw new Error('handoff counts must be monotonically bounded by admissions')
  }
  if (result.handoffs.entityMemoryRows < result.handoffs.entityWorkCompletions) {
    throw new Error('entityMemoryRows cannot be below successful entity work completions')
  }
  if (result.handoffs.latencySampleCount !== result.handoffs.entityWorkCompletions) {
    throw new Error('handoff latency samples must cover every entity work completion')
  }
  const sampledSpan = Date.parse(result.sampling.lastSampleAt) - Date.parse(result.sampling.firstSampleAt)
  if (sampledSpan < 0 || (result.sampling.statusSampleCount - 1) * result.sampling.maximumGapMs < sampledSpan) {
    throw new Error('sampling count and maximumGapMs cannot cover firstSampleAt through lastSampleAt')
  }
  const thresholds = policy.thresholds as LiveSoakEvidenceThresholdsV1
  const handoffRate = result.handoffs.entityWorkCompletions / result.handoffs.admitted
  const deadLetterRate = result.handoffs.deadLetters / result.handoffs.admitted
  const sqliteGrowth = result.sqlite.reduce((sum, item) => sum + Math.max(0, item.mainBytesEnd - item.mainBytesStart)
    + Math.max(0, item.walBytesEnd - item.walBytesStart) + Math.max(0, item.shmBytesEnd - item.shmBytesStart), 0)
  const boundedGrowth = Math.max(0, result.boundedState.hermesSessionsEnd - result.boundedState.hermesSessionsStart)
    + Math.max(0, result.boundedState.temporaryArtifactsEnd - result.boundedState.temporaryArtifactsStart)
  const derivedFailures = [
    ...(result.durationMs < Math.max(MINIMUM_LIVE_SOAK_MS, thresholds.minimumDurationMs) ? ['duration is less than 24 hours'] : []),
    ...(Date.parse(result.sampling.firstSampleAt) > Date.parse(result.startedAt)
      || Date.parse(result.sampling.lastSampleAt) < Date.parse(result.finishedAt)
      ? ['status sampling does not span the full soak window'] : []),
    ...(result.sampling.statusSampleCount < thresholds.minimumStatusSamples ? ['status sample count was below reviewed minimum'] : []),
    ...(result.sampling.maximumGapMs > thresholds.maximumSampleGapMs ? ['status sampling gap exceeded reviewed maximum'] : []),
    ...(result.processes.some((item) => item.expectedOnline && (!item.onlineAtEnd || item.uptimeMs < result.durationMs))
      ? ['expected PM2 process was not continuously online for the soak'] : []),
    ...(result.processes.some((item) => item.restartDelta > thresholds.maximumRestartDelta) ? ['PM2 restart delta exceeded threshold'] : []),
    ...(result.queueFreshness.some((item) => item.sampleCount < thresholds.minimumQueueSamplesPerLane)
      ? ['queue lane sample count was below reviewed minimum'] : []),
    ...(result.queueFreshness.some((item) => item.p95Ms > thresholds.maximumQueueP95Ms) ? ['queue p95 freshness exceeded threshold'] : []),
    ...(!hasStageCoverage(result.sourceTypes, result.providers) ? ['provider source/stage coverage is incomplete'] : []),
    ...(!hasStageCoverage(result.sourceTypes, result.circuits) ? ['circuit source/stage coverage is incomplete'] : []),
    ...(result.providers.some((item) => item.terminalCalls === 0 || item.succeededCalls / item.terminalCalls < thresholds.minimumProviderSuccessRate)
      ? ['provider success rate was below threshold'] : []),
    ...(result.providers.some((item) => item.p95LatencyMs > thresholds.maximumProviderP95LatencyMs) ? ['provider p95 latency exceeded threshold'] : []),
    ...(result.circuits.some((item) => item.state !== 'closed' || item.nextProbeAt !== null) ? ['provider circuit remained non-closed'] : []),
    ...(result.sqlite.some((item) => item.writeErrorsDelta > 0) ? ['SQLite write errors were observed'] : []),
    ...(sqliteGrowth > thresholds.maximumSqliteGrowthBytes ? ['SQLite growth exceeded threshold'] : []),
    ...(!result.orphanAudit.passed || result.orphanAudit.incomplete || result.orphanAudit.suspectedOrphans > 0
      || result.orphanAudit.unregisteredArtifacts > 0 ? ['orphan audit did not pass cleanly'] : []),
    ...(handoffRate < thresholds.minimumMemoryHandoffRate ? ['memory handoff rate was below threshold'] : []),
    ...(deadLetterRate > thresholds.maximumDeadLetterRate ? ['dead-letter rate exceeded threshold'] : []),
    ...(result.manualSqlRepairs > 0 ? ['manual SQL repairs were required'] : []),
    ...(boundedGrowth > thresholds.maximumBoundedStateGrowth ? ['bounded state growth exceeded threshold'] : []),
  ]
  assertTruthfulPass(result.passed, result.failures, derivedFailures)
  return result
}

export function validateProviderOutageRehearsalEvidence(
  value: unknown,
  policy: OperationalEvidencePolicyV1,
): ProviderOutageRehearsalEvidenceV1 {
  policy = validateOperationalEvidencePolicy(policy)
  const record = exactObject(value, [
    'schemaVersion', 'artifactId', 'policyId', 'policySha256', 'sourceType', 'stage', 'failureCategory',
    'startedAt', 'circuitOpenedAt', 'probeAllowedAt', 'recoveredAt', 'finishedAt', 'configuredCooldownMs',
    'rawArtifacts', 'cohortSize', 'outageInjection', 'duringOpen', 'probe', 'afterRecovery',
    'manualSqlRepairs', 'passed', 'failures',
  ], 'evidence')
  literal(record.schemaVersion, PROVIDER_OUTAGE_EVIDENCE_SCHEMA_VERSION, 'schemaVersion')
  const raw = exactObject(record.rawArtifacts, ['cohort', 'statusSamples', 'traceSamples'], 'rawArtifacts')
  const injection = exactObject(record.outageInjection, ['attemptedItems', 'retryableFailures', 'providerCalls'], 'outageInjection')
  const during = exactObject(record.duringOpen, [
    'observationCount', 'observationDurationMs', 'pendingItems', 'claimedItems', 'terminalFailures', 'attemptDelta', 'providerCalls',
  ], 'duringOpen')
  const probe = exactObject(record.probe, ['calls', 'succeeded'], 'probe')
  const after = exactObject(record.afterRecovery, [
    'pendingItems', 'retryingItems', 'completedItems', 'deadLetterItems', 'duplicateArtifacts', 'terminalOutageFailures',
  ], 'afterRecovery')
  const result: ProviderOutageRehearsalEvidenceV1 = {
    schemaVersion: PROVIDER_OUTAGE_EVIDENCE_SCHEMA_VERSION, artifactId: text(record.artifactId, 'artifactId'),
    ...policyBinding(record, policy), sourceType: source(record.sourceType), stage: outageStage(record.stage),
    failureCategory: outageCategory(record.failureCategory), startedAt: timestamp(record.startedAt, 'startedAt'),
    circuitOpenedAt: timestamp(record.circuitOpenedAt, 'circuitOpenedAt'), probeAllowedAt: timestamp(record.probeAllowedAt, 'probeAllowedAt'),
    recoveredAt: timestamp(record.recoveredAt, 'recoveredAt'), finishedAt: timestamp(record.finishedAt, 'finishedAt'),
    configuredCooldownMs: positiveInteger(record.configuredCooldownMs, 'configuredCooldownMs'),
    rawArtifacts: {
      cohort: artifactReference(raw.cohort, 'rawArtifacts.cohort'),
      statusSamples: artifactReference(raw.statusSamples, 'rawArtifacts.statusSamples'),
      traceSamples: artifactReference(raw.traceSamples, 'rawArtifacts.traceSamples'),
    },
    cohortSize: positiveInteger(record.cohortSize, 'cohortSize'),
    outageInjection: {
      attemptedItems: positiveInteger(injection.attemptedItems, 'outageInjection.attemptedItems'),
      retryableFailures: positiveInteger(injection.retryableFailures, 'outageInjection.retryableFailures'),
      providerCalls: positiveInteger(injection.providerCalls, 'outageInjection.providerCalls'),
    },
    duringOpen: {
      observationCount: positiveInteger(during.observationCount, 'duringOpen.observationCount'),
      observationDurationMs: positiveInteger(during.observationDurationMs, 'duringOpen.observationDurationMs'),
      pendingItems: integer(during.pendingItems, 'duringOpen.pendingItems'), claimedItems: integer(during.claimedItems, 'duringOpen.claimedItems'),
      terminalFailures: integer(during.terminalFailures, 'duringOpen.terminalFailures'),
      attemptDelta: integer(during.attemptDelta, 'duringOpen.attemptDelta'), providerCalls: integer(during.providerCalls, 'duringOpen.providerCalls'),
    },
    probe: { calls: integer(probe.calls, 'probe.calls'), succeeded: bool(probe.succeeded, 'probe.succeeded') },
    afterRecovery: {
      pendingItems: integer(after.pendingItems, 'afterRecovery.pendingItems'), retryingItems: integer(after.retryingItems, 'afterRecovery.retryingItems'),
      completedItems: integer(after.completedItems, 'afterRecovery.completedItems'), deadLetterItems: integer(after.deadLetterItems, 'afterRecovery.deadLetterItems'),
      duplicateArtifacts: integer(after.duplicateArtifacts, 'afterRecovery.duplicateArtifacts'),
      terminalOutageFailures: integer(after.terminalOutageFailures, 'afterRecovery.terminalOutageFailures'),
    },
    manualSqlRepairs: integer(record.manualSqlRepairs, 'manualSqlRepairs'), passed: bool(record.passed, 'passed'),
    failures: strings(record.failures, 'failures'),
  }
  const start = Date.parse(result.startedAt); const opened = Date.parse(result.circuitOpenedAt)
  const probeAt = Date.parse(result.probeAllowedAt); const recovered = Date.parse(result.recoveredAt)
  const finished = Date.parse(result.finishedAt)
  if (!(start < opened && opened < probeAt && probeAt <= recovered && recovered <= finished)) {
    throw new Error('provider outage timestamps must be strictly ordered through probe allowance')
  }
  assertPolicyUsable({ policy, kind: 'provider-outage', observedAt: result.finishedAt })
  const thresholds = policy.thresholds as ProviderOutageEvidenceThresholdsV1
  if (probeAt - opened < result.configuredCooldownMs) throw new Error('probeAllowedAt precedes the configured circuit cooldown')
  if (result.outageInjection.retryableFailures > result.outageInjection.attemptedItems
    || result.outageInjection.providerCalls < result.outageInjection.attemptedItems) {
    throw new Error('outage injection counts are inconsistent')
  }
  const afterCount = result.afterRecovery.pendingItems + result.afterRecovery.retryingItems
    + result.afterRecovery.completedItems + result.afterRecovery.deadLetterItems
  const derivedFailures = [
    ...(result.configuredCooldownMs < thresholds.minimumCooldownMs || result.configuredCooldownMs > thresholds.maximumCooldownMs
      ? ['configured cooldown is outside the reviewed range'] : []),
    ...(result.cohortSize < thresholds.minimumCohortSize ? ['outage cohort is below reviewed minimum size'] : []),
    ...(result.outageInjection.retryableFailures !== result.outageInjection.attemptedItems ? ['outage injection did not produce retryable failures'] : []),
    ...(result.duringOpen.observationCount < 2 ? ['open circuit was not observed at least twice'] : []),
    ...(result.duringOpen.observationDurationMs < result.configuredCooldownMs ? ['open-circuit observation did not span cooldown'] : []),
    ...(result.duringOpen.pendingItems !== result.cohortSize ? ['outage cohort was not fully pending while open'] : []),
    ...(result.duringOpen.claimedItems !== 0 ? ['work was claimed while the provider circuit was open'] : []),
    ...(result.duringOpen.terminalFailures !== 0 ? ['terminal failures were created while the circuit was open'] : []),
    ...(result.duringOpen.attemptDelta !== 0 ? ['attempt counters changed while the circuit was open'] : []),
    ...(result.duringOpen.providerCalls !== 0 ? ['provider calls occurred while the circuit was open'] : []),
    ...(result.probe.calls !== 1 || !result.probe.succeeded ? ['half-open recovery did not run exactly one successful probe'] : []),
    ...(recovered - probeAt > thresholds.maximumRecoveryMs ? ['provider recovery exceeded reviewed maximum'] : []),
    ...(afterCount !== result.cohortSize ? ['post-recovery cohort cardinality changed'] : []),
    ...(result.afterRecovery.completedItems !== result.cohortSize || result.afterRecovery.pendingItems !== 0
      || result.afterRecovery.retryingItems !== 0 || result.afterRecovery.deadLetterItems !== 0
      ? ['cohort did not fully complete after recovery'] : []),
    ...(result.afterRecovery.duplicateArtifacts !== 0 ? ['recovery created duplicate artifacts'] : []),
    ...(result.afterRecovery.terminalOutageFailures !== 0 ? ['outage produced terminal cohort failures'] : []),
    ...(result.manualSqlRepairs !== 0 ? ['manual SQL repairs were required'] : []),
  ]
  assertTruthfulPass(result.passed, result.failures, derivedFailures)
  return result
}

export function formatOperationalEvidenceJson(value: OperationalEvidence): string {
  return JSON.stringify(redactControlPlaneValue(value), null, 2)
}

export function evidenceArtifactReferences(value: OperationalEvidence): RawArtifactReferenceV1[] {
  return Object.values(value.rawArtifacts)
}

function policyBinding(record: Record<string, unknown>, policy: OperationalEvidencePolicyV1): PolicyBoundEvidenceV1 {
  const policyId = text(record.policyId, 'policyId')
  if (policyId !== policy.policyId) throw new Error('evidence policyId does not match independently supplied policy')
  return { policyId, policySha256: digest(record.policySha256, 'policySha256') }
}

function artifactReference(value: unknown, path: string): RawArtifactReferenceV1 {
  const row = exactObject(value, ['artifactPath', 'artifactSha256'], path)
  const artifactPath = text(row.artifactPath, `${path}.artifactPath`)
  if (!isAbsolute(artifactPath)) throw new Error(`${path}.artifactPath must be absolute`)
  return { artifactPath: resolve(artifactPath), artifactSha256: digest(row.artifactSha256, `${path}.artifactSha256`) }
}

function assertTruthfulPass(passed: boolean, declared: string[], derived: string[]): void {
  if (passed && (declared.length > 0 || derived.length > 0)) throw new Error(`Evidence cannot pass: ${[...declared, ...derived].join('; ')}`)
  if (!passed && declared.length === 0 && derived.length === 0) throw new Error('Failed evidence must declare or derive at least one failure')
}

function assertExactDuration(startedAt: string, finishedAt: string, durationMs: number): void {
  if (Date.parse(finishedAt) - Date.parse(startedAt) !== durationMs) throw new Error('durationMs must exactly match startedAt/finishedAt')
}

function exactObject(value: unknown, keys: readonly string[], path: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${path} must be an object`)
  const record = value as Record<string, unknown>; const actual = Object.keys(record).sort(); const expected = [...keys].sort()
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error(`${path} must contain exactly: ${keys.join(', ')}`)
  }
  return record
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
function literal(value: unknown, expected: string, field: string): void { if (value !== expected) throw new Error(`${field} must be ${expected}`) }
function text(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${field} must be non-empty`)
  return value.trim()
}
function timestamp(value: unknown, field: string): string {
  const result = text(value, field)
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(result)
    || !Number.isFinite(Date.parse(result)) || new Date(Date.parse(result)).toISOString() !== result) {
    throw new Error(`${field} must be a canonical UTC timestamp`)
  }
  return result
}
function integer(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw new Error(`${field} must be a non-negative safe integer`)
  return Number(value)
}
function positiveInteger(value: unknown, field: string): number {
  const result = integer(value, field); if (result === 0) throw new Error(`${field} must be positive`); return result
}
function positiveNumber(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) throw new Error(`${field} must be positive`)
  return value
}
function bool(value: unknown, field: string): boolean { if (typeof value !== 'boolean') throw new Error(`${field} must be boolean`); return value }
function strings(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || !item.trim())) throw new Error(`${field} must be an array of non-empty strings`)
  const result = value.map((item) => String(item).trim())
  if (new Set(result).size !== result.length) throw new Error(`${field} must not contain duplicates`)
  return result
}
function sources(value: unknown): Signal['sourceType'][] {
  const allowed = new Set<Signal['sourceType']>(['news', 'polymarket', 'market_calendar', 'x'])
  if (!Array.isArray(value) || value.length === 0 || value.some((item) => !allowed.has(item as Signal['sourceType']))) {
    throw new Error('sourceTypes must contain known sources')
  }
  if (new Set(value).size !== value.length) throw new Error('sourceTypes must not contain duplicates')
  return value as Signal['sourceType'][]
}
function digest(value: unknown, field: string): string {
  const result = text(value, field); if (!/^[a-f0-9]{64}$/.test(result)) throw new Error(`${field} must be lowercase SHA-256`); return result
}
function source(value: unknown): Signal['sourceType'] { return sources([value])[0]! }
function stage(value: unknown): CutoverStage { if (value !== 'research' && value !== 'entity') throw new Error('stage must be research or entity'); return value }

function ownership(value: unknown, field: string): RollbackRehearsalEvidenceV1['before'] {
  const row = exactObject(value, ['canonicalOwnerActive', 'legacyOwnerActive', 'queueRows', 'leasedRows'], field)
  return { canonicalOwnerActive: bool(row.canonicalOwnerActive, `${field}.canonicalOwnerActive`), legacyOwnerActive: bool(row.legacyOwnerActive, `${field}.legacyOwnerActive`), queueRows: integer(row.queueRows, `${field}.queueRows`), leasedRows: integer(row.leasedRows, `${field}.leasedRows`) }
}
function samplingEvidence(value: unknown): LiveSoakEvidenceV1['sampling'] {
  const row = exactObject(value, ['statusSampleCount', 'firstSampleAt', 'lastSampleAt', 'maximumGapMs'], 'sampling')
  return { statusSampleCount: positiveInteger(row.statusSampleCount, 'sampling.statusSampleCount'), firstSampleAt: timestamp(row.firstSampleAt, 'sampling.firstSampleAt'), lastSampleAt: timestamp(row.lastSampleAt, 'sampling.lastSampleAt'), maximumGapMs: integer(row.maximumGapMs, 'sampling.maximumGapMs') }
}
function processEvidence(value: unknown): LiveSoakEvidenceV1['processes'] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 100) throw new Error('processes must contain 1-100 rows')
  const result = value.map((item, index) => { const path = `processes[${index}]`; const row = exactObject(item, ['processNameSha256', 'restartDelta', 'uptimeMs', 'onlineAtEnd', 'expectedOnline'], path); return { processNameSha256: digest(row.processNameSha256, `${path}.processNameSha256`), restartDelta: integer(row.restartDelta, `${path}.restartDelta`), uptimeMs: integer(row.uptimeMs, `${path}.uptimeMs`), onlineAtEnd: bool(row.onlineAtEnd, `${path}.onlineAtEnd`), expectedOnline: bool(row.expectedOnline, `${path}.expectedOnline`) } })
  if (new Set(result.map((item) => item.processNameSha256)).size !== result.length) throw new Error('processes contain duplicate name hashes')
  return result
}
function queueEvidence(value: unknown): LiveSoakEvidenceV1['queueFreshness'] {
  if (!Array.isArray(value) || value.length === 0) throw new Error('queueFreshness must be non-empty')
  const result = value.map((item, index) => { const path = `queueFreshness[${index}]`; const row = exactObject(item, ['sourceType', 'priorityClass', 'researchDepth', 'sampleCount', 'p50Ms', 'p95Ms', 'p99Ms', 'oldestMs'], path); const priorityClass = row.priorityClass; const researchDepth = row.researchDepth; if (!['P0', 'P1', 'P2', 'P3'].includes(String(priorityClass))) throw new Error(`${path}.priorityClass is invalid`); if (!['light', 'standard', 'deep'].includes(String(researchDepth))) throw new Error(`${path}.researchDepth is invalid`); const parsed = { sourceType: source(row.sourceType), priorityClass: priorityClass as PriorityClass, researchDepth: researchDepth as ResearchDepth, sampleCount: positiveInteger(row.sampleCount, `${path}.sampleCount`), p50Ms: integer(row.p50Ms, `${path}.p50Ms`), p95Ms: integer(row.p95Ms, `${path}.p95Ms`), p99Ms: integer(row.p99Ms, `${path}.p99Ms`), oldestMs: integer(row.oldestMs, `${path}.oldestMs`) }; if (!(parsed.p50Ms <= parsed.p95Ms && parsed.p95Ms <= parsed.p99Ms && parsed.p99Ms <= parsed.oldestMs)) throw new Error(`${path} percentiles must be ordered`); return parsed })
  const keys = result.map((row) => `${row.sourceType}:${row.priorityClass}:${row.researchDepth}`)
  if (new Set(keys).size !== keys.length) throw new Error('queueFreshness contains duplicate lanes')
  return result
}
function typedFailures(value: unknown): LiveSoakEvidenceV1['typedFailures'] {
  if (!Array.isArray(value)) throw new Error('typedFailures must be an array')
  const allowed = new Set<FailureCategory>(['provider_unavailable', 'provider_rate_limited', 'provider_timeout', 'provider_authentication', 'circuit_open', 'retrieval_timeout', 'retrieval_blocked', 'retrieval_unsafe_url', 'budget_exceeded', 'invalid_structured_output', 'schema_version_mismatch', 'permanent_source_error', 'entity_resolution_failed', 'storage_transient', 'storage_permanent'])
  const result = value.map((item, index) => { const path = `typedFailures[${index}]`; const row = exactObject(item, ['category', 'count'], path); const category = text(row.category, `${path}.category`) as FailureCategory; if (!allowed.has(category)) throw new Error(`${path}.category is not typed`); return { category, count: integer(row.count, `${path}.count`) } })
  if (new Set(result.map((row) => row.category)).size !== result.length) throw new Error('typedFailures contains duplicate categories')
  return result
}
function providers(value: unknown): LiveSoakEvidenceV1['providers'] {
  if (!Array.isArray(value) || value.length === 0) throw new Error('providers must be non-empty')
  const result = value.map((item, index) => { const path = `providers[${index}]`; const row = exactObject(item, ['sourceType', 'stage', 'provider', 'terminalCalls', 'succeededCalls', 'p95LatencyMs'], path); return { sourceType: source(row.sourceType), stage: stage(row.stage), provider: text(row.provider, `${path}.provider`), terminalCalls: positiveInteger(row.terminalCalls, `${path}.terminalCalls`), succeededCalls: integer(row.succeededCalls, `${path}.succeededCalls`), p95LatencyMs: integer(row.p95LatencyMs, `${path}.p95LatencyMs`) } })
  assertUniqueRoutes(result, 'providers'); return result
}
function circuits(value: unknown): LiveSoakEvidenceV1['circuits'] {
  if (!Array.isArray(value) || value.length === 0) throw new Error('circuits must be non-empty')
  const result: LiveSoakEvidenceV1['circuits'] = value.map((item, index) => { const path = `circuits[${index}]`; const row = exactObject(item, ['sourceType', 'stage', 'provider', 'state', 'nextProbeAt'], path); const state = row.state; if (state !== 'closed' && state !== 'open' && state !== 'half_open') throw new Error(`${path}.state is invalid`); return { sourceType: source(row.sourceType), stage: stage(row.stage), provider: text(row.provider, `${path}.provider`), state, nextProbeAt: row.nextProbeAt === null ? null : timestamp(row.nextProbeAt, `${path}.nextProbeAt`) } })
  assertUniqueRoutes(result, 'circuits'); return result
}
function assertUniqueRoutes(rows: Array<{ sourceType: string; stage: string; provider: string }>, path: string): void {
  const keys = rows.map((row) => `${row.sourceType}:${row.stage}:${row.provider}`); if (new Set(keys).size !== keys.length) throw new Error(`${path} contains duplicate routes`)
}
function sqliteEvidence(value: unknown): LiveSoakEvidenceV1['sqlite'] {
  if (!Array.isArray(value) || value.length !== 2) throw new Error('sqlite must contain news and pipeline measurements')
  const result: LiveSoakEvidenceV1['sqlite'] = value.map((item, index) => { const path = `sqlite[${index}]`; const row = exactObject(item, ['database', 'mainBytesStart', 'mainBytesEnd', 'walBytesStart', 'walBytesEnd', 'shmBytesStart', 'shmBytesEnd', 'writeErrorsDelta'], path); const database = row.database; if (database !== 'news' && database !== 'pipeline') throw new Error(`${path}.database is invalid`); return { database, mainBytesStart: integer(row.mainBytesStart, `${path}.mainBytesStart`), mainBytesEnd: integer(row.mainBytesEnd, `${path}.mainBytesEnd`), walBytesStart: integer(row.walBytesStart, `${path}.walBytesStart`), walBytesEnd: integer(row.walBytesEnd, `${path}.walBytesEnd`), shmBytesStart: integer(row.shmBytesStart, `${path}.shmBytesStart`), shmBytesEnd: integer(row.shmBytesEnd, `${path}.shmBytesEnd`), writeErrorsDelta: integer(row.writeErrorsDelta, `${path}.writeErrorsDelta`) } })
  if (new Set(result.map((item) => item.database)).size !== 2) throw new Error('sqlite measurements must be unique')
  return result
}
function orphanEvidence(value: unknown): LiveSoakEvidenceV1['orphanAudit'] {
  const row = exactObject(value, ['passed', 'suspectedOrphans', 'unregisteredArtifacts', 'incomplete'], 'orphanAudit')
  return { passed: bool(row.passed, 'orphanAudit.passed'), suspectedOrphans: integer(row.suspectedOrphans, 'orphanAudit.suspectedOrphans'), unregisteredArtifacts: integer(row.unregisteredArtifacts, 'orphanAudit.unregisteredArtifacts'), incomplete: bool(row.incomplete, 'orphanAudit.incomplete') }
}
function handoffEvidence(value: unknown): LiveSoakEvidenceV1['handoffs'] {
  const row = exactObject(value, ['admitted', 'researchPackets', 'entityWorkCompletions', 'entityMemoryRows', 'deadLetters', 'latencySampleCount', 'p50Ms', 'p95Ms', 'p99Ms'], 'handoffs')
  const result = { admitted: positiveInteger(row.admitted, 'handoffs.admitted'), researchPackets: integer(row.researchPackets, 'handoffs.researchPackets'), entityWorkCompletions: integer(row.entityWorkCompletions, 'handoffs.entityWorkCompletions'), entityMemoryRows: integer(row.entityMemoryRows, 'handoffs.entityMemoryRows'), deadLetters: integer(row.deadLetters, 'handoffs.deadLetters'), latencySampleCount: positiveInteger(row.latencySampleCount, 'handoffs.latencySampleCount'), p50Ms: integer(row.p50Ms, 'handoffs.p50Ms'), p95Ms: integer(row.p95Ms, 'handoffs.p95Ms'), p99Ms: integer(row.p99Ms, 'handoffs.p99Ms') }
  if (!(result.p50Ms <= result.p95Ms && result.p95Ms <= result.p99Ms)) throw new Error('handoff latency percentiles must be ordered')
  return result
}
function boundedStateEvidence(value: unknown): LiveSoakEvidenceV1['boundedState'] {
  const row = exactObject(value, ['hermesSessionsStart', 'hermesSessionsEnd', 'temporaryArtifactsStart', 'temporaryArtifactsEnd'], 'boundedState')
  return { hermesSessionsStart: integer(row.hermesSessionsStart, 'boundedState.hermesSessionsStart'), hermesSessionsEnd: integer(row.hermesSessionsEnd, 'boundedState.hermesSessionsEnd'), temporaryArtifactsStart: integer(row.temporaryArtifactsStart, 'boundedState.temporaryArtifactsStart'), temporaryArtifactsEnd: integer(row.temporaryArtifactsEnd, 'boundedState.temporaryArtifactsEnd') }
}
function hasStageCoverage(sourcesToCover: Signal['sourceType'][], values: Array<{ sourceType: Signal['sourceType']; stage: 'research' | 'entity' }>): boolean {
  return sourcesToCover.every((sourceType) => (['research', 'entity'] as const).every((stageName) => values.some((value) => value.sourceType === sourceType && value.stage === stageName)))
}
