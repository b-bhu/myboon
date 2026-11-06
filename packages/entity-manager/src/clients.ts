/**
 * Minimal LLM clients, copied from @myboon/analyst (session.ts createOllamaLlm, deciders.ts
 * SystemOneDecider) so this package has no dependency on the analyst. Keys are never logged.
 */
export type ChatMessage = { role: 'system' | 'user' | 'assistant'; content: string };
export type Llm = (messages: ChatMessage[]) => Promise<string>;
export type JevAnswer = { choice: string; probabilities: Record<string, number> };
export type Jev = (state: unknown, question: string, choices: string[]) => Promise<JevAnswer>;

const redact = (text: string, secret: string) => (secret ? text.split(secret).join('[redacted]') : text);
const snip = (text: string) => text.replace(/\s+/g, ' ').slice(0, 300);
const rec = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

export function createOllamaLlm(o: { apiKey: string; model: string; url?: string; timeoutMs?: number; fetchImpl?: typeof fetch }): Llm {
  const url = o.url ?? 'https://ollama.com/v1/chat/completions';
  const fetchImpl = o.fetchImpl ?? fetch;
  const timeoutMs = o.timeoutMs ?? 30_000;
  return async (messages) => {
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${o.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: o.model, messages, temperature: 0, stream: false }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) throw new Error(`LLM HTTP ${res.status}: ${snip(redact(await res.text(), o.apiKey))}`);
    const content = rec(rec((rec(await res.json()).choices as unknown[] | undefined)?.[0]).message).content;
    if (typeof content !== 'string' || !content.trim()) throw new Error('LLM reply has no content');
    return content;
  };
}

export const JEV_ENDPOINT = 'https://api.typesafe.ai/v1/systemone';
export const JEV_MODEL = 'jev-1.13.0';

export function createJev(o: { apiToken: string; endpoint?: string; model?: string; timeoutMs?: number; fetchImpl?: typeof fetch }): Jev {
  const fetchImpl = o.fetchImpl ?? fetch;
  const model = o.model ?? JEV_MODEL;
  return async (state, question, choices) => {
    const res = await fetchImpl(o.endpoint ?? JEV_ENDPOINT, {
      method: 'POST',
      headers: { Authorization: `Bearer ${o.apiToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        state,
        questions: { pick: { type: 'choice', instructions: question, criteria: Object.fromEntries(choices.map((c) => [c, c])) } },
      }),
      signal: AbortSignal.timeout(o.timeoutMs ?? 30_000),
    });
    if (!res.ok) throw new Error(`jev HTTP ${res.status}: ${snip(redact(await res.text(), o.apiToken))}`);
    const root = rec(await res.json());
    if (root.model !== model) throw new Error(`jev model mismatch: ${JSON.stringify(root.model ?? null)}`);
    const pick = rec(rec(root.answers).pick);
    if (typeof pick.choice !== 'string' || !choices.includes(pick.choice)) throw new Error('jev pick.choice is not one of the choices');
    const probabilities: Record<string, number> = {};
    for (const [k, v] of Object.entries(rec(pick.probabilities))) if (typeof v === 'number') probabilities[k] = v;
    return { choice: pick.choice, probabilities };
  };
}
