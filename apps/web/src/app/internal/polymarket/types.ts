export type PolymarketCatalogSourceKind = 'event' | 'market' | 'sports_rule' | 'sports_tag'

export interface PolymarketSportsRuleConfig {
  windowDays: number
  limit: number
  marketType: 'moneyline'
  /** Set only for sports_tag sources — the Gamma tag whose leagues are expanded. */
  tagId?: string
}

export interface PolymarketSportsTagOption {
  tagId: string
  slug: string
  label: string
}

export interface PolymarketSportsRuleOption {
  sportCode: string
  currentSeriesId: string
  label: string
  image: string | null
}

export interface PolymarketSportsRuleOptionsResponse {
  options: PolymarketSportsRuleOption[]
  defaults: PolymarketSportsRuleConfig
}

export interface PolymarketCatalogItemInput {
  sourceKind: PolymarketCatalogSourceKind
  sourceSlug: string
  category?: string | null
  sport?: string | null
  ruleConfig?: PolymarketSportsRuleConfig | null
}

export interface PolymarketCatalogItem extends PolymarketCatalogItemInput {
  id: string
  title: string
  sourceId: string | null
  conditionId: string | null
  position: number
  isEnabled: boolean
  activeFrom: string | null
  activeUntil: string | null
  displayOverrides: Record<string, unknown>
  ruleConfig: PolymarketSportsRuleConfig | null
}

export interface PolymarketCatalogRelease {
  id: string
  version: number
  revision: number
  status: 'draft' | 'published' | 'archived'
  note: string | null
  createdBy: string | null
  publishedBy: string | null
  createdAt: string
  updatedAt: string
  publishedAt: string | null
  items: PolymarketCatalogItem[]
}

export interface PolymarketCatalogCollectionResponse {
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

export interface SavePolymarketCatalogDraftRequest {
  expectedRevision: number | null
  items: PolymarketCatalogItemInput[]
}

export interface PublishPolymarketCatalogDraftRequest {
  expectedRevision: number
}
