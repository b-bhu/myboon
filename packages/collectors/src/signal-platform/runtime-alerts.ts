import type { Signal } from './contracts'
import type { SignalPlatformControlPlaneStatus, WorkControlPlaneStage } from './control-plane'
import type { FeedV3RuntimeStatusAvailability } from './runtime-status'

export const OPERATIONAL_ALERT_REPORT_SCHEMA_VERSION = 'myboon.feed_v3_operational_alerts.v1' as const

export interface OperationalAlertPolicyV1 {
  minimumThroughputWindowMs: number
  minimumCompletionAdmissionRatio: number
  sqliteWriteErrorCountThreshold: number
}

export type OperationalAlertCode =
  | 'PROVIDER_CIRCUIT_OPEN'
  | 'RESEARCH_COMPLETION_BELOW_ADMISSION'
  | 'CONTAINED_JOB_SURVIVED_DEADLINE'
  | 'SQLITE_WRITE_ERROR_THRESHOLD'

export interface OperationalAlertV1 {
  code: OperationalAlertCode
  sourceType: Signal['sourceType']
  stage: WorkControlPlaneStage | 'synthesis' | 'deep_research' | 'entity_manager'
  provider: string | null
  queueAgeMs: number | null
  nextProbeAt: string | null
  message: string
  suggestedCommand: string
}

export interface OperationalAlertCoverageGapV1 {
  check: 'policy' | 'research_runtime' | 'entity_runtime' | 'throughput_window' | 'sqlite_write_errors' | 'deep_audit'
  sourceType: Signal['sourceType'] | null
  reason: string
}

export interface OperationalAlertReportV1 {
  schemaVersion: typeof OPERATIONAL_ALERT_REPORT_SCHEMA_VERSION
  generatedAt: string
  availability: 'available' | 'partial' | 'unavailable'
  items: OperationalAlertV1[]
  unavailableChecks: OperationalAlertCoverageGapV1[]
}

export function parseOperationalAlertPolicy(value: unknown): OperationalAlertPolicyV1 {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('operational alert policy must be an object')
  const record = value as Record<string, unknown>
  for (const key of Object.keys(record)) {
    if (!['minimumThroughputWindowMs', 'minimumCompletionAdmissionRatio', 'sqliteWriteErrorCountThreshold'].includes(key)) {
      throw new Error(`unknown operational alert policy key: ${key}`)
    }
  }
  const minimumThroughputWindowMs = integer(record.minimumThroughputWindowMs, 'minimumThroughputWindowMs', 30 * 60_000)
  const minimumCompletionAdmissionRatio = Number(record.minimumCompletionAdmissionRatio)
  if (!Number.isFinite(minimumCompletionAdmissionRatio)
    || minimumCompletionAdmissionRatio < 0 || minimumCompletionAdmissionRatio > 1) {
    throw new Error('minimumCompletionAdmissionRatio must be between 0 and 1')
  }
  const sqliteWriteErrorCountThreshold = integer(record.sqliteWriteErrorCountThreshold, 'sqliteWriteErrorCountThreshold', 0)
  return { minimumThroughputWindowMs, minimumCompletionAdmissionRatio, sqliteWriteErrorCountThreshold }
}

