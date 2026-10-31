/**
 * #480 the timed entity manager, on a throwaway LOCAL Postgres (ANALYST_TEST_ADMIN_URL). The job
 * pool runs as service_role (the role the PM2 entry will use), the DB role checks mirror
 * runner.db.test.ts acting as analyst_worker, and the LLM is scripted. What this pins:
 *   - alias: 1 transaction moves the proposed shelf's items to the active target (skipping any item
 *     whose (signal_id, target) already exists, so that item stays put), appends the proposed slug
 *     to the target aliases once, retires the shelf, and writes one entity_reviews row per distinct
 *     signal (applied=true, decision linked, alias_target_id set);
 *   - reject: shelf retired, items stay, applied=true rows; the existing drop-at-filing behaviour
 *     still drops a kind-new filing for the retired slug (d36-worker.ts is untouched);
 *   - new: shelf stays proposed with applied=false rows; the next run makes NO LLM call for it
 *     until a new item lands there, then it is reviewed again;
 *   - invalid JSON, unknown or non-active alias_of, LLM error and LLM timeout change nothing and
 *     log entity_review_failed;
 *   - a quota guard stop makes no LLM call (stop_reason 'quota'); maxShelves truncates (stop_reason
 *     'max'); a shelf that is no longer proposed at apply time is skipped without writes.
 * Counter contract (mirrors catchup): reviewed = aliased + rejected + kept_new + failed; skipped =
 * eligible shelves left untouched without an applied verdict (token-rule skips and raced shelves,
 * whose LLM call still shows in llm_calls); llm_calls counts every call. Shelves are processed in
 * slug order (deterministic cap).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool, type Pool as PoolType } from 'pg';
import { createThrowawayDatabase, type ThrowawayDatabase } from '@myboon/atlas-schema';
import { parseAnalystOutput } from '@myboon/contracts';

import { PgDecisionSink } from './d36-worker.js';
import { reviewProposedShelves, type EntityManagerOptions } from './entity-manager.js';
import { createQuotaGuard } from './ollama-quota.js';
import type { ChatMessage, Llm } from './session.js';

const ADMIN_URL = process.env.ANALYST_TEST_ADMIN_URL?.trim() ?? '';

/**
 * Scripted LLM; the reply may be a string, an Error, or per-prompt text. `onCall` runs while the
 * reply is pending (the race case: it retires the shelf between the LLM call and the apply), and
 * the prompts are kept for assertions.
 */
function scriptedLlm(
  reply: string | ((prompt: string) => (string | Error)),
  o: { slowMs?: number; onCall?: () => Promise<void> | void } = {},
): Llm & { calls: number; prompts: string[] } {
  const llm = (async (messages: ChatMessage[]) => {
    llm.calls += 1;
    const prompt = messages.map((m) => `${m.role}: ${m.content}`).join('\n');
    llm.prompts.push(prompt);
    if (o.slowMs) await new Promise((resolve) => setTimeout(resolve, o.slowMs));
    if (o.onCall) await o.onCall();
    const r = typeof reply === 'function' ? reply(prompt) : reply;
    if (r instanceof Error) throw r;
    return r;
  }) as Llm & { calls: number; prompts: string[] };
  llm.calls = 0;
  llm.prompts = [];
  return llm;
}

const aliasReply = (slug: string, reason = 'same entity'): string =>
  JSON.stringify({ decision: 'alias', alias_of: slug, reason });
const rejectReply = (reason = 'not a real entity'): string =>
  JSON.stringify({ decision: 'reject', alias_of: null, reason });
const newReply = (reason = 'deserves its own entity'): string =>
  JSON.stringify({ decision: 'new', alias_of: null, reason });

