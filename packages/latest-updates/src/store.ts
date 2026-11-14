/**
 * Reads and writes against Atlas, as the insert-only latest_update_worker role (LATEST_UPDATES_DATABASE_URL).
 *
 * Reads (SELECT only), with the exact columns used:
 *   atlas.entities       id, slug, name, type, summary, status
 *   atlas.entity_items   id, title, summary, note, angle, occurred_at, created_at, signal_id, status, main_entity_id
 *   atlas.item_signals   item_id, signal_id, role
 *   atlas.signals        signal_id, type, source, text, excerpt, numbers, link, occurred_at, created_at
 *   atlas.latest_updates / latest_update_items / latest_update_runs   (our own rows, to know what we last published)
 * Writes: INSERT into atlas.latest_update_runs, atlas.latest_updates, atlas.latest_update_items only. There is no
 * UPDATE and no DELETE anywhere in this package, and no write to any other table.
 *
 * The window is ALWAYS entity_items.occurred_at: there is no parameter for the basis.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import pg from 'pg';

import { MAX_ATTEMPTS, type Visibility } from './config.js';
import { EDITOR_VERSION } from './editor.js';
import type { Bundle, Draft, Item, LastUpdate, Signal } from './types.js';

export const MAX_PRIOR_ITEMS = 7;

export type Candidate = { entityId: string; slug: string; newestItemId: string; newestOccurredAt: string; errorCount: number };

export type Decision = 'published' | 'hold' | 'skip' | 'error';
export type DecisionWrite = {
  entityId: string;
  newestItemId: string;
  decision: Decision;
  reason: string;
  checkFailures: Array<{ check: string; detail: string }>;
  /** Only for `published`: the draft and the new item ids that become latest_update_items. */
  publish?: { draft: Draft; itemIds: string[]; model: string; visibility: Visibility };
};
export type WriteResult = { outcome: 'written'; decision: Decision; attempt: number } | { outcome: 'already_decided' };

export interface Store {
  listCandidates(opts: { now: Date; windowHours: number; limit: number }): Promise<Candidate[]>;
  loadBundle(candidate: Candidate, opts: { now: Date; windowHours: number }): Promise<Bundle | null>;
  /** One transaction: the run row, and for `published` the update and its items. All or nothing. */
  record(write: DecisionWrite): Promise<WriteResult>;
}

type Q = Pick<pg.PoolClient, 'query'>;

const CA_PATH = fileURLToPath(new URL('../certs/supabase-prod-ca-2021.crt', import.meta.url));
const LOCAL = new Set(['', 'localhost', '127.0.0.1', '::1', '[::1]']);

/** Same TLS rule as @myboon/entity-manager: verify against the Supabase CA unless the host is local. */
export function createPool(databaseUrl: string, max = 3): pg.Pool {
  const url = new URL(databaseUrl);
  for (const k of [...url.searchParams.keys()].filter((key) => /^ssl/i.test(key))) url.searchParams.delete(k);
  const ssl = LOCAL.has(url.hostname)
    ? false
    : { rejectUnauthorized: true as const, ca: readFileSync(process.env.LATEST_UPDATES_DATABASE_CA_FILE?.trim() || CA_PATH, 'utf8') };
  return new pg.Pool({ connectionString: url.toString(), ssl, max });
}

export const CANDIDATES_SQL = `
with w as (
  select i.id, i.main_entity_id as entity_id, i.occurred_at
    from atlas.entity_items i
    join atlas.entities e on e.id = i.main_entity_id and e.status = 'active'
   where i.status = 'active'
     and i.occurred_at is not null
     and i.occurred_at <= $1::timestamptz
     and i.occurred_at >= $1::timestamptz - make_interval(hours => $2::int)
), newest as (
  select distinct on (entity_id) entity_id, id as newest_item_id, occurred_at
    from w
   order by entity_id, occurred_at desc, id desc
)
select n.entity_id, e.slug, n.newest_item_id, n.occurred_at,
       (select count(*)::int from atlas.latest_update_runs r
         where r.entity_id = n.entity_id and r.newest_entity_item_id = n.newest_item_id and r.decision = 'error') as errors
  from newest n
  join atlas.entities e on e.id = n.entity_id
 where not exists (select 1 from atlas.latest_update_runs r
                    where r.entity_id = n.entity_id and r.newest_entity_item_id = n.newest_item_id and r.decision <> 'error')
   and not exists (select 1 from atlas.latest_updates u
                    where u.entity_id = n.entity_id and u.newest_entity_item_id = n.newest_item_id)
 order by n.occurred_at asc, n.newest_item_id asc
 limit $3`;

