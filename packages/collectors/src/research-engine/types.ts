import type { GateEntityContext } from '../research-gate'

/**
 * Source-agnostic read-and-conclude research engine.
 *
 * What this replaces (for the Polymarket lane first): a retrieval-only
 * pipeline that never read a page - planner (tool-less) -> snippet ranking ->
 * reflection about query phrasing -> a packet whose verified_facts were
 * hard-coded empty and whose editor recommendation was a hard-coded
 * 'needs_more_research' placeholder. The editor was being handed
 * bibliographies and asked whether they were stories.
 *
 * The engine's contract is different in three deliberate ways:
 *
 *  1. It READS. It runs in the hermes chat mode with the browser toolset -
 *     the same sanctioned path the news lane uses - and is instructed that a
 *     search-result snippet is not verification; facts must come from pages
 *     it actually opened, each carrying evidence URLs.
 *
 *  2. Its stop condition is knowledge, not retrieval mechanics: "can I answer
 *     the question?" - not "was my query good?".
 *
 *  3. It is ALLOWED to conclude nothing happened. 'nothing_found' is a
 *     first-class, auditable outcome (it must list what was checked), and the
 *     caller keeps it away from the editor instead of dressing it up as a
 *     story. This is where most of the old 0.17% research->published waste
 *     lived.
 *
 * Source-specifics stay at the edges, exactly as the product design demands:
 * the subject, what we already know (the entity timeline from the research
 * gate), and WHAT COUNTS AS AN ANSWER (ResearchAnswerSpec) are inputs;
 * the engine itself is shared between lanes.
 */

export interface ResearchAnswerSpec {
  /** Free-form label for observability, e.g. 'catalyst' | 'corroboration'. */
  kind: string
  /** The definition of "an answer" the model must satisfy, e.g. market
   * signals: a concrete catalyst explaining the repricing; news: independent
   * corroboration plus novelty vs the timeline. */
  instruction: string
}

export interface ResearchTask {
  /** Observability id, e.g. 'polymarket:markets:<candidateId>'. */
  taskId: string
  source: string
  /** Durable subject key - entity slug(s) when resolved, source slug otherwise. */
  subject: string
  title: string
  /** The focused question research must answer. When the gate resolved a
   * timeline this is a DIFF question ("what changed after <latest entry>?"),
   * not a from-scratch briefing request. */
  question: string
  /** What the collector observed - the trigger. */
  signal: string
  observedAt: string
  /** The entity timeline from the research gate; null for new subjects. */
  known: GateEntityContext | null
  /** Source-native context the collector already verified (market rules,
   * prices, article metadata). The model is told NOT to re-research these. */
  sourceContext: Record<string, unknown> | null
  answerSpec: ResearchAnswerSpec
}

export type ResearchOutcome =
  /** The question is answered with verified, evidenced facts. */
  | 'answered'
  /** Checked the obvious places; nothing new happened. Must carry `checked`. */
  | 'nothing_found'
  /** Some signal but not enough verification to answer or to rule out. */
  | 'partial'
  /** The engine run itself failed (process/timeout/unparseable output).
   * Routed to the caller's retry lane - never fabricated into a conclusion. */
  | 'engine_failed'

export interface ResearchEvidence {
  url: string
  title: string
  note?: string
}

export interface ResearchVerifiedFact {
  fact: string
  evidence: ResearchEvidence[]
}

export interface ResearchConclusion {
  taskId: string
  outcome: ResearchOutcome
  summary: string
  /** The delta vs `known` - the sentence a timeline entry is made of. */
  whatChanged: string
  verifiedFacts: ResearchVerifiedFact[]
  unverifiedClaims: string[]
  /** What was actually checked - required for nothing_found (laziness guard). */
  checked: string[]
  openQuestions: string[]
  evidenceLinks: ResearchEvidence[]
  /** Raw model stdout, kept for audit. */
  raw: string
  durationMs: number
}
