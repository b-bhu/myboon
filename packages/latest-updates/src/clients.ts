/**
 * Minimal Ollama Cloud chat client (same call as @myboon/entity-manager and @myboon/analyst; copied so this
 * package depends on neither). Model: GLM glm-5.3-flash, temperature 0. The key is never logged.
 */
export type ChatMessage = { role: 'system' | 'user' | 'assistant'; content: string };
export type Llm = (messages: ChatMessage[]) => Promise<string>;

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
