import type { ChildProcess, SpawnOptions } from 'node:child_process'
import { HermesService } from '../hermes'
import { AgentBrowserReader, type AgentBrowserReadResult } from './agent-browser-reader'
import { appendRetrievedSourceToResearchPrompt } from './research-contract'
import type {
  HermesWorkerClientOptions,
  HermesWorkerRequest,
  HermesWorkerResult,
  HermesWorkerStatus,
} from './types'

const DEFAULT_HERMES_PROFILE = 'myboonfeed'
const DEFAULT_HERMES_TOOLSETS = ['browser', 'web']
const DEFAULT_AGENT_BROWSER_READ_TIMEOUT_MS = 30_000
const DEFAULT_AGENT_BROWSER_MAX_OUTPUT_CHARS = 40_000

type SpawnHermesProcess = (
  command: string,
  args: string[],
  options: SpawnOptions
) => ChildProcess

type SourceReader = Pick<AgentBrowserReader, 'read'> & Partial<Pick<AgentBrowserReader, 'vetForBrowserFallback'>>

export interface HermesWorkerClientConstructorOptions extends Partial<HermesWorkerClientOptions> {
  spawnProcess?: SpawnHermesProcess
  /** Preferred injection point: a shared HermesService instance. */
  service?: HermesService
  /** Deterministic test seam; production uses the service's cross-process pools. */
  limiter?: { acquire(timeoutMs: number): Promise<{ release(): void }> }
  reader?: SourceReader
  directReadEnabled?: boolean
  browserFallbackEnabled?: boolean
  agentBrowserCommand?: string
  agentBrowserReadTimeoutMs?: number
  agentBrowserMaxOutputChars?: number
}

/**
 * Hybrid news researcher:
 *  1. Read the known article URL with agent-browser's HTTP-only read command.
 *  2. Give that bounded, untrusted document to lightweight Hermes oneshot.
 *  3. Fall back to the existing Hermes browser/web chat only when the direct
 *     source read is unavailable, blocked, too short, or times out.
 */
export class HermesWorkerClient {
  private readonly profile?: string
  private readonly toolsets: string[]
  private readonly service: HermesService
  private readonly reader: SourceReader
  private readonly directReadEnabled: boolean
  private readonly browserFallbackEnabled: boolean

  constructor(options: HermesWorkerClientConstructorOptions = {}) {
    const command = options.command ?? process.env.NEWS_HERMES_COMMAND
    this.profile = options.profile ?? process.env.NEWS_HERMES_PROFILE ?? DEFAULT_HERMES_PROFILE
    this.toolsets = options.toolsets ?? toolsetsFromEnv(process.env.NEWS_HERMES_TOOLSETS) ?? DEFAULT_HERMES_TOOLSETS
    this.service = options.service ?? new HermesService({
      command,
      spawnImpl: options.spawnProcess,
      limiter: options.limiter,
    })
    this.directReadEnabled = options.directReadEnabled
      ?? enabledFromEnv(process.env.NEWS_AGENT_BROWSER_DIRECT_READ_ENABLED, true)
    this.browserFallbackEnabled = options.browserFallbackEnabled
      ?? enabledFromEnv(process.env.NEWS_HERMES_BROWSER_FALLBACK_ENABLED, true)
    this.reader = options.reader ?? new AgentBrowserReader({
      command: options.agentBrowserCommand,
      timeoutMs: options.agentBrowserReadTimeoutMs
        ?? positiveIntegerFromEnv(process.env.NEWS_AGENT_BROWSER_READ_TIMEOUT_MS, DEFAULT_AGENT_BROWSER_READ_TIMEOUT_MS),
      maxOutputChars: options.agentBrowserMaxOutputChars
        ?? positiveIntegerFromEnv(process.env.NEWS_AGENT_BROWSER_MAX_OUTPUT_CHARS, DEFAULT_AGENT_BROWSER_MAX_OUTPUT_CHARS),
    })
  }

  async run(request: HermesWorkerRequest): Promise<HermesWorkerResult> {
    if (!Number.isFinite(request.timeoutMs) || request.timeoutMs <= 0) {
      throw new Error(`Hermes worker timeoutMs must be positive for job ${request.jobId}`)
    }

    const startedAtMs = Date.now()
    let sourceRead: AgentBrowserReadResult | null = null
    if (this.directReadEnabled && request.sourceUrl) {
      sourceRead = await this.reader.read(request.sourceUrl)
      if (sourceRead.status === 'succeeded') {
        return this.runStructured(request, sourceRead, startedAtMs)
      }
      if (!sourceRead.fallbackAllowed) {
        return failedWithoutFallback(request, sourceRead, startedAtMs)
      }
    }
    if (!this.directReadEnabled && request.sourceUrl && this.reader.vetForBrowserFallback) {
      sourceRead = await this.reader.vetForBrowserFallback(request.sourceUrl)
      if (!sourceRead.fallbackAllowed) {
        return failedWithoutFallback(request, sourceRead, startedAtMs)
      }
    }

    if (!this.browserFallbackEnabled) {
      return failedWithoutFallback(request, sourceRead, startedAtMs)
    }
    if (request.sourceUrl && (!sourceRead || sourceRead.allowedFallbackDomains.length === 0)) {
      return failedWithoutFallback(
        request,
        sourceRead,
        startedAtMs,
        'failed',
        'Hermes browser fallback refused an unvetted source URL',
      )
    }

    const remainingTimeoutMs = request.timeoutMs - (Date.now() - startedAtMs)
    if (remainingTimeoutMs <= 0) {
      return failedWithoutFallback(request, sourceRead, startedAtMs, 'timed_out')
    }
    const result = await this.service.chat({
      purpose: `news.worker.${request.taskType}.browser_fallback`,
      prompt: request.prompt,
      timeoutMs: remainingTimeoutMs,
      profile: this.profile,
      toolsets: sourceRead?.allowedFallbackDomains.length
        ? ['browser']
        : this.toolsets,
      ...(sourceRead?.allowedFallbackDomains.length
        ? { env: { AGENT_BROWSER_ALLOWED_DOMAINS: sourceRead.allowedFallbackDomains.join(',') } }
        : {}),
    })

    return {
      jobId: request.jobId,
      taskType: request.taskType,
      status: result.status,
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
      startedAt: new Date(startedAtMs).toISOString(),
      finishedAt: result.finishedAt,
      durationMs: Date.now() - startedAtMs,
      executionMode: 'hermes_browser_fallback',
      sourceReadStatus: sourceRead?.status ?? 'skipped',
      sourceReadDurationMs: sourceRead?.durationMs ?? 0,
      sourceReadError: sourceRead?.error ?? null,
    }
  }

