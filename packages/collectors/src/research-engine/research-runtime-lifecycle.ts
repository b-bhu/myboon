import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'

import type { SharedResearchRuntimeStatus } from './run-shared-research'

export const RESEARCH_RUNTIME_SNAPSHOT_SCHEMA_VERSION = 'myboon.shared_research_runtime_snapshot.v1' as const

export type ResearchRuntimeLifecycleState = 'running' | 'draining' | 'stopped'

export interface ResearchRuntimeRecoverySnapshot {
  lastRunAt: string | null
  recoveredBySource: Readonly<Record<string, readonly string[]>>
}

export interface ResearchRuntimeStatusSnapshot {
  schemaVersion: typeof RESEARCH_RUNTIME_SNAPSHOT_SCHEMA_VERSION
  capturedAt: string
  processId: number
  lifecycleState: ResearchRuntimeLifecycleState
  runtime: SharedResearchRuntimeStatus
  recovery: ResearchRuntimeRecoverySnapshot
}

export interface ResearchRuntimeStatusWriter {
  write(input: {
    capturedAt: string
    lifecycleState: ResearchRuntimeLifecycleState
    runtime: SharedResearchRuntimeStatus
    recovery: ResearchRuntimeRecoverySnapshot
  }): Promise<void>
}

/**
 * Serializes writes and renames a private temporary file in the destination
 * directory, so readers observe either the previous complete snapshot or the
 * next complete snapshot. Runtime configuration and prompts are never stored.
 */
export class AtomicResearchRuntimeStatusFile implements ResearchRuntimeStatusWriter {
  readonly path: string
  private pending: Promise<void> = Promise.resolve()

  constructor(path: string, private readonly processId = process.pid) {
    this.path = resolve(path)
  }

  write(input: {
    capturedAt: string
    lifecycleState: ResearchRuntimeLifecycleState
    runtime: SharedResearchRuntimeStatus
    recovery: ResearchRuntimeRecoverySnapshot
  }): Promise<void> {
    const snapshot = validateSnapshot({
      schemaVersion: RESEARCH_RUNTIME_SNAPSHOT_SCHEMA_VERSION,
      capturedAt: input.capturedAt,
      processId: this.processId,
      lifecycleState: input.lifecycleState,
      runtime: input.runtime,
      recovery: input.recovery,
    })
    const operation = this.pending.then(() => this.writeAtomic(snapshot))
    this.pending = operation.catch(() => undefined)
    return operation
  }

  private async writeAtomic(snapshot: ResearchRuntimeStatusSnapshot): Promise<void> {
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

export type ResearchRuntimeStatusRead =
  | { availability: 'missing', snapshot: null }
  | { availability: 'invalid', snapshot: null }
  | { availability: 'current' | 'stale', snapshot: ResearchRuntimeStatusSnapshot }

export async function readResearchRuntimeStatusSnapshot(input: {
  path: string
  now?: () => number
  staleAfterMs: number
}): Promise<ResearchRuntimeStatusRead> {
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
    const snapshot = validateSnapshot(JSON.parse(contents) as ResearchRuntimeStatusSnapshot)
    const ageMs = (input.now ?? Date.now)() - Date.parse(snapshot.capturedAt)
    return {
      availability: ageMs <= input.staleAfterMs ? 'current' : 'stale',
      snapshot,
    }
  } catch {
    return { availability: 'invalid', snapshot: null }
  }
}

export class ResearchRuntimeDrainTimeoutError extends Error {
  constructor(readonly graceMs: number) {
    super(`Shared Research did not drain within ${graceMs}ms`)
    this.name = 'ResearchRuntimeDrainTimeoutError'
  }
}

export async function awaitDrainWithin(promise: Promise<void>, graceMs: number): Promise<void> {
  if (!Number.isInteger(graceMs) || graceMs <= 0) throw new Error('drain grace must be a positive integer')
  let timer: NodeJS.Timeout | undefined
  try {
    await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new ResearchRuntimeDrainTimeoutError(graceMs)), graceMs)
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

function validateSnapshot(value: ResearchRuntimeStatusSnapshot): ResearchRuntimeStatusSnapshot {
  if (value.schemaVersion !== RESEARCH_RUNTIME_SNAPSHOT_SCHEMA_VERSION
    || !Number.isFinite(Date.parse(value.capturedAt))
    || !Number.isInteger(value.processId) || value.processId <= 0
    || !['running', 'draining', 'stopped'].includes(value.lifecycleState)
    || value.runtime?.schemaVersion !== 'myboon.shared_research_runtime_status.v1'
    || value.recovery === null || typeof value.recovery !== 'object'
    || (value.recovery.lastRunAt !== null && !Number.isFinite(Date.parse(value.recovery.lastRunAt)))) {
    throw new Error('Invalid shared Research runtime status snapshot')
  }
  return Object.freeze({
    ...value,
    runtime: Object.freeze({ ...value.runtime }),
    recovery: Object.freeze({
      lastRunAt: value.recovery.lastRunAt,
      recoveredBySource: Object.freeze(Object.fromEntries(
        Object.entries(value.recovery.recoveredBySource).map(([source, workIds]) => [source, Object.freeze([...workIds])]),
      )),
    }),
  })
}

function isNodeError(value: unknown): value is NodeJS.ErrnoException {
  return value instanceof Error && 'code' in value
}
