import { positiveInteger } from '../pipeline-store/cli-env'
import type { XDeskProvider, XDeskReviewInput, XDeskRunResult, XDeskSource } from './types'
import { XDeskStore } from './store'

const DEFAULT_BATCH_SIZE = 20
const DEFAULT_CHANGE_PAGE_SIZE = 100
const DEFAULT_MAX_INTAKE_PAGES = 100
const DEFAULT_INITIAL_LOOKBACK_HOURS = 24
const DEFAULT_MAX_RECOMMENDATIONS = 5
export const X_DESK_MAX_RECOMMENDATIONS = 5
const DEFAULT_PRIOR_POST_LIMIT = 20
const DEFAULT_RETRY_DELAY_MS = 15 * 60 * 1000
const DEFAULT_MAX_ATTEMPTS = 3

export interface XDeskCliConfig {
  batchSize: number
  changePageSize: number
  maxIntakePages: number
  initialLookbackHours: number
  maxRecommendations: number
  priorPostLimit: number
  retryDelayMs: number
  maxAttempts: number
  dbPath: string | undefined
}

export interface RunXDeskOptions {
  source: XDeskSource
  store: XDeskStore
  provider: XDeskProvider
  now?: string
  batchSize?: number
  changePageSize?: number
  maxIntakePages?: number
  initialLookbackHours?: number
  maxRecommendations?: number
  priorPostLimit?: number
  retryDelayMs?: number
  maxAttempts?: number
}

export function xDeskCliConfig(env: NodeJS.ProcessEnv = process.env): XDeskCliConfig {
  return {
    batchSize: positiveInteger(env.X_DESK_BATCH_SIZE, DEFAULT_BATCH_SIZE),
    changePageSize: positiveInteger(env.X_DESK_CHANGE_PAGE_SIZE, DEFAULT_CHANGE_PAGE_SIZE),
    maxIntakePages: positiveInteger(env.X_DESK_MAX_INTAKE_PAGES, DEFAULT_MAX_INTAKE_PAGES),
    initialLookbackHours: positiveInteger(env.X_DESK_INITIAL_LOOKBACK_HOURS, DEFAULT_INITIAL_LOOKBACK_HOURS),
    maxRecommendations: positiveInteger(env.X_DESK_MAX_RECOMMENDATIONS, DEFAULT_MAX_RECOMMENDATIONS),
    priorPostLimit: positiveInteger(env.X_DESK_PRIOR_POST_LIMIT, DEFAULT_PRIOR_POST_LIMIT),
    retryDelayMs: positiveInteger(env.X_DESK_RETRY_DELAY_MS, DEFAULT_RETRY_DELAY_MS),
    maxAttempts: positiveInteger(env.X_DESK_MAX_ATTEMPTS, DEFAULT_MAX_ATTEMPTS),
    dbPath: env.X_DESK_DB_PATH?.trim() || undefined,
  }
}

export function isNewsMemory(change: Parameters<XDeskStore['enqueuePage']>[0][number]): boolean {
  const provenance = change.memory.provenance
  return provenance.provider === 'news'
    && (provenance.sourceType === 'news' || provenance.sourceType === 'article')
}

function safeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message.slice(0, 1_000)
}

export async function runXDesk(options: RunXDeskOptions): Promise<XDeskRunResult> {
  const observedAt = options.now ?? new Date().toISOString()
  const batchSize = Math.min(options.batchSize ?? DEFAULT_BATCH_SIZE, 50)
  const changePageSize = Math.min(options.changePageSize ?? DEFAULT_CHANGE_PAGE_SIZE, 100)
  const maxIntakePages = options.maxIntakePages ?? DEFAULT_MAX_INTAKE_PAGES
  const initialLookbackHours = options.initialLookbackHours ?? DEFAULT_INITIAL_LOOKBACK_HOURS
  const maxRecommendations = Math.min(
    options.maxRecommendations ?? DEFAULT_MAX_RECOMMENDATIONS,
    X_DESK_MAX_RECOMMENDATIONS,
    batchSize,
  )
  const priorPostLimit = options.priorPostLimit ?? DEFAULT_PRIOR_POST_LIMIT
  const retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS
  const proposedCutoff = new Date(Date.parse(observedAt) - initialLookbackHours * 3_600_000).toISOString()
  const initialCutoff = options.store.initialCutoff(proposedCutoff, observedAt)

  let changesScanned = 0
  let newsChangesQueued = 0
  let intakeHasMore = false
  for (let pageNumber = 0; pageNumber < maxIntakePages; pageNumber += 1) {
    const page = await options.source.getChanges(options.store.cursor(), changePageSize)
    changesScanned += page.changes.length
    const eligible = page.changes.filter((change) => (
      change.changedAt >= initialCutoff
      && isNewsMemory(change)
    ))
    newsChangesQueued += options.store.enqueuePage(eligible, page.nextCursor, observedAt)
    intakeHasMore = page.hasMore
    if (!page.hasMore) break
  }

  const candidates = options.store.fetchWork(batchSize, observedAt, maxAttempts)
  if (candidates.length === 0) {
    return {
      observedAt, changesScanned, newsChangesQueued, candidatesReviewed: 0,
      recommended: 0, skipped: 0, failed: 0, intakeHasMore, recommendations: [],
    }
  }

  let entities: Awaited<ReturnType<XDeskSource['getEntities']>>
  try {
    entities = await options.source.getEntities(candidates.map((candidate) => candidate.entityId))
    const inputs: XDeskReviewInput[] = candidates.map((candidate) => ({
      candidateId: candidate.id,
      entity: entities.get(candidate.entityId) ?? {
        id: candidate.entityId,
        slug: candidate.entitySlug ?? candidate.entityId,
        name: candidate.entityName ?? candidate.memory.title,
        type: 'unknown',
        summary: null,
      },
      memory: candidate.memory,
    }))
    const decisions = await options.provider.decide(
      inputs,
      options.store.recentPostTexts(priorPostLimit),
      maxRecommendations,
    )
    options.store.recordDecisions(decisions, entities, candidates, observedAt)
    const recommendations = decisions.flatMap((decision) => {
      if (decision.action !== 'recommend' || !decision.postText) return []
      const candidate = candidates.find((item) => item.id === decision.candidateId)!
      const entity = entities.get(candidate.entityId)
      return [{
        candidateId: decision.candidateId,
        entityName: entity?.name ?? candidate.memory.title,
        postText: decision.postText,
        rationale: decision.rationale,
        confidence: decision.confidence,
        sourceMemoryId: candidate.memoryId,
      }]
    })
    return {
      observedAt,
      changesScanned,
      newsChangesQueued,
      candidatesReviewed: decisions.length,
      recommended: recommendations.length,
      skipped: decisions.filter((decision) => decision.action === 'skip').length,
      failed: 0,
      intakeHasMore,
      recommendations,
    }
  } catch (error) {
    options.store.recordFailure(
      candidates.map((candidate) => candidate.id),
      safeError(error),
      new Date(Date.parse(observedAt) + retryDelayMs).toISOString(),
      maxAttempts,
      observedAt,
    )
    return {
      observedAt, changesScanned, newsChangesQueued, candidatesReviewed: candidates.length,
      recommended: 0, skipped: 0, failed: candidates.length, intakeHasMore, recommendations: [],
    }
  }
}
