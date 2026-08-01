import type { ChildProcess, SpawnOptions } from 'node:child_process'
import { HermesService } from '../hermes'
import type {
  HermesWorkerClientOptions,
  HermesWorkerRequest,
  HermesWorkerResult,
} from './types'

const DEFAULT_HERMES_PROFILE = 'myboonfeed'
const DEFAULT_HERMES_TOOLSETS = ['browser', 'web']

type SpawnHermesProcess = (
  command: string,
  args: string[],
  options: SpawnOptions
) => ChildProcess

export interface HermesWorkerClientConstructorOptions extends Partial<HermesWorkerClientOptions> {
  spawnProcess?: SpawnHermesProcess
  /** Preferred injection point: a shared HermesService instance. spawnProcess
   * is kept for back-compat with existing tests/callers and threads into an
   * internally-built service when no service is supplied. */
  service?: HermesService
}

/**
 * News-lane adapter over the central HermesService (see src/hermes/).
 *
 * This class used to own its own spawn/timeout/settle plumbing; that logic
 * now lives in HermesService.chat verbatim. What remains here is only the
 * news-worker envelope: per-request jobId/taskType threading and the
 * NEWS_HERMES_* env configuration.
 */
export class HermesWorkerClient {
  private readonly profile?: string
  private readonly toolsets: string[]
  private readonly service: HermesService

  constructor(options: HermesWorkerClientConstructorOptions = {}) {
    const command = options.command ?? process.env.NEWS_HERMES_COMMAND
    this.profile = options.profile ?? process.env.NEWS_HERMES_PROFILE ?? DEFAULT_HERMES_PROFILE
    this.toolsets = options.toolsets ?? toolsetsFromEnv(process.env.NEWS_HERMES_TOOLSETS) ?? DEFAULT_HERMES_TOOLSETS
    this.service = options.service ?? new HermesService({
      command,
      spawnImpl: options.spawnProcess,
    })
  }

  async run(request: HermesWorkerRequest): Promise<HermesWorkerResult> {
    if (!Number.isFinite(request.timeoutMs) || request.timeoutMs <= 0) {
      throw new Error(`Hermes worker timeoutMs must be positive for job ${request.jobId}`)
    }

    const result = await this.service.chat({
      purpose: `news.worker.${request.taskType}`,
      prompt: request.prompt,
      timeoutMs: request.timeoutMs,
      profile: this.profile,
      toolsets: this.toolsets,
    })

    return {
      jobId: request.jobId,
      taskType: request.taskType,
      status: result.status,
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
      startedAt: result.startedAt,
      finishedAt: result.finishedAt,
      durationMs: result.durationMs,
    }
  }
}

function toolsetsFromEnv(value: string | undefined): string[] | undefined {
  if (value == null) return undefined
  return value.split(',').map((item) => item.trim()).filter(Boolean)
}
