import { randomUUID } from 'node:crypto'
import { mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import type { DeepResearchDiscoverySnapshot } from './orphan-discovery'

export const DEEP_RESEARCH_RUNTIME_SNAPSHOT_VERSION = 'myboon.deep_research_runtime_snapshot.v1' as const

export interface DeepResearchRuntimeSnapshotV1 {
  schemaVersion: typeof DEEP_RESEARCH_RUNTIME_SNAPSHOT_VERSION
  capturedAt: string
  enabled: boolean
  activeExecutions: number
  lastAuditAt: string | null
  suspectedOrphans: number
  unregisteredArtifacts: number
  incomplete: boolean
  errors: readonly string[]
}

export function deepResearchRuntimeSnapshot(input: {
  enabled: boolean
  audit?: DeepResearchDiscoverySnapshot | null
  activeExecutions?: number
  now?: () => Date
}): DeepResearchRuntimeSnapshotV1 {
  const audit = input.audit ?? null
  const snapshot: DeepResearchRuntimeSnapshotV1 = {
    schemaVersion: DEEP_RESEARCH_RUNTIME_SNAPSHOT_VERSION,
    capturedAt: (input.now?.() ?? new Date()).toISOString(), enabled: input.enabled,
    activeExecutions: input.activeExecutions ?? audit?.activeExecutions ?? 0, lastAuditAt: audit?.auditedAt ?? null,
    suspectedOrphans: audit?.suspectedOrphans ?? 0,
    unregisteredArtifacts: audit?.unregisteredArtifacts.length ?? 0,
    incomplete: audit?.incomplete ?? false, errors: Object.freeze([...(audit?.errors ?? [])]),
  }
  for (const value of [snapshot.activeExecutions, snapshot.suspectedOrphans, snapshot.unregisteredArtifacts]) {
    if (!Number.isSafeInteger(value) || value < 0) throw new Error('Deep runtime status count is invalid')
  }
  return Object.freeze(snapshot)
}

export class AtomicDeepResearchRuntimeStatusFile {
  private pending: Promise<void> = Promise.resolve()
  constructor(readonly path: string) { this.path = resolve(path) }
  write(snapshot: DeepResearchRuntimeSnapshotV1): Promise<void> {
    const operation = this.pending.then(async () => {
      await mkdir(dirname(this.path), { recursive: true })
      const temporary = `${this.path}.${process.pid}.${randomUUID()}.tmp`
      try {
        await writeFile(temporary, `${JSON.stringify(snapshot)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
        await rename(temporary, this.path)
      } finally { await rm(temporary, { force: true }).catch(() => undefined) }
    })
    this.pending = operation.catch(() => undefined)
    return operation
  }
}
