import type { SupabaseClient } from '@supabase/supabase-js'
import type {
  EntityKnowledgeEventQuery,
  EntityKnowledgeEventQueryResult,
  EntityKnowledgeQuery,
  EntityKnowledgeQueryPort,
  EntityKnowledgeRow,
} from './entity-knowledge-query'
import { PortBackedEntityKnowledgeReader } from './entity-knowledge-reader'
import { SupabaseEntityKnowledgeQueryPort } from './supabase-entity-knowledge-reader'

/**
 * Row envelope of public.read_managed_entity_knowledge_v1. Its rows already
 * carry exactly the legacy EntityKnowledgeRow keys, and the count is exact
 * only for the event-desc order.
 */
interface ManagedRowsResult {
  rows: unknown[]
  totalCount?: unknown
}

type ManagedArgs = {
  p_order: EntityKnowledgeQuery['order'] | 'event-desc'
  p_entity_id: string | null
  p_memory_ids: string[] | null
  p_since: string | null
  p_memory_types: EntityKnowledgeQuery['memoryTypes'] | null
  p_priority_classes: EntityKnowledgeQuery['priorityClasses'] | null
  p_after_at: string | null
  p_after_id: string | null
  p_limit: number
}

/** Reads the V4 managed store through the read-only RPC, without table access. */
export class SupabaseManagedEntityKnowledgeQueryPort implements EntityKnowledgeQueryPort {
  constructor(private readonly db: SupabaseClient) {}

  async queryMemories(input: EntityKnowledgeQuery): Promise<EntityKnowledgeRow[]> {
    const entityId = input.entityId ? await this.resolveEntityId(input.entityId) : null
    const result = await this.callManagedFunction({
      p_order: input.order,
      p_entity_id: entityId,
      p_memory_ids: input.memoryIds ?? null,
      p_since: input.since ?? null,
      p_memory_types: input.memoryTypes ?? null,
      p_priority_classes: input.priorityClasses ?? null,
      p_after_at: input.after?.at ?? null,
      p_after_id: input.after?.id ?? null,
      p_limit: input.limit,
    }, 'managed entity knowledge query failed', 'managed entity knowledge query returned an invalid result')
    return result.rows as EntityKnowledgeRow[]
  }

  async queryMemoryEvents(input: EntityKnowledgeEventQuery): Promise<EntityKnowledgeEventQueryResult> {
    const entityId = await this.resolveEntityId(input.entityId)
    const result = await this.callManagedFunction({
      p_order: 'event-desc',
      p_entity_id: entityId,
      p_memory_ids: null,
      p_since: null,
      p_memory_types: null,
      p_priority_classes: null,
      p_after_at: input.after?.at ?? null,
      p_after_id: input.after?.id ?? null,
      p_limit: input.limit,
    }, 'managed entity knowledge event query failed', 'managed entity knowledge event query returned an invalid result')
    const totalCount = result.totalCount
    if (typeof totalCount !== 'number' || !Number.isSafeInteger(totalCount) || totalCount < 0) {
      throw new Error('managed entity knowledge event count was unavailable')
    }
    return { rows: result.rows as EntityKnowledgeRow[], totalCount }
  }

  private async callManagedFunction(
    args: ManagedArgs,
    failurePrefix: string,
    invalidResultMessage: string,
  ): Promise<ManagedRowsResult> {
    const { data, error } = await this.db.rpc('read_managed_entity_knowledge_v1', args)
    if (error) throw new Error(`${failurePrefix}: ${error.message}`)
    if (!isRowsResult(data)) throw new Error(invalidResultMessage)
    return data
  }

  private async resolveEntityId(entityId: string): Promise<string> {
    const { data, error } = await this.db.rpc('resolve_entity_redirect_v1', { p_entity_id: entityId })
    if (error) throw new Error(`entity redirect lookup failed: ${error.message}`)
    if (typeof data === 'string' && data) return data
    // Null means the ID is absent from public.entities, e.g. an article-only
    // managed Entity; the read function itself accepts it.
    return entityId
  }
}

function isRowsResult(value: unknown): value is ManagedRowsResult {
  return typeof value === 'object' && value !== null && Array.isArray((value as { rows?: unknown }).rows)
}

/**
 * V4 first, legacy fills in and is the fallback: both ports are queried
 * concurrently and a one-sided failure degrades to the surviving side.
 */
export class DualEntityKnowledgeQueryPort implements EntityKnowledgeQueryPort {
  constructor(
    private readonly managed: EntityKnowledgeQueryPort,
    private readonly legacy: EntityKnowledgeQueryPort,
    private readonly warn: (event: Record<string, unknown>) => void = (event) => console.warn(JSON.stringify(event)),
  ) {}

  async queryMemories(input: EntityKnowledgeQuery): Promise<EntityKnowledgeRow[]> {
    const [managedResult, legacyResult] = await Promise.allSettled([
      this.managed.queryMemories(input),
      this.legacy.queryMemories(input),
    ])
    if (isFulfilled(managedResult) && isFulfilled(legacyResult)) {
      return mergedMemoryRows(managedResult.value, legacyResult.value, input.order, input.limit)
    }
    if (isFulfilled(managedResult)) {
      this.warnFallback('legacy', 'queryMemories', rejectionMessage(legacyResult))
      return managedResult.value
    }
    if (isFulfilled(legacyResult)) {
      this.warnFallback('managed', 'queryMemories', rejectionMessage(managedResult))
      return legacyResult.value
    }
    throw rejectionReason(legacyResult)
  }

