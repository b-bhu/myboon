import type { FeaturedMarket } from '../read/featured-markets.js'
import {
  mapGammaEventToFeaturedMarket,
  mapGammaMarketToFeaturedMarket,
} from '../read/featured-markets.js'
import {
  gammaFetchCached,
  getLivePrice,
  registerTokenIds,
} from '../read/market-read.js'
import type {
  PolymarketCatalogItem,
  PolymarketCatalogItemInput,
  PolymarketCatalogRelease,
} from './contracts.js'
import { discoverSportsRuleMarkets, discoverSportsTagMarkets } from './sports-rules.js'

export interface HydratedPolymarketCollection {
  items: FeaturedMarket[]
  categories: string[]
}

const MAX_COLLECTION_OUTPUT = 200

/**
 * Hydrate one already-resolved source without saving it. The internal catalog
 * preview uses this so its fixture list follows the exact same discovery,
 * filtering, limits, deduping, and live-price path as a published release.
 */
export async function hydratePolymarketCatalogItemPreview(
  input: PolymarketCatalogItemInput,
  options: { now?: number } = {},
): Promise<HydratedPolymarketCollection> {
  const now = options.now ?? Date.now()
  const item: PolymarketCatalogItem = {
    id: 'catalog-preview-item',
    sourceKind: input.sourceKind,
    sourceSlug: input.sourceSlug,
    sourceId: input.sourceId ?? null,
    conditionId: input.conditionId ?? null,
    title: input.title?.trim() || input.sourceSlug,
    category: input.category ?? null,
    sport: input.sport ?? null,
    position: 0,
    isEnabled: input.isEnabled ?? true,
    activeFrom: input.activeFrom ?? null,
    activeUntil: input.activeUntil ?? null,
    displayOverrides: input.displayOverrides ?? {},
    ruleConfig: input.ruleConfig ?? null,
  }
  const timestamp = new Date(now).toISOString()
  const release: PolymarketCatalogRelease = {
    id: 'catalog-preview-release',
    version: 1,
    revision: 1,
    status: 'draft',
    note: null,
    createdBy: 'dashboard-preview',
    publishedBy: null,
    createdAt: timestamp,
    updatedAt: timestamp,
    publishedAt: null,
    items: [item],
  }

  return hydratePolymarketCatalogRelease(release, {
    limit: item.ruleConfig?.limit ?? 1,
    now,
    throwOnItemError: true,
  })
}

export async function hydratePolymarketCatalogRelease(
  release: PolymarketCatalogRelease,
  options: { limit?: number; now?: number; throwOnItemError?: boolean } = {},
): Promise<HydratedPolymarketCollection> {
  const now = options.now ?? Date.now()
  const limit = Math.max(1, Math.min(options.limit ?? MAX_COLLECTION_OUTPUT, MAX_COLLECTION_OUTPUT))
  const activeItems = release.items.filter((item) => (
    item.isEnabled
    && (!item.activeFrom || Date.parse(item.activeFrom) <= now)
    && (!item.activeUntil || Date.parse(item.activeUntil) > now)
  ))
  const items: FeaturedMarket[] = []
  const seenSlugs = new Set<string>()

  for (const item of activeItems) {
    if (items.length >= limit) break
    try {
      const hydrated = item.sourceKind === 'sports_tag'
        ? await discoverSportsTagMarkets(item, now)
        : item.sourceKind === 'sports_rule'
          ? await discoverSportsRuleMarkets(item, now)
          : await hydratePinnedItem(item)
      let addedForSource = 0
      for (const featured of hydrated) {
        if (seenSlugs.has(featured.slug)) continue
        seenSlugs.add(featured.slug)
        applyLivePrices(featured)
        items.push(featured)
        addedForSource += 1
        if (items.length >= limit) break
        if ((item.sourceKind === 'sports_rule' || item.sourceKind === 'sports_tag')
          && item.ruleConfig
          && addedForSource >= item.ruleConfig.limit) break
      }
    } catch (error) {
      if (options.throwOnItemError) throw error
      console.error(
        `[api] Skipping Polymarket catalog item ${item.sourceSlug}:`,
        error,
      )
    }
  }

  return {
    items,
    categories: [...new Set(items.map((item) => item.category))],
  }
}

async function hydratePinnedItem(
  item: PolymarketCatalogRelease['items'][number],
): Promise<FeaturedMarket[]> {
  const path = item.sourceKind === 'event'
    ? `events?slug=${encodeURIComponent(item.sourceSlug)}`
    : `markets?slug=${encodeURIComponent(item.sourceSlug)}`
  const rows = await gammaFetchCached<Record<string, unknown>[]>(path)
  const source = Array.isArray(rows) ? rows[0] : null
  if (!source) throw new Error(`No ${item.sourceKind} found for ${item.sourceSlug}`)

  const featured = item.sourceKind === 'event'
    ? mapGammaEventToFeaturedMarket(source, { category: item.category, sport: item.sport })
    : mapGammaMarketToFeaturedMarket(source, { category: item.category, sport: item.sport })
  if (!featured) throw new Error(`Could not map ${item.sourceKind} ${item.sourceSlug}`)
  return [featured]
}

function applyLivePrices(featured: FeaturedMarket): void {
  if (featured.type === 'match') {
    for (const outcome of featured.outcomes ?? []) {
      const tokenId = outcome.clobTokenIds[0]
      if (!tokenId) continue
      registerTokenIds([tokenId])
      const live = getLivePrice(tokenId)
      if (live !== null) outcome.price = live
    }
    return
  }

  const tokenIds = featured.clobTokenIds ?? []
  registerTokenIds(tokenIds)
  const liveYes = tokenIds[0] ? getLivePrice(tokenIds[0]) : null
  const liveNo = tokenIds[1] ? getLivePrice(tokenIds[1]) : null
  if (liveYes !== null) featured.yesPrice = liveYes
  if (liveNo !== null) featured.noPrice = liveNo
}