const ITEM_COLUMNS = 'id, title, summary, note, angle, occurred_at, created_at, signal_id';

const iso = (v: unknown): string | null => (v instanceof Date ? v.toISOString() : typeof v === 'string' ? v : null);

type ItemRow = { id: string; title: string; summary: string | null; note: string | null; angle: string | null; occurred_at: Date | null; created_at: Date; signal_id: string | null };
const toItem = (r: ItemRow): Item => ({
  id: r.id, title: r.title, summary: r.summary, note: r.note, angle: r.angle,
  occurred_at: iso(r.occurred_at), created_at: iso(r.created_at) ?? '', signal_id: r.signal_id,
});

const itemAsText = (i: Item) => [i.title, i.summary ?? '', i.note ?? ''].filter(Boolean).join('\n');

export async function loadBundle(db: Q, c: Candidate, opts: { now: Date; windowHours: number }): Promise<Bundle | null> {
  const ent = await db.query<{ id: string; slug: string; name: string; type: string; summary: string | null }>(
    "select id, slug, name, type, summary from atlas.entities where id = $1 and status = 'active'", [c.entityId]);
  const entity = ent.rows[0];
  if (!entity) return null;

  const win = await db.query<ItemRow>(
    `select ${ITEM_COLUMNS} from atlas.entity_items
      where main_entity_id = $1 and status = 'active' and occurred_at is not null
        and occurred_at <= $2::timestamptz and occurred_at >= $2::timestamptz - make_interval(hours => $3::int)
      order by occurred_at desc, id desc`,
    [c.entityId, opts.now, opts.windowHours]);

  // What we last published: our own newest latest_updates row, dark or live (it is our memory, not the reader's view).
  const pub = await db.query<{ id: string; headline: string; what_happened: string; how_we_got_here: string; what_to_watch: string; published_at: Date }>(
    `select id, headline, what_happened, how_we_got_here, what_to_watch, published_at from atlas.latest_updates
      where entity_id = $1 order by published_at desc, id desc limit 1`, [c.entityId]);
  const published = pub.rows[0];
  const covered = new Set<string>();
  if (published) {
    const r = await db.query<{ entity_item_id: string }>('select entity_item_id from atlas.latest_update_items where latest_update_id = $1', [published.id]);
    for (const row of r.rows) covered.add(row.entity_item_id);
  }
  const newItems = win.rows.filter((r) => !covered.has(r.id)).map(toItem);
  if (!newItems.some((i) => i.id === c.newestItemId)) return null;

  const prior = await db.query<ItemRow>(
    `select ${ITEM_COLUMNS} from atlas.entity_items
      where main_entity_id = $1 and status = 'active' and id <> all($2::uuid[])
        and coalesce(occurred_at, created_at) <= $3::timestamptz
      order by coalesce(occurred_at, created_at) desc, id desc limit ${MAX_PRIOR_ITEMS}`,
    [c.entityId, newItems.map((i) => i.id), opts.now]);
  const priorItems = prior.rows.map(toItem);

  let lastUpdate: LastUpdate | null = null;
  if (published) {
    lastUpdate = {
      kind: 'published', id: published.id, title: published.headline, date: iso(published.published_at),
      text: [published.headline, published.what_happened, published.how_we_got_here, published.what_to_watch].join('\n'),
    };
  } else if (priorItems[0]) {
    const p = priorItems[0];
    lastUpdate = { kind: 'earlier_item', id: p.id, title: p.title, date: p.occurred_at ?? p.created_at, text: itemAsText(p) };
  }

  const itemIds = [...newItems, ...priorItems].map((i) => i.id);
  const ownSignalIds = [...newItems, ...priorItems].map((i) => i.signal_id).filter((s): s is string => s !== null);
  const sig = await db.query<{ signal_id: string; type: string | null; source: string | null; text: string | null; excerpt: string | null; numbers: unknown; link: string | null; occurred_at: Date | null; created_at: Date | null }>(
    `select s.signal_id, s.type, s.source, s.text, s.excerpt, s.numbers, s.link, s.occurred_at, s.created_at
       from atlas.signals s
      where s.signal_id in (select signal_id from atlas.item_signals where item_id = any($1::uuid[]) and role = 'origin'
                            union select unnest($2::text[]))
      order by s.signal_id`,
    [itemIds, ownSignalIds]);
  const signals: Signal[] = sig.rows.map((s) => ({
    signal_id: s.signal_id, type: s.type, source: s.source, text: s.text,
    excerpt: s.excerpt && s.excerpt !== s.text ? s.excerpt : null,
    numbers: s.numbers, link: s.link, occurred_at: iso(s.occurred_at), created_at: iso(s.created_at),
  }));

  return { entity, newest_item_id: c.newestItemId, new_items: newItems, prior_items: priorItems, origin_signals: signals, last_update: lastUpdate };
}

