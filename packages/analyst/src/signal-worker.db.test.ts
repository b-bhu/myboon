/**
 * #504 D36 analyst worker on a throwaway LOCAL Postgres (ANALYST_TEST_ADMIN_URL). The worker (claims,
 * signal reads, entity search) and PgHandoffSink run on a second pool whose connections set role
 * service_role, so the tests prove the migration grants suffice; the admin/superuser pool stays for
 * setup only (truncate, seed entities/signals, resets) and assertion reads. Claim and finish use the
 * existing atlas.signal_* functions (#478/#479). The handoff goes to a HandoffSink: the
 * in-memory sink, and PgHandoffSink writing the atlas.decisions row only (#571: no items). The LLM, Jev and Clef are scripted (answers, errors, timeouts).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { createThrowawayDatabase, type ThrowawayDatabase } from '@myboon/atlas-schema';
import { ANALYST_OUTPUT_SCHEMA_VERSION, parseAnalystHandoff, parseAnalystOutput } from '@myboon/contracts';

import { DeciderError, type Decider, type DecisionCase } from './deciders.js';
import {
  InMemoryHandoffSink, PgHandoffSink, classifySignalFailure, processNextD36, pgCandidateLookup, toHandoff, emStatusFor, type D36Options,
} from './signal-worker.js';
import { createOllamaLlm, type ChatMessage, type JevLogEntry, type Llm } from './session.js';
import { spikeCases, spikeEntities } from './test-fixtures/d36-spike.js';
import { seedAliases } from './test-fixtures/aliases.js';

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
/** keep, existing_story for the angle, and the first offered choice for type and pick questions (#567). */
const keepAll: Rule = (c) => (c.choices.includes('keep') ? 'keep' : c.choices.includes('new_story') ? 'existing_story' : c.choices[0]);

