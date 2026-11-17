import { describe, expect, it } from 'vitest';

import { askEditor, buildUserMessage, EDITOR_VERSION, parseModelReply, SYSTEM_PROMPT } from './editor.js';
import { bundle, item, passingCase, publishedLast } from './fixtures.js';

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
  it('carries the #671 rules: no restating the last card, time words true for NOW, watch tied to the new items', () => {
    expect(SYSTEM_PROMPT).toMatch(/Do not restate the last card\. how_we_got_here and what_to_watch must be new/);
    expect(SYSTEM_PROMPT).toMatch(/Relative time words .* must be correct for NOW/);
    expect(SYSTEM_PROMPT).toMatch(/If a named session or day has already closed, do not write as if it is still in progress/);
    expect(SYSTEM_PROMPT).toMatch(/what_to_watch must be tied to a fact in the new items or their origin signals/);
    expect(EDITOR_VERSION).toBe('latest-updates-v2');
  });
  it('the user message lists new items, earlier items, signals and the last card as labelled fields', () => {
    const a = item({ title: 'New thing', summary: 'sum' });
    const e = item({ title: 'Earlier thing' });
    const last = publishedLast(
      { title: 'H', what_happened: 'WH body', how_we_got_here: 'HWGH body', what_to_watch: 'WTW body' },
      { id: 'u1', date: '2026-11-13T00:00:00Z' },
    );
    const msg = buildUserMessage(bundle({ new_items: [a], prior_items: [e, a], last_update: last }));
    expect(msg).toContain(`id: ${a.id}`);
    expect(msg).toContain('Earlier thing');
    expect(msg.match(new RegExp(`id: ${a.id}`, 'g'))).toHaveLength(1);
    expect(msg).toContain(['LAST UPDATE (what we last published):', 'id: u1', 'date: 2026-11-13T00:00:00Z', 'title: H',
      'what_happened: WH body', 'how_we_got_here: HWGH body', 'what_to_watch: WTW body'].join('\n'));
    expect(msg).not.toContain('text: H');
  });
  it('states the run clock in UTC and IST, and keeps each item occurred_at', () => {
    const a = item({ title: 'New thing', occurred_at: '2026-11-17T03:00:00.000Z' });
    const msg = buildUserMessage(bundle({ new_items: [a], now: '2026-11-17T05:07:00.000Z' }));
    expect(msg.startsWith('NOW:\nutc: 2026-11-17T05:07:00.000Z\nist: 2026-11-17 10:37 IST (Asia/Kolkata), Tuesday\n')).toBe(true);
    expect(msg).toContain('occurred_at: 2026-11-17T03:00:00.000Z');
  });
  it('an earlier item stand-in keeps the old text fallback', () => {
    const a = item({ title: 'New thing' });
    const msg = buildUserMessage(bundle({ new_items: [a], last_update: { kind: 'earlier_item', id: 'e1', title: 'E', date: null, text: 'E\nolder body' } }));
    expect(msg).toContain('LAST UPDATE (newest earlier item):\nid: e1\ndate: unknown\ntext: E\nolder body');
  });
});
