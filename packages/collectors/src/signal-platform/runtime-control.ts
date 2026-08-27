import { createHash, randomUUID } from 'node:crypto'
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { dirname, isAbsolute, resolve } from 'node:path'

export const RUNTIME_CONTROL_SCHEMA_VERSION = 'myboon.feed_v3_runtime_control.v1' as const
export const RUNTIME_CONTROL_RESULT_SCHEMA_VERSION = 'myboon.feed_v3_runtime_control_result.v1' as const
export const FEED_V3_RUNTIME_CONTROL_PATH_ENV = 'FEED_V3_RUNTIME_CONTROL_PATH' as const
const RUNTIME_CONTROL_LOCK_STALE_MS = 60_000

export type RuntimeControlStage = 'research' | 'entity'
export type RuntimeControlAction = 'drain' | 'resume'
export type RuntimeControlDesiredState = 'running' | 'draining'

export interface RuntimeStageControl {
  desiredState: RuntimeControlDesiredState
  changedAt: string | null
  operationId: string | null
}

export interface FeedV3RuntimeControlV1 {
  schemaVersion: typeof RUNTIME_CONTROL_SCHEMA_VERSION
  revision: number
  updatedAt: string | null
  stages: Record<RuntimeControlStage, RuntimeStageControl>
}

export interface RuntimeControlOperationResult {
  schemaVersion: typeof RUNTIME_CONTROL_RESULT_SCHEMA_VERSION
  mode: 'dry_run' | 'apply'
  stage: RuntimeControlStage
  action: RuntimeControlAction
  changed: boolean
  operationId: string
  current: FeedV3RuntimeControlV1
  proposed: FeedV3RuntimeControlV1
}

export interface RuntimeControlReadPort {
  read(): FeedV3RuntimeControlV1
}

export class RuntimeControlFileError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RuntimeControlFileError'
  }
}

export class FileRuntimeControlStore implements RuntimeControlReadPort {
  readonly path: string

  constructor(path: string) {
    if (!path.trim()) throw new RuntimeControlFileError('Runtime control path is required')
    this.path = resolve(path)
  }

  read(): FeedV3RuntimeControlV1 {
    if (!existsSync(this.path)) return defaultRuntimeControl()
    try {
      return validateRuntimeControl(JSON.parse(readFileSync(this.path, 'utf8')))
    } catch (error) {
      if (error instanceof RuntimeControlFileError) throw error
      throw new RuntimeControlFileError('Runtime control file could not be read or parsed')
    }
  }

  run(input: {
    stage: RuntimeControlStage
    action: RuntimeControlAction
    apply?: boolean
    now: string
  }): RuntimeControlOperationResult {
    validateTimestamp(input.now, 'now')
    const stage = validateStage(input.stage)
    const action = validateAction(input.action)
    if (!input.apply) return buildOperation(this.read(), stage, action, input.now, false)
    return this.withLock(() => {
      const operation = buildOperation(this.read(), stage, action, input.now, true)
      if (operation.changed) this.writeAtomic(operation.proposed)
      return operation
    })
  }

  private withLock<T>(operation: () => T): T {
    mkdirSync(dirname(this.path), { recursive: true })
    const lockPath = `${this.path}.lock`
    let descriptor: number | null = null
    const token = randomUUID()
    let metadataWritten = false
    try {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          descriptor = openSync(lockPath, 'wx', 0o600)
          const metadata = JSON.stringify({ pid: process.pid, token, createdAt: new Date().toISOString() })
          writeFileSync(descriptor, `${metadata}\n`, 'utf8')
          fsyncSync(descriptor)
          metadataWritten = true
          break
        } catch (error) {
          if (!isNodeError(error) || error.code !== 'EEXIST') throw error
          if (attempt === 0 && reclaimAbandonedLock(lockPath)) continue
          throw new RuntimeControlFileError('Another runtime control update is in progress')
        }
      }
      if (descriptor === null) throw new RuntimeControlFileError('Runtime control lock could not be acquired')
      return operation()
    } finally {
      if (descriptor !== null) closeSync(descriptor)
      if (descriptor !== null) {
        try {
          if (!metadataWritten) {
            unlinkSync(lockPath)
          } else {
            const current = JSON.parse(readFileSync(lockPath, 'utf8')) as { token?: unknown }
            if (current.token === token) unlinkSync(lockPath)
          }
        } catch { /* a later update reclaims only a proven abandoned lock */ }
      }
    }
  }

  private writeAtomic(value: FeedV3RuntimeControlV1): void {
    const temporary = `${this.path}.${process.pid}.${randomUUID()}.tmp`
    let descriptor: number | null = null
    try {
      descriptor = openSync(temporary, 'wx', 0o600)
      writeFileSync(descriptor, `${JSON.stringify(value)}\n`, 'utf8')
      fsyncSync(descriptor)
      closeSync(descriptor)
      descriptor = null
      renameSync(temporary, this.path)
      chmodSync(this.path, 0o600)
    } finally {
      if (descriptor !== null) closeSync(descriptor)
      try { unlinkSync(temporary) } catch { /* rename already removed the temporary path */ }
    }
  }
}

export function resolveRuntimeControlPath(
  env: Readonly<Record<string, string | undefined>> = process.env,
  packageDirectory = resolve(__dirname, '..', '..'),
): string {
  const configured = env[FEED_V3_RUNTIME_CONTROL_PATH_ENV]?.trim() || '.data/feed-v3-runtime-control.json'
  return isAbsolute(configured) ? configured : resolve(packageDirectory, configured)
}