  private async runStructured(
    request: HermesWorkerRequest,
    sourceRead: AgentBrowserReadResult,
    startedAtMs: number,
  ): Promise<HermesWorkerResult> {
    const prompt = appendRetrievedSourceToResearchPrompt({
      prompt: request.prompt,
      requestedUrl: request.sourceUrl!,
      finalUrl: sourceRead.finalUrl,
      content: sourceRead.content,
      truncated: sourceRead.truncated,
    })
    const remainingTimeoutMs = request.timeoutMs - (Date.now() - startedAtMs)
    if (remainingTimeoutMs <= 0) {
      return structuredFailure(request, sourceRead, startedAtMs, 'timed_out', 'News research timed out after source read')
    }

    try {
      const result = await this.service.oneshot({
        purpose: `news.worker.${request.taskType}.direct_read`,
        prompt,
        timeoutMs: remainingTimeoutMs,
        ignoreRules: true,
      })
      const finishedAtMs = Date.now()
      return {
        jobId: request.jobId,
        taskType: request.taskType,
        status: 'succeeded',
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: 0,
        startedAt: new Date(startedAtMs).toISOString(),
        finishedAt: new Date(finishedAtMs).toISOString(),
        durationMs: finishedAtMs - startedAtMs,
        executionMode: 'agent_browser_read',
        sourceReadStatus: 'succeeded',
        sourceReadDurationMs: sourceRead.durationMs,
        sourceReadError: null,
      }
    } catch (error) {
      return structuredFailure(
        request,
        sourceRead,
        startedAtMs,
        isTimeoutError(error) ? 'timed_out' : 'failed',
        safeError(error),
      )
    }
  }
}

function structuredFailure(
  request: HermesWorkerRequest,
  sourceRead: AgentBrowserReadResult,
  startedAtMs: number,
  status: HermesWorkerStatus,
  error: string,
): HermesWorkerResult {
  const finishedAtMs = Date.now()
  return {
    jobId: request.jobId,
    taskType: request.taskType,
    status,
    stdout: '',
    stderr: error,
    exitCode: null,
    startedAt: new Date(startedAtMs).toISOString(),
    finishedAt: new Date(finishedAtMs).toISOString(),
    durationMs: finishedAtMs - startedAtMs,
    executionMode: 'agent_browser_read',
    sourceReadStatus: 'succeeded',
    sourceReadDurationMs: sourceRead.durationMs,
    sourceReadError: null,
  }
}

function failedWithoutFallback(
  request: HermesWorkerRequest,
  sourceRead: AgentBrowserReadResult | null,
  startedAtMs: number,
  status: HermesWorkerStatus = 'failed',
  errorOverride?: string,
): HermesWorkerResult {
  const finishedAtMs = Date.now()
  return {
    jobId: request.jobId,
    taskType: request.taskType,
    status,
    stdout: '',
    stderr: errorOverride ?? sourceRead?.error ?? 'Direct source read was skipped and Hermes browser fallback is disabled',
    exitCode: null,
    startedAt: new Date(startedAtMs).toISOString(),
    finishedAt: new Date(finishedAtMs).toISOString(),
    durationMs: finishedAtMs - startedAtMs,
    executionMode: 'agent_browser_read',
    sourceReadStatus: sourceRead?.status ?? 'skipped',
    sourceReadDurationMs: sourceRead?.durationMs ?? 0,
    sourceReadError: sourceRead?.error ?? null,
  }
}

function toolsetsFromEnv(value: string | undefined): string[] | undefined {
  if (value == null) return undefined
  return value.split(',').map((item) => item.trim()).filter(Boolean)
}

function enabledFromEnv(value: string | undefined, fallback: boolean): boolean {
  if (value == null || value.trim() === '') return fallback
  return !['0', 'false', 'no', 'off'].includes(value.trim().toLowerCase())
}

function positiveIntegerFromEnv(value: string | undefined, fallback: number): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : fallback
}

function isTimeoutError(error: unknown): boolean {
  const value = error as { killed?: unknown, signal?: unknown, code?: unknown }
  return value?.killed === true || value?.signal === 'SIGTERM' || value?.code === 'ETIMEDOUT'
}

function safeError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 800)
}
