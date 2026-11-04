/**
 * #567 type-first analyst session, pure (no DB). The LLM and the decision tool are scripted; the
 * candidate lookup is an in-memory stand-in for atlas.entity_candidates(_any) (#566: active only,
 * exact on the normalized alias). Covers the #567 acceptance scenarios and the #560 folded tests.
 */
import { describe, expect, it } from 'vitest';

import { ENTITY_TYPES, type EntityType } from '@myboon/contracts';

import {
  KEEP_QUESTION,
  SHORTLIST_CAP,
  articlePhrases,
  createOllamaLlm,
  isEntityType,
  runSession,
  type Ask,
  type AskInput,
  type CandidateLookup,
  type ShortlistCandidate,
  type ChatMessage,
  type EntityMissEntry,
  type JevLogEntry,
  type Llm,
  type MatchTrace,
} from './session.js';

type Ent = { slug: string; name: string; type: EntityType; status: 'active' | 'retired'; aliases: string[] };

const norm = (v: string): string => v.toLowerCase().replace(/[^a-z0-9$]+/g, ' ').trim();

const ENTITIES: Ent[] = [
  { slug: 'bitcoin', name: 'Bitcoin', type: 'asset', status: 'active', aliases: ['BTC', 'XBT'] },
  { slug: 'xrp', name: 'XRP', type: 'asset', status: 'active', aliases: ['Ripple XRP'] },
  { slug: 'binance', name: 'Binance', type: 'organization', status: 'active', aliases: ['He Yi', 'BNB Chain'] },
  { slug: 'binance-hack', name: 'Binance hot wallet exploit', type: 'event', status: 'active', aliases: ['Binance exploit'] },
  { slug: 'digital-rmb', name: 'Digital RMB', type: 'product', status: 'active', aliases: ['e-CNY'] },
  { slug: 'stablecoins', name: 'Stablecoins', type: 'topic', status: 'active', aliases: ['stablecoin'] },
  { slug: 'usdc', name: 'USDC', type: 'asset', status: 'active', aliases: [] },
  { slug: 'usdt', name: 'USDT', type: 'asset', status: 'active', aliases: [] },
  ...['argentina', 'australia', 'canada', 'china', 'iran', 'finland', 'japan', 'brazil', 'india'].map(
    (p): Ent => ({ slug: p, name: p[0].toUpperCase() + p.slice(1), type: 'place', status: 'active', aliases: [] })),
  { slug: 'france', name: 'France', type: 'place', status: 'active', aliases: ['French Republic'] },
  { slug: 'old-kalshi', name: 'Kalshi Inc', type: 'organization', status: 'retired', aliases: ['Kalshi'] },
];

/** In-memory shortlist with the #567 contract: alias hits of the types first, then fill by item count, active only. */
function memLookup(entities: Ent[] = ENTITIES, items: Record<string, number> = {}): CandidateLookup & { calls: string[][] } {
  const calls: string[][] = [];
  const hit = (e: Ent, names: string[]): boolean => {
    const wanted = new Set(names.map(norm));
    return [e.name, ...e.aliases].some((a) => wanted.has(norm(a)));
  };
  const out = (e: Ent, aliasHit: boolean): ShortlistCandidate => ({
    id: `id-${e.slug}`, slug: e.slug, name: e.name, type: e.type, aliases: e.aliases, summary: `${e.name} summary.`, alias_hit: aliasHit, item_count: items[e.slug] ?? 0,
  });
  return {
    calls,
    async shortlist(types, names, cap) {
      calls.push(types);
      const pool = entities.filter((e) => e.status === 'active' && types.includes(e.type));
      const hits = pool.filter((e) => hit(e, names)).map((e) => out(e, true));
      const fill = pool.filter((e) => !hit(e, names)).map((e) => out(e, false)).sort((a, b) => b.item_count - a.item_count);
      return [...hits, ...fill.slice(0, Math.max(0, cap - hits.length))];
    },
  };
}

