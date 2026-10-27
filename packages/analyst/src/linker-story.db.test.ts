/**
 * Issue #479 acceptance scenarios: one analyst job (Linker + Story) on the #478
 * claim, decider slot and decision provenance. Throwaway LOCAL Postgres; shelves are
 * the entities and items their raw items; Jev/Clef are scripted and answer from the
 * case they are shown. Assertions read DB state.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { newsSampleSignals } from '@myboon/contracts/test-fixtures';
import { createThrowawayDatabase, type ThrowawayDatabase } from '@myboon/atlas-schema';
import {
  DeciderError,
  linkerStory,
  processNext,
  ADDS_NOTHING,
  type Decider,
  type DecisionCase,
  type ProcessOptions,
  type RoutingRule,
  type StoryState,
} from './index.js';

const ADMIN_URL = process.env.ANALYST_TEST_ADMIN_URL?.trim() ?? '';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const DAY = 86_400_000;

type Answerer = (c: DecisionCase) => Record<string, number>;

/** A decider that answers from the case: pick() gives probabilities over c.choices; the top one is the choice. */
function story(name: 'jev' | 'clef', pick: Answerer | 'error', delayMs = 0): Decider & { calls: number; seen: DecisionCase[] } {
  const d = {
    name, modelName: name, modelVersion: `${name}-test`, calls: 0, seen: [] as DecisionCase[],
    async decide(c: DecisionCase) {
      d.calls += 1; d.seen.push(c);
      if (delayMs) await sleep(delayMs);
      if (pick === 'error') throw new DeciderError('error', `${name} 503`);
      const probabilities = pick(c);
      for (const k of Object.keys(probabilities)) expect(c.choices).toContain(k);
      const choice = Object.entries(probabilities).sort((a, b) => b[1] - a[1])[0][0];
      return { choice, probabilities };
    },
  };
  return d;
}

const items = (c: DecisionCase) => (c.state as StoryState).candidates.flatMap((e) => e.items.map((i) => ({ ...i, slug: e.slug })));
/** Link to the shown item whose title matches, else that entity's new story. */
const linkTo = (slug: string, title: RegExp, p = 0.95): Answerer => (c) => {
  const hit = items(c).find((i) => i.slug === slug && title.test(i.title));
  const choice = hit ? `${slug}/${hit.id}` : `${slug}/new_story`;
  return { [choice]: p, [ADDS_NOTHING]: Math.round((1 - p) * 100) / 100 };
};

