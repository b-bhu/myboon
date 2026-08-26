import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'

import type { InferenceCircuitStatusSnapshot, InferenceTelemetry } from '../inference-gateway'
import type { RuntimeControlDesiredState } from '../signal-platform/runtime-control'
import { CANONICAL_ENTITY_WORKLOAD } from './canonical-planner'

export const ENTITY_RUNTIME_HEALTH_SCHEMA_VERSION = 'myboon.shared_entity_runtime_health.v1' as const

export type EntityRuntimeLifecycleState = 'running' | 'draining' | 'stopped'
export type EntityRuntimeControlStatus = 'ok' | 'unavailable'

export interface EntityRuntimeHealthSnapshot {
  schemaVersion: typeof ENTITY_RUNTIME_HEALTH_SCHEMA_VERSION
  capturedAt: string
  processId: number
  mode: 'active' | 'shadow'
  lifecycleState: EntityRuntimeLifecycleState
  desiredState: RuntimeControlDesiredState
  controlStatus: EntityRuntimeControlStatus
  route: {
    workload: typeof CANONICAL_ENTITY_WORKLOAD
    lastCompletedAt: string | null
    lastSucceededAt: string | null
    provider: string | null
    model: string | null
    succeeded: boolean | null
    durationMs: number | null
  }
  circuit: {
    capturedAt: string
    workload: typeof CANONICAL_ENTITY_WORKLOAD
    ready: boolean | null
    targets: Array<{
      provider: string
      model: string
      circuitOpen: boolean
      nextProbeAt: string | null
    }>
  }
}

export interface EntityRuntimeHealthWriter {
  write(input: Omit<EntityRuntimeHealthSnapshot, 'schemaVersion' | 'processId'>): Promise<void>
}

/** Keeps only bounded route outcome data; prompts, usage, and raw failures never enter this object. */
export class EntityRuntimeHealthTracker {
  private route: EntityRuntimeHealthSnapshot['route'] = emptyRoute()

  observe(event: InferenceTelemetry, observedAt = new Date().toISOString()): void {
    if (event.workload !== CANONICAL_ENTITY_WORKLOAD || !validTimestamp(observedAt)) return
    const succeeded = event.failureCategory === null
    this.route = Object.freeze({
      workload: CANONICAL_ENTITY_WORKLOAD,
      lastCompletedAt: observedAt,
      lastSucceededAt: succeeded ? observedAt : this.route.lastSucceededAt,
      provider: safeRouteIdentity(event.actualProvider),
      model: safeRouteIdentity(event.actualModel),
      succeeded,
      durationMs: boundedDuration(event.durationMs),
    })
  }

  snapshot(input: {
    capturedAt: string
    mode: 'active' | 'shadow'
    lifecycleState: EntityRuntimeLifecycleState
    desiredState: RuntimeControlDesiredState
    controlStatus: EntityRuntimeControlStatus
    circuit?: InferenceCircuitStatusSnapshot | null
  }): Omit<EntityRuntimeHealthSnapshot, 'schemaVersion' | 'processId'> {
    if (!validTimestamp(input.capturedAt)) throw new Error('capturedAt must be a valid timestamp')
    return Object.freeze({
      capturedAt: input.capturedAt,
      mode: input.mode,
      lifecycleState: input.lifecycleState,
      desiredState: input.desiredState,
      controlStatus: input.controlStatus,
      route: Object.freeze({ ...this.route }),
      circuit: circuitHealth(input.circuit, input.capturedAt),
    })
  }
}

export class AtomicEntityRuntimeHealthFile implements EntityRuntimeHealthWriter {
  readonly path: string
  private pending: Promise<void> = Promise.resolve()

  constructor(path: string, private readonly processId = process.pid) {
    this.path = resolve(path)
  }

