/**
 * #504 D36 analyst worker on a throwaway LOCAL Postgres (ANALYST_TEST_ADMIN_URL). The worker (claims,
 * signal reads, entity search) and PgDecisionSink run on a second pool whose connections set role
 * service_role, so the tests prove the migration grants suffice; the admin/superuser pool stays for
 * setup only (truncate, seed entities/signals, resets) and assertion reads. Claim and finish use the
 * existing atlas.signal_* functions (#478/#479). The decision write goes to a DecisionSink: the
 * in-memory sink, and PgDecisionSink writing atlas.decisions + atlas.entity_items (proposed entities for new
 * targets) on the #503 schema. The LLM, Jev and Clef are scripted (answers, errors, timeouts).
 *
 * #482 filing rules (tests written first; sink changes follow): per-slug advisory-lock serialisation,
 * items stamped with the signal's occurred_at, and kind-new slugs: reuse only a proposed entity, file on
 * an active entity with a target_reclassified log (#511), drop a retired slug (target_dropped, no item).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { createThrowawayDatabase, type ThrowawayDatabase } from '@myboon/atlas-schema';
import { ANALYST_OUTPUT_SCHEMA_VERSION, parseAnalystOutput } from '@myboon/contracts';

import { DeciderError, type Decider, type DecisionCase } from './deciders.js';
import {
  InMemoryDecisionSink, PgDecisionSink, classifySignalFailure, processNextD36, pgCandidateLookup, type D36Options,
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
    { summary: 'Kalshi raised $1B at a $40B valuation, per Cointelegraph.', mentions: [{ name: 'Kalshi', types: ['organization'], search_terms: [] }] },
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
  let sink: InMemoryDecisionSink;
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
    sink = new InMemoryDecisionSink();
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
    expect(sink.outputs()).toHaveLength(1);
    expect(sink.outputs()[0]).toMatchObject({ decision: 'keep', analyst_version: 'analyst-567-v1', schema_version: 1,
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

  it('the Ollama LLM call hangs: it aborts at timeoutMs and takes the same retry path (Refs #512)', async () => {
    const hang = (async (_url: string, init: RequestInit) =>
      new Promise<Response>((_, reject) => init.signal?.addEventListener('abort', () => reject(init.signal?.reason)))) as unknown as typeof fetch;
    const llm = createOllamaLlm({ apiKey: 'sk-secret', model: 'm', fetchImpl: hang, timeoutMs: 50 });
    const r = await processNextD36(svcPool, opts({ llm }));
    expect(r?.result).toBe('failed');
    const s = await sig();
    expect(s).toMatchObject({ status: 'received', attempts: 1, claim_token: null });
    expect(s.last_error).toMatch(/LLM timed out after 50ms/);
    expect(sink.outputs()).toHaveLength(0);
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

  it('a signal older than 24h is parked backlog_skip_24h before the LLM, deciders or sink run (#391)', async () => {
    await pool.query("update atlas.signals set occurred_at = now() - interval '25 hours' where signal_id = $1", [KALSHI.signal_id]);
    const llm = kalshiLlm();
    const r = await processNextD36(svcPool, opts({ llm, sink: new PgDecisionSink(svcPool) }));
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

  it('the same signal processed twice gives one atlas.decisions row (PgDecisionSink)', async () => {
    await processNextD36(svcPool, opts({ sink: new PgDecisionSink(svcPool) }));
    await pool.query("update atlas.signals set status = 'received', next_attempt_at = now() where signal_id = $1", [KALSHI.signal_id]);
    await processNextD36(svcPool, opts({ sink: new PgDecisionSink(svcPool) }));
    expect((await pool.query('select count(*)::int n from atlas.decisions where signal_id = $1', [KALSHI.signal_id])).rows[0].n).toBe(1);
    expect((await pool.query('select count(*)::int n from atlas.entity_items where signal_id = $1', [KALSHI.signal_id])).rows[0].n).toBe(1);
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
      'select i.*, s.slug as entity_slug from atlas.entity_items i join atlas.entities s on s.id = i.main_entity_id where i.signal_id = $1',
      [KALSHI.signal_id],
    )).rows;
    expect(items).toHaveLength(out!.targets.length);
    for (const t of out!.targets) {
      const item = items.find((i: { entity_slug: string }) => i.entity_slug === t.entity);
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
    expect((await pool.query('select count(*)::int n from atlas.entity_items where signal_id = $1', [KALSHI.signal_id])).rows[0].n).toBe(0);
  });

  it('unclear writes a decision row (targets []) and no items (PgDecisionSink)', async () => {
    const r = await processNextD36(svcPool, opts({ sink: new PgDecisionSink(svcPool), primary: scripted('jev', (c) => (c.choices.includes('keep') ? 'keep' : 'banana')) }));
    expect(r?.result).toBe('parked');
    const d = (await pool.query('select decision, summary, reason, targets from atlas.decisions where signal_id = $1', [KALSHI.signal_id])).rows[0];
    expect(d.decision).toBe('unclear');
    expect(d.reason).toMatch(/banana/);
    expect(d.targets).toEqual([]);
    expect((await pool.query('select count(*)::int n from atlas.entity_items where signal_id = $1', [KALSHI.signal_id])).rows[0].n).toBe(0);
  });

  it('#559 PANews case: title is the headline with no source names, summary differs from the note, link stays on the signal', async () => {
    const output = parseAnalystOutput({
      schema_version: ANALYST_OUTPUT_SCHEMA_VERSION,
      analyst_version: 'analyst-504-v1',
      signal_id: KALSHI.signal_id,
      headline: 'According to PANews, China Merchants Bank adds digital RMB payments to its app',
      summary: 'According to a PANews report shared by tokens_xyz, China Merchants Bank added digital RMB payments to its mobile app. It widens retail access to the e-CNY.',
      decision: 'keep',
      reason: 'A new entity is needed.',
      targets: [{ entity: 'coinbase', kind: 'existing', type: 'organization', angle: 'new_story', note: 'PANews reports the bank shipped an e-CNY feature.' }],
    });
    await new PgDecisionSink(svcPool).save(output);
    const row = (await pool.query(
      'select i.title, i.summary, i.note, s.link from atlas.entity_items i join atlas.signals s on s.signal_id = i.signal_id where i.signal_id = $1',
      [KALSHI.signal_id],
    )).rows[0];
    expect(row.title).toBe('China Merchants Bank adds digital RMB payments to its app');
    expect(row.summary).toBe('China Merchants Bank added digital RMB payments to its mobile app. It widens retail access to the e-CNY.');
    for (const bad of ['PANews', 'tokens_xyz', 'According to', 'shared by']) {
      expect(row.title).not.toContain(bad);
      expect(row.summary).not.toContain(bad);
    }
    expect(row.summary).not.toBe(row.note);
    expect(row.link).toBe(KALSHI.link);
  });

  it('an existing target whose slug is not an active entity throws and writes nothing (PgDecisionSink)', async () => {
    const output = parseAnalystOutput({
      schema_version: ANALYST_OUTPUT_SCHEMA_VERSION,
      analyst_version: 'analyst-504-v1',
      signal_id: KALSHI.signal_id,
      summary: 'Nobody special.',
      decision: 'keep',
      reason: 'Bad route.',
      targets: [{ entity: 'no-such-entity', kind: 'existing', type: 'organization', angle: 'plain_update', note: 'Nothing here.' }],
    });
    await expect(new PgDecisionSink(svcPool).save(output)).rejects.toThrow(/no active entity/);
    expect((await pool.query('select count(*)::int n from atlas.decisions where signal_id = $1', [KALSHI.signal_id])).rows[0].n).toBe(0);
    expect((await pool.query('select count(*)::int n from atlas.entity_items where signal_id = $1', [KALSHI.signal_id])).rows[0].n).toBe(0);
    expect((await pool.query('select count(*)::int n from atlas.entities where slug = $1', ['no-such-entity'])).rows[0].n).toBe(0);
  });

  describe('#482 filing rules (PgDecisionSink, tests first)', () => {
    type ItemRow = {
      item_key: string; signal_id: string; occurred_at: Date | null;
      entity_slug: string; entity_status: string; signal_occurred_at: Date | null;
    };
    /** Extra signal with a fixed occurred_at: the sink must copy it onto every filed item. */
    const addSignal = (signalId: string, occurredAt: string) => pool.query(
      `insert into atlas.signals (signal_id, schema_version, source, source_id, type, text, link, occurred_at)
         values ($1, 1, 'tokens_xyz', $2, 'news', $3, null, $4::timestamptz)`,
      [signalId, `${signalId}-src`, `Signal ${signalId} for #482.`, occurredAt],
    );
    const tgt = (entity: string, kind: 'existing' | 'new', type: string, angle: string) =>
      ({ entity, kind, type, angle, note: `Note on ${entity}.` });
    const out = (signalId: string, targets: { entity: string; kind: 'existing' | 'new'; type: string; angle: string; note: string }[]) =>
      parseAnalystOutput({
        schema_version: ANALYST_OUTPUT_SCHEMA_VERSION,
        analyst_version: 'analyst-504-v1',
        signal_id: signalId,
        summary: `Summary for ${signalId}.`,
        decision: 'keep',
        reason: 'Worth filing.',
        targets,
      });
    /** Items joined to their entity and signal (for occurred_at and timeline-order reads). */
    const itemsOf = (slug?: string) => pool.query<ItemRow>(
      `select i.item_key, i.signal_id, i.occurred_at, s.slug as entity_slug, s.status as entity_status,
              (select occurred_at from atlas.signals where signal_id = i.signal_id) as signal_occurred_at
         from atlas.entity_items i join atlas.entities s on s.id = i.main_entity_id
        where ($1::text is null or s.slug = $1::text)
        order by i.occurred_at, i.item_key`,
      [slug ?? null],
    );
    const n = (sql: string, params: unknown[] = []) => pool.query<{ n: number }>(sql, params).then((r) => r.rows[0].n);

    it('#567/#560: 3 targets still file exactly 1 item, on the first existing target; the rest are dropped and logged', async () => {
      await addSignal('sig-567-a', '2026-10-30T09:00:00.000Z');
      const drops: Record<string, unknown>[] = [];
      await new PgDecisionSink(svcPool, (e) => { drops.push(e); }).save(out('sig-567-a', [
        tgt('base', 'existing', 'protocol', 'existing_story'),
        tgt('coinbase', 'existing', 'organization', 'plain_update'),
        tgt('stanley-druckenmiller', 'new', 'person', 'new_story'),
      ]));
      expect(await n('select count(*)::int n from atlas.decisions where signal_id = $1', ['sig-567-a'])).toBe(1);
      const items = (await itemsOf()).rows;
      expect(items.map((i) => i.entity_slug)).toEqual(['base']);
      expect(items[0].occurred_at?.getTime()).toBe(items[0].signal_occurred_at?.getTime());
      expect(drops).toEqual([
        { event: 'target_dropped', signal_id: 'sig-567-a', entity: 'coinbase', reason: 'one main entity per signal (#567)' },
        { event: 'target_dropped', signal_id: 'sig-567-a', entity: 'stanley-druckenmiller', reason: 'new entities are never created (#567)' },
      ]);
    });

    it('#567/#560: never propose: kind new targets insert no atlas.entities row and set nothing to proposed', async () => {
      await addSignal('sig-567-b', '2026-10-30T09:00:00.000Z');
      const before = await n('select count(*)::int n from atlas.entities');
      await new PgDecisionSink(svcPool, () => {}).save(out('sig-567-b', [
        tgt('fresh-567', 'new', 'organization', 'new_story'),
        tgt('coinbase', 'new', 'organization', 'new_story'),
      ]));
      expect(await n('select count(*)::int n from atlas.entities')).toBe(before);
      expect(await n("select count(*)::int n from atlas.entities where status = 'proposed'")).toBe(0);
      expect((await itemsOf()).rows).toHaveLength(0);
      expect(await n('select count(*)::int n from atlas.decisions where signal_id = $1', ['sig-567-b'])).toBe(1);
    });

    it('#560: saving the same output twice still leaves 1 item and 1 decision; existing items stay unchanged', async () => {
      await addSignal('sig-567-c', '2026-10-30T09:00:00.000Z');
      const output = out('sig-567-c', [tgt('hyperliquid', 'existing', 'protocol', 'plain_update')]);
      const sink = new PgDecisionSink(svcPool);
      await sink.save(output);
      const first = (await itemsOf()).rows;
      await sink.save(out('sig-567-c', [tgt('base', 'existing', 'protocol', 'new_story')]));
      expect(await n('select count(*)::int n from atlas.decisions where signal_id = $1', ['sig-567-c'])).toBe(1);
      expect((await itemsOf()).rows).toEqual(first);
    });

    it('a save waits while another transaction holds the advisory lock on the slug', async () => {
      await addSignal('sig-482-d3', '2026-10-30T09:00:00.000Z');
      const holder = await pool.connect();
      try {
        await holder.query('begin');
        await holder.query("select pg_advisory_xact_lock(hashtext('atlas.entity:' || $1))", ['coinbase']);
        let settled = false;
        const done = new PgDecisionSink(svcPool)
          .save(out('sig-482-d3', [tgt('coinbase', 'existing', 'organization', 'new_story')]))
          .then(() => { settled = true; });
        await new Promise((r) => setTimeout(r, 200));
        expect(settled).toBe(false);
        await holder.query('commit');
        await done;
        expect(settled).toBe(true);
        expect((await itemsOf('coinbase')).rows).toHaveLength(1);
      } finally {
        try { await holder.query('rollback'); } catch { /* committed above */ }
        holder.release();
      }
    });
  });

  describe('#567 pgCandidateLookup on the #566 tables', () => {
    it('typed: exact alias hits of one type, active only; anyType: cross-type exact', async () => {
      const lookup = pgCandidateLookup(svcPool);
      await pool.query("update atlas.entities set status = 'retired' where slug = 'base'");
      const typed = await lookup.typed('organization', ['COINBASE', 'base', 'unrelated words']);
      expect(typed.map((c) => c.slug)).toContain('coinbase');
      expect(typed.every((c) => c.type === 'organization')).toBe(true);
      expect((await lookup.anyType(['Base'])).map((c) => c.slug)).not.toContain('base');
      expect((await lookup.anyType(['Coinbase'])).map((c) => c.slug)).toEqual(['coinbase']);
    });

    it('event: active events with an item in the last EVENT_WINDOW_DAYS days are offered', async () => {
      await pool.query("insert into atlas.entities (slug, name, type) values ('binance-hack', 'Binance hot wallet exploit', 'event'), ('old-event', 'Old Event', 'event')");
      await pool.query(`insert into atlas.entity_items (item_key, title, summary, main_entity_id, signal_id, angle, note, occurred_at)
        select 'k-'||slug, 't', 's', id, $1, 'plain_update', 'n', case when slug = 'old-event' then now() - interval '30 days' else now() end
          from atlas.entities where slug in ('binance-hack', 'old-event')`, [KALSHI.signal_id]);
      const lookup = pgCandidateLookup(svcPool);
      await seedAliases(pool);
      expect((await lookup.typed('event', ['nothing matches'])).map((c) => c.slug)).toEqual(['binance-hack']);
      await pool.query("insert into atlas.entities (slug, name, type) values ('aa-alias-event', 'Zeta Fork', 'event')");
      await seedAliases(pool);
      // Alias hits come first, then the recent-events window.
      expect((await lookup.typed('event', ['zeta fork'])).map((c) => c.slug)).toEqual(['aa-alias-event', 'binance-hack']);
    });

    it('alias-first for every type: 10 active places, only the alias hit (France) is offered; no hit means no candidates', async () => {
      const places = ['argentina', 'australia', 'canada', 'china', 'iran', 'finland', 'japan', 'brazil', 'india', 'france'];
      for (const p of places) await pool.query("insert into atlas.entities (slug, name, type) values ($1, initcap($1), 'place')", [p]);
      await pool.query("update atlas.entities set aliases = array['French Republic'] where slug = 'france'");
      await seedAliases(pool);
      const lookup = pgCandidateLookup(svcPool);
      const phrases = ['france delays', 'france', 'budget vote'];
      expect((await lookup.typed('place', phrases)).map((c) => c.slug)).toEqual(['france']);
      expect((await lookup.typed('place', ['French Republic'])).map((c) => c.slug)).toEqual(['france']);
      expect(await lookup.typed('place', ['budget vote'])).toEqual([]);
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
