/**
 * #504 D36 worker: claims one due signal, runs the D36 session over it with the decision tool wired
 * to primary + fallback deciders, saves the output to a DecisionSink and finishes the claim. The
 * claim never spans the session: claimNext picks the signal, the LLM and deciders run inside the
 * live claim lease, and finish/fail records the outcome (the sink persists the decision; no decision
 * payload rides the finish call). A shadow decider, when set, sees every case in parallel and its
 * answers are never recorded. The standing #391 rule parks any signal older than 24 hours
 * (occurred_at, judged in SQL with the claim's row read) with reason BACKLOG_SKIP_REASON before the
 * session runs. No run ever creates entities (#567). A failed attempt (missing signal row, or the session/sink save
 * throwing) fails the claim and logs one structured `signal_failed` line whose `reason` comes
 * from classifySignalFailure, so the retry/dead story of every signal is on stdout.
 */
import type { AnalystOutput, EntityType } from '@myboon/contracts';
import type { Pool, PoolClient } from 'pg';

import type { DecisionCase, Decider } from './deciders.js';
import { itemSummary, itemTitle } from './item-wording.js';
import { decideTimed } from './process.js';
import type { Ask, AskInput, AskResult, CandidateLookup, ShortlistCandidate, EntityMissEntry, JevLogEntry, Llm, SignalInput, SessionDeps } from './session.js';
import { runSession } from './session.js';
import { claimNext, failClaim, finishClaim, type Db } from './states.js';

/** The fixed parked_reason for the #391 standing rule: a signal older than 24h is parked in the claim path, never analysed. */
export const BACKLOG_SKIP_REASON = 'backlog_skip_24h';

/** target_dropped reasons (#567): the analyst never creates entities, and files one main entity per signal. */
const NO_NEW_ENTITIES_REASON = 'new entities are never created (#567)';
const ONE_MAIN_ENTITY_REASON = 'one main entity per signal (#567)';

/** Where finished outputs go: in-memory for tests, or atlas.decisions (+ atlas.entity_items) via PgDecisionSink. */
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

/**
 * The atlas.decisions sink on the #503 schema, one transaction per save: insert the decision row,
 * then (keep) at most one entity item, on the signal's one main entity (#567). Per #482 the filing
 * takes an advisory lock on the target slug inside this transaction, and the item copies the signal's
 * occurred_at so an entity timeline orders by signal time, not write order. The target must be an
 * active entity (else it throws: the item has nowhere to land). The sink never creates or proposes an
 * entity (#567): a kind new target, or any target after the first, is dropped with a target_dropped
 * log line and no item. `on conflict (signal_id)` makes the second save of the same signal a no-op
 * commit, and any failure rolls the transaction back so nothing is written.
 */
export class PgDecisionSink implements DecisionSink {
  private readonly pool: Pool;
  /** Where dropped targets are logged; the default keeps them on the worker's stdout. */
  private readonly log: (e: Record<string, unknown>) => void;

  constructor(pool: Pool, log?: (e: Record<string, unknown>) => void) {
    this.pool = pool;
    this.log = log ?? ((e) => console.log(JSON.stringify(e)));
  }

  async save(output: AnalystOutput): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      try {
        const decisions = await client.query<{ signal_id: string }>(
          `insert into atlas.decisions
             (schema_version, signal_id, analyst_version, decision_type, summary, decision, reason, targets)
           values ($1, $2, $3, 'file', $4, $5, $6, $7::jsonb)
           on conflict (signal_id) do nothing
           returning signal_id`,
          [output.schema_version, output.signal_id, output.analyst_version, output.summary, output.decision, output.reason, JSON.stringify(output.targets)],
        );
        if (decisions.rows.length === 0) {
          await client.query('commit');
          return;
        }
        if (output.decision === 'keep') await fileMainItem(client, output, this.log);
        await client.query('commit');
      } catch (e) {
        await client.query('rollback');
        throw e;
      }
    } finally {
      client.release();
    }
  }
}

/** File the one main item: the first existing target; every other target is dropped and logged (#567). */
async function fileMainItem(client: PoolClient, output: AnalystOutput, log: (e: Record<string, unknown>) => void): Promise<void> {
  const main = output.targets.find((t) => t.kind === 'existing');
  for (const t of output.targets) {
    if (t === main) continue;
    log({ event: 'target_dropped', signal_id: output.signal_id, entity: t.entity, reason: t.kind === 'new' ? NO_NEW_ENTITIES_REASON : ONE_MAIN_ENTITY_REASON });
  }
  if (!main) return;
  await client.query("select pg_advisory_xact_lock(hashtext('atlas.entity:' || $1))", [main.entity]);
  const mainEntityId = await activeEntityId(client, main.entity);
  await client.query(
    `insert into atlas.entity_items (item_key, title, summary, main_entity_id, signal_id, angle, note, occurred_at)
       select $1, $2, $3, $4, $5, $6, $7, s.occurred_at
         from atlas.signals s
        where s.signal_id = $5
     on conflict do nothing`,
    [`${output.signal_id}:${main.entity}`, itemTitle(output.headline, output.summary, main.note), itemSummary(output.summary, main.note), mainEntityId, output.signal_id, main.angle, main.note],
  );
}

/** The active entity for the main target, or throw: the item has nowhere to land. */
async function activeEntityId(client: PoolClient, slug: string): Promise<string> {
  const { rows } = await client.query<{ id: string }>(`select id from atlas.entities where slug = $1 and status = 'active'`, [slug]);
  if (rows[0]) return rows[0].id;
  throw new Error(`target ${slug}: no active entity`);
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
 * the type whose alias matches a name (atlas.entity_candidates, #566: exact on norm_alias), always kept,
 * then the type's most active entities by entity item count. Merged as all alias hits first (in type
 * order), then the fill by item count across types, deduped, capped at `cap` (alias hits are never cut).
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
  sink: DecisionSink;
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

export type D36Result = { signalId: string; result: 'analysed' | 'parked' | 'failed' | 'lost_claim'; output?: AnalystOutput };

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

  const row = (await db.query<{
    signal_id: string; source: string | null; text: string | null; link: string | null; occurred_at: Date | null; stale: boolean;
  }>(
    `select signal_id, source, text, link,
            occurred_at,
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
  // `sink.save` and the session throw differently: the stage tags the failure reason.
  let stage: 'session' | 'sink' = 'session';
  try {
    output = await runSession(signal, deps);
    stage = 'sink';
    await o.sink.save(output);
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
  if (!written) return { signalId: claim.signalId, result: 'lost_claim', output };
  return { signalId: claim.signalId, result: parked ? 'parked' : 'analysed', output };
}