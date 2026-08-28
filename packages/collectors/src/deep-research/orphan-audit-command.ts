import { isAbsolute } from 'node:path'
import type { DeepResearchDiscoverySnapshot, DeepResearchUnregisteredArtifact } from './orphan-discovery'
import type { DeepResearchOrphanAuditSnapshot } from './sqlite-execution-registry'

export interface DeepResearchOrphanAuditCommand {
  registryPaths: string[]
  registryRequired: boolean
  productionDefault: boolean
  tempRoots: string[]
  profileRoots: string[]
  sandboxExecutables: string[]
  limit: number
  configurationErrors: string[]
}

export interface DeepResearchOrphanAuditReport {
  schemaVersion: 'myboon.deep_research_orphan_audit_report.v2'
  auditedAt: string
  registryPresent: boolean
  registryRequired: boolean
  registeredExecutions: number
  suspectedOrphans: number
  incompleteAudits: number
  incomplete: boolean
  passed: boolean
  errors: string[]
  unregisteredArtifacts: DeepResearchUnregisteredArtifact[]
  inspection: {
    limit: number
    transientUnits: true
    tempRootsConfigured: number
    profileRootsConfigured: number
    sandboxExecutablesConfigured: number
  }
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
): DeepResearchOrphanAuditCommand {
  const many = new Map<string, string[]>()
  const singles = new Map<string, string>()
  const repeatable = new Set(['--temp-root', '--profile-root', '--sandbox-executable'])
  const known = new Set(['--registry', '--limit', ...repeatable])
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index]
    const value = argv[index + 1]?.trim()
    if (!flag || !known.has(flag) || !value) throw new Error(orphanAuditUsage())
    if (repeatable.has(flag)) many.set(flag, [...(many.get(flag) ?? []), value])
    else {
      if (singles.has(flag)) throw new Error(`Duplicate ${flag} flag`)
      singles.set(flag, value)
    }
  }
  const explicitRegistry = singles.get('--registry')
  const tempRoots = many.get('--temp-root') ?? csv(env.FEED_V3_DEEP_RESEARCH_AUDIT_TEMP_ROOTS)
  const profileRoots = many.get('--profile-root') ?? csv(env.FEED_V3_DEEP_RESEARCH_AUDIT_PROFILE_ROOTS)
  const configuredExecutable = env.FEED_V3_DEEP_RESEARCH_WORKER_EXECUTABLE?.trim()
  const sandboxExecutables = many.get('--sandbox-executable')
    ?? (configuredExecutable ? [configuredExecutable] : [])
  if (sandboxExecutables.length > 16 || sandboxExecutables.some((value) => !isAbsolute(value) || value.includes('\0'))) {
    throw new Error('Deep orphan audit sandbox executables must be at most 16 absolute paths')
  }
  const limitValue = singles.get('--limit') ?? env.FEED_V3_DEEP_RESEARCH_AUDIT_LIMIT?.trim() ?? '100'
  if (!/^\d+$/.test(limitValue)) throw new Error('Deep orphan audit limit must be an integer from 1 to 10000')
  const limit = Number(limitValue)
  if (!Number.isInteger(limit) || limit < 1 || limit > 10_000) throw new Error('Deep orphan audit limit must be an integer from 1 to 10000')
  const configurationErrors: string[] = []
  if (tempRoots.length === 0) configurationErrors.push('temp_roots_not_configured')
  if (profileRoots.length === 0) configurationErrors.push('profile_roots_not_configured')
  if (sandboxExecutables.length === 0) configurationErrors.push('sandbox_executable_not_configured')
  return {
    registryPaths: explicitRegistry ? [explicitRegistry] : [
      env.NEWS_SQLITE_PATH?.trim() || '.data/news.sqlite',
      env.PIPELINE_SQLITE_PATH?.trim() || '.data/pipeline.sqlite',
    ],
    registryRequired: true,
    productionDefault: explicitRegistry === undefined,
    tempRoots,
    profileRoots,
    sandboxExecutables: [...new Set(sandboxExecutables)],
    limit,
    configurationErrors,
  }
}

/** Redacts trace/profile/temp paths while retaining enough identity to clean up manually. */
export function formatDeepOrphanAudit(
  snapshot: DeepResearchOrphanAuditSnapshot,
  registryPresent = true,
  registryRequired = false,
  discovery?: DeepResearchDiscoverySnapshot,
  inspection: DeepResearchOrphanAuditReport['inspection'] = {
    limit: 100, transientUnits: true, tempRootsConfigured: 0,
    profileRootsConfigured: 0, sandboxExecutablesConfigured: 0,
  },
  configurationErrors: readonly string[] = [],
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
  const errors = [...new Set([
    ...(discovery?.errors ?? []), ...configurationErrors,
    ...(registryRequired && !registryPresent ? ['registry_unavailable'] : []),
  ])]
  const incompleteAudits = entries.filter((entry) => entry.auditError !== null).length
    + errors.length
  const unregisteredArtifacts = (discovery?.unregisteredArtifacts ?? []).map((item) => ({ ...item }))
  const suspectedOrphans = entries.filter((entry) => entry.suspectedOrphan).length + unregisteredArtifacts.length
  return {
    schemaVersion: 'myboon.deep_research_orphan_audit_report.v2',
    auditedAt: snapshot.auditedAt,
    registryPresent,
    registryRequired,
    registeredExecutions: snapshot.registeredExecutions,
    suspectedOrphans,
    incompleteAudits,
    incomplete: incompleteAudits > 0,
    passed: suspectedOrphans === 0 && incompleteAudits === 0,
    errors,
    unregisteredArtifacts,
    inspection,
    entries,
  }
}

function csv(value: string | undefined): string[] {
  if (!value?.trim()) return []
  const values = value.split(',').map((item) => item.trim()).filter(Boolean)
  if (values.some((item) => item.length > 2_000 || item.includes('\0'))) throw new Error('Deep orphan audit configuration is unsafe or unbounded')
  return [...new Set(values)]
}

function orphanAuditUsage(): string {
  return 'Usage: feed-v3:deep-orphan-audit [--registry path] [--temp-root /dedicated/root] [--profile-root /dedicated/root] [--sandbox-executable /absolute/path] [--limit 100]'
}
