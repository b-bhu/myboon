import { HermesService, extractJson } from '../hermes'
import { nearestEntities, type CanonEntity, type ExtractionCanon } from './canon'
import { normalizeExtraction, normalizeSlug } from './normalization'
import type { EntityMemoryExtraction, ExtractionProvider, PrimaryEntityCandidate, ResearchPacket } from './types'

export interface HermesEntityExtractionOptions {
  command?: string
  timeoutMs?: number
  toolsets?: string
  ignoreRules?: boolean
  /** Injectable central Hermes service; built from `command` when omitted. */
  service?: HermesService
}

function compactString(value: string, maxLength: number): string {
  return value.length > maxLength ? `${value.slice(0, maxLength)}...` : value
}

function compactForPrompt(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') return compactString(value, depth <= 1 ? 2_000 : 800)
  if (typeof value !== 'object' || value === null) return value
  if (Array.isArray(value)) return value.slice(0, depth <= 1 ? 10 : 6).map((item) => compactForPrompt(item, depth + 1))
  if (depth >= 5) return '[truncated]'

  const output: Record<string, unknown> = {}
  for (const [key, nested] of Object.entries(value).slice(0, 30)) {
    output[key] = compactForPrompt(nested, depth + 1)
  }
  return output
}

function packetForPrompt(packet: ResearchPacket): ResearchPacket {
  return {
    ...packet,
    summary: compactString(packet.summary, 1_500),
    body: compactString(packet.body, 4_000),
    evidence: compactForPrompt(packet.evidence) as unknown[],
    context: compactForPrompt(packet.context) as Record<string, unknown>,
  }
}

function sanitizeHermesError(error: unknown): Error {
  if (!(error instanceof Error)) return new Error(String(error).slice(0, 800))
  const anyError = error as Error & { code?: unknown, signal?: unknown, stderr?: unknown }
  const stderr = typeof anyError.stderr === 'string' ? anyError.stderr.replace(/\s+/g, ' ').slice(0, 800) : ''
  const detail = [
    typeof anyError.code === 'string' || typeof anyError.code === 'number' ? `code=${anyError.code}` : '',
    typeof anyError.signal === 'string' ? `signal=${anyError.signal}` : '',
    stderr ? `stderr=${stderr}` : '',
  ].filter(Boolean).join(' ')
  return new Error(`Hermes entity extraction failed${detail ? ` (${detail})` : ''}`)
}

function shortlistSection(shortlist: CanonEntity[]): string[] {
  if (shortlist.length === 0) return []
  return [
    '',
    'KNOWN ENTITIES likely relevant to this packet. File memories into one of these unless none genuinely fits:',
    JSON.stringify(shortlist.map((entity) => ({
      slug: entity.slug,
      name: entity.name,
      type: entity.type,
      aliases: entity.aliases,
      summary: entity.summary,
    })), null, 2),
    '',
    'Filing rules:',
    '- STRONGLY prefer filing under an existing entity from the list above. Creating a new entity is exceptional and requires a createReason.',
    '- File a story under the most specific durable entity it is about: an institution\'s decision belongs to the institution, not its country (a central-bank rate decision files under the central bank entity, never a country entity).',
    '- Use a broad country entity only when the story is about the country itself.',
    '- One memory = one story. Never bundle unrelated developments into a single memory.',
  ]
}

