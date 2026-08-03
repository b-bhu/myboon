import { deriveCategoryFromText } from '../../curated.js'
import { gammaFetch } from '../read/market-read.js'
import type { PolymarketCatalogItemInput } from './contracts.js'
import { PolymarketCatalogValidationError } from './contracts.js'
import { resolveSportsRuleForSave, resolveSportsTagForSave } from './sports-rules.js'

const SAFE_SLUG_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,255}$/
const RESOLUTION_CONCURRENCY = 8
// A tag spans every league beneath it, so it needs a higher ceiling than a
// single-series rule — cricket alone runs ~57 fixtures in a 14-day window.
export const TAG_RULE_MAX_LIMIT = 100

export async function resolvePolymarketCatalogItems(
  inputs: PolymarketCatalogItemInput[],
): Promise<PolymarketCatalogItemInput[]> {
  const resolved = new Array<PolymarketCatalogItemInput>(inputs.length)
  let nextIndex = 0
  const workers = Array.from(
    { length: Math.min(RESOLUTION_CONCURRENCY, inputs.length) },
    async () => {
      while (nextIndex < inputs.length) {
        const index = nextIndex++
        resolved[index] = await resolvePolymarketCatalogItem(inputs[index])
      }
    },
  )
  await Promise.all(workers)
  return resolved
}

export async function resolvePolymarketCatalogItem(
  input: PolymarketCatalogItemInput,
): Promise<PolymarketCatalogItemInput> {
  const sourceSlug = input.sourceSlug.trim()
  if (!SAFE_SLUG_RE.test(sourceSlug)) {
    throw new PolymarketCatalogValidationError(`Invalid Polymarket slug: ${sourceSlug || '(empty)'}`)
  }

  if (input.sourceKind === 'event') {
    const sport = input.sport?.trim() || null
    if (!sport) {
      throw new PolymarketCatalogValidationError('Sports event entries require a sport for display.')
    }
    const event = await fetchFirst(`events?slug=${encodeURIComponent(sourceSlug)}`, sourceSlug)
    const markets = Array.isArray(event.markets)
      ? event.markets.filter(isRecord)
      : []
    const mainMarket = markets.find((market) => market.slug === event.slug) ?? markets[0]
    if (!mainMarket || !stringValue(mainMarket.gameStartTime ?? event.startTime)) {
      throw new PolymarketCatalogValidationError(
        'Event sources must be match-style sports events. Add an individual market instead.',
      )
    }
    const title = stringValue(event.title) ?? sourceSlug
    return {
      ...input,
      sourceKind: 'event',
      sourceSlug,
      sourceId: stringValue(event.id),
      conditionId: null,
      title,
      category: input.category?.trim() || 'sports',
      sport,
      isEnabled: input.isEnabled ?? true,
      displayOverrides: input.displayOverrides ?? {},
    }
  }

  if (input.sourceKind === 'market') {
    const market = await fetchFirst(`markets?slug=${encodeURIComponent(sourceSlug)}`, sourceSlug)
    const title = stringValue(market.question ?? market.title) ?? sourceSlug
    return {
      ...input,
      sourceKind: 'market',
      sourceSlug,
      sourceId: stringValue(market.id),
      conditionId: stringValue(market.conditionId ?? market.condition_id),
      title,
      category: input.category?.trim() || deriveCategoryFromText(sourceSlug, title),
      sport: input.sport?.trim() || null,
      isEnabled: input.isEnabled ?? true,
      displayOverrides: input.displayOverrides ?? {},
    }
  }

  if (input.sourceKind === 'sports_rule') {
    const ruleConfig = input.ruleConfig
    if (!ruleConfig
      || !Number.isSafeInteger(ruleConfig.windowDays)
      || ruleConfig.windowDays < 1
      || ruleConfig.windowDays > 30
      || !Number.isSafeInteger(ruleConfig.limit)
      || ruleConfig.limit < 1
      || ruleConfig.limit > 50
      || ruleConfig.marketType !== 'moneyline') {
      throw new PolymarketCatalogValidationError(
        'Automatic sports sources require a 1–30 day window and a 1–50 game limit.',
      )
    }
    const resolved = await resolveSportsRuleForSave(sourceSlug.toLowerCase())
    return {
      ...input,
      sourceKind: 'sports_rule',
      sourceSlug: resolved.sportCode,
      sourceId: resolved.seriesId,
      conditionId: null,
      title: resolved.title,
      category: 'sports',
      sport: resolved.displaySport,
      isEnabled: input.isEnabled ?? true,
      displayOverrides: {
        ...(input.displayOverrides ?? {}),
        resolvedSeriesSlug: resolved.seriesSlug,
      },
      ruleConfig,
    }
  }

  if (input.sourceKind === 'sports_tag') {
    const ruleConfig = input.ruleConfig
    if (!ruleConfig
      || !Number.isSafeInteger(ruleConfig.windowDays)
      || ruleConfig.windowDays < 1
      || ruleConfig.windowDays > 30
      || !Number.isSafeInteger(ruleConfig.limit)
      || ruleConfig.limit < 1
      || ruleConfig.limit > TAG_RULE_MAX_LIMIT
      || ruleConfig.marketType !== 'moneyline') {
      throw new PolymarketCatalogValidationError(
        `Automatic sports tags require a 1–30 day window and a 1–${TAG_RULE_MAX_LIMIT} game limit.`,
      )
    }
    const resolved = resolveSportsTagForSave(sourceSlug)
    return {
      ...input,
      sourceKind: 'sports_tag',
      sourceSlug: resolved.slug,
      sourceId: resolved.tagId,
      conditionId: null,
      title: resolved.label,
      category: 'sports',
      sport: resolved.slug,
      isEnabled: input.isEnabled ?? true,
      displayOverrides: input.displayOverrides ?? {},
      ruleConfig: { ...ruleConfig, tagId: resolved.tagId },
    }
  }

  throw new PolymarketCatalogValidationError('sourceKind must be event, market, sports_rule, or sports_tag.')
}

async function fetchFirst(path: string, slug: string): Promise<Record<string, unknown>> {
  const res = await gammaFetch(path)
  if (!res.ok) {
    throw new PolymarketCatalogValidationError(`Polymarket could not validate ${slug}.`)
  }
  const rows = await res.json() as unknown
  if (!Array.isArray(rows) || !isRecord(rows[0])) {
    throw new PolymarketCatalogValidationError(`No Polymarket source was found for ${slug}.`)
  }
  return rows[0]
}

function stringValue(value: unknown): string | null {
  if (typeof value === 'string' && value.trim()) return value.trim()
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}
