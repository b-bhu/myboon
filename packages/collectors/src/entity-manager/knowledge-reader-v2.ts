import type { EntityKnowledgeMemoryV1 } from './entity-knowledge-reader'

/** Additive, storage-neutral contract; no assumptions about physical tables. */
export const KNOWLEDGE_V2_SCHEMA = 'myboon.knowledge.v2' as const
export type KnowledgeStatus = 'active' | 'corrected' | 'retracted'
export interface KnowledgeItemV2 {
  id: string
  revisionId: string
  changeId: string
  status: KnowledgeStatus
  memory: EntityKnowledgeMemoryV1
  entityIds: string[]
  changedAt: string
}
export interface KnowledgeChangeV2 {
  changeId: string
  revisionId: string
  itemId: string
  changedAt: string
  status: KnowledgeStatus
  /** Union of pre-change and post-change memberships, including removals. */
  affectedEntityIds: string[]
  item: KnowledgeItemV2
}
export interface ChangeFilterV2 { entityIds?: string[]; statuses?: KnowledgeStatus[] }
export interface ChangePageV2 {
  schemaVersion: typeof KNOWLEDGE_V2_SCHEMA
  changes: KnowledgeChangeV2[]
  nextCursor: string
  hasMore: boolean
  snapshot: string
}
export type HydrationOutcomeV2 =
  | { outcome: 'complete'; items: KnowledgeItemV2[]; missingIds: [] }
  | { outcome: 'failed'; items: []; missingIds: string[]; reason: string }
  | { outcome: 'truncated'; items: KnowledgeItemV2[]; missingIds: string[]; limit: number }
export interface KnowledgeReaderV2 {
  readChanges(input: { after?: string; limit: number; filter?: ChangeFilterV2; snapshot?: string }): ChangePageV2
  hydrateExact(ids: string[], limit: number): HydrationOutcomeV2
}

/** Fixture-only positions; production needs durable per-consumer fenced checkpoints. */
export class ConsumerCheckpointsV2 {
  private readonly positions = new Map<string, string>()
  get(consumerId: string): string | null { return this.positions.get(required(consumerId, 'consumerId')) ?? null }
  advance(consumerId: string, cursor: string): void {
    this.positions.set(required(consumerId, 'consumerId'), required(cursor, 'cursor'))
  }
}

interface FixtureChange { item: KnowledgeItemV2; changedAt: string; affectedEntityIds: string[] }
interface CursorPayload { v: 2; index: number; filter: string; snapshot: string }
export class InvalidKnowledgeV2CursorError extends Error { constructor() { super('Invalid or mismatched knowledge v2 cursor'); this.name = 'InvalidKnowledgeV2CursorError' } }

/**
 * Deterministic in-memory reference only. Its array index is a fixture snapshot,
 * NOT a safe production publication watermark. Production requires a writer
 * that commits ordered immutable change records atomically with item effects;
 * neither that writer nor its durable watermark exists in this stage.
 */
export class FixtureKnowledgeReaderV2 implements KnowledgeReaderV2 {
  private readonly items = new Map<string, KnowledgeItemV2>()
  private readonly changes: FixtureChange[] = []
  private readonly changeIds = new Set<string>()
  constructor(seed: KnowledgeItemV2[] = []) { for (const item of seed) this.put(item, item.changedAt, item.entityIds) }

  /** Fixture mutation records old and new membership so removal is observable. */
  put(item: KnowledgeItemV2, changedAt = item.changedAt, priorEntityIds: string[] = []): void {
    validateItem(item)
    if (this.changeIds.has(item.changeId)) throw new TypeError(`duplicate change ID: ${item.changeId}`)
    const current = this.items.get(item.id)
    const prior = current?.entityIds ?? priorEntityIds
    const affectedEntityIds = sortedUnique([...prior, ...item.entityIds])
    this.items.set(item.id, cloneItem(item))
    this.changes.push({ item: cloneItem(item), changedAt: iso(changedAt), affectedEntityIds })
    this.changeIds.add(item.changeId)
  }