export function evaluateOperationalAlerts(input: {
  status: SignalPlatformControlPlaneStatus
  runtime: FeedV3RuntimeStatusAvailability
  policy: OperationalAlertPolicyV1 | null
}): OperationalAlertReportV1 {
  const nowMs = Date.parse(input.status.generatedAt)
  if (!Number.isFinite(nowMs)) throw new Error('status.generatedAt must be valid')
  const items: OperationalAlertV1[] = []
  const unavailableChecks: OperationalAlertCoverageGapV1[] = []
  const sourceTypes = Object.keys(input.status.sources).sort() as Signal['sourceType'][]

  if (!input.policy) unavailableChecks.push({
    check: 'policy', sourceType: null, reason: 'reviewed operational alert thresholds are not configured',
  })
  else {
    for (const sourceType of sourceTypes) {
      const source = input.status.sources[sourceType]
      if (!source) continue
      const windowMs = nowMs - Date.parse(source.activity.windowStart)
      if (!Number.isFinite(windowMs) || windowMs < input.policy.minimumThroughputWindowMs
        || source.activity.admissions === null || source.activity.completions === null) {
        unavailableChecks.push({
          check: 'throughput_window', sourceType,
          reason: `rolling activity window is unavailable or shorter than ${input.policy.minimumThroughputWindowMs}ms`,
        })
      } else if (source.activity.admissions > 0
        && source.activity.completions / source.activity.admissions < input.policy.minimumCompletionAdmissionRatio) {
        items.push({
          code: 'RESEARCH_COMPLETION_BELOW_ADMISSION', sourceType, stage: 'synthesis', provider: null,
          queueAgeMs: source.oldestReadyAgeMs, nextProbeAt: null,
          message: 'Rolling research completion remains below admission',
          suggestedCommand: `pnpm feed-v3:status`,
        })
      }
    }
    if (input.status.sqliteWriteErrors.availability !== 'available'
      || input.status.sqliteWriteErrors.value === null) {
      unavailableChecks.push({
        check: 'sqlite_write_errors', sourceType: null,
        reason: input.status.sqliteWriteErrors.reason ?? 'durable SQLite write-error count is unavailable',
      })
    } else if (input.status.sqliteWriteErrors.value > input.policy.sqliteWriteErrorCountThreshold) {
      for (const sourceType of sourceTypes) items.push({
        code: 'SQLITE_WRITE_ERROR_THRESHOLD', sourceType, stage: 'unassigned', provider: null,
        queueAgeMs: null, nextProbeAt: null,
        message: 'SQLite write-error count exceeds the reviewed threshold',
        suggestedCommand: 'pnpm feed-v3:status',
      })
    }
  }

  const research = input.runtime.researchRuntime
  if (research.availability !== 'current' || !research.snapshot) {
    unavailableChecks.push({
      check: 'research_runtime', sourceType: null,
      reason: `Research runtime snapshot is ${research.availability}`,
    })
  } else {
    const runtime = research.snapshot.runtime
    for (const workload of runtime.circuits.workloads) {
      for (const target of workload.targets) {
        if (!target.circuitOpen) continue
        const probe = runtime.circuitNextProbes.find((row) => row.workload === workload.workload
          && row.provider === target.provider && row.model === target.model)?.nextProbeAt ?? null
        for (const sourceType of runtime.sources) items.push({
          code: 'PROVIDER_CIRCUIT_OPEN', sourceType,
          stage: workload.workload.includes('deep') || workload.workload.includes('investigate')
            ? 'deep_research' : 'synthesis',
          provider: target.provider, queueAgeMs: input.status.sources[sourceType]?.oldestReadyAgeMs ?? null,
          nextProbeAt: probe,
          message: 'Research provider circuit is open', suggestedCommand: 'pnpm feed-v3:status',
        })
      }
    }
    const deep = runtime.deep
    if (!deep || deep.incomplete) unavailableChecks.push({
      check: 'deep_audit', sourceType: null,
      reason: deep ? 'Deep orphan audit is incomplete' : 'Deep runtime audit is unavailable',
    })
    if (deep && (deep.suspectedOrphans > 0 || deep.unregisteredArtifacts > 0)) {
      for (const sourceType of runtime.sources) items.push({
        code: 'CONTAINED_JOB_SURVIVED_DEADLINE', sourceType, stage: 'deep_research', provider: null,
        queueAgeMs: null, nextProbeAt: null,
        message: 'Deep containment audit found a surviving or unregistered artifact',
        suggestedCommand: 'pnpm feed-v3:deep-orphan-audit',
      })
    }
  }

  const entity = input.runtime.entityRuntime
  if (entity.availability !== 'current' || !entity.snapshot) unavailableChecks.push({
    check: 'entity_runtime', sourceType: null, reason: `Entity runtime snapshot is ${entity.availability}`,
  })
  else for (const target of entity.snapshot.circuit.targets) {
    if (!target.circuitOpen) continue
    const entitySources = sourceTypes.filter((sourceType) => (input.status.sources[sourceType]?.byStage.entity.total ?? 0) > 0)
    for (const sourceType of entitySources.length > 0 ? entitySources : sourceTypes) items.push({
      code: 'PROVIDER_CIRCUIT_OPEN', sourceType, stage: 'entity_manager', provider: target.provider,
      queueAgeMs: input.status.sources[sourceType]?.oldestReadyAgeMs ?? null,
      nextProbeAt: target.nextProbeAt,
      message: 'Entity provider circuit is open', suggestedCommand: 'pnpm feed-v3:status',
    })
  }

  const unique = deduplicate(items)
  const unavailable = unavailableChecks.some((item) => item.check === 'policy')
    && unavailableChecks.some((item) => item.check === 'research_runtime')
    && unavailableChecks.some((item) => item.check === 'entity_runtime')
  return {
    schemaVersion: OPERATIONAL_ALERT_REPORT_SCHEMA_VERSION,
    generatedAt: input.status.generatedAt,
    availability: unavailableChecks.length === 0 ? 'available' : unavailable ? 'unavailable' : 'partial',
    items: unique,
    unavailableChecks,
  }
}

function deduplicate(items: OperationalAlertV1[]): OperationalAlertV1[] {
  const seen = new Set<string>()
  return items.filter((item) => {
    const key = JSON.stringify([item.code, item.sourceType, item.stage, item.provider])
    if (seen.has(key)) return false
    seen.add(key)
    return true
  }).sort((a, b) => a.sourceType.localeCompare(b.sourceType) || a.code.localeCompare(b.code))
}

function integer(value: unknown, name: string, minimum: number): number {
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < minimum) throw new Error(`${name} must be an integer >= ${minimum}`)
  return parsed
}
