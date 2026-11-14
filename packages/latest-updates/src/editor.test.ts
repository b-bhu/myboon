import { describe, expect, it } from 'vitest';

import { askEditor, buildUserMessage, parseModelReply, SYSTEM_PROMPT } from './editor.js';
import { bundle, item, passingCase } from './fixtures.js';

const WRITE = {
  decision: 'write', reason: 'new number', title: 'T', what_happened: 'W', how_we_got_here: 'H', what_to_watch: 'Dec 10',
  claims: [{ text: 'c', source_item_id: 'i1', source_signal_id: null }],
};

describe('parseModelReply', () => {
  it('parses hold and skip', () => {
    expect(parseModelReply('{"decision":"hold","reason":"thin"}')).toEqual({ decision: 'hold', reason: 'thin' });
    expect(parseModelReply('{"decision":"SKIP","reason":"repeat","claims":null}')).toEqual({ decision: 'skip', reason: 'repeat' });
  });
  it('parses a write, also inside a markdown fence', () => {
    const r = parseModelReply('```json\n' + JSON.stringify(WRITE) + '\n```');
    expect(r).toEqual({ decision: 'write', reason: 'new number', draft: { title: 'T', what_happened: 'W', how_we_got_here: 'H', what_to_watch: 'Dec 10', claims: [{ text: 'c', source_item_id: 'i1', source_signal_id: null }] } });
  });
  it.each([
    ['not json', 'no json at all'],
    ['unknown decision', '{"decision":"watch","reason":"x"}'],
    ['no reason', '{"decision":"hold"}'],
    ['write without a part', JSON.stringify({ ...WRITE, how_we_got_here: '' })],
    ['write without a title', JSON.stringify({ ...WRITE, title: null })],
    ['claims not an array', JSON.stringify({ ...WRITE, claims: 'x' })],
    ['a claim without text', JSON.stringify({ ...WRITE, claims: [{ source_item_id: 'i' }] })],
  ])('throws on %s', (_name, raw) => {
    expect(() => parseModelReply(raw)).toThrow();
  });
});

describe('askEditor', () => {
  const b = passingCase().bundle;
  it('returns the decision', async () => {
    expect(await askEditor(b, async () => '{"decision":"hold","reason":"thin"}')).toEqual({ kind: 'decision', model: { decision: 'hold', reason: 'thin' } });
  });
  it('a timeout is an error outcome', async () => {
    const llm = async () => { throw Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' }); };
    expect(await askEditor(b, llm)).toEqual({ kind: 'error', code: 'timeout', message: 'model timed out' });
  });
  it('a failed call is an error outcome with a short message', async () => {
    const out = await askEditor(b, async () => { throw new Error('LLM HTTP 503: ' + 'x'.repeat(1000)); });
    expect(out.kind).toBe('error');
    if (out.kind === 'error') { expect(out.code).toBe('llm_error'); expect(out.message.length).toBeLessThanOrEqual(300); }
  });
  it('bad JSON is an error outcome', async () => {
    const out = await askEditor(b, async () => 'sorry, I cannot');
    expect(out).toMatchObject({ kind: 'error', code: 'bad_json' });
  });
  it('sends the system prompt and one user message at temperature-0 shape (messages only)', async () => {
    let seen: Array<{ role: string; content: string }> = [];
    await askEditor(b, async (m) => { seen = m; return '{"decision":"hold","reason":"x"}'; });
    expect(seen.map((m) => m.role)).toEqual(['system', 'user']);
    expect(seen[0]!.content).toBe(SYSTEM_PROMPT);
  });
});

describe('the prompt', () => {
  it('says hold is the default and carries bars (a), (c) and (d)', () => {
    expect(SYSTEM_PROMPT).toMatch(/HOLD IS THE DEFAULT/);
    expect(SYSTEM_PROMPT).toMatch(/\(a\) the new items add at least one fact/);
    expect(SYSTEM_PROMPT).toMatch(/\(c\) what_to_watch names something concrete/);
    expect(SYSTEM_PROMPT).toMatch(/\(d\) any month, quarter, half-year or fiscal year/);
    expect(SYSTEM_PROMPT).toMatch(/Catch-up editor/);
  });
  it('the user message lists new items, earlier items, signals and the last update', () => {
    const a = item({ title: 'New thing', summary: 'sum' });
    const e = item({ title: 'Earlier thing' });
    const msg = buildUserMessage(bundle({ new_items: [a], prior_items: [e, a], last_update: { kind: 'published', id: 'u1', title: 'H', date: '2026-11-13T00:00:00Z', text: 'H\nbody' } }));
    expect(msg).toContain(`id: ${a.id}`);
    expect(msg).toContain('Earlier thing');
    expect(msg.match(new RegExp(`id: ${a.id}`, 'g'))).toHaveLength(1);
    expect(msg).toContain('LAST UPDATE (what we last published):');
  });
});
