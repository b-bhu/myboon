/**
 * JSONL error log for pipeline workers.
 *
 * Workers previously reported failures only through console/stderr, which PM2
 * truncates and interleaves with the workers' stdout JSON. This module appends
 * one redacted JSON line per failure to a single file (MYBOON_ERROR_LOG, by
 * default ~/myboon-logs/errors.jsonl) so an operator can answer "which worker
 * failed, when, why, how often" with plain grep. Writes are synchronous on
 * purpose: uncaught-exception logging must complete before the process exits.
 * The writer never throws - a failing log write must not be able to kill (or
 * crash-loop) a worker that is already failing.
 */
import { appendFileSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export type ErrorLogKind =
  | 'run_failed'
  | 'cycle_failed'
  | 'recovery_failed'
  | 'unhandled_rejection'
  | 'uncaught_exception'
  | 'ledger_start_failed'
  | 'ledger_finish_failed'
  | 'trace_append_failed'
  | 'supabase_unavailable'

/** Supabase health-gate transition: outage first seen, inside the outage, or recovered (Ref #346). */
export type ErrorLogHealthState = 'down' | 'still_down' | 'recovered'

export interface ErrorLogEntry {
  app: string
  kind: ErrorLogKind
  error: unknown
  count?: number
  /** Health-gate state transition; only set on supabase_unavailable entries. */
  state?: ErrorLogHealthState
  /** Milliseconds from the first observed outage to recovery; only set on recovered entries. */
  downtimeMs?: number
}

export interface AppendErrorLogOptions {
  env?: NodeJS.ProcessEnv
  now?: Date
  path?: string
}

export interface ProcessErrorLogOptions {
  /** Exit hook, injectable for tests. Defaults to process.exit. */
  exit?: (code: number) => void
  /** Append hook, injectable for tests. Defaults to appendErrorLog. */
  append?: (entry: ErrorLogEntry) => void
}

export interface ProcessErrorHandlers {
  onUnhandledRejection: (reason: unknown) => void
  onUncaughtException: (error: unknown) => void
}

const MESSAGE_MAX_LENGTH = 1000
const STACK_MAX_LENGTH = 2048
const CAUSE_MAX_LENGTH = 500
const CODE_MAX_LENGTH = 100
/** Cause-walk depth: outer cause first, deeper grandchild causes are dropped. */
const MAX_CAUSE_DEPTH = 2
const TRUNCATION_MARKER = '…[truncated]'
const REDACTION_MARKER = '[REDACTED]'

/**
 * Ordered redaction rules. Credential-bearing URLs run first so later rules
 * redact what they leave behind, not the reverse.
 */
const REDACTION_PATTERNS: ReadonlyArray<{ pattern: RegExp, replacement: string }> = [
  // scheme://user:password@ (postgres, postgresql, mysql, redis, mongodb(+srv)
  // and any other scheme), keeping the scheme so the line stays readable.
  {
    pattern: /([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)(?:[^\s/@:]+:[^\s/@]+|:[^\s/@]+)@/g,
    replacement: `$1${REDACTION_MARKER}@`,
  },
  // Authorization-style bearer tokens.
  { pattern: /\b(bearer\s+)\S+/gi, replacement: `$1${REDACTION_MARKER}` },
  // JWT-shaped tokens: three base64url segments with the standard {" header prefix.
  { pattern: /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, replacement: REDACTION_MARKER },
  // Common API key shapes: OpenAI, Stripe, GitHub, Slack, AWS access key ids.
  {
    pattern: /\b(?:sk-[A-Za-z0-9_-]{8,}|sk_live_[A-Za-z0-9]{8,}|pk_live_[A-Za-z0-9]{8,}|ghp_[A-Za-z0-9]{8,}|gho_[A-Za-z0-9]{8,}|github_pat_[A-Za-z0-9_]{8,}|xox[abp]-[A-Za-z0-9-]{8,}|AKIA[0-9A-Z]{16})/g,
    replacement: REDACTION_MARKER,
  },
  // Named secret fields in key=value, key: value and "key": "value" forms
  // (case-insensitive). The name must END with one of the secret words, with
  // an optional [A-Za-z0-9_-]* prefix, so env-var style names such as
  // SUPABASE_SERVICE_ROLE_KEY and x-api-key are covered, while ordinary words
  // like "keyboard" are not. The key name is kept; only the value is redacted.
  {
    pattern: /(["']?[A-Za-z0-9_-]*(?:access_token|api_key|apikey|password|passwd|secret|token|pwd|key)(?![A-Za-z0-9_-])["']?\s*[=:]\s*)(?:"[^"]*"|'[^']*'|[^\s,;&}]+)/gi,
    replacement: `$1${REDACTION_MARKER}`,
  },
]

function truncate(text: string, maxLength: number): string {
  return text.length <= maxLength ? text : text.slice(0, maxLength) + TRUNCATION_MARKER
}

/** Property reads with a safety net: getters, Proxies or host objects must not
 * be able to derail a failing worker's last log write. */
function readProperty(source: unknown, key: string): unknown {
  if (source === null || typeof source !== 'object') return undefined
  try {
    return (source as Record<string, unknown>)[key]
  } catch {
    return undefined
  }
}

function asText(value: unknown): string {
  try {
    return String(value)
  } catch {
    return '<unprintable error>'
  }
}

/** The real message of Errors and PostgrestError-like plain objects alike. */
function errorMessage(error: unknown): string {
  // A missing error (e.g. the recovered health-gate entry) is an empty
  // message, not the string "undefined".
  if (error === null || error === undefined) return ''
  const message = readProperty(error, 'message')
  if (typeof message === 'string' && message !== '') return message
  if (error instanceof Error) return typeof message === 'string' ? message : ''
  return asText(error)
}

/** Code (e.g. PostgrestError PGRST codes, errno strings): only meaningful as a
 * string or number; redacted and truncated like every other free-form field. */
function readCode(source: unknown): string | null {
  const code = readProperty(source, 'code')
  if (typeof code !== 'string' && typeof code !== 'number') return null
  return truncate(redactSecrets(asText(code)), CODE_MAX_LENGTH)
}

/** PostgrestError details/hint: only string values carry information. */
function readTextField(source: unknown, key: string): string | null {
  const value = readProperty(source, key)
  if (typeof value !== 'string' || value === '') return null
  return value
}

/**
 * Cause chain, outer cause first, capped at MAX_CAUSE_DEPTH levels. The
 * identity set stops cycles (cause === self, or a → b → a); stacks of causes
 * are never included.
 */
function collectCauses(error: unknown): Array<{ message: string, code?: string }> {
  const causes: Array<{ message: string, code?: string }> = []
  const seen = new Set<unknown>([error])
  let current: unknown = readProperty(error, 'cause')
  while (current !== undefined && current !== null && causes.length < MAX_CAUSE_DEPTH) {
    if (seen.has(current)) break
    seen.add(current)
    const message = truncate(redactSecrets(errorMessage(current)), CAUSE_MAX_LENGTH)
    const code = readCode(current)
    causes.push(code === null ? { message } : { message, code })
    current = readProperty(current, 'cause')
  }
  return causes
}

export function redactSecrets(text: string): string {
  let redacted = text
  for (const { pattern, replacement } of REDACTION_PATTERNS) {
    redacted = redacted.replace(pattern, replacement)
  }
  return redacted
}

export function resolveErrorLogPath(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.MYBOON_ERROR_LOG?.trim()
  if (configured) return configured
  return join(homedir(), 'myboon-logs', 'errors.jsonl')
}

/**
 * One JSONL line per failure. PostgrestError fields (code, details, hint) and
 * a bounded cause chain are recorded so Supabase network failures that only
 * surface as "fetch failed" also carry the real reason from error.cause
 * (ECONNRESET, timeout, DNS). Every field is redacted before truncation and
 * omitted when the error does not provide it; the writer must not throw.
 */
export function formatErrorLogLine(entry: ErrorLogEntry, now: Date = new Date()): string {
  const error = entry.error
  const stackValue = readProperty(error, 'stack')
  const stack = error instanceof Error && typeof stackValue === 'string' ? stackValue : null
  const record: Record<string, unknown> = {
    ts: now.toISOString(),
    app: entry.app,
    kind: entry.kind,
    message: truncate(redactSecrets(errorMessage(error)), MESSAGE_MAX_LENGTH),
    stack: stack === null ? null : truncate(redactSecrets(stack), STACK_MAX_LENGTH),
  }
  const code = readCode(error)
  if (code !== null) record.code = code
  const details = readTextField(error, 'details')
  if (details !== null) record.details = truncate(redactSecrets(details), MESSAGE_MAX_LENGTH)
  const hint = readTextField(error, 'hint')
  if (hint !== null) record.hint = truncate(redactSecrets(hint), MESSAGE_MAX_LENGTH)
  const causes = collectCauses(error)
  if (causes.length > 0) record.cause = causes
  if (entry.count !== undefined) record.count = entry.count
  if (entry.state !== undefined) record.state = entry.state
  if (entry.downtimeMs !== undefined) record.downtimeMs = entry.downtimeMs
  return `${JSON.stringify(record)}\n`
}

export function appendErrorLog(entry: ErrorLogEntry, options: AppendErrorLogOptions = {}): void {
  try {
    const path = options.path ?? resolveErrorLogPath(options.env)
    const line = formatErrorLogLine(entry, options.now)
    mkdirSync(dirname(path), { recursive: true })
    appendFileSync(path, line)
  } catch {
    // Never throw: logging must not turn an already-failing worker into a
    // crash loop. Emit the already-redacted line on stderr instead, and keep
    // the failed write's path details out of the output.
    let line: string
    try {
      line = formatErrorLogLine(entry, options.now).replace(/\n$/, '')
    } catch {
      line = JSON.stringify({ app: entry.app, kind: entry.kind, message: '<unformattable error>' })
    }
    console.error('[error-log] write failed; falling back to stderr:', line)
  }
}

export function createProcessErrorHandlers(
  app: string,
  options: ProcessErrorLogOptions = {},
): ProcessErrorHandlers {
  const append = options.append ?? ((entry: ErrorLogEntry) => appendErrorLog(entry))
  const exit = options.exit ?? ((code: number) => process.exit(code))
  return {
    // A late async failure keeps the process alive: the daemon can still make
    // progress on later ticks, so this logs and continues.
    onUnhandledRejection(reason: unknown) {
      append({ app, kind: 'unhandled_rejection', error: reason })
      console.error(`[${app}] unhandled rejection:`, reason)
    },
    // A synchronous crash stays fatal as before - the JSONL line is simply
    // written first, synchronously, so it survives the exit.
    onUncaughtException(error: unknown) {
      append({ app, kind: 'uncaught_exception', error })
      console.error(`[${app}] uncaught exception:`, error)
      exit(1)
    },
  }
}

let processErrorLoggingInstalled = false

export function installProcessErrorLogging(app: string, options: ProcessErrorLogOptions = {}): void {
  if (processErrorLoggingInstalled) return
  processErrorLoggingInstalled = true
  const { onUnhandledRejection, onUncaughtException } = createProcessErrorHandlers(app, options)
  process.on('unhandledRejection', onUnhandledRejection)
  process.on('uncaughtException', onUncaughtException)
}