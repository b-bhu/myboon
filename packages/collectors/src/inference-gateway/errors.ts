import type { InferenceFailureCategory, InferenceTelemetry } from './types'

export interface InferenceGatewayErrorOptions {
  category: InferenceFailureCategory
  retryable: boolean
  retryAfterMs?: number
  provider?: string
  model?: string
  telemetry?: InferenceTelemetry
  /** True only when an adapter returned a provider response that was rejected locally. */
  providerResponseReceived?: boolean
  cause?: unknown
}

export class InferenceGatewayError extends Error {
  readonly category: InferenceFailureCategory
  readonly retryable: boolean
  /** Milliseconds until a retry may be attempted, when the provider reports it. */
  readonly retryAfterMs?: number
  /** Alias retained on the public error metadata for consumers using the PRD name. */
  readonly retryAfter?: number
  readonly provider?: string
  readonly model?: string
  readonly telemetry?: InferenceTelemetry
  readonly providerResponseReceived: boolean

  constructor(message: string, options: InferenceGatewayErrorOptions) {
    super(message, { cause: options.cause })
    this.name = 'InferenceGatewayError'
    this.category = options.category
    this.retryable = options.retryable
    this.retryAfterMs = options.retryAfterMs
    this.retryAfter = options.retryAfterMs
    this.provider = options.provider
    this.model = options.model
    this.telemetry = options.telemetry
    this.providerResponseReceived = options.providerResponseReceived === true
  }

  withTelemetry(telemetry: InferenceTelemetry): InferenceGatewayError {
    return new InferenceGatewayError(this.message, {
      category: this.category,
      retryable: this.retryable,
      retryAfterMs: this.retryAfterMs,
      provider: this.provider,
      model: this.model,
      telemetry,
      providerResponseReceived: this.providerResponseReceived,
      cause: this.cause,
    })
  }
}
