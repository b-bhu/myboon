export type PolymarketCatalogSourceKind = 'event' | 'market' | 'sports_rule' | 'sports_tag'
export type PolymarketCatalogReleaseStatus = 'draft' | 'published' | 'archived'

export interface PolymarketSportsRuleConfig {
  windowDays: number
  limit: number
  marketType: 'moneyline'
  /** Set only for sports_tag sources — the Gamma tag whose leagues are expanded. */
  tagId?: string
}

export interface PolymarketCatalogItemInput {
  sourceKind: PolymarketCatalogSourceKind
  sourceSlug: string
  sourceId?: string | null
  conditionId?: string | null
  title?: string
  category?: string | null
  sport?: string | null
  isEnabled?: boolean
  activeFrom?: string | null
  activeUntil?: string | null
  displayOverrides?: Record<string, unknown>
  ruleConfig?: PolymarketSportsRuleConfig | null
}

export interface PolymarketCatalogItem extends Required<Pick<PolymarketCatalogItemInput,
  'sourceKind' | 'sourceSlug' | 'title' | 'isEnabled'>> {
  id: string
  sourceId: string | null
  conditionId: string | null
  category: string | null
  sport: string | null
  position: number
  activeFrom: string | null
  activeUntil: string | null
  displayOverrides: Record<string, unknown>
  ruleConfig: PolymarketSportsRuleConfig | null
}

export interface PolymarketCatalogRelease {
  id: string
  version: number
  revision: number
  status: PolymarketCatalogReleaseStatus
  note: string | null
  createdBy: string | null
  publishedBy: string | null
  createdAt: string
  updatedAt: string
  publishedAt: string | null
  items: PolymarketCatalogItem[]
}

export interface PolymarketCatalogCollectionState {
  collection: {
    key: string
    name: string
    description: string | null
    isEnabled: boolean
    defaultLimit: number
    createdAt: string
    updatedAt: string
  }
  draft: PolymarketCatalogRelease | null
  published: PolymarketCatalogRelease | null
  hasUnpublishedChanges: boolean
}

export interface PolymarketCatalogStore {
  getCollection(key: string): Promise<PolymarketCatalogCollectionState | null>
  saveDraft(input: {
    key: string
    expectedRevision: number | null
    items: PolymarketCatalogItemInput[]
    actor: string
  }): Promise<PolymarketCatalogCollectionState>
  publish(input: {
    key: string
    expectedRevision: number
    actor: string
  }): Promise<PolymarketCatalogCollectionState>
}

export class PolymarketCatalogConflictError extends Error {
  readonly code = 'catalog_revision_conflict'
}

export class PolymarketCatalogValidationError extends Error {
  readonly code = 'catalog_validation_error'
}