export function stageRuntimeControl(
  control: FeedV3RuntimeControlV1,
  stage: RuntimeControlStage,
): RuntimeStageControl {
  return Object.freeze({ ...validateRuntimeControl(control).stages[validateStage(stage)] })
}

export function defaultRuntimeControl(): FeedV3RuntimeControlV1 {
  return Object.freeze({
    schemaVersion: RUNTIME_CONTROL_SCHEMA_VERSION,
    revision: 0,
    updatedAt: null,
    stages: Object.freeze({
      research: Object.freeze({ desiredState: 'running' as const, changedAt: null, operationId: null }),
      entity: Object.freeze({ desiredState: 'running' as const, changedAt: null, operationId: null }),
    }),
  })
}

export function validateRuntimeControl(value: unknown): FeedV3RuntimeControlV1 {
  const record = object(value, 'runtime control')
  if (record.schemaVersion !== RUNTIME_CONTROL_SCHEMA_VERSION) {
    throw new RuntimeControlFileError('Unsupported runtime control schema version')
  }
  const revision = integer(record.revision, 'revision')
  if (revision < 0) throw new RuntimeControlFileError('revision must not be negative')
  const updatedAt = nullableTimestamp(record.updatedAt, 'updatedAt')
  const stages = object(record.stages, 'stages')
  return Object.freeze({
    schemaVersion: RUNTIME_CONTROL_SCHEMA_VERSION,
    revision,
    updatedAt,
    stages: Object.freeze({
      research: validateStageControl(stages.research, 'research'),
      entity: validateStageControl(stages.entity, 'entity'),
    }),
  })
}

function buildOperation(
  current: FeedV3RuntimeControlV1,
  stage: RuntimeControlStage,
  action: RuntimeControlAction,
  now: string,
  apply: boolean,
): RuntimeControlOperationResult {
  const desiredState = action === 'drain' ? 'draining' : 'running'
  const changed = current.stages[stage].desiredState !== desiredState
  const operationId = `runtime_control_${createHash('sha256')
    .update(`${current.revision}|${stage}|${action}|${now}`)
    .digest('hex')}`
  const proposed = changed ? Object.freeze({
    ...current,
    revision: current.revision + 1,
    updatedAt: now,
    stages: Object.freeze({
      ...current.stages,
      [stage]: Object.freeze({ desiredState, changedAt: now, operationId }),
    }),
  }) : current
  return Object.freeze({
    schemaVersion: RUNTIME_CONTROL_RESULT_SCHEMA_VERSION,
    mode: apply ? 'apply' : 'dry_run',
    stage,
    action,
    changed,
    operationId,
    current,
    proposed,
  })
}

function validateStageControl(value: unknown, field: RuntimeControlStage): RuntimeStageControl {
  const record = object(value, `stages.${field}`)
  if (record.desiredState !== 'running' && record.desiredState !== 'draining') {
    throw new RuntimeControlFileError(`stages.${field}.desiredState is unsupported`)
  }
  return Object.freeze({
    desiredState: record.desiredState,
    changedAt: nullableTimestamp(record.changedAt, `stages.${field}.changedAt`),
    operationId: nullableString(record.operationId, `stages.${field}.operationId`),
  })
}

function validateStage(value: string): RuntimeControlStage {
  if (value !== 'research' && value !== 'entity') throw new RuntimeControlFileError(`Unsupported runtime stage: ${value}`)
  return value
}

function validateAction(value: string): RuntimeControlAction {
  if (value !== 'drain' && value !== 'resume') throw new RuntimeControlFileError(`Unsupported runtime action: ${value}`)
  return value
}

function object(value: unknown, field: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new RuntimeControlFileError(`${field} must be an object`)
  }
  return value as Record<string, unknown>
}

function integer(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value)) throw new RuntimeControlFileError(`${field} must be an integer`)
  return value as number
}

function nullableTimestamp(value: unknown, field: string): string | null {
  if (value === null) return null
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) {
    throw new RuntimeControlFileError(`${field} must be null or an ISO timestamp`)
  }
  return value
}

function nullableString(value: unknown, field: string): string | null {
  if (value === null) return null
  if (typeof value !== 'string' || !value.trim()) throw new RuntimeControlFileError(`${field} must be null or non-empty`)
  return value
}

function validateTimestamp(value: string, field: string): void {
  if (!Number.isFinite(Date.parse(value))) throw new RuntimeControlFileError(`${field} must be an ISO timestamp`)
}

function isNodeError(value: unknown): value is NodeJS.ErrnoException {
  return value instanceof Error && 'code' in value
}

function reclaimAbandonedLock(path: string): boolean {
  let ageMs: number
  try {
    ageMs = Math.max(0, Date.now() - statSync(path).mtimeMs)
  } catch (error) {
    return isNodeError(error) && error.code === 'ENOENT'
  }
  try {
    const value = JSON.parse(readFileSync(path, 'utf8')) as { pid?: unknown; token?: unknown }
    if (Number.isSafeInteger(value.pid) && (value.pid as number) > 0 && typeof value.token === 'string') {
      if (isProcessAlive(value.pid as number)) return false
      unlinkSync(path)
      return true
    }
  } catch { /* partial or malformed lock: age gate below */ }
  if (ageMs < RUNTIME_CONTROL_LOCK_STALE_MS) return false
  try {
    unlinkSync(path)
    return true
  } catch (error) {
    return isNodeError(error) && error.code === 'ENOENT'
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return isNodeError(error) && error.code !== 'ESRCH'
  }
}
