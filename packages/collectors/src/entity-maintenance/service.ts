import { buildEntityMaintenanceCandidates } from './candidates'
import {
  ENTITY_CATALOG_MAINTENANCE_PROMPT_VERSION,
  type EntityCatalogMaintenanceMode,
  type EntityCatalogMaintenanceRunResult,
  type EntityCatalogMaintenanceScope,
  type EntityCatalogMaintenanceStore,
  type EntityCatalogMaintenanceTrigger,
  type EntityIdentityJudge,
  type EntityMaintenanceFindingInput,
} from './contracts'
import { findingFromJudgment } from './decision-policy'

const DEFAULT_BATCH_SIZE = 8
const DEFAULT_LEASE_MS = 30 * 60_000

export interface EntityCatalogMaintenanceServiceOptions {
  store: EntityCatalogMaintenanceStore
  judge: EntityIdentityJudge
  provider: string
  model: string
  batchSize?: number
  leaseMs?: number
  logger?: (message: string) => void
}

export interface RunEntityCatalogMaintenanceInput {
  trigger: EntityCatalogMaintenanceTrigger
  mode?: EntityCatalogMaintenanceMode
  scope?: EntityCatalogMaintenanceScope
  changedSince?: string
}

export class EntityCatalogMaintenanceService {
  private readonly store: EntityCatalogMaintenanceStore
  private readonly judge: EntityIdentityJudge
  private readonly provider: string
  private readonly model: string
  private readonly batchSize: number
  private readonly leaseMs: number
  private readonly logger: (message: string) => void

  constructor(options: EntityCatalogMaintenanceServiceOptions) {
    this.store = options.store
    this.judge = options.judge
    this.provider = nonEmpty(options.provider, 'provider')
    this.model = nonEmpty(options.model, 'model')
    this.batchSize = positiveInteger(options.batchSize ?? DEFAULT_BATCH_SIZE, 'batchSize')
    this.leaseMs = positiveInteger(options.leaseMs ?? DEFAULT_LEASE_MS, 'leaseMs')
    this.logger = options.logger ?? ((message) => console.log(message))
  }

  async run(input: RunEntityCatalogMaintenanceInput): Promise<EntityCatalogMaintenanceRunResult> {
    const mode = input.mode ?? 'dry_run'
    const scope = input.scope ?? 'full_catalog'
    // Mutation execution deliberately remains a separate, explicitly approved
    // operation. The scheduled analysis process cannot acquire mutation power
    // merely by changing its inference output.
    if (mode !== 'dry_run') {
      throw new Error('Entity catalogue maintenance analysis currently supports dry_run mode only.')
    }
    const run = await this.store.beginRun({
      trigger: input.trigger,
      mode,
      scope,
      provider: this.provider,
      model: this.model,
      promptVersion: ENTITY_CATALOG_MAINTENANCE_PROMPT_VERSION,
      leaseMs: this.leaseMs,
    })

    try {
      const profiles = await this.store.listProfiles(scope, input.changedSince)
      const allCandidates = buildEntityMaintenanceCandidates(profiles)
      const candidates = scope === 'incremental'
        ? incrementalCandidates(allCandidates, requiredTimestamp(input.changedSince, 'changedSince'))
        : allCandidates
      const findings: EntityMaintenanceFindingInput[] = []
      const batchErrors: Array<{ pairKeys: string[], error: string }> = []
      this.logger(`[entity-maintenance] run=${run.id} scanned=${profiles.length} candidates=${candidates.length}`)

      for (let offset = 0; offset < candidates.length; offset += this.batchSize) {
        const batch = candidates.slice(offset, offset + this.batchSize)
        try {
          const judgments = await this.judge.judge(batch)
          const batchByPair = new Map(batch.map((candidate) => [candidate.pairKey, candidate]))
          const batchFindings = judgments.map((judgment) => {
            const candidate = batchByPair.get(judgment.pairKey)
            if (!candidate) throw new Error(`Identity judge returned unknown pair ${judgment.pairKey}.`)
            return findingFromJudgment(run.id, candidate, judgment)
          })
          await this.store.saveFindings(batchFindings)
          findings.push(...batchFindings)
        } catch (error) {
          batchErrors.push({
            pairKeys: batch.map((candidate) => candidate.pairKey),
            error: errorMessage(error).slice(0, 800),
          })
        }
        await this.store.heartbeatRun(run.id, this.leaseMs)
      }

      const mergeProposalCount = findings.filter((finding) => finding.recommendedAction === 'merge').length
      const aliasQuarantineCount = findings.filter((finding) => finding.recommendedAction === 'quarantine_alias').length
      const uncertainCount = findings.filter((finding) => finding.recommendedAction === 'review').length
      const status = findings.length === candidates.length ? 'completed' : 'partial'
      const completion = {
        status,
        catalogCount: profiles.length,
        candidateCount: candidates.length,
        reviewedCount: findings.length,
        mergeProposalCount,
        aliasQuarantineCount,
        uncertainCount,
        summary: {
          mode,
          scope,
          batchSize: this.batchSize,
          failedBatchCount: batchErrors.length,
          batchErrors,
          autoApplyEligibleCount: findings.filter((finding) => finding.autoApplyEligible).length,
          mutationCount: 0,
        },
      } as const
      await this.store.completeRun(run.id, completion)
      return { runId: run.id, mode, scope, ...completion }
    } catch (error) {
      await this.store.failRun(run.id, errorMessage(error).slice(0, 2_000))
      throw error
    }
  }
}

function positiveInteger(value: number, field: string): number {
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${field} must be a positive integer.`)
  return value
}

function nonEmpty(value: string, field: string): string {
  const cleaned = value.trim()
  if (!cleaned) throw new Error(`${field} is required.`)
  return cleaned
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function requiredTimestamp(value: string | undefined, field: string): number {
  const parsed = value ? Date.parse(value) : Number.NaN
  if (!Number.isFinite(parsed)) throw new Error(`${field} must be a valid timestamp for incremental maintenance.`)
  return parsed
}

function incrementalCandidates(
  candidates: ReturnType<typeof buildEntityMaintenanceCandidates>,
  changedSinceMs: number,
): ReturnType<typeof buildEntityMaintenanceCandidates> {
  return candidates.filter((candidate) => (
    Date.parse(candidate.left.changedAt) >= changedSinceMs
    || Date.parse(candidate.right.changedAt) >= changedSinceMs
  ))
}
