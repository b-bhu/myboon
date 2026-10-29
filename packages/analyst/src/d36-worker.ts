/**
 * #504 D36 worker: claims one due signal, runs the D36 session over it with the decision tool wired
 * to primary + fallback deciders, saves the output to a DecisionSink and finishes the claim. The
 * claim never spans the session: claimNext picks the signal, the LLM and deciders run inside the
 * live claim lease, and finish/fail records the outcome (no decision payload here; the
 * atlas.decisions sink lands with #503). A shadow decider, when set, sees every case in parallel
 * and its answers are never recorded.
 */
import type { AnalystOutput } from '@myboon/contracts';

import type { DecisionCase, Decider } from './deciders.js';
import { decideTimed } from './process.js';
import type { Ask, AskInput, AskResult, EntitySearch, JevLogEntry, Llm, SignalInput, SessionDeps } from './session.js';
import { runSession, searchShelves } from './session.js';
import { claimNext, failClaim, finishClaim, type Db } from './states.js';

/** Where finished outputs go; the atlas.decisions sink lands with #503. */
export interface DecisionSink {
  save(output: AnalystOutput): Promise<void>;
}

/** In-memory sink: the first save per signal_id wins, so reprocessing a signal cannot duplicate rows. */
export class InMemoryDecisionSink implements DecisionSink {
  private readonly saved = new Map<string, AnalystOutput>();

  async save(output: AnalystOutput): Promise<void> {
    if (!this.saved.has(output.signal_id)) this.saved.set(output.signal_id, output);
  }

  outputs(): AnalystOutput[] {
    return [...this.saved.values()];
  }
}

/** Entity search over the DB shelves: one read-only select per call, then the in-memory matcher. */
export function shelfSearchFromDb(db: Db): EntitySearch {
  return async (terms: string[]) => {
    const { rows } = await db.query<{ slug: string; name: string; type: string; aliases: unknown }>(
      "select slug, name, type, aliases from atlas.shelves where status = 'active'",
    );
    const shelves = rows.map((row) => ({
      slug: row.slug,
      name: row.name,
      type: row.type,
      aliases: Array.isArray(row.aliases) ? row.aliases.filter((a): a is string => typeof a === 'string') : [],
    }));
    return searchShelves(terms, shelves);
  };
}

export type D36Options = {
  llm: Llm;
  primary: Decider;
  fallback: Decider;
  /** Same cases in parallel, never recorded; a null shadow skips it. */
  shadow: Decider | null;
  search: EntitySearch;
  sink: DecisionSink;
  log?: (e: JevLogEntry) => void;
  leaseMs: number;
  timeoutMs: number;
  backoffMs: number;
  maxAttempts: number;
  worker: string;
};

export type D36Result = { signalId: string; result: 'analysed' | 'parked' | 'failed' | 'lost_claim'; output?: AnalystOutput };

function asMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * Pick up a due signal and run the D36 session on it, or null when nothing is due. Unclear is parked
 * with the output's reason; anything the session throws fails the claim (retry with backoff, dead at
 * the cap); a lost claim is reported without changing the signal.
 */
export async function processNextD36(db: Db, o: D36Options): Promise<D36Result | null> {
  const claim = await claimNext(db, { leaseMs: o.leaseMs, worker: o.worker, maxAttempts: o.maxAttempts });
  if (!claim) return null;

  const row = (await db.query<{ signal_id: string; source: string | null; text: string | null; link: string | null }>(
    'select signal_id, source, text, link from atlas.signals where signal_id = $1',
    [claim.signalId],
  )).rows[0];
  if (!row) {
    await failClaim(db, claim, {
      error: `${o.primary.name}: signal row missing after claim`,
      backoffMs: o.backoffMs,
      maxAttempts: o.maxAttempts,
    });
    return { signalId: claim.signalId, result: 'failed' };
  }

  const logJev: (e: JevLogEntry) => void =
    o.log ?? ((entry: JevLogEntry) => console.log(JSON.stringify({ event: 'jev_call', ...entry })));

  /** The decision tool for this signal: primary first, then the fallback; the shadow sees the same cases in parallel. */
  const ask: Ask = async (input: AskInput): Promise<AskResult> => {
    const kase: DecisionCase = {
      question: input.question,
      choices: input.choices,
      shortlist: input.shortlist,
      itemIds: input.shortlist.map((candidate) => candidate.slug),
      state: input.state,
    };
    if (o.shadow) {
      void decideTimed(o.shadow, kase, o.timeoutMs)
        .then((r) => {
          console.log(JSON.stringify({ event: 'd36_shadow_answer', shadow: o.shadow?.name, signal_id: row.signal_id, question: input.question, choice: r.answer.choice, confidence: r.answer.probabilities[r.answer.choice] ?? null }));
        })
        .catch((e: unknown) => {
          console.log(JSON.stringify({ event: 'd36_shadow_failed', shadow: o.shadow?.name, error: asMessage(e) }));
        });
    }
    let deciding: Decider;
    let answer;
    try {
      deciding = o.primary;
      answer = (await decideTimed(deciding, kase, o.timeoutMs)).answer;
    } catch (primaryError) {
      try {
        deciding = o.fallback;
        answer = (await decideTimed(deciding, kase, o.timeoutMs)).answer;
      } catch (fallbackError) {
        throw new Error(`${o.primary.name}: ${asMessage(primaryError)}; ${o.fallback.name}: ${asMessage(fallbackError)}`);
      }
    }
    return { choice: answer.choice, probabilities: answer.probabilities, provider: deciding.name };
  };

  const signal: SignalInput = { signal_id: row.signal_id, text: row.text ?? '', source: row.source, link: row.link };
  const deps: SessionDeps = { llm: o.llm, ask, search: o.search, log: logJev };

  let output: AnalystOutput;
  try {
    output = await runSession(signal, deps);
    await o.sink.save(output);
  } catch (e) {
    await failClaim(db, claim, { error: asMessage(e), backoffMs: o.backoffMs, maxAttempts: o.maxAttempts });
    return { signalId: claim.signalId, result: 'failed' };
  }

  const parked = output.decision === 'unclear';
  const written = await finishClaim(db, claim, {
    status: parked ? 'parked' : 'analysed',
    parkedReason: parked ? output.reason : undefined,
  });
  if (!written) return { signalId: claim.signalId, result: 'lost_claim', output };
  return { signalId: claim.signalId, result: parked ? 'parked' : 'analysed', output };
}