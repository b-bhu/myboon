/**
 * #504 D36 analyst session, pure (no DB). The LLM and Jev are scripted; the entity search runs over the spike's
 * read-only shelves snapshot subset. Scenarios from the issue's acceptance list.
 */
import { describe, expect, it } from 'vitest';

import { SHELF_TYPES } from '@myboon/contracts';

import {
  KEEP_QUESTION,
  SYSTEM_PROMPT,
  canonicalSlug,
  createOllamaLlm,
  isShelfType,
  runSession,
  searchShelves,
  type Ask,
  type AskInput,
  type ChatMessage,
  type JevLogEntry,
  type Llm,
} from './session.js';
import { spikeCases, spikeShelves } from './test-fixtures/d36-spike.js';

type Mention = { name: string; type: string; search_terms: string[] };

/** Scripted LLM: replays JSON replies in order and records every message list it was sent. */
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

/** Scripted Jev: answers by question kind and mention name; records every question. */
function scriptedJev(o: { keep: string; existence?: Record<string, string>; angle?: Record<string, string> }): Ask & { asked: AskInput[] } {
  const asked: AskInput[] = [];
  const ask = (async (input: AskInput) => {
    asked.push(input);
    const answer = (choice: string) => ({ choice, probabilities: { [choice]: 0.9 }, provider: 'jev' as const });
    if (input.choices.includes('keep')) return answer(o.keep);
    const name = Object.keys({ ...o.existence, ...o.angle }).find((n) => input.question.includes(`"${n}"`));
    if (!name) throw new Error(`unscripted Jev question: ${input.question}`);
    if (input.choices.includes('new_story')) return answer(o.angle?.[name] ?? 'plain_update');
    return answer(o.existence?.[name] ?? 'not_related');
  }) as Ask & { asked: AskInput[] };
  ask.asked = asked;
  return ask;
}

const search = async (terms: string[]) => searchShelves(terms, spikeShelves);

/** Per spike case: the mentions the scripted LLM lists (names from the v5 Jev questions, search terms scripted). */
const MENTIONS: Record<string, Mention[]> = {
  'test-standuquesne-2115777839622689036': [
    { name: 'trade.xyz', type: 'protocol', search_terms: ['Trade.XYZ', 'trade(xyz)'] },
    { name: 'Intercontinental Exchange (ICE)', type: 'organization', search_terms: ['ICE'] },
    { name: 'Hyperliquid', type: 'protocol', search_terms: ['HYPE'] },
  ],
  '05d904405cc85501c44bd32ba7744b3217665245b7cf3431ed451af28f5b5b72': [
    { name: 'Base', type: 'protocol', search_terms: [] },
    { name: 'Coinbase', type: 'organization', search_terms: ['Base'] },
    { name: 'Tokenized stocks', type: 'topic', search_terms: ['Tokenization of real-world assets'] },
  ],
  '3bed46f7813adab73db18d8e45a9e143bafd080b901f80cd064565821cc9233a': [
    { name: 'Elon Musk', type: 'person', search_terms: [] },
    { name: 'Stanley Druckenmiller', type: 'person', search_terms: ['Druckenmiller'] },
    { name: 'Hyperliquid', type: 'protocol', search_terms: [] },
  ],
  '0d4c3fb8ff4265b631a4859cf5594055e100972b1d336776aed0d11abff2a81b': [
    { name: 'Solana', type: 'asset', search_terms: [] },
    { name: 'Real-World Assets (RWA) on Solana', type: 'topic', search_terms: ['Tokenization of real-world assets'] },
  ],
  '9b5c85c270f40b67a668a9ad1a8247d6452f56ad2f5cf57ff0fc90efcfa05410': [
    { name: 'Tokenized stocks', type: 'topic', search_terms: ['Tokenization of real-world assets'] },
    { name: 'Jersey', type: 'jurisdiction', search_terms: [] },
    { name: 'ADGM (Abu Dhabi Global Market)', type: 'jurisdiction', search_terms: [] },
  ],
  'f89d45bbd398a54e02a11569426a5c7b171205d46823b41afbfe60fb027cd563': [
    { name: 'Kalshi', type: 'organization', search_terms: [] },
  ],
};

