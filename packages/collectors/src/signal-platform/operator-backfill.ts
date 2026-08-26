import type { Signal, TriageOutcome } from './contracts'
import { stableContractId } from './adapters/identity'
import type { VerifiedBackupReceipt, RecoveryBackupPort } from './operator-recovery'
import type { SourceSignalIntakePort } from './source-intake'

export const BACKFILL_OPERATION_SCHEMA_VERSION = 'myboon.signal_backfill_operation.v1' as const

export interface LegacySignalBackfillFilters {
  sourceType?: Extract<Signal['sourceType'], 'news' | 'polymarket'>
  legacyId?: string
  since?: string
  until?: string
}

export interface LegacySignalBackfillCandidate {
  sourceType: Extract<Signal['sourceType'], 'news' | 'polymarket'>
  legacyId: string
  observedAt: string
  signal: Signal
}

/** Legacy readers are read-only and must not claim or update source rows. */
export interface LegacySignalBackfillReadPort {
  readonly sourceType: LegacySignalBackfillCandidate['sourceType']
  list(input: {
    filters: Omit<LegacySignalBackfillFilters, 'sourceType'>
    limit: number
  }): Promise<LegacySignalBackfillCandidate[]>
}

export interface LegacySignalBackfillIntakePort {
  readonly sourceType: LegacySignalBackfillCandidate['sourceType']
  readonly intake: SourceSignalIntakePort
}

export interface LegacySignalBackfillCommand {
  apply?: boolean
  batchSize?: number
  filters?: LegacySignalBackfillFilters
  now: string
  operationId?: string
  backupReceipt?: VerifiedBackupReceipt
}

export interface LegacySignalBackfillRow {
  sourceType: LegacySignalBackfillCandidate['sourceType']
  legacyId: string
  signalId: string
  outcome: 'would_evaluate' | 'inserted' | 'duplicate' | 'failed'
  triageOutcome: TriageOutcome | null
  signalInserted: boolean
  decisionInserted: boolean
  errorCode: 'CANONICAL_BACKFILL_FAILED' | null
}

export interface LegacySignalBackfillResult {
  schemaVersion: typeof BACKFILL_OPERATION_SCHEMA_VERSION
  operationId: string
  mode: 'dry_run' | 'apply'
  filters: LegacySignalBackfillFilters
  batchSize: number
  matchedCount: number
  truncated: boolean
  backup: { receiptId: string; verifiedAt: string; sources: Signal['sourceType'][] } | null
  rows: LegacySignalBackfillRow[]
}

export interface ParsedLegacySignalBackfillArgs {
  apply: boolean
  batchSize: number
  filters: LegacySignalBackfillFilters
}

export function parseLegacySignalBackfillArgs(args: string[]): ParsedLegacySignalBackfillArgs {
  let apply = false
  let batchSize = 25
  const filters: LegacySignalBackfillFilters = {}
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === '--apply') { apply = true; continue }
    const value = args[index + 1]
    if (!value || value.startsWith('--')) throw new Error(`${arg} requires a value`)
    if (arg === '--batch') batchSize = bounded(Number(value), 1, 500, 'batchSize')
    else if (arg === '--source') filters.sourceType = value as LegacySignalBackfillFilters['sourceType']
    else if (arg === '--legacy-id') filters.legacyId = value
    else if (arg === '--since') filters.since = value
    else if (arg === '--until') filters.until = value
    else throw new Error(`Unknown backfill argument: ${arg}`)
    index += 1
  }
  return { apply, batchSize, filters: validateFilters(filters) }
}

/**
 * Bounded, append-only migration/evaluation operator. Dry-run is the default.
 * Apply is fail-closed behind a verified backup and may write only through an
 * observe+evaluation intake, so no work or legacy status can be mutated.
 */
export class LegacySignalBackfillOperator {
  private readonly readers: ReadonlyMap<LegacySignalBackfillCandidate['sourceType'], LegacySignalBackfillReadPort>
  private readonly intakes: ReadonlyMap<LegacySignalBackfillCandidate['sourceType'], SourceSignalIntakePort>

  constructor(input: {
    readers: LegacySignalBackfillReadPort[]
    intakes: LegacySignalBackfillIntakePort[]
    backupPort?: RecoveryBackupPort | null
  }) {
    this.readers = uniqueBySource(input.readers, 'reader')
    uniqueBySource(input.intakes, 'intake')
    this.intakes = new Map(input.intakes.map((entry) => [entry.sourceType, entry.intake]))
    this.backupPort = input.backupPort ?? null
  }

  private readonly backupPort: RecoveryBackupPort | null

