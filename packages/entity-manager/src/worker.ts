/** #571 entity-manager worker: claim -> decide -> apply, one decision row at a time. */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { parseAnalystHandoff, type AnalystHandoff } from '@myboon/contracts';
import pg from 'pg';

import type { Jev, Llm } from './clients.js';
import type { ClaimScope } from './config.js';
import { decide, emOutcome, MAX_RECENT_ITEMS, signalImage, type DecideResult, type EntityRow, type RecentItem } from './decide.js';

export type Claim = { decision_id: string; signal_id: string; claim_token: string; attempts: number };
export type RunSummary = { claimed: number; story: number; parked: number; duplicate: number; deferred_no_entity: number; parked_stale_no_entity: number; failed: number; retry: number; lost: number };

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

/** #621: a no-entity handoff older than this is parked for good instead of being put back for another day. */
export const NO_ENTITY_MAX_AGE_DAYS = 7;
export const NO_ENTITY_PARK_REASON = `no entity after ${NO_ENTITY_MAX_AGE_DAYS} days: parked, not retried (#621)`;

/**
 * Terminal park for a stale no-entity handoff (same end state as atlas.em_finish(..., 'parked'), plus the reason in
 * em_last_error). Only a live claim of ours, only a decision older than NO_ENTITY_MAX_AGE_DAYS. Returns true if parked.
 */
export async function parkStaleNoEntity(db: Q, c: Claim): Promise<boolean> {
  const r = await db.query(
    `update atlas.decisions set em_status = 'parked', em_last_error = $3, em_done_at = now(),
            em_claim_token = null, em_claim_expires_at = null, em_claimed_by = null
      where id = $1 and em_status = 'claimed' and em_claim_token = $2 and em_claim_expires_at >= now()
        and created_at < now() - make_interval(days => $4)`,
    [c.decision_id, c.claim_token, NO_ENTITY_PARK_REASON, NO_ENTITY_MAX_AGE_DAYS],
  );
  return r.rowCount === 1;
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

export const MISSING_SCOPED_CLAIM_MSG =
  'atlas.em_claim_scoped does not exist: apply supabase/migrations/20261113190000_atlas_em_claim_scoped.sql (DB Guy) before turning ENTITY_MANAGER_CLAIM_ENTITY_ONLY or ENTITY_MANAGER_RETRY_ENABLED on; nothing was claimed';

/** #621 lag signal: age in minutes of the oldest ready pending handoff that has an entity, or null when there is none. */
export async function oldestReadyEntityAgeMinutes(db: Q): Promise<number | null> {
  const r = await db.query<{ age: string | null }>(
    `select extract(epoch from now() - min(created_at)) / 60 as age from atlas.decisions
      where em_status = 'pending' and em_next_attempt_at <= now() and jsonb_typeof(handoff -> 'entity') = 'object'`,
  );
  const age = r.rows[0]?.age;
  return age == null ? null : Math.round(Number(age));
}

/** The WARN line when the oldest ready entity row is older than `thresholdMinutes`; null otherwise. */
export function lagWarning(ageMinutes: number | null, thresholdMinutes: number): Record<string, unknown> | null {
  if (ageMinutes === null || ageMinutes <= thresholdMinutes) return null;
  return { level: 'warn', event: 'em_lag_warn', oldest_ready_entity_age_min: ageMinutes, threshold_min: thresholdMinutes, msg: `entity manager is ${ageMinutes} min behind (oldest ready row with an entity), over the ${thresholdMinutes} min threshold` };
}

/** Claim SQL: no scope is the #593 atlas.em_claim (unchanged); a scope uses atlas.em_claim_scoped (#621). */
export function claimQuery(scope: ClaimScope | undefined): string {
  return scope === undefined
    ? 'select * from atlas.em_claim($1, make_interval(secs => $2), 3)'
    : 'select * from atlas.em_claim_scoped($1, $3, make_interval(secs => $2), 3)';
}

export type WorkerDeps = { pool: pg.Pool; llm: Llm; jev?: Jev; worker: string; limit: number; scope?: ClaimScope; leaseSeconds?: number; log?: (e: Record<string, unknown>) => void };

export async function runOnce(deps: WorkerDeps): Promise<RunSummary> {
  const sum: RunSummary = { claimed: 0, story: 0, parked: 0, duplicate: 0, deferred_no_entity: 0, parked_stale_no_entity: 0, failed: 0, retry: 0, lost: 0 };
  const log = deps.log ?? ((e) => console.log(JSON.stringify(e)));
  for (let i = 0; i < deps.limit; i++) {
    const params: unknown[] = [deps.worker, deps.leaseSeconds ?? 300];
    if (deps.scope !== undefined) params.push(deps.scope);
    let r: pg.QueryResult<Claim>;
    try {
      r = await deps.pool.query<Claim>(claimQuery(deps.scope), params);
    } catch (e) {
      // 42883 undefined_function: the flag is on but the migration is not applied. Stop the run once, loudly (never reached with the flag off).
      if (deps.scope !== undefined && (e as { code?: string }).code === '42883') throw new Error(MISSING_SCOPED_CLAIM_MSG);
      throw e;
    }
    const c = r.rows[0];
    if (!c) break;
    sum.claimed++;
    try {
      const h = await loadHandoff(deps.pool, c.decision_id);
      if (!h.entity) {
        // #621 retry run only (scope 'no_entity'): a row that has had no entity for 7 days is parked for good. With the flag off
        // (no scope) nothing changes: every no-entity row is put back for a day as before.
        if (deps.scope === 'no_entity' && (await parkStaleNoEntity(deps.pool, c))) {
          sum.parked_stale_no_entity++;
          log({ event: 'em_park_stale_no_entity', decision_id: c.decision_id, signal_id: c.signal_id });
          continue;
        }
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
