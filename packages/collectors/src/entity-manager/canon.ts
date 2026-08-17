import type { EntityRecord, ResearchPacket } from './types'

/**
 * Entity canon: the machinery that makes the entity manager AWARE of the
 * catalog it already owns before it files anything.
 *
 * The failure this closes (observed live 2026-07-30/31): the extraction
 * prompt contained only the research packet - never the catalog - so the
 * model invented a home from its own head ("united-states" for an FOMC
 * decision) and the resolver then only CONFIRMED that guess against exact
 * slug/alias matches. `us-federal-reserve`, sitting right there with eight
 * memories, was never consulted because nothing ever asked "is there a
 * better existing home for this?". Filing was a menu-less decision.
 *
 * Three deterministic pieces, all free of LLM cost:
 *  - shortlistForPacket: the registry lookup. Matches packet text against
 *    entity names/aliases and hands the extraction prompt a ~20-entry menu
 *    of plausible homes instead of the whole catalog (flat prompt cost at
 *    any catalog size).
 *  - nearestEntities / isNearDuplicate: the constructor guardrail. When the
 *    model still proposes a NEW entity, these find existing entities it
 *    likely duplicates - the mechanical kill for `china-taiwan` #5 and
 *    `nvidia-h100`-next-to-`nvidia`.
 *  - normalizeEntityType: collapses the free-formed type zoo (27+ observed
 *    values, `country` AND `nation`, one-off `index`/`legislation`/...)
 *    into a fixed vocabulary at creation time.
 *
 * The same shortlist machinery is intentionally reusable by the research
 * gate later ("new FOMC market - do we have a Fed timeline?") - build once,
 * both consumers.
 */

export interface CanonEntity {
  id: string
  slug: string
  name: string
  type: string
  aliases: string[]
  summary: string | null
  tags?: string[]
}

/** Compact story memory supplied to the extraction prompt for reconciliation. */
export interface RecentEntityMemory {
  id: string
  entityId: string
  entitySlug: string
  entityName: string
  memoryType: string
  title: string
  summary: string
  eventAt: string | null
  observedAt: string
  source: string
  sourceUrl: string | null
}

/** What the extraction provider receives alongside the packet. */
export interface ExtractionCanon {
  /** Plausible homes for this packet - goes into the prompt as the menu. */
  shortlist: CanonEntity[]
  /** The full catalog - used for near-duplicate detection, never for the prompt. */
  catalog: CanonEntity[]
  /** Recent memories for the shortlist; included only for news reconciliation. */
  recentMemories?: RecentEntityMemory[]
}

/** Fixed entity-type vocabulary. Everything else normalizes into it. */
export const ENTITY_TYPE_VOCABULARY = [
  'person',
  'organization',
  'asset',
  'commodity',
  'topic',
  'event',
  'country',
  'project',
  'product',
  'regulation',
] as const

const TYPE_SYNONYMS: Record<string, string> = {
  company: 'organization',
  platform: 'organization',
  nation: 'country',
  geo: 'country',
  currency: 'asset',
  index: 'asset',
  instrument: 'asset',
  asset_class: 'asset',
  ai_model: 'product',
  protocol: 'project',
  legislation: 'regulation',
  regulation_or_initiative: 'regulation',
  market_theme: 'topic',
  sector: 'topic',
  indicator: 'topic',
  geopolitical_topic: 'topic',
  event_market: 'topic',
  place: 'topic',
  location: 'topic',
}

/**
 * Source objects are never entities: markets, feeds and scrape targets belong
 * in memory context/evidence. (`telegram` the company IS an entity; the
 * `polymarket` platform we collect FROM is not.)
 */
const BANNED_ENTITY_SLUGS = new Set(['polymarket'])

const STOP_TOKENS = new Set(['the', 'and', 'for', 'with', 'will', 'this', 'that', 'from', 'into', 'inc'])

export function isBannedEntitySlug(slug: string): boolean {
  return BANNED_ENTITY_SLUGS.has(slug)
}

export function normalizeEntityType(type: string): string {
  const cleaned = type.trim().toLowerCase().replace(/[\s-]+/g, '_')
  if ((ENTITY_TYPE_VOCABULARY as readonly string[]).includes(cleaned)) return cleaned
  return TYPE_SYNONYMS[cleaned] ?? 'topic'
}