  async run(command: LegacySignalBackfillCommand): Promise<LegacySignalBackfillResult> {
    timestamp(command.now, 'now')
    const filters = validateFilters(command.filters ?? {})
    const batchSize = bounded(command.batchSize ?? 25, 1, 500, 'batchSize')
    const readers = filters.sourceType
      ? [this.readers.get(filters.sourceType)].filter((item): item is LegacySignalBackfillReadPort => Boolean(item))
      : [...this.readers.values()]
    const candidates = (await Promise.all(readers.map((reader) => reader.list({
      filters: { legacyId: filters.legacyId, since: filters.since, until: filters.until },
      limit: batchSize + 1,
    })))).flat()
      .filter((item) => matchesFilters(item, filters))
      .sort((a, b) => Date.parse(a.observedAt) - Date.parse(b.observedAt)
        || a.sourceType.localeCompare(b.sourceType) || a.legacyId.localeCompare(b.legacyId))
    const truncated = candidates.length > batchSize
    const selected = candidates.slice(0, batchSize)
    const operationId = command.operationId?.trim() || stableContractId(
      'backfill', command.now, JSON.stringify(filters), String(batchSize),
    )

    if (!command.apply) return result(command, filters, batchSize, operationId, selected, truncated, null,
      selected.map((item) => row(item, 'would_evaluate')))

    const sources = [...new Set(selected.map((item) => item.sourceType))]
    const receipt = command.backupReceipt
      ?? await this.requireBackup().createVerifiedBackup({ sources, requestedAt: command.now })
    validateBackup(receipt, sources)
    const rows: LegacySignalBackfillRow[] = []
    for (const candidate of selected) {
      const intake = this.intakes.get(candidate.sourceType)
      if (!intake || intake.mode !== 'observe') {
        rows.push(row(candidate, 'failed'))
        continue
      }
      try {
        const appended = await intake.ingest(candidate.signal)
        rows.push({
          ...row(candidate, appended.signalInserted || appended.decisionInserted ? 'inserted' : 'duplicate'),
          triageOutcome: appended.decision?.outcome ?? null,
          signalInserted: appended.signalInserted,
          decisionInserted: appended.decisionInserted,
          errorCode: null,
        })
      } catch {
        rows.push(row(candidate, 'failed'))
      }
    }
    return result(command, filters, batchSize, operationId, selected, truncated, receipt, rows)
  }

  private requireBackup(): RecoveryBackupPort {
    if (!this.backupPort) throw new Error('Backfill apply requires a verified backup receipt or backup port')
    return this.backupPort
  }
}

function result(
  command: LegacySignalBackfillCommand,
  filters: LegacySignalBackfillFilters,
  batchSize: number,
  operationId: string,
  selected: LegacySignalBackfillCandidate[],
  truncated: boolean,
  receipt: VerifiedBackupReceipt | null,
  rows: LegacySignalBackfillRow[],
): LegacySignalBackfillResult {
  return {
    schemaVersion: BACKFILL_OPERATION_SCHEMA_VERSION,
    operationId,
    mode: command.apply ? 'apply' : 'dry_run',
    filters,
    batchSize,
    matchedCount: selected.length,
    truncated,
    backup: receipt ? {
      receiptId: receipt.receiptId, verifiedAt: receipt.verifiedAt, sources: [...receipt.sources],
    } : null,
    rows,
  }
}

function row(
  item: LegacySignalBackfillCandidate,
  outcome: LegacySignalBackfillRow['outcome'],
): LegacySignalBackfillRow {
  return {
    sourceType: item.sourceType,
    legacyId: item.legacyId,
    signalId: item.signal.signalId,
    outcome,
    triageOutcome: null,
    signalInserted: false,
    decisionInserted: false,
    errorCode: outcome === 'failed' ? 'CANONICAL_BACKFILL_FAILED' : null,
  }
}

function matchesFilters(item: LegacySignalBackfillCandidate, filters: LegacySignalBackfillFilters): boolean {
  return (!filters.sourceType || item.sourceType === filters.sourceType)
    && (!filters.legacyId || item.legacyId === filters.legacyId)
    && (!filters.since || item.observedAt >= filters.since)
    && (!filters.until || item.observedAt < filters.until)
}

function validateFilters(input: LegacySignalBackfillFilters): LegacySignalBackfillFilters {
  if (input.sourceType && input.sourceType !== 'news' && input.sourceType !== 'polymarket') {
    throw new Error(`Unsupported backfill source: ${String(input.sourceType)}`)
  }
  if (input.since) timestamp(input.since, 'since')
  if (input.until) timestamp(input.until, 'until')
  if (input.since && input.until && input.since >= input.until) throw new Error('since must precede until')
  return { ...input }
}

function validateBackup(receipt: VerifiedBackupReceipt, required: Signal['sourceType'][]): void {
  timestamp(receipt.verifiedAt, 'backup verifiedAt')
  if (receipt.verified !== true || !receipt.receiptId.trim()) throw new Error('Backfill backup receipt is not verified')
  const missing = required.filter((source) => !receipt.sources.includes(source))
  if (missing.length > 0) throw new Error(`Backfill backup receipt is missing sources: ${missing.join(',')}`)
}

function uniqueBySource<T extends { readonly sourceType: LegacySignalBackfillCandidate['sourceType'] }>(
  values: T[], label: string,
): ReadonlyMap<LegacySignalBackfillCandidate['sourceType'], T> {
  const map = new Map<LegacySignalBackfillCandidate['sourceType'], T>()
  for (const value of values) {
    if (map.has(value.sourceType)) throw new Error(`Duplicate backfill ${label} for ${value.sourceType}`)
    map.set(value.sourceType, value)
  }
  return map
}

function timestamp(value: string, label: string): void {
  if (!Number.isFinite(Date.parse(value))) throw new Error(`${label} must be a timestamp`)
}

function bounded(value: number, min: number, max: number, label: string): number {
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${label} must be ${min}-${max}`)
  return value
}
