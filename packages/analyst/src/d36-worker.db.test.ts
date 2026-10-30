/**
 * #504 D36 analyst worker on a throwaway LOCAL Postgres (ANALYST_TEST_ADMIN_URL). The worker (claims,
 * signal reads, shelf search) and PgDecisionSink run on a second pool whose connections set role
 * service_role, so the tests prove the migration grants suffice; the admin/superuser pool stays for
 * setup only (truncate, seed shelves/signals, resets) and assertion reads. Claim and finish use the
 * existing atlas.signal_* functions (#478/#479). The decision write goes to a DecisionSink: the in-memory
 * sink, and PgDecisionSink writing atlas.decisions + atlas.items (proposed shelves for new targets) on the
 * #503 schema. The LLM, Jev and Clef are scripted (answers, errors, timeouts).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { createThrowawayDatabase, type ThrowawayDatabase } from '@myboon/atlas-schema';
import { ANALYST_OUTPUT_SCHEMA_VERSION, parseAnalystOutput } from '@myboon/contracts';

import { DeciderError, type Decider, type DecisionCase } from './deciders.js';
import { InMemoryDecisionSink, PgDecisionSink, processNextD36, shelfSearchFromDb, type D36Options } from './d36-worker.js';
import type { ChatMessage, JevLogEntry, Llm } from './session.js';
import { spikeCases, spikeShelves } from './test-fixtures/d36-spike.js';

const ADMIN_URL = process.env.ANALYST_TEST_ADMIN_URL?.trim() ?? '';
const KALSHI = spikeCases[5].signal; // a real scout signal (Cointelegraph via tokens_xyz)

type Rule = (c: DecisionCase) => string | 'error' | 'timeout';
/** Scripted decider: a rule maps each case to a choice, an error or a hang until abort. */
function scripted(name: 'jev' | 'clef', rule: Rule): Decider & { calls: number } {
  const d = {
    name, modelName: name, modelVersion: `${name}-test`, calls: 0,
    async decide(c: DecisionCase, signal: AbortSignal) {
      d.calls += 1;
      const r = rule(c);
      if (r === 'timeout') return new Promise<never>((_, rej) => signal.addEventListener('abort', () => rej(new Error('aborted'))));
      if (r === 'error') throw new DeciderError('error', `${name} 503`);
      return { choice: r, probabilities: { [r]: 0.9 } };
    },
  };
  return d;
}
const keepAll: Rule = (c) => (c.choices.includes('keep') ? 'keep' : c.choices.includes('new_story') ? 'existing_story' : 'existing');

/** Scripted LLM for the Kalshi signal: dissect, reasoning, notes (ignore path uses the 2nd reply as the reason). */
function kalshiLlm(o: { fail?: boolean } = {}): Llm & { turns: number } {
  const replies = [
    { summary: 'Kalshi raised $1B at a $40B valuation, per Cointelegraph.', mentions: [{ name: 'Kalshi', type: 'organization', search_terms: [] }] },
    { reasoning: [{ mention: 'Kalshi', reasoning: 'Continues its growth story.' }], reason: 'Not interesting.' },
    { targets: [{ mention: 'Kalshi', type: 'organization', note: 'Cointelegraph reports the raise.' }], reason: 'Routed.' },
  ];
  const llm = (async (_m: ChatMessage[]) => {
    llm.turns += 1;
    if (o.fail) throw new Error('LLM HTTP 500');
    return JSON.stringify(replies[Math.min(llm.turns - 1, replies.length - 1)]);
  }) as Llm & { turns: number };
  llm.turns = 0;
  return llm;
}