export function toCanonEntity(record: EntityRecord): CanonEntity {
  return {
    id: record.id,
    slug: record.slug,
    name: record.name,
    type: record.type,
    aliases: record.aliases ?? [],
    summary: record.summary ?? null,
  }
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 1 && !STOP_TOKENS.has(token))
}

interface NamedThing {
  slug: string
  name: string
  aliases?: string[]
}

function tokenSet(thing: NamedThing): Set<string> {
  return new Set([
    ...tokenize(thing.slug),
    ...tokenize(thing.name),
    ...(thing.aliases ?? []).flatMap(tokenize),
  ])
}

/**
 * Rank the catalog against a packet's text and return the ~N plausible
 * filing homes. Pure string work: multi-word aliases match as phrases,
 * single-word aliases match on word boundaries only ("US" must not match
 * inside "confusing"). Zero LLM cost - this runs before the model is called.
 */
export function shortlistForPacket(catalog: CanonEntity[], packet: ResearchPacket, limit = 20): CanonEntity[] {
  const text = [packet.title, packet.summary, packet.body.slice(0, 2000)].join('\n').toLowerCase()
  const textTokens = new Set(text.split(/[^a-z0-9]+/).filter(Boolean))

  const scored = catalog.flatMap((entity) => {
    if (isBannedEntitySlug(entity.slug)) return []
    let score = 0
    for (const label of [entity.name, ...entity.aliases]) {
      const cleaned = label.trim().toLowerCase()
      if (cleaned.length < 2) continue
      if (cleaned.includes(' ')) {
        if (text.includes(cleaned)) score += 3
      } else if (textTokens.has(cleaned)) {
        score += 2
      }
    }
    for (const token of tokenize(entity.slug)) {
      if (textTokens.has(token)) score += 1
    }
    return score > 0 ? [{ entity, score }] : []
  })

  return scored
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((item) => item.entity)
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0
  let intersection = 0
  for (const token of a) if (b.has(token)) intersection += 1
  return intersection / (a.size + b.size - intersection)
}

function contains(outer: Set<string>, inner: Set<string>): boolean {
  if (inner.size === 0) return false
  for (const token of inner) if (!outer.has(token)) return false
  return true
}

/**
 * Existing entities most similar to a proposed NEW entity, best first.
 * Feeds both the registrar reflection ("are you sure this deserves to
 * exist?") and the deterministic near-duplicate snap in the resolver.
 */
export function nearestEntities(catalog: CanonEntity[], candidate: NamedThing, limit = 5): CanonEntity[] {
  const candidateTokens = tokenSet(candidate)
  return catalog
    .flatMap((entity) => {
      const score = jaccard(candidateTokens, tokenSet(entity))
      return score > 0 ? [{ entity, score }] : []
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((item) => item.entity)
}

/**
 * True when a proposed new entity is almost certainly the same durable
 * subject as an existing one at different granularity
 * (`china-taiwan-military-clash-2027` vs `china-taiwan`; `nvidia-h100` vs
 * `nvidia`). Deliberately conservative: `united-states` vs
 * `us-federal-reserve` shares no tokens and stays false - THAT confusion is
 * the prompt menu's job, not string matching's.
 */
export function isNearDuplicate(candidate: NamedThing, entity: CanonEntity): boolean {
  const candidateTokens = tokenSet(candidate)
  const entityTokens = tokenSet(entity)
  const similarity = jaccard(candidateTokens, entityTokens)
  if (similarity >= 0.5) return true
  // Slug tokens are the core identity; names add descriptive words
  // ("China-Taiwan tensions") that dilute full-set containment. Containment
  // is checked in ONE direction only: the candidate's tokens swallowing the
  // existing entity's SLUG marks the candidate as a NARROWER/granular
  // variant of it (`china-taiwan-military-clash-2027` of `china-taiwan`,
  // `nvidia-h100` of `nvidia`) - safe to snap onto the existing entity.
  // The reverse direction is deliberately NOT matched: a BROADER candidate
  // (`china` when only `china-taiwan` exists, `korea` vs `north-korea`) is a
  // genuinely distinct subject, and silently merging it into a narrower
  // entity would corrupt the catalog in a hard-to-undo way (PR review
  // finding). Broader-vs-narrower judgment is left to the registrar
  // reflection, which can reason about identity instead of tokens.
  const candidateSwallowsEntitySlug = contains(candidateTokens, new Set(tokenize(entity.slug)))
  return candidateSwallowsEntitySlug && similarity >= 0.25
}
