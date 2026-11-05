/**
 * #504 D36 worker: claims one due signal, runs the D36 session over it with the decision tool wired
 * to primary + fallback deciders, hands over its decision plus the full
 * signal (#571 AnalystHandoff) to a HandoffSink and finishes the claim. It writes no entity items
 * and no summaries (#571). The
 * claim never spans the session: claimNext picks the signal, the LLM and deciders run inside the
 * live claim lease, and finish/fail records the outcome (the sink persists the handoff). A shadow decider, when set, sees every case in parallel and its
 * answers are never recorded. The standing #391 rule parks any signal older than 24 hours
 * (occurred_at, judged in SQL with the claim's row read) with reason BACKLOG_SKIP_REASON before the
 * session runs. No run ever creates entities (#567). A failed attempt (missing signal row, or the session/sink save
 * throwing) fails the claim and logs one structured `signal_failed` line whose `reason` comes
 * from classifySignalFailure, so the retry/dead story of every signal is on stdout.
 */
import {
  ANALYST_HANDOFF_SCHEMA_VERSION, parseAnalystHandoff, signalMetadataSchema,
  type AnalystHandoff, type AnalystOutput, type EntityType, type SignalMetadata,
} from '@myboon/contracts';

import type { DecisionCase, Decider } from './deciders.js';
import { decideTimed } from './process.js';
import type { Ask, AskInput, AskResult, CandidateLookup, ShortlistCandidate, EntityMissEntry, JevLogEntry, Llm, SignalInput, SessionDeps } from './session.js';
import { runSession } from './session.js';
import { claimNext, failClaim, finishClaim, type Db } from './states.js';

/** The fixed parked_reason for the #391 standing rule: a signal older than 24h is parked in the claim path, never analysed. */
export const BACKLOG_SKIP_REASON = 'backlog_skip_24h';

/** target_dropped reasons (#567): the analyst never creates entities, and files one main entity per signal. */
const NO_NEW_ENTITIES_REASON = 'new entities are never created (#567)';
const ONE_MAIN_ENTITY_REASON = 'one main entity per signal (#567)';

/**
 * #571 where the analyst's work ends: the handoff goes to a HandoffSink (in-memory for tests, or the
 * atlas.decisions row via PgHandoffSink). The analyst never writes entity items or summaries.
 */
export interface HandoffSink {
  save(handoff: AnalystHandoff): Promise<void>;
}

/** In-memory sink: the first save per signal_id wins, so reprocessing a signal cannot duplicate. */
export class InMemoryHandoffSink implements HandoffSink {
  private readonly saved = new Map<string, AnalystHandoff>();

  async save(handoff: AnalystHandoff): Promise<void> {
    if (!this.saved.has(handoff.signal_id)) this.saved.set(handoff.signal_id, handoff);
  }

  handoffs(): AnalystHandoff[] {
    return [...this.saved.values()];
  }
}

/** The entity manager's queue status (#571 task 2): every keep is pending (entity null = growth), the rest none. */
export function emStatusFor(h: AnalystHandoff): 'pending' | 'none' {
  return h.decision === 'keep' ? 'pending' : 'none';
}

/**
 * Persists the handoff in one atlas.decisions insert (#571, migration 20261105150000): decision,
 * reason, the one entity pick in targets, summary null, the full AnalystHandoff snapshot in
 * `handoff`, its `handoff_version`, and `em_status` (pending for keep, none otherwise) so the
 * entity manager claims it via atlas.em_claim. `on conflict (signal_id) do nothing` makes a second
 * save of the same signal a no-op.
 */
export class PgHandoffSink implements HandoffSink {
  constructor(private readonly db: Db) {}

  async save(h: AnalystHandoff): Promise<void> {
    const targets = h.entity ? [{ entity: h.entity.slug, kind: 'existing', type: h.entity.type, angle: h.entity.angle, note: h.entity.note }] : [];
    await this.db.query(
      `insert into atlas.decisions
         (schema_version, signal_id, analyst_version, decision_type, summary, decision, reason, targets, handoff, handoff_version, em_status)
       values ($1, $2, $3, 'file', null, $4, $5, $6::jsonb, $7::jsonb, $8, $9)
       on conflict (signal_id) do nothing`,
      [h.schema_version, h.signal_id, h.analyst_version, h.decision, h.reason, JSON.stringify(targets), JSON.stringify(h), h.schema_version, emStatusFor(h)],
    );
  }
}

/**
 * Build the handoff: the first existing target is the one entity pick (#567); every other target
 * (kind new, or a second one) is dropped with a target_dropped line. No run creates entities.
 */
