/**
 * The decider slot (#478): one System One client that asks a fixed `pick`
 * choice question about a decision case. Jev is the default, Clef the
 * automatic fallback and the shadow; the request/response shape mirrors the
 * collectors' JevSystemOneAdapter without importing from that package:
 *
 *   POST {model, state, questions: {pick: {type: 'choice', instructions, criteria}}}
 *   <-  {model, answers: {pick: {choice, probabilities}}}
 *
 * The response model must match the configured one exactly. HTTP 402 maps to
 * out_of_credit, a request that dies on the abort signal to timeout, and every
 * other failure to error - all as DeciderError, whose messages are redacted so
 * the API token never leaves this file. Token values are never logged.
 */
export type DeciderKind = 'error' | 'timeout' | 'out_of_credit';

/** The three decidable failures; the message never carries secrets. */
export class DeciderError extends Error {
  constructor(readonly kind: DeciderKind, message: string) {
    super(message);
    this.name = 'DeciderError';
  }
}

export type DecisionCase = {
  question: string;
  choices: string[];
  /** Shortlisted candidate shelves (the case the decider ranks against). */
  shortlist: unknown[];
  itemIds: string[];
  state: unknown;
};

export type DeciderAnswer = { choice: string; probabilities: Record<string, number> };

export interface Decider {
  name: 'jev' | 'clef';
  modelName: string;
  modelVersion: string;
  decide(c: DecisionCase, signal: AbortSignal): Promise<DeciderAnswer>;
}

export type SystemOneDeciderOptions = {
  name: 'jev' | 'clef';
  /** Sent as `model` and pinned against the response's model field. */
  model: string;
  endpoint: string;
  apiToken: string;
  fetchImpl?: typeof fetch;
};

const QUESTION_KEY = 'pick';

export class SystemOneDecider implements Decider {
  readonly name: 'jev' | 'clef';
  readonly modelName: string;
  readonly modelVersion: string;

  private readonly endpoint: string;
  private readonly apiToken: string;
  private readonly fetchImpl: typeof fetch;

  constructor(o: SystemOneDeciderOptions) {
    if (!o.apiToken.trim()) throw new Error('decider api token is required');
    this.name = o.name;
    this.modelName = o.model;
    this.modelVersion = o.model;
    this.endpoint = o.endpoint;
    this.apiToken = o.apiToken;
    this.fetchImpl = o.fetchImpl ?? fetch;
  }

  async decide(c: DecisionCase, signal: AbortSignal): Promise<DeciderAnswer> {
    let response: Response;
    try {
      response = await this.fetchImpl(this.endpoint, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: this.modelName,
          state: c.state,
          questions: {
            [QUESTION_KEY]: {
              type: 'choice',
              instructions: c.question,
              criteria: Object.fromEntries(c.choices.map((choice) => [choice, choice])),
            },
          },
        }),
        signal,
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      if (signal.aborted) {
        throw new DeciderError('timeout', `${this.name} did not answer before the abort: ${redact(reason, this.apiToken)}`);
      }
      throw new DeciderError('error', `${this.name}: ${redact(reason, this.apiToken)}`);
    }

    if (!response.ok) {
      const kind: DeciderKind = response.status === 402 ? 'out_of_credit' : 'error';
      throw new DeciderError(kind, `${this.name} HTTP ${response.status}: ${await failureDetail(response, this.apiToken)}`);
    }

    let value: unknown;
    try {
      value = await response.json();
    } catch {
      throw new DeciderError('error', `${this.name}: response is not JSON`);
    }
    return mapAnswer(value, c, this.name, this.modelName);
  }
}

/** The approved System One endpoint for Jev (TypeSafe). */
export const JEV_ENDPOINT = 'https://api.typesafe.ai/v1/systemone';
/** Cloudflare's Clef decision model on Ollama Cloud. */
export const CLEF_ENDPOINT = 'https://ollama.com/v1/systemone';

export const JEV_MODEL = 'jev-1.13.0';
export const CLEF_MODEL = 'clef';

/** Real Jev from the environment; JEV_API_TOKEN is never logged or stored elsewhere. */
export function jevFromEnv(fetchImpl?: typeof fetch): SystemOneDecider {
  return new SystemOneDecider({
    name: 'jev',
    model: JEV_MODEL,
    endpoint: JEV_ENDPOINT,
    apiToken: requiredToken('JEV_API_TOKEN'),
    fetchImpl,
  });
}

/** Real Clef from the environment; OLLAMA_API_KEY is never logged or stored elsewhere. */
export function clefFromEnv(fetchImpl?: typeof fetch): SystemOneDecider {
  return new SystemOneDecider({
    name: 'clef',
    model: CLEF_MODEL,
    endpoint: CLEF_ENDPOINT,
    apiToken: requiredToken('OLLAMA_API_KEY'),
    fetchImpl,
  });
}

function requiredToken(envName: string): string {
  const token = process.env[envName]?.trim();
  if (!token) throw new Error(`${envName} is required`);
  return token;
}

/** The pick answer, checked against the configured model and the case choices. */
function mapAnswer(value: unknown, c: DecisionCase, name: string, model: string): DeciderAnswer {
  const root = asRecord(value, 'response must be an object');
  if (root.model !== model) {
    throw new DeciderError('error', `${name} model mismatch: response model ${JSON.stringify(root.model ?? null)} but client pinned to ${model}`);
  }
  const answers = asRecord(root.answers, 'response answers must be an object');
  const pick = asRecord(answers[QUESTION_KEY], 'answers.pick must be an object');
  const choice = pick.choice;
  if (typeof choice !== 'string' || !c.choices.includes(choice)) {
    throw new DeciderError('error', `${name} pick.choice must be one of the case choices ${JSON.stringify(c.choices)}`);
  }
  const rawProbabilities = asRecord(pick.probabilities, 'answers.pick.probabilities must be an object');
  const probabilities: Record<string, number> = {};
  for (const [key, value] of Object.entries(rawProbabilities)) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
      throw new DeciderError('error', `${name} probabilities.${key} must be a number between zero and one`);
    }
    probabilities[key] = value;
  }
  if (!(choice in probabilities)) {
    throw new DeciderError('error', `${name} probabilities.${choice} is missing`);
  }
  return { choice, probabilities };
}

/** Body/status detail for an error message, with the API token redacted. */
async function failureDetail(response: Response, token: string): Promise<string> {
  let body: string;
  try {
    body = await response.text();
  } catch {
    return '';
  }
  return redact(clean(body), token);
}

function redact(text: string, token: string): string {
  let value = text.split(token).join('[redacted]');
  value = value.replace(/(Bearer\s+)[^\s"']+/gi, '$1[redacted]');
  return value.replace(/[\r\n]+/g, ' ').slice(0, 500);
}

function clean(text: string): string {
  return text.slice(0, 2_000);
}

function asRecord(value: unknown, message: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new DeciderError('error', message);
  return value as Record<string, unknown>;
}