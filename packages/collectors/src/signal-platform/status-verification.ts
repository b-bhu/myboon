import { createHash } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'

import {
  parseControlPlaneAlertPolicy,
  type ControlPlaneAlertPolicy,
  type SignalPlatformControlPlaneStatus,
} from './control-plane'
import {
  parseOperationalAlertPolicy,
  type OperationalAlertPolicyV1,
  type OperationalAlertReportV1,
} from './runtime-alerts'
import type { FeedV3RuntimeStatusAvailability } from './runtime-status'

export const STATUS_POLICY_SCHEMA_VERSION = 'myboon.feed_v3_status_policy.v1' as const
export const STATUS_VERIFICATION_SCHEMA_VERSION = 'myboon.feed_v3_status_verification.v1' as const
const MAX_POLICY_BYTES = 1024 * 1024

export interface FeedV3StatusPolicyV1 {
  schemaVersion: typeof STATUS_POLICY_SCHEMA_VERSION
  policyId: string
  reviewedAt: string
  expiresAt: string
  reviewedBy: string
  controlPlaneAlerts: ControlPlaneAlertPolicy
  operationalAlerts: OperationalAlertPolicyV1
}

export interface ParsedStatusArgs {
  strict: boolean
  policyPath: string | null
}

export type StatusVerificationFailure =
  | 'POLICY_EXPIRED'
  | 'CONTROL_PLANE_UNAVAILABLE'
  | 'CONTROL_PLANE_ERRORS_PRESENT'
  | 'CONTROL_PLANE_ALERT_COVERAGE_UNAVAILABLE'
  | 'CONTROL_PLANE_ALERTS_PRESENT'
  | 'OPERATIONAL_ALERT_COVERAGE_GAPS'
  | 'OPERATIONAL_ALERTS_PRESENT'
  | 'RESEARCH_RUNTIME_NOT_CURRENT'
  | 'ENTITY_RUNTIME_NOT_CURRENT'
  | 'SQLITE_WRITE_ERROR_COVERAGE_UNAVAILABLE'

export interface FeedV3StatusVerificationV1 {
  schemaVersion: typeof STATUS_VERIFICATION_SCHEMA_VERSION
  generatedAt: string
  policyId: string
  policySha256: string
  passed: boolean
  failures: StatusVerificationFailure[]
}

export function parseStatusArgs(args: string[]): ParsedStatusArgs {
  let strict = false
  let policyPath: string | null = null
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]
    if (argument === '--strict') {
      if (strict) throw new Error('--strict may be provided only once')
      strict = true
      continue
    }
    if (argument !== '--policy') throw new Error(`Unknown status argument: ${argument ?? ''}`)
    if (policyPath !== null) throw new Error('--policy may be provided only once')
    const value = args[index + 1]
    if (!value || value.startsWith('--')) throw new Error('--policy requires a value')
    if (!isAbsolute(value)) throw new Error('--policy must be an absolute path')
    policyPath = resolve(value)
    index += 1
  }
  if (strict && policyPath === null) throw new Error('--strict requires an independently reviewed --policy file')
  return { strict, policyPath }
}

export function readStatusPolicy(path: string): { policy: FeedV3StatusPolicyV1; sha256: string } {
  if (!isAbsolute(path)) throw new Error('status policy path must be absolute')
  const resolved = resolve(path)
  if (statSync(resolved).size > MAX_POLICY_BYTES) throw new Error(`status policy exceeds ${MAX_POLICY_BYTES} bytes`)
  const bytes = readFileSync(resolved)
  return {
    policy: validateStatusPolicy(JSON.parse(bytes.toString('utf8'))),
    sha256: createHash('sha256').update(bytes).digest('hex'),
  }
}

