/**
 * Pre-research entity gate: the "do we already know this?" check that runs
 * BEFORE any research is paid for.
 *
 * Motivation (the duplication bug this closes): a market repricing 41->58
 * triggered research and was saved; the next day the SAME market repricing
 * 58->35 triggered a second full research pass, because nothing ever asked
 * whether entity memory already covered the story. Each pass looked fine in
 * isolation; the missing piece was a precondition, not research quality.
 *
 * The gate is source-agnostic by design: a signal is anything with a source
 * + a durable per-subject reference (a Polymarket market slug, a news
 * article's story key). Resolution is DETERMINISTIC for repeat subjects -
 * every entity memory row already carries source/source_ref_id, so "which
 * entity does this subject file under" is a lookup against history, not a
 * fuzzy match. Only genuinely new subjects fall through (no_prior_entity),
 * and for those the gate simply lets research proceed exactly as before -
 * the gate can only ever SAVE work, never lose a signal.
 *
 * Role boundary (deliberate, from the product design): the gate judges
 * NOVELTY ONLY - "does the timeline already record this?" It never judges
 * importance, newsworthiness, or evidence quality. Significance is the
 * editor's job; filing is the entity manager's job; the gate only decides
 * whether there is anything new to research at all.
 */

export interface GateSignal {
  /** Signal lane, e.g. 'polymarket' | 'news'. Matches entity_memories.source. */
  source: string
  /** Durable per-subject key. Matches entity_memories.source_ref_id
   * (for Polymarket: the market slug - see polymarketResearchToPacket). */
  sourceRefId: string
  title: string
  /** What the collector observed, e.g. 'Yes odds moved from 41% to 58%'. */
  whatChanged: string
  observedAt: string
  /** Present only when the caller supplies the actual bounded source material. */
  sourceMaterial?: string
  sourceMaterialDigest?: string
  /** False prevents a title/summary-only comparison from suppressing work. */
  sourceMaterialComplete?: boolean
}

export interface GateEntity {
  id: string
  slug: string
  name: string
  summary: string | null
  type?: string
  aliases?: string[]
  metadata?: Record<string, unknown>
}

export interface GateMemory {
  /** Durable legacy memory identity, when the reader provides it. */
  id?: string
  entityId: string
  memoryType: string
  title: string
  summary: string
  eventAt: string
  sourceUrl?: string | null
}

/** The entity timeline handed to research as "what we already know". */
export interface GateEntityContext {
  entities: GateEntity[]
  /** Newest first. */
  recentMemories: GateMemory[]
}

/**
 * OPTIONAL richer comparison evidence a reader may offer beyond the three
 * basic entity-memory lookups (PRD v4 stage-3 seam): item/citation/research
 * references, the filter/time coverage its search actually spanned,
 * truncation, per-lookup failures, and a digest/watermark over consulted
 * rows. Failures live inside the record and never fail the gate; an
 * implementation that does not supply this method simply keeps the legacy
 * shape (the gate builds its lookup record from the basic lookups only).
 */
export interface GateNoveltyEvidence {
  /** Item/citation/research references related to this subject. */
  itemRefs: string[]
  /** Filter/time coverage of the evidence search (null where unknown — the
   * absence of a bound is never evidence that everything was seen). */
  timeCoverage?: { oldestEventAt: string | null; newestEventAt: string | null }
  /** True when the evidence search was bounded before draining its source. */
  truncated?: boolean
  /** True when the provider can tell its returned references concern a
   * different subject - never evidence for already_known. */
  unrelated?: boolean
  /** Descriptions of what the evidence lookups could not answer. */
  failures: string[]
  /** Digest/watermark over the rows the evidence search consulted. */
  digest: string
}

/**
 * Bounded relevant-context record behind a gate verdict (PRD §5.2): what
 * the novelty comparison actually consulted and where it was incomplete.
 * It is evidence-of-comparison bookkeeping, never a verdict input beyond
 * `finalizeVerdict`'s one rule: an empty, failed, truncated, or unrelated
 * lookup can NEVER justify `already_known`.
 */
