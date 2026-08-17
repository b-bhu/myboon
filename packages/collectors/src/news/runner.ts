import { buildResearchPrompt, buildResearchRequest, parseResearchResponse } from './research-contract'
import {
  DEFAULT_NEWS_RESEARCH_BACKLOG_WARN_AGE_MS,
  DEFAULT_NEWS_RESEARCH_BACKLOG_WARN_COUNT,
  DEFAULT_NEWS_RESEARCH_BATCH_SIZE,
  DEFAULT_NEWS_RESEARCH_CONCURRENCY,
  MAX_NEWS_RESEARCH_CONCURRENCY,
} from './runtime-config'
import type { NewsStore, RecoverStaleNewsWorkResult } from './store'
import type { HermesWorkerRequest, HermesWorkerResult } from './types'

export interface NewsResearchRunnerOptions {
  researchTimeoutMs: number
  batchSize: number
  concurrency: number
  staleWorkCutoffMs: number
  backlogWarnCount: number
  backlogWarnAgeMs: number
  now?: Date
}

export interface NewsResearchFailure {
  stage: 'research'
  sourceId?: string
  urlId?: string
  candidateId?: string
  error: string
}

export interface NewsResearchRunResult {
  researchCandidatesFetched: number
  researchConcurrency: number
  researchProcessed: number
  researchSucceeded: number
  researchFailed: number
  researchResultsInserted: number
  jsonValidationFailures: number
  failures: NewsResearchFailure[]
}

export interface NewsResearchBacklogStatus {
  pendingCandidates: number | null
  oldestPendingObservedAt: string | null
  oldestPendingAgeMs: number | null
  warning: boolean
  readError: string | null
}

export interface NewsResearchPipelineRunResult extends NewsResearchRunResult {
  recoveredStaleResearchCandidates: number
  backlog: NewsResearchBacklogStatus
}

type HermesRunner = {
  run(request: HermesWorkerRequest): Promise<HermesWorkerResult>
}

const DEFAULT_NEWS_RESEARCH_OPTIONS: NewsResearchRunnerOptions = {
  researchTimeoutMs: 10 * 60_000,
  batchSize: DEFAULT_NEWS_RESEARCH_BATCH_SIZE,
  concurrency: DEFAULT_NEWS_RESEARCH_CONCURRENCY,
  staleWorkCutoffMs: 30 * 60_000,
  backlogWarnCount: DEFAULT_NEWS_RESEARCH_BACKLOG_WARN_COUNT,
  backlogWarnAgeMs: DEFAULT_NEWS_RESEARCH_BACKLOG_WARN_AGE_MS,
}

export async function recoverStaleNewsWork(
  store: NewsStore,
  options: Partial<Pick<NewsResearchRunnerOptions, 'now' | 'staleWorkCutoffMs'>> = {},
): Promise<RecoverStaleNewsWorkResult> {
  const now = options.now ?? new Date()
  const cutoffMs = options.staleWorkCutoffMs ?? DEFAULT_NEWS_RESEARCH_OPTIONS.staleWorkCutoffMs
  return store.recoverStaleWork({
    candidateCutoffIso: new Date(now.getTime() - cutoffMs).toISOString(),
  })
}

