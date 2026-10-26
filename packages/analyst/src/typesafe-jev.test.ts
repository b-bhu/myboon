/** Fix 3: real Jev (TypeSafe System One) adapter, exercised with a fake fetch. No network. */
import { describe, expect, it } from 'vitest';
import { TypeSafeJev } from './index.js';

const question = { type: 'choice', instructions: 'Which entity?', criteria: { uniswap: 'Uniswap protocol', uni: 'UNI token' } } as const;

function fakeFetch(body: unknown, status = 200) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const impl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

describe('TypeSafeJev adapter', () => {
  it('posts model/state/questions with the bearer token and the abort signal, and maps the answer', async () => {
    const { impl, calls } = fakeFetch({
      model: 'jev-1.13.0',
      answers: { pick: { type: 'choice', choice: 'uniswap', probabilities: { uniswap: 0.91, uni: 0.09 }, confidence: 0.9 } },
      usage: { input_tokens: 10, output_tokens: 2 },
    });
    const jev = new TypeSafeJev({ apiToken: 'tok-test', fetchImpl: impl, questions: { pick: question } });
    const ac = new AbortController();
    const out = await jev.decide({ title: 'Uniswap fee switch' }, ac.signal);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://api.typesafe.ai/v1/systemone');
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe('Bearer tok-test');
    expect(calls[0].init.signal).toBe(ac.signal);
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ model: 'jev-1.13.0', state: { title: 'Uniswap fee switch' }, questions: { pick: question } });
    expect(out).toEqual({ answer: { pick: 'uniswap' }, probability: 0.91, runnerUp: { pick: 'uni', probability: 0.09 }, modelVersion: 'jev-1.13.0' });
    expect(jev.modelVersion).toBe('jev-1.13.0');
  });

  it('throws on HTTP errors without leaking the token', async () => {
    const { impl } = fakeFetch({ detail: 'bad token tok-test' }, 401);
    const jev = new TypeSafeJev({ apiToken: 'tok-test', fetchImpl: impl, questions: { pick: question } });
    const err = await jev.decide({}, new AbortController().signal).catch((e: Error) => e);
    expect(String(err)).toMatch(/HTTP 401/);
    expect(String(err)).not.toContain('tok-test');
  });

  it('rejects a wrong model or malformed answers', async () => {
    const { impl } = fakeFetch({ model: 'other', answers: {}, usage: {} });
    const jev = new TypeSafeJev({ apiToken: 't', fetchImpl: impl, questions: { pick: question } });
    await expect(jev.decide({}, new AbortController().signal)).rejects.toThrow(/model/);
  });

  it('refuses a non-approved endpoint', () => {
    expect(() => new TypeSafeJev({ apiToken: 't', endpoint: 'https://evil.example/v1', questions: { pick: question } })).toThrow(/endpoint/);
  });
});
