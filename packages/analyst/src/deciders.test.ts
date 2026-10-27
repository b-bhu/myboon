/**
 * SystemOneDecider against a fake fetch (issue #478, no network and no real
 * Jev or Clef): the request shape (url, POST, Bearer auth, one pick choice
 * question), answer mapping with model pinning, the failure mapping (402 ->
 * out_of_credit, abort -> timeout, everything else -> error), and token
 * redaction in error messages. The env factories are checked for the pinned
 * endpoints, models and names.
 */
import { describe, expect, it } from 'vitest';

import {
  CLEF_ENDPOINT,
  CLEF_MODEL,
  JEV_ENDPOINT,
  JEV_MODEL,
  DeciderError,
  SystemOneDecider,
  clefFromEnv,
  jevFromEnv,
} from './deciders.js';
import type { DecisionCase } from './deciders.js';

const TOKEN = 'test-api-token-not-a-real-secret';

const CASE: DecisionCase = {
  question: 'Does this signal start a new story?',
  choices: ['new_story', 'adds_nothing', 'link'],
  shortlist: [{ slug: 'bitcoin', score: 2 }],
  itemIds: ['00000000-0000-7000-8000-000000000001'],
  state: { signal_id: 'a'.repeat(64), text: 'headline' },
};

function jsonBody(value: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
}

describe('SystemOneDecider request shape (fake fetch)', () => {
  it('posts one pick choice question with the model, state and Bearer token, and answers with choice + probabilities', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const impl: typeof fetch = async (url, init) => {
      calls.push({ url: String(url), init: init ?? {} });
      return jsonBody({
        model: JEV_MODEL,
        answers: { pick: { choice: 'new_story', probabilities: { new_story: 0.82, adds_nothing: 0.12, link: 0.06 } } },
      });
    };
    const d = new SystemOneDecider({ name: 'jev', model: JEV_MODEL, endpoint: JEV_ENDPOINT, apiToken: TOKEN, fetchImpl: impl });

    const answer = await d.decide(CASE, new AbortController().signal);

    expect(answer).toEqual({ choice: 'new_story', probabilities: { new_story: 0.82, adds_nothing: 0.12, link: 0.06 } });
    expect(calls).toHaveLength(1);
    const { url, init } = calls[0]!;
    expect(url).toBe(JEV_ENDPOINT);
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>)['Authorization']).toBe(`Bearer ${TOKEN}`);
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/json');
    expect(JSON.parse(String(init.body))).toEqual({
      model: JEV_MODEL,
      state: CASE.state,
      questions: {
        pick: {
          type: 'choice',
          instructions: CASE.question,
          criteria: { new_story: 'new_story', adds_nothing: 'adds_nothing', link: 'link' },
        },
      },
    });
  });

  it('rejects an answer whose choice is not one of the case choices', async () => {
    const impl: typeof fetch = async () => jsonBody({ model: CLEF_MODEL, answers: { pick: { choice: 'park_it', probabilities: { park_it: 0.9 } } } });
    const d = new SystemOneDecider({ name: 'clef', model: CLEF_MODEL, endpoint: CLEF_ENDPOINT, apiToken: TOKEN, fetchImpl: impl });
    await expect(d.decide(CASE, new AbortController().signal)).rejects.toSatisfy(
      (e: unknown) => e instanceof DeciderError && e.kind === 'error' && /pick\.choice/.test(e.message),
    );
  });

  it('rejects a response that misses the chosen probability', async () => {
    const impl: typeof fetch = async () => jsonBody({ model: JEV_MODEL, answers: { pick: { choice: 'link', probabilities: { new_story: 0.5 } } } });
    const d = deciderWithImpl(impl);
    await expect(d.decide(CASE, new AbortController().signal)).rejects.toSatisfy(
      (e: unknown) => e instanceof DeciderError && e.kind === 'error' && /probabilities\.link is missing/.test(e.message),
    );
  });

  it('rejects a probability outside 0..1', async () => {
    const impl: typeof fetch = async () => jsonBody({ model: JEV_MODEL, answers: { pick: { choice: 'new_story', probabilities: { new_story: 1.4 } } } });
    const d = deciderWithImpl(impl);
    await expect(d.decide(CASE, new AbortController().signal)).rejects.toSatisfy(
      (e: unknown) => e instanceof DeciderError && e.kind === 'error' && /between zero and one/.test(e.message),
    );
  });
});