/** Scripted LLM for the Kalshi signal: dissect, reasoning, notes (ignore path uses the 2nd reply as the reason). */
function kalshiLlm(o: { fail?: boolean } = {}): Llm & { turns: number } {
  const replies = [
    { summary: 'Kalshi raised $1B at a $40B valuation, per Cointelegraph.', mentions: [{ name: 'Kalshi', types: ['organization', 'product'], main: true, search_terms: [] }] },
    { reasoning: 'Continues its growth story.', reason: 'Not interesting.' },
    { note: 'Cointelegraph reports the raise.', reason: 'Routed.' },
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
  /** The admin pool: setup only (truncate, seed entities/signals, resets) and assertion reads. */
  let pool: Pool;
  /** The worker/sink pool: same throwaway DB with every connection running as service_role. */
  let svcPool: Pool;
  let sink: InMemoryHandoffSink;
  const logs: JevLogEntry[] = [];
  const opts = (o: Partial<D36Options>): D36Options => ({
    llm: kalshiLlm(), primary: scripted('jev', keepAll), fallback: scripted('clef', keepAll), shadow: null,
    lookup: pgCandidateLookup(svcPool), missLog: () => {}, sink, log: (e) => logs.push(e),
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
    sink = new InMemoryHandoffSink();
    await pool.query('truncate atlas.item_signals, atlas.decisions, atlas.signals cascade');
    await pool.query('delete from atlas.entities');
    for (const s of spikeEntities) {
      await pool.query('insert into atlas.entities (slug, name, type, aliases) values ($1, $2, $3, $4)', [s.slug, s.name, s.type, s.aliases]);
    }
    await seedAliases(pool);
    await pool.query(
      `insert into atlas.signals (signal_id, schema_version, source, source_id, type, text, link, occurred_at)
       values ($1, 1, $2, $3, 'news', $4, $5, now())`,
      [KALSHI.signal_id, KALSHI.source ?? 'tokens_xyz', 'src-kalshi', KALSHI.text, KALSHI.link]);
  });

  it('keep: the signal is analysed and one output with Jev-decided targets is saved', async () => {
    const r = await processNextD36(svcPool, opts({}));
    expect(r).toMatchObject({ signalId: KALSHI.signal_id, result: 'analysed' });
    expect(await sig()).toMatchObject({ status: 'analysed', claim_token: null });
    expect(sink.handoffs()).toHaveLength(1);
    expect(sink.handoffs()[0]).toMatchObject({ decision: 'keep', analyst_version: 'analyst-567-v1', schema_version: 1,
      entity: { slug: 'kalshi', type: 'organization', angle: 'existing_story' } });
    expect(logs.map((l) => l.provider)).toEqual(['jev', 'jev', 'jev']);
  });

  it('ignore: the signal is analysed and the output has a reason and no targets', async () => {
    const r = await processNextD36(svcPool, opts({ primary: scripted('jev', () => 'ignore') }));
    expect(r?.result).toBe('analysed');
    expect(sink.handoffs()[0]).toMatchObject({ decision: 'ignore', reason: 'Not interesting.', entity: null });
  });

  it('unclear: the signal is parked with the reason', async () => {
    const r = await processNextD36(svcPool, opts({ primary: scripted('jev', (c) => (c.choices.includes('keep') ? 'keep' : c.choices.includes('new_story') ? 'banana' : c.choices[0])) }));
    expect(r?.result).toBe('parked');
    const s = await sig();
    expect(s.status).toBe('parked');
    expect(s.parked_reason).toMatch(/banana/);
    expect(sink.handoffs()[0]).toMatchObject({ decision: 'unclear', entity: null });
  });

  it('Jev times out: Clef answers (fallback) and the signal is analysed', async () => {
    const clef = scripted('clef', keepAll);
    const r = await processNextD36(svcPool, opts({ primary: scripted('jev', () => 'timeout'), fallback: clef }));
    expect(r?.result).toBe('analysed');
    expect(clef.calls).toBe(3);
    expect(logs.every((l) => l.provider === 'clef')).toBe(true);
    expect(sink.handoffs()).toHaveLength(1);
  });

  it('Jev and Clef both fail: the signal stays unfinished (received, claim cleared, attempt counted) and is retried', async () => {
    const r = await processNextD36(svcPool, opts({ primary: scripted('jev', () => 'error'), fallback: scripted('clef', () => 'timeout') }));
    expect(r?.result).toBe('failed');
    const s = await sig();
    expect(s).toMatchObject({ status: 'received', attempts: 1, claim_token: null });
    expect(s.last_error).toMatch(/jev/);
    expect(s.last_error).toMatch(/clef/);
    expect(sink.handoffs()).toHaveLength(0);
    await pool.query('update atlas.signals set next_attempt_at = now() where signal_id = $1', [KALSHI.signal_id]);
    expect((await processNextD36(svcPool, opts({})))?.result).toBe('analysed');
  });

  it('the LLM fails: the signal stays unfinished and is retried', async () => {
    const r = await processNextD36(svcPool, opts({ llm: kalshiLlm({ fail: true }) }));
    expect(r?.result).toBe('failed');
    expect(await sig()).toMatchObject({ status: 'received', attempts: 1 });
    expect(sink.handoffs()).toHaveLength(0);
  });

  it('the Ollama LLM call hangs: it aborts at timeoutMs and takes the same retry path (Refs #512)', async () => {
    const hang = (async (_url: string, init: RequestInit) =>
      new Promise<Response>((_, reject) => init.signal?.addEventListener('abort', () => reject(init.signal?.reason)))) as unknown as typeof fetch;
    const llm = createOllamaLlm({ apiKey: 'sk-secret', model: 'm', fetchImpl: hang, timeoutMs: 50 });
    const r = await processNextD36(svcPool, opts({ llm }));
    expect(r?.result).toBe('failed');
    const s = await sig();
    expect(s).toMatchObject({ status: 'received', attempts: 1, claim_token: null });
    expect(s.last_error).toMatch(/LLM timed out after 50ms/);
    expect(sink.handoffs()).toHaveLength(0);
  });

  it('a signal_failed line is logged for every failed attempt: retry then dead at the attempt cap', async () => {
    const lines: Record<string, unknown>[] = [];
    const failOpts = (): D36Options => opts({ llm: kalshiLlm({ fail: true }), failLog: (e) => { lines.push(e); } });
    expect(await processNextD36(svcPool, failOpts())).toMatchObject({ result: 'failed' });
    // Exactly one line per attempt, with the claim's attempt number and failClaim's outcome.
    expect(lines).toEqual([
      { event: 'signal_failed', signal_id: KALSHI.signal_id, attempt: 1, reason: 'other', error: 'LLM HTTP 500', dead: false },
    ]);
    await pool.query('update atlas.signals set next_attempt_at = now() where signal_id = $1', [KALSHI.signal_id]);
    await processNextD36(svcPool, failOpts());
    expect(lines).toHaveLength(2);
    expect(lines[1]).toMatchObject({ attempt: 2, dead: false });
    await pool.query('update atlas.signals set next_attempt_at = now() where signal_id = $1', [KALSHI.signal_id]);
    expect(await processNextD36(svcPool, failOpts())).toMatchObject({ result: 'failed' });
    expect(lines[2]).toMatchObject({ event: 'signal_failed', signal_id: KALSHI.signal_id, attempt: 3, dead: true });
    expect(lines[2]).not.toHaveProperty('lost_claim');
    expect(await sig()).toMatchObject({ status: 'dead', attempts: 3 });
  });

  it('the Clef shadow is off by default and never changes the output when on', async () => {
    const shadow = scripted('clef', () => 'ignore');
    await processNextD36(svcPool, opts({}));
    expect(shadow.calls).toBe(0);
    await pool.query("update atlas.signals set status = 'received', next_attempt_at = now() where signal_id = $1", [KALSHI.signal_id]);
    sink = new InMemoryHandoffSink();
    await processNextD36(svcPool, opts({ shadow, sink }));
    expect(shadow.calls).toBe(3);
    expect(sink.handoffs()[0]).toMatchObject({ decision: 'keep', entity: { slug: 'kalshi' } });
  });

  it('the same signal processed twice keeps one output in the sink', async () => {
    await processNextD36(svcPool, opts({}));
    await pool.query("update atlas.signals set status = 'received', next_attempt_at = now() where signal_id = $1", [KALSHI.signal_id]);
    await processNextD36(svcPool, opts({}));
    expect(sink.handoffs()).toHaveLength(1);
  });

  it('nothing due: returns null', async () => {
    await pool.query("update atlas.signals set next_attempt_at = now() + interval '1 hour'");
    expect(await processNextD36(svcPool, opts({}))).toBeNull();
  });

  it('a signal older than 24h is parked backlog_skip_24h before the LLM, deciders or sink run (#391)', async () => {
    await pool.query("update atlas.signals set occurred_at = now() - interval '25 hours' where signal_id = $1", [KALSHI.signal_id]);
    const llm = kalshiLlm();
    const r = await processNextD36(svcPool, opts({ llm, sink: new PgHandoffSink(svcPool) }));
    expect(r).toMatchObject({ signalId: KALSHI.signal_id, result: 'parked' });
    // Never LLM'd: the session started with zero turns and not a single decider call was logged.
    expect(llm.turns).toBe(0);
    expect(logs).toHaveLength(0);
    // signal_claim counts one attempt per claim, so a claim followed by the park is attempts 1.
    expect(await sig()).toMatchObject({ status: 'parked', parked_reason: 'backlog_skip_24h', claim_token: null, attempts: 1 });
    expect((await pool.query('select count(*)::int n from atlas.decisions')).rows[0].n).toBe(0);
    expect((await pool.query('select count(*)::int n from atlas.entity_items')).rows[0].n).toBe(0);
  });

  it('a signal at 23h is still analysed as before (the 24h rule only parks older ones, #391)', async () => {
    await pool.query("update atlas.signals set occurred_at = now() - interval '23 hours' where signal_id = $1", [KALSHI.signal_id]);
    const llm = kalshiLlm();
    const r = await processNextD36(svcPool, opts({ llm }));
    expect(r?.result).toBe('analysed');
    expect(llm.turns).toBe(3);
    expect(await sig()).toMatchObject({ status: 'analysed', parked_reason: null });
  });

  const itemCount = async () => (await pool.query('select count(*)::int n from atlas.entity_items')).rows[0].n;
  const decisionRow = async () => (await pool.query('select decision, summary, reason, targets, handoff, handoff_version, em_status from atlas.decisions where signal_id = $1', [KALSHI.signal_id])).rows[0];

  it('#571 keep: the handoff carries the one entity pick and the full signal row, unchanged; no item, no summary', async () => {
    await pool.query(`update atlas.signals set raw_ids = $2::jsonb, excerpt = text, raw_hash = $3 where signal_id = $1`,
      [KALSHI.signal_id, JSON.stringify({ image: 'https://img.example/k.jpg', author: 'Jane', feed_source: 'coingecko', outlet: 'Cointelegraph' }), 'f'.repeat(64)]);
    const stored = (await pool.query('select * from atlas.signals where signal_id = $1', [KALSHI.signal_id])).rows[0];
    const r = await processNextD36(svcPool, opts({ sink: new PgHandoffSink(svcPool) }));
    expect(r?.result).toBe('analysed');
    const h = r!.handoff!;
    expect(h).toMatchObject({ decision: 'keep', entity: { slug: 'kalshi', type: 'organization', angle: 'existing_story' } });
    expect(h).not.toHaveProperty('summary');
    expect(h.signal).toMatchObject({
      signal_id: KALSHI.signal_id, source: stored.source, source_id: stored.source_id, type: 'news', text: stored.text, link: stored.link,
      excerpt: stored.text, raw_hash: 'f'.repeat(64), occurred_at: stored.occurred_at.toISOString(), fetched_at: stored.fetched_at.toISOString(),
      raw_ids: { image: 'https://img.example/k.jpg', author: 'Jane', feed_source: 'coingecko', outlet: 'Cointelegraph' },
    });
    const d = await decisionRow();
    expect(d).toMatchObject({ decision: 'keep', summary: null, reason: h.reason, handoff_version: 1, em_status: 'pending' });
    // The stored snapshot round-trips through the contract unchanged.
    expect(parseAnalystHandoff(d.handoff)).toEqual(h);
    expect(d.targets).toEqual([{ entity: 'kalshi', kind: 'existing', type: 'organization', angle: 'existing_story', note: h.entity!.note }]);
    expect(await itemCount()).toBe(0);
  });

  it('#571 the same signal processed twice gives one atlas.decisions row and no items', async () => {
    await processNextD36(svcPool, opts({ sink: new PgHandoffSink(svcPool) }));
    await pool.query("update atlas.signals set status = 'received', next_attempt_at = now() where signal_id = $1", [KALSHI.signal_id]);
    await processNextD36(svcPool, opts({ sink: new PgHandoffSink(svcPool) }));
    expect((await pool.query('select count(*)::int n from atlas.decisions where signal_id = $1', [KALSHI.signal_id])).rows[0].n).toBe(1);
    expect(await itemCount()).toBe(0);
  });

  it('#571 ignore and unclear hand over no entity and write no items', async () => {
    const r = await processNextD36(svcPool, opts({ sink: new PgHandoffSink(svcPool), primary: scripted('jev', () => 'ignore') }));
    expect(r?.handoff).toMatchObject({ decision: 'ignore', reason: 'Not interesting.', entity: null });
    const d = await decisionRow();
    expect(d).toMatchObject({ decision: 'ignore', summary: null, targets: [], em_status: 'none' });
    expect(parseAnalystHandoff(d.handoff)).toEqual(r!.handoff);
    expect(await itemCount()).toBe(0);
  });

  it('#571 unclear is stored with em_status none; keep with no entity pick is pending (growth path)', async () => {
    const r = await processNextD36(svcPool, opts({ sink: new PgHandoffSink(svcPool), primary: scripted('jev', (c) => (c.choices.includes('keep') ? 'keep' : c.choices.includes('new_story') ? 'banana' : c.choices[0])) }));
    expect(r?.result).toBe('parked');
    expect(await decisionRow()).toMatchObject({ decision: 'unclear', em_status: 'none' });
    const keepNone = { ...r!.handoff!, decision: 'keep' as const, entity: null };
    expect(emStatusFor(keepNone)).toBe('pending');
    await pool.query('delete from atlas.decisions');
    await new PgHandoffSink(svcPool).save(keepNone);
    const d = await decisionRow();
    expect(d).toMatchObject({ decision: 'keep', em_status: 'pending', targets: [] });
    expect(parseAnalystHandoff(d.handoff).entity).toBeNull();
  });

  it('#571/#567 extra or kind-new targets are dropped and logged; the handoff keeps only the first existing one', async () => {
    const drops: Record<string, unknown>[] = [];
    const signal = (await processNextD36(svcPool, opts({})))!.handoff!.signal;
    const out = parseAnalystOutput({
      schema_version: ANALYST_OUTPUT_SCHEMA_VERSION, analyst_version: 'v', signal_id: KALSHI.signal_id, summary: 'S.', decision: 'keep', reason: 'r',
      targets: [
        { entity: 'fresh-567', kind: 'new', type: 'organization', angle: 'new_story', note: 'n' },
        { entity: 'base', kind: 'existing', type: 'protocol', angle: 'existing_story', note: 'n' },
        { entity: 'coinbase', kind: 'existing', type: 'organization', angle: 'plain_update', note: 'n' },
      ],
    });
    const before = (await pool.query('select count(*)::int n from atlas.entities')).rows[0].n;
    expect(toHandoff(out, signal, (e) => { drops.push(e); }).entity?.slug).toBe('base');
    expect(drops).toEqual([
      { event: 'target_dropped', signal_id: KALSHI.signal_id, entity: 'fresh-567', reason: 'new entities are never created (#567)' },
      { event: 'target_dropped', signal_id: KALSHI.signal_id, entity: 'coinbase', reason: 'one main entity per signal (#567)' },
    ]);
    expect((await pool.query('select count(*)::int n from atlas.entities')).rows[0].n).toBe(before);
  });

  describe('#567 pgCandidateLookup shortlist on the #566 tables', () => {
    const seedPlaces = async (n: number) => {
      for (let k = 0; k < n; k += 1) await pool.query("insert into atlas.entities (slug, name, type) values ($1, $2, 'place')", [`place-${k}`, `Place ${k}`]);
      await pool.query("insert into atlas.entities (slug, name, type, aliases, summary) values ('france', 'France', 'place', array['French Republic'], 'A country. Second sentence.')");
      await seedAliases(pool);
    };
    const giveItems = async (slug: string, count: number) => {
      for (let k = 0; k < count; k += 1) {
        await pool.query(`insert into atlas.signals (signal_id, schema_version, source, source_id, type, text, link, occurred_at)
          values ($1, 1, 'tokens_xyz', $1, 'news', 'x', null, now())`, [`${slug}-${k}`]);
        await pool.query(`insert into atlas.entity_items (item_key, title, summary, main_entity_id, signal_id, angle, note, occurred_at)
          select $1, 't', 's', id, $1, 'plain_update', 'n', now() from atlas.entities where slug = $2`, [`${slug}-${k}`, slug]);
      }
    };

    it('alias hits first and always kept, then the fill by item count, capped; carries id, aliases and one-line summary', async () => {
      await seedPlaces(50);
      await giveItems('place-7', 3);
      await giveItems('place-3', 1);
      const rows = await pgCandidateLookup(svcPool).shortlist(['place', 'regulation'], ['france delays', 'french republic'], 10);
      expect(rows.map((r) => r.slug).slice(0, 3)).toEqual(['france', 'place-7', 'place-3']);
      expect(rows).toHaveLength(10);
      expect(rows[0]).toMatchObject({ id: expect.any(String), type: 'place', alias_hit: true, summary: 'A country.' });
      expect(rows[0].aliases).toEqual(expect.arrayContaining(['France', 'French Republic']));
      expect(rows.filter((r) => r.alias_hit).map((r) => r.slug)).toEqual(['france']);
    });

    it('alias hits are capped too: more hits than the cap returns exactly cap rows, most items first', async () => {
      await seedPlaces(12);
      await giveItems('place-7', 3);
      const names = Array.from({ length: 12 }, (_, i) => `place ${i}`);
      const rows = await pgCandidateLookup(svcPool).shortlist(['place'], names, 5);
      expect(rows).toHaveLength(5);
      expect(rows.every((r) => r.alias_hit)).toBe(true);
      expect(rows[0].slug).toBe('place-7');
    });

    it('both types are searched; active only; deduped', async () => {
      await seedPlaces(2);
      await pool.query("update atlas.entities set status = 'retired' where slug = 'place-0'");
      const rows = await pgCandidateLookup(svcPool).shortlist(['organization', 'place'], ['Coinbase', 'Place 0'], 40);
      const slugs = rows.map((r) => r.slug);
      expect(slugs[0]).toBe('coinbase');
      expect(slugs).not.toContain('place-0');
      expect(new Set(slugs).size).toBe(slugs.length);
      expect(rows.some((r) => r.type === 'place')).toBe(true);
    });
  });
});

