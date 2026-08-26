import { execFile } from 'node:child_process'
import { readdir } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import type { DeepResearchExecutionMetadata } from './types'

const execFileAsync = promisify(execFile)
export type DeepResearchUnregisteredArtifactKind =
  | 'transient_unit' | 'temp_directory' | 'profile_directory' | 'sandbox_executor'

export interface DeepResearchUnregisteredArtifact {
  kind: DeepResearchUnregisteredArtifactKind
  /** Redacted basename/unit/PID identity only; never command lines or full paths. */
  identifier: string
}

export interface DeepResearchOrphanInspectionPort {
  listTransientUnits(limit: number): Promise<readonly string[]>
  listRootEntries(root: string, limit: number): Promise<readonly string[]>
  listSandboxExecutors(executables: readonly string[], limit: number): Promise<readonly { pid: number, argv: string }[]>
}

export interface DeepResearchDiscoverySnapshot {
  auditedAt: string
  activeExecutions: number
  suspectedOrphans: number
  unregisteredArtifacts: readonly DeepResearchUnregisteredArtifact[]
  incomplete: boolean
  errors: readonly string[]
}

export async function discoverDeepResearchOrphans(input: {
  registered: readonly DeepResearchExecutionMetadata[]
  inspector: DeepResearchOrphanInspectionPort
  tempRoots: readonly string[]
  profileRoots: readonly string[]
  sandboxExecutables: readonly string[]
  limit: number
  now?: () => Date
}): Promise<DeepResearchDiscoverySnapshot> {
  if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 10_000) throw new Error('Deep orphan discovery limit is invalid')
  const artifacts: DeepResearchUnregisteredArtifact[] = []
  const errors: string[] = []
  const registeredUnits = new Set(input.registered.map((item) => item.unitName))
  const registeredTemps = new Set(input.registered.map((item) => resolve(item.tempPath)))
  const registeredProfiles = new Set(input.registered.map((item) => resolve(item.profilePath)))
  const inspect = async <T>(code: string, operation: () => Promise<readonly T[]>): Promise<readonly T[]> => {
    try { return await operation() } catch { errors.push(code); return [] }
  }
  const units = await inspect('transient_unit_inspection_failed', () => input.inspector.listTransientUnits(input.limit + 1))
  if (units.length > input.limit) errors.push('transient_unit_inspection_truncated')
  for (const unit of units.slice(0, input.limit)) {
    if (/^myboon-deep-[a-z0-9-]+\.service$/.test(unit) && !registeredUnits.has(unit)) {
      artifacts.push({ kind: 'transient_unit', identifier: unit })
    }
  }
  const inspectedRoots = new Set<string>()
  for (const [kind, roots, registered] of [
    ['temp_directory', input.tempRoots, registeredTemps],
    ['profile_directory', input.profileRoots, registeredProfiles],
  ] as const) {
    for (const root of roots) {
      const resolvedRoot = resolve(root)
      // The contained runtime intentionally permits one dedicated root to own
      // both its workspace and nested browser profile. Scan that physical root
      // once; otherwise the registered workspace basename would be falsely
      // reported as an unregistered top-level profile directory.
      if (inspectedRoots.has(resolvedRoot)) continue
      inspectedRoots.add(resolvedRoot)
      const entries = await inspect(`${kind}_inspection_failed`, () => input.inspector.listRootEntries(resolvedRoot, input.limit + 1))
      if (entries.length > input.limit) errors.push(`${kind}_inspection_truncated`)
      for (const entry of entries.slice(0, input.limit)) {
        const full = resolve(resolvedRoot, entry)
        if (basename(entry).startsWith('myboon-deep-') && !registered.has(full)) artifacts.push({ kind, identifier: basename(entry) })
      }
    }
  }
  const processes = await inspect('sandbox_executor_inspection_failed', () =>
    input.inspector.listSandboxExecutors(input.sandboxExecutables, input.limit + 1))
  if (processes.length > input.limit) errors.push('sandbox_executor_inspection_truncated')
  for (const process of processes.slice(0, input.limit)) {
    const linked = input.registered.some((item) => process.argv.includes(item.tempPath))
    if (!linked) artifacts.push({ kind: 'sandbox_executor', identifier: `pid:${process.pid}` })
  }
  const deduplicated = [...new Map(artifacts.map((item) => [`${item.kind}:${item.identifier}`, Object.freeze(item)])).values()]
  if (deduplicated.length > input.limit) errors.push('artifact_collection_truncated')
  const unique = deduplicated.slice(0, input.limit)
  const now = input.now?.() ?? new Date()
  const expiredRegistered = input.registered.filter((item) => Date.parse(item.deadlineAt) <= now.getTime()).length
  return Object.freeze({
    auditedAt: now.toISOString(), activeExecutions: input.registered.length,
    suspectedOrphans: expiredRegistered + unique.length,
    unregisteredArtifacts: Object.freeze(unique), incomplete: errors.length > 0,
    errors: Object.freeze([...new Set(errors)]),
  })
}

export class NodeDeepResearchOrphanInspector implements DeepResearchOrphanInspectionPort {
  async listTransientUnits(limit: number): Promise<readonly string[]> {
    const { stdout } = await execFileAsync('systemctl', [
      'list-units', '--all', '--type=service', '--plain', '--no-legend', 'myboon-deep-*.service',
    ], { maxBuffer: 256_000 })
    return stdout.split('\n').map((line) => line.trim().split(/\s+/)[0] ?? '').filter(Boolean).slice(0, limit)
  }
  async listRootEntries(root: string, limit: number): Promise<readonly string[]> {
    const entries = await readdir(resolve(root), { withFileTypes: true })
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort().slice(0, limit)
  }
  async listSandboxExecutors(executables: readonly string[], limit: number): Promise<readonly { pid: number, argv: string }[]> {
    if (executables.length === 0) return []
    const approved = new Set(executables.map((value) => resolve(value)))
    const { stdout } = await execFileAsync('ps', ['-eo', 'pid=,args='], { maxBuffer: 512_000 })
    return stdout.split('\n').flatMap((line) => {
      const match = /^\s*(\d+)\s+([^\s]+)(?:\s+(.*))?$/.exec(line)
      if (!match || !approved.has(resolve(match[2]!))) return []
      return [{ pid: Number(match[1]), argv: `${match[2]} ${match[3] ?? ''}`.trim() }]
    }).slice(0, limit)
  }
}