function scriptedLlm(replies: unknown[]): Llm & { calls: ChatMessage[][] } {
  const calls: ChatMessage[][] = [];
  const llm = (async (messages: ChatMessage[]) => {
    calls.push(messages.map((m) => ({ ...m })));
    const next = replies[calls.length - 1];
    if (next === undefined) throw new Error(`unscripted LLM turn ${calls.length}`);
    return typeof next === 'string' ? next : JSON.stringify(next);
  }) as Llm & { calls: ChatMessage[][] };
  llm.calls = calls;
  return llm;
}

/** Scripted decision tool: keep, the pick (by main subject; default the first choice), angle (default plain_update). */
function scriptedAsk(o: { keep?: string; pick?: Record<string, string>; angle?: string }): Ask & { asked: AskInput[] } {
  const asked: AskInput[] = [];
  const ask = (async (input: AskInput) => {
    asked.push(input);
    const answer = (choice: string) => ({ choice, probabilities: { [choice]: 0.9 }, provider: 'jev' as const });
    if (input.choices.includes('keep')) return answer(o.keep ?? 'keep');
    if (input.choices.includes('new_story')) return answer(o.angle ?? 'plain_update');
    const name = input.question.match(/main subject of this article is "([^"]+)"/)?.[1] ?? '';
    return answer(o.pick?.[name] ?? input.choices[0]);
  }) as Ask & { asked: AskInput[] };
  ask.asked = asked;
  return ask;
}

const turn1 = (mentions: unknown[], extra: Record<string, unknown> = {}) => ({ headline: 'H', summary: 'S.', mentions, ...extra });
const kept = (mentions: unknown[]) => scriptedLlm([turn1(mentions), { reasoning: 'r' }, { note: 'n', reason: 'why' }]);
const sig = (text: string) => ({ signal_id: 'sig-1', text });

const isPick = (a: AskInput): boolean => a.question.includes('main subject of this article');
const m = (name: string, types: [EntityType, EntityType], o: { main?: boolean; search_terms?: string[] } = {}) =>
  ({ name, types, main: o.main ?? false, search_terms: o.search_terms ?? [] });

