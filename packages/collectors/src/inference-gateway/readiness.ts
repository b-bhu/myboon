import type { ResearchWorkItem } from '../signal-platform/contracts'
import type {
  ResearchWorkerStage,
  StageReadinessDecision,
  StageReadinessPort,
} from '../research-engine/shared-worker'
import type { InferenceGateway } from './gateway'

/** Queue-facing view of the gateway's structured synthesis route health. */
export class InferenceGatewayStageReadiness implements StageReadinessPort {
  constructor(
    private readonly gateway: Pick<InferenceGateway, 'checkReadiness'>,
    private readonly synthesisWorkload = 'research.synthesis',
  ) {}

  async checkStage(stage: ResearchWorkerStage): Promise<StageReadinessDecision> {
    if (stage === 'retrieval') return { ready: true }
    return this.checkSynthesis()
  }

  async check(input: { stage: ResearchWorkerStage | 'deep_research', workItem: ResearchWorkItem }) {
    if (input.stage !== 'synthesis') return { ready: true } as const
    return this.checkSynthesis()
  }

  private checkSynthesis() {
    const readiness = this.gateway.checkReadiness(this.synthesisWorkload)
    if (readiness.ready) return { ready: true } as const
    return {
      ready: false,
      category: 'circuit_open' as const,
      detail: 'All configured structured synthesis routes have open circuits',
      retryAfterMs: readiness.retryAfterMs,
    }
  }
}