export async function runPendingNewsResearch(input: {
  store: NewsStore
  hermes: HermesRunner
  options?: Partial<NewsResearchRunnerOptions>
}): Promise<NewsResearchRunResult> {
  const options = newsResearchRunnerOptions(input.options)
  const candidates = await input.store.claimPendingCandidateObservations(options.batchSize)
  const result: NewsResearchRunResult = {
    researchCandidatesFetched: candidates.length,
    researchConcurrency: candidates.length === 0 ? 0 : Math.min(options.concurrency, candidates.length),
    researchProcessed: 0,
    researchSucceeded: 0,
    researchFailed: 0,
    researchResultsInserted: 0,
    jsonValidationFailures: 0,
    failures: [],
  }

  await runWithConcurrency(candidates, options.concurrency, async (candidate) => {
    result.researchProcessed += 1
    const request = buildResearchRequest(candidate, options.now)
    let worker: HermesWorkerResult | null = null
    try {
      await input.store.markCandidateResearchStarted(candidate.id, request.job_id)
      worker = await input.hermes.run({
        jobId: request.job_id,
        taskType: 'source_aware_research',
        prompt: buildResearchPrompt(request),
        timeoutMs: options.researchTimeoutMs,
      })
      if (worker.status !== 'succeeded') {
        throw new Error(`Hermes research ${worker.status}: ${worker.stderr.slice(0, 500)}`)
      }
      const response = parseResearchResponse(worker.stdout, {
        jobId: request.job_id,
        candidateId: candidate.id,
        sourceId: candidate.sourceId,
        urlId: candidate.urlId,
      })
      await input.store.insertResearchResult({
        candidate,
        response,
        researchedAt: response.source_signal.observed_at || request.requested_at,
      })
      result.researchSucceeded += 1
      result.researchResultsInserted += 1
    } catch (error) {
      const message = errorMessage(error)
      const isValidation = /response|schema|JSON|candidate_id|source_id|url_id|job_id/i.test(message)
      await input.store.recordCandidateResearchFailure({
        id: candidate.id,
        jobId: request.job_id,
        workerStatus: worker?.status ?? null,
        error: message,
        rawResponse: worker?.stdout ?? null,
        stderr: worker?.stderr ?? null,
      })
      result.researchFailed += 1
      result.jsonValidationFailures += isValidation ? 1 : 0
      result.failures.push({
        stage: 'research',
        sourceId: candidate.sourceId,
        urlId: candidate.urlId,
        candidateId: candidate.id,
        error: message,
      })
    }
  })

  return result
}

async function runWithConcurrency<T>(
  items: T[],
  concurrency: number,
  run: (item: T) => Promise<void>,
): Promise<void> {
  let nextIndex = 0
  const workerCount = Math.min(Math.max(1, concurrency), items.length)
  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex
      nextIndex += 1
      await run(items[index])
    }
  }))
}

async function readResearchBacklogStatus(
  store: NewsStore,
  options: NewsResearchRunnerOptions,
): Promise<NewsResearchBacklogStatus> {
  try {
    const backlog = await store.readResearchBacklog()
    const oldestTime = backlog.oldestPendingObservedAt
      ? Date.parse(backlog.oldestPendingObservedAt)
      : NaN
    const nowMs = (options.now ?? new Date()).getTime()
    const oldestPendingAgeMs = Number.isFinite(oldestTime)
      ? Math.max(0, nowMs - oldestTime)
      : null
    return {
      pendingCandidates: backlog.pendingCandidates,
      oldestPendingObservedAt: backlog.oldestPendingObservedAt,
      oldestPendingAgeMs,
      warning: backlog.pendingCandidates >= options.backlogWarnCount
        || (oldestPendingAgeMs !== null && oldestPendingAgeMs >= options.backlogWarnAgeMs),
      readError: null,
    }
  } catch (error) {
    return {
      pendingCandidates: null,
      oldestPendingObservedAt: null,
      oldestPendingAgeMs: null,
      warning: true,
      readError: errorMessage(error),
    }
  }
}

export async function runNewsResearchPipelineOnce(input: {
  store: NewsStore
  hermes: HermesRunner
  options?: Partial<NewsResearchRunnerOptions>
}): Promise<NewsResearchPipelineRunResult> {
  const options = newsResearchRunnerOptions(input.options)
  const recovered = await recoverStaleNewsWork(input.store, {
    now: options.now,
    staleWorkCutoffMs: options.staleWorkCutoffMs,
  })
  const research = await runPendingNewsResearch({
    store: input.store,
    hermes: input.hermes,
    options,
  })
  const backlog = await readResearchBacklogStatus(input.store, options)
  return {
    recoveredStaleResearchCandidates: recovered.candidatesRecovered,
    ...research,
    backlog,
  }
}

function newsResearchRunnerOptions(
  partial: Partial<NewsResearchRunnerOptions> = {},
): NewsResearchRunnerOptions {
  const options = {
    ...DEFAULT_NEWS_RESEARCH_OPTIONS,
    ...partial,
  }
  return {
    ...options,
    concurrency: Math.min(
      Math.max(1, Math.trunc(options.concurrency)),
      MAX_NEWS_RESEARCH_CONCURRENCY,
    ),
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
