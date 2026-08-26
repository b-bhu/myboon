import type {
  FailureCategory,
  Signal,
  WorkStatus,
} from './contracts'
import { stableContractId } from './adapters/identity'

export const RECOVERY_OPERATION_SCHEMA_VERSION = 'myboon.recovery_operation.v1' as const
export const RECOVERY_AUDIT_EVENT_SCHEMA_VERSION = 'myboon.recovery_event.v1' as const

const FAILURE_CATEGORIES = new Set<FailureCategory>([
  'provider_unavailable', 'provider_rate_limited', 'provider_timeout',
  'provider_authentication', 'circuit_open', 'retrieval_timeout',
  'retrieval_blocked', 'retrieval_unsafe_url', 'budget_exceeded',
  'invalid_structured_output', 'schema_version_mismatch', 'permanent_source_error',
  'entity_resolution_failed', 'storage_transient', 'storage_permanent',
])

export type RecoverySource = Signal['sourceType']
export type RecoveryStage = 'retrieval' | 'deep' | 'synthesis' | 'entity'
export type RecoverableStatus = Extract<WorkStatus, 'expired' | 'dead_letter' | 'retry_wait'>
export type RecoveryTargetStatus = Extract<WorkStatus, 'research_pending' | 'deep_pending' | 'synthesis_pending' | 'entity_pending'>

export interface RecoveryFilters {
  sourceType?: RecoverySource
  stage?: RecoveryStage
  failureCategory?: FailureCategory
  workId?: string
  since?: string
  until?: string
}

export interface RecoveryCandidate {
  sourceType: RecoverySource
  workId: string
  traceId: string
  fromStatus: RecoverableStatus
  targetStatus: RecoveryTargetStatus
  failureCategory: FailureCategory | null
  attemptCount: number
  updatedAt: string
}

export interface RecoveryAuditEventV1 {
  schemaVersion: typeof RECOVERY_AUDIT_EVENT_SCHEMA_VERSION
  eventId: string
  operationId: string
  backupReceiptId: string
  sourceType: RecoverySource
  workId: string
  traceId: string
  fromStatus: RecoverableStatus
  toStatus: RecoveryTargetStatus
  priorFailureCategory: FailureCategory | null
  attemptCount: number
  recoveredAt: string
}

export interface VerifiedBackupReceipt {
  receiptId: string
  verified: true
  verifiedAt: string
  sources: RecoverySource[]
}

export interface RecoveryBackupPort {
  createVerifiedBackup(input: {
    sources: RecoverySource[]
    requestedAt: string
  }): Promise<VerifiedBackupReceipt>
}

export interface RecoveryStorePort {
  readonly sourceType: RecoverySource
  listRecoverable(input: {
    filters: Omit<RecoveryFilters, 'sourceType'>
    limit: number
  }): Promise<RecoveryCandidate[]>
  /** Called only after verified backup and only for explicit apply. */
  prepareApply(): Promise<void>
  recoverCandidate(input: {
    candidate: RecoveryCandidate
    operationId: string
    backupReceiptId: string
    recoveredAt: string
  }): Promise<RecoveryAuditEventV1 | null>
}

export interface RecoveryOperationCommand {
  apply?: boolean
  batchSize?: number
  filters?: RecoveryFilters
  now: string
  operationId?: string
  backupReceipt?: VerifiedBackupReceipt
}

export interface RecoveryOperationRow {
  sourceType: RecoverySource
  workId: string
  fromStatus: RecoverableStatus
  targetStatus: RecoveryTargetStatus
  failureCategory: FailureCategory | null
  attemptCount: number
  outcome: 'would_recover' | 'recovered' | 'cas_lost'
  auditEventId: string | null
}

export interface RecoveryOperationResult {
  schemaVersion: typeof RECOVERY_OPERATION_SCHEMA_VERSION
  operationId: string
  mode: 'dry_run' | 'apply'
  filters: RecoveryFilters
  batchSize: number
  matchedCount: number
  truncated: boolean
  backup: {
    receiptId: string
    verifiedAt: string
    sources: RecoverySource[]
  } | null
  rows: RecoveryOperationRow[]
}

export class CanonicalRecoveryOperator {
  private readonly stores: ReadonlyMap<RecoverySource, RecoveryStorePort>

  constructor(
    stores: RecoveryStorePort[],
    private readonly backupPort: RecoveryBackupPort | null = null,
  ) {
    const registered = new Map<RecoverySource, RecoveryStorePort>()
    for (const store of stores) {
      if (registered.has(store.sourceType)) throw new Error(`Duplicate recovery store for ${store.sourceType}`)
      registered.set(store.sourceType, store)
    }
    this.stores = registered
  }