export interface GateNoveltyLookup {
  /** Durable candidate identities resolved and consulted (entity ids). */
  resolvedCandidateRefs: string[]
  /** Item/citation/research references available in the consulted context
   * (populated via novelty evidence; empty when none were available). */
  itemRefs: string[]
  /** Time span of what was consulted (null where unknown). */
  timeCoverage: { oldestEventAt: string | null; newestEventAt: string | null }
  /** True when a lookup bound (e.g. memoryLimit) cut the consulted set, or
   * the evidence search reported truncation. */
  truncated: boolean
  /** True when the consulted evidence is known to concern a different
   * subject (from GateNoveltyEvidence.unrelated) - suppression evidence
   * against already_known. */
  unrelated: boolean
  /** True when the reader's richer evidence lookup actually ran; false
   * means the record rests on the basic timeline lookups only (readers
   * without the optional noveltyEvidence port keep that legacy shape). */
  evidenceRan: boolean
  /** Descriptions of lookup/evidence failures; empty when all lookups ran
   * clean. Non-empty is always suppression evidence against already_known. */
  lookupFailures: string[]
  /** Digest/watermark over the consulted content. */
  digest: string
}

export type GateVerdict =
  /** No entity has ever filed a memory under this subject - a genuinely new
   * subject. Research proceeds exactly as it did before the gate existed. */
  | 'no_prior_entity'
  /** The timeline already records what this signal reports. Research is NOT
   * run; the candidate gets a terminal skip status. */
  | 'already_known'
  /** The signal reports something the timeline does not contain. Research
   * proceeds WITH the timeline as context (diff question, not from-scratch). */
  | 'new_information'
  /** The signal conflicts with what the timeline currently says. Research
   * proceeds with the timeline as context. */
  | 'contradicts_prior'
  /** The gate infrastructure itself failed (reader down, model down, or
   * unparseable output). FAIL OPEN: research proceeds as if new. The gate
   * must never block or lose a signal because of its own plumbing. */
  | 'gate_unavailable'

export interface GateDecision {
  verdict: GateVerdict
  /** Derived: everything proceeds except 'already_known'. */
  proceed: boolean
  reason: string
  entityIds: string[]
  memoriesConsulted: number
  /** Present whenever entities resolved, so research (and reporting) can use
   * the timeline even on fail-open verdicts. */
  entityContext: GateEntityContext | null
  /** OPTIONAL bounded novelty-context record (what the comparison actually
   * consulted and where it was incomplete; PRD v4 stage-3). Attached
   * whenever the gate's novelty comparison ran - built from the basic
   * timeline lookups alone when the reader offers no richer evidence port
   * - and absent when no comparison completed (no entities, empty
   * timeline, fail-open gate failure). Callers must treat its presence as
   * additive, never load-bearing. */
  noveltyContext?: GateNoveltyLookup
}

/**
 * Read-side port over entity memory. The production implementation reads
 * Supabase (entities / entity_memories); tests use in-memory fakes. Kept
 * intentionally tiny - three lookups - so a future news-lane gate reuses it
 * unchanged.
 */
export interface EntityMemoryReader {
  entityIdsForSourceRef(source: string, sourceRefId: string): Promise<string[]>
  entitiesByIds(ids: string[]): Promise<GateEntity[]>
  /** Newest first, bounded by limit across all requested entities. */
  recentMemories(entityIds: string[], limit: number): Promise<GateMemory[]>
  /** Internal article placement: retrieve profiles beyond exact source subjects. */
  searchEntities?(labels: string[], limit: number, options?: { exactOnly?: boolean }): Promise<GateEntity[]>
  /** Targeted historical lookup without the latest-five story-context boundary. */
  findMemoriesForArticle?(input: {
    entityIds: string[]
    terms: string[]
    sourceUrl: string | null
    limit: number
  }): Promise<GateMemory[]>
  /** OPTIONAL stage-3 richer evidence port (item/citation/research refs,
   * time coverage, truncation, failures, digest). Implementations that do
   * not provide it keep the legacy three-lookup shape. */
  noveltyEvidence?(source: string, sourceRefId: string): Promise<GateNoveltyEvidence>
  /** Research-internal exact accepted packet target; never a label similarity match. */
  attachmentTargetForPacket?(packetId: string): Promise<{ targetId: string, revision: string | number, producerPacketId: string } | null>
}
