import { existsSync } from 'node:fs'
import { access } from 'node:fs/promises'
import { resolve } from 'node:path'
import { packageScriptArgs } from '../cli-args'
import { formatDeepOrphanAudit, parseDeepOrphanAuditArgs } from './orphan-audit-command'
import { discoverDeepResearchOrphans, NodeDeepResearchOrphanInspector, validateDeepResearchAuditRoots } from './orphan-discovery'
import { auditDeepResearchOrphans, SqliteDeepResearchExecutionRegistry } from './sqlite-execution-registry'
import { NodeSystemdController } from './systemd-controller'

async function main(): Promise<void> {
  const command = parseDeepOrphanAuditArgs(packageScriptArgs(process.argv.slice(2)))
  const paths = [...new Set(command.registryPaths.map((path) => resolve(path)))]
  const present = paths.filter((path) => existsSync(path))
  const registries: Array<{ registry: SqliteDeepResearchExecutionRegistry, registered: ReturnType<SqliteDeepResearchExecutionRegistry['list']> }> = []
  let registryInspectionFailed = false
  for (const path of present) {
    let registry: SqliteDeepResearchExecutionRegistry | undefined
    try {
      registry = new SqliteDeepResearchExecutionRegistry(path, { readOnly: true })
      registries.push({ registry, registered: registry.list() })
    } catch {
      registryInspectionFailed = true
      registry?.close()
    }
  }
  try {
    const systemd = new NodeSystemdController()
    const snapshots = await Promise.all(registries.map((item) => auditDeepResearchOrphans({
      registry: { list: () => item.registered }, systemd, pathExists,
    })))
    const registered = registries.flatMap((item) => [...item.registered])
    const tempRoots = validateDeepResearchAuditRoots(command.tempRoots, 'Deep orphan audit temp roots')
    const profileRoots = validateDeepResearchAuditRoots(command.profileRoots, 'Deep orphan audit profile roots')
    const discovery = await discoverDeepResearchOrphans({
      registered,
      inspector: new NodeDeepResearchOrphanInspector(),
      tempRoots,
      profileRoots,
      sandboxExecutables: command.sandboxExecutables,
      limit: command.limit,
    })
    const report = formatDeepOrphanAudit({
      schemaVersion: 'myboon.deep_research_orphan_audit.v1',
      auditedAt: new Date().toISOString(),
      registeredExecutions: snapshots.reduce((sum, snapshot) => sum + snapshot.registeredExecutions, 0),
      entries: snapshots.flatMap((snapshot) => snapshot.entries),
    }, present.length === paths.length && !registryInspectionFailed, command.registryRequired, discovery, {
      limit: command.limit,
      transientUnits: true,
      tempRootsConfigured: tempRoots.length,
      profileRootsConfigured: profileRoots.length,
      sandboxExecutablesConfigured: command.sandboxExecutables.length,
    }, [
      ...command.configurationErrors,
      ...(registryInspectionFailed ? ['registry_inspection_failed'] : []),
    ])
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
    if (report.suspectedOrphans > 0 || report.incompleteAudits > 0) process.exitCode = 2
  } finally {
    registries.forEach(({ registry }) => registry.close())
  }
}

async function pathExists(candidate: string): Promise<boolean> {
  try {
    await access(candidate)
    return true
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ENOTDIR') return false
    throw error
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : 'Deep orphan audit failed'}\n`)
  process.exitCode = 1
})
