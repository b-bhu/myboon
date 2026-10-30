/**
 * #480 the timed entity manager: reviews every atlas.shelves row with status='proposed' and lets
 * the LLM decide alias (fold into an existing ACTIVE shelf), reject (retire, items stay), or new
 * (deserves its own entity; the shelf stays proposed, activation is #530). Only alias and reject
 * are applied; `new` writes applied=false review rows only and parks the shelf behind the token
 * rule (no LLM call for a shelf whose latest review is `new` until a new item lands there).
 * Applied verdicts run inside one transaction per shelf, taking the same per-slug advisory locks
 * as PgDecisionSink (#482) in sorted slug order and re-checking the shelf is still proposed before
 * writing, so a raced shelf is skipped without any writes. Failures are per-shelf the run
 * (one entity_review_failed line, nothing written) and the quota guard stops the run fail-closed.
 */
import type { Pool } from 'pg';

import type { QuotaGuard } from './ollama-quota.js';
import { searchShelves, type ChatMessage, type Llm } from './session.js';

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

const REVIEW_SYSTEM_PROMPT =
  'You are the entity manager. A proposed entity shelf is waiting for a decision. ' +
  'Decide whether its items are really about one of the candidate active entities (alias), ' +
  'the shelf is not a real entity worth keeping (reject), or it deserves its own entity (new). ' +
  'Answer with JSON only: {"decision":"alias"|"reject"|"new","alias_of":"<slug>"|null,"reason":"..."}. ' +
  'alias_of is the slug of the active candidate (required for alias, null otherwise).';

export async function reviewProposedShelves(db: Pool, o: EntityManagerOptions): Promise<EntityManagerSummary> {
  const log = o.log ?? ((e: Record<string, unknown>) => { console.log(JSON.stringify(e)); });
  const summary: EntityManagerSummary = {
    reviewed: 0, aliased: 0, rejected: 0, kept_new: 0, skipped: 0, failed: 0, llm_calls: 0, stop_reason: 'idle',
  };

  // Slug order: the deterministic side of the maxShelves cap (the first N slugs are the ones reviewed).
  const shelves = (await db.query<{ id: string; slug: string; name: string; type: string }>(
    `select id, slug, name, type from atlas.shelves where status = 'proposed' order by slug`,
  )).rows;
  if (shelves.length === 0) {
    log({ event: 'entity_manager_run', ...summary });
    return summary;
  }

  // One active-shelf read per run; every per-shelf shortlist is matched in memory (searchShelves).
  const active = (await db.query<{ slug: string; name: string; type: string; aliases: unknown }>(
    "select slug, name, type, aliases from atlas.shelves where status = 'active'",
  )).rows.map((row) => ({
    slug: row.slug,
    name: row.name,
    type: row.type,
    aliases: Array.isArray(row.aliases) ? row.aliases.filter((a): a is string => typeof a === 'string') : [],
  }));

  for (const shelf of shelves) {
    if (summary.reviewed >= o.maxShelves) {
      summary.stop_reason = 'max'; // the cap left this shelf (and any after it) pending
      break;
    }
    if (await skipReviewedNew(db, shelf.id)) {
      summary.skipped += 1;
      continue;
    }
    if (o.quota) {
      const check = await o.quota.check();
      if (!check.ok) {
        summary.stop_reason = 'quota'; // fail closed: nothing further is reviewed this run
        break;
      }
    }

    const { rows: items } = await db.query<{ signal_id: string | null; title: string; note: string | null }>(
      'select signal_id, title, note from atlas.items where main_shelf_id = $1 order by created_at desc, id desc',
      [shelf.id],
    );
    summary.llm_calls += 1;
    let reply: string;
    try {
      reply = await askTimed(o.llm, reviewPrompt(shelf, items.slice(0, 10), active), o.timeoutMs);
      const verdict = parseVerdict(reply);
      const targetId = verdict.decision === 'alias' ? await activeShelfId(db, verdict.aliasOf as string) : null;
      if (verdict.decision === 'alias' && targetId === null) {
        throw new Error(`alias_of ${verdict.aliasOf} is not an active shelf`);
      }
      if (verdict.decision === 'new') {
        // `new` touches nothing but the audit rows; the shelf stays proposed.
        const signalIds = (await db.query<{ signal_id: string }>(
          'select distinct signal_id from atlas.items where main_shelf_id = $1 and signal_id is not null',
          [shelf.id],
        )).rows.map((r) => r.signal_id);
        await insertReviews(db, shelf.id, signalIds, 'new', null, false, o, verdict.reason);
        summary.kept_new += 1;
        summary.reviewed += 1;
        continue;
      }
      // Only alias and reject are applied; `new` left the shelf above.
      const outcome = await applyVerdict(db, shelf, verdict.decision as 'alias' | 'reject', targetId, o, verdict.reason, verdict.aliasOf ?? undefined);
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
      log({ event: 'entity_review_failed', shelf: shelf.slug, error: asMessage(e) });
    }
  }

  log({ event: 'entity_manager_run', ...summary });
  return summary;
}

/**
 * The token rule: skip the shelf (no LLM call) when its latest entity_reviews row is outcome 'new'
 * and no item on it was created after that review — the answer would not change.
 */
async function skipReviewedNew(db: Pool, shelfId: string): Promise<boolean> {
  const { rows } = await db.query<{ outcome: string; has_newer: boolean }>(
    `with latest as (
       select outcome, reviewed_at from atlas.entity_reviews
        where shelf_id = $1 order by reviewed_at desc, id desc limit 1)
     select outcome, exists (select 1 from atlas.items i
                              where i.main_shelf_id = $1 and i.created_at > latest.reviewed_at) as has_newer
       from latest`,
    [shelfId],
  );
  return rows[0] !== undefined && rows[0].outcome === 'new' && !rows[0].has_newer;
}

