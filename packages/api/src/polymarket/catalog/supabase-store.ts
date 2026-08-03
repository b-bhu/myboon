import type {
  PolymarketCatalogCollectionState,
  PolymarketCatalogItem,
  PolymarketCatalogItemInput,
  PolymarketCatalogRelease,
  PolymarketCatalogReleaseStatus,
  PolymarketCatalogStore,
} from './contracts.js'
import {
  PolymarketCatalogConflictError,
  PolymarketCatalogValidationError,
} from './contracts.js'

interface CollectionRow {
  collection_key: string
  name: string
  description: string | null
  is_enabled: boolean
  default_limit: number
  created_at: string
  updated_at: string
}

interface ReleaseRow {
  id: string
  version: number
  revision: number
  status: PolymarketCatalogReleaseStatus
  note: string | null
  created_by: string | null
  published_by: string | null
  created_at: string
  updated_at: string
  published_at: string | null
}

interface ItemRow {
  id: string
  release_id: string
  source_kind: 'event' | 'market' | 'sports_rule' | 'sports_tag'
  source_slug: string
  source_id: string | null
  condition_id: string | null
  title: string
  category: string | null
  sport: string | null
  position: number
  is_enabled: boolean
  active_from: string | null
  active_until: string | null
  display_overrides: unknown
  rule_config: unknown
}

type FetchLike = typeof fetch

const COLLECTION_SELECT = 'collection_key,name,description,is_enabled,default_limit,created_at,updated_at'
const RELEASE_SELECT = 'id,version,revision,status,note,created_by,published_by,created_at,updated_at,published_at'
const ITEM_SELECT = 'id,release_id,source_kind,source_slug,source_id,condition_id,title,category,sport,position,is_enabled,active_from,active_until,display_overrides,rule_config'

export class SupabasePolymarketCatalogStore implements PolymarketCatalogStore {
  private readonly restBaseUrl: string

  constructor(
    supabaseUrl: string,
    private readonly serviceRoleKey: string,
    private readonly fetchImpl: FetchLike = globalThis.fetch,
  ) {
    this.restBaseUrl = `${supabaseUrl.replace(/\/$/, '')}/rest/v1`
  }

  async getCollection(key: string): Promise<PolymarketCatalogCollectionState | null> {
    const collectionParams = new URLSearchParams({
      select: COLLECTION_SELECT,
      collection_key: `eq.${key}`,
      limit: '1',
    })
    const collectionRows = await this.readRows<CollectionRow>('polymarket_catalog_collections', collectionParams)
    const collection = collectionRows[0]
    if (!collection) return null

    const releaseParams = new URLSearchParams({
      select: RELEASE_SELECT,
      collection_key: `eq.${key}`,
      status: 'in.(draft,published)',
      order: 'version.desc',
    })
    const releaseRows = await this.readRows<ReleaseRow>('polymarket_catalog_releases', releaseParams)
    const releaseIds = releaseRows.map((release) => release.id)
    const itemRows = releaseIds.length === 0
      ? []
      : await this.readRows<ItemRow>('polymarket_catalog_items', new URLSearchParams({
          select: ITEM_SELECT,
          release_id: `in.(${releaseIds.join(',')})`,
          order: 'position.asc',
        }))

    const releases = releaseRows.map((release) => mapRelease(
      release,
      itemRows.filter((item) => item.release_id === release.id),
    ))
    const draft = releases.find((release) => release.status === 'draft') ?? null
    const published = releases.find((release) => release.status === 'published') ?? null

    return {
      collection: {
        key: collection.collection_key,
        name: collection.name,
        description: collection.description,
        isEnabled: collection.is_enabled,
        defaultLimit: collection.default_limit,
        createdAt: collection.created_at,
        updatedAt: collection.updated_at,
      },
      draft,
      published,
      hasUnpublishedChanges: Boolean(draft && (!published || draft.version !== published.version)),
    }
  }