describe('classifySignalFailure (pure, no database)', () => {
  it('timeout: a message saying timed out/timeout wins, whichever stage failed', () => {
    expect(classifySignalFailure(new Error('LLM timed out after 50ms'), 'session')).toBe('timeout');
    expect(classifySignalFailure(new Error('decider request timeout'), 'session')).toBe('timeout');
    expect(classifySignalFailure(new Error('pool connection timed out'), 'sink')).toBe('timeout');
  });

  it('parse: a SyntaxError or a JSON/parse message, even from the sink stage', () => {
    expect(classifySignalFailure(new SyntaxError('Unexpected token o'), 'session')).toBe('parse');
    expect(classifySignalFailure(new Error('reply has no JSON object: oops'), 'session')).toBe('parse');
    expect(classifySignalFailure(new Error('failed to parse the sink output'), 'sink')).toBe('parse');
  });

  it('db: a pg error (a string code) or whatever sink.save threw', () => {
    expect(classifySignalFailure({ code: '42703', message: 'column "x" does not exist' }, 'session')).toBe('db');
    expect(classifySignalFailure(new Error('target kalshi: no active entity'), 'sink')).toBe('db');
  });

  it('other: an LLM HTTP error and a non-error value', () => {
    expect(classifySignalFailure(new Error('LLM HTTP 500'), 'session')).toBe('other');
    expect(classifySignalFailure(null, 'session')).toBe('other');
  });
});
