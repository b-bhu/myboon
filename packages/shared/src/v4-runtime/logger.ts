/**
 * V4 runtime stage logger (#444).
 *
 * One JSON line per call — shaped for pm2 log files and `jq`: single line, no
 * multi-line stack traces, secrets dropped at the field level. Timestamps come
 * from an injectable clock so tests can pin them.
 */

import type { V4HealthSnapshot } from './health'

const REDACT_KEY_PATTERN = /key|token|secret|password|url/i

export interface StageLogger {
  info(msg: string, fields?: Record<string, unknown>): void
  warn(msg: string, fields?: Record<string, unknown>): void
  error(msg: string, fields?: Record<string, unknown>): void
  /** Log a {@link V4HealthSnapshot} as one 'health' line with its fields. */
  health(snapshot: V4HealthSnapshot): void
}

export interface CreateStageLoggerOptions {
  /** Line sink; defaults to process.stdout, one '\n'-terminated line per call. */
  write?: (line: string) => void
  /** Clock for the ts field; defaults to wall-clock. */
  now?: () => Date
}

/** Turn any value into something JSON.stringify renders plainly. */
function deserializeValue(value: unknown, seen?: WeakSet<object>): unknown {
  if (value instanceof Error) return { name: value.name, message: value.message }
  if (Array.isArray(value)) {
    const cycles = seen ?? new WeakSet<object>()
    cycles.add(value)
    return value.map((item) => deserializeValue(item, cycles))
  }
  if (value !== null && typeof value === 'object') {
    const cycles = seen ?? new WeakSet<object>()
    if (cycles.has(value as object)) return '[circular]'
    cycles.add(value as object)
    const plain = value as Record<string, unknown>
    const out: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(plain)) {
      // Redact by key, recursively, before serialization.
      out[key] = REDACT_KEY_PATTERN.test(key) ? '[redacted]' : deserializeValue(item, cycles)
    }
    return out
  }
  return value
}

export function createStageLogger(
  stage: string,
  opts: CreateStageLoggerOptions = {},
): StageLogger {
  const write = opts.write ?? ((line: string) => { process.stdout.write(line) })
  const now = opts.now ?? (() => new Date())

  function emit(level: 'info' | 'warn' | 'error', msg: string, fields?: object): void {
    const entry: Record<string, unknown> = { ts: now().toISOString(), level, stage, msg }
    for (const [key, value] of Object.entries(fields ?? {})) {
      entry[key] = REDACT_KEY_PATTERN.test(key) ? '[redacted]' : deserializeValue(value)
    }
    let line: string
    try {
      line = JSON.stringify(entry)
    } catch {
      // A circular or BigInt field must never take down a worker loop.
      line = JSON.stringify({ ts: entry.ts, level, stage, msg, logError: 'entry serialization failed' })
    }
    write(line + '\n')
  }

  return {
    info: (msg, fields) => emit('info', msg, fields),
    warn: (msg, fields) => emit('warn', msg, fields),
    error: (msg, fields) => emit('error', msg, fields),
    health: (snapshot) => emit('info', 'health', snapshot),
  }
}