  async saveDraft(input: {
    key: string
    expectedRevision: number | null
    items: PolymarketCatalogItemInput[]
    actor: string
  }): Promise<PolymarketCatalogCollectionState> {
    await this.callRpc('save_polymarket_catalog_draft', {
      p_collection_key: input.key,
      p_items: input.items,
      p_expected_revision: input.expectedRevision,
      p_actor: input.actor,
    })
    return this.requireCollection(input.key)
  }

  async publish(input: {
    key: string
    expectedRevision: number
    actor: string
  }): Promise<PolymarketCatalogCollectionState> {
    await this.callRpc('publish_polymarket_catalog_draft', {
      p_collection_key: input.key,
      p_expected_revision: input.expectedRevision,
      p_actor: input.actor,
    })
    return this.requireCollection(input.key)
  }

  private async requireCollection(key: string): Promise<PolymarketCatalogCollectionState> {
    const collection = await this.getCollection(key)
    if (!collection) throw new Error(`Polymarket catalog collection disappeared after mutation: ${key}`)
    return collection
  }

  private async readRows<T>(table: string, params: URLSearchParams): Promise<T[]> {
    const res = await this.fetchImpl(`${this.restBaseUrl}/${table}?${params.toString()}`, {
      headers: this.headers(),
      signal: AbortSignal.timeout(10_000),
    })
    if (!res.ok) {
      const detail = (await res.text()).slice(0, 500)
      throw new Error(`Supabase catalog read failed for ${table}: ${res.status}: ${detail}`)
    }
    return res.json() as Promise<T[]>
  }

  private async callRpc(functionName: string, payload: unknown): Promise<void> {
    const res = await this.fetchImpl(`${this.restBaseUrl}/rpc/${functionName}`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10_000),
    })
    if (res.ok) return

    const detail = (await res.text()).slice(0, 1_000)
    if (res.status === 409 || detail.includes('revision conflict') || detail.includes('40001')) {
      throw new PolymarketCatalogConflictError('This collection changed after it was loaded. Reload it before saving again.')
    }
    if (res.status === 400 || detail.includes('22023') || detail.includes('22P02') || detail.includes('23514') || detail.includes('23505')) {
      throw new PolymarketCatalogValidationError('The catalog draft was rejected by the database.')
    }
    throw new Error(`Supabase catalog RPC failed for ${functionName}: ${res.status}: ${detail}`)
  }

  private headers(): Record<string, string> {
    return {
      apikey: this.serviceRoleKey,
      Authorization: `Bearer ${this.serviceRoleKey}`,
      'Content-Type': 'application/json',
    }
  }
}

function mapRelease(release: ReleaseRow, items: ItemRow[]): PolymarketCatalogRelease {
  return {
    id: release.id,
    version: Number(release.version),
    revision: Number(release.revision),
    status: release.status,
    note: release.note,
    createdBy: release.created_by,
    publishedBy: release.published_by,
    createdAt: release.created_at,
    updatedAt: release.updated_at,
    publishedAt: release.published_at,
    items: items.map(mapItem),
  }
}

function mapItem(item: ItemRow): PolymarketCatalogItem {
  return {
    id: item.id,
    sourceKind: item.source_kind,
    sourceSlug: item.source_slug,
    sourceId: item.source_id,
    conditionId: item.condition_id,
    title: item.title,
    category: item.category,
    sport: item.sport,
    position: Number(item.position),
    isEnabled: item.is_enabled,
    activeFrom: item.active_from,
    activeUntil: item.active_until,
    displayOverrides: isRecord(item.display_overrides) ? item.display_overrides : {},
    ruleConfig: mapSportsRuleConfig(item.rule_config),
  }
}

function mapSportsRuleConfig(value: unknown): PolymarketCatalogItem['ruleConfig'] {
  if (!isRecord(value)) return null
  const windowDays = Number(value.windowDays)
  const limit = Number(value.limit)
  if (!Number.isSafeInteger(windowDays) || !Number.isSafeInteger(limit) || value.marketType !== 'moneyline') {
    return null
  }
  const tagId = typeof value.tagId === 'string' && value.tagId.trim() ? value.tagId.trim() : null
  return { windowDays, limit, marketType: 'moneyline', ...(tagId ? { tagId } : {}) }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}
