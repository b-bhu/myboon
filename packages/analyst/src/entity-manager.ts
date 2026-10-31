/**
 * #480 the timed entity manager: reviews atlas.entities rows with status='proposed' whose own stamp
 * marks them pending — entities.entity_reviewed_at null (never reviewed), or at least one item on
 * the entity created after the stored stamp (a new item re-opens the review) — and lets the LLM
 * decide alias (fold into an existing ACTIVE entity), reject (retire, items stay), or new
 * (deserves its own entity; the entity stays proposed, activation is #530). Only alias and reject
 * are applied; `new` writes nothing but the verdict, stamped onto the signals' existing
 * atlas.decisions rows. A completed review (alias, reject, or new) stamps the entity's own
 * entity_reviewed_at — alias and reject inside the apply transaction, new right after the verdict;
 * failed, raced and capped entities are not stamped — so the entity is picked up again only when a
 * new item lands there. The stamp is per entity, so two proposed entities sharing one signal are
 * reviewed independently: reviewing one leaves the other pending (#480). Applied verdicts run
 * inside one transaction per entity, taking the same per-slug advisory locks
 * as PgDecisionSink (#482) in sorted slug order and re-checking the entity is still proposed before
 * writing, so a raced entity is skipped without any writes. A garbled reply (anything parseVerdict
 * throws) is retried once in the same run with the same prompt — a timeout, an LLM error or an
 * alias-target error never retries — and a second bad reply fails the entity. Failures are
 * per-entity the run (one entity_review_failed line, nothing written) and the quota guard stops the
 * run fail-closed.
 */
import type { Pool } from 'pg';

import type { QuotaGuard } from './ollama-quota.js';
import { searchEntities, type ChatMessage, type Llm } from './session.js';

/** The one run-summary line the reviewer returns (and logs once as entity_manager_run). */
export type EntityManagerSummary = {
  /** Entities the run sent to the LLM: aliased + rejected + kept_new + failed. */
  reviewed: number;
  /** Verdict alias applied: items moved, alias added, entity retired. */
  aliased: number;
  /** Verdict reject applied: entity retired, items stay. */
  rejected: number;
  /** Verdict new: entity stays proposed, verdict recorded on the signals' decisions rows only. */
  kept_new: number;
  /** Eligible entities left untouched without a verdict: raced entities. */
  skipped: number;
  /** Reviewed entities whose verdict or LLM call failed; nothing written for them (fail-open per entity). */
  failed: number;
  /** Every LLM call, success or failure. */
  llm_calls: number;
  /** quota: the guard stopped the run; max: the cap left entities pending; idle: nothing pending. */
  stop_reason: 'idle' | 'quota' | 'max';
};

export type EntityManagerOptions = {
  /** The chat client (same Llm type as the analyst session). */
  llm: Llm;
  /** Written to atlas.decisions.entity_model_name on every reviewed signal. */
  modelName: string;
  /** Hard cap on reviewed entities per run (default 40 from config). */
  maxEntities: number;
  /** Fail-closed Ollama quota guard; a stop ends the run with stop_reason 'quota'. */
  quota?: QuotaGuard;
  /** Event sink for entity_manager_run (one per run) and entity_review_failed (one per failed entity). */
  log?: (e: Record<string, unknown>) => void;
  /** Per-LLM-call timeout in ms (default 20000 from config). */
  timeoutMs: number;
};

const REVIEW_SYSTEM_PROMPT =
  'You are the entity manager. A proposed entity is waiting for a decision. ' +
  'Decide whether its items are really about one of the candidate active entities (alias), ' +
  'it is not a real entity worth keeping (reject), or it deserves its own entity (new). ' +
  'Answer with JSON only: {"decision":"alias"|"reject"|"new","alias_of":"<slug>"|null,"reason":"..."}. ' +
  'alias_of is the slug of the active candidate (required for alias, null otherwise).';

