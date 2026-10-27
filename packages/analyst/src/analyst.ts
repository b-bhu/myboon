/**
 * #479 (D20/D23/D25/D26): the Story analyst. `runAnalystOnce` claims
 * 'received' signals for worker 'analyst' and, one signal at a time:
 *
 * - LINKER (code, no Jev): shortlists up to five active shelves (atlas.shelves
 *   are the entities) whose aliases appear in the signal text (+ excerpt),
 *   case-insensitive and whole-word, aliases starting with '$' matching
 *   literally with the '$'. Ranked by distinct alias hits, then total alias
 *   length, then slug; atlas.routing_rules then drops the token or the
 *   project shelf when BOTH are shortlisted for a rule (route_to wins).
 *   Applied after ranking, before Jev.
 * - ITEMS: per candidate, five raw items -- the shelf's newest item plus the
 *   newest item of every recent week bucket (0-7d .. 28-35d), deduped, filled
 *   with the next-newest items -- ordered newest first.
 * - STORY: ONE Jev call per signal via callJev (logged to
 *   atlas.jev_decisions), the input carrying state {signal, candidates} and
 *   the two per-call choice questions (entity over slugs, item over all
 *   candidate item ids + 'new_story' + 'adds_nothing').
 * - OUTCOME: Jev error/timeout/invalid answer retries with backoff
 *   (dead-letters at the attempt cap, no decision row); below the entity/item
 *   cutoffs, item 'adds_nothing' or an item off the picked entity's items
 *   parks with a reason; no shortlist parks as 'no_match' without a Jev call;
 *   otherwise the decision row and the 'analysed' advance happen in ONE
 *   transaction.
 */
import type { Pool } from 'pg';

import { storyCaseSchema, type StoryCase, type StoryCandidateItem } from '@myboon/contracts';

import { callJev, type JevAnswer, type JevPort } from './jev.js';
import { claimSignals, completeClaim, failClaim, type Claim } from './states.js';

/** Analyst implementation marker recorded on every atlas.decisions row. */
export const ANALYST_VERSION = 'analyst-479-v1';

/** Story cutoffs (D25): probability floors and the margin over the runner-up. */
export const ENTITY_PROBABILITY_MIN = 0.85;
export const ENTITY_MARGIN_MIN = 0.30;
export const ITEM_PROBABILITY_MIN = 0.70;
export const ITEM_MARGIN_MIN = 0.20;

const WORKER = 'analyst';
const STAGE = 'story';
const SHORTLIST_MAX = 5;
const ITEMS_PER_CANDIDATE = 5;

export type AnalystOptions = { jev: JevPort; limit: number; leaseMs: number; backoffMs: number; timeoutMs: number };

export type AnalystRun = { claimed: number; analysed: number; parked: number; retried: number; deadLettered: number };

type SignalRow = { signal_id: string; text: string | null; excerpt: string | null; occurred_at: Date | null };

type ShelfRow = { id: string; slug: string; name: string; type: string; aliases: string[] };

type RoutingRuleRow = { token_shelf_id: string; project_shelf_id: string; route_to_shelf_id: string };

/** A shelf with its precompiled alias matchers: whole-word, case-insensitive; '$' aliases match literally with the '$'. */
type ShelfAliases = { shelf: ShelfRow; matchers: Array<{ alias: string; re: RegExp }> };

type ItemRow = { id: string; title: string; summary: string | null; occurred_at: Date | null };

type ShortlistShelf = { id: string; slug: string; name: string; type: string; items: ItemRow[] };