  async run(command: RecoveryOperationCommand): Promise<RecoveryOperationResult> {
    validateTimestamp(command.now, 'now')
    const filters = validateFilters(command.filters ?? {})
    const batchSize = boundedInteger(command.batchSize ?? 25, 'batchSize', 1, 500)
    const operationId = command.operationId?.trim() || stableContractId(
      'recovery', command.now, canonicalFilterIdentity(filters), String(batchSize),
    )
    const selectedStores = this.selectStores(filters.sourceType)
    const candidates = (await Promise.all(selectedStores.map(async (store) =>
      store.listRecoverable({ filters: withoutSource(filters), limit: batchSize + 1 }),
    )))
      .flat()
      .sort((a, b) => Date.parse(a.updatedAt) - Date.parse(b.updatedAt)
        || a.sourceType.localeCompare(b.sourceType)
        || a.workId.localeCompare(b.workId))
    const truncated = candidates.length > batchSize
    const selected = candidates.slice(0, batchSize)

    if (!command.apply) return {
      schemaVersion: RECOVERY_OPERATION_SCHEMA_VERSION,
      operationId,
      mode: 'dry_run',
      filters,
      batchSize,
      matchedCount: selected.length,
      truncated,
      backup: null,
      rows: selected.map((candidate) => resultRow(candidate, 'would_recover', null)),
    }

    const requiredSources = selectedStores.map((store) => store.sourceType)
    const receipt = command.backupReceipt
      ?? await this.requireBackupPort().createVerifiedBackup({ sources: requiredSources, requestedAt: command.now })
    validateBackupReceipt(receipt, requiredSources)
    await Promise.all(selectedStores.map((store) => store.prepareApply()))

    const rows: RecoveryOperationRow[] = []
    for (const candidate of selected) {
      const store = this.stores.get(candidate.sourceType)
      if (!store) continue
      const event = await store.recoverCandidate({
        candidate,
        operationId,
        backupReceiptId: receipt.receiptId,
        recoveredAt: command.now,
      })
      rows.push(resultRow(candidate, event ? 'recovered' : 'cas_lost', event?.eventId ?? null))
    }
    return {
      schemaVersion: RECOVERY_OPERATION_SCHEMA_VERSION,
      operationId,
      mode: 'apply',
      filters,
      batchSize,
      matchedCount: selected.length,
      truncated,
      backup: {
        receiptId: receipt.receiptId,
        verifiedAt: receipt.verifiedAt,
        sources: [...receipt.sources],
      },
      rows,
    }
  }

  private selectStores(sourceType?: RecoverySource): RecoveryStorePort[] {
    if (!sourceType) return [...this.stores.values()]
    const store = this.stores.get(sourceType)
    return store ? [store] : []
  }

  private requireBackupPort(): RecoveryBackupPort {
    if (!this.backupPort) throw new Error('Apply requires a verified backup receipt or backup port')
    return this.backupPort
  }
}

export interface ParsedRecoveryOperatorArgs {
  apply: boolean
  batchSize: number
  filters: RecoveryFilters
}

/** Pure argument parser. It never opens a database or performs recovery. */
export function parseRecoveryOperatorArgs(args: string[]): ParsedRecoveryOperatorArgs {
  let apply = false
  let batchSize = 25
  const filters: RecoveryFilters = {}
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === '--apply') { apply = true; continue }
    const value = args[index + 1]
    if (!value || value.startsWith('--')) throw new Error(`${arg} requires a value`)
    if (arg === '--batch') batchSize = boundedInteger(Number(value), 'batchSize', 1, 500)
    else if (arg === '--source') filters.sourceType = value as RecoverySource
    else if (arg === '--stage') filters.stage = value as RecoveryStage
    else if (arg === '--failure-category') filters.failureCategory = value as FailureCategory
    else if (arg === '--work-id') filters.workId = value
    else if (arg === '--since') filters.since = value
    else if (arg === '--until') filters.until = value
    else throw new Error(`Unknown recovery argument: ${arg}`)
    index += 1
  }
  return { apply, batchSize, filters: validateFilters(filters) }
}

function resultRow(
  candidate: RecoveryCandidate,
  outcome: RecoveryOperationRow['outcome'],
  auditEventId: string | null,
): RecoveryOperationRow {
  return {
    sourceType: candidate.sourceType,
    workId: candidate.workId,
    fromStatus: candidate.fromStatus,
    targetStatus: candidate.targetStatus,
    failureCategory: candidate.failureCategory,
    attemptCount: candidate.attemptCount,
    outcome,
    auditEventId,
  }
}

function validateFilters(filters: RecoveryFilters): RecoveryFilters {
  if (filters.sourceType && !['news', 'polymarket', 'market_calendar', 'x'].includes(filters.sourceType)) {
    throw new Error(`Unsupported sourceType ${filters.sourceType}`)
  }
  if (filters.stage && !['retrieval', 'deep', 'synthesis', 'entity'].includes(filters.stage)) {
    throw new Error(`Unsupported recovery stage ${filters.stage}`)
  }
  if (filters.failureCategory && !FAILURE_CATEGORIES.has(filters.failureCategory)) {
    throw new Error(`Unsupported failure category ${filters.failureCategory}`)
  }
  if (filters.workId !== undefined && !filters.workId.trim()) throw new Error('workId must not be empty')
  if (filters.since) validateTimestamp(filters.since, 'since')
  if (filters.until) validateTimestamp(filters.until, 'until')
  if (filters.since && filters.until && Date.parse(filters.since) > Date.parse(filters.until)) {
    throw new Error('since must not be after until')
  }
  return { ...filters }
}

function validateBackupReceipt(receipt: VerifiedBackupReceipt, requiredSources: RecoverySource[]): void {
  if (receipt.verified !== true || !receipt.receiptId.trim()) throw new Error('Backup receipt is not verified')
  validateTimestamp(receipt.verifiedAt, 'backup.verifiedAt')
  const covered = new Set(receipt.sources)
  const missing = requiredSources.filter((source) => !covered.has(source))
  if (missing.length > 0) throw new Error(`Verified backup receipt is missing sources: ${missing.join(', ')}`)
}

function withoutSource(filters: RecoveryFilters): Omit<RecoveryFilters, 'sourceType'> {
  const { sourceType: _sourceType, ...rest } = filters
  return rest
}

function canonicalFilterIdentity(filters: RecoveryFilters): string {
  return JSON.stringify(Object.entries(filters).sort(([a], [b]) => a.localeCompare(b)))
}

function validateTimestamp(value: string, label: string): void {
  if (!Number.isFinite(Date.parse(value))) throw new Error(`${label} must be a timestamp`)
}

function boundedInteger(value: number, name: string, minimum: number, maximum: number): number {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`)
  }
  return value
}
