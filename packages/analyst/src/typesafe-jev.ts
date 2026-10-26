/**
 * #485 fix 3: the real Jev client (TypeSafe System One). One POST per call,
 * mirroring the request/response shape of the collectors' JevSystemOneAdapter
 * (packages/collectors/src/inference-gateway/classification-adapters.ts)
 * without importing from that package: {model, state, questions} in,
 * Bearer token + caller-provided abort signal, and {model, answers, usage} out
 * with the model pinned to the configured version. The endpoint is pinned to
 * the approved System One URL, token values are never logged, and provider
 * failure text is redacted before it reaches an error message.
 */
import type { JevAnswer, JevPort } from './jev.js';

/** Choice and noul are the two answer maps this client supports (see decide). */
export type JevQuestion =
  | { type: 'choice'; instructions: unknown; criteria: Readonly<Record<string, unknown>> }
  | { type: 'noul'; instructions: unknown; criteria?: Readonly<{ true: unknown; false: unknown }> };

export const APPROVED_JEV_ENDPOINT = 'https://api.typesafe.ai/v1/systemone';

export type TypeSafeJevOptions = {
  apiToken: string;
  endpoint?: string;
  /** Defaults to jev-1.13.0; the response model must match it exactly. */
  model?: string;
  questions: Record<string, JevQuestion>;
  /** Question key whose choice/probability becomes answer/probability. First key if omitted. */
  primary?: string;
  fetchImpl?: typeof fetch;
};

function requiredToken(value: string): string {
  const token = value.trim();
  if (token === '') throw new Error('JEV_API_TOKEN is required');
  return token;
}

export class TypeSafeJev implements JevPort {
  readonly modelVersion: string;

  private readonly questions: Record<string, JevQuestion>;
  private readonly primary: string;
  private readonly apiToken: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: TypeSafeJevOptions) {
    this.apiToken = requiredToken(options.apiToken);
    if (options.endpoint !== undefined && options.endpoint !== APPROVED_JEV_ENDPOINT) {
      throw new Error(`endpoint ${options.endpoint} is not approved; Jev only talks to ${APPROVED_JEV_ENDPOINT}`);
    }
    this.modelVersion = options.model ?? 'jev-1.13.0';
    this.questions = { ...options.questions };
    if (Object.keys(this.questions).length === 0) throw new Error('questions must not be empty');
    this.primary = options.primary ?? Object.keys(this.questions)[0];
    if (!(this.primary in this.questions)) throw new Error(`primary ${this.primary} is not a question key`);
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async decide(input: unknown, signal: AbortSignal): Promise<JevAnswer> {
    let response: Response;
    try {
      response = await this.fetchImpl(APPROVED_JEV_ENDPOINT, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ model: this.modelVersion, state: input, questions: this.questions }),
        signal,
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(`Jev request failed: ${reason}${signal.aborted ? ' (aborted)' : ''}`);
    }
    if (!response.ok) {
      const detail = await failureDetail(response, this.apiToken);
      throw new Error(`Jev HTTP ${response.status}${detail ? `: ${detail}` : ''}`);
    }
    let value: unknown;
    try { value = await response.json(); } catch {
      throw new Error('Jev response is not JSON');
    }
    return this.mapAnswer(value);
  }

  /** Pins the model and requires answers for exactly the configured question keys. */
  private mapAnswer(value: unknown): JevAnswer {
    const root = asRecord(value, 'Jev response must be an object');
    if (root.model !== this.modelVersion) {
      throw new Error(`Jev returned model ${JSON.stringify(root.model ?? null)} but this client is pinned to ${this.modelVersion}`);
    }
    const rawAnswers = asRecord(root.answers, 'Jev response answers must be an object');
    const keys = Object.keys(this.questions);
    if (Object.keys(rawAnswers).sort().join('\u0000') !== [...keys].sort().join('\u0000')) {
      throw new Error('Jev response answers must contain exactly the configured question keys');
    }

    const answer: Record<string, unknown> = {};
    let probability: number | null = null;
    let runnerUp: unknown = null;
    for (const key of keys) {
      const question = this.questions[key];
      const raw = asRecord(rawAnswers[key], `${key} must be an object`);
      if (raw.type !== question.type) throw new Error(`${key}.type must be ${question.type}`);
      if (question.type === 'noul') {
        const noul = asProbability(raw.noul, `${key}.noul`);
        answer[key] = noul >= 0.5;
        if (key === this.primary) {
          probability = Math.max(noul, 1 - noul);
          runnerUp = null;
        }
        continue;
      }
      const choice = asChoice(raw.choice, `${key}.choice`);
      const criteria = asRecord(question.criteria, `${key}.criteria must be an object`);
      if (!(choice in criteria)) throw new Error(`${key}.choice is not registry-defined`);
      const probabilities = asProbabilities(raw.probabilities, `${key}.probabilities`);
      if (!(choice in probabilities)) throw new Error(`${key}.probabilities.${choice} is missing`);
      answer[key] = choice;
      if (key === this.primary) {
        probability = probabilities[choice];
        runnerUp = runnerUpChoice(criteria, probabilities, choice, this.primary);
      }
    }
    return { answer, probability, runnerUp, modelVersion: this.modelVersion };
  }
}

/** Second-best criteria-defined choice of the primary question, ranked by probability. */
function runnerUpChoice(
  criteria: Record<string, unknown>,
  probabilities: Record<string, number>,
  chosen: string,
  primaryKey: string,
): unknown {
  const ranked = Object.keys(criteria)
    .filter((candidate) => candidate !== chosen && probabilities[candidate] !== undefined)
    .sort((a, b) => probabilities[b] - probabilities[a]);
  const second = ranked[0];
  if (second === undefined) return null;
  return { [primaryKey]: second, probability: probabilities[second] };
}

function asRecord(value: unknown, message: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(message);
  return value as Record<string, unknown>;
}

function asProbability(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`${field} must be a number between zero and one`);
  }
  return value;
}

function asProbabilities(value: unknown, field: string): Record<string, number> {
  const raw = asRecord(value, `${field} must be an object`);
  return Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, asProbability(v, `${field}.${k}`)]));
}

function asChoice(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${field} must be non-empty text`);
  return value.trim();
}

/** Provider failure text for the error message, with the API token redacted. */
async function failureDetail(response: Response, token: string): Promise<string | null> {
  try {
    const value = await response.json() as { detail?: unknown; message?: unknown; error?: { message?: unknown } };
    const message = [value.detail, value.message, value.error?.message].find((candidate): candidate is string => typeof candidate === 'string');
    return message ? message.split(token).join('[redacted]').replace(/[\r\n]+/g, ' ').slice(0, 500) : null;
  } catch {
    return null;
  }
}

/**
 * Real Jev from the environment (manual record run, live stages): reads
 * JEV_API_TOKEN and never logs or stores it beyond the client instance.
 */
export function jevFromEnv(questions: Record<string, JevQuestion>): TypeSafeJev {
  const token = process.env.JEV_API_TOKEN;
  if (token === undefined || token.trim() === '') throw new Error('JEV_API_TOKEN is required');
  return new TypeSafeJev({ apiToken: token.trim(), questions });
}