  write(input: Omit<EntityRuntimeHealthSnapshot, 'schemaVersion' | 'processId'>): Promise<void> {
    const snapshot = validateEntityRuntimeHealthSnapshot({
      schemaVersion: ENTITY_RUNTIME_HEALTH_SCHEMA_VERSION,
      processId: this.processId,
      ...input,
    })
    const operation = this.pending.then(() => this.writeAtomic(snapshot))
    this.pending = operation.catch(() => undefined)
    return operation
  }

  private async writeAtomic(snapshot: EntityRuntimeHealthSnapshot): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true })
    const temporary = `${this.path}.${this.processId}.${randomUUID()}.tmp`
    try {
      await writeFile(temporary, `${JSON.stringify(snapshot)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
      await rename(temporary, this.path)
    } finally {
      await rm(temporary, { force: true }).catch(() => undefined)
    }
  }
}

export type EntityRuntimeHealthRead =
  | { availability: 'missing' | 'invalid', snapshot: null }
  | { availability: 'current' | 'stale', snapshot: EntityRuntimeHealthSnapshot }

export async function readEntityRuntimeHealthSnapshot(input: {
  path: string
  now?: () => number
  staleAfterMs: number
}): Promise<EntityRuntimeHealthRead> {
  if (!Number.isInteger(input.staleAfterMs) || input.staleAfterMs <= 0) {
    throw new Error('staleAfterMs must be a positive integer')
  }
  let contents: string
  try {
    contents = await readFile(resolve(input.path), 'utf8')
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') return { availability: 'missing', snapshot: null }
    throw error
  }
  try {
    const snapshot = validateEntityRuntimeHealthSnapshot(JSON.parse(contents))
    const ageMs = (input.now ?? Date.now)() - Date.parse(snapshot.capturedAt)
    return { availability: ageMs <= input.staleAfterMs ? 'current' : 'stale', snapshot }
  } catch {
    return { availability: 'invalid', snapshot: null }
  }
}

export function validateEntityRuntimeHealthSnapshot(value: unknown): EntityRuntimeHealthSnapshot {
  const record = object(value)
  const route = object(record.route)
  const circuit = object(record.circuit)
  if (record.schemaVersion !== ENTITY_RUNTIME_HEALTH_SCHEMA_VERSION
    || !validTimestamp(record.capturedAt)
    || !Number.isInteger(record.processId) || Number(record.processId) <= 0
    || (record.mode !== 'active' && record.mode !== 'shadow')
    || !['running', 'draining', 'stopped'].includes(String(record.lifecycleState))
    || (record.desiredState !== 'running' && record.desiredState !== 'draining')
    || (record.controlStatus !== 'ok' && record.controlStatus !== 'unavailable')
    || route.workload !== CANONICAL_ENTITY_WORKLOAD
    || circuit.workload !== CANONICAL_ENTITY_WORKLOAD
    || !validTimestamp(circuit.capturedAt)
    || !Array.isArray(circuit.targets)) {
    throw new Error('Invalid shared Entity runtime health snapshot')
  }
  const snapshot = value as EntityRuntimeHealthSnapshot
  validateRoute(snapshot.route)
  if (snapshot.circuit.ready !== null && typeof snapshot.circuit.ready !== 'boolean') {
    throw new Error('Invalid Entity circuit readiness')
  }
  for (const target of snapshot.circuit.targets) validateCircuitTarget(target)
  return Object.freeze({
    schemaVersion: ENTITY_RUNTIME_HEALTH_SCHEMA_VERSION,
    capturedAt: snapshot.capturedAt,
    processId: snapshot.processId,
    mode: snapshot.mode,
    lifecycleState: snapshot.lifecycleState,
    desiredState: snapshot.desiredState,
    controlStatus: snapshot.controlStatus,
    route: Object.freeze({
      workload: CANONICAL_ENTITY_WORKLOAD,
      lastCompletedAt: snapshot.route.lastCompletedAt,
      lastSucceededAt: snapshot.route.lastSucceededAt,
      provider: snapshot.route.provider,
      model: snapshot.route.model,
      succeeded: snapshot.route.succeeded,
      durationMs: snapshot.route.durationMs,
    }),
    circuit: Object.freeze({
      capturedAt: snapshot.circuit.capturedAt,
      workload: CANONICAL_ENTITY_WORKLOAD,
      ready: snapshot.circuit.ready,
      targets: Object.freeze(snapshot.circuit.targets.map((target) => Object.freeze({
        provider: target.provider,
        model: target.model,
        circuitOpen: target.circuitOpen,
        nextProbeAt: target.nextProbeAt,
      }))),
    }) as EntityRuntimeHealthSnapshot['circuit'],
  })
}

function circuitHealth(
  circuit: InferenceCircuitStatusSnapshot | null | undefined,
  capturedAt: string,
): EntityRuntimeHealthSnapshot['circuit'] {
  const route = circuit?.workloads.find((item) => item.workload === CANONICAL_ENTITY_WORKLOAD)
  return Object.freeze({
    capturedAt: circuit && validTimestamp(circuit.capturedAt) ? circuit.capturedAt : capturedAt,
    workload: CANONICAL_ENTITY_WORKLOAD,
    ready: route?.ready ?? null,
    targets: Object.freeze((route?.targets ?? []).flatMap((target) => {
      const provider = safeRouteIdentity(target.provider)
      const model = safeRouteIdentity(target.model)
      if (!provider || !model) return []
      const nextProbeAt = target.circuitOpen && target.retryAfterMs !== null
        ? new Date(Date.parse(circuit!.capturedAt) + Math.max(0, target.retryAfterMs)).toISOString()
        : null
      return [Object.freeze({ provider, model, circuitOpen: target.circuitOpen, nextProbeAt })]
    })),
  }) as EntityRuntimeHealthSnapshot['circuit']
}

function emptyRoute(): EntityRuntimeHealthSnapshot['route'] {
  return Object.freeze({
    workload: CANONICAL_ENTITY_WORKLOAD,
    lastCompletedAt: null,
    lastSucceededAt: null,
    provider: null,
    model: null,
    succeeded: null,
    durationMs: null,
  })
}

function validateRoute(route: EntityRuntimeHealthSnapshot['route']): void {
  for (const timestamp of [route.lastCompletedAt, route.lastSucceededAt]) {
    if (timestamp !== null && !validTimestamp(timestamp)) throw new Error('Invalid Entity route timestamp')
  }
  if (route.provider !== null && safeRouteIdentity(route.provider) !== route.provider) throw new Error('Invalid provider')
  if (route.model !== null && safeRouteIdentity(route.model) !== route.model) throw new Error('Invalid model')
  if (route.succeeded !== null && typeof route.succeeded !== 'boolean') throw new Error('Invalid route success')
  if (route.durationMs !== null && boundedDuration(route.durationMs) !== route.durationMs) throw new Error('Invalid duration')
}

function validateCircuitTarget(target: EntityRuntimeHealthSnapshot['circuit']['targets'][number]): void {
  if (safeRouteIdentity(target.provider) !== target.provider || safeRouteIdentity(target.model) !== target.model
    || typeof target.circuitOpen !== 'boolean'
    || (target.nextProbeAt !== null && !validTimestamp(target.nextProbeAt))) {
    throw new Error('Invalid Entity circuit target')
  }
}

function safeRouteIdentity(value: unknown): string | null {
  return typeof value === 'string'
    && value.length <= 200
    && /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(value)
    && !/(?:bearer|authorization|password|secret|api[_-]?key)|\bsk-/i.test(value)
    ? value
    : null
}

function boundedDuration(value: unknown): number | null {
  return Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= 24 * 60 * 60_000
    ? Number(value)
    : null
}

function validTimestamp(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value))
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected object')
  return value as Record<string, unknown>
}

function isNodeError(value: unknown): value is NodeJS.ErrnoException {
  return value instanceof Error && 'code' in value
}