function reviewPrompt(
  shelf: { slug: string; name: string; type: string },
  items: { title: string; note: string | null }[],
  active: { slug: string; name: string; type: string; aliases: string[] }[],
): ChatMessage[] {
  const shortlist = searchShelves([shelf.slug, shelf.name, shelf.slug.replaceAll('-', ' ')], active)
    .map((c) => {
      const aliases = active.find((a) => a.slug === c.slug)?.aliases ?? [];
      return `${c.slug} (${c.name}, ${c.type}${aliases.length > 0 ? `; aliases: ${aliases.join(', ')}` : ''})`;
    });
  const lines = [
    `Proposed shelf: ${shelf.slug} — "${shelf.name}" (type: ${shelf.type})`,
    'Its items, most recent first:',
    ...(items.length > 0
      ? items.map((i) => `- ${i.title}${i.note ? ` | note: ${i.note}` : ''}`)
      : ['- (no items on the shelf yet)']),
    `Candidate active shelves: ${shortlist.length > 0 ? shortlist.join('; ') : 'none'}`,
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

async function activeShelfId(db: Pool, slug: string): Promise<string | null> {
  const { rows } = await db.query<{ id: string }>(`select id from atlas.shelves where slug = $1 and status = 'active'`, [slug]);
  return rows[0]?.id ?? null;
}

/**
 * Apply an alias/reject verdict in one transaction: advisory locks on the shelf slugs
 * (sorted, the same key PgDecisionSink filings take, #482), then re-check under the lock
 * that the proposed shelf is still proposed ('raced' when it is not), then write. Alias
 * moves the non-duplicate items (an item whose (signal_id, target) already exists stays
 * put), appends the proposed slug to the target's aliases once and retires the shelf;
 * reject only retires it (the items stay). Review rows always cover the DISTINCT signals
 * on the shelf as the locked transaction sees it, one row per signal with its decision
 * linked when one exists (latest atlas.decisions row for the signal; ids are uuidv7).
 */
async function applyVerdict(
  db: Pool,
  shelf: { id: string; slug: string },
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
      const slugs = decision === 'alias' ? [shelf.slug, targetSlug as string].sort() : [shelf.slug];
      for (const slug of slugsUnique(slugs)) {
        await client.query("select pg_advisory_xact_lock(hashtext('atlas.shelf:' || $1))", [slug]);
      }
      const proposed = (await client.query<{ id: string }>(
        `select id from atlas.shelves where slug = $1 and status = 'proposed' for update`, [shelf.slug])).rows[0];
      if (!proposed) {
        await client.query('rollback');
        return 'raced';
      }
      let aliasTargetId: string | null = null;
      // The review covers the shelf's DISTINCT signals as the locked transaction sees it,
      // captured BEFORE the move (a moved item's signal is still a reviewed signal).
      const signalIds = (await client.query<{ signal_id: string }>(
        'select distinct signal_id from atlas.items where main_shelf_id = $1 and signal_id is not null',
        [proposed.id],
      )).rows.map((r) => r.signal_id);
      if (decision === 'alias') {
        const target = (await client.query<{ id: string }>(
          `select id from atlas.shelves where slug = $1 and status = 'active' for update`, [targetSlug as string])).rows[0];
        if (!target) throw new Error(`alias target ${targetSlug} is no longer an active shelf`);
        aliasTargetId = target.id;
        await client.query(
          `update atlas.items i
              set main_shelf_id = $1
            where i.main_shelf_id = $2
              and not exists (select 1 from atlas.items i2
                               where i2.signal_id = i.signal_id and i2.main_shelf_id = $1)`,
          [aliasTargetId, proposed.id],
        );
        // Append the proposed slug once, and only when it is not already there.
        await client.query(
          'update atlas.shelves set aliases = array_append(aliases, $1) where id = $2 and not ($1 = any(aliases))',
          [shelf.slug, aliasTargetId],
        );
      }
      await client.query(`update atlas.shelves set status = 'retired' where id = $1`, [proposed.id]);
      await insertReviewsOnClient(client, proposed.id, signalIds, decision, aliasTargetId, true, o, reason);
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

/** The review rows behind one verdict: one row per distinct signal on the shelf. */
async function insertReviews(
  db: Pool,
  shelfId: string,
  signalIds: string[],
  outcome: 'alias' | 'reject' | 'new',
  aliasTargetId: string | null,
  applied: boolean,
  o: EntityManagerOptions,
  reason: string,
): Promise<void> {
  await insertReviewsOnClient(db, shelfId, signalIds, outcome, aliasTargetId, applied, o, reason);
}

async function insertReviewsOnClient(
  client: Pick<Pool, 'query'>,
  shelfId: string,
  signalIds: string[],
  outcome: 'alias' | 'reject' | 'new',
  aliasTargetId: string | null,
  applied: boolean,
  o: EntityManagerOptions,
  reason: string,
): Promise<void> {
  await client.query(
    `insert into atlas.entity_reviews
       (shelf_id, signal_id, decision_id, outcome, alias_target_id, applied, decided_by, model_name, reason)
     select $1, signal_ids.signal_id,
            (select d.id from atlas.decisions d where d.signal_id = signal_ids.signal_id order by d.id desc limit 1),
            $2, $3, $4, 'entity-manager', $5, $6
       from unnest($7::text[]) as signal_ids (signal_id)`,
    [shelfId, outcome, aliasTargetId, applied, o.modelName, reason, signalIds],
  );
}

function asMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}