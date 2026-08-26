import { existsSync } from 'node:fs'
import { access } from 'node:fs/promises'
import { resolve } from 'node:path'
import { formatDeepOrphanAudit, parseDeepOrphanAuditArgs } from './orphan-audit-command'
import { auditDeepResearchOrphans, SqliteDeepResearchExecutionRegistry } from './sqlite-execution-registry'
import { NodeSystemdController } from './systemd-controller'

async function main(): Promise<void> {
  const command = parseDeepOrphanAuditArgs(process.argv.slice(2))
  const paths = [...new Set(command.registryPaths.map((path) => resolve(path)))]
  const present = paths.filter((path) => existsSync(path))
  const registries = present.map((path) => new SqliteDeepResearchExecutionRegistry(path, { readOnly: true }))
  try {
    const systemd = new NodeSystemdController()
    const snapshots = await Promise.all(registries.map((registry) => auditDeepResearchOrphans({
      registry, systemd, pathExists,
    })))
    const report = formatDeepOrphanAudit({
      schemaVersion: 'myboon.deep_research_orphan_audit.v1',
      auditedAt: new Date().toISOString(),
      registeredExecutions: snapshots.reduce((sum, snapshot) => sum + snapshot.registeredExecutions, 0),
      entries: snapshots.flatMap((snapshot) => snapshot.entries),
    }, present.length === paths.length, command.registryRequired)
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
    if (report.suspectedOrphans > 0 || report.incompleteAudits > 0) process.exitCode = 2
  } finally {
    registries.forEach((registry) => registry.close())
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
