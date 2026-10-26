/**
 * Issue #479 acceptance scenarios: Linker (code shortlist) + Story (one Jev call).
 * Throwaway LOCAL Postgres, scripted Jev that reads exactly what the analyst sent.
 * Assertions read DB state: signal_states, jev_decisions.input_case, atlas.decisions.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { createThrowawayDatabase, type ThrowawayDatabase } from '@myboon/atlas-schema';

import { admitSignals, runAnalystOnce, sweepExpiredClaims, type JevAnswer, type JevPort } from './index.js';

const ADMIN_URL = process.env.ANALYST_TEST_ADMIN_URL?.trim() ?? '';
const DAY = 86_400_000;

type Candidate = { slug: string; items: Array<{ id: string; title: string }> };
type StoryState = { signal: { text: string }; candidates: Candidate[] };
type Pick = { entity: [string, number, number]; item: [string, number, number] };

/** Scripted Jev: `pick` sees the state the analyst built and returns choice, probability, runner-up probability per question. */
function scriptedJev(pick: (s: StoryState) => Pick | Error): JevPort & { calls: number } {
  const port = {
    calls: 0,
    modelVersion: 'scripted-jev',
    async decide(input: unknown): Promise<JevAnswer> {
      port.calls += 1;
      const state = (input as { state: StoryState }).state;
      const p = pick(state);
      if (p instanceof Error) throw p;
      const q = (v: [string, number, number]) => ({ choice: v[0], probability: v[1], runnerUpProbability: v[2] });
      return {
        answer: { entity: p.entity[0], item: p.item[0] },
        probability: p.entity[1],
        runnerUp: null,
        modelVersion: 'scripted-jev',
        questions: { entity: q(p.entity), item: q(p.item) },
      };
    },
  };
  return port;
}

