import {
  HERMES_PROVIDER_CIRCUIT_OPEN_CODE,
  HermesProviderCircuitOpenError,
  HermesService,
  extractJson,
} from '../hermes'
import { InferenceGatewayError } from './errors'
import type {
  InferenceProviderTarget,
  StructuredProviderAdapter,
  StructuredProviderRequest,
  StructuredProviderResult,
} from './types'

export interface HermesStructuredAdapterOptions {
  service: Pick<HermesService, 'oneshot'>
  /** Optional shared Hermes profile; provider/model always come from the route target. */
  profile?: string
  estimateTokens?: (text: string) => number
}

type LegacyHermesError = Error & {
  code?: string | number | null
  status?: number
  statusCode?: number
  killed?: boolean
  signal?: string
  stderr?: string
  stdout?: string
  retryAfterMs?: number
}

const CONNECTION_CODES = new Set([
  'ECONNABORTED',
  'ECONNREFUSED',
  'ECONNRESET',
  'EPIPE',
  'EHOSTUNREACH',
  'ENETDOWN',
  'ENETUNREACH',
  'ENOTFOUND',
  'EAI_AGAIN',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_SOCKET',
])

/** All compatibility message parsing is intentionally confined to this adapter. */
export function mapHermesInferenceError(
  error: unknown,
  target: InferenceProviderTarget,
): InferenceGatewayError {
  if (error instanceof InferenceGatewayError) return error

  const value = error as LegacyHermesError
  const code = typeof value?.code === 'string' ? value.code.toUpperCase() : value?.code
  const status = value?.status ?? value?.statusCode
  const metadata = { provider: target.provider, model: target.model, cause: error }

  if (error instanceof HermesProviderCircuitOpenError || code === HERMES_PROVIDER_CIRCUIT_OPEN_CODE) {
    return new InferenceGatewayError('Hermes provider circuit is open', {
      category: 'circuit_open',
      retryable: true,
      retryAfterMs: value.retryAfterMs,
      ...metadata,
    })
  }
  if (value?.killed === true || value?.signal === 'SIGTERM' || code === 'ETIMEDOUT') {
    return new InferenceGatewayError('Hermes provider call timed out', {
      category: 'provider_timeout', retryable: true, ...metadata,
    })
  }
  if (status === 429) {
    return new InferenceGatewayError('Hermes provider rate limited the call', {
      category: 'provider_rate_limited', retryable: true, retryAfterMs: value.retryAfterMs, ...metadata,
    })
  }
  if (status === 401 || status === 403) {
    return new InferenceGatewayError('Hermes provider authentication failed', {
      category: 'provider_authentication', retryable: false, ...metadata,
    })
  }
  if (typeof code === 'string' && CONNECTION_CODES.has(code)) {
    return new InferenceGatewayError('Hermes provider is unavailable', {
      category: 'provider_unavailable', retryable: true, ...metadata,
    })
  }

  const text = [
    error instanceof Error ? error.message : String(error),
    typeof value?.stderr === 'string' ? value.stderr : '',
    typeof value?.stdout === 'string' ? value.stdout : '',
  ].filter(Boolean).join('\n')

  if (/\b(?:401|403)\b|no usable credentials|api[_ -]?key|unauthorized|authentication/i.test(text)) {
    return new InferenceGatewayError('Hermes provider authentication failed', {
      category: 'provider_authentication', retryable: false, ...metadata,
    })
  }
  if (/\b429\b|rate[ _-]?limit|too many requests|quota|capacity exhausted/i.test(text)) {
    return new InferenceGatewayError('Hermes provider rate limited the call', {
      category: 'provider_rate_limited', retryable: true, retryAfterMs: value?.retryAfterMs, ...metadata,
    })
  }
  if (/timed? ?out|timeout/i.test(text)) {
    return new InferenceGatewayError('Hermes provider call timed out', {
      category: 'provider_timeout', retryable: true, ...metadata,
    })
  }
  return new InferenceGatewayError('Hermes provider is unavailable', {
    category: 'provider_unavailable', retryable: true, ...metadata,
  })
}

export class HermesStructuredAdapter implements StructuredProviderAdapter {
  private readonly service: Pick<HermesService, 'oneshot'>
  private readonly profile?: string
  private readonly estimateTokens: (text: string) => number

  constructor(options: HermesStructuredAdapterOptions) {
    this.service = options.service
    this.profile = options.profile
    this.estimateTokens = options.estimateTokens ?? ((text) => Math.ceil(text.length / 4))
  }

  async generate(request: StructuredProviderRequest): Promise<StructuredProviderResult> {
    const target = request.target
    try {
      // Never pass toolsets or call chat: structured inference is ephemeral and tool-less.
      const result = await this.service.oneshot({
        purpose: request.purpose,
        prompt: request.prompt,
        timeoutMs: request.timeoutMs,
        profile: this.profile,
        provider: target.provider,
        model: target.model,
      })
      return {
        value: extractJson<unknown>(result.stdout),
        rawOutput: result.stdout,
        usage: {
          inputTokens: this.estimateTokens(request.prompt),
          outputTokens: this.estimateTokens(result.stdout),
        },
        actualProvider: target.provider,
        actualModel: target.model,
      }
    } catch (error) {
      throw mapHermesInferenceError(error, target)
    }
  }
}