export async function reviewProposedEntities(db: Pool, o: EntityManagerOptions): Promise<EntityManagerSummary> {
  const log = o.log ?? ((e: Record<string, unknown>) => { console.log(JSON.stringify(e)); });
  const summary: EntityManagerSummary = {
    reviewed: 0, aliased: 0, rejected: 0, kept_new: 0, skipped: 0, failed: 0, llm_calls: 0, stop_reason: 'idle',
  };

  // Stamp order with a stable slug tiebreak (the deterministic side of the maxEntities cap — the
  // first N entities are the ones reviewed). An entity is pending until a review stamps its own
  // entity_reviewed_at (#480), and pending again when an item lands after that stamp; the stamp
  // is per entity, so shared signals don't hold other entities back. The tiebreak is slug only:
  // s.created_at is not in entity_worker's column grant (20261031070000), and Postgres denies any
  // query referencing an ungranted column, order clause included.
  const entities = (await db.query<{ id: string; slug: string; name: string; type: string }>(
    `select s.id, s.slug, s.name, s.type
       from atlas.entities s
      where s.status = 'proposed'
        and (s.entity_reviewed_at is null
             or exists (select 1
                          from atlas.entity_items i
                         where i.main_entity_id = s.id
                           and i.created_at > s.entity_reviewed_at))
      order by s.entity_reviewed_at nulls first, s.slug`,
  )).rows;
  if (entities.length === 0) {
    log({ event: 'entity_manager_run', ...summary });
    return summary;
  }

  // One active-entity read per run; every per-entity shortlist is matched in memory (searchEntities).
  const active = (await db.query<{ slug: string; name: string; type: string; aliases: unknown }>(
    "select slug, name, type, aliases from atlas.entities where status = 'active'",
  )).rows.map((row) => ({
    slug: row.slug,
    name: row.name,
    type: row.type,
    aliases: Array.isArray(row.aliases) ? row.aliases.filter((a): a is string => typeof a === 'string') : [],
  }));

  for (const entity of entities) {
    if (summary.reviewed >= o.maxEntities) {
      summary.stop_reason = 'max'; // the cap left this entity (and any after it) pending
      break;
    }
    if (o.quota) {
      const check = await o.quota.check();
      if (!check.ok) {
        summary.stop_reason = 'quota'; // fail closed: nothing further is reviewed this run
        break;
      }
    }

    const { rows: items } = await db.query<{ signal_id: string | null; title: string; note: string | null }>(
      'select signal_id, title, note from atlas.entity_items where main_entity_id = $1 order by created_at desc, id desc',
      [entity.id],
    );
    const prompt = reviewPrompt(entity, items.slice(0, 10), active);
    summary.llm_calls += 1;
    let retried = false;
    try {
      let reply = await askTimed(o.llm, prompt, o.timeoutMs);
      let verdict: Verdict;
      try {
        verdict = parseVerdict(reply);
      } catch {
        // One bounded same-run retry for a parse failure: one garbled reply must not fail an
        // entity that talks fine, and a timeout/LLM/alias-target error must never multiply.
        log({ event: 'entity_review_parse_retry', entity: entity.slug });
        summary.llm_calls += 1;
        retried = true;
        reply = await askTimed(o.llm, prompt, o.timeoutMs);
        verdict = parseVerdict(reply);
      }
      const targetId = verdict.decision === 'alias' ? await activeEntityId(db, verdict.aliasOf as string) : null;
      if (verdict.decision === 'alias' && targetId === null) {
        throw new Error(`alias_of ${verdict.aliasOf} is not an active entity`);
      }
      if (verdict.decision === 'new') {
        // `new` touches nothing but the audit rows; the entity stays proposed.
        const signalIds = (await db.query<{ signal_id: string }>(
          'select distinct signal_id from atlas.entity_items where main_entity_id = $1 and signal_id is not null',
          [entity.id],
        )).rows.map((r) => r.signal_id);
        await recordVerdict(db, signalIds, 'new', null, o, verdict.reason);
        // The stamp closes this entity's review (#480); it re-opens only when a new item lands.
        await db.query('update atlas.entities set entity_reviewed_at = now() where id = $1', [entity.id]);
        summary.kept_new += 1;
        summary.reviewed += 1;
        continue;
      }
      // Only alias and reject are applied; `new` left the entity above.
      const outcome = await applyVerdict(db, entity, verdict.decision as 'alias' | 'reject', targetId, o, verdict.reason, verdict.aliasOf ?? undefined);
      if (outcome === 'raced') {
        summary.skipped += 1; // no longer proposed at apply time: the LLM call is spent, nothing else
        continue;
      }
      if (verdict.decision === 'alias') summary.aliased += 1;
      else summary.rejected += 1;
      summary.reviewed += 1;
    } catch (e) {
      summary.reviewed += 1;
      summary.failed += 1;
      log({ event: 'entity_review_failed', entity: entity.slug, error: asMessage(e), ...(retried ? { retried: true } : {}) });
    }
  }

  log({ event: 'entity_manager_run', ...summary });
  return summary;
}

