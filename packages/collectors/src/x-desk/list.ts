import { loadDotenvChain, positiveInteger } from '../pipeline-store/cli-env'
import type { XDeskCandidateStatus } from './types'
import { XDeskStore } from './store'

loadDotenvChain()

const statuses = new Set<XDeskCandidateStatus>(['pending', 'retry_wait', 'ready', 'skipped', 'failed'])
const requested = process.argv[2] ?? 'ready'
if (!statuses.has(requested as XDeskCandidateStatus)) {
  throw new Error(`Status must be one of: ${[...statuses].join(', ')}`)
}

function evidenceUrls(evidence: unknown[]): string[] {
  const urls = new Set<string>()
  const visit = (value: unknown): void => {
    if (typeof value === 'string' && /^https?:\/\//i.test(value)) {
      urls.add(value)
      return
    }
    if (Array.isArray(value)) {
      value.forEach(visit)
      return
    }
    if (value && typeof value === 'object') Object.values(value as Record<string, unknown>).forEach(visit)
  }
  visit(evidence)
  return [...urls].slice(0, 5)
}

const store = new XDeskStore(process.env.X_DESK_DB_PATH?.trim() || undefined)
try {
  const rows = store.list(requested as XDeskCandidateStatus, positiveInteger(process.argv[3], 20))
  console.log(JSON.stringify(rows.map((row) => ({
    candidateId: row.id,
    status: row.status,
    entity: row.entityName ?? row.entitySlug ?? row.entityId,
    postText: row.postText,
    rationale: row.rationale,
    confidence: row.confidence,
    sourceMemoryId: row.memoryId,
    sourceTitle: row.memory.title,
    sourceUrls: evidenceUrls(row.memory.evidence),
    eventAt: row.memory.eventAt,
    changedAt: row.changedAt,
    attempts: row.attemptCount,
    lastError: row.lastError,
  })), null, 2))
} finally {
  store.close()
}
