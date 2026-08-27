import type { ContainedInvestigationPort, InvestigateRequest, InferenceProviderTarget } from '../inference-gateway'
import { DeepResearchError } from './errors'
import { DeepResearchExecutor } from './executor'
import type { DeepResearchJob, DeepResearchResult } from './types'

/** The only gateway bridge: it delegates the opaque job to the contained executor. */
export class DeepResearchGatewayPort implements ContainedInvestigationPort {
  constructor(private readonly executor: Pick<DeepResearchExecutor, 'execute'>) {}

  async execute(request: InvestigateRequest & {
    target?: InferenceProviderTarget
    reasoningEffort?: 'low' | 'medium' | 'high'
  }) {
    if (!request.job || typeof request.job !== 'object') {
      throw new DeepResearchError('Investigate request requires a canonical deep-research job', {
        category: 'invalid_job', retryable: false,
      })
    }
    const job = request.job as DeepResearchJob
    if (request.workload !== 'research.deep') {
      throw new DeepResearchError('Contained deep research requires workload research.deep', {
        category: 'invalid_job', retryable: false,
      })
    }
    const requestedCapabilities = new Set(request.allowedCapabilities)
    const jobCapabilities = new Set(job.capabilities)
    if (requestedCapabilities.size !== request.allowedCapabilities.length
      || requestedCapabilities.size !== jobCapabilities.size
      || [...requestedCapabilities].some((capability) => !jobCapabilities.has(capability as never))) {
      throw new DeepResearchError('Gateway capabilities must exactly match the contained job allowlist', {
        category: 'invalid_job', retryable: false,
      })
    }
    if (request.policyVersion !== job.workItem.policyVersion) {
      throw new DeepResearchError('Gateway policyVersion must match the contained work item', {
        category: 'invalid_job', retryable: false,
      })
    }
    if (!request.target) throw new DeepResearchError('Gateway target is required', { category: 'invalid_job', retryable: false })
    if (job.inference.provider !== request.target.provider || job.inference.model !== request.target.model
      || job.inference.reasoningEffort !== request.reasoningEffort) {
      throw new DeepResearchError('Gateway route policy must exactly match the contained job', {
        category: 'invalid_job', retryable: false,
      })
    }
    if (request.budget.maxRepairCalls !== 0
      || request.budget.maxProviderCalls !== job.budget.maxProviderCalls
      || request.budget.maxInputTokens !== job.budget.maxInputTokens
      || request.budget.maxOutputTokens !== job.budget.maxOutputTokens
      || request.budget.maxToolCalls !== job.budget.maxToolCalls
      || request.budget.maxWallTimeMs !== job.budget.maxWallTimeMs) {
      throw new DeepResearchError('Gateway and contained job budgets must match exactly', {
        category: 'invalid_job', retryable: false,
      })
    }
    const result = await this.executor.execute(job, {
      signal: request.signal, onExecutionStarted: request.onExecutionStarted,
    })
    return {
      value: result,
      actualProvider: request.target.provider,
      actualModel: request.target.model,
      usage: {
        providerCalls: result.budgetUsed.providerCalls,
        inputTokens: result.budgetUsed.inputTokens,
        outputTokens: result.budgetUsed.outputTokens,
        toolCalls: result.budgetUsed.toolCalls,
        wallTimeMs: result.budgetUsed.wallTimeMs,
      },
    }
  }
}
