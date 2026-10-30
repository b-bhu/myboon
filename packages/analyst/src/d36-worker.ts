/**
 * #504 D36 worker: claims one due signal, runs the D36 session over it with the decision tool wired
 * to primary + fallback deciders, saves the output to a DecisionSink and finishes the claim. The
 * claim never spans the session: claimNext picks the signal, the LLM and deciders run inside the
 * live claim lease, and finish/fail records the outcome (the sink persists the decision; no decision
 * payload rides the finish call). A shadow decider, when set, sees every case in parallel and its
 * answers are never recorded. The standing #391 rule parks any signal older than 24 hours
 * (occurred_at, judged in SQL with the claim's row read) with reason BACKLOG_SKIP_REASON before the
 * session runs, and PgDecisionSink's `allowNewEntities: false` drops kind-new targets so a catch-up
 * run cannot create shelves.
 */
import type { AnalystOutput } from '@myboon/contracts';
import type { Pool, PoolClient } from 'pg';

import type { DecisionCase, Decider } from './deciders.js';
import { decideTimed } from './process.js';
import type { Ask, AskInput, AskResult, EntitySearch, JevLogEntry, Llm, SignalInput, SessionDeps } from './session.js';
import { runSession, searchShelves } from './session.js';
import { claimNext, failClaim, finishClaim, type Db } from './states.js';

/** The fixed parked_reason for the #391 standing rule: a signal older than 24h is parked in the claim path, never analysed. */
export const BACKLOG_SKIP_REASON = 'backlog_skip_24h';

/** The target_dropped reason when PgDecisionSink is created with allowNewEntities: false (the #391 catch-up run). */
const NEW_ENTITY_DISABLED_REASON = 'new-entity creation disabled (catch-up)';

