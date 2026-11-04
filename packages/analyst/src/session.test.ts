/**
 * #567 type-first analyst session, pure (no DB). The LLM and the decision tool are scripted; the
 * candidate lookup is an in-memory stand-in for atlas.entity_candidates(_any) (#566: active only,
 * exact on the normalized alias). Covers the #567 acceptance scenarios and the #560 folded tests.
 */
import { describe, expect, it } from 'vitest';

import { ENTITY_TYPES, type EntityType } from '@myboon/contracts';

import {
  KEEP_QUESTION,
  articlePhrases,
  createOllamaLlm,
  isEntityType,
  runSession,
  type Ask,
  type AskInput,
  type Candidate,
  type CandidateLookup,
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

/** In-memory lookup with the #566 contract; records every call. */
function memLookup(entities: Ent[] = ENTITIES): CandidateLookup & { calls: string[] } {
  const calls: string[] = [];
  const hit = (e: Ent, names: string[]): boolean => {
    const wanted = new Set(names.map(norm));
    return e.status === 'active' && [e.name, e.slug.replaceAll('-', ' '), ...e.aliases].some((a) => wanted.has(norm(a)));
  };
  const out = (e: Ent): Candidate => ({ slug: e.slug, name: e.name, type: e.type });
  return {
    calls,
    async typed(type, names) {
      calls.push(`typed:${type}`);
      return entities.filter((e) => e.type === type && hit(e, names)).map(out);
    },
    async anyType(names) {
      calls.push('any');
      return entities.filter((e) => hit(e, names)).map(out);
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

/** Scripted decision tool: keep, type and pick answers by mention; angle defaults to plain_update. */
function scriptedAsk(o: { keep?: string; type?: Record<string, string>; pick?: Record<string, string>; angle?: string }): Ask & { asked: AskInput[] } {
  const asked: AskInput[] = [];
  const ask = (async (input: AskInput) => {
    asked.push(input);
    const answer = (choice: string) => ({ choice, probabilities: { [choice]: 0.9 }, provider: 'jev' as const });
    if (input.choices.includes('keep')) return answer(o.keep ?? 'keep');
    if (input.choices.includes('new_story')) return answer(o.angle ?? 'plain_update');
    const name = input.question.match(/touches "([^"]+)"/)?.[1] ?? '';
    if (input.question.includes('Which kind of entity')) return answer(o.type?.[name] ?? input.choices[0]);
    return answer(o.pick?.[name] ?? input.choices[0]);
  }) as Ask & { asked: AskInput[] };
  ask.asked = asked;
  return ask;
}

const turn1 = (mentions: unknown[], extra: Record<string, unknown> = {}) => ({ headline: 'H', summary: 'S.', mentions, ...extra });
const kept = (mentions: unknown[]) => scriptedLlm([turn1(mentions), { reasoning: 'r' }, { note: 'n', reason: 'why' }]);
const sig = (text: string) => ({ signal_id: 'sig-1', text });

describe('#567 type-first matching (scripted LLM + decision tool, in-memory #566 lookup)', () => {
  it('BTC and Bitcoin map to the bitcoin asset; the type is obvious so no decision call runs', async () => {
    const ask = scriptedAsk({});
    const traces: MatchTrace[] = [];
    const out = await runSession(sig('BTC tops $100k as Bitcoin ETFs see inflows'), {
      llm: kept([{ name: 'Bitcoin', types: ['asset', 'topic'], search_terms: ['BTC'] }]), ask, lookup: memLookup(), trace: (t) => traces.push(t),
    });
    expect(out.targets).toEqual([{ entity: 'bitcoin', kind: 'existing', type: 'asset', angle: 'plain_update', note: 'n' }]);
    expect(ask.asked.some((a) => a.question.includes('Which kind of entity'))).toBe(false);
    expect(traces[0]).toMatchObject({ type_decision: 'obvious', chosen_type: 'asset', pick: { slug: 'bitcoin' } });
  });

  it('a Binance exploit article matches the existing Binance-hack event, not a new one', async () => {
    const out = await runSession(sig('Binance exploit drains hot wallet'), {
      llm: kept([{ name: 'Binance exploit', types: ['event'], search_terms: [] }]), ask: scriptedAsk({}), lookup: memLookup(),
    });
    expect(out.targets.map((t) => t.entity)).toEqual(['binance-hack']);
  });

  it('a mention with no candidate in either type logs entity_miss and routes nothing', async () => {
    const misses: EntityMissEntry[] = [];
    const lookup = memLookup();
    const out = await runSession(sig('Zorblax launches'), {
      llm: kept([{ name: 'Zorblax', types: ['protocol', 'product', 'organization'], search_terms: [] }]),
      ask: scriptedAsk({ type: { Zorblax: 'product' } }), lookup, missLog: (e) => misses.push(e),
    });
    expect(out.decision).toBe('keep');
    expect(out.targets).toEqual([]);
    expect(misses).toEqual([{
      event: 'entity_miss', signal_id: 'sig-1', mention: 'Zorblax', types: ['protocol', 'product', 'organization'],
      types_tried: ['product', 'protocol'], candidate_count: 0, fallback_tried: true, fallback_candidate_count: 0,
    }]);
    // Top type probed for obviousness, chosen type, one retry, then the cross-type fallback; never the third type.
    expect(lookup.calls).toEqual(['typed:protocol', 'typed:product', 'any']);
  });

  it('an ambiguous mention runs the decision call and retries the second type at most once', async () => {
    const ask = scriptedAsk({ type: { 'Digital RMB': 'protocol' } });
    const lookup = memLookup();
    const out = await runSession(sig('Digital RMB pilot expands'), {
      llm: kept([{ name: 'Digital RMB', types: ['regulation', 'protocol', 'product'], search_terms: [] }]), ask, lookup, missLog: () => {},
    });
    expect(ask.asked.filter((a) => a.question.includes('Which kind of entity'))).toHaveLength(1);
    // protocol (chosen) missed, regulation (2nd) missed, so the cross-type exact fallback finds the product.
    expect(lookup.calls).toEqual(['typed:regulation', 'typed:protocol', 'any']);
    expect(out.targets.map((t) => t.entity)).toEqual(['digital-rmb']);
  });

  it('the cross-type fallback runs only after both typed tries miss (He Yi -> binance)', async () => {
    const lookup = memLookup();
    const out = await runSession(sig('He Yi comments'), {
      llm: kept([{ name: 'He Yi', types: ['person'], search_terms: [] }]), ask: scriptedAsk({}), lookup,
    });
    expect(lookup.calls).toEqual(['typed:person', 'any']);
    expect(out.targets.map((t) => t.entity)).toEqual(['binance']);
  });

  it('the pick is a closed choice of candidate slugs plus none; none on every try is a miss', async () => {
    const ask = scriptedAsk({ pick: { Bitcoin: 'none' } });
    const misses: EntityMissEntry[] = [];
    const out = await runSession(sig('Bitcoin'), {
      llm: kept([{ name: 'Bitcoin', types: ['asset'], search_terms: [] }]), ask, lookup: memLookup(), missLog: (e) => misses.push(e),
    });
    const picks = ask.asked.filter((a) => a.question.includes('Answer one slug'));
    expect(picks[0].choices).toEqual(['bitcoin', 'none']);
    expect(out.targets).toEqual([]);
    expect(misses).toHaveLength(1);
  });

  it('a pick outside the offered slugs (an invented name) makes the signal unclear, never a new entity', async () => {
    const out = await runSession(sig('Bitcoin'), {
      llm: scriptedLlm([turn1([{ name: 'Bitcoin', types: ['asset'], search_terms: [] }])]),
      ask: scriptedAsk({ pick: { Bitcoin: 'bitcoin-new' } }), lookup: memLookup(),
    });
    expect(out.decision).toBe('unclear');
    expect(out.targets).toEqual([]);
  });

  it('#560: a signal with 3 mentions still yields exactly one main entity (XRP case)', async () => {
    const ask = scriptedAsk({});
    const out = await runSession(sig('XRP rallies as Binance lists Bitcoin pairs'), {
      llm: kept([
        { name: 'XRP', types: ['asset'], search_terms: [] },
        { name: 'Binance', types: ['organization'], search_terms: [] },
        { name: 'Bitcoin', types: ['asset'], search_terms: [] },
      ]), ask, lookup: memLookup(),
    });
    expect(out.targets).toHaveLength(1);
    expect(out.targets[0].entity).toBe('xrp');
    // The first match wins; later mentions are not looked up at all.
    expect(ask.asked.filter((a) => a.question.includes('Answer one slug'))).toHaveLength(1);
  });

  it('#560: the Digital RMB signal gives one item on the existing product', async () => {
    const out = await runSession(sig('China expands e-CNY'), {
      llm: kept([{ name: 'Digital RMB', types: ['product'], search_terms: ['e-CNY'] }, { name: 'China', types: ['place'], search_terms: [] }]),
      ask: scriptedAsk({}), lookup: memLookup(), missLog: () => {},
    });
    expect(out.targets.map((t) => t.entity)).toEqual(['digital-rmb']);
  });

  it('#560: active-only candidates: a retired entity alias is never offered', async () => {
    const misses: EntityMissEntry[] = [];
    const ask = scriptedAsk({});
    const out = await runSession(sig('Kalshi raises'), {
      llm: kept([{ name: 'Kalshi', types: ['organization'], search_terms: [] }]), ask, lookup: memLookup(), missLog: (e) => misses.push(e),
    });
    expect(ask.asked.flatMap((a) => a.shortlist).map((c) => c.slug)).not.toContain('old-kalshi');
    expect(out.targets).toEqual([]);
    expect(misses).toHaveLength(1);
  });

  it('#560: ignore still writes nothing and makes no lookup', async () => {
    const lookup = memLookup();
    const out = await runSession(sig('meh'), {
      llm: scriptedLlm([turn1([{ name: 'Bitcoin', types: ['asset'], search_terms: [] }]), { reason: 'noise' }]),
      ask: scriptedAsk({ keep: 'ignore' }), lookup,
    });
    expect(out).toMatchObject({ decision: 'ignore', reason: 'noise', targets: [] });
    expect(lookup.calls).toEqual([]);
  });

  it('mentions are validated with zod: bad types are dropped, an old single "type" still parses', async () => {
    const lookup = memLookup();
    const out = await runSession(sig('BTC'), {
      llm: kept([{ name: 'Foo', types: ['jurisdiction'] }, { name: '', types: ['asset'] }, { name: 'Bitcoin', type: 'Asset' }]),
      ask: scriptedAsk({}), lookup,
    });
    expect(out.targets.map((t) => t.entity)).toEqual(['bitcoin']);
    expect(lookup.calls).toEqual(['typed:asset']);
  });

  it('turn 1 asks for top types per mention, main first; the keep question is the fixed wording', async () => {
    const llm = kept([{ name: 'Bitcoin', types: ['asset'], search_terms: [] }]);
    const ask = scriptedAsk({});
    await runSession(sig('BTC'), { llm, ask, lookup: memLookup() });
    expect(llm.calls[0][1].content).toContain('"types": [');
    expect(llm.calls[0][1].content).toContain('the main one first');
    expect(ask.asked[0].question).toContain(KEEP_QUESTION);
  });

  it('every decision-tool call is logged', async () => {
    const logs: JevLogEntry[] = [];
    await runSession(sig('BTC'), { llm: kept([{ name: 'Bitcoin', types: ['asset'], search_terms: [] }]), ask: scriptedAsk({}), lookup: memLookup(), log: (e) => logs.push(e) });
    expect(logs.map((l) => l.answer)).toEqual(['keep', 'bitcoin', 'plain_update']);
  });

  it('a prose reasoning reply (no JSON) does not fail the signal; it is used as context', async () => {
    const out = await runSession(sig('BTC'), {
      llm: scriptedLlm([turn1([{ name: 'Bitcoin', types: ['asset'], search_terms: [] }]), 'This continues a story.', { note: 'n', reason: 'r' }]),
      ask: scriptedAsk({}), lookup: memLookup(),
    });
    expect(out.targets.map((t) => t.entity)).toEqual(['bitcoin']);
  });

  it('alias-first: France is found by its alias among more than 8 active places; only it is offered', async () => {
    const ask = scriptedAsk({});
    const out = await runSession(sig('France delays budget vote again'), {
      llm: kept([{ name: 'France', types: ['place'], search_terms: [] }]), ask, lookup: memLookup(),
    });
    const offered = ask.asked.filter((a) => a.question.includes('Answer one slug'))[0].choices;
    expect(offered).toEqual(['france', 'none']);
    expect(out.targets.map((t) => t.entity)).toEqual(['france']);
  });

  it('stablecoins: asset offers only USDC/USDT, the decision says none, the retry with topic finds stablecoins', async () => {
    const lookup = memLookup();
    const ask = scriptedAsk({});
    const realAsk: typeof ask = Object.assign(async (input: AskInput) => {
      if (input.question.includes('Answer one slug') && input.choices.includes('usdc')) {
        ask.asked.push(input);
        return { choice: 'none', probabilities: { none: 0.9 }, provider: 'jev' as const };
      }
      return ask(input);
    }, { asked: ask.asked });
    const traces: MatchTrace[] = [];
    const out = await runSession(sig('Stablecoins USDC USDT tax pending'), {
      llm: kept([{ name: 'Stablecoins', types: ['asset', 'topic'], search_terms: ['USDC', 'USDT'] }]), ask: realAsk, lookup, trace: (t) => traces.push(t),
    });
    expect(lookup.calls).toEqual(['typed:asset', 'typed:topic']);
    expect(traces[0].tries.map((t) => [t.type, t.pick])).toEqual([['asset', null], ['topic', 'stablecoins']]);
    expect(out.targets.map((t) => t.entity)).toEqual(['stablecoins']);
  });

  it('turn 1 asks for 2-3 types whenever the type is not certain', async () => {
    const llm = kept([{ name: 'Bitcoin', types: ['asset'], search_terms: [] }]);
    await runSession(sig('BTC'), { llm, ask: scriptedAsk({}), lookup: memLookup() });
    expect(llm.calls[0][1].content).toContain('give 2 or 3');
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