describe.skipIf(ADMIN_URL === '')('#479 Linker + Story (local Postgres)', () => {
  let db: ThrowawayDatabase;
  let pool: Pool;
  const shelf: Record<string, string> = {};
  const item: Record<string, string> = {};
  const target = newsSampleSignals[0].signal_id;
  const rules: RoutingRule[] = [{ tokenSlug: 'uni-token', projectSlug: 'uniswap', routeTo: 'uniswap' }];
  const ls = () => linkerStory({ routingRules: rules });
  const opts = (o: Partial<ProcessOptions> & Deciders): ProcessOptions => {
    const j = ls();
    return {
      buildCase: j.buildCase, interpret: j.interpret, promptVersion: 'story-479-v1',
      leaseMs: 60_000, timeoutMs: 300, backoffMs: 60_000, maxAttempts: 3, worker: 'w1', ...o,
    };
  };
  const sig = async () => (await pool.query(
    `select status, parked_reason, attempts::int attempts, last_error, claim_token, next_attempt_at > now() backing_off
       from atlas.signals where signal_id = $1`, [target])).rows[0];
  const decisions = async () => (await pool.query('select * from atlas.decisions where signal_id = $1', [target])).rows;
  const setText = (text: string) => pool.query('update atlas.signals set text = $2, excerpt = null where signal_id = $1', [target, text]);

  async function addShelf(slug: string, aliases: string[], type = 'asset') {
    const r = await pool.query(`insert into atlas.shelves (slug, name, type, aliases) values ($1,$1,$2,$3) returning id`, [slug, type, aliases]);
    shelf[slug] = r.rows[0].id;
  }
  async function addItem(key: string, slug: string, title: string, daysAgo: number) {
    const r = await pool.query(
      `insert into atlas.items (item_key, title, main_shelf_id, occurred_at) values ($1,$2,$3, now() - make_interval(secs => $4)) returning id`,
      [key, title, shelf[slug], daysAgo * DAY / 1000]);
    item[key] = r.rows[0].id;
  }

  beforeAll(async () => {
    db = await createThrowawayDatabase(ADMIN_URL);
    pool = new Pool({ connectionString: db.url, max: 8 });
  });
  afterAll(async () => { await pool?.end(); await db?.drop(); });
  beforeEach(async () => {
    await pool.query('truncate atlas.item_signals, atlas.decisions, atlas.signals, atlas.items, atlas.shelves cascade');
    for (const s of newsSampleSignals) {
      await pool.query(
        `insert into atlas.signals (signal_id, schema_version, source, source_id, type, text, link, occurred_at, next_attempt_at)
         values ($1,$2,$3,$4,$5,$6,$7,$8, case when $1 = $9 then now() else now() + interval '1 hour' end)`,
        [s.signal_id, s.schema_version, s.source, s.source_id, s.type, s.text, s.link, s.occurred_at, target]);
    }
    await addShelf('xrp', ['XRP', 'Ripple']);
    await addItem('xrp-sec', 'xrp', 'SEC v Ripple: court schedule', 22);
    for (let i = 0; i < 5; i++) await addItem(`xrp-price-${i}`, 'xrp', `XRP price move ${i}`, i + 0.5);
  });

  it('XRP: a 3-week-quiet SEC story is among the items shown and the SEC update links to it, not new story', async () => {
    await setText('SEC files new response in the Ripple XRP case');
    const jev = story('jev', linkTo('xrp', /SEC/));
    await processNext(pool, opts({ primary: jev, fallback: story('clef', 'error'), shadow: story('clef', linkTo('xrp', /SEC/)) }));
    expect(jev.seen[0].itemIds).toContain(item['xrp-sec']);
    expect(jev.seen[0].itemIds.length).toBeLessThanOrEqual(5);
    const [d] = await decisions();
    expect(d).toMatchObject({ reason: 'linked', target_item_id: item['xrp-sec'], decided_by: 'jev' });
    expect(await sig()).toMatchObject({ status: 'analysed' });
  });

  it('$UNI/Uniswap routing rule is applied before the cap of 5 and the shortlist follows it', async () => {
    await addShelf('uni-token', ['$UNI', 'UNI token']);
    await addShelf('uniswap', ['Uniswap', '$UNI'], 'protocol');
    for (const s of ['aave', 'curve', 'lido', 'maker', 'compound']) await addShelf(s, [s]);
    await setText('$UNI and UNI token rally as Uniswap fee switch passes; aave, curve, lido, maker and compound follow');
    const jev = story('jev', linkTo('uniswap', /never/));
    await processNext(pool, opts({ primary: jev, fallback: story('clef', 'error'), shadow: story('clef', 'error') }));
    const slugs = (jev.seen[0].shortlist as Array<{ slug: string }>).map((s) => s.slug);
    expect(slugs).toHaveLength(5);
    expect(slugs).toContain('uniswap');
    expect(slugs).not.toContain('uni-token');
    const [d] = await decisions();
    expect((d.shortlist as Array<{ slug: string }>).map((s) => s.slug)).toEqual(slugs);
    expect(d).toMatchObject({ reason: 'new_story', target_item_id: null });
  });

  it('a pick below the cutoff parks with a reason, the decision is saved, and nothing moves on', async () => {
    await setText('Ripple XRP SEC news');
    const jev = story('jev', linkTo('xrp', /SEC/, 0.6));
    await processNext(pool, opts({ primary: jev, fallback: story('clef', 'error'), shadow: story('clef', 'error') }));
    const s = await sig();
    expect(s.status).toBe('parked');
    expect(s.parked_reason).toMatch(/^below_cutoff: entity p=0\.60/);
    expect(await decisions()).toHaveLength(1);
    expect(Number((await pool.query('select count(*) n from atlas.item_signals')).rows[0].n)).toBe(0);
    expect(await processNext(pool, opts({ primary: jev, fallback: jev, shadow: jev }))).toBeNull();
  });

  it('entity and item picks that disagree park the signal (top choice is off the most likely entity)', async () => {
    await addShelf('ripple-labs', ['Ripple'], 'organization');
    await addItem('rl-cfo', 'ripple-labs', 'Ripple Labs hires a CFO', 2);
    await setText('Ripple XRP SEC news');
    // Top single choice is the xrp SEC item (0.4), but ripple-labs holds 0.6 in total.
    const jev = story('jev', () => ({ [`xrp/${item['xrp-sec']}`]: 0.4, [`ripple-labs/${item['rl-cfo']}`]: 0.3, 'ripple-labs/new_story': 0.3 }));
    await processNext(pool, opts({ primary: jev, fallback: story('clef', 'error'), shadow: story('clef', 'error') }));
    const s = await sig();
    expect(s.status).toBe('parked');
    expect(s.parked_reason).toMatch(/^disagree: item xrp, entity ripple-labs/);
    expect(await decisions()).toHaveLength(1);
  });

  it('Story step fails after the Linker: not analysed, no decision, retried after backoff', async () => {
    await setText('Ripple XRP SEC news');
    const res = await processNext(pool, opts({ primary: story('jev', 'error'), fallback: story('clef', 'error'), shadow: story('clef', 'error') }));
    expect(res).toMatchObject({ result: 'failed' });
    expect(await sig()).toMatchObject({ status: 'received', attempts: 1, backing_off: true, claim_token: null });
    expect((await sig()).last_error).toMatch(/jev.*clef/);
    expect(await decisions()).toHaveLength(0);
  });

  it('worker crashes after the Jev call but before the write: the claim expires, it is redone, one decision', async () => {
    await setText('Ripple XRP SEC news');
    const slow = story('jev', linkTo('xrp', /SEC/), 120);
    // Lease 40 ms < the 120 ms Jev call: the write finds the claim gone (the "crash"), so nothing is written.
    await processNext(pool, opts({ primary: slow, fallback: story('clef', 'error'), shadow: story('clef', 'error'), leaseMs: 40 }));
    expect(await decisions()).toHaveLength(0);
    const jev = story('jev', linkTo('xrp', /SEC/));
    await processNext(pool, opts({ primary: jev, fallback: story('clef', 'error'), shadow: story('clef', 'error') }));
    expect(await decisions()).toHaveLength(1);
    expect(await sig()).toMatchObject({ status: 'analysed', attempts: 2 });
  });

  it('Jev is down: Clef decides and the decision shows decided_by = clef', async () => {
    await setText('Ripple XRP SEC news');
    await processNext(pool, opts({ primary: story('jev', 'error'), fallback: story('clef', linkTo('xrp', /SEC/)), shadow: story('clef', linkTo('xrp', /SEC/)) }));
    const [d] = await decisions();
    expect(d).toMatchObject({ decided_by: 'clef', reason: 'linked', target_item_id: item['xrp-sec'] });
    expect(d.primary_error).toMatch(/^error: jev/);
  });

  it('successful pick: the decision stores shortlist, item ids, probabilities and runner-up margin; status analysed', async () => {
    await setText('Ripple XRP SEC news');
    const jev = story('jev', linkTo('xrp', /SEC/, 0.9));
    await processNext(pool, opts({ primary: jev, fallback: story('clef', 'error'), shadow: story('clef', linkTo("xrp", /move 0$/)) }));
    const [d] = await decisions();
    const c = jev.seen[0];
    expect(d.shortlist).toEqual(c.shortlist);
    expect(d.item_ids).toEqual(c.itemIds);
    expect(d.probabilities).toEqual({ [`xrp/${item['xrp-sec']}`]: 0.9, [ADDS_NOTHING]: 0.1 });
    expect(Number(d.runner_up_margin)).toBeCloseTo(0.8);
    expect(Number(d.confidence)).toBeCloseTo(0.9);
    expect(d).toMatchObject({ outcome: 'decided', decided_by: 'jev', shadow_outcome: 'decided', prompt_version: 'story-479-v1' });
    expect(d.shadow_answer).toEqual({ choice: `xrp/${item['xrp-price-0']}` });
    expect(await sig()).toMatchObject({ status: 'analysed' });
  });

  it('no alias match: parked no_match without a decider call (the no-match path is the next issue)', async () => {
    await setText('Completely unrelated weather report');
    const jev = story('jev', linkTo('xrp', /SEC/));
    await processNext(pool, opts({ primary: jev, fallback: jev, shadow: jev }));
    expect(jev.calls).toBe(0);
    expect(await sig()).toMatchObject({ status: 'parked', parked_reason: 'no_match' });
    expect(await decisions()).toHaveLength(0);
  });

  it('service_role runs the whole Linker + Story job through its grants', async () => {
    await setText('Ripple XRP SEC news');
    const svc = new Pool({ connectionString: db.url, max: 2, options: '-c role=service_role' });
    try {
      await processNext(svc, opts({ primary: story('jev', linkTo('xrp', /SEC/)), fallback: story('clef', 'error'), shadow: story('clef', 'error') }));
    } finally { await svc.end(); }
    expect(await decisions()).toHaveLength(1);
    expect(await sig()).toMatchObject({ status: 'analysed' });
  });
});

type Deciders = Pick<ProcessOptions, 'primary' | 'fallback' | 'shadow'>;