function buildPrompt(packet: ResearchPacket, canon?: ExtractionCanon): string {
  const compactPacket = packetForPrompt(packet)
  return [
    'You are the myboon Entity Extraction Agent.',
    '',
    'Assign the research packet to durable primary entities and create memory entries for their research record.',
    ...shortlistSection(canon?.shortlist ?? []),
    'Do not write to a database. Do not make editor, publisher, or feed decisions.',
    'Do not judge evidence quality, importance, causality, sentiment, or whether the item is publishable.',
    'Do not use verdict language such as weak, strong, reject, accept, blocked, noise, likely, plausibly, no signal, or needs more research.',
    'If the packet contains diagnostics or missing data, preserve them as factual context only.',
    'Do not extract every named object. Pick only the durable primary entity/entities this memory should live under.',
    'Source objects are not entities by default: Polymarket markets, article URLs, headlines, Reddit threads, and source pages belong in memory context/evidence.',
    'Only propose a new entity when the packet is clearly about a durable real-world/project/asset/person/organization/topic and the memory cannot fit an existing primary entity.',
    'For example, an Ethereum market signal or Ethereum Foundation layoff article usually belongs under Ethereum; Ethereum Foundation can be a mention unless the packet is primarily about the foundation as a durable entity.',
    'For every memory, write summary as a concise, neutral, standalone one- or two-line description of the concrete event, signal, or change.',
    'Write the summary for a reader who cannot see the research packet. Name the subject and state what happened without source/pipeline framing such as "research packet observed" or "the source reported".',
    'Do not add editorial interpretation, recommendations, importance claims, or facts that are not present in the packet. Keep research detail in body, evidence, metrics, and context.',
    '',
    'Return strict JSON only with this shape:',
    JSON.stringify({
      primaryEntities: [{
        name: 'Ethereum',
        type: 'asset',
        slug: 'ethereum',
        aliases: ['ETH', 'Ethereum'],
        summary: 'One sentence durable description of the entity.',
        createIfMissing: true,
        createReason: 'Why this is a durable primary entity, not a source object.',
        metadata: { symbol: 'ETH' },
      }],
      memories: [{
        entitySlug: 'ethereum',
        memoryType: 'market_signal',
        title: 'ETH $3,000 Polymarket market research packet',
        summary: 'Polymarket odds for Ethereum reaching $3,000 by Dec. 31, 2026 moved from 18.5% to 29%.',
        body: 'Optional neutral detail about sources checked and source-native observations.',
        eventAt: packet.eventAt ?? packet.observedAt,
        confidence: 0.7,
        evidence: [{ url: 'https://example.com', title: 'Source title' }],
        mentions: ['Ethereum Foundation', 'Polymarket'],
        metrics: { current_yes: 0.29, previous_yes: 0.185 },
        context: { source_market_title: 'Will Ethereum reach $3,000 by December 31, 2026?' },
        observedAt: packet.observedAt,
      }],
    }, null, 2),
    '',
    'Allowed memoryType values: research_note, market_signal, news_event, social_signal, timeline_event, metric_change.',
    '',
    'Research packet:',
    JSON.stringify(compactPacket, null, 2),
  ].join('\n')
}

function candidateMatchesCatalog(candidate: PrimaryEntityCandidate, catalog: CanonEntity[]): boolean {
  const slug = normalizeSlug(candidate.slug, candidate.name)
  const aliases = new Set([candidate.name, ...(candidate.aliases ?? [])].map((alias) => alias.toLowerCase()))
  return catalog.some((entity) =>
    entity.slug === slug
    || entity.name.toLowerCase() === candidate.name.toLowerCase()
    || entity.aliases.some((alias) => aliases.has(alias.toLowerCase()))
  )
}

function buildRegistrarPrompt(candidate: PrimaryEntityCandidate, nearest: CanonEntity[]): string {
  return [
    'You are the myboon Entity Registrar.',
    '',
    'The extraction agent proposes CREATING a new durable entity. Your only job is to decide whether it genuinely deserves to exist, or whether it is the same durable subject as an existing entity at a different granularity.',
    'Prefer file_under when the proposal is a product, sub-topic, variant, or narrower framing of an existing entity. Create only for a genuinely distinct durable subject.',
    'Do NOT judge importance or newsworthiness - only identity.',
    '',
    'Return strict JSON only: {"decision": "create" | "file_under", "existing_slug": "slug when file_under", "reason": "one short sentence"}',
    '',
    'Proposed new entity:',
    JSON.stringify({
      name: candidate.name,
      slug: candidate.slug,
      type: candidate.type,
      aliases: candidate.aliases ?? [],
      summary: candidate.summary ?? null,
      create_reason: candidate.createReason || null,
    }, null, 2),
    '',
    'Nearest existing entities:',
    JSON.stringify(nearest.map((entity) => ({
      slug: entity.slug,
      name: entity.name,
      type: entity.type,
      aliases: entity.aliases,
      summary: entity.summary,
    })), null, 2),
  ].join('\n')
}

/**
 * Re-home a proposed creation onto an existing catalog entity: the candidate
 * becomes a reference to the existing entity (keeping its own aliases so the
 * resolver can merge them in - a "file_under nvidia" verdict for `nvidia-h100`
 * teaches `nvidia` the H100 alias), and every memory pointed at the old slug
 * moves to the existing one.
 */
