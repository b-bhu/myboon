import { createHash } from 'node:crypto'

import type { Signal } from './contracts'
import type { SignalPlatformControlPlaneStatus } from './control-plane'
import type { FeedV3RuntimeControlV1, RuntimeControlStage } from './runtime-control'
import type { FeedV3RuntimeStatusAvailability } from './runtime-status'

export const DRAIN_VERIFICATION_SCHEMA_VERSION = 'myboon.feed_v3_drain_verification.v1' as const

export interface ParsedDrainVerificationArgs {
  stage: RuntimeControlStage
  operationId: string
  sources: Signal['sourceType'][]
  timeoutMs: number
  pollMs: number
}

export type DrainVerificationFailure =
  | 'CONTROL_OPERATION_MISMATCH'
  | 'CONTROL_NOT_DRAINING'
  | 'RUNTIME_NOT_CURRENT'
  | 'RUNTIME_NOT_DRAINED'
  | 'RUNTIME_CONTROL_UNAVAILABLE'
  | 'SOURCE_STATUS_UNAVAILABLE'
  | 'LEASED_WORK_REMAINS'

export interface DrainVerificationV1 {
  schemaVersion: typeof DRAIN_VERIFICATION_SCHEMA_VERSION
  generatedAt: string
  stage: RuntimeControlStage
  operationId: string
  controlRevision: number
  controlSha256: string
  sources: Array<{
    sourceType: Signal['sourceType']
    availability: 'available' | 'partial' | 'unavailable'
    leased: number | null
  }>
  runtimeAvailability: 'current' | 'stale' | 'missing' | 'invalid'
  runtimeLifecycle: 'running' | 'draining' | 'stopped' | null
  passed: boolean
  failures: DrainVerificationFailure[]
}

export function parseDrainVerificationArgs(args: string[]): ParsedDrainVerificationArgs {
  const values = new Map<string, string>()
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index]
    const value = args[index + 1]
    if (!flag || !['--stage', '--operation-id', '--sources', '--timeout-ms', '--poll-ms'].includes(flag)) {
      throw new Error(`Unknown drain verification argument: ${flag ?? ''}`)
    }
    if (!value || value.startsWith('--')) throw new Error(`${flag} requires a value`)
    if (values.has(flag)) throw new Error(`${flag} may be provided only once`)
    values.set(flag, value)
  }
  const stage = values.get('--stage')
  if (stage !== 'research' && stage !== 'entity') throw new Error('--stage must be research or entity')
  const operationId = values.get('--operation-id')?.trim()
  if (!operationId) throw new Error('--operation-id is required')
  const sources = parseSources(values.get('--sources'))
  const timeoutMs = boundedInteger(values.get('--timeout-ms') ?? '0', '--timeout-ms', 0, 10 * 60_000)
  const pollMs = boundedInteger(values.get('--poll-ms') ?? '1000', '--poll-ms', 100, 30_000)
  if (timeoutMs > 0 && pollMs > timeoutMs) throw new Error('--poll-ms cannot exceed --timeout-ms')
  return { stage, operationId, sources, timeoutMs, pollMs }
}

export function verifyDrainState(input: {
  generatedAt: string
  stage: RuntimeControlStage
  operationId: string
  sources: Signal['sourceType'][]
  control: FeedV3RuntimeControlV1
  status: SignalPlatformControlPlaneStatus
  runtime: FeedV3RuntimeStatusAvailability
}): DrainVerificationV1 {
  if (!Number.isFinite(Date.parse(input.generatedAt))) throw new Error('generatedAt must be a timestamp')
  const controlStage = input.control.stages[input.stage]
  const runtime = input.stage === 'research' ? input.runtime.researchRuntime : input.runtime.entityRuntime
  const lifecycle = runtime.snapshot?.lifecycleState ?? null
  const failures: DrainVerificationFailure[] = []
  if (controlStage.operationId !== input.operationId) failures.push('CONTROL_OPERATION_MISMATCH')
  if (controlStage.desiredState !== 'draining') failures.push('CONTROL_NOT_DRAINING')
  if (runtime.availability !== 'current') failures.push('RUNTIME_NOT_CURRENT')
  if (lifecycle !== 'draining' && lifecycle !== 'stopped') failures.push('RUNTIME_NOT_DRAINED')
  if (input.stage === 'entity' && runtime.snapshot && 'controlStatus' in runtime.snapshot
    && runtime.snapshot.controlStatus !== 'ok') failures.push('RUNTIME_CONTROL_UNAVAILABLE')
  const sources = [...new Set(input.sources)].sort().map((sourceType) => {
    const source = input.status.sources[sourceType]
    if (!source || source.availability !== 'available') failures.push('SOURCE_STATUS_UNAVAILABLE')
    if (source && source.counts.leased > 0) failures.push('LEASED_WORK_REMAINS')
    return {
      sourceType,
      availability: source?.availability ?? 'unavailable' as const,
      leased: source ? source.counts.leased : null,
    }
  })
  return Object.freeze({
    schemaVersion: DRAIN_VERIFICATION_SCHEMA_VERSION,
    generatedAt: input.generatedAt,
    stage: input.stage,
    operationId: input.operationId,
    controlRevision: input.control.revision,
    controlSha256: createHash('sha256').update(JSON.stringify(input.control)).digest('hex'),
    sources: Object.freeze(sources) as DrainVerificationV1['sources'],
    runtimeAvailability: runtime.availability,
    runtimeLifecycle: lifecycle,
    passed: failures.length === 0,
    failures: Object.freeze([...new Set(failures)]) as DrainVerificationFailure[],
  })
}

function parseSources(value: string | undefined): Signal['sourceType'][] {
  const allowed = new Set<Signal['sourceType']>(['news', 'polymarket', 'market_calendar', 'x'])
  const sources = [...new Set((value ?? '').split(',').map((item) => item.trim()).filter(Boolean))]
  if (sources.length === 0) throw new Error('--sources requires at least one source')
  for (const source of sources) if (!allowed.has(source as Signal['sourceType'])) throw new Error(`unsupported source: ${source}`)
  return sources as Signal['sourceType'][]
}

function boundedInteger(value: string, field: string, minimum: number, maximum: number): number {
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${field} must be an integer between ${minimum} and ${maximum}`)
  }
  return parsed
}