describe.skipIf(ADMIN_URL === '')('#479 Linker + Story (local Postgres)', () => {
  let db: ThrowawayDatabase;
  let pool: Pool;
  const shelf: Record<string, string> = {};
  const item: Record<string, string> = {};
  const opts = { limit: 10, leaseMs: 60_000, backoffMs: 60_000, timeoutMs: 500 };

  const state = async (id: string) => (await pool.query(
    'select state, park_reason, attempts::int as attempts from atlas.signal_states where signal_id = $1', [id])).rows[0];
  const decisions = async (id: string) => (await pool.query(
    `select d.action, d.shelves, d.target_item_id, d.confidence from atlas.decisions d where d.signal_id = $1`, [id])).rows;
  const sentState = async (id: string): Promise<StoryState> => (await pool.query(
    'select input_case from atlas.jev_decisions where signal_id = $1 order by created_at desc limit 1', [id])).rows[0]?.input_case?.state;

  async function addSignal(id: string, text: string) {
    await pool.query(`insert into atlas.signals (signal_id, schema_version, source, source_id, type, text, occurred_at) values ($1,1,'news',$1,'news',$2, now())`, [id, text]);
    await admitSignals(pool);
  }
  async function addItem(key: string, slug: string, title: string, ageDays: number) {
    const { rows } = await pool.query(
      `insert into atlas.items (item_key, title, main_shelf_id, occurred_at) values ($1,$2,$3, now() - make_interval(secs => $4)) returning id`,
      [key, title, shelf[slug], ageDays * DAY / 1000]);
    item[key] = rows[0].id;
  }

  beforeAll(async () => {
    db = await createThrowawayDatabase(ADMIN_URL);
    pool = new Pool({ connectionString: db.url, max: 4 });
  });
  afterAll(async () => { await pool?.end(); await db?.drop(); });
  beforeEach(async () => {
    await pool.query('truncate atlas.decisions, atlas.jev_decisions, atlas.signal_states, atlas.item_signals, atlas.items, atlas.routing_rules, atlas.shelves, atlas.signals cascade');
    for (const [slug, type, aliases] of [
      ['xrp', 'asset', ['XRP', 'Ripple']],
      ['uni', 'asset', ['$UNI', 'UNI token']],
      ['uniswap', 'protocol', ['Uniswap']],
      ['bitcoin', 'asset', ['Bitcoin', 'BTC']],
      ['sec', 'organization', ['SEC']],
    ] as const) {
      const { rows } = await pool.query(`insert into atlas.shelves (slug, name, type, aliases) values ($1,$1,$2,$3) returning id`, [slug, type, aliases]);
      shelf[slug] = rows[0].id;
    }
  });

  it('XRP: a 3-week-quiet SEC item is in what Jev sees and the signal links to it, not "new story"', async () => {
    await addItem('xrp-sec', 'xrp', 'SEC appeal in Ripple case', 21);
    for (let i = 0; i < 5; i++) await addItem(`xrp-price-${i}`, 'xrp', `XRP price move ${i}`, i * 0.5 + 0.1);
    await addSignal('s-xrp', 'SEC files new brief in Ripple XRP appeal');
    const jev = scriptedJev((s) => {
      const xrp = s.candidates.find((c) => c.slug === 'xrp');
      const sec = xrp?.items.find((i) => /SEC/.test(i.title));
      return { entity: ['xrp', 0.95, 0.03], item: sec ? [sec.id, 0.88, 0.05] : ['new_story', 0.8, 0.1] };
    });
    await runAnalystOnce(pool, { jev, ...opts });

    const sent = await sentState('s-xrp');
    const xrp = sent.candidates.find((c) => c.slug === 'xrp')!;
    expect(xrp.items).toHaveLength(5);
    expect(xrp.items.map((i) => i.id)).toContain(item['xrp-sec']);
    expect(sent.candidates.length).toBeLessThanOrEqual(5);
    expect(await state('s-xrp')).toMatchObject({ state: 'analysed' });
    const d = await decisions('s-xrp');
    expect(d).toHaveLength(1);
    expect(d[0]).toMatchObject({ action: 'keep', target_item_id: item['xrp-sec'], shelves: ['xrp'] });
  });

  it('$UNI/Uniswap pair rule: the shortlist follows the rule before Jev runs', async () => {
    await pool.query('insert into atlas.routing_rules (token_shelf_id, project_shelf_id, route_to_shelf_id) values ($1,$2,$2)', [shelf.uni, shelf.uniswap]);
    await addItem('uniswap-fee', 'uniswap', 'Uniswap fee switch debate', 3);
    await addSignal('s-uni', 'Uniswap governance passes fee switch; $UNI jumps 12%');
    const jev = scriptedJev((s) => ({ entity: [s.candidates[0].slug, 0.93, 0.02], item: ['new_story', 0.85, 0.1] }));
    await runAnalystOnce(pool, { jev, ...opts });

    const slugs = (await sentState('s-uni')).candidates.map((c) => c.slug);
    expect(slugs).toContain('uniswap');
    expect(slugs).not.toContain('uni');
    expect(await state('s-uni')).toMatchObject({ state: 'analysed' });
    expect(await decisions('s-uni')).toEqual([expect.objectContaining({ action: 'keep', shelves: ['uniswap'], target_item_id: null })]);
  });

  it('without a rule, both token and project stay on the shortlist', async () => {
    await addSignal('s-uni2', 'Uniswap governance passes fee switch; $UNI jumps 12%');
    const jev = scriptedJev(() => ({ entity: ['uniswap', 0.93, 0.02], item: ['new_story', 0.85, 0.1] }));
    await runAnalystOnce(pool, { jev, ...opts });
    const slugs = (await sentState('s-uni2')).candidates.map((c) => c.slug).sort();
    expect(slugs).toEqual(['uni', 'uniswap']);
  });

  it.each([
    ['entity below 0.85', { entity: ['bitcoin', 0.80, 0.05], item: ['new_story', 0.9, 0.05] }, /entity/],
    ['entity margin below 0.30', { entity: ['bitcoin', 0.90, 0.65], item: ['new_story', 0.9, 0.05] }, /entity/],
    ['item below 0.70', { entity: ['bitcoin', 0.95, 0.02], item: ['new_story', 0.65, 0.1] }, /item/],
    ['item margin below 0.20', { entity: ['bitcoin', 0.95, 0.02], item: ['new_story', 0.75, 0.6] }, /item/],
  ] as const)('below cutoff (%s): parked with reason and nothing moves on', async (_n, pick, reason) => {
    await addSignal('s-btc', 'Bitcoin ETF flows turn positive');
    await runAnalystOnce(pool, { jev: scriptedJev(() => pick as unknown as Pick), ...opts });
    const s = await state('s-btc');
    expect(s.state).toBe('parked');
    expect(s.park_reason).toMatch(/below_cutoff/);
    expect(s.park_reason).toMatch(reason);
    expect(await decisions('s-btc')).toHaveLength(0);
  });

  it('disagreeing picks (item not on the picked entity) are parked', async () => {
    await addItem('xrp-sec', 'xrp', 'SEC appeal in Ripple case', 21);
    await addSignal('s-mix', 'Bitcoin and XRP both rally');
    await runAnalystOnce(pool, { jev: scriptedJev(() => ({ entity: ['bitcoin', 0.95, 0.02], item: [item['xrp-sec'], 0.9, 0.05] })), ...opts });
    expect(await state('s-mix')).toMatchObject({ state: 'parked', park_reason: expect.stringMatching(/disagree/) });
    expect(await decisions('s-mix')).toHaveLength(0);
  });

  it('"adds nothing" is parked as adds_nothing', async () => {
    await addSignal('s-dup', 'Bitcoin hovers near the same level');
    await runAnalystOnce(pool, { jev: scriptedJev(() => ({ entity: ['bitcoin', 0.95, 0.02], item: ['adds_nothing', 0.9, 0.05] })), ...opts });
    expect(await state('s-dup')).toMatchObject({ state: 'parked', park_reason: expect.stringMatching(/adds_nothing/) });
    expect(await decisions('s-dup')).toHaveLength(0);
  });

  it('Story fails after the Linker: the signal is not analysed and is retried, then analysed once', async () => {
    await addSignal('s-retry', 'Bitcoin miners sell reserves');
    let fail = true;
    const jev = scriptedJev(() => (fail ? new Error('jev 503') : { entity: ['bitcoin', 0.95, 0.02], item: ['new_story', 0.9, 0.05] }));
    await runAnalystOnce(pool, { jev, ...opts });
    expect(await state('s-retry')).toMatchObject({ state: 'received', attempts: 1 });
    expect(await decisions('s-retry')).toHaveLength(0);

    fail = false;
    await pool.query('update atlas.signal_states set available_at = now()');
    await runAnalystOnce(pool, { jev, ...opts });
    await runAnalystOnce(pool, { jev, ...opts });
    expect(await state('s-retry')).toMatchObject({ state: 'analysed' });
    expect(await decisions('s-retry')).toHaveLength(1);
    expect(jev.calls).toBe(2);
  });

  it('no alias match: parked as no_match without a Jev call (no-match path is the next issue)', async () => {
    await addSignal('s-none', 'Local bakery wins award');
    const jev = scriptedJev(() => new Error('should not be called'));
    await runAnalystOnce(pool, { jev, ...opts });
    expect(await state('s-none')).toMatchObject({ state: 'parked', park_reason: expect.stringMatching(/no_match/) });
    expect(jev.calls).toBe(0);
  });

  it('runs as service_role (DB Guy #486): signal read, linker, items, decision insert and advance', async () => {
    await addItem('btc-etf', 'bitcoin', 'Bitcoin ETF approvals', 2);
    await addSignal('s-svc', 'Bitcoin ETF inflows hit a record');
    const svc = new Pool({ connectionString: db.url, max: 2, options: '-c role=service_role' });
    try {
      expect((await svc.query('select current_user u')).rows[0].u).toBe('service_role');
      const jev = scriptedJev((s) => ({ entity: ['bitcoin', 0.95, 0.02], item: [s.candidates[0].items[0].id, 0.9, 0.05] }));
      await runAnalystOnce(svc, { jev, ...opts });
    } finally {
      await svc.end();
    }
    expect(await state('s-svc')).toMatchObject({ state: 'analysed' });
    expect(await decisions('s-svc')).toEqual([expect.objectContaining({ action: 'keep', shelves: ['bitcoin'], target_item_id: item['btc-etf'] })]);
  });

  it('CTO must-fix 2: Jev slower than the lease, two runners: one Jev call and one decision per signal', async () => {
    for (const id of ['s-l1', 's-l2', 's-l3']) await addSignal(id, `Bitcoin update ${id}`);
    const slow: JevPort = {
      modelVersion: 'scripted-jev',
      async decide(input: unknown) {
        await new Promise((r) => setTimeout(r, 100));
        const st = (input as { state: StoryState }).state;
        void st;
        const q = (c: string, p: number, r: number) => ({ choice: c, probability: p, runnerUpProbability: r });
        return { answer: {}, probability: 0.95, runnerUp: null, modelVersion: 'scripted-jev', questions: { entity: q('bitcoin', 0.95, 0.02), item: q('new_story', 0.9, 0.05) } };
      },
    };
    const short = { limit: 3, leaseMs: 150, backoffMs: 60_000, timeoutMs: 1000 };
    const a = runAnalystOnce(pool, { jev: slow, ...short });
    await new Promise((r) => setTimeout(r, 170));
    await sweepExpiredClaims(pool);
    const b = runAnalystOnce(pool, { jev: slow, ...short });
    await Promise.all([a, b]);
    const perSignal = (await pool.query(
      `select s.signal_id, (select count(*)::int from atlas.jev_decisions j where j.signal_id = s.signal_id) jev,
              (select count(*)::int from atlas.decisions d where d.signal_id = s.signal_id) dec, ss.state
         from atlas.signals s join atlas.signal_states ss using (signal_id) order by 1`)).rows;
    expect(perSignal).toEqual(['s-l1', 's-l2', 's-l3'].map((id) => ({ signal_id: id, jev: 1, dec: 1, state: 'analysed' })));
  });

  it('CTO should-fix 3: routing rules apply to the full ranked list before the cap of 5', async () => {
    const { rows } = await pool.query(`insert into atlas.shelves (slug, name, type, aliases) values ('eth','eth','asset',$1) returning id`, [['ETH']]);
    shelf.eth = rows[0].id;
    await pool.query('insert into atlas.routing_rules (token_shelf_id, project_shelf_id, route_to_shelf_id) values ($1,$2,$2)', [shelf.uni, shelf.uniswap]);
    await addSignal('s-six', 'Uniswap and $UNI rally with Bitcoin, ETH and XRP as the SEC weighs in');
    const jev = scriptedJev(() => ({ entity: ['uniswap', 0.95, 0.02], item: ['new_story', 0.9, 0.05] }));
    await runAnalystOnce(pool, { jev, ...opts });
    const slugs = (await sentState('s-six')).candidates.map((c) => c.slug).sort();
    expect(slugs).toEqual(['bitcoin', 'eth', 'sec', 'uniswap', 'xrp']);
  });

  it('CTO should-fix 4: the decision row stores entity/item probabilities and margins as numeric columns; reason is the outcome only', async () => {
    await addItem('btc-etf', 'bitcoin', 'Bitcoin ETF approvals', 2);
    await addSignal('s-prob', 'Bitcoin ETF inflows hit a record');
    await addSignal('s-new', 'Bitcoin miners form a new alliance');
    const jev = scriptedJev((s) => (/miners/.test(s.signal.text)
      ? { entity: ['bitcoin', 0.91, 0.04], item: ['new_story', 0.77, 0.12] }
      : { entity: ['bitcoin', 0.95, 0.02], item: [s.candidates[0].items[0].id, 0.88, 0.05] }));
    await runAnalystOnce(pool, { jev, ...opts });
    const rows = (await pool.query(
      `select signal_id, confidence, reason, entity_p::float8 entity_p, entity_margin::float8 entity_margin,
              item_p::float8 item_p, item_margin::float8 item_margin,
              pg_typeof(entity_p)::text t from atlas.decisions where signal_id in ('s-prob','s-new') order by signal_id`)).rows;
    expect(rows).toHaveLength(2);
    const [n, l] = rows;
    expect(l).toMatchObject({ signal_id: 's-prob', reason: 'linked', t: 'numeric' });
    expect(l.entity_p).toBeCloseTo(0.95); expect(l.entity_margin).toBeCloseTo(0.93);
    expect(l.item_p).toBeCloseTo(0.88); expect(l.item_margin).toBeCloseTo(0.83);
    expect(l.confidence).toBeCloseTo(0.95);
    expect(n).toMatchObject({ signal_id: 's-new', reason: 'new_story' });
    expect(n.item_p).toBeCloseTo(0.77); expect(n.item_margin).toBeCloseTo(0.65);
    await expect(pool.query(`update atlas.decisions set item_p = 1.5 where signal_id = 's-prob'`)).rejects.toThrow(/check/);
  });
});