  async queryMemoryEvents(input: EntityKnowledgeEventQuery): Promise<EntityKnowledgeEventQueryResult> {
    const [managedResult, legacyResult] = await Promise.allSettled([
      this.managed.queryMemoryEvents(input),
      this.legacy.queryMemoryEvents(input),
    ])
    if (isFulfilled(managedResult) && isFulfilled(legacyResult)) {
      return mergedEventRows(managedResult.value, legacyResult.value, input.limit)
    }
    if (isFulfilled(managedResult)) {
      this.warnFallback('legacy', 'queryMemoryEvents', rejectionMessage(legacyResult))
      return managedResult.value
    }
    if (isFulfilled(legacyResult)) {
      this.warnFallback('managed', 'queryMemoryEvents', rejectionMessage(managedResult))
      return legacyResult.value
    }
    throw rejectionReason(legacyResult)
  }

  private warnFallback(
    failed: 'managed' | 'legacy',
    operation: 'queryMemories' | 'queryMemoryEvents',
    error: string,
  ): void {
    this.warn({
      event: 'entity_knowledge_dual_read_fallback',
      failed,
      operation,
      error,
    })
  }
}

function isFulfilled<T>(result: PromiseSettledResult<T>): result is PromiseFulfilledResult<T> {
  return result.status === 'fulfilled'
}

function rejectionMessage(result: PromiseSettledResult<unknown>): string {
  const reason = result.status === 'rejected' ? result.reason : null
  return reason instanceof Error ? reason.message : String(reason)
}

function rejectionReason(result: PromiseSettledResult<unknown>): unknown {
  return result.status === 'rejected' ? result.reason : undefined
}

function mergedMemoryRows(
  managed: EntityKnowledgeRow[],
  legacy: EntityKnowledgeRow[],
  order: EntityKnowledgeQuery['order'],
  limit: number,
): EntityKnowledgeRow[] {
  return sortByOrder(combineUnique(managed, legacy), order).slice(0, limit)
}

function mergedEventRows(
  managed: EntityKnowledgeEventQueryResult,
  legacy: EntityKnowledgeEventQueryResult,
  limit: number,
): EntityKnowledgeEventQueryResult {
  const rows = combineUnique(managed.rows, legacy.rows).sort((left, right) => {
    const timeComparison = compareTimestamps(String(left.event_at), String(right.event_at))
    if (timeComparison !== 0) return -timeComparison
    return -compareStrings(String(left.id), String(right.id))
  })
  return { rows: rows.slice(0, limit), totalCount: managed.totalCount + legacy.totalCount }
}

function combineUnique(managed: EntityKnowledgeRow[], legacy: EntityKnowledgeRow[]): EntityKnowledgeRow[] {
  const managedIds = new Set(managed.map((row) => String(row.id)))
  return [...managed, ...legacy.filter((row) => !managedIds.has(String(row.id)))]
}

function sortByOrder(rows: EntityKnowledgeRow[], order: EntityKnowledgeQuery['order']): EntityKnowledgeRow[] {
  return [...rows].sort((left, right) => {
    if (order === 'id-asc') return compareStrings(String(left.id), String(right.id))
    const timeField = order === 'observed-desc' ? 'observed_at' : 'updated_at'
    const ascending = order === 'updated-asc'
    const timeComparison = compareTimestamps(String(left[timeField]), String(right[timeField]))
    if (timeComparison !== 0) return ascending ? timeComparison : -timeComparison
    const idComparison = compareStrings(String(left.id), String(right.id))
    return ascending ? idComparison : -idComparison
  })
}

/** Parse-based primary comparison keeps mixed timestamp formats ordered by instant. */
function compareTimestamps(left: string, right: string): number {
  const leftTime = Date.parse(left)
  const rightTime = Date.parse(right)
  if (Number.isFinite(leftTime) && Number.isFinite(rightTime)) {
    return leftTime < rightTime ? -1 : leftTime > rightTime ? 1 : 0
  }
  return compareStrings(left, right)
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

/** Production reader on the V4 managed store only. */
export class SupabaseManagedEntityKnowledgeReader extends PortBackedEntityKnowledgeReader {
  constructor(db: SupabaseClient) {
    super(new SupabaseManagedEntityKnowledgeQueryPort(db))
  }
}

/** Production reader querying V4 and legacy concurrently, legacy as the fallback. */
export class DualEntityKnowledgeReader extends PortBackedEntityKnowledgeReader {
  constructor(db: SupabaseClient, warn?: (event: Record<string, unknown>) => void) {
    super(new DualEntityKnowledgeQueryPort(
      new SupabaseManagedEntityKnowledgeQueryPort(db),
      new SupabaseEntityKnowledgeQueryPort(db),
      warn,
    ))
  }
}