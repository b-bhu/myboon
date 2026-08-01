import { execFile, spawn, type ChildProcess, type SpawnOptions } from 'node:child_process'
import { promisify } from 'node:util'
import { extractJson } from './json'

/**
 * Central Hermes invocation service.
 *
 * Every stage that talks to the `hermes` CLI goes through this one class.
 * Before it existed there were SEVEN independent invocation points across six
 * files (researcher planner + reflection, entity extractor, polymarket
 * editor, polymarket publisher, editor-draft provider, news worker), each
 * with its own execFile/spawn plumbing, its own copy of JSON extraction, and
 * no shared visibility into what was actually being spent on LLM calls.
 *
 * The CLI is invoked in exactly two shapes, and both are preserved verbatim:
 *
 *  - oneshot: `hermes [--ignore-rules] [-t <toolsets>] -z <prompt>` -
 *    buffered execFile, one prompt in, stdout out. Used by every structured
 *    (JSON-answer) call site.
 *  - chat: `hermes chat [--profile <p>] [--toolsets <a,b>] --quiet --query
 *    <prompt>` - streaming spawn with a caller-owned timeout, used where the
 *    model runs tools (browser/web) and takes minutes, historically only by
 *    the news worker. The research engine uses this mode too: it is the
 *    "actually read pages" mode.
 *
 * Deliberate design decisions:
 *  - oneshot RETHROWS the underlying execFile error untouched. Call sites
 *    have stage-specific error handling (the researcher planner falls back
 *    to a deterministic plan, the extractor wraps into a sanitized message,
 *    editor/publisher let it propagate to their runners). Centralizing
 *    invocation must not silently rewrite those semantics.
 *  - chat NEVER rejects for process-level failures; it resolves a status
 *    envelope ('succeeded' | 'failed' | 'timed_out') exactly like the news
 *    HermesWorkerClient contract it absorbed. It throws only on caller
 *    programming errors (non-positive timeout).
 *  - every call - success or failure, either mode - emits one
 *    HermesCallRecord to the observer. This is the instrumentation seed the
 *    sprint's cost-measurement work (issue #260's baseline) hangs off:
 *    purpose, duration, and payload sizes per call, without logging prompt
 *    contents anywhere.
 */

const execFileAsync = promisify(execFile)

const DEFAULT_COMMAND = 'hermes'
const DEFAULT_MAX_BUFFER_BYTES = 10 * 1024 * 1024

export type HermesCallMode = 'oneshot' | 'chat'
export type HermesCallStatus = 'succeeded' | 'failed' | 'timed_out'

export interface HermesCallRecord {
  purpose: string
  mode: HermesCallMode
  command: string
  status: HermesCallStatus
  startedAt: string
  finishedAt: string
  durationMs: number
  /** Prompt SIZE only - prompt contents are never recorded. */
  promptChars: number
  stdoutChars: number
  stderrChars: number
  exitCode: number | null
  error: string | null
}

export type HermesCallObserver = (record: HermesCallRecord) => void

type ExecFileImpl = (
  command: string,
  args: string[],
  options: { timeout: number, maxBuffer: number, env: NodeJS.ProcessEnv }
) => Promise<{ stdout: string, stderr: string }>

type SpawnImpl = (command: string, args: string[], options: SpawnOptions) => ChildProcess

export interface HermesServiceOptions {
  /** CLI command, default 'hermes' (or HERMES_COMMAND). Per-stage env vars
   * like POLYMARKET_EDITOR_COMMAND keep working - stages pass their resolved
   * command in here (or per call via commandOverride). */
  command?: string
  observer?: HermesCallObserver
  /** Test seams. Production uses node:child_process. */
  execFileImpl?: ExecFileImpl
  spawnImpl?: SpawnImpl
}

export interface HermesOneshotRequest {
  /** Stable dotted identifier for observability, e.g. 'polymarket.researcher.planner'. */
  purpose: string
  prompt: string
  timeoutMs: number
  /** Value for `-t` - comma-separated toolsets string, omitted when empty. */
  toolsets?: string
  /** Adds `--ignore-rules` (researcher/extractor legacy behavior). */
  ignoreRules?: boolean
  maxBufferBytes?: number
  commandOverride?: string
}

export interface HermesOneshotResult {
  stdout: string
  stderr: string
}

export interface HermesStructuredResult<T> extends HermesOneshotResult {
  /** Parsed JSON payload, or null when stdout contained no parseable JSON.
   * Callers decide whether null is a fallback case or an error. */
  value: T | null
}

export interface HermesChatRequest {
  purpose: string
  prompt: string
  timeoutMs: number
  profile?: string
  toolsets?: string[]
  commandOverride?: string
}

export interface HermesChatResult {
  status: HermesCallStatus
  stdout: string
  stderr: string
  exitCode: number | null
  startedAt: string
  finishedAt: string
  durationMs: number
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function oneshotStatus(error: unknown): HermesCallStatus {
  const anyError = error as { killed?: unknown, signal?: unknown }
  return anyError && anyError.killed === true && typeof anyError.signal === 'string' ? 'timed_out' : 'failed'
}

export class HermesService {
  private readonly command: string
  private readonly observer: HermesCallObserver | null
  private readonly execFileImpl: ExecFileImpl
  private readonly spawnImpl: SpawnImpl