function reviewPrompt(
  entity: { slug: string; name: string; type: string },
  items: { title: string; note: string | null }[],
  active: { slug: string; name: string; type: string; aliases: string[] }[],
): ChatMessage[] {
  const shortlist = searchEntities([entity.slug, entity.name, entity.slug.replaceAll('-', ' ')], active)
    .map((c) => {
      const aliases = active.find((a) => a.slug === c.slug)?.aliases ?? [];
      return `${c.slug} (${c.name}, ${c.type}${aliases.length > 0 ? `; aliases: ${aliases.join(', ')}` : ''})`;
    });
  const lines = [
    `Proposed entity: ${entity.slug} — "${entity.name}" (type: ${entity.type})`,
    'Its items, most recent first:',
    ...(items.length > 0
      ? items.map((i) => `- ${i.title}${i.note ? ` | note: ${i.note}` : ''}`)
      : ['- (no items on the entity yet)']),
    `Candidate active entities: ${shortlist.length > 0 ? shortlist.join('; ') : 'none'}`,
  ];
  return [
    { role: 'system', content: REVIEW_SYSTEM_PROMPT },
    { role: 'user', content: lines.join('\n') },
  ];
}

/** One LLM call under a hard timeout; a late rejection of the losing call is never unhandled. */
async function askTimed(llm: Llm, messages: ChatMessage[], timeoutMs: number): Promise<string> {
  const call = llm(messages);
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`entity review timed out after ${timeoutMs}ms`)), timeoutMs);
  });
  try {
    return await Promise.race([call, timeout]);
  } finally {
    clearTimeout(timer);
    call.catch(() => {}); // the losing call may still reject late (e.g. an HTTP error after the timeout)
  }
}

type Verdict = { decision: 'alias' | 'reject' | 'new'; aliasOf: string | null; reason: string };

/** Strict verdict parse: invalid JSON, an unknown decision or a missing alias_of all throw. */
function parseVerdict(raw: string): Verdict {
  let text = raw.trim();
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (fenced) text = fenced[1].trim();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) throw new Error(`reply has no JSON object: ${text.slice(0, 120)}`);
  const parsed: unknown = JSON.parse(text.slice(start, end + 1));
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('reply JSON is not an object');
  const rec = parsed as Record<string, unknown>;
  if (rec['decision'] !== 'alias' && rec['decision'] !== 'reject' && rec['decision'] !== 'new') {
    throw new Error(`unknown decision: ${String(rec['decision']).slice(0, 50)}`);
  }
  const aliasOfRaw = rec['alias_of'];
  if (rec['decision'] === 'alias') {
    if (typeof aliasOfRaw !== 'string' || aliasOfRaw.trim() === '') throw new Error('alias verdict without alias_of');
  }
  return {
    decision: rec['decision'],
    aliasOf: typeof aliasOfRaw === 'string' ? aliasOfRaw.trim() : null,
    reason: typeof rec['reason'] === 'string' ? rec['reason'] : '',
  };
}

async function activeEntityId(db: Pool, slug: string): Promise<string | null> {
  const { rows } = await db.query<{ id: string }>(`select id from atlas.entities where slug = $1 and status = 'active'`, [slug]);
  return rows[0]?.id ?? null;
}