describe('#567 shortlist matching (scripted LLM + decision tool, in-memory shortlist)', () => {
  it('BTC and Bitcoin map to the bitcoin asset with one pick call; alias hits lead the shortlist', async () => {
    const ask = scriptedAsk({});
    const traces: MatchTrace[] = [];
    const out = await runSession(sig('BTC tops $100k as Bitcoin ETFs see inflows'), {
      llm: kept([m('Bitcoin', ['asset', 'topic'], { main: true, search_terms: ['BTC'] })]), ask, lookup: memLookup(), trace: (t) => traces.push(t),
    });
    expect(out.targets).toEqual([{ entity: 'bitcoin', kind: 'existing', type: 'asset', angle: 'plain_update', note: 'n' }]);
    expect(ask.asked.filter(isPick)).toHaveLength(1);
    expect(traces[0]).toMatchObject({ main_subject: 'Bitcoin', types: ['asset', 'topic'], alias_hits: ['bitcoin'], pick: { slug: 'bitcoin' } });
    expect(traces[0].shortlist[0]).toBe('bitcoin');
  });

  it('the pick call gets the article, the main subject and the full shortlist with id, aliases and summary', async () => {
    const ask = scriptedAsk({});
    await runSession(sig('Binance exploit drains hot wallet'), {
      llm: kept([m('Binance', ['organization', 'event']), m('Binance exploit', ['event', 'topic'], { main: true })]), ask, lookup: memLookup(),
    });
    const pick = ask.asked.find(isPick)!;
    expect(pick.question).toContain('"Binance exploit"');
    expect(pick.state).toMatchObject({ main_subject: 'Binance exploit', article: { headline: 'H', text: 'Binance exploit drains hot wallet' } });
    const shortlist = (pick.state as { shortlist: { id: string; aliases: string[]; summary: string }[] }).shortlist;
    expect(shortlist[0]).toMatchObject({ id: expect.any(String), aliases: expect.any(Array), summary: expect.any(String) });
    expect(pick.choices.at(-1)).toBe('none');
    expect(pick.choices).toContain('binance-hack');
  });

  it('one shortlist over every mentioned type, main subject types first, built once', async () => {
    const lookup = memLookup();
    await runSession(sig('x'), {
      llm: kept([m('XRP', ['asset', 'protocol']), m('Binance', ['organization', 'person'], { main: true })]), ask: scriptedAsk({}), lookup,
    });
    expect(lookup.calls).toEqual([['organization', 'person', 'asset', 'protocol']]);
  });

  it('alias hits are always kept and the fill is by item count, capped at SHORTLIST_CAP', async () => {
    const many: Ent[] = Array.from({ length: 60 }, (_, i) => ({ slug: `p-${i}`, name: `P ${i}`, type: 'place' as const, status: 'active' as const, aliases: [] }));
    const items = Object.fromEntries(many.map((e, i) => [e.slug, i]));
    const traces: MatchTrace[] = [];
    await runSession(sig('France delays budget vote again'), {
      llm: kept([m('France', ['place', 'regulation'], { main: true })]), ask: scriptedAsk({}),
      lookup: memLookup([...many, ...ENTITIES], items), trace: (t) => traces.push(t),
    });
    expect(traces[0].alias_hits).toEqual(['france']);
    expect(traces[0].shortlist[0]).toBe('france');
    expect(traces[0].shortlist).toHaveLength(SHORTLIST_CAP);
    expect(traces[0].shortlist[1]).toBe('p-59'); // most active first
  });

  it('France is found by its alias among more than 8 active places', async () => {
    const out = await runSession(sig('France delays budget vote again'), {
      llm: kept([m('France', ['place', 'regulation'], { main: true })]), ask: scriptedAsk({}), lookup: memLookup(),
    });
    expect(out.targets.map((t) => t.entity)).toEqual(['france']);
  });

  it('stablecoins: asset then topic in one shortlist, so the topic entity is on it and can be picked', async () => {
    const ask = scriptedAsk({ pick: { Stablecoins: 'stablecoins' } });
    const out = await runSession(sig('Stablecoin tax pending'), {
      llm: kept([m('Stablecoins', ['asset', 'topic'], { main: true, search_terms: ['stablecoin'] })]), ask, lookup: memLookup(),
    });
    expect(ask.asked.find(isPick)!.choices).toEqual(expect.arrayContaining(['stablecoins', 'usdc', 'usdt', 'none']));
    expect(out.targets.map((t) => t.entity)).toEqual(['stablecoins']);
  });

  it('none: entity_miss is logged with the shortlist size and alias hits, nothing is routed', async () => {
    const misses: EntityMissEntry[] = [];
    const out = await runSession(sig('Bitcoin'), {
      llm: kept([m('Bitcoin', ['asset', 'topic'], { main: true })]), ask: scriptedAsk({ pick: { Bitcoin: 'none' } }), lookup: memLookup(), missLog: (e) => misses.push(e),
    });
    expect(out).toMatchObject({ decision: 'keep', targets: [] });
    expect(misses).toEqual([expect.objectContaining({ event: 'entity_miss', main_subject: 'Bitcoin', types: ['asset', 'topic'], alias_hits: ['bitcoin'] })]);
  });

  it('an empty shortlist makes no pick call and logs entity_miss', async () => {
    const ask = scriptedAsk({});
    const misses: EntityMissEntry[] = [];
    await runSession(sig('Zorblax'), { llm: kept([m('Zorblax', ['protocol', 'product'], { main: true })]), ask, lookup: memLookup([]), missLog: (e) => misses.push(e) });
    expect(ask.asked.filter(isPick)).toHaveLength(0);
    expect(misses[0]).toMatchObject({ shortlist_size: 0 });
  });

  it('a pick outside the shortlist (an invented slug) counts as none: no target, never a new entity', async () => {
    const misses: EntityMissEntry[] = [];
    const out = await runSession(sig('Bitcoin'), {
      llm: kept([m('Bitcoin', ['asset', 'topic'], { main: true })]), ask: scriptedAsk({ pick: { Bitcoin: 'bitcoin-new' } }), lookup: memLookup(), missLog: (e) => misses.push(e),
    });
    expect(out.targets).toEqual([]);
    expect(misses).toHaveLength(1);
  });

  it('#560: 3 mentions still give exactly one main entity, the marked main subject (XRP case)', async () => {
    const ask = scriptedAsk({ pick: { XRP: 'xrp' } });
    const out = await runSession(sig('XRP rallies as Binance lists Bitcoin pairs'), {
      llm: kept([m('Binance', ['organization', 'person']), m('XRP', ['asset', 'protocol'], { main: true }), m('Bitcoin', ['asset', 'topic'])]), ask, lookup: memLookup(),
    });
    expect(out.targets.map((t) => t.entity)).toEqual(['xrp']);
    expect(ask.asked.filter(isPick)).toHaveLength(1);
  });

  it('no mention marked main: the first mention is the main subject', async () => {
    const ask = scriptedAsk({});
    await runSession(sig('x'), { llm: kept([m('Digital RMB', ['product', 'asset']), m('China', ['place', 'organization'])]), ask, lookup: memLookup() });
    expect(ask.asked.find(isPick)!.question).toContain('"Digital RMB"');
  });

  it('#560: the Digital RMB signal gives one item on the existing product', async () => {
    const out = await runSession(sig('China expands e-CNY'), {
      llm: kept([m('Digital RMB', ['product', 'asset'], { main: true, search_terms: ['e-CNY'] }), m('China', ['place', 'organization'])]),
      ask: scriptedAsk({ pick: { 'Digital RMB': 'digital-rmb' } }), lookup: memLookup(),
    });
    expect(out.targets.map((t) => t.entity)).toEqual(['digital-rmb']);
  });

  it('#560: active-only: a retired entity is never on the shortlist', async () => {
    const ask = scriptedAsk({});
    await runSession(sig('Kalshi raises'), { llm: kept([m('Kalshi', ['organization', 'product'], { main: true })]), ask, lookup: memLookup(), missLog: () => {} });
    expect(ask.asked.flatMap((a) => a.choices)).not.toContain('old-kalshi');
  });

  it('#560: ignore writes nothing and builds no shortlist', async () => {
    const lookup = memLookup();
    const out = await runSession(sig('meh'), {
      llm: scriptedLlm([turn1([m('Bitcoin', ['asset', 'topic'])]), { reason: 'noise' }]), ask: scriptedAsk({ keep: 'ignore' }), lookup,
    });
    expect(out).toMatchObject({ decision: 'ignore', reason: 'noise', targets: [] });
    expect(lookup.calls).toEqual([]);
  });

  it('mentions are validated with zod: exactly 2 distinct types; bad rows are dropped', async () => {
    const lookup = memLookup();
    await runSession(sig('BTC'), {
      llm: kept([{ name: 'Foo', types: ['asset'] }, { name: 'Bar', types: ['asset', 'asset'] }, { name: 'Baz', types: ['jurisdiction', 'asset'] }, m('Bitcoin', ['asset', 'topic'])]),
      ask: scriptedAsk({}), lookup,
    });
    expect(lookup.calls).toEqual([['asset', 'topic']]);
  });

  it('turn 1 asks for exactly 2 types and a main flag; the keep question is the fixed wording', async () => {
    const llm = kept([m('Bitcoin', ['asset', 'topic'])]);
    const ask = scriptedAsk({});
    await runSession(sig('BTC'), { llm, ask, lookup: memLookup() });
    expect(llm.calls[0][1].content).toContain('exactly 2 entity types');
    expect(llm.calls[0][1].content).toContain('"main": boolean');
    expect(ask.asked[0].question).toContain(KEEP_QUESTION);
  });

  it('prose replies to the reasoning and note steps do not fail the signal; the prose becomes the note', async () => {
    const out = await runSession(sig('BTC'), {
      llm: scriptedLlm([turn1([m('Bitcoin', ['asset', 'topic'])]), 'This continues a story.', 'note: HYPE tests support.']),
      ask: scriptedAsk({}), lookup: memLookup(),
    });
    expect(out.targets[0]).toMatchObject({ entity: 'bitcoin', note: 'note: HYPE tests support.' });
  });

  it('every decision-tool call is logged', async () => {
    const logs: JevLogEntry[] = [];
    await runSession(sig('BTC'), { llm: kept([m('Bitcoin', ['asset', 'topic'])]), ask: scriptedAsk({}), lookup: memLookup(), log: (e) => logs.push(e) });
    expect(logs.map((l) => l.answer)).toEqual(['keep', 'bitcoin', 'plain_update']);
  });

  it('articlePhrases gives 1-3 word windows, lowercased, punctuation stripped', () => {
    const p = articlePhrases('Binance exploit: hot-wallet, $BTC!');
    expect(p).toEqual(expect.arrayContaining(['binance', 'binance exploit', 'binance exploit hot-wallet', '$btc']));
  });
});