function aliasRegExp(alias: string): RegExp {
  const body = alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?<![\\p{L}\\p{N}_])${body}(?![\\p{L}\\p{N}_])`, 'iu');
}

/**
 * The shortlist (D23): rank active shelves by distinct alias hits, then total
 * alias length, then slug; drop one side of every routing
 * rule whose token AND project shelf both matched, then cap at five (the route_to shelf
 * stays). The route_to shelf is always one of the pair (SQL check), so a rule
 * only ever shrinks the shortlist.
 */
export function linkShortlist(shelves: ShelfAliases[], rules: RoutingRuleRow[], text: string): ShelfRow[] {
  const scored = shelves
    .map(({ shelf, matchers }) => {
      const hits = matchers.filter(({ alias, re }) => alias.length > 0 && re.test(text));
      return { shelf, hits: hits.length, aliasLength: hits.reduce((n, { alias }) => n + alias.length, 0) };
    })
    .filter((s) => s.hits > 0);
  scored.sort((a, b) => b.hits - a.hits || b.aliasLength - a.aliasLength || (a.shelf.slug < b.shelf.slug ? -1 : a.shelf.slug > b.shelf.slug ? 1 : 0));

  // Rules run on the full ranked list, then the cap (CTO #486 review): a dropped
  // pair side must not cost the next-ranked shelf its place.
  let shortlist = scored.map((s) => s.shelf);
  for (const rule of rules) {
    const tokenIndex = shortlist.findIndex((s) => s.id === rule.token_shelf_id);
    const projectIndex = shortlist.findIndex((s) => s.id === rule.project_shelf_id);
    if (tokenIndex === -1 || projectIndex === -1) continue;
    const keepId = rule.route_to_shelf_id === shortlist[tokenIndex].id
      ? shortlist[tokenIndex].id
      : shortlist[projectIndex].id;
    shortlist = shortlist.filter((s) => s.id === keepId || (s.id !== rule.token_shelf_id && s.id !== rule.project_shelf_id));
  }
  return shortlist.slice(0, SHORTLIST_MAX);
}

function toIso(value: Date | string | null): string | null {
  if (value === null) return null;
  return value instanceof Date ? value.toISOString() : value;
}

/**
 * Raw candidate items for a whole shortlist in one query, per shelf: the
 * newest item (`rn = 1`) plus the newest item of every recent week bucket
 * (age 0-7d..28-35d, `min(rn)` per bucket), deduped, topped up with the
 * next-newest items (`fill`) to five, ordered newest first.
 */
async function loadCandidateItems(pool: Pool, shelfIds: string[]): Promise<Map<string, ItemRow[]>> {
  const { rows } = await pool.query<{ shelf_id: string; id: string; title: string; summary: string | null; occurred_at: Date | null }>(`
    with items as (
      select i.main_shelf_id, i.id, i.title, i.summary, i.occurred_at,
             row_number() over (partition by i.main_shelf_id order by i.occurred_at desc, i.id) as rn,
             case
               when i.occurred_at >= now() - make_interval(days => 35)
                 then floor(extract(epoch from (now() - i.occurred_at)) / 604800.0)
             end as wk
        from atlas.items i
       where i.main_shelf_id = any($1::uuid[])
         and i.status = 'active'
         and i.occurred_at is not null
    ),
    bucket_newest as (
      select main_shelf_id, min(rn) as rn
        from items
       where wk is not null and wk between 0 and 4
       group by main_shelf_id, wk
    ),
    seed as (
      select it.main_shelf_id, it.rn
        from items it
       where it.rn = 1
          or exists (select 1 from bucket_newest b where b.main_shelf_id = it.main_shelf_id and b.rn = it.rn)
    ),
    fill as (
      select f.main_shelf_id, f.rn
        from (
          select it.main_shelf_id, it.rn,
                 row_number() over (partition by it.main_shelf_id order by it.rn) as frn,
                 (select count(*) from seed s where s.main_shelf_id = it.main_shelf_id) as seed_n
            from items it
           where not exists (select 1 from seed s where s.main_shelf_id = it.main_shelf_id and s.rn = it.rn)
        ) f
       where f.frn <= ${ITEMS_PER_CANDIDATE} - f.seed_n
    )
    select it.main_shelf_id::text as shelf_id, it.id, it.title, it.summary, it.occurred_at
      from (
        select main_shelf_id, rn from seed union all select main_shelf_id, rn from fill
      ) chosen
      join items it on it.main_shelf_id = chosen.main_shelf_id and it.rn = chosen.rn
     order by it.main_shelf_id, it.occurred_at desc, it.id
  `, [shelfIds]);
  const byShelf = new Map<string, ItemRow[]>();
  for (const row of rows) {
    byShelf.set(row.shelf_id, [
      ...(byShelf.get(row.shelf_id) ?? []),
      { id: row.id, title: row.title, summary: row.summary, occurred_at: row.occurred_at },
    ]);
  }
  return byShelf;
}

function buildStoryCase(signal: SignalRow, shortlist: ShortlistShelf[]): StoryCase {
  return {
    state: {
      signal: {
        signal_id: signal.signal_id,
        text: signal.text,
        excerpt: signal.excerpt,
        occurred_at: toIso(signal.occurred_at),
      },
      candidates: shortlist.map((s) => ({
        slug: s.slug,
        name: s.name,
        type: s.type,
        items: s.items.map((it): StoryCandidateItem => ({ id: it.id, title: it.title, summary: it.summary, occurred_at: toIso(it.occurred_at) })),
      })),
    },
    questions: {
      entity: {
        type: 'choice',
        instructions: 'Which of the candidate entities is this signal mainly about? Choose exactly one candidate slug.',
        criteria: Object.fromEntries(shortlist.map((s) => [s.slug, `${s.name} (${s.type})`])),
      },
      item: {
        type: 'choice',
        instructions:
          'Which listed item does this signal mostly update? Pick its id, or new_story when the signal starts something none of the listed items cover, or adds_nothing when it adds nothing to any of them.',
        criteria: (() => {
          const criteria: Record<string, string> = {};
          for (const s of shortlist) for (const it of s.items) criteria[it.id] = it.title;
          criteria['new_story'] = 'The signal starts a new item that is none of the listed ones';
          criteria['adds_nothing'] = 'The signal adds nothing to any listed item';
          return criteria;
        })(),
      },
    },
  };
}

/** Story picks read off the answer's per-question probabilities (D25). */
type StoryPicks = { entity: string; item: string; entityP: number; entityMargin: number; itemP: number; itemMargin: number };

/**
 * questions.entity and questions.item must be present with a numeric
 * probability; the entity choice must be on the shortlist. Any violation
 * throws, and the claim goes back with backoff -- nothing is parked or filed.
 */
function readStoryPicks(answer: JevAnswer, slugs: string[]): StoryPicks {
  const question = (key: string): { choice: string; probability: number; runnerUpProbability: number } => {
    const entry = (answer.questions as Record<string, unknown> | undefined)?.[key];
    const q = entry as { choice?: unknown; probability?: unknown; runnerUpProbability?: unknown } | undefined;
    if (q === undefined || q === null || typeof q !== 'object' || typeof q.choice !== 'string' || q.choice === '') {
      throw new Error(`invalid_answer: missing questions.${key}`);
    }
    if (typeof q.probability !== 'number' || !Number.isFinite(q.probability) || q.probability < 0 || q.probability > 1) {
      throw new Error(`invalid_answer: questions.${key}.probability out of range`);
    }
    const runnerUp =
      typeof q.runnerUpProbability === 'number' && Number.isFinite(q.runnerUpProbability) ? q.runnerUpProbability : 0;
    return { choice: q.choice, probability: q.probability, runnerUpProbability: runnerUp };
  };
  const entity = question('entity');
  if (!slugs.includes(entity.choice)) throw new Error(`invalid_answer: entity ${entity.choice} is not on the shortlist`);
  const item = question('item');
  return {
    entity: entity.choice,
    item: item.choice,
    entityP: entity.probability,
    entityMargin: entity.probability - entity.runnerUpProbability,
    itemP: item.probability,
    itemMargin: item.probability - item.runnerUpProbability,
  };
}

const pp = (n: number) => n.toFixed(2);

/**
 * Files the decision and advances to 'analysed' in ONE transaction on one
 * pooled client: the decision insert (on conflict do nothing for a repeated
 * analyst version) and the claim-checked advance of the state machine. A lost
 * claim rolls the insert back; the signal stays claimable for the next run.
 */
async function fileDecision(
  pool: Pool,
  claim: Claim,
  d: { confidence: number; shelves: string[]; targetItemId: string | null; reason: 'linked' | 'new_story'; entityP: number; entityMargin: number; itemP: number; itemMargin: number },
): Promise<boolean> {
  const client = await pool.connect();
  try {
    await client.query('begin');
    try {
      await client.query(
        `insert into atlas.decisions
           (schema_version, signal_id, analyst_version, decision_type, action, confidence, shelves, target_item_id, reason,
            entity_p, entity_margin, item_p, item_margin)
         values (1, $1, $2, 'file', 'keep', $3, $4::jsonb, $5, $6, $7, $8, $9, $10)
         on conflict (signal_id, analyst_version) do nothing`,
        [claim.signalId, ANALYST_VERSION, d.confidence, JSON.stringify(d.shelves), d.targetItemId, d.reason, d.entityP, d.entityMargin, d.itemP, d.itemMargin],
      );
      const advanced = await completeClaim(client, claim, { to: 'analysed' });
      if (!advanced) {
        await client.query('rollback');
        return false;
      }
      await client.query('commit');
      return true;
    } catch (err) {
      await client.query('rollback').catch(() => undefined);
      throw err;
    }
  } finally {
    client.release();
  }
}

/** One claim went back for a retry with backoff (dead-letter at the attempt cap). */
async function retryClaim(pool: Pool, claim: Claim, error: string, run: AnalystRun, o: AnalystOptions): Promise<void> {
  const result = await failClaim(pool, claim, { error, backoffMs: o.backoffMs });
  if (result === 'retry') run.retried += 1;
  if (result === 'dead_lettered') run.deadLettered += 1;
}

/** Thrown at startup when the analyst configuration is unsafe to run. */
export class AnalystConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AnalystConfigError';
  }
}

/** The lease must outlive one Jev call by this share of the timeout (claim + DB writes + clock slack). */
export const LEASE_MARGIN_RATIO = 0.2;

/**
 * Fail fast (CTO #486 review): a lease that is not longer than the Jev timeout
 * plus a 20% margin can lapse during a single call, letting another worker
 * reclaim the signal and call Jev twice.
 */
export function assertAnalystTiming(o: { leaseMs: number; timeoutMs: number }): void {
  const ok = Number.isFinite(o.leaseMs) && Number.isFinite(o.timeoutMs) && o.timeoutMs > 0
    && o.leaseMs > o.timeoutMs * (1 + LEASE_MARGIN_RATIO);
  if (!ok) {
    throw new AnalystConfigError(
      `lease ${o.leaseMs}ms must be greater than the Jev timeout ${o.timeoutMs}ms plus ${LEASE_MARGIN_RATIO * 100}%`,
    );
  }
}

/**
 * Works up to o.limit signals, claiming ONE at a time (claim, analyse, next
 * claim), so a lease only ever has to cover a single Jev call (CTO #486
 * review: a batch lease lapsed mid-run and allowed a second Jev call).
 */
export async function runAnalystOnce(pool: Pool, o: AnalystOptions): Promise<AnalystRun> {
  assertAnalystTiming(o);
  const run: AnalystRun = { claimed: 0, analysed: 0, parked: 0, retried: 0, deadLettered: 0 };
  for (let i = 0; i < o.limit; i++) {
    const claims = await claimSignals(pool, { state: 'received', limit: 1, leaseMs: o.leaseMs, worker: WORKER });
    if (claims.length === 0) break;
    run.claimed += 1;
    await analyseClaims(pool, claims, o, run);
  }
  return run;
}

async function analyseClaims(pool: Pool, claims: Claim[], o: AnalystOptions, run: AnalystRun): Promise<void> {

  const { rows: signalRows } = await pool.query<SignalRow>(
    'select signal_id, text, excerpt, occurred_at from atlas.signals where signal_id = any($1)',
    [claims.map((c) => c.signalId)],
  );
  const signalById = new Map(signalRows.map((r) => [r.signal_id, r]));

  // The linker reads both tables whole per run: matching happens in code (D23)
  // and the shelf/alias volume is small next to the per-signal Jev work.
  const { rows: shelfRows } = await pool.query<ShelfRow>(
    "select id, slug, name, type, aliases from atlas.shelves where status = 'active'",
  );
  const shelved: ShelfAliases[] = shelfRows.map((shelf) => ({
    shelf,
    matchers: shelf.aliases.map((alias) => ({ alias, re: aliasRegExp(alias) })),
  }));
  const { rows: ruleRows } = await pool.query<RoutingRuleRow>(
    'select token_shelf_id, project_shelf_id, route_to_shelf_id from atlas.routing_rules',
  );

  for (const claim of claims) {
    const signal = signalById.get(claim.signalId);
    if (signal === undefined) {
      await retryClaim(pool, claim, 'signal row missing', run, o);
      continue;
    }

    const hay = [signal.text, signal.excerpt].filter((t): t is string => t !== null).join('\n');
    const linked = linkShortlist(shelved, ruleRows, hay);
    if (linked.length === 0) {
      // No-match path: parked without a Jev call. Digging the missing shelf
      // or alias out of parked is the next issue's work.
      if (await completeClaim(pool, claim, { to: 'parked', parkReason: 'no_match' })) run.parked += 1;
      continue;
    }

    const itemsByShelf = await loadCandidateItems(pool, linked.map((s) => s.id));
    const shortlist: ShortlistShelf[] = linked.map((s) => ({ ...s, items: itemsByShelf.get(s.id) ?? [] }));
    const inputCase = buildStoryCase(signal, shortlist);

    try {
      storyCaseSchema.parse(inputCase);
    } catch (err) {
      await retryClaim(pool, claim, `invalid_case: ${err instanceof Error ? err.message : String(err)}`, run, o);
      continue;
    }

    const outcome = await callJev(pool, o.jev, {
      signalId: claim.signalId,
      stage: STAGE,
      inputCase,
      timeoutMs: o.timeoutMs,
    });
    if (outcome.status !== 'success') {
      await retryClaim(pool, claim, outcome.error, run, o);
      continue;
    }

    let picks: StoryPicks;
    try {
      picks = readStoryPicks(outcome.answer, shortlist.map((s) => s.slug));
    } catch (err) {
      await retryClaim(pool, claim, err instanceof Error ? err.message : String(err), run, o);
      continue;
    }

    const picked = shortlist.find((s) => s.slug === picks.entity)!;
    const parkReason =
      picks.entityP < ENTITY_PROBABILITY_MIN || picks.entityMargin < ENTITY_MARGIN_MIN
        ? `below_cutoff: entity p=${pp(picks.entityP)} margin=${pp(picks.entityMargin)}`
        : picks.itemP < ITEM_PROBABILITY_MIN || picks.itemMargin < ITEM_MARGIN_MIN
          ? `below_cutoff: item p=${pp(picks.itemP)} margin=${pp(picks.itemMargin)}`
          : picks.item === 'adds_nothing'
            ? 'adds_nothing'
            : picks.item !== 'new_story' && !picked.items.some((it) => it.id === picks.item)
              ? `disagreeing_pick: item ${picks.item} is not among ${picked.slug} items`
              : null;
    if (parkReason !== null) {
      if (await completeClaim(pool, claim, { to: 'parked', parkReason })) run.parked += 1;
      continue;
    }

    const isLinked = picks.item !== 'new_story';
    if (await fileDecision(pool, claim, {
      confidence: picks.entityP,
      shelves: [picked.slug],
      targetItemId: isLinked ? picks.item : null,
      reason: isLinked ? 'linked' : 'new_story',
      entityP: picks.entityP,
      entityMargin: picks.entityMargin,
      itemP: picks.itemP,
      itemMargin: picks.itemMargin,
    })) {
      run.analysed += 1;
    }
  }
}