/**
 * Apply an alias/reject verdict in one transaction: advisory locks on the entity slugs
 * (sorted, the same key PgDecisionSink filings take, #482), then re-check under the lock
 * that the proposed entity is still proposed ('raced' when it is not), then write. Alias
 * moves the non-duplicate items (an item whose (signal_id, target) already exists stays
 * put), appends the proposed slug to the target's aliases once and retires the entity;
 * reject only retires it (the items stay). The verdict is recorded by UPDATING the existing
 * atlas.decisions row of each DISTINCT signal on the entity as the locked transaction sees
 * it (the five entity_* columns only; that row is the signal's own decision). Both
 * branches then stamp the entity's entity_reviewed_at (the per-entity pending marker, #480)
 * in the same transaction; a race or a failure rolls the whole thing back, stamp included.
 */
async function applyVerdict(
  db: Pool,
  entity: { id: string; slug: string },
  decision: 'alias' | 'reject',
  targetId: string | null,
  o: EntityManagerOptions,
  reason: string,
  targetSlug?: string,
): Promise<'applied' | 'raced'> {
  if (decision === 'alias' && (targetId === null || targetSlug === undefined)) throw new Error('alias verdict without an active target');
  const client = await db.connect();
  try {
    await client.query('begin');
    try {
      const slugs = decision === 'alias' ? [entity.slug, targetSlug as string].sort() : [entity.slug];
      for (const slug of slugsUnique(slugs)) {
        await client.query("select pg_advisory_xact_lock(hashtext('atlas.entity:' || $1))", [slug]);
      }
      const proposed = (await client.query<{ id: string }>(
        `select id from atlas.entities where slug = $1 and status = 'proposed' for update`, [entity.slug])).rows[0];
      if (!proposed) {
        await client.query('rollback');
        return 'raced';
      }
      let aliasTargetId: string | null = null;
      // The review covers the entity's DISTINCT signals as the locked transaction sees it,
      // captured BEFORE the move (a moved item's signal is still a reviewed signal).
      const signalIds = (await client.query<{ signal_id: string }>(
        'select distinct signal_id from atlas.entity_items where main_entity_id = $1 and signal_id is not null',
        [proposed.id],
      )).rows.map((r) => r.signal_id);
      if (decision === 'alias') {
        const target = (await client.query<{ id: string }>(
          `select id from atlas.entities where slug = $1 and status = 'active' for update`, [targetSlug as string])).rows[0];
        if (!target) throw new Error(`alias target ${targetSlug} is no longer an active entity`);
        aliasTargetId = target.id;
        await client.query(
          `update atlas.entity_items i
              set main_entity_id = $1
            where i.main_entity_id = $2
              and not exists (select 1 from atlas.entity_items i2
                               where i2.signal_id = i.signal_id and i2.main_entity_id = $1)`,
          [aliasTargetId, proposed.id],
        );
        // Append the proposed slug once, and only when it is not already there.
        await client.query(
          'update atlas.entities set aliases = array_append(aliases, $1) where id = $2 and not ($1 = any(aliases))',
          [entity.slug, aliasTargetId],
        );
      }
      await client.query(`update atlas.entities set status = 'retired' where id = $1`, [proposed.id]);
      await recordVerdict(client, signalIds, decision, aliasTargetId, o, reason);
      await client.query('update atlas.entities set entity_reviewed_at = now() where id = $1', [proposed.id]);
      await client.query('commit');
      return 'applied';
    } catch (e) {
      await client.query('rollback');
      throw e;
    }
  } finally {
    client.release();
  }
}

function slugsUnique(slugs: string[]): string[] {
  return [...new Set(slugs)];
}

/**
 * The verdict behind one review: stamped onto the signals' existing atlas.decisions rows —
 * the five entity_* columns only, one update per reviewed signal (alias_target_id set for
 * alias, null otherwise).
 */
async function recordVerdict(
  client: Pick<Pool, 'query'>,
  signalIds: string[],
  outcome: 'alias' | 'reject' | 'new',
  aliasTargetId: string | null,
  o: EntityManagerOptions,
  reason: string,
): Promise<void> {
  await client.query(
    `update atlas.decisions
        set entity_outcome = $1, entity_alias_target_id = $2, entity_reviewed_at = now(),
            entity_model_name = $3, entity_reason = $4
      where signal_id = any($5::text[])`,
    [outcome, aliasTargetId, o.modelName, reason, signalIds],
  );
}

function asMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}