export function toHandoff(output: AnalystOutput, signal: SignalMetadata, log: (e: Record<string, unknown>) => void): AnalystHandoff {
  const main = output.decision === 'keep' ? output.targets.find((t) => t.kind === 'existing') : undefined;
  for (const t of output.targets) {
    if (t === main) continue;
    log({ event: 'target_dropped', signal_id: output.signal_id, entity: t.entity, reason: t.kind === 'new' ? NO_NEW_ENTITIES_REASON : ONE_MAIN_ENTITY_REASON });
  }
  return parseAnalystHandoff({
    schema_version: ANALYST_HANDOFF_SCHEMA_VERSION,
    analyst_version: output.analyst_version,
    signal_id: output.signal_id,
    decision: output.decision,
    reason: output.reason,
    entity: main ? { slug: main.entity, type: main.type, angle: main.angle, note: main.note } : null,
    signal,
  });
}

/** The atlas.signals row in the #571 metadata shape (timestamps as ISO strings). */
export type SignalRow = Omit<SignalMetadata, 'occurred_at' | 'fetched_at' | 'created_at' | 'priority' | 'schema_version'> & {
  occurred_at: Date | null; fetched_at: Date; created_at: Date; priority: number | string; schema_version: number | string;
};

export const SIGNAL_METADATA_COLUMNS =
  'signal_id, schema_version, source, source_id, type, priority, occurred_at, fetched_at, text, numbers, link, raw_ids, unusual_score, excerpt, raw_hash, created_at';

export function signalMetadataFromRow(r: SignalRow): SignalMetadata {
  return signalMetadataSchema.parse({
    ...r,
    schema_version: Number(r.schema_version),
    priority: Number(r.priority),
    occurred_at: r.occurred_at ? new Date(r.occurred_at).toISOString() : null,
    fetched_at: new Date(r.fetched_at).toISOString(),
    created_at: new Date(r.created_at).toISOString(),
  });
}

type ShortlistRow = { id: string; slug: string; name: string; type: string; summary: string | null; aliases: string[] | null; alias_hit: boolean; item_count: number };

/** The one-line summary shown to the decision tool: first sentence, at most 160 chars. */
function oneLine(summary: string | null): string {
  const text = (summary ?? '').replace(/\s+/g, ' ').trim();
  const first = text.match(/^.*?[.!?](\s|$)/)?.[0]?.trim() ?? text;
  return first.length > 160 ? `${first.slice(0, 157)}...` : first;
}

/**
 * The #567 shortlist over Postgres, read-only, one query per type run in parallel: active entities of
 * the type whose alias matches a name (atlas.entity_candidates, #566: exact on norm_alias), then the
 * type's most active entities by entity item count. Merged as alias hits first (in type order), then the
 * fill by item count across types, deduped, hard-capped at `cap` in total (alias hits count toward it).
 */
export function pgCandidateLookup(db: Db): CandidateLookup {
  return {
    async shortlist(types: EntityType[], names: string[], cap: number): Promise<ShortlistCandidate[]> {
      const perType = await Promise.all(types.map(async (type) => (await db.query<ShortlistRow>(
        `with hits as (select distinct c.entity_id from atlas.entity_candidates($1, $2::text[]) c),
              ents as (
                select e.id, e.slug, e.name, e.type, e.summary, (e.id in (select entity_id from hits)) as alias_hit,
                       (select count(*) from atlas.entity_items i where i.main_entity_id = e.id)::int as item_count
                  from atlas.entities e where e.type = $1 and e.status = 'active')
         select ents.*, (select array_agg(a.alias order by a.alias) from atlas.entity_aliases a where a.entity_id = ents.id) as aliases
           from ents
          where alias_hit or ents.id in (select id from ents order by item_count desc, slug limit $3)
          order by alias_hit desc, item_count desc, slug`,
        [type, names, cap],
      )).rows));
      const rows = perType.flat();
      const toCandidate = (r: ShortlistRow): ShortlistCandidate => ({
        id: r.id, slug: r.slug, name: r.name, type: r.type, aliases: r.aliases ?? [], summary: oneLine(r.summary), alias_hit: r.alias_hit, item_count: r.item_count,
      });
      const seen = new Set<string>();
      const out: ShortlistCandidate[] = [];
      // Alias hits first (most items first), but the cap holds for them too: a noisy article can't push past it.
      for (const r of rows.filter((x) => x.alias_hit).sort((a, b) => b.item_count - a.item_count || a.slug.localeCompare(b.slug))) {
        if (out.length >= cap) break;
        if (!seen.has(r.slug)) { seen.add(r.slug); out.push(toCandidate(r)); }
      }
      for (const r of rows.filter((x) => !x.alias_hit).sort((a, b) => b.item_count - a.item_count || a.slug.localeCompare(b.slug))) {
        if (out.length >= cap) break;
        if (!seen.has(r.slug)) { seen.add(r.slug); out.push(toCandidate(r)); }
      }
      return out;
    },
  };
}

export type D36Options = {
  llm: Llm;
  primary: Decider;
  fallback: Decider;
  /** Same cases in parallel, never recorded; a null shadow skips it. */
  shadow: Decider | null;
  lookup: CandidateLookup;
  sink: HandoffSink;
  /** target_dropped lines; default prints JSON to stdout. */
  dropLog?: (e: Record<string, unknown>) => void;
  log?: (e: JevLogEntry) => void;
  /** entity_miss lines (#567); default prints JSON to stdout. */
  missLog?: (e: EntityMissEntry) => void;
  /** One `signal_failed` record per failed attempt, logged after failClaim; default prints JSON to stdout. */
  failLog?: (e: Record<string, unknown>) => void;
  leaseMs: number;
  timeoutMs: number;
  backoffMs: number;
  maxAttempts: number;
  worker: string;
};

