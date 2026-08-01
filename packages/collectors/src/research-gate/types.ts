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
}

export interface GateEntity {
  id: string
  slug: string
  name: string
  summary: string | null
}

export interface GateMemory {
  entityId: string
  memoryType: string
  title: string
  summary: string
  eventAt: string
}

/** The entity timeline handed to research as "what we already know". */
export interface GateEntityContext {
  entities: GateEntity[]
  /** Newest first. */
  recentMemories: GateMemory[]
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
}