/**
 * Write one decision in one transaction, under a per-(entity) advisory lock. The attempt number is the number of
 * `error` rows for the pair, plus one, counted inside the transaction. A third failed attempt is written as a
 * `hold` (retries_exhausted). A second final decision for the pair is refused by the partial unique index and
 * reported as `already_decided` with nothing written.
 */
export async function record(pool: pg.Pool, w: DecisionWrite): Promise<WriteResult> {
  const db = await pool.connect();
  try {
    await db.query('begin');
    await db.query("select pg_advisory_xact_lock(hashtext('atlas.latest_update:' || $1))", [w.entityId]);
    const errors = await db.query<{ n: number }>(
      "select count(*)::int as n from atlas.latest_update_runs where entity_id = $1 and newest_entity_item_id = $2 and decision = 'error'",
      [w.entityId, w.newestItemId]);
    const attempt = (errors.rows[0]?.n ?? 0) + 1;
    let { decision, reason, checkFailures } = w;
    if (decision === 'error' && attempt >= MAX_ATTEMPTS) {
      checkFailures = [...checkFailures, { check: 'retries', detail: reason.slice(0, 300) }];
      decision = 'hold';
      reason = 'retries_exhausted';
    }
    const params = [w.entityId, w.newestItemId, decision, reason.slice(0, 500), JSON.stringify(checkFailures), attempt];
    const runSql = 'insert into atlas.latest_update_runs (entity_id, newest_entity_item_id, decision, reason, check_failures, attempt) values ($1, $2, $3, $4, $5::jsonb, $6)';
    let runId: string | undefined;
    if (decision === 'error') {
      runId = (await db.query<{ id: string }>(`${runSql} returning id`, params)).rows[0]?.id;
    } else {
      runId = (await db.query<{ id: string }>(
        `${runSql} on conflict (entity_id, newest_entity_item_id) where decision <> 'error' do nothing returning id`, params)).rows[0]?.id;
    }
    if (!runId) {
      await db.query('rollback');
      return { outcome: 'already_decided' };
    }
    if (decision === 'published' && w.publish) {
      const { draft, itemIds, model, visibility } = w.publish;
      const upd = await db.query<{ id: string }>(
        `insert into atlas.latest_updates
           (entity_id, headline, what_happened, how_we_got_here, what_to_watch, claims, newest_entity_item_id, editor_version, model, run_id, visibility)
         values ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, $10, $11) returning id`,
        [w.entityId, draft.title, draft.what_happened, draft.how_we_got_here, draft.what_to_watch, JSON.stringify(draft.claims),
          w.newestItemId, EDITOR_VERSION, model, runId, visibility]);
      const updateId = upd.rows[0]!.id;
      for (const itemId of new Set(itemIds)) {
        await db.query('insert into atlas.latest_update_items (latest_update_id, entity_item_id) values ($1, $2)', [updateId, itemId]);
      }
    }
    await db.query('commit');
    return { outcome: 'written', decision, attempt };
  } catch (e) {
    await db.query('rollback').catch(() => {});
    throw e;
  } finally {
    db.release();
  }
}

export function createPgStore(pool: pg.Pool): Store {
  return {
    async listCandidates({ now, windowHours, limit }) {
      const r = await pool.query<{ entity_id: string; slug: string; newest_item_id: string; occurred_at: Date; errors: number }>(CANDIDATES_SQL, [now, windowHours, limit]);
      return r.rows.map((x) => ({ entityId: x.entity_id, slug: x.slug, newestItemId: x.newest_item_id, newestOccurredAt: x.occurred_at.toISOString(), errorCount: x.errors }));
    },
    loadBundle: (candidate, opts) => loadBundle(pool, candidate, opts),
    record: (w) => record(pool, w),
  };
}
