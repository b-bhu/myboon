/**
 * #480 the timed entity manager: reviews every atlas.shelves row with status='proposed' and lets
 * the LLM decide alias (fold into an existing ACTIVE shelf), reject (retire, items stay), or new
 * (deserves its own entity; the shelf stays proposed, activation is #530). Only alias and reject
 * are applied. PHASE 1 (tests first): this module is a stub that only fixes the public contract
 * for the tests; the implementation lands next.
 */
import type { Pool } from 'pg';

import type { QuotaGuard } from './ollama-quota.js';
import type { Llm } from './session.js';

/** The one run-summary line the reviewer returns (and logs once as entity_manager_run). */
export type EntityManagerSummary = {
  /** Shelves the run sent to the LLM: aliased + rejected + kept_new + failed. */
  reviewed: number;
  /** Verdict alias applied: items moved, alias added, shelf retired. */
  aliased: number;
  /** Verdict reject applied: shelf retired, items stay. */
  rejected: number;
  /** Verdict new: shelf stays proposed, applied-false review rows only. */
  kept_new: number;
  /** Eligible shelves left untouched without a verdict: token-rule skips and raced shelves. */
  skipped: number;
  /** Reviewed shelves whose verdict or LLM call failed; nothing written for them (fail-open per shelf). */
  failed: number;
  /** Every LLM call, success or failure. */
  llm_calls: number;
  /** quota: the guard stopped the run; max: the cap left shelves pending; idle: nothing pending. */
  stop_reason: 'idle' | 'quota' | 'max';
};

export type EntityManagerOptions = {
  /** The chat client (same Llm type as the analyst session). */
  llm: Llm;
  /** Written to entity_reviews.model_name on every written row. */
  modelName: string;
  /** Hard cap on reviewed shelves per run (default 40 from config). */
  maxShelves: number;
  /** Fail-closed Ollama quota guard; a stop ends the run with stop_reason 'quota'. */
  quota?: QuotaGuard;
  /** Event sink for entity_manager_run (one per run) and entity_review_failed (one per failed shelf). */
  log?: (e: Record<string, unknown>) => void;
  /** Per-LLM-call timeout in ms (default 20000 from config). */
  timeoutMs: number;
};

export async function reviewProposedShelves(db: Pool, o: EntityManagerOptions): Promise<EntityManagerSummary> {
  void db;
  void o;
  throw new Error('not implemented');
}