describe('SystemOneDecider failure mapping (fake fetch)', () => {
  it('maps HTTP 402 to out_of_credit', async () => {
    const impl: typeof fetch = async () => jsonBody({ detail: 'payment required' }, 402);
    const d = deciderWithImpl(impl);
    await expect(d.decide(CASE, new AbortController().signal)).rejects.toSatisfy(
      (e: unknown) => e instanceof DeciderError && e.kind === 'out_of_credit' && /HTTP 402/.test(e.message),
    );
  });

  it('maps another HTTP status to error and keeps the token out of the message', async () => {
    const impl: typeof fetch = async () =>
      new Response(JSON.stringify({ error: `auth failed for Bearer ${TOKEN}` }), {
        status: 503,
        headers: { 'content-type': 'application/json' },
      });
    const d = deciderWithImpl(impl);
    const failure = await d.decide(CASE, new AbortController().signal).then(
      () => null,
      (e: unknown) => e,
    );
    expect(failure).toBeInstanceOf(DeciderError);
    const e = failure as DeciderError;
    expect(e.kind).toBe('error');
    expect(e.message).toMatch(/HTTP 503/);
    expect(e.message).not.toContain(TOKEN);
  });

  it('maps a response whose model does not match to error', async () => {
    const impl: typeof fetch = async () => jsonBody({ model: 'jev-0.9', answers: { pick: { choice: 'new_story', probabilities: { new_story: 1 } } } });
    const d = deciderWithImpl(impl);
    await expect(d.decide(CASE, new AbortController().signal)).rejects.toSatisfy(
      (e: unknown) => e instanceof DeciderError && e.kind === 'error' && /model mismatch/.test(e.message),
    );
  });

  it('maps a request that dies on the abort signal to timeout', async () => {
    const impl: typeof fetch = ((_url: unknown, init?: RequestInit) =>
      new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('This operation was aborted')));
        init?.signal?.throwIfAborted();
      })) as typeof fetch;
    const d = deciderWithImpl(impl);
    const ac = new AbortController();
    const pending = d.decide(CASE, ac.signal);
    setTimeout(() => ac.abort(), 10);
    await expect(pending).rejects.toSatisfy(
      (e: unknown) => e instanceof DeciderError && e.kind === 'timeout' && /abort/.test(e.message),
    );
  });

  it('maps a network failure (no abort) to error', async () => {
    const impl: typeof fetch = async () => {
      throw new Error('connect ECONNREFUSED');
    };
    const d = deciderWithImpl(impl);
    await expect(d.decide(CASE, new AbortController().signal)).rejects.toSatisfy(
      (e: unknown) => e instanceof DeciderError && e.kind === 'error' && /ECONNREFUSED/.test(e.message),
    );
  });

  it('maps a non-JSON 200 response to error', async () => {
    const impl: typeof fetch = async () => new Response('<html>not json</html>', { status: 200 });
    const d = deciderWithImpl(impl);
    await expect(d.decide(CASE, new AbortController().signal)).rejects.toSatisfy(
      (e: unknown) => e instanceof DeciderError && e.kind === 'error' && /not JSON/.test(e.message),
    );
  });
});

function deciderWithImpl(impl: typeof fetch): SystemOneDecider {
  return new SystemOneDecider({ name: 'jev', model: JEV_MODEL, endpoint: JEV_ENDPOINT, apiToken: TOKEN, fetchImpl: impl });
}

describe('env decider factories', () => {
  it('jevFromEnv pins the approved TypeSafe endpoint and jev-1.13.0', () => {
    process.env.JEV_API_TOKEN = TOKEN;
    const d = jevFromEnv();
    expect(d.name).toBe('jev');
    expect(d.modelName).toBe(JEV_MODEL);
    expect(d.modelVersion).toBe(JEV_MODEL);
    expect(JEV_ENDPOINT).toBe('https://api.typesafe.ai/v1/systemone');
  });

  it('clefFromEnv pins the Ollama Cloud endpoint and the clef model', () => {
    process.env.OLLAMA_API_KEY = TOKEN;
    const d = clefFromEnv();
    expect(d.name).toBe('clef');
    expect(d.modelName).toBe(CLEF_MODEL);
    expect(CLEF_ENDPOINT).toBe('https://ollama.com/v1/systemone');
  });

  it('throws before any request when the env token is missing', () => {
    delete process.env.JEV_API_TOKEN;
    expect(() => jevFromEnv()).toThrow(/JEV_API_TOKEN/);
    delete process.env.OLLAMA_API_KEY;
    expect(() => clefFromEnv()).toThrow(/OLLAMA_API_KEY/);
  });

  it('refuses an empty token at construction', () => {
    expect(() => new SystemOneDecider({ name: 'jev', model: JEV_MODEL, endpoint: JEV_ENDPOINT, apiToken: '  ', fetchImpl: fetch }))
      .toThrow(/token is required/);
  });
});