/**
 * processNext (#478): claim one due signal, ask the decider slot in memory,
 * write the finished result once. The claim never spans the decider calls:
 *
 *   1. claimNext picks up a due received signal (or an expired claim).
 *   2. primary and shadow run in parallel, each with its own AbortController
 *      and opts.timeoutMs. If primary fails, fallback runs; the deciding
 *      model's name lands in decided_by and the losing primary in
 *      primary_error. If both fail, failClaim records last_error naming both.
 *   3. On success: finishClaim marks the signal analysed and inserts the
 *      decision row (at most one per signal) with the full provenance. The
 *      shadow answers every signal but only records shadow_*; a shadow failure
 *      is recorded and never blocks the outcome.
 */
import { claimNext, failClaim, finishClaim, type Db } from './states.js';
import { DeciderError, type Decider, type DecisionCase, type DeciderAnswer } from './deciders.js';

/** Analyst version written on every decision row. */
export const ANALYST_VERSION = 'analyst-478-v1';

export type ProcessOptions = {
  primary: Decider;
  fallback: Decider;
  shadow: Decider;
  buildCase(signal: { signal_id: string; text: string | null; excerpt: string | null; link: string | null }): DecisionCase;
  promptVersion: string;
  leaseMs: number;
  timeoutMs: number;
  backoffMs: number;
  maxAttempts: number;
  worker: string;
};

export type ProcessResult = { signalId: string; result: 'decided' | 'failed' };

/** What the shadow contributed, recorded on the decision's shadow_* columns. */
type ShadowRecord =
  | { ok: true; answer: DeciderAnswer; latencyMs: number }
  | { ok: false; kind: 'error' | 'timeout' };

type Decided = { answer: DeciderAnswer; latencyMs: number };

/** The signal row the case is built from (columns service_role may read). */
type SignalRow = { signal_id: string; text: string | null; excerpt: string | null; link: string | null };

export async function processNext(db: Db, o: ProcessOptions): Promise<ProcessResult | null> {
  const claim = await claimNext(db, { leaseMs: o.leaseMs, worker: o.worker });
  if (!claim) return null;

  const row = (await db.query<SignalRow>(
    'select signal_id, text, excerpt, link from atlas.signals where signal_id = $1',
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

  const c = o.buildCase(row);
  const shadow = runShadow(o.shadow, c, o.timeoutMs);

  let primaryError: DeciderError | null = null;
  let deciding: Decider;
  let decided: Decided;
  try {
    deciding = o.primary;
    decided = await decideTimed(deciding, c, o.timeoutMs);
  } catch (e) {
    primaryError = toDeciderError(e);
    try {
      deciding = o.fallback;
      decided = await decideTimed(deciding, c, o.timeoutMs);
    } catch (fallbackError) {
      await shadow.settled;
      await failClaim(db, claim, {
        error: `${primaryFails(o, e)}; ${o.fallback.name}: ${describe(toDeciderError(fallbackError))}`,
        backoffMs: o.backoffMs,
        maxAttempts: o.maxAttempts,
      });
      return { signalId: claim.signalId, result: 'failed' };
    }
  }

  const shadowRecord = await shadow.settled;
  const probabilities = decided.answer.probabilities;
  const choice = decided.answer.choice;
  const confidence = probabilities[choice] ?? 0;
  const decision: Record<string, unknown> = {
    schema_version: 1,
    signal_id: claim.signalId,
    analyst_version: ANALYST_VERSION,
    decision_type: 'file',
    action: 'keep',
    confidence,
    shortlist: c.shortlist,
    item_ids: c.itemIds,
    prompt_version: o.promptVersion,
    model_name: deciding.modelName,
    model_version: deciding.modelVersion,
    decided_by: deciding.name,
    answer: { choice },
    probabilities,
    runner_up_margin: runnerUpMargin(probabilities, choice, confidence),
    latency_ms: decided.latencyMs,
    outcome: 'decided',
    primary_error: primaryError ? describe(primaryError) : null,
    shadow_answer: shadowRecord.ok ? { choice: shadowRecord.answer.choice } : null,
    shadow_probabilities: shadowRecord.ok ? shadowRecord.answer.probabilities : null,
    shadow_latency_ms: shadowRecord.ok ? shadowRecord.latencyMs : null,
    shadow_outcome: shadowRecord.ok ? 'decided' : shadowRecord.kind,
    shadow_model_version: o.shadow.modelVersion,
  };
  await finishClaim(db, claim, { status: 'analysed', decision });
  return { signalId: claim.signalId, result: 'decided' };
}

function primaryFails(o: ProcessOptions, e: unknown): string {
  return `${o.primary.name}: ${describe(toDeciderError(e))}`;
}

/** Start the shadow alongside the primary; its result never blocks the outcome. */
function runShadow(d: Decider, c: DecisionCase, timeoutMs: number): { settled: Promise<ShadowRecord> } {
  const settled = decideTimed(d, c, timeoutMs)
    .then((r) => ({ ok: true, answer: r.answer, latencyMs: r.latencyMs }) as ShadowRecord)
    .catch((e: unknown): ShadowRecord => {
      const error = toDeciderError(e);
      return { ok: false, kind: error.kind === 'timeout' ? 'timeout' : 'error' };
    });
  return { settled };
}

/**
 * One decider call under its own abort deadline. A plain abort failure becomes
 * a DeciderError('timeout'); anything else that is not already a DeciderError
 * becomes a DeciderError('error').
 */
async function decideTimed(d: Decider, c: DecisionCase, timeoutMs: number): Promise<Decided> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  const started = Date.now();
  try {
    const answer = await d.decide(c, ac.signal);
    return { answer, latencyMs: Math.max(0, Date.now() - started) };
  } catch (e) {
    if (e instanceof DeciderError) throw e;
    if (ac.signal.aborted) {
      throw new DeciderError('timeout', `${d.name} timed out after ${timeoutMs} ms`);
    }
    throw new DeciderError('error', `${d.name}: ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    clearTimeout(timer);
  }
}

function toDeciderError(e: unknown): DeciderError {
  if (e instanceof DeciderError) return e;
  return new DeciderError('error', e instanceof Error ? e.message : String(e));
}

function describe(e: DeciderError): string {
  return `${e.kind}: ${e.message}`;
}

/** Chosen probability minus the best losing one, clamped to the 0..1 check. */
function runnerUpMargin(probabilities: Record<string, number>, chosen: string, chosenP: number): number {
  let bestOther = 0;
  for (const [key, value] of Object.entries(probabilities)) {
    if (key !== chosen && value > bestOther) bestOther = value;
  }
  return Math.min(1, Math.max(0, chosenP - bestOther));
}