export type D36Result = { signalId: string; result: 'analysed' | 'parked' | 'failed' | 'lost_claim'; output?: AnalystOutput; handoff?: AnalystHandoff };

function asMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * Why a per-signal attempt failed, for the event's `reason` field: timeout when the message says it
 * timed out, parse for a SyntaxError or a JSON/parse message, db for a pg error (a string `code`
 * property) or anything the sink save threw, else other. The missing-row branch needs none of the
 * error shape, so it reports `missing_row` directly.
 */
export function classifySignalFailure(e: unknown, stage: 'session' | 'sink'): string {
  const message = asMessage(e);
  if (/timed out|timeout/i.test(message)) return 'timeout';
  if (e instanceof SyntaxError || /json|parse/i.test(message)) return 'parse';
  if (stage === 'sink' || typeof (e as { code?: unknown } | null | undefined)?.['code'] === 'string') return 'db';
  return 'other';
}

/**
 * Pick up a due signal and run the D36 session on it, or null when nothing is due. Unclear is parked
 * with the output's reason; anything the session throws fails the claim (retry with backoff, dead at
 * the cap); a lost claim is reported without changing the signal.
 */
export async function processNextD36(db: Db, o: D36Options): Promise<D36Result | null> {
  const claim = await claimNext(db, { leaseMs: o.leaseMs, worker: o.worker, maxAttempts: o.maxAttempts });
  if (!claim) return null;

  /** One structured line per failed attempt, after failClaim has recorded the outcome. */
  const failLog: (e: Record<string, unknown>) => void =
    o.failLog ?? ((e: Record<string, unknown>) => { console.log(JSON.stringify(e)); });
  /** lost_claim also reports: the attempt failed, only the signal is someone else's to retry. */
  const signalFailed = (reason: string, error: string, outcome: 'retry' | 'dead' | 'lost_claim'): void => {
    failLog({
      event: 'signal_failed', signal_id: claim.signalId, attempt: claim.attempts, reason, error,
      dead: outcome === 'dead', ...(outcome === 'lost_claim' ? { lost_claim: true } : {}),
    });
  };

  const row = (await db.query<SignalRow & { stale: boolean }>(
    `select ${SIGNAL_METADATA_COLUMNS},
            (occurred_at < now() - interval '24 hours') as stale
       from atlas.signals where signal_id = $1`,
    [claim.signalId],
  )).rows[0];
  if (!row) {
    const error = `${o.primary.name}: signal row missing after claim`;
    const outcome = await failClaim(db, claim, {
      error,
      backoffMs: o.backoffMs,
      maxAttempts: o.maxAttempts,
    });
    signalFailed('missing_row', error, outcome);
    return { signalId: claim.signalId, result: 'failed' };
  }

  // #391 standing catch-up rule, judged in SQL inside the same select that reads
  // the row: a signal more than 24h old is parked with a fixed reason and the
  // LLM, deciders and sink never run on it (a null occurred_at is never stale).
  if (row.stale === true) {
    const written = await finishClaim(db, claim, { status: 'parked', parkedReason: BACKLOG_SKIP_REASON });
    if (!written) return { signalId: claim.signalId, result: 'lost_claim' };
    return { signalId: claim.signalId, result: 'parked' };
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
  const deps: SessionDeps = { llm: o.llm, ask, lookup: o.lookup, log: logJev, ...(o.missLog ? { missLog: o.missLog } : {}) };

  let output: AnalystOutput;
  let handoff: AnalystHandoff;
  // `sink.save` and the session throw differently: the stage tags the failure reason.
  let stage: 'session' | 'sink' = 'session';
  try {
    output = await runSession(signal, deps);
    stage = 'sink';
    const { stale: _stale, ...signalRow } = row;
    handoff = toHandoff(output, signalMetadataFromRow(signalRow), o.dropLog ?? ((e) => { console.log(JSON.stringify(e)); }));
    await o.sink.save(handoff);
  } catch (e) {
    const outcome = await failClaim(db, claim, { error: asMessage(e), backoffMs: o.backoffMs, maxAttempts: o.maxAttempts });
    signalFailed(classifySignalFailure(e, stage), asMessage(e), outcome);
    return { signalId: claim.signalId, result: 'failed' };
  }

  const parked = output.decision === 'unclear';
  const written = await finishClaim(db, claim, {
    status: parked ? 'parked' : 'analysed',
    parkedReason: parked ? output.reason : undefined,
  });
  if (!written) return { signalId: claim.signalId, result: 'lost_claim', output, handoff };
  return { signalId: claim.signalId, result: parked ? 'parked' : 'analysed', output, handoff };
}