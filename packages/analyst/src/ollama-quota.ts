/**
 * #391 the Ollama quota guard for the one-off catch-up run. ollama.com documents
 * GET https://ollama.com/api/balance with `Authorization: Bearer <OLLAMA_API_KEY>`
 * and a 10 requests/minute limit (docs.ollama.com/api/balance). Two shapes:
 *   - legacy plans: {included:{weekly:{remaining_percent: 0..100, resets_at}, session:{...}}}
 *   - current plans: {included:{balance_usd, allowance_usd, period}}
 * The guard turns a balance read into a pass/stop verdict for the catch-up loop
 * and fails closed: a remaining percent below the minimum, a non-2xx response, a
 * shape it cannot read, or a network error all stop the run. It reads at most once
 * per minIntervalMs (the catch-up loop checks before every signal), far below the
 * documented 10 req/min. No error ever includes the key.
 */

/** One remaining-budget reading in service terms: which plan shape and how much is left. */
export type QuotaReading = { source: 'weekly' | 'monthly_balance'; remainingPercent: number };

/** One guard verdict: ok is false on a stop; reading is set whenever a read was usable. */
export type QuotaCheck = { ok: boolean; reading?: QuotaReading; reason?: string };

export type QuotaGuard = { check(): Promise<QuotaCheck> };

export const OLLAMA_BALANCE_URL = 'https://ollama.com/api/balance';

/** One balance read; a hanging call aborts rather than stalling the catch-up loop. */
const READ_TIMEOUT_MS = 10_000;

/**
 * Read the remaining quota. A weekly.remaining_percent number wins (legacy plans);
 * otherwise balance_usd over a positive allowance_usd gives the percent (current
 * plans). Anything else throws: the caller decides to fail closed.
 */
export async function readOllamaQuota(apiKey: string, fetchImpl: typeof fetch = fetch): Promise<QuotaReading> {
  let response: Response;
  try {
    response = await fetchImpl(OLLAMA_BALANCE_URL, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(READ_TIMEOUT_MS),
    });
  } catch (e) {
    throw new Error(`ollama quota: no reliable remaining signal (network error: ${redactKey(asMessage(e), apiKey)})`);
  }
  if (!response.ok) {
    throw new Error(`ollama quota: no reliable remaining signal (HTTP ${response.status})`);
  }
  let body: Record<string, unknown>;
  try {
    body = asRecord(await response.json());
  } catch (e) {
    throw new Error(`ollama quota: no reliable remaining signal (invalid JSON: ${redactKey(asMessage(e), apiKey)})`);
  }
  const included = asRecord(body['included']);
  const weekly = asRecord(included['weekly']);
  const percent = weekly['remaining_percent'];
  if (typeof percent === 'number' && Number.isFinite(percent)) {
    return { source: 'weekly', remainingPercent: percent };
  }
  const balance = included['balance_usd'];
  const allowance = included['allowance_usd'];
  if (typeof balance === 'number' && Number.isFinite(balance) && typeof allowance === 'number' && Number.isFinite(allowance) && allowance > 0) {
    return { source: 'monthly_balance', remainingPercent: (balance / allowance) * 100 };
  }
  throw new Error('ollama quota: no reliable remaining signal (unexpected response shape)');
}

/**
 * The catch-up loop's guard: check() before every signal. The last successful
 * reading is reused for minIntervalMs (at most one real request per interval);
 * a verdict below minPercent, or an unreadable balance, answers ok: false.
 */
export function createQuotaGuard(o: {
  read: () => Promise<QuotaReading>;
  minPercent?: number;
  minIntervalMs?: number;
  now?: () => number;
}): QuotaGuard {
  const minPercent = o.minPercent ?? 15;
  const minIntervalMs = o.minIntervalMs ?? 60_000;
  const now = o.now ?? Date.now;
  let cached: { reading: QuotaReading; at: number } | null = null;

  const verdict = (reading: QuotaReading): QuotaCheck =>
    reading.remainingPercent < minPercent
      ? { ok: false, reading, reason: stoppedReason(reading, minPercent) }
      : { ok: true, reading };

  return {
    async check(): Promise<QuotaCheck> {
      const at = now();
      if (cached !== null && at - cached.at < minIntervalMs) return verdict(cached.reading);
      let reading: QuotaReading;
      try {
        reading = await o.read();
        cached = { reading, at: now() };
      } catch (e) {
        cached = null; // never keep a reading that failed; the next check may try again
        return { ok: false, reason: `quota read failed (fail closed): ${asMessage(e)}` };
      }
      return verdict(reading);
    },
  };
}

function stoppedReason(reading: QuotaReading, minPercent: number): string {
  return `${reading.source} remaining ${reading.remainingPercent}% is below the minimum ${minPercent}%`;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function asMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function redactKey(text: string, secret: string): string {
  return secret ? text.split(secret).join('[redacted]') : text;
}