  readChanges(input: { after?: string; limit: number; filter?: ChangeFilterV2; snapshot?: string }): ChangePageV2 {
    const limit = validLimit(input.limit)
    const filter = normalizeFilter(input.filter)
    const filterKey = JSON.stringify(filter)
    const snapshot = input.snapshot ?? String(this.changes.length)
    if (!/^\d+$/.test(snapshot) || Number(snapshot) > this.changes.length) throw new InvalidKnowledgeV2CursorError()
    let index = 0
    if (input.after) {
      const decoded = decode(input.after)
      if (decoded.filter !== filterKey || decoded.snapshot !== snapshot) throw new InvalidKnowledgeV2CursorError()
      index = decoded.index
    }
    if (!Number.isSafeInteger(index) || index < 0 || index > Number(snapshot)) throw new InvalidKnowledgeV2CursorError()
    const matching: KnowledgeChangeV2[] = []
    let scanIndex = index
    while (scanIndex < Number(snapshot) && matching.length <= limit) {
      const c = this.changes[scanIndex++]!
      if (filter.entityIds && !filter.entityIds.some((id) => c.affectedEntityIds.includes(id))) continue
      if (filter.statuses && !filter.statuses.includes(c.item.status)) continue
      matching.push(toChange(c))
    }
    const hasMore = matching.length > limit
    const page = hasMore ? matching.slice(0, limit) : matching
    // Advance by log position, including filtered records, not by change-ID lookup.
    const nextIndex = hasMore ? scanIndex - 1 : Number(snapshot)
    return { schemaVersion: KNOWLEDGE_V2_SCHEMA, changes: page, nextCursor: encode({ v: 2, index: nextIndex, filter: filterKey, snapshot }), hasMore, snapshot }
  }

  hydrateExact(ids: string[], limit: number): HydrationOutcomeV2 {
    const cap = validLimit(limit)
    const wanted = [...new Set(ids.map((id) => required(id, 'item id'))) ]
    if (wanted.length > cap) return { outcome: 'truncated', items: wanted.slice(0, cap).flatMap((id) => this.items.has(id) ? [cloneItem(this.items.get(id)!)] : []), missingIds: wanted.slice(cap), limit: cap }
    const missingIds = wanted.filter((id) => !this.items.has(id))
    if (missingIds.length) return { outcome: 'failed', items: [], missingIds, reason: 'one or more exact references are unavailable' }
    return { outcome: 'complete', items: wanted.map((id) => cloneItem(this.items.get(id)!)), missingIds: [] }
  }
}
function toChange(c: FixtureChange): KnowledgeChangeV2 { return { changeId: c.item.changeId, revisionId: c.item.revisionId, itemId: c.item.id, changedAt: c.changedAt, status: c.item.status, affectedEntityIds: [...c.affectedEntityIds], item: cloneItem(c.item) } }
function validateItem(i: KnowledgeItemV2): void { required(i.id, 'id'); required(i.revisionId, 'revisionId'); required(i.changeId, 'changeId'); iso(i.changedAt); if (!['active', 'corrected', 'retracted'].includes(i.status)) throw new TypeError('invalid status'); if (i.memory.id !== i.id) throw new TypeError('memory ID must equal stable item ID') }
function cloneItem(i: KnowledgeItemV2): KnowledgeItemV2 { return structuredClone(i) }
function normalizeFilter(f?: ChangeFilterV2): ChangeFilterV2 { return { ...(f?.entityIds ? { entityIds: sortedUnique(f.entityIds) } : {}), ...(f?.statuses ? { statuses: [...new Set(f.statuses)].sort() } : {}) } }
function sortedUnique(xs: string[]): string[] { return [...new Set(xs.map((x) => required(x, 'entity ID')))].sort() }
function validLimit(n: number): number { if (!Number.isSafeInteger(n) || n < 1 || n > 100) throw new RangeError('limit must be an integer from 1 to 100'); return n }
function required(s: string, name: string): string { if (typeof s !== 'string' || !s.trim()) throw new TypeError(`${name} is required`); return s }
function iso(s: string): string { const d = new Date(s); if (!s || Number.isNaN(d.valueOf())) throw new TypeError('timestamp must be valid'); return d.toISOString() }
function encode(p: CursorPayload): string { return Buffer.from(JSON.stringify(p)).toString('base64url') }
function decode(s: string): CursorPayload { try { const p = JSON.parse(Buffer.from(s, 'base64url').toString()) as CursorPayload; if (p.v !== 2 || !Number.isSafeInteger(p.index)) throw 0; return p } catch { throw new InvalidKnowledgeV2CursorError() } }