function rehomeCandidate(
  extraction: EntityMemoryExtraction,
  candidate: PrimaryEntityCandidate,
  existing: CanonEntity
): EntityMemoryExtraction {
  const oldSlug = normalizeSlug(candidate.slug, candidate.name)
  const replacement: PrimaryEntityCandidate = {
    name: existing.name,
    type: existing.type,
    slug: existing.slug,
    aliases: [existing.name, ...(candidate.aliases ?? [])],
    summary: existing.summary ?? candidate.summary,
    createIfMissing: false,
    metadata: candidate.metadata,
  }
  const alreadyListed = extraction.primaryEntities.some((entity) =>
    entity !== candidate && normalizeSlug(entity.slug, entity.name) === existing.slug)
  const primaryEntities = extraction.primaryEntities.flatMap((entity) => {
    if (entity !== candidate) return [entity]
    return alreadyListed ? [] : [replacement]
  })
  const memories = extraction.memories.map((memory) =>
    memory.entitySlug === oldSlug ? { ...memory, entitySlug: existing.slug } : memory)
  return { primaryEntities, memories }
}

export class HermesEntityExtractionProvider implements ExtractionProvider {
  private readonly timeoutMs: number
  private readonly toolsets: string
  private readonly ignoreRules: boolean
  private readonly service: HermesService

  constructor(options: HermesEntityExtractionOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? 60_000
    this.toolsets = options.toolsets ?? ''
    this.ignoreRules = options.ignoreRules ?? true
    this.service = options.service ?? new HermesService({ command: options.command ?? 'hermes' })
  }

  async extract(packet: ResearchPacket, canon?: ExtractionCanon): Promise<EntityMemoryExtraction> {
    const prompt = buildPrompt(packet, canon)
    let extraction: EntityMemoryExtraction
    try {
      const { value } = await this.service.structured<unknown>({
        purpose: 'entity-manager.extractor',
        prompt,
        timeoutMs: this.timeoutMs,
        toolsets: this.toolsets || undefined,
        ignoreRules: this.ignoreRules,
      })
      extraction = normalizeExtraction(value, packet)
    } catch (error) {
      throw sanitizeHermesError(error)
    }
    return this.reflectOnCreations(extraction, canon)
  }

  /**
   * Registrar reflection: fires ONLY when the extraction proposes creating a
   * new entity (the rare, catalog-polluting path), never on ordinary filings
   * into existing entities. A second cheap structured call judges identity -
   * "is this the same durable subject as an existing entity at different
   * granularity?" - with the nearest catalog entries as context. Every
   * failure mode (call error, unparseable output, unknown verdict, verdict
   * naming a slug outside the catalog) fails OPEN to the original creation:
   * the deterministic near-duplicate snap in the resolver remains the
   * backstop.
   */
  private async reflectOnCreations(
    extraction: EntityMemoryExtraction,
    canon?: ExtractionCanon
  ): Promise<EntityMemoryExtraction> {
    if (!canon || canon.catalog.length === 0) return extraction

    let current = extraction
    const creations = extraction.primaryEntities.filter((candidate) => !candidateMatchesCatalog(candidate, canon.catalog))
    for (const candidate of creations) {
      const nearest = nearestEntities(canon.catalog, {
        slug: normalizeSlug(candidate.slug, candidate.name),
        name: candidate.name,
        aliases: candidate.aliases,
      }, 5)
      if (nearest.length === 0) continue
      try {
        const { value } = await this.service.structured<{ decision?: unknown, existing_slug?: unknown }>({
          purpose: 'entity-manager.registrar',
          prompt: buildRegistrarPrompt(candidate, nearest),
          timeoutMs: this.timeoutMs,
          toolsets: this.toolsets || undefined,
          ignoreRules: this.ignoreRules,
        })
        if (value?.decision !== 'file_under' || typeof value.existing_slug !== 'string') continue
        const existing = canon.catalog.find((entity) => entity.slug === value.existing_slug)
        if (!existing) continue
        current = rehomeCandidate(current, candidate, existing)
      } catch {
        // Fail open: keep the creation; the resolver guardrail still runs.
      }
    }
    return current
  }
}

export const __testing = {
  buildPrompt,
  buildRegistrarPrompt,
  candidateMatchesCatalog,
  extractJson,
  packetForPrompt,
  rehomeCandidate,
}