  constructor(options: HermesServiceOptions = {}) {
    this.command = options.command ?? process.env.HERMES_COMMAND ?? DEFAULT_COMMAND
    this.observer = options.observer ?? null
    this.execFileImpl = options.execFileImpl ?? (execFileAsync as unknown as ExecFileImpl)
    this.spawnImpl = options.spawnImpl ?? spawn
  }

  private record(record: HermesCallRecord): void {
    if (!this.observer) return
    try {
      this.observer(record)
    } catch {
      // Observability must never break the call it observes.
    }
  }

  async oneshot(request: HermesOneshotRequest): Promise<HermesOneshotResult> {
    const command = request.commandOverride ?? this.command
    const args = [
      ...(request.ignoreRules ? ['--ignore-rules'] : []),
      ...(request.toolsets ? ['-t', request.toolsets] : []),
      '-z',
      request.prompt,
    ]
    const startedAtMs = Date.now()
    try {
      const { stdout, stderr } = await this.execFileImpl(command, args, {
        timeout: request.timeoutMs,
        maxBuffer: request.maxBufferBytes ?? DEFAULT_MAX_BUFFER_BYTES,
        env: { ...process.env },
      })
      const finishedAtMs = Date.now()
      this.record({
        purpose: request.purpose,
        mode: 'oneshot',
        command,
        status: 'succeeded',
        startedAt: new Date(startedAtMs).toISOString(),
        finishedAt: new Date(finishedAtMs).toISOString(),
        durationMs: finishedAtMs - startedAtMs,
        promptChars: request.prompt.length,
        stdoutChars: stdout.length,
        stderrChars: stderr.length,
        exitCode: 0,
        error: null,
      })
      return { stdout, stderr }
    } catch (error) {
      const finishedAtMs = Date.now()
      this.record({
        purpose: request.purpose,
        mode: 'oneshot',
        command,
        status: oneshotStatus(error),
        startedAt: new Date(startedAtMs).toISOString(),
        finishedAt: new Date(finishedAtMs).toISOString(),
        durationMs: finishedAtMs - startedAtMs,
        promptChars: request.prompt.length,
        stdoutChars: 0,
        stderrChars: 0,
        exitCode: null,
        error: errorMessage(error).slice(0, 800),
      })
      throw error
    }
  }

  async structured<T>(request: HermesOneshotRequest): Promise<HermesStructuredResult<T>> {
    const { stdout, stderr } = await this.oneshot(request)
    return { value: extractJson<T>(stdout), stdout, stderr }
  }

  chat(request: HermesChatRequest): Promise<HermesChatResult> {
    if (!Number.isFinite(request.timeoutMs) || request.timeoutMs <= 0) {
      throw new Error(`Hermes chat timeoutMs must be positive for purpose ${request.purpose}`)
    }
    const command = request.commandOverride ?? this.command
    const args = ['chat']
    if (request.profile) args.push('--profile', request.profile)
    if (request.toolsets && request.toolsets.length > 0) args.push('--toolsets', request.toolsets.join(','))
    args.push('--quiet', '--query', request.prompt)

    const startedAtMs = Date.now()
    const startedAt = new Date(startedAtMs).toISOString()
    const child = this.spawnImpl(command, args, {
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    let stdout = ''
    let stderr = ''
    let exitCode: number | null = null
    let settled = false

    child.stdout?.on('data', (chunk) => {
      stdout += chunk.toString()
    })
    child.stderr?.on('data', (chunk) => {
      stderr += chunk.toString()
    })

    return new Promise((resolve) => {
      const finish = (status: HermesCallStatus) => {
        if (settled) return
        settled = true
        clearTimeout(timeout)
        const finishedAtMs = Date.now()
        const result: HermesChatResult = {
          status,
          stdout,
          stderr,
          exitCode,
          startedAt,
          finishedAt: new Date(finishedAtMs).toISOString(),
          durationMs: finishedAtMs - startedAtMs,
        }
        this.record({
          purpose: request.purpose,
          mode: 'chat',
          command,
          status,
          startedAt,
          finishedAt: result.finishedAt,
          durationMs: result.durationMs,
          promptChars: request.prompt.length,
          stdoutChars: stdout.length,
          stderrChars: stderr.length,
          exitCode,
          error: status === 'succeeded' ? null : (stderr.slice(0, 800) || status),
        })
        resolve(result)
      }

      const timeout = setTimeout(() => {
        child.kill('SIGTERM')
        exitCode = null
        finish('timed_out')
      }, request.timeoutMs)

      child.once('error', (error) => {
        stderr += stderr ? `\n${error.message}` : error.message
        exitCode = null
        finish('failed')
      })

      child.once('close', (code) => {
        exitCode = typeof code === 'number' ? code : null
        finish(exitCode === 0 ? 'succeeded' : 'failed')
      })
    })
  }
}
