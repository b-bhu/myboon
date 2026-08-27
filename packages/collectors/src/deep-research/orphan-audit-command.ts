import type { DeepResearchOrphanAuditSnapshot } from './sqlite-execution-registry'

export interface DeepResearchOrphanAuditReport {
  schemaVersion: 'myboon.deep_research_orphan_audit_report.v1'
  auditedAt: string
  registryPresent: boolean
  registryRequired: boolean
  registeredExecutions: number
  suspectedOrphans: number
  incompleteAudits: number
  entries: Array<{
    unitName: string
    jobId: string
    workId: string
    deadlineAt: string
    unitActive: boolean | null
    tempPathPresent: boolean | null
    deadlineExpired: boolean
    suspectedOrphan: boolean
    auditError: 'systemd_status_unavailable' | 'filesystem_status_unavailable' | null
  }>
}

export function parseDeepOrphanAuditArgs(
  argv: string[],
  env: NodeJS.ProcessEnv = process.env,
): { registryPaths: string[]; registryRequired: boolean; productionDefault: boolean } {
  if (argv.length === 0) {
    return {
      registryPaths: [env.NEWS_SQLITE_PATH?.trim() || '.data/news.sqlite', env.PIPELINE_SQLITE_PATH?.trim() || '.data/pipeline.sqlite'],
      registryRequired: true,
      productionDefault: true,
    }
  }
  if (argv.length !== 2 || argv[0] !== '--registry' || !argv[1]?.trim()) {
    throw new Error('Usage: feed-v3:deep-orphan-audit [--registry /absolute/or/relative/path.sqlite]')
  }
  return { registryPaths: [argv[1].trim()], registryRequired: true, productionDefault: false }
}

/** Redacts trace/profile/temp paths while retaining enough identity to clean up manually. */
export function formatDeepOrphanAudit(
  snapshot: DeepResearchOrphanAuditSnapshot,
  registryPresent = true,
  registryRequired = false,
): DeepResearchOrphanAuditReport {
  const entries = snapshot.entries.map((entry) => {
    const suspectedOrphan = entry.deadlineExpired && (entry.unitActive === true || entry.tempPathPresent === true)
    return {
      unitName: entry.metadata.unitName,
      jobId: entry.metadata.jobId,
      workId: entry.metadata.workId,
      deadlineAt: entry.metadata.deadlineAt,
      unitActive: entry.unitActive,
      tempPathPresent: entry.tempPathPresent,
      deadlineExpired: entry.deadlineExpired,
      suspectedOrphan,
      auditError: entry.auditError,
    }
  })
  return {
    schemaVersion: 'myboon.deep_research_orphan_audit_report.v1',
    auditedAt: snapshot.auditedAt,
    registryPresent,
    registryRequired,
    registeredExecutions: snapshot.registeredExecutions,
    suspectedOrphans: entries.filter((entry) => entry.suspectedOrphan).length,
    incompleteAudits: entries.filter((entry) => entry.auditError !== null).length
      + (registryRequired && !registryPresent ? 1 : 0),
    entries,
  }
}
