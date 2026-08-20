import { execFile, spawn, type ChildProcess, type SpawnOptions } from 'node:child_process'
import { promisify } from 'node:util'
import { extractJson } from './json'
import { HermesConcurrencyLimiter } from './limiter'

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
 * The CLI is invoked in two shapes:
 *
 *  - oneshot: `hermes [--ignore-rules] [-t <toolsets>] -z <prompt>` -
 *    buffered execFile, one prompt in, stdout out. Used by every structured
 *    (JSON-answer) call site.
 *  - chat: `hermes chat [--profile <p>] [--toolsets <a,b>] --source tool
 *    --quiet --query <prompt>` - streaming spawn with a caller-owned timeout, used where the
 *    model runs tools (browser/web) and takes minutes, historically only by
 *    the news worker. The research engine uses this mode too: it is the
 *    "actually read pages" mode.
 *
 * The modes use separate cross-process concurrency budgets so long browser
 * sessions cannot starve lightweight structured calls. Chat runs are isolated
 * tool sessions: successful exits report a session id which is deleted
 * exactly, while timeout signals target the spawned Unix process group.
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
  /** Shared limiter injection for deterministic tests. Production defaults
   * to a cross-process lock-file semaphore. */
  limiter?: Pick<HermesConcurrencyLimiter, 'acquire'>
  /** Optional independent limiter injections. `limiter` remains a legacy
   * shortcut that supplies both pools when these are omitted. */
  structuredLimiter?: Pick<HermesConcurrencyLimiter, 'acquire'>
  browserLimiter?: Pick<HermesConcurrencyLimiter, 'acquire'>
  processGroupKillGraceMs?: number
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
  /** Narrow per-call environment additions, used for browser network containment. */
  env?: NodeJS.ProcessEnv
}