/** Jev's v5 answers keyed by mention name (the v5 questions name the mention; ADGM was asked as "ADGM"). */
function jevFromV5(c: (typeof spikeCases)[number]) {
  const existence: Record<string, string> = {};
  const angle: Record<string, string> = {};
  const mentions = MENTIONS[c.signal.signal_id];
  for (const j of c.v5.jev) {
    if (j.choices.includes('keep')) continue;
    const m = mentions.find((x) => j.question.includes(`"${x.name}"`) || x.name.startsWith(j.question.match(/"([^"]+)"/)?.[1] ?? '\u0000'));
    if (!m) throw new Error(`fixture: no mention for ${j.question}`);
    if (j.choices.includes('new_story')) angle[m.name] = j.answer;
    else existence[m.name] = j.answer;
  }
  return { keep: 'keep', existence, angle };
}

/** The four scripted LLM turns for a keep path; the LLM's own angle is deliberately wrong. */
function keepReplies(summary: string, mentions: Mention[], kept: { name: string; type: string; note: string }[]) {
  return [
    { summary, mentions },
    { reasoning: kept.map((k) => ({ mention: k.name, reasoning: `What this means for ${k.name}.` })) },
    { targets: kept.map((k) => ({ mention: k.name, type: k.type, note: k.note, angle: 'new_story', entity: 'llm-made-this-up' })), reason: 'Routed per the decision tool.' },
  ];
}

describe('#504 D36 analyst session (scripted LLM + Jev)', () => {
  for (const c of spikeCases) {
    it(`spike signal ${c.signal.signal_id.slice(0, 12)}: output matches the v5 decision, targets, kinds and angles`, async () => {
      const mentions = MENTIONS[c.signal.signal_id];
      const jev = jevFromV5(c);
      const kept = mentions.filter((m) => jev.existence[m.name] !== 'not_related')
        .map((m) => ({ name: m.name, type: c.v5.targets.find((t) => t.entity === canonicalSlug(m.name))?.type ?? m.type, note: `Note on ${m.name}.` }));
      const llm = scriptedLlm(keepReplies(c.v5.summary, mentions, kept));
      const out = await runSession(c.signal, { llm, ask: scriptedJev(jev), search });
      expect(out.decision).toBe(c.v5.decision);
      // Strict type rules: an existing target carries the shelf's own type; a kept new target with a
      // non-shelf type is dropped like not_related (the v5 fixtures classed Jersey/ADGM 'jurisdiction').
      const want = c.v5.targets.flatMap((t): { entity: string; kind: 'existing' | 'new'; type: string; angle: string }[] => {
        if (t.kind === 'existing') return [{ entity: t.entity, kind: t.kind, type: spikeShelves.find((s) => s.slug === t.entity)?.type ?? t.type, angle: t.angle }];
        return isShelfType(t.type) ? [{ entity: t.entity, kind: t.kind, type: t.type, angle: t.angle }] : [];
      });
      expect(out.targets.map(({ entity, kind, type, angle }) => ({ entity, kind, type, angle }))).toEqual(want);
      expect(out.signal_id).toBe(c.signal.signal_id);
      expect(out.summary).toBe(c.v5.summary);
    });
  }

  it('Jev says ignore: decision ignore with a reason and no targets; only the keep question is asked', async () => {
    const c = spikeCases[0];
    const llm = scriptedLlm([{ summary: 'S', mentions: MENTIONS[c.signal.signal_id] }, { reason: 'Nobody would care.' }]);
    const jev = scriptedJev({ keep: 'ignore' });
    const out = await runSession(c.signal, { llm, ask: jev, search });
    expect(out).toMatchObject({ decision: 'ignore', reason: 'Nobody would care.', targets: [] });
    expect(jev.asked).toHaveLength(1);
    expect(jev.asked[0].choices).toEqual(['keep', 'ignore']);
    expect(jev.asked[0].question).toContain(KEEP_QUESTION);
  });

  it('the keep question is the fixed D36 wording', () => {
    expect(KEEP_QUESTION).toBe('Would a crypto trader or market watcher care about this, even if it is only talk for now?');
  });

  it('no entity candidates for a mention: Jev is only offered new / not_related', async () => {
    const c = spikeCases[4];
    const mentions = MENTIONS[c.signal.signal_id];
    const jev = scriptedJev(jevFromV5(c));
    const llm = scriptedLlm(keepReplies('S', mentions, [
      { name: 'Tokenized stocks', type: 'topic', note: 'n' }, { name: 'Jersey', type: 'jurisdiction', note: 'n' }, { name: 'ADGM (Abu Dhabi Global Market)', type: 'jurisdiction', note: 'n' },
    ]));
    await runSession(c.signal, { llm, ask: jev, search });
    const jersey = jev.asked.find((a) => a.question.includes('"Jersey"') && !a.choices.includes('new_story'));
    expect(jersey?.choices).toEqual(['new', 'not_related']);
    const tokenized = jev.asked.find((a) => a.question.includes('"Tokenized stocks"') && !a.choices.includes('new_story'));
    expect(tokenized?.choices).toEqual(['existing', 'new', 'not_related']);
  });

  it('a news outlet only mentioned as the source is not a target (messenger prompt line; Jev not_related drops it)', async () => {
    expect(SYSTEM_PROMPT).toContain("The source is only the messenger; don't treat it as an entity unless the news is about the source itself.");
    expect(SYSTEM_PROMPT).toContain("Your note is what you'd want to read months later. Say who said it: if the entity itself says it, it's their announcement; if a news site or someone else says it, it's their report; if people are just talking, it's talk.");
    const c = spikeCases[5];
    const mentions = [...MENTIONS[c.signal.signal_id], { name: 'Cointelegraph', type: 'organization', search_terms: [] }];
    const llm = scriptedLlm(keepReplies('S', mentions, [{ name: 'Kalshi', type: 'organization', note: 'n' }]));
    const out = await runSession(c.signal, { llm, ask: scriptedJev({ keep: 'keep', existence: { Kalshi: 'existing', Cointelegraph: 'not_related' }, angle: { Kalshi: 'existing_story' } }), search });
    expect(out.targets.map((t) => t.entity)).toEqual(['kalshi']);
    expect(llm.calls[0][0]).toEqual({ role: 'system', content: SYSTEM_PROMPT });
  });

  it("the LLM returns an angle and an entity: the saved angle is Jev's and the entity is code's", async () => {
    const c = spikeCases[5];
    const llm = scriptedLlm(keepReplies('S', MENTIONS[c.signal.signal_id], [{ name: 'Kalshi', type: 'organization', note: 'n' }]));
    const out = await runSession(c.signal, { llm, ask: scriptedJev({ keep: 'keep', existence: { Kalshi: 'existing' }, angle: { Kalshi: 'plain_update' } }), search });
    expect(out.targets).toEqual([{ entity: 'kalshi', kind: 'existing', type: 'organization', angle: 'plain_update', note: 'n' }]);
  });

  it('the angle question carries summary, kind and the LLM reasoning as context', async () => {
    const c = spikeCases[5];
    const jev = scriptedJev({ keep: 'keep', existence: { Kalshi: 'existing' }, angle: { Kalshi: 'existing_story' } });
    await runSession(c.signal, { llm: scriptedLlm(keepReplies('The summary.', MENTIONS[c.signal.signal_id], [{ name: 'Kalshi', type: 'organization', note: 'n' }])), ask: jev, search });
    const angleQ = jev.asked.find((a) => a.choices.includes('new_story'));
    expect(angleQ?.choices).toEqual(['new_story', 'existing_story', 'plain_update']);
    expect(angleQ?.state).toMatchObject({ summary: 'The summary.', kind: 'existing', reasoning: 'What this means for Kalshi.' });
  });

  it('Jev answers outside the offered choices: the signal is unclear with no targets', async () => {
    const c = spikeCases[5];
    const llm = scriptedLlm(keepReplies('S', MENTIONS[c.signal.signal_id], [{ name: 'Kalshi', type: 'organization', note: 'n' }]));
    const ask: Ask = async (input) => ({ choice: input.choices.includes('keep') ? 'keep' : 'banana', probabilities: { banana: 1 }, provider: 'jev' });
    const out = await runSession(c.signal, { llm, ask, search });
    expect(out.decision).toBe('unclear');
    expect(out.targets).toEqual([]);
    expect(out.reason).toMatch(/banana/);
  });

  it('a free-text type on an existing target keeps the signal with the shelf type (no parking)', async () => {
    const c = spikeCases[0]; // any keep signal works; the mentions are scripted below
    const mentions: Mention[] = [{ name: 'Hyperliquid', type: 'crypto platform', search_terms: ['HYPE'] }];
    const llm = scriptedLlm(keepReplies('S', mentions, [{ name: 'Hyperliquid', type: 'crypto platform', note: 'n' }]));
    const out = await runSession(c.signal, { llm, ask: scriptedJev({ keep: 'keep', existence: { Hyperliquid: 'existing' }, angle: { Hyperliquid: 'existing_story' } }), search });
    expect(out.decision).toBe('keep');
    expect(out.targets).toEqual([{ entity: 'hyperliquid', kind: 'existing', type: 'protocol', angle: 'existing_story', note: 'n' }]);
  });

  it('a kept NEW target with a free-text type is dropped like not_related; the existing target keeps its shelf type', async () => {
    const c = spikeCases[0];
    const mentions: Mention[] = [
      { name: 'Backpack', type: 'crypto exchange / company', search_terms: [] },
      { name: 'SK Securities', type: 'securities firm / company', search_terms: [] },
    ];
    const llm = scriptedLlm(keepReplies('S', mentions, [
      { name: 'Backpack', type: 'crypto exchange / company', note: 'n' },
      { name: 'SK Securities', type: 'securities firm / company', note: 'n' },
    ]));
    const out = await runSession(c.signal, { llm, ask: scriptedJev({ keep: 'keep', existence: { Backpack: 'existing', 'SK Securities': 'new' }, angle: { Backpack: 'new_story' } }), search });
    expect(out.decision).toBe('keep');
    expect(out.targets).toEqual([{ entity: 'backpack', kind: 'existing', type: 'organization', angle: 'new_story', note: 'n' }]);
  });

  it('every kept NEW target dropped for a free-text type: keep with no targets, the nothing-to-route result', async () => {
    const c = spikeCases[1];
    const mentions: Mention[] = [{ name: 'Tokenized stocks', type: 'market/sector', search_terms: [] }];
    const llm = scriptedLlm(keepReplies('S', mentions, [{ name: 'Tokenized stocks', type: 'market/sector', note: 'n' }]));
    const out = await runSession(c.signal, { llm, ask: scriptedJev({ keep: 'keep', existence: { 'Tokenized stocks': 'new' }, angle: { 'Tokenized stocks': 'plain_update' } }), search: async () => [] });
    expect(out.decision).toBe('keep');
    expect(out.targets).toEqual([]);
    expect(out.reason).toMatch(/judged not related/);
  });

  it('an existing target takes the shelf type even when the LLM names a different shelf type', async () => {
    const c = spikeCases[3];
    const mentions: Mention[] = [{ name: 'Solana', type: 'protocol', search_terms: [] }];
    const llm = scriptedLlm(keepReplies('S', mentions, [{ name: 'Solana', type: 'protocol', note: 'n' }]));
    const out = await runSession(c.signal, { llm, ask: scriptedJev({ keep: 'keep', existence: { Solana: 'existing' }, angle: { Solana: 'existing_story' } }), search });
    expect(out.decision).toBe('keep');
    expect(out.targets).toEqual([{ entity: 'solana', kind: 'existing', type: 'asset', angle: 'existing_story', note: 'n' }]);
  });

  it('the T1 dissect and T4 notes prompts tell the LLM that type is one of the nine SHELF_TYPES', async () => {
    const c = spikeCases[5];
    const llm = scriptedLlm(keepReplies('S', MENTIONS[c.signal.signal_id], [{ name: 'Kalshi', type: 'organization', note: 'n' }]));
    await runSession(c.signal, { llm, ask: scriptedJev({ keep: 'keep', existence: { Kalshi: 'existing' }, angle: { Kalshi: 'existing_story' } }), search });
    // Turn 1 (dissect) is the first LLM call, turn 4 (notes) the third; each call is [system, user].
    const prompts = [llm.calls[0][1].content, llm.calls[2][1].content];
    for (const prompt of prompts) {
      for (const t of SHELF_TYPES) expect(prompt).toContain(`"${t}"`);
    }
  });

  it('a kept NEW target with a type no shelf has: dropped like not_related, the same result as the all-not-related path', async () => {
    const c = spikeCases[5];
    const llm = scriptedLlm(keepReplies('S', MENTIONS[c.signal.signal_id], [{ name: 'Kalshi', type: 'media_account', note: 'n' }]));
    const out = await runSession(c.signal, { llm, ask: scriptedJev({ keep: 'keep', existence: { Kalshi: 'new' }, angle: { Kalshi: 'new_story' } }), search: async () => [] });
    expect(out.decision).toBe('keep');
    expect(out.targets).toEqual([]);
    expect(out.reason).toBe('The decision tool said keep, but every mentioned entity was judged not related or dropped as a target, so there is nothing to route.');
  });

  it('the T4 note prompt says "Reply with JSON only:" immediately before the targets JSON shape line', async () => {
    const c = spikeCases[5];
    const llm = scriptedLlm(keepReplies('S', MENTIONS[c.signal.signal_id], [{ name: 'Kalshi', type: 'organization', note: 'n' }]));
    await runSession(c.signal, { llm, ask: scriptedJev({ keep: 'keep', existence: { Kalshi: 'existing' }, angle: { Kalshi: 'existing_story' } }), search });
    const call = llm.calls[2]; // the third call carries the full history; its last message is the T4 note prompt
    const prompt = call[call.length - 1].content;
    expect(prompt).toContain('The decision tool has picked each angle');
    expect(prompt).toContain('Reply with JSON only:\n{"targets": ');
  });

  it('the decision tool keeps a NEW entity and turn 4 returns an invalid type for it: it is dropped, targets [] and the nothing-to-route reason', async () => {
    const c = spikeCases[0];
    const mentions: Mention[] = [{ name: 'Backpack', type: 'organization', search_terms: [] }];
    const llm = scriptedLlm(keepReplies('S', mentions, [{ name: 'Backpack', type: 'crypto exchange', note: 'n' }]));
    const out = await runSession(c.signal, { llm, ask: scriptedJev({ keep: 'keep', existence: { Backpack: 'new' }, angle: { Backpack: 'new_story' } }), search: async () => [] });
    expect(out.decision).toBe('keep');
    expect(out.targets).toEqual([]);
    expect(out.reason).toBe('The decision tool said keep, but every mentioned entity was judged not related or dropped as a target, so there is nothing to route.');
  });

  it('every Jev call is logged with question, choices, answer and confidence', async () => {
    const c = spikeCases[5];
    const log: JevLogEntry[] = [];
    const llm = scriptedLlm(keepReplies('S', MENTIONS[c.signal.signal_id], [{ name: 'Kalshi', type: 'organization', note: 'n' }]));
    await runSession(c.signal, { llm, ask: scriptedJev({ keep: 'keep', existence: { Kalshi: 'existing' }, angle: { Kalshi: 'existing_story' } }), search, log: (e) => log.push(e) });
    expect(log).toHaveLength(3);
    for (const e of log) expect(e).toMatchObject({ signal_id: c.signal.signal_id, question: expect.any(String), choices: expect.any(Array), answer: expect.any(String), confidence: 0.9, provider: 'jev' });
  });

  it('an LLM failure or unparseable reply throws (the worker retries the signal)', async () => {
    const c = spikeCases[5];
    await expect(runSession(c.signal, { llm: scriptedLlm(['not json at all']), ask: scriptedJev({ keep: 'keep' }), search })).rejects.toThrow();
    await expect(runSession(c.signal, { llm: async () => { throw new Error('LLM HTTP 500'); }, ask: scriptedJev({ keep: 'keep' }), search })).rejects.toThrow(/500/);
  });
});

describe('#504 entity search, slugs and type mapping', () => {
  it('an exact name/alias/slug match on the mention ranks first (Coinbase -> coinbase, not base)', () => {
    expect(searchShelves(['Coinbase', 'Base'], spikeShelves)[0].slug).toBe('coinbase');
    expect(searchShelves(['HYPE'], spikeShelves)[0].slug).toBe('hyperliquid');
    expect(searchShelves(['trade-xyz'], spikeShelves)[0].slug).toBe('trade-xyz');
    expect(searchShelves(['Jersey'], spikeShelves)).toEqual([]);
  });

  it('canonicalSlug prefers a bracketed abbreviation', () => {
    expect(canonicalSlug('ADGM (Abu Dhabi Global Market)')).toBe('adgm');
    expect(canonicalSlug('Abu Dhabi Global Market (ADGM)')).toBe('adgm');
    expect(canonicalSlug('British Virgin Islands (BVI)')).toBe('bvi');
    expect(canonicalSlug('trade(xyz)')).toBe('trade-xyz');
    expect(canonicalSlug('Stanley Druckenmiller')).toBe('stanley-druckenmiller');
  });

  it('isShelfType is strict: only the nine shelf types after trim + lowercase, no synonyms', () => {
    for (const t of SHELF_TYPES) expect(isShelfType(t)).toBe(true);
    expect(isShelfType(' Organization ')).toBe(true);
    expect(isShelfType('jurisdiction')).toBe(false);
    expect(isShelfType('sector')).toBe(false);
    expect(isShelfType('media_account')).toBe(false);
    expect(isShelfType('')).toBe(false);
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