describe.skipIf(ADMIN_URL === '')('#480 entity manager run (local Postgres, service_role role)', () => {
  let db: ThrowawayDatabase;
  let pool: PoolType;
  let svcPool: PoolType;
  let workerPool: PoolType;

  const rolePoolFor = (url: string, role: string): PoolType => {
    const p = new Pool({ connectionString: url, max: 2 });
    p.on('connect', (c) => c.query(`set role ${role}`));
    return p;
  };
  const logOf = () => {
    const events: Record<string, unknown>[] = [];
    return { events, log: (e: Record<string, unknown>) => { events.push(e); } };
  };
  const review = (llm: Llm, o: Partial<EntityManagerOptions> = {}) =>
    reviewProposedShelves(svcPool, { llm, modelName: 'glm-5.3-flash', maxShelves: 40, timeoutMs: 1_000, log: () => {}, ...o });

  const seedShelf = async (slug: string, o: { status?: string; name?: string; aliases?: string[] } = {}) => {
    await pool.query('insert into atlas.shelves (slug, name, type, aliases, status) values ($1, $2, $3, $4, $5)', [
      slug, o.name ?? slug, 'organization', o.aliases ?? [], o.status ?? 'active',
    ]);
  };
  /** One signal with its atlas.decisions row, optionally an item on a shelf. */
  const seedSignal = async (signalId: string, o: { onShelf?: string; withDecision?: boolean } = {}) => {
    const text = `Kalshi raised $1B at a $40B valuation (${signalId}).`;
    await pool.query(
      `insert into atlas.signals (signal_id, schema_version, source, source_id, type, text, link, occurred_at)
       values ($1, 1, 'tokens_xyz', $2, 'news', $3, null, now() - interval '2 hours')`,
      [signalId, `src-em-${signalId}`, text],
    );
    if (o.onShelf) {
      await pool.query(
        `insert into atlas.items (item_key, title, main_shelf_id, signal_id, angle, note)
         select $1, $2, s.id, $3, 'new_story', $4 from atlas.shelves s where s.slug = $5`,
        [`${signalId}:${o.onShelf}`, `On ${o.onShelf}: ${text}`, signalId, `note for ${signalId}`, o.onShelf],
      );
    }
    if (o.withDecision !== false) {
      await pool.query(
        `insert into atlas.decisions (schema_version, signal_id, analyst_version, decision_type, summary, decision, reason, targets, decided_by)
         values (1, $1, 'analyst-504-v1', 'file', 'summary', 'keep', 'kept', '[]'::jsonb, 'jev')`,
        [signalId],
      );
    }
  };
  const seedProposed = async (slug: string, o: { signals?: string[] } = {}) => {
    await seedShelf(slug, { status: 'proposed' });
    for (const signalId of o.signals ?? [`${slug}-s1`]) await seedSignal(signalId, { onShelf: slug });
  };
  const shelfStatus = async (slug: string): Promise<string> =>
    (await pool.query<{ status: string }>('select status from atlas.shelves where slug = $1', [slug])).rows[0]!.status;
  const reviewCount = async (): Promise<number> =>
    (await pool.query<{ n: number }>('select count(*)::int n from atlas.entity_reviews')).rows[0]!.n;
  const itemHomes = async (signalIds: string[]) =>
    (await pool.query<{ signal_id: string; slug: string }>(
      'select signal_id, (select slug from atlas.shelves where id = main_shelf_id) slug from atlas.items where signal_id = any($1) order by signal_id, slug',
      [signalIds],
    )).rows;

  beforeAll(async () => {
    // Pinned to the schema before #537 (entity_reviews dropped): this code still writes
    // entity_reviews until Backend Dev's #539 moves it to atlas.decisions and removes the pin.
    db = await createThrowawayDatabase(ADMIN_URL, { before: '20261031090000' });
    pool = new Pool({ connectionString: db.url, max: 2 });
    svcPool = rolePoolFor(db.url, 'service_role');
    workerPool = rolePoolFor(db.url, 'analyst_worker');
  });
  afterAll(async () => {
    await workerPool?.end();
    await svcPool?.end();
    await pool?.end();
    await db?.drop();
  });
  beforeEach(async () => {
    await pool.query('truncate atlas.item_signals, atlas.items, atlas.decisions, atlas.signals cascade');
    await pool.query('delete from atlas.shelves');
    if ((await pool.query("select to_regclass('atlas.entity_reviews') is not null as ok")).rows[0]?.ok) {
      await pool.query('truncate atlas.entity_reviews cascade');
    }
    // The active target present in every test: slug 'kalshi' with alias 'Kalshi Inc', which the
    // shortlist terms (slug with '-' -> ' ') match, so the model can alias onto it.
    await seedShelf('kalshi', { name: 'Kalshi', aliases: ['Kalshi Inc'] });
  });

  it('alias: moves the non-duplicate items, appends the slug to X.aliases once, retires P, one applied row per signal', async () => {
    await seedProposed('kalshi-inc', { signals: ['s1', 's2'] });
    // The duplicate: X already holds an item for s1 (unique index (signal_id, main_shelf_id)).
    await pool.query(
      `insert into atlas.items (item_key, title, main_shelf_id, signal_id, angle, note)
       select 's1:kalshi', 'On kalshi: same signal', id, 's1', 'new_story', 'note for s1' from atlas.shelves where slug = 'kalshi'`,
    );
    const xId = (await pool.query<{ id: string }>("select id from atlas.shelves where slug = 'kalshi'")).rows[0]!.id;
    const llm = scriptedLlm(aliasReply('kalshi'));
    const { events, log } = logOf();

    const s = await review(llm, { log });

    expect(s).toEqual({ reviewed: 1, aliased: 1, rejected: 0, kept_new: 0, skipped: 0, failed: 0, llm_calls: 1, stop_reason: 'idle' });
    // The prompt carried the proposed shelf, its items and a shortlist that includes X.
    expect(llm.prompts[0]).toContain('kalshi-inc');
    expect(llm.prompts[0]).toContain('Kalshi raised $1B at a $40B valuation (s1).');
    expect(llm.prompts[0]).toContain('Kalshi Inc');
    // The s1 duplicate stays on P; s2's item moved to X.
    expect(await itemHomes(['s1', 's2'])).toEqual([
      { signal_id: 's1', slug: 'kalshi' },
      { signal_id: 's1', slug: 'kalshi-inc' },
      { signal_id: 's2', slug: 'kalshi' },
    ]);
    expect((await pool.query<{ aliases: string[] }>("select aliases from atlas.shelves where slug = 'kalshi'")).rows[0]!.aliases)
      .toEqual(['Kalshi Inc', 'kalshi-inc']);
    expect(await shelfStatus('kalshi-inc')).toBe('retired');
    const reviews = (await pool.query<{ signal_id: string; outcome: string; alias_target_id: string; applied: boolean;
      decided_by: string; model_name: string; reason: string; linked: boolean }>(
      `select r.signal_id, r.outcome, r.alias_target_id, r.applied, r.decided_by, r.model_name, r.reason,
              r.decision_id = (select id from atlas.decisions d where d.signal_id = r.signal_id) as linked
         from atlas.entity_reviews r
        where r.shelf_id = (select id from atlas.shelves where slug = 'kalshi-inc')
        order by r.signal_id`)).rows;
    expect(reviews).toHaveLength(2);
    for (const r of reviews) {
      expect(r).toMatchObject({ outcome: 'alias', alias_target_id: xId, applied: true, decided_by: 'entity-manager',
        model_name: 'glm-5.3-flash', reason: 'same entity', linked: true });
    }
    expect(events.filter((e) => e['event'] === 'entity_manager_run')).toHaveLength(1);
  });

  it('reject: retires P, leaves the items, applied rows per signal; a later kind-new filing for the slug is dropped', async () => {
    await seedProposed('kalshi-inc', { signals: ['s1', 's2'] });
    const llm = scriptedLlm(rejectReply());

    const s = await review(llm);

    expect(s).toEqual({ reviewed: 1, aliased: 0, rejected: 1, kept_new: 0, skipped: 0, failed: 0, llm_calls: 1, stop_reason: 'idle' });
    expect(await shelfStatus('kalshi-inc')).toBe('retired');
    expect(await itemHomes(['s1', 's2'])).toEqual([
      { signal_id: 's1', slug: 'kalshi-inc' },
      { signal_id: 's2', slug: 'kalshi-inc' },
    ]);
    const rows = (await pool.query<{ outcome: string; applied: boolean; alias_target_id: string | null }>(
      'select outcome, applied, alias_target_id from atlas.entity_reviews order by signal_id',
    )).rows;
    expect(rows).toEqual([
      { outcome: 'reject', applied: true, alias_target_id: null },
      { outcome: 'reject', applied: true, alias_target_id: null },
    ]);

    // Existing d36-worker behaviour is preserved: a later kind-new target for the now-retired
    // slug files no item and logs target_dropped (the live worker sink, as analyst_worker).
    await seedSignal('s3', { withDecision: false });
    const sinkLog: Record<string, unknown>[] = [];
    const sink = new PgDecisionSink(workerPool, (e) => sinkLog.push(e));
    await sink.save(parseAnalystOutput({
      schema_version: 1,
      analyst_version: 'analyst-504-v1',
      signal_id: 's3',
      summary: 'Kalshi in the news again.',
      decision: 'keep',
      reason: 'routed',
      targets: [{ entity: 'kalshi-inc', kind: 'new', type: 'organization', angle: 'new_story', note: 'the story' }],
    }));
    expect((await pool.query<{ n: number }>("select count(*)::int n from atlas.items where signal_id = 's3'")).rows[0]!.n).toBe(0);
    expect((await pool.query<{ n: number }>("select count(*)::int n from atlas.decisions where signal_id = 's3'")).rows[0]!.n).toBe(1);
    expect(sinkLog).toEqual([{
      event: 'target_dropped', signal_id: 's3', entity: 'kalshi-inc', reason: expect.stringContaining('retired'),
    }]);
    expect(await shelfStatus('kalshi-inc')).toBe('retired');
  });

  it('new: the shelf stays proposed with applied=false rows; reruns make no LLM call until a new item lands', async () => {
    await seedProposed('kalshi-inc', { signals: ['s1'] });

    const llm1 = scriptedLlm(newReply());
    const run1 = await review(llm1);
    expect(run1).toEqual({ reviewed: 1, aliased: 0, rejected: 0, kept_new: 1, skipped: 0, failed: 0, llm_calls: 1, stop_reason: 'idle' });
    expect(await shelfStatus('kalshi-inc')).toBe('proposed');
    expect(await itemHomes(['s1'])).toEqual([{ signal_id: 's1', slug: 'kalshi-inc' }]);
    expect((await pool.query<{ outcome: string; applied: boolean }>('select outcome, applied from atlas.entity_reviews')).rows)
      .toEqual([{ outcome: 'new', applied: false }]);

    // Second run: the latest review row is outcome 'new' and nothing newer landed -> no LLM call.
    const llm2 = scriptedLlm(newReply());
    const run2 = await review(llm2);
    expect(run2).toEqual({ reviewed: 0, aliased: 0, rejected: 0, kept_new: 0, skipped: 1, failed: 0, llm_calls: 0, stop_reason: 'idle' });
    expect(llm2.calls).toBe(0);
    expect(await reviewCount()).toBe(1); // no new rows from the skipped run

    // A new item lands on the shelf: the next run reviews it again.
    await seedSignal('s2', { onShelf: 'kalshi-inc' });
    const llm3 = scriptedLlm(newReply());
    const run3 = await review(llm3);
    expect(run3).toEqual({ reviewed: 1, aliased: 0, rejected: 0, kept_new: 1, skipped: 0, failed: 0, llm_calls: 1, stop_reason: 'idle' });
    expect(llm3.calls).toBe(1);
    expect(await reviewCount()).toBe(3); // run 1 wrote one row per signal (s1); run 3 wrote s1 + s2
    expect((await pool.query<{ n: number }>("select count(*)::int n from atlas.entity_reviews where signal_id = 's2'")).rows[0]!.n).toBe(1);
  });

  it('invalid JSON: nothing changes, the failure is logged and the run continues', async () => {
    await seedProposed('kalshi-inc', { signals: ['s1'] });
    const llm = scriptedLlm('oops, not json');
    const { events, log } = logOf();

    const s = await review(llm, { log });

    expect(s).toEqual({ reviewed: 1, aliased: 0, rejected: 0, kept_new: 0, skipped: 0, failed: 1, llm_calls: 1, stop_reason: 'idle' });
    expect(await shelfStatus('kalshi-inc')).toBe('proposed');
    expect(await itemHomes(['s1'])).toEqual([{ signal_id: 's1', slug: 'kalshi-inc' }]);
    expect(await reviewCount()).toBe(0);
    expect(events).toContainEqual(expect.objectContaining({ event: 'entity_review_failed', shelf: 'kalshi-inc' }));
    expect(events.filter((e) => e['event'] === 'entity_manager_run')).toHaveLength(1);
  });

  for (const [label, targetSlug] of [
    ['an unknown slug', 'no-such-shelf'],
    ['a non-active (retired) slug', 'kalshi-old'],
  ] as const) {
    it(`alias_of pointing at ${label} fails without writing`, async () => {
      if (targetSlug === 'kalshi-old') await seedShelf('kalshi-old', { status: 'retired' });
      await seedProposed('kalshi-inc', { signals: ['s1'] });
      const llm = scriptedLlm(aliasReply(targetSlug, 'close enough'));

      const s = await review(llm);

      expect(s).toEqual({ reviewed: 1, aliased: 0, rejected: 0, kept_new: 0, skipped: 0, failed: 1, llm_calls: 1, stop_reason: 'idle' });
      expect(await shelfStatus('kalshi-inc')).toBe('proposed');
      expect(await itemHomes(['s1'])).toEqual([{ signal_id: 's1', slug: 'kalshi-inc' }]);
      expect(await reviewCount()).toBe(0);
    });
  }

  it('an LLM that throws fails the shelf without writing and the run continues', async () => {
    await seedProposed('kalshi-inc', { signals: ['s1'] });
    await seedProposed('kalshi-alt', { signals: ['s4'] }); // alphabetical first; keeps the "continues" part real
    const llm = scriptedLlm((prompt: string) => (prompt.includes('kalshi-alt') ? new Error('llm 503') : rejectReply()));
    const { events, log } = logOf();

    const s = await review(llm, { log });

    expect(s).toEqual({ reviewed: 2, aliased: 0, rejected: 1, kept_new: 0, skipped: 0, failed: 1, llm_calls: 2, stop_reason: 'idle' });
    expect(await shelfStatus('kalshi-alt')).toBe('proposed'); // the throwing shelf wrote nothing
    expect(await itemHomes(['s4'])).toEqual([{ signal_id: 's4', slug: 'kalshi-alt' }]);
    expect(await shelfStatus('kalshi-inc')).toBe('retired'); // the run continued to the next shelf
    expect(events).toContainEqual(expect.objectContaining({ event: 'entity_review_failed', shelf: 'kalshi-alt' }));
  });

  it('a slow LLM reply past timeoutMs is a failure: nothing written, counted as failed', async () => {
    await seedProposed('kalshi-inc', { signals: ['s1'] });
    const llm = scriptedLlm(aliasReply('kalshi'), { slowMs: 200 });
    const { events, log } = logOf();

    const s = await review(llm, { log, timeoutMs: 30 });

    expect(s).toEqual({ reviewed: 1, aliased: 0, rejected: 0, kept_new: 0, skipped: 0, failed: 1, llm_calls: 1, stop_reason: 'idle' });
    expect(await shelfStatus('kalshi-inc')).toBe('proposed');
    expect(await itemHomes(['s1'])).toEqual([{ signal_id: 's1', slug: 'kalshi-inc' }]);
    expect(await reviewCount()).toBe(0);
    expect(events).toContainEqual(expect.objectContaining({ event: 'entity_review_failed', shelf: 'kalshi-inc' }));
  });

  it('a quota guard that says stop: no LLM call, stop_reason quota, nothing touched', async () => {
    await seedProposed('kalshi-inc', { signals: ['s1'] });
    const llm = scriptedLlm(aliasReply('kalshi'));
    const { events, log } = logOf();
    const guard = createQuotaGuard({ read: async () => ({ source: 'weekly', remainingPercent: 5 }) });

    const s = await review(llm, { quota: guard, log });

    expect(s).toEqual({ reviewed: 0, aliased: 0, rejected: 0, kept_new: 0, skipped: 0, failed: 0, llm_calls: 0, stop_reason: 'quota' });
    expect(llm.calls).toBe(0);
    expect(await shelfStatus('kalshi-inc')).toBe('proposed');
    expect(await itemHomes(['s1'])).toEqual([{ signal_id: 's1', slug: 'kalshi-inc' }]);
    expect(await reviewCount()).toBe(0);
    expect(events).toContainEqual(expect.objectContaining({ event: 'entity_manager_run', stop_reason: 'quota' }));
  });

  it('maxShelves caps the run: the first slug is reviewed, later shelves stay pending, stop_reason max', async () => {
    await seedProposed('kalshi-a', { signals: ['s-a'] });
    await seedProposed('kalshi-b', { signals: ['s-b'] });
    const llm = scriptedLlm(rejectReply()); // whatever it is asked, it rejects; the cap decides scope
    const { events, log } = logOf();

    const s = await review(llm, { maxShelves: 1, log });

    // Slug order: kalshi-a first. kalshi-b must not even reach the LLM.
    expect(llm.prompts.some((p) => p.includes('kalshi-a'))).toBe(true);
    expect(llm.prompts.some((p) => p.includes('kalshi-b'))).toBe(false);
    expect(s).toEqual({ reviewed: 1, aliased: 0, rejected: 1, kept_new: 0, skipped: 0, failed: 0, llm_calls: 1, stop_reason: 'max' });
    expect(await shelfStatus('kalshi-a')).toBe('retired');
    expect(await shelfStatus('kalshi-b')).toBe('proposed');
    expect(await itemHomes(['s-a', 's-b'])).toEqual([
      { signal_id: 's-a', slug: 'kalshi-a' },
      { signal_id: 's-b', slug: 'kalshi-b' },
    ]);
    expect(await reviewCount()).toBe(1);
    expect(events).toContainEqual(expect.objectContaining({ event: 'entity_manager_run', stop_reason: 'max' }));
  });

  it('a shelf that is no longer proposed at apply time (race) is skipped without any writes', async () => {
    await seedProposed('kalshi-inc', { signals: ['s1'] });
    const xAliasesBefore = ['Kalshi Inc'];
    // The scripted LLM retires the shelf while its (delayed) reply is in flight — i.e. between
    // the review decision and the apply-time re-check under the advisory locks.
    const llm = scriptedLlm(aliasReply('kalshi'), {
      slowMs: 20,
      onCall: async () => {
        await pool.query("update atlas.shelves set status = 'retired' where slug = 'kalshi-inc'");
      },
    });
    const { events, log } = logOf();

    const s = await review(llm, { log });

    expect(s).toEqual({ reviewed: 0, aliased: 0, rejected: 0, kept_new: 0, skipped: 1, failed: 0, llm_calls: 1, stop_reason: 'idle' });
    expect(await shelfStatus('kalshi-inc')).toBe('retired'); // the test's own update, not a job write
    expect(await itemHomes(['s1'])).toEqual([{ signal_id: 's1', slug: 'kalshi-inc' }]);
    expect(await reviewCount()).toBe(0);
    expect((await pool.query<{ aliases: string[] }>("select aliases from atlas.shelves where slug = 'kalshi'")).rows[0]!.aliases)
      .toEqual(xAliasesBefore);
    expect(events).not.toContainEqual(expect.objectContaining({ event: 'entity_review_failed' }));
  });
});