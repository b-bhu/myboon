import { extractJson, HermesService } from '../hermes'
import { InferenceGatewayError } from './errors'
import { mapHermesInferenceError } from './hermes-adapter'
import type {
  HermesClassificationAdapter,
  HermesClassificationCall,
  HermesClassificationResponse,
  JevAnswer,
  JevClassificationAdapter,
  JevClassificationCall,
  JevClassificationResponse,
  JevQuestion,
} from './classification-types'

const DEFAULT_JEV_ENDPOINT = 'https://api.typesafe.ai/v1/systemone'

export interface JevSystemOneAdapterOptions {
  apiToken: string
  endpoint?: string
  fetchImpl?: typeof fetch
}

/** A single HTTP attempt. Retries are deliberately owned by the gateway and are disabled for Jev v1. */
export class JevSystemOneAdapter implements JevClassificationAdapter {
  private readonly apiToken: string
  private readonly endpoint: string
  private readonly fetchImpl: typeof fetch

  constructor(options: JevSystemOneAdapterOptions) {
    this.apiToken = requiredSecret(options.apiToken)
    this.endpoint = requiredText(options.endpoint ?? DEFAULT_JEV_ENDPOINT, 'Jev endpoint')
    this.fetchImpl = options.fetchImpl ?? fetch
  }

  async classify(request: JevClassificationCall): Promise<JevClassificationResponse> {
    const startedAt = Date.now()
    let response: Response
    try {
      response = await this.fetchImpl(this.endpoint, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: request.target.model,
          state: request.state,
          questions: request.questions,
        }),
        signal: request.signal,
      })
    } catch (error) {
      const timeout = request.signal.aborted
      throw new InferenceGatewayError(timeout ? 'Jev classification timed out' : 'Jev classification provider is unavailable', {
        category: timeout ? 'provider_timeout' : 'provider_unavailable',
        retryable: true,
        provider: request.target.provider,
        model: request.target.model,
        cause: error,
      })
    }
    if (!response.ok) {
      const category = response.status === 429 ? 'provider_rate_limited'
        : response.status === 401 || response.status === 403 ? 'provider_authentication'
          : response.status >= 500 ? 'provider_unavailable' : 'invalid_structured_output'
      throw new InferenceGatewayError(`Jev classification failed with HTTP ${response.status}`, {
        category,
        retryable: category === 'provider_rate_limited' || category === 'provider_unavailable',
        provider: request.target.provider,
        model: request.target.model,
      })
    }

    let value: unknown
    try { value = await response.json() } catch (error) {
      throw invalidJev('Jev classification response is not JSON', request, error)
    }
    const root = record(value, 'Jev response must be an object', request)
    const actualModel = boundedText(root.model, 'Jev response model', 200, request)
    if (actualModel !== request.target.model) {
      throw new InferenceGatewayError(`Jev returned wrong model ${actualModel}`, {
        category: 'schema_version_mismatch', retryable: false,
        provider: request.target.provider, model: actualModel,
      })
    }
    const rawAnswers = record(root.answers, 'Jev response answers must be an object', request)
    const answers: Record<string, JevAnswer> = {}
    const expectedKeys = Object.keys(request.questions).sort()
    if (Object.keys(rawAnswers).sort().join('\0') !== expectedKeys.join('\0')) {
      throw invalidJev('Jev response must contain exactly the registry questions', request)
    }
    for (const key of expectedKeys) answers[key] = parseAnswer(rawAnswers[key], request.questions[key]!, key, request)
    const usage = record(root.usage, 'Jev response usage must be an object', request)
    return {
      actualProvider: request.target.provider,
      actualModel,
      answers: Object.freeze(answers),
      usage: {
        inputTokens: nonNegativeInteger(usage.input_tokens, 'Jev input_tokens', request),
        outputTokens: nonNegativeInteger(usage.output_tokens, 'Jev output_tokens', request),
        ...(usage.cost_usd_micros === undefined ? {} : {
          costUsdMicros: nonNegativeInteger(usage.cost_usd_micros, 'Jev cost_usd_micros', request),
        }),
      },
      durationMs: Math.max(0, Date.now() - startedAt),
    }
  }
}

export interface HermesDecisionAdapterOptions {
  service: Pick<HermesService, 'oneshot'>
  profile?: string
  estimateTokens?: (text: string) => number
}

export class HermesDecisionAdapter implements HermesClassificationAdapter {
  private readonly service: Pick<HermesService, 'oneshot'>
  private readonly profile?: string
  private readonly estimateTokens: (text: string) => number

  constructor(options: HermesDecisionAdapterOptions) {
    this.service = options.service
    this.profile = options.profile
    this.estimateTokens = options.estimateTokens ?? ((text) => Math.ceil(text.length / 4))
  }