export function validateStatusPolicy(value: unknown): FeedV3StatusPolicyV1 {
  const record = exactObject(value, [
    'schemaVersion', 'policyId', 'reviewedAt', 'expiresAt', 'reviewedBy',
    'controlPlaneAlerts', 'operationalAlerts',
  ], 'status policy')
  if (record.schemaVersion !== STATUS_POLICY_SCHEMA_VERSION) throw new Error('unsupported status policy schema')
  const policyId = text(record.policyId, 'policyId')
  const reviewedBy = text(record.reviewedBy, 'reviewedBy')
  const reviewedAt = timestamp(record.reviewedAt, 'reviewedAt')
  const expiresAt = timestamp(record.expiresAt, 'expiresAt')
  if (Date.parse(expiresAt) <= Date.parse(reviewedAt)) throw new Error('expiresAt must follow reviewedAt')
  exactObject(record.controlPlaneAlerts, [
    'queueAgeSloMs', 'providerErrorRateThreshold', 'deadLetterCountThreshold',
  ], 'controlPlaneAlerts')
  return Object.freeze({
    schemaVersion: STATUS_POLICY_SCHEMA_VERSION,
    policyId,
    reviewedAt,
    expiresAt,
    reviewedBy,
    controlPlaneAlerts: parseControlPlaneAlertPolicy(record.controlPlaneAlerts),
    operationalAlerts: parseOperationalAlertPolicy(record.operationalAlerts),
  })
}

export function verifyStrictStatus(input: {
  status: SignalPlatformControlPlaneStatus
  runtime: FeedV3RuntimeStatusAvailability
  operationalAlerts: OperationalAlertReportV1
  policy: FeedV3StatusPolicyV1
  policySha256: string
}): FeedV3StatusVerificationV1 {
  const failures: StatusVerificationFailure[] = []
  if (Date.parse(input.policy.expiresAt) <= Date.parse(input.status.generatedAt)) failures.push('POLICY_EXPIRED')
  if (input.status.availability !== 'available') failures.push('CONTROL_PLANE_UNAVAILABLE')
  if (input.status.errors.length > 0) failures.push('CONTROL_PLANE_ERRORS_PRESENT')
  if (input.status.alerts.availability !== 'available') failures.push('CONTROL_PLANE_ALERT_COVERAGE_UNAVAILABLE')
  if (input.status.alerts.items.length > 0) failures.push('CONTROL_PLANE_ALERTS_PRESENT')
  if (input.operationalAlerts.availability !== 'available'
    || input.operationalAlerts.unavailableChecks.length > 0) failures.push('OPERATIONAL_ALERT_COVERAGE_GAPS')
  if (input.operationalAlerts.items.length > 0) failures.push('OPERATIONAL_ALERTS_PRESENT')
  if (input.runtime.researchRuntime.availability !== 'current') failures.push('RESEARCH_RUNTIME_NOT_CURRENT')
  if (input.runtime.entityRuntime.availability !== 'current') failures.push('ENTITY_RUNTIME_NOT_CURRENT')
  if (input.status.sqliteWriteErrors.availability !== 'available'
    || input.status.sqliteWriteErrors.value === null) failures.push('SQLITE_WRITE_ERROR_COVERAGE_UNAVAILABLE')
  return Object.freeze({
    schemaVersion: STATUS_VERIFICATION_SCHEMA_VERSION,
    generatedAt: input.status.generatedAt,
    policyId: input.policy.policyId,
    policySha256: digest(input.policySha256),
    passed: failures.length === 0,
    failures: Object.freeze(failures) as StatusVerificationFailure[],
  })
}

function exactObject(value: unknown, keys: string[], field: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${field} must be an object`)
  const record = value as Record<string, unknown>
  const allowed = new Set(keys)
  for (const key of Object.keys(record)) if (!allowed.has(key)) throw new Error(`unknown ${field} key: ${key}`)
  for (const key of keys) if (!(key in record)) throw new Error(`${field}.${key} is required`)
  return record
}

function text(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 256) throw new Error(`${field} must be non-empty`)
  return value.trim()
}

function timestamp(value: unknown, field: string): string {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) throw new Error(`${field} must be a timestamp`)
  return value
}

function digest(value: string): string {
  if (!/^[a-f0-9]{64}$/.test(value)) throw new Error('policySha256 must be a SHA-256 digest')
  return value
}
