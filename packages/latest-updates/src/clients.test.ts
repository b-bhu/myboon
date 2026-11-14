import { describe, expect, it } from 'vitest';

import { createOllamaLlm } from './clients.js';

const msgs = [{ role: 'user' as const, content: 'hi' }];
const KEY = 'sk-test-secret-key';

describe('createOllamaLlm', () => {
  it('posts glm-5.3-flash at temperature 0, non-streaming, with the key only in the Authorization header', async () => {
    let seen: { url: string; init: RequestInit } | null = null;
    const fetchImpl = (async (url: string, init: RequestInit) => {
      seen = { url, init };
      return new Response(JSON.stringify({ choices: [{ message: { content: '{"ok":true}' } }] }));
    }) as unknown as typeof fetch;
    const out = await createOllamaLlm({ apiKey: KEY, model: 'glm-5.3-flash', fetchImpl })(msgs);
    expect(out).toBe('{"ok":true}');
    expect(seen!.url).toBe('https://ollama.com/v1/chat/completions');
    expect(JSON.parse(String(seen!.init.body))).toEqual({ model: 'glm-5.3-flash', messages: msgs, temperature: 0, stream: false });
    expect(String(seen!.init.body)).not.toContain(KEY);
    expect((seen!.init.headers as Record<string, string>).Authorization).toBe(`Bearer ${KEY}`);
    expect(seen!.init.signal).toBeInstanceOf(AbortSignal);
  });

  it('an HTTP error carries a short message with the key redacted', async () => {
    const fetchImpl = (async () => new Response(`bad key ${KEY} ${'x'.repeat(500)}`, { status: 401 })) as unknown as typeof fetch;
    const err = await createOllamaLlm({ apiKey: KEY, model: 'm', fetchImpl })(msgs).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/^LLM HTTP 401: bad key \[redacted\]/);
    expect((err as Error).message).not.toContain(KEY);
    expect((err as Error).message.length).toBeLessThan(330);
  });

  it('an empty reply is an error', async () => {
    const fetchImpl = (async () => new Response(JSON.stringify({ choices: [{ message: { content: '  ' } }] }))) as unknown as typeof fetch;
    await expect(createOllamaLlm({ apiKey: KEY, model: 'm', fetchImpl })(msgs)).rejects.toThrow('LLM reply has no content');
  });

  it('enforces the per-entity timeout with a TimeoutError', async () => {
    const fetchImpl = ((_url: string, init: RequestInit) => new Promise((_resolve, reject) => {
      init.signal!.addEventListener('abort', () => reject(init.signal!.reason));
    })) as unknown as typeof fetch;
    const err = await createOllamaLlm({ apiKey: KEY, model: 'm', timeoutMs: 20, fetchImpl })(msgs).catch((e: Error) => e);
    expect((err as Error).name).toBe('TimeoutError');
  });
});
