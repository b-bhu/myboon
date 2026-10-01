import { createHash } from 'node:crypto'
import type { Signal } from './contracts'
import { canonicalJson } from './canonical-json'
import { validateSignal } from './validation'
import type { SourceSignalIntakePort } from './source-intake'

/**
 * Shared source-side delivery obligation contract.
 *
 * A source (News, Polymarket) owns a local SQLite store. In the same
 * transaction that records a new/material observation it also records the
 * exact validated Signal payload it owes canonical intake. Delivery is
 * at-least-once; canonical intake's stable identity makes an exact replay
 * idempotent. No transaction here ever spans source observation and
 * canonical intake.
 */

export type SourceDeliveryState = 'pending' | 'delivered'

/**
 * Redacted failure marker. Provider and database error text never reaches a
 * source obligation row or a batch report.
 */
export type SourceDeliveryFailureCode = 'SOURCE_SIGNAL_INTAKE_FAILED'

export interface SourceDeliveryObligation {
  signalId: string
  sourceType: Signal['sourceType']
  /** Exact validated adapted Signal payload, frozen at observation time. */
  signal: Signal
  /** Canonical payload digest; reuse of the id with another digest conflicts. */
  payloadDigest: string
  state: SourceDeliveryState
  attemptCount: number
  lastErrorCode: SourceDeliveryFailureCode | null
  createdAt: string
  updatedAt: string
  deliveredAt: string | null
}

/** Outbox reads/writes a source store must provide to drain obligations. */
export interface SourceDeliveryOutbox {
  listPendingSourceDeliveries(limit: number): Promise<SourceDeliveryObligation[]>
  /** Marks acknowledged. Only ever called after intake returned. */
  markSourceDeliveryDelivered(signalId: string): Promise<void>
  recordSourceDeliveryFailure(
    signalId: string,
    code: SourceDeliveryFailureCode
  ): Promise<void>
}

export interface SourceDeliveryFailure {
  signalId: string
  sourceType: Signal['sourceType']
  code: SourceDeliveryFailureCode
}

export interface SourceDeliveryDrainReport {
  attempted: number
  delivered: number
  duplicateDeliveries: number
  failures: SourceDeliveryFailure[]
}

export const DEFAULT_SOURCE_DELIVERY_DRAIN_LIMIT = 100

/** Canonical digest of an adapted Signal payload. */
export function sourceDeliveryDigest(signal: Signal): string {
  // observedAt is the source poll/capture time, not part of News's stable
  // content identity. Canonical intake likewise treats an otherwise identical
  // Signal with a later observedAt as an idempotent duplicate. Keep the first
  // frozen payload and digest the same immutable semantics.
  const { observedAt: _observedAt, ...stablePayload } = signal
  return createHash('sha256').update(canonicalJson(stablePayload), 'utf8').digest('hex')
}

export function emptySourceDeliveryDrainReport(): SourceDeliveryDrainReport {
  return { attempted: 0, delivered: 0, duplicateDeliveries: 0, failures: [] }
}

export function mergeSourceDeliveryDrainReports(
  target: SourceDeliveryDrainReport,
  ...sources: SourceDeliveryDrainReport[]
): SourceDeliveryDrainReport {
  for (const source of sources) {
    target.attempted += source.attempted
    target.delivered += source.delivered
    target.duplicateDeliveries += source.duplicateDeliveries
    target.failures.push(...source.failures)
  }
  return target
}

/**
 * Builds the obligation for a validated payload. Identity is the canonical
 * `signalId`, so the same observation re-derived from a later poll produces
 * the same obligation rather than a second one.
 */
export function buildSourceDeliveryObligation(
  signal: Signal,
): { signalId: string; sourceType: Signal['sourceType']; payloadDigest: string; payloadJson: string } {
  const validated = validateSignal(signal)
  return {
    signalId: validated.signalId,
    sourceType: validated.sourceType,
    payloadDigest: sourceDeliveryDigest(validated),
    payloadJson: canonicalJson(validated),
  }
}

export function parseSourceDeliveryObligation(row: {
  signalId: string
  sourceType: string
  payloadDigest: string
  payloadJson: string
  state: string
  attemptCount: number
  lastErrorCode: string | null
  createdAt: string
  updatedAt: string
  deliveredAt: string | null
}): SourceDeliveryObligation {
  const signal = validateSignal(JSON.parse(row.payloadJson) as unknown)
  if (
    signal.signalId !== row.signalId
    || signal.sourceType !== row.sourceType
    || sourceDeliveryDigest(signal) !== row.payloadDigest
  ) {
    throw new Error(`Source delivery obligation ${row.signalId} failed its identity or digest check`)
  }
  if (row.state !== 'pending' && row.state !== 'delivered') {
    throw new Error(`Source delivery obligation ${row.signalId} has invalid state`)
  }
  return {
    signalId: row.signalId,
    sourceType: row.sourceType as Signal['sourceType'],
    signal,
    payloadDigest: row.payloadDigest,
    state: row.state as SourceDeliveryState,
    attemptCount: row.attemptCount,
    lastErrorCode: row.lastErrorCode as SourceDeliveryFailureCode | null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    deliveredAt: row.deliveredAt,
  }
}

/**
 * Bounded, retry-safe drain of older pending obligations.
 *
 * Every attempt uses the frozen payload, never a reconstruction from a newer
 * poll. Intake success — including an idempotent duplicate — acknowledges the
 * obligation; a thrown intake leaves it pending with a redacted code so the
 * next run retries it. Failures are collected rather than thrown, so legacy
 * source collection is never blocked by canonical delivery.
 */
export async function drainSourceDeliveries(input: {
  store: SourceDeliveryOutbox
  intake: SourceSignalIntakePort
  limit?: number
  /** Prevent a failed older row from being retried twice during one source run. */
  skipSignalIds?: ReadonlySet<string>
}): Promise<SourceDeliveryDrainReport> {
  const limit = input.limit ?? DEFAULT_SOURCE_DELIVERY_DRAIN_LIMIT
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
    throw new Error('Source delivery drain limit must be 1-500')
  }
  const report = emptySourceDeliveryDrainReport()
  if (input.intake.mode === 'off') return report

  const fetchLimit = Math.min(500, limit + (input.skipSignalIds?.size ?? 0))
  const pending = await input.store.listPendingSourceDeliveries(fetchLimit)
  for (const obligation of pending) {
    if (input.skipSignalIds?.has(obligation.signalId)) continue
    report.attempted += 1
    try {
      const result = await input.intake.ingest(obligation.signal)
      if (result.mode !== input.intake.mode || result.signalId !== obligation.signalId) {
        throw new Error('Source intake did not acknowledge the expected active observation')
      }
      await input.store.markSourceDeliveryDelivered(obligation.signalId)
      if (result.signalInserted) report.delivered += 1
      else report.duplicateDeliveries += 1
    } catch {
      // Redacted: the raw provider or database error stays out of source rows.
      try {
        await input.store.recordSourceDeliveryFailure(
          obligation.signalId,
          'SOURCE_SIGNAL_INTAKE_FAILED',
        )
      } catch {
        // Best effort: the obligation stays pending and is retried next run.
      }
      report.failures.push({
        signalId: obligation.signalId,
        sourceType: obligation.sourceType,
        code: 'SOURCE_SIGNAL_INTAKE_FAILED',
      })
    }
  }
  return report
}