  async classify(request: HermesClassificationCall): Promise<HermesClassificationResponse> {
    const startedAt = Date.now()
    try {
      const result = await this.service.oneshot({
        purpose: `classification.${request.workload}`,
        prompt: request.prompt,
        timeoutMs: request.deadlineMs,
        profile: this.profile,
        provider: request.target.provider,
        model: request.target.model,
      })
      return {
        actualProvider: request.target.provider,
        actualModel: request.target.model,
        value: extractJson<unknown>(result.stdout),
        usage: {
          inputTokens: this.estimateTokens(request.prompt),
          outputTokens: this.estimateTokens(result.stdout),
        },
        durationMs: Math.max(0, Date.now() - startedAt),
      }
    } catch (error) {
      throw mapHermesInferenceError(error, request.target)
    }
  }
}

function parseAnswer(
  value: unknown,
  question: JevQuestion,
  key: string,
  request: JevClassificationCall,
): JevAnswer {
  const answer = record(value, `${key} must be an object`, request)
  if (answer.type !== question.type) throw invalidJev(`${key}.type must be ${question.type}`, request)
  if (question.type === 'noul') {
    return Object.freeze({ type: 'noul' as const, noul: probability(answer.noul, `${key}.noul`, request) })
  }
  const probabilities = probabilityMap(answer.probabilities, `${key}.probabilities`, request)
  const confidence = probability(answer.confidence, `${key}.confidence`, request)
  if (question.type === 'choice') {
    const choice = boundedText(answer.choice, `${key}.choice`, 200, request)
    const allowed = Object.keys(question.criteria)
    if (!allowed.includes(choice)) throw invalidJev(`${key}.choice is not registry-defined`, request)
    requireProbabilityKeys(probabilities, allowed, key, request)
    return Object.freeze({ type: 'choice' as const, choice, probabilities: Object.freeze(probabilities), confidence })
  }
  const score = answer.score
  if (typeof score !== 'number' || !Number.isFinite(score)) throw invalidJev(`${key}.score must be finite`, request)
  const expectedLevels = question.criteria.map((_item, index) => String(index))
  requireProbabilityKeys(probabilities, expectedLevels, key, request)
  if (score < 0 || score > question.criteria.length - 1) throw invalidJev(`${key}.score is outside the registry levels`, request)
  const legend = record(answer.legend, `${key}.legend must be an object`, request)
  if (Object.keys(legend).sort().join('\0') !== expectedLevels.sort().join('\0')) {
    throw invalidJev(`${key}.legend must contain exactly the registry levels`, request)
  }
  for (const [index, criterion] of question.criteria.entries()) {
    if (JSON.stringify(legend[String(index)]) !== JSON.stringify(criterion)) {
      throw invalidJev(`${key}.legend does not match registry criteria`, request)
    }
  }
  return Object.freeze({
    type: 'score' as const, score, legend: Object.freeze(legend),
    probabilities: Object.freeze(probabilities), confidence,
  })
}

function requireProbabilityKeys(
  probabilities: Record<string, number>,
  expected: readonly string[],
  key: string,
  request: JevClassificationCall,
): void {
  if (Object.keys(probabilities).sort().join('\0') !== [...expected].sort().join('\0')) {
    throw invalidJev(`${key}.probabilities must contain exactly the registry choices`, request)
  }
  const sum = Object.values(probabilities).reduce((total, current) => total + current, 0)
  if (Math.abs(sum - 1) > 0.02) throw invalidJev(`${key}.probabilities must sum to one`, request)
}

function probabilityMap(value: unknown, field: string, request: JevClassificationCall): Record<string, number> {
  const raw = record(value, `${field} must be an object`, request)
  return Object.fromEntries(Object.entries(raw).map(([key, item]) => [key, probability(item, `${field}.${key}`, request)]))
}

function probability(value: unknown, field: string, request: JevClassificationCall): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
    throw invalidJev(`${field} must be between zero and one`, request)
  }
  return value
}

function nonNegativeInteger(value: unknown, field: string, request: JevClassificationCall): number {
  if (!Number.isInteger(value) || Number(value) < 0) throw invalidJev(`${field} must be a non-negative integer`, request)
  return Number(value)
}

function record(value: unknown, message: string, request: JevClassificationCall): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalidJev(message, request)
  return value as Record<string, unknown>
}

function boundedText(value: unknown, field: string, max: number, request: JevClassificationCall): string {
  if (typeof value !== 'string' || value.trim() === '' || value.trim().length > max) {
    throw invalidJev(`${field} must be non-empty text of at most ${max} characters`, request)
  }
  return value.trim()
}

function invalidJev(message: string, request: JevClassificationCall, cause?: unknown): InferenceGatewayError {
  return new InferenceGatewayError(message, {
    category: 'invalid_structured_output', retryable: false,
    provider: request.target.provider, model: request.target.model, cause,
  })
}

function requiredText(value: string, field: string): string {
  const result = value.trim()
  if (!result) throw new Error(`${field} is required`)
  return result
}

function requiredSecret(value: string): string {
  const result = value.trim()
  if (!result) throw new Error('JEV_API_TOKEN is required')
  return result
}