/** Where finished outputs go: in-memory for tests, or atlas.decisions (+ atlas.items) via PgDecisionSink. */
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
 * then (keep) one entity item per target on its shelf. Per #482 the filing serialises per entity:
 * before touching any shelf it takes one advisory lock per target slug, in sorted slug order inside
 * this transaction, so two saves for one entity cannot race; every item copies the signal's
 * occurred_at so a shelf timeline orders by signal time, not write order. A kind existing target
 * needs an active shelf and throws when it is missing; a kind new target reuses a shelf whose status
 * is proposed, files on an already active slug with a target_reclassified log line (#511), and only a
 * retired slug drops the target (a target_dropped log line, no item, no throw: the other targets
 * still file and the row stores the output as-is). With `{ allowNewEntities: false }` (#391
 * catch-up) the active-slug reclassification still files there, but every other kind-new target —
 * a proposed shelf, a retired slug, or no row at all — is dropped through the same target_dropped
 * path: no shelf is proposed or inserted, no item lands on a proposed shelf.
 * `on conflict (signal_id)` makes the second save of the same signal a no-op commit (items are not
 * rewritten), and any failure rolls the transaction back so nothing is written.
 */
export class PgDecisionSink implements DecisionSink {
  private readonly pool: Pool;
  /** Where dropped targets are logged; the default keeps them on the worker's stdout. */
  private readonly log: (e: Record<string, unknown>) => void;
  /** False only for the #391 catch-up run: kind-new targets never create shelves. */
  private readonly allowNewEntities: boolean;

  constructor(pool: Pool, log?: (e: Record<string, unknown>) => void, o: { allowNewEntities?: boolean } = {}) {
    this.pool = pool;
    this.log = log ?? ((e) => console.log(JSON.stringify(e)));
    this.allowNewEntities = o.allowNewEntities ?? true;
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
        if (output.decision === 'keep') {
          await lockShelfSlugs(client, output.targets);
          await fileItems(client, output, this.log, this.allowNewEntities);
        }
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

/** One advisory lock per target slug, sorted so two saves of overlapping slugs take locks in the same order and cannot deadlock (#482). */
async function lockShelfSlugs(client: PoolClient, targets: AnalystOutput['targets']): Promise<void> {
  for (const slug of targets.map((t) => t.entity).sort()) {
    await client.query("select pg_advisory_xact_lock(hashtext('atlas.shelf:' || $1))", [slug]);
  }
}

/** One entity item per keep target, filed on the target's shelf in the sink's open transaction; each item copies the signal's occurred_at (#482). */
async function fileItems(
  client: PoolClient,
  output: AnalystOutput,
  log: (e: Record<string, unknown>) => void,
  allowNewEntities: boolean,
): Promise<void> {
  for (const target of output.targets) {
    const mainShelfId = target.kind === 'existing'
      ? await activeShelfId(client, target.entity)
      : await proposedShelfId(client, target.entity, target.type, output.signal_id, log, allowNewEntities);
    if (mainShelfId === null) continue; // dropped target: already logged, the other targets in the output still file
    await client.query(
      `insert into atlas.items (item_key, title, summary, main_shelf_id, signal_id, angle, note, occurred_at)
         select $1, $2, $3, $4, $5, $6, $7, s.occurred_at
           from atlas.signals s
          where s.signal_id = $5
       on conflict do nothing`,
      [`${output.signal_id}:${target.entity}`, itemTitle(output.summary, target.note), target.note, mainShelfId, output.signal_id, target.angle, target.note],
    );
  }
}

/** The active shelf for a kind existing target, or throw: the item has nowhere to land. */
async function activeShelfId(client: PoolClient, slug: string): Promise<string> {
  const { rows } = await client.query<{ id: string }>(`select id from atlas.shelves where slug = $1 and status = 'active'`, [slug]);
  if (rows[0]) return rows[0].id;
  throw new Error(`target ${slug}: no active shelf`);
}

/**
 * The shelf for a kind new target: reuse a proposed shelf; an already active slug files on that
 * existing shelf with a target_reclassified log line (#511); a retired slug drops the target
 * (target_dropped, no item, no throw, #482); else propose one (name = slug). With
 * `allowNewEntities = false` (#391 catch-up) the retired/no-row/proposed cases all drop through the
 * same target_dropped path with the fixed catch-up reason: never insert a shelf.
 */
async function proposedShelfId(
  client: PoolClient,
  slug: string,
  type: string,
  signalId: string,
  log: (e: Record<string, unknown>) => void,
  allowNewEntities: boolean,
): Promise<string | null> {
  const { rows } = await client.query<{ id: string; status: string }>('select id, status from atlas.shelves where slug = $1', [slug]);
  if (rows[0] && rows[0].status === 'proposed') {
    if (!allowNewEntities) {
      log({ event: 'target_dropped', signal_id: signalId, entity: slug, reason: NEW_ENTITY_DISABLED_REASON });
      return null;
    }
    return rows[0].id;
  }
  if (rows[0] && rows[0].status === 'active') {
    log({ event: 'target_reclassified', signal_id: signalId, entity: slug, reason: `shelf ${slug} is already active; filed as existing` });
    return rows[0].id;
  }
  if (rows[0]) {
    log({ event: 'target_dropped', signal_id: signalId, entity: slug, reason: allowNewEntities
      ? `shelf ${slug} is ${rows[0].status}, not proposed or active`
      : NEW_ENTITY_DISABLED_REASON });
    return null;
  }
  if (!allowNewEntities) {
    log({ event: 'target_dropped', signal_id: signalId, entity: slug, reason: NEW_ENTITY_DISABLED_REASON });
    return null;
  }
  const inserted = await client.query<{ id: string }>(
    `insert into atlas.shelves (slug, name, type, status) values ($1, $1, $2, 'proposed') returning id`,
    [slug, type],
  );
  return inserted.rows[0].id;
}

/** The item title: the signal summary, or the target note when the summary is empty, capped at 200 chars. */
function itemTitle(summary: string, note: string): string {
  return (summary.length > 0 ? summary : note).slice(0, 200);
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
    await failClaim(db, claim, {
      error: `${o.primary.name}: signal row missing after claim`,
      backoffMs: o.backoffMs,
      maxAttempts: o.maxAttempts,
    });
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