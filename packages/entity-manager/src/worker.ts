/** #571 entity-manager worker: claim -> decide -> apply, one decision row at a time. */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { parseAnalystHandoff, type AnalystHandoff } from '@myboon/contracts';
import pg from 'pg';

import type { Jev, Llm } from './clients.js';
import { decide, emOutcome, MAX_RECENT_ITEMS, signalImage, type DecideResult, type EntityRow, type RecentItem } from './decide.js';

export type Claim = { decision_id: string; signal_id: string; claim_token: string; attempts: number };
export type RunSummary = { claimed: number; story: number; parked: number; duplicate: number; deferred_no_entity: number; failed: number; retry: number; lost: number };

const CA_PATH = fileURLToPath(new URL('../certs/supabase-prod-ca-2021.crt', import.meta.url));
const LOCAL = new Set(['', 'localhost', '127.0.0.1', '::1', '[::1]']);

export function createPool(databaseUrl: string): pg.Pool {
  const url = new URL(databaseUrl);
  for (const k of [...url.searchParams.keys()].filter((k) => /^ssl/i.test(k))) url.searchParams.delete(k);
  const ssl = LOCAL.has(url.hostname) ? false : { rejectUnauthorized: true as const, ca: readFileSync(process.env.ENTITY_MANAGER_DATABASE_CA_FILE?.trim() || CA_PATH, 'utf8') };
  return new pg.Pool({ connectionString: url.toString(), ssl, max: 2 });
}

type Q = Pick<pg.PoolClient, 'query'>;

export async function loadEntity(db: Q, slug: string): Promise<EntityRow | null> {
  const r = await db.query<EntityRow>('select id, slug, name, type, summary from atlas.entities where slug = $1 and status = $2', [slug, 'active']);
  return r.rows[0] ?? null;
}

export async function loadRecentItems(db: Q, entityId: string): Promise<RecentItem[]> {
  const r = await db.query<{ id: string; title: string; summary: string | null; date: Date | null }>(
    `select id, title, summary, coalesce(occurred_at, created_at) as date from atlas.entity_items
      where main_entity_id = $1 and status = 'active'
      order by coalesce(occurred_at, created_at) desc, id desc limit $2`,
    [entityId, MAX_RECENT_ITEMS],
  );
  return r.rows.map((x) => ({ id: x.id, title: x.title, summary: x.summary, date: x.date ? x.date.toISOString() : null }));
}

export async function loadHandoff(db: Q, decisionId: string): Promise<AnalystHandoff> {
  const r = await db.query<{ handoff: unknown }>('select handoff from atlas.decisions where id = $1', [decisionId]);
  return parseAnalystHandoff(r.rows[0]?.handoff);
}

/** Growth rows (keep, no entity) are out of scope for now: put them back untouched, retry in a day. */
async function defer(db: Q, c: Claim): Promise<void> {
  await db.query(
    `update atlas.decisions set em_status = 'pending', em_claim_token = null, em_claim_expires_at = null, em_claimed_by = null,
            em_attempts = greatest(em_attempts - 1, 0), em_next_attempt_at = now() + interval '1 day'
      where id = $1 and em_status = 'claimed' and em_claim_token = $2`,
    [c.decision_id, c.claim_token],
  );
}

/** Apply one decision in one transaction, under the per-entity advisory lock. Returns false if the claim was lost. */
export async function apply(pool: pg.Pool, c: Claim, h: AnalystHandoff, entity: EntityRow, d: DecideResult): Promise<boolean> {
  const db = await pool.connect();
  try {
    await db.query('begin');
    await db.query("select pg_advisory_xact_lock(hashtext('atlas.entity:' || $1))", [entity.slug]);
    if (d.decision === 'story') {
      const ins = await db.query<{ id: string }>(
        `insert into atlas.entity_items (item_key, title, summary, main_entity_id, occurred_at, signal_id, angle, note, image_url)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         on conflict (item_key) do nothing returning id`,
        [`${h.signal_id}:${entity.slug}`, d.title, d.summary, entity.id, h.signal.occurred_at ?? h.signal.created_at, h.signal_id,
          h.entity!.angle, h.entity!.note, signalImage(h)],
      );
      const itemId = ins.rows[0]?.id;
      if (itemId) {
        await db.query(`insert into atlas.item_signals (item_id, signal_id, role) values ($1, $2, 'origin') on conflict do nothing`, [itemId, h.signal_id]);
      }
    } else if (d.decision === 'park') {
      await db.query(
        `insert into atlas.entity_context (entity_id, signal_id, decision_id, reason, sentiment)
         values ($1, $2, $3, $4, null) on conflict (entity_id, signal_id) do nothing`,
        [entity.id, h.signal_id, c.decision_id, d.reason.slice(0, 2000)],
      );
    }
    const fin = await db.query<{ ok: boolean }>('select atlas.em_finish($1, $2, $3, $4) as ok', [
      c.decision_id, c.claim_token, emOutcome(d.decision), d.decision === 'duplicate' ? d.duplicate_of : null,
    ]);
    if (!fin.rows[0]?.ok) {
      await db.query('rollback');
      return false;
    }
    await db.query('commit');
    return true;
  } catch (e) {
    await db.query('rollback').catch(() => {});
    throw e;
  } finally {
    db.release();
  }
}

export type WorkerDeps = { pool: pg.Pool; llm: Llm; jev?: Jev; worker: string; limit: number; leaseSeconds?: number; log?: (e: Record<string, unknown>) => void };

export async function runOnce(deps: WorkerDeps): Promise<RunSummary> {
  const sum: RunSummary = { claimed: 0, story: 0, parked: 0, duplicate: 0, deferred_no_entity: 0, failed: 0, retry: 0, lost: 0 };
  const log = deps.log ?? ((e) => console.log(JSON.stringify(e)));
  for (let i = 0; i < deps.limit; i++) {
    const r = await deps.pool.query<Claim>('select * from atlas.em_claim($1, make_interval(secs => $2), 3)', [deps.worker, deps.leaseSeconds ?? 300]);
    const c = r.rows[0];
    if (!c) break;
    sum.claimed++;
    try {
      const h = await loadHandoff(deps.pool, c.decision_id);
      if (!h.entity) {
        await defer(deps.pool, c);
        sum.deferred_no_entity++;
        continue;
      }
      const entity = await loadEntity(deps.pool, h.entity.slug);
      if (!entity) throw new Error(`entity ${h.entity.slug} not found or not active`);
      const items = await loadRecentItems(deps.pool, entity.id);
      const d = await decide(entity, items, h, deps);
      const ok = await apply(deps.pool, c, h, entity, d);
      if (!ok) { sum.lost++; continue; }
      sum[d.decision === 'park' ? 'parked' : d.decision]++;
      log({ event: 'em_decision', decision_id: c.decision_id, signal_id: c.signal_id, entity: entity.slug, decision: d.decision, jev: d.jev?.choice, reason: d.reason });
    } catch (e) {
      const msg = (e instanceof Error ? e.message : String(e)).slice(0, 1000);
      const f = await deps.pool.query<{ r: string }>('select atlas.em_fail($1, $2, $3) as r', [c.decision_id, c.claim_token, msg]);
      const outcome = f.rows[0]?.r;
      if (outcome === 'failed') sum.failed++; else if (outcome === 'retry') sum.retry++; else sum.lost++;
      log({ event: 'em_fail', decision_id: c.decision_id, signal_id: c.signal_id, outcome, error: msg });
    }
  }
  return sum;
}