describe('#504 helpers', () => {
  it('isEntityType is strict: only the nine entity types after trim + lowercase, no synonyms', () => {
    for (const t of ENTITY_TYPES) expect(isEntityType(t)).toBe(true);
    expect(isEntityType(' Organization ')).toBe(true);
    expect(isEntityType('jurisdiction')).toBe(false);
    expect(isEntityType('sector')).toBe(false);
    expect(isEntityType('media_account')).toBe(false);
    expect(isEntityType('')).toBe(false);
  });

  it('the Ollama LLM client sends temperature 0 and never puts the key in errors', async () => {
    const bodies: unknown[] = [];
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)));
      return new Response(JSON.stringify({ choices: [{ message: { content: '{"ok":true}' } }] }), { status: 200 });
    }) as unknown as typeof fetch;
    const llm = createOllamaLlm({ apiKey: 'sk-secret', model: 'glm-5.3-flash', fetchImpl });
    expect(await llm([{ role: 'user', content: 'hi' }])).toBe('{"ok":true}');
    expect(bodies[0]).toMatchObject({ model: 'glm-5.3-flash', temperature: 0 });
    const failing = createOllamaLlm({ apiKey: 'sk-secret', model: 'm', fetchImpl: (async () => new Response('bad sk-secret', { status: 500 })) as unknown as typeof fetch });
    await expect(failing([{ role: 'user', content: 'x' }])).rejects.toThrow(/500/);
    await failing([{ role: 'user', content: 'x' }]).catch((e: Error) => expect(e.message).not.toContain('sk-secret'));
  });

  it('the Ollama LLM client aborts a hung fetch after timeoutMs and fails like any other call (Refs #512, found in #516 review)', async () => {
    let signal: AbortSignal | undefined;
    const hang = (async (_url: string, init: RequestInit) => {
      signal = init.signal ?? undefined;
      return new Promise<Response>((_, reject) => init.signal?.addEventListener('abort', () => reject(init.signal?.reason)));
    }) as unknown as typeof fetch;
    const llm = createOllamaLlm({ apiKey: 'sk-secret', model: 'm', fetchImpl: hang, timeoutMs: 50 });
    const started = Date.now();
    const err = await llm([{ role: 'user', content: 'x' }]).then(() => null, (e: Error) => e);
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(err).toBeInstanceOf(Error);
    expect(err?.message).toMatch(/LLM timed out after 50ms/);
    expect(err?.message).not.toContain('sk-secret');
    expect(Date.now() - started).toBeLessThan(2_000);
  });
});
