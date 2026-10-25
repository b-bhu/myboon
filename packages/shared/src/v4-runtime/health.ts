/**
 * V4 runtime health snapshot (#444).
 *
 * One snapshot per stage, assembled from an injected health source. No
 * database client, no table names, and no env reads live here: the caller
 * wires the source. Every metric read is independent — a failed read turns
 * that field to null, records a "<field>: <message>" entry, and the snapshot
 * still comes back.
 */

export type V4Stage = 'scout-news' | 'analyst' | 'entity-manager'

/**
 * Injected source of queue and lock facts.
 *
 * TODO(#444 wiring): implement against the #440/#441 queue tables
 */
export interface V4HealthSource {
  /** Items waiting in the stage's queue right now. */
  queueDepth(stage: V4Stage): Promise<number>
  /** Age in ms of the oldest open claim, or null when nothing is claimed. */
  oldestClaimAgeMs(stage: V4Stage): Promise<number | null>
  /**
   * Number of leases that expired inside the window [sinceMs, now]:
   * work that stalled and will be (or was) requeued.
   */
  leaseExpiries(stage: V4Stage, sinceMs: number): Promise<number>
  /** Items parked in the stage's dead-letter queue. */
  deadLetterCount(stage: V4Stage): Promise<number>
  /** Holder of the advisory lock, or null when no process owns it. */
  advisoryLockHolder(): Promise<{ pid: number; since: string } | null>
  /** Signals produced for the stage inside the window [sinceMs, now]. */
  signalsSince(stage: V4Stage, sinceMs: number): Promise<number>
}

export interface V4HealthSnapshot {
  stage: V4Stage
  /** Snapshot time, ISO 8601, from the injected clock. */
  at: string
  // Every metric below is null when its read failed (see errors).
  queueDepth: number | null
  oldestClaimAgeMs: number | null
  leaseExpiriesLastHour: number | null
  deadLetterCount: number | null
  advisoryLockHolder: { pid: number; since: string } | null
  signalsPerHour: number | null
  errors: string[]
}

/** Last-hour window start, in epoch ms. */
const HOUR_MS = 3_600_000

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

/** One metric read: either the value, or the failure's message. */
type MetricResult<T> = { ok: true; value: T } | { ok: false; error: string }

/**
 * Read one metric; never throws. Failure identity stays on the result, so a
 * legitimate null (e.g. an empty advisory-lock slot) is not confused with one.
 */
async function readMetric<T>(read: () => Promise<T>): Promise<MetricResult<T>> {
  try {
    return { ok: true, value: await read() }
  } catch (error) {
    return { ok: false, error: messageOf(error) }
  }
}

export async function takeHealthSnapshot(
  stage: V4Stage,
  source: V4HealthSource,
  now: () => Date = () => new Date(),
): Promise<V4HealthSnapshot> {
  const atTime = now()
  const sinceMs = atTime.getTime() - HOUR_MS

  // Sequential reads keep the errors array order deterministic. Each read is
  // independent: one failure neither stops the others nor poisons them.
  const errors: string[] = []

  const queueDepth = await readMetric(() => source.queueDepth(stage))
  if (!queueDepth.ok) errors.push(`queueDepth: ${queueDepth.error}`)

  const oldestClaimAgeMs = await readMetric(() => source.oldestClaimAgeMs(stage))
  if (!oldestClaimAgeMs.ok) errors.push(`oldestClaimAgeMs: ${oldestClaimAgeMs.error}`)

  const leaseExpiries = await readMetric(() => source.leaseExpiries(stage, sinceMs))
  if (!leaseExpiries.ok) errors.push(`leaseExpiriesLastHour: ${leaseExpiries.error}`)

  const deadLetterCount = await readMetric(() => source.deadLetterCount(stage))
  if (!deadLetterCount.ok) errors.push(`deadLetterCount: ${deadLetterCount.error}`)

  const advisoryLockHolder = await readMetric(() => source.advisoryLockHolder())
  if (!advisoryLockHolder.ok) errors.push(`advisoryLockHolder: ${advisoryLockHolder.error}`)

  const signals = await readMetric(() => source.signalsSince(stage, sinceMs))
  if (!signals.ok) errors.push(`signalsPerHour: ${signals.error}`)

  return {
    stage,
    at: atTime.toISOString(),
    queueDepth: queueDepth.ok ? queueDepth.value : null,
    oldestClaimAgeMs: oldestClaimAgeMs.ok ? oldestClaimAgeMs.value : null,
    leaseExpiriesLastHour: leaseExpiries.ok ? leaseExpiries.value : null,
    deadLetterCount: deadLetterCount.ok ? deadLetterCount.value : null,
    advisoryLockHolder: advisoryLockHolder.ok ? advisoryLockHolder.value : null,
    signalsPerHour: signals.ok ? signals.value : null,
    errors,
  }
}