export interface HermesChatResult {
  status: HermesCallStatus
  stdout: string
  stderr: string
  exitCode: number | null
  startedAt: string
  finishedAt: string
  durationMs: number
  /** Hermes tool session created for this isolated call, when reported. */
  sessionId: string | null
  /** True only when the exact session above was deleted successfully. */
  sessionDeleted: boolean
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function oneshotStatus(error: unknown): HermesCallStatus {
  const anyError = error as { killed?: unknown, signal?: unknown }
  return anyError && anyError.killed === true && typeof anyError.signal === 'string' ? 'timed_out' : 'failed'
}

const SESSION_ID_PATTERN = /(?:^|\n)session_id:\s*([A-Za-z0-9_-]+)\s*(?:\n|$)/i
const SESSION_DELETE_TIMEOUT_MS = 30_000
const PROCESS_GROUP_KILL_GRACE_MS = 2_000
const PROCESS_GROUP_EXIT_CONFIRM_MS = 2_000
const PROCESS_GROUP_EXIT_POLL_MS = 50

function positiveInteger(value: string | undefined, fallback: number): number {
  if (!value) return fallback
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback
}

function sessionIdFromStderr(stderr: string): string | null {
  return stderr.match(SESSION_ID_PATTERN)?.[1] ?? null
}

function terminateProcessTree(child: ChildProcess, signal: NodeJS.Signals): void {
  if (process.platform !== 'win32' && typeof child.pid === 'number' && child.pid > 0) {
    try {
      process.kill(-child.pid, signal)
      return
    } catch {
      // Fall through when the child exited between the check and the signal,
      // or when a test/fallback spawn is not a process-group leader.
    }
  }
  try {
    child.kill(signal)
  } catch {
    // Timeout cleanup must not throw out of the timer callback.
  }
}

function processGroupIsAlive(child: ChildProcess): boolean {
  if (process.platform === 'win32' || typeof child.pid !== 'number' || child.pid <= 0) return false
  try {
    process.kill(-child.pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

async function killAndConfirmProcessGroup(child: ChildProcess): Promise<void> {
  const deadline = Date.now() + PROCESS_GROUP_EXIT_CONFIRM_MS
  do {
    terminateProcessTree(child, 'SIGKILL')
    if (!processGroupIsAlive(child)) return
    await new Promise((resolve) => setTimeout(resolve, PROCESS_GROUP_EXIT_POLL_MS))
  } while (Date.now() < deadline)
  // One final signal before releasing the concurrency lease. A process group
  // that still appears here can only be an un-reaped zombie or kernel race;
  // live descendants have received repeated uncatchable SIGKILL signals.
  terminateProcessTree(child, 'SIGKILL')
}

export class HermesService {
  private readonly command: string
  private readonly observer: HermesCallObserver | null
  private readonly execFileImpl: ExecFileImpl
  private readonly spawnImpl: SpawnImpl
  private readonly structuredLimiter: Pick<HermesConcurrencyLimiter, 'acquire'>
  private readonly browserLimiter: Pick<HermesConcurrencyLimiter, 'acquire'>
  private readonly processGroupKillGraceMs: number

  constructor(options: HermesServiceOptions = {}) {
    this.command = options.command ?? process.env.HERMES_COMMAND ?? DEFAULT_COMMAND
    this.observer = options.observer ?? null
    this.execFileImpl = options.execFileImpl ?? (execFileAsync as unknown as ExecFileImpl)
    this.spawnImpl = options.spawnImpl ?? spawn
    this.structuredLimiter = options.structuredLimiter ?? options.limiter ?? new HermesConcurrencyLimiter({
      maxConcurrency: positiveInteger(
        process.env.HERMES_STRUCTURED_MAX_CONCURRENCY,
        4,
      ),
      lockDir: process.env.HERMES_STRUCTURED_CONCURRENCY_LOCK_DIR
        ?? '/tmp/myboon-hermes-structured-slots',
    })
    this.browserLimiter = options.browserLimiter ?? options.limiter ?? new HermesConcurrencyLimiter({
      maxConcurrency: positiveInteger(
        process.env.HERMES_BROWSER_MAX_CONCURRENCY ?? process.env.HERMES_MAX_CONCURRENCY,
        2,
      ),
      lockDir: process.env.HERMES_BROWSER_CONCURRENCY_LOCK_DIR
        ?? process.env.HERMES_CONCURRENCY_LOCK_DIR
        ?? '/tmp/myboon-hermes-slots',
    })
    this.processGroupKillGraceMs = options.processGroupKillGraceMs ?? PROCESS_GROUP_KILL_GRACE_MS
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
    const lease = await this.structuredLimiter.acquire(request.timeoutMs)
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
    } finally {
      lease.release()
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
    return this.chatWithLease(request)
  }

  private async chatWithLease(request: HermesChatRequest): Promise<HermesChatResult> {
    const waitingAtMs = Date.now()
    let lease
    try {
      lease = await this.browserLimiter.acquire(request.timeoutMs)
    } catch (error) {
      const finishedAtMs = Date.now()
      const message = errorMessage(error)
      const command = request.commandOverride ?? this.command
      const result: HermesChatResult = {
        status: 'timed_out',
        stdout: '',
        stderr: message,
        exitCode: null,
        startedAt: new Date(waitingAtMs).toISOString(),
        finishedAt: new Date(finishedAtMs).toISOString(),
        durationMs: finishedAtMs - waitingAtMs,
        sessionId: null,
        sessionDeleted: false,
      }
      this.record({
        purpose: request.purpose,
        mode: 'chat',
        command,
        status: result.status,
        startedAt: result.startedAt,
        finishedAt: result.finishedAt,
        durationMs: result.durationMs,
        promptChars: request.prompt.length,
        stdoutChars: 0,
        stderrChars: message.length,
        exitCode: null,
        error: message.slice(0, 800),
      })
      return result
    }
    try {
      return await this.runChat(request)
    } finally {
      lease.release()
    }
  }

  private runChat(request: HermesChatRequest): Promise<HermesChatResult> {
    const command = request.commandOverride ?? this.command
    const args = ['chat']
    if (request.profile) args.push('--profile', request.profile)
    if (request.toolsets && request.toolsets.length > 0) args.push('--toolsets', request.toolsets.join(','))
    args.push('--source', 'tool', '--quiet', '--query', request.prompt)

    const startedAtMs = Date.now()
    const startedAt = new Date(startedAtMs).toISOString()
    const child = this.spawnImpl(command, args, {
      shell: false,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
      ...(request.env ? { env: { ...process.env, ...request.env } } : {}),
    })

    let stdout = ''
    let stderr = ''
    let exitCode: number | null = null
    let settled = false
    let timedOut = false
    let forceKill: NodeJS.Timeout | null = null

    child.stdout?.on('data', (chunk) => {
      stdout += chunk.toString()
    })
    child.stderr?.on('data', (chunk) => {
      stderr += chunk.toString()
    })

    return new Promise((resolve) => {
      const finish = async (status: HermesCallStatus) => {
        if (settled) return
        settled = true
        clearTimeout(timeout)
        if (forceKill) clearTimeout(forceKill)
        const finishedAtMs = Date.now()
        const sessionId = sessionIdFromStderr(stderr)
        const sessionDeleted = sessionId
          ? await this.deleteToolSession(command, request.profile, sessionId)
          : false
        const result: HermesChatResult = {
          status,
          stdout,
          stderr,
          exitCode,
          startedAt,
          finishedAt: new Date(finishedAtMs).toISOString(),
          durationMs: finishedAtMs - startedAtMs,
          sessionId,
          sessionDeleted,
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
        timedOut = true
        terminateProcessTree(child, 'SIGTERM')
        exitCode = null
        // Hold the shared slot for the complete cleanup sequence even if the
        // Hermes parent exits on SIGTERM while a descendant remains alive.
        forceKill = setTimeout(() => {
          void killAndConfirmProcessGroup(child).then(() => finish('timed_out'))
        }, this.processGroupKillGraceMs)
      }, request.timeoutMs)

      child.once('error', (error) => {
        stderr += stderr ? `\n${error.message}` : error.message
        exitCode = null
        if (timedOut) return
        void finish('failed')
      })

      child.once('close', (code) => {
        if (timedOut) {
          exitCode = null
          return
        }
        exitCode = typeof code === 'number' ? code : null
        void finish(exitCode === 0 ? 'succeeded' : 'failed')
      })
    })
  }

  private async deleteToolSession(command: string, profile: string | undefined, sessionId: string): Promise<boolean> {
    // Session IDs are generated by Hermes and constrained here before being
    // passed back to the CLI. Never run a broad prune from a per-job cleanup.
    if (!/^[A-Za-z0-9_-]+$/.test(sessionId)) return false
    const args = [
      ...(profile ? ['--profile', profile] : []),
      'sessions',
      'delete',
      sessionId,
      '--yes',
    ]
    try {
      await this.execFileImpl(command, args, {
        timeout: SESSION_DELETE_TIMEOUT_MS,
        maxBuffer: DEFAULT_MAX_BUFFER_BYTES,
        env: { ...process.env },
      })
      return true
    } catch {
      // A cleanup failure must not turn a successful research result into a
      // failed one. Source-tagged leftovers are safe for scheduled pruning.
      return false
    }
  }
}