describe.skipIf(ADMIN_URL === '')('#504 D36 analyst worker (local Postgres)', () => {
  let db: ThrowawayDatabase;
  /** The admin pool: setup only (truncate, seed shelves/signals, resets) and assertion reads. */
  let pool: Pool;
  /** The worker/sink pool: same throwaway DB with every connection running as service_role. */
  let svcPool: Pool;
  let sink: InMemoryDecisionSink;
  const logs: JevLogEntry[] = [];
  const opts = (o: Partial<D36Options>): D36Options => ({
    llm: kalshiLlm(), primary: scripted('jev', keepAll), fallback: scripted('clef', keepAll), shadow: null,
    search: shelfSearchFromDb(svcPool), sink, log: (e) => logs.push(e),
    leaseMs: 60_000, timeoutMs: 100, backoffMs: 60_000, maxAttempts: 3, worker: 'w504', ...o,
  });
  const sig = async () => (await pool.query(
    'select status, parked_reason, attempts::int attempts, last_error, claim_token from atlas.signals where signal_id = $1', [KALSHI.signal_id])).rows[0];

  beforeAll(async () => {
    db = await createThrowawayDatabase(ADMIN_URL);
    pool = new Pool({ connectionString: db.url, max: 4 });
    svcPool = new Pool({ connectionString: db.url, max: 4 });
    svcPool.on('connect', (c) => c.query('set role service_role'));
  });
  afterAll(async () => { await pool?.end(); await svcPool?.end(); await db?.drop(); });
  beforeEach(async () => {
    logs.length = 0;
    sink = new InMemoryDecisionSink();
    await pool.query('truncate atlas.item_signals, atlas.decisions, atlas.signals cascade');
    await pool.query('delete from atlas.shelves');
    for (const s of spikeShelves) {
      await pool.query('insert into atlas.shelves (slug, name, type, aliases) values ($1, $2, $3, $4)', [s.slug, s.name, s.type, s.aliases]);
    }
    await pool.query(
      `insert into atlas.signals (signal_id, schema_version, source, source_id, type, text, link, occurred_at)
       values ($1, 1, $2, $3, 'news', $4, $5, now())`,
      [KALSHI.signal_id, KALSHI.source ?? 'tokens_xyz', 'src-kalshi', KALSHI.text, KALSHI.link]);
  });

  it('keep: the signal is analysed and one output with Jev-decided targets is saved', async () => {
    const r = await processNextD36(svcPool, opts({}));
    expect(r).toMatchObject({ signalId: KALSHI.signal_id, result: 'analysed' });
    expect(await sig()).toMatchObject({ status: 'analysed', claim_token: null });
    expect(sink.outputs()).toHaveLength(1);
    expect(sink.outputs()[0]).toMatchObject({ decision: 'keep', analyst_version: 'analyst-504-v1', schema_version: 1,
      targets: [{ entity: 'kalshi', kind: 'existing', type: 'organization', angle: 'existing_story' }] });
    expect(logs.map((l) => l.provider)).toEqual(['jev', 'jev', 'jev']);
  });

  it('ignore: the signal is analysed and the output has a reason and no targets', async () => {
    const r = await processNextD36(svcPool, opts({ primary: scripted('jev', () => 'ignore') }));
    expect(r?.result).toBe('analysed');
    expect(sink.outputs()[0]).toMatchObject({ decision: 'ignore', reason: 'Not interesting.', targets: [] });
  });

  it('unclear: the signal is parked with the reason', async () => {
    const r = await processNextD36(svcPool, opts({ primary: scripted('jev', (c) => (c.choices.includes('keep') ? 'keep' : 'banana')) }));
    expect(r?.result).toBe('parked');
    const s = await sig();
    expect(s.status).toBe('parked');
    expect(s.parked_reason).toMatch(/banana/);
    expect(sink.outputs()[0]).toMatchObject({ decision: 'unclear', targets: [] });
  });

  it('Jev times out: Clef answers (fallback) and the signal is analysed', async () => {
    const clef = scripted('clef', keepAll);
    const r = await processNextD36(svcPool, opts({ primary: scripted('jev', () => 'timeout'), fallback: clef }));
    expect(r?.result).toBe('analysed');
    expect(clef.calls).toBe(3);
    expect(logs.every((l) => l.provider === 'clef')).toBe(true);
    expect(sink.outputs()).toHaveLength(1);
  });

  it('Jev and Clef both fail: the signal stays unfinished (received, claim cleared, attempt counted) and is retried', async () => {
    const r = await processNextD36(svcPool, opts({ primary: scripted('jev', () => 'error'), fallback: scripted('clef', () => 'timeout') }));
    expect(r?.result).toBe('failed');
    const s = await sig();
    expect(s).toMatchObject({ status: 'received', attempts: 1, claim_token: null });
    expect(s.last_error).toMatch(/jev/);
    expect(s.last_error).toMatch(/clef/);
    expect(sink.outputs()).toHaveLength(0);
    await pool.query('update atlas.signals set next_attempt_at = now() where signal_id = $1', [KALSHI.signal_id]);
    expect((await processNextD36(svcPool, opts({})))?.result).toBe('analysed');
  });

  it('the LLM fails: the signal stays unfinished and is retried', async () => {
    const r = await processNextD36(svcPool, opts({ llm: kalshiLlm({ fail: true }) }));
    expect(r?.result).toBe('failed');
    expect(await sig()).toMatchObject({ status: 'received', attempts: 1 });
    expect(sink.outputs()).toHaveLength(0);
  });

  it('the Clef shadow is off by default and never changes the output when on', async () => {
    const shadow = scripted('clef', () => 'ignore');
    await processNextD36(svcPool, opts({}));
    expect(shadow.calls).toBe(0);
    await pool.query("update atlas.signals set status = 'received', next_attempt_at = now() where signal_id = $1", [KALSHI.signal_id]);
    sink = new InMemoryDecisionSink();
    await processNextD36(svcPool, opts({ shadow, sink }));
    expect(shadow.calls).toBe(3);
    expect(sink.outputs()[0]).toMatchObject({ decision: 'keep', targets: [{ entity: 'kalshi' }] });
  });

  it('the same signal processed twice keeps one output in the sink', async () => {
    await processNextD36(svcPool, opts({}));
    await pool.query("update atlas.signals set status = 'received', next_attempt_at = now() where signal_id = $1", [KALSHI.signal_id]);
    await processNextD36(svcPool, opts({}));
    expect(sink.outputs()).toHaveLength(1);
  });

  it('nothing due: returns null', async () => {
    await pool.query("update atlas.signals set next_attempt_at = now() + interval '1 hour'");
    expect(await processNextD36(svcPool, opts({}))).toBeNull();
  });

  it('the same signal processed twice gives one atlas.decisions row (PgDecisionSink)', async () => {
    await processNextD36(svcPool, opts({ sink: new PgDecisionSink(svcPool) }));
    await pool.query("update atlas.signals set status = 'received', next_attempt_at = now() where signal_id = $1", [KALSHI.signal_id]);
    await processNextD36(svcPool, opts({ sink: new PgDecisionSink(svcPool) }));
    expect((await pool.query('select count(*)::int n from atlas.decisions where signal_id = $1', [KALSHI.signal_id])).rows[0].n).toBe(1);
    expect((await pool.query('select count(*)::int n from atlas.items where signal_id = $1', [KALSHI.signal_id])).rows[0].n).toBe(1);
  });

  it('keep with targets: the decisions row carries the output and one item per target (PgDecisionSink)', async () => {
    const r = await processNextD36(svcPool, opts({ sink: new PgDecisionSink(svcPool) }));
    expect(r?.result).toBe('analysed');
    const out = r?.output;
    expect(out?.decision).toBe('keep');
    const d = (await pool.query('select decision, summary, reason, targets from atlas.decisions where signal_id = $1', [KALSHI.signal_id])).rows[0];
    expect(d.decision).toBe('keep');
    expect(d.summary).toBe(out?.summary);
    expect(d.reason).toBe(out?.reason);
    expect(d.targets).toEqual(out!.targets);
    const items = (await pool.query(
      'select i.*, s.slug as shelf_slug from atlas.items i join atlas.shelves s on s.id = i.main_shelf_id where i.signal_id = $1',
      [KALSHI.signal_id],
    )).rows;
    expect(items).toHaveLength(out!.targets.length);
    for (const t of out!.targets) {
      const item = items.find((i: { shelf_slug: string }) => i.shelf_slug === t.entity);
      expect(item).toBeDefined();
      expect(item.item_key).toBe(`${KALSHI.signal_id}:${t.entity}`);
      expect(item.signal_id).toBe(KALSHI.signal_id);
      expect(item.angle).toBe(t.angle);
      expect(item.note).toBe(t.note);
    }
    expect((await pool.query('select count(*)::int n from atlas.item_signals')).rows[0].n).toBe(0);
  });

  it('ignore writes a decision row and no items (PgDecisionSink)', async () => {
    const r = await processNextD36(svcPool, opts({ sink: new PgDecisionSink(svcPool), primary: scripted('jev', () => 'ignore') }));
    expect(r?.result).toBe('analysed');
    const d = (await pool.query('select decision, summary, reason, targets from atlas.decisions where signal_id = $1', [KALSHI.signal_id])).rows[0];
    expect(d.decision).toBe('ignore');
    expect(d.summary).toBe(r?.output?.summary);
    expect(d.reason).toBe('Not interesting.');
    expect(d.targets).toEqual([]);
    expect((await pool.query('select count(*)::int n from atlas.items where signal_id = $1', [KALSHI.signal_id])).rows[0].n).toBe(0);
  });

  it('unclear writes a decision row (targets []) and no items (PgDecisionSink)', async () => {
    const r = await processNextD36(svcPool, opts({ sink: new PgDecisionSink(svcPool), primary: scripted('jev', (c) => (c.choices.includes('keep') ? 'keep' : 'banana')) }));
    expect(r?.result).toBe('parked');
    const d = (await pool.query('select decision, summary, reason, targets from atlas.decisions where signal_id = $1', [KALSHI.signal_id])).rows[0];
    expect(d.decision).toBe('unclear');
    expect(d.reason).toMatch(/banana/);
    expect(d.targets).toEqual([]);
    expect((await pool.query('select count(*)::int n from atlas.items where signal_id = $1', [KALSHI.signal_id])).rows[0].n).toBe(0);
  });

  it('a kind new target creates a proposed shelf holding the item (PgDecisionSink)', async () => {
    const output = parseAnalystOutput({
      schema_version: ANALYST_OUTPUT_SCHEMA_VERSION,
      analyst_version: 'analyst-504-v1',
      signal_id: KALSHI.signal_id,
      summary: 'Druckenmiller moved into Hyperliquid.',
      decision: 'keep',
      reason: 'A new entity is needed.',
      targets: [{ entity: 'stanley-druckenmiller', kind: 'new', type: 'person', angle: 'new_story', note: 'Reported move into Hyperliquid.' }],
    });
    await new PgDecisionSink(svcPool).save(output);
    const shelf = (await pool.query('select slug, name, type, status from atlas.shelves where slug = $1', ['stanley-druckenmiller'])).rows[0];
    expect(shelf).toMatchObject({ slug: 'stanley-druckenmiller', name: 'stanley-druckenmiller', type: 'person', status: 'proposed' });
    const items = (await pool.query(
      'select i.signal_id, i.angle, i.note, i.summary, s.slug as shelf_slug from atlas.items i join atlas.shelves s on s.id = i.main_shelf_id where i.signal_id = $1',
      [KALSHI.signal_id],
    )).rows;
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      signal_id: KALSHI.signal_id, shelf_slug: 'stanley-druckenmiller',
      angle: 'new_story', note: 'Reported move into Hyperliquid.', summary: 'Reported move into Hyperliquid.',
    });
  });

  it('an existing target whose slug is not an active shelf throws and writes nothing (PgDecisionSink)', async () => {
    const output = parseAnalystOutput({
      schema_version: ANALYST_OUTPUT_SCHEMA_VERSION,
      analyst_version: 'analyst-504-v1',
      signal_id: KALSHI.signal_id,
      summary: 'Nobody special.',
      decision: 'keep',
      reason: 'Bad route.',
      targets: [{ entity: 'no-such-shelf', kind: 'existing', type: 'organization', angle: 'plain_update', note: 'Nothing here.' }],
    });
    await expect(new PgDecisionSink(svcPool).save(output)).rejects.toThrow(/no active shelf/);
    expect((await pool.query('select count(*)::int n from atlas.decisions where signal_id = $1', [KALSHI.signal_id])).rows[0].n).toBe(0);
    expect((await pool.query('select count(*)::int n from atlas.items where signal_id = $1', [KALSHI.signal_id])).rows[0].n).toBe(0);
    expect((await pool.query('select count(*)::int n from atlas.shelves where slug = $1', ['no-such-shelf'])).rows[0].n).toBe(0);
  });
});
