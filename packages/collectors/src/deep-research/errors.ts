import type { DeepResearchErrorCategory, DeepResearchExecutionMetadata } from './types'

export interface DeepResearchErrorOptions {
  category: DeepResearchErrorCategory
  retryable: boolean
  metadata?: DeepResearchExecutionMetadata
  cause?: unknown
}
export class DeepResearchError extends Error {
  readonly category: DeepResearchErrorCategory
  readonly retryable: boolean
  readonly metadata?: DeepResearchExecutionMetadata

  constructor(message: string, options: DeepResearchErrorOptions) {
    super(message, { cause: options.cause })
    this.name = 'DeepResearchError'
    this.category = options.category
    this.retryable = options.retryable
    this.metadata = options.metadata
  }
}
