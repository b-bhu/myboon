import { buildResearchPrompt, buildResearchRequest, parseResearchResponse } from './research-contract'
import { DEFAULT_NEWS_RESEARCH_BATCH_SIZE } from './runtime-config'
import type { NewsStore, RecoverStaleNewsWorkResult } from './store'
import type { HermesWorkerRequest, HermesWorkerResult } from './types'

export interface NewsResearchRunnerOptions {
  researchTimeoutMs: number
  batchSize: number
  staleWorkCutoffMs: number
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
  researchProcessed: number
  researchSucceeded: number
  researchFailed: number
  researchResultsInserted: number
  jsonValidationFailures: number
  failures: NewsResearchFailure[]
}

export interface NewsResearchPipelineRunResult extends NewsResearchRunResult {
  recoveredStaleResearchCandidates: number
}

type HermesRunner = {
  run(request: HermesWorkerRequest): Promise<HermesWorkerResult>
}

const DEFAULT_NEWS_RESEARCH_OPTIONS: NewsResearchRunnerOptions = {
  researchTimeoutMs: 10 * 60_000,
  batchSize: DEFAULT_NEWS_RESEARCH_BATCH_SIZE,
  staleWorkCutoffMs: 30 * 60_000,
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
  const candidates = await input.store.fetchPendingCandidateObservations(options.batchSize)
  const result: NewsResearchRunResult = {
    researchCandidatesFetched: candidates.length,
    researchProcessed: 0,
    researchSucceeded: 0,
    researchFailed: 0,
    researchResultsInserted: 0,
    jsonValidationFailures: 0,
    failures: [],
  }

  for (const candidate of candidates) {
    result.researchProcessed += 1
    const request = buildResearchRequest(candidate, options.now)
    await input.store.markCandidateResearchStarted(candidate.id, request.job_id)
    let worker: HermesWorkerResult | null = null
    try {
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
  }

  return result
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
  return {
    recoveredStaleResearchCandidates: recovered.candidatesRecovered,
    ...research,
  }
}

function newsResearchRunnerOptions(
  partial: Partial<NewsResearchRunnerOptions> = {},
): NewsResearchRunnerOptions {
  return {
    ...DEFAULT_NEWS_RESEARCH_OPTIONS,
    ...partial,
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
