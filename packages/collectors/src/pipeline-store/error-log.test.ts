import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  appendErrorLog,
  createProcessErrorHandlers,
  formatErrorLogLine,
  installProcessErrorLogging,
  redactSecrets,
  resolveErrorLogPath,
  type ErrorLogEntry,
} from './error-log'

const REDACTED = '[REDACTED]'
const TRUNCATION_MARKER = '…[truncated]'

// Safety net for the one real-process install below: a stray asynchronous
// failure during the test run must never append to the operator's home log.
// The parent directory does not exist, so a real write would fail loudly on
// stderr instead of landing anywhere.
process.env.MYBOON_ERROR_LOG = join(tmpdir(), 'error-log-test-disabled', 'errors.jsonl')

test('credential-bearing URLs keep the scheme but lose the credentials', () => {
  for (const scheme of ['postgres', 'postgresql', 'mysql', 'redis', 'mongodb', 'mongodb+srv']) {
    const secret = `pw-${scheme.replace(/[^a-z]/g, '')}-123`
    const out = redactSecrets('connect via ' + scheme + ':' + '//' + 'user' + ':' + secret + '@db.internal:5432/mydb now')
    assert.ok(!out.includes(secret), `secret for ${scheme} survived: ${out}`)
    assert.ok(out.includes(`${scheme}://${REDACTED}@db.internal:5432/mydb`), `scheme not kept for ${scheme}: ${out}`)
    assert.ok(out.startsWith('connect via '), 'plain text around the URL must survive')
  }
  const emptyUser = redactSecrets('redis' + ':' + '//' + ':' + 'pw-redis-123' + '@db.internal:6379/0')
  assert.ok(!emptyUser.includes('pw-redis-123'))
  assert.equal(emptyUser, `redis://${REDACTED}@db.internal:6379/0`)
  const generic = redactSecrets('https' + ':' + '//' + 'alice' + ':' + 'hunter22' + '@example.com/path')
  assert.ok(!generic.includes('hunter22'))
  assert.equal(generic, 'https://[REDACTED]@example.com/path')
  // URLs without credentials must survive untouched.
  assert.equal(
    redactSecrets('postgres://db.internal:5432/mydb and https://example.com'),
    'postgres://db.internal:5432/mydb and https://example.com',
  )
})

test('bearer tokens are redacted case-insensitively while the scheme name survives', () => {
  const token = 'AbCdEfGhIjKlMnOpQrStUvWxYz0123456789'
  const out = redactSecrets(`Authorization: Bearer ${token}; retrying`)
  assert.ok(!out.includes(token))
  assert.ok(out.includes(`Bearer ${REDACTED}`))
  const lower = redactSecrets(`bearer ${token} leaked`)
  assert.ok(!lower.includes(token))
  assert.ok(lower.includes(REDACTED))
})

test('JWT-shaped tokens are redacted in full', () => {
  // Built at runtime so no token-shaped literal sits in the source.
  const header = 'ey' + 'J' + 'x'.repeat(20)
  const payload = 'ey' + 'J' + 'y'.repeat(30)
  const signature = 'z'.repeat(43)
  const jwt = [header, payload, signature].join('.')
  const out = redactSecrets(`received ${jwt} from the gateway`)
  assert.ok(!out.includes(signature))
  assert.ok(!out.includes(header))
  assert.ok(!out.includes(payload))
  assert.equal(out, `received ${REDACTED} from the gateway`)
})

test('common API key shapes are redacted', () => {
  // Built at runtime so no provider-shaped literal sits in the source.
  const keys = [
    's' + 'k-' + 'x'.repeat(32),
    's' + 'k_live_' + 'x'.repeat(24),
    'p' + 'k_live_' + 'x'.repeat(24),
    'gh' + 'p_' + 'x'.repeat(36),
    'gh' + 'o_' + 'x'.repeat(36),
    'github' + '_pat_' + 'x'.repeat(40),
    'xo' + 'xb-' + '1'.repeat(12) + '-' + 'x'.repeat(24),
    'AK' + 'IA' + 'X'.repeat(16),
  ]
  for (const key of keys) {
    const out = redactSecrets(`using ${key} for the request`)
    assert.ok(!out.includes(key), `key survived: ${out}`)
    assert.equal(out, `using ${REDACTED} for the request`)
  }
})

test('named secret fields keep the key name and redact only the value, in every documented form', () => {
  const equalForm = redactSecrets(
    'password=hunter22 token=hunter22 api_key=hunter22 apikey=hunter22 secret=hunter22 '
    + 'pwd=hunter22 passwd=hunter22 access_token=hunter22 key=hunter22',
  )
  assert.ok(!equalForm.includes('hunter22'))
  for (const key of ['password=', 'token=', 'api_key=', 'apikey=', 'secret=', 'pwd=', 'passwd=', 'access_token=', 'key=']) {
    assert.ok(equalForm.includes(`${key}${REDACTED}`), `key name not kept for ${key}: ${equalForm}`)
  }
  assert.ok(!redactSecrets('PASSWORD=hunter22').includes('hunter22'), 'matching must be case-insensitive')

  const colonForm = redactSecrets('password: hunter22, token: hunter22')
  assert.ok(!colonForm.includes('hunter22'))
  assert.ok(colonForm.includes('password: [REDACTED], token: [REDACTED]'), colonForm)

  const jsonForm = redactSecrets('{"password": "hunter22", "api_key": "hunter22"}')
  assert.ok(!jsonForm.includes('hunter22'))
  assert.ok(jsonForm.includes('"password"'), jsonForm)
  assert.ok(jsonForm.includes('"api_key"'), jsonForm)

  const contextual = redactSecrets('The request failed with password=hunter22 against db.internal')
  assert.equal(contextual, 'The request failed with password=[REDACTED] against db.internal')

  // Env-var style names: the secret word sits at the end of a longer
  // identifier, so a plain word boundary cannot see it.
  const envAssign = redactSecrets(
    'SUPABASE_SERVICE_ROLE_KEY=zzz OPENAI_API_KEY=zzz DB_PASSWORD=zzz',
  )
  assert.ok(!envAssign.includes('zzz'))
  for (const key of ['SUPABASE_SERVICE_ROLE_KEY=', 'OPENAI_API_KEY=', 'DB_PASSWORD=']) {
    assert.ok(envAssign.includes(`${key}${REDACTED}`), `key name not kept for ${key}: ${envAssign}`)
  }
  const envColon = redactSecrets('HERMES_TOKEN: zzz')
  assert.ok(!envColon.includes('zzz'))
  assert.ok(envColon.includes(`HERMES_TOKEN: ${REDACTED}`), envColon)
  const envJson = redactSecrets('{"SUPABASE_SERVICE_ROLE_KEY": "zzz"}')
  assert.ok(!envJson.includes('zzz'))
  assert.ok(envJson.includes('"SUPABASE_SERVICE_ROLE_KEY"'), envJson)

  // Ordinary words must survive: the identifier has to END with the secret
  // word, and plain prose has no key/value form to redact.
  assert.equal(redactSecrets('monkey business'), 'monkey business')
  assert.equal(redactSecrets('keyboard=1'), 'keyboard=1')
})

test('appendErrorLog creates the directory and appends one parseable JSONL line per failure', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'error-log-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const path = join(dir, 'nested', 'dir', 'errors.jsonl')
  assert.equal(existsSync(path), false)
  const now = new Date('2026-10-17T10:00:00.000Z')
  appendErrorLog({ app: 'editor-draft', kind: 'run_failed', error: new Error('boom'), count: 3 }, { path, now })
  appendErrorLog({ app: 'editor-draft', kind: 'cycle_failed', error: 'plain failure' }, { path, now })
  const lines = readFileSync(path, 'utf8').split('\n')
  assert.equal(lines.length, 3, 'expected exactly two entries plus the trailing newline')
  assert.equal(lines[2], '')
  const first = JSON.parse(lines[0]) as Record<string, unknown>
  assert.deepEqual(Object.keys(first), ['ts', 'app', 'kind', 'message', 'stack', 'count'])
  assert.equal(first.ts, now.toISOString())
  assert.equal(first.app, 'editor-draft')
  assert.equal(first.kind, 'run_failed')
  assert.equal(first.message, 'boom')
  assert.equal(typeof first.stack, 'string')
  assert.equal(first.count, 3)
  const second = JSON.parse(lines[1]) as Record<string, unknown>
  assert.deepEqual(Object.keys(second), ['ts', 'app', 'kind', 'message', 'stack'])
  assert.equal(second.kind, 'cycle_failed')
  assert.equal(second.message, 'plain failure')
  assert.equal(second.stack, null)
  assert.equal(Number.isNaN(Date.parse(first.ts as string)), false, 'ts must be a valid ISO timestamp')
})

test('message and stack are redacted and truncated to their documented bounds', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'error-log-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const path = join(dir, 'errors.jsonl')
  const secret = 'hunter22'
  const error = new Error(`connect failed: password=${secret}`)
  error.stack = `Error: connect failed: password=${secret}\n    at pool (/srv/myboon/db.ts:1:1)\n${'at frame;'.repeat(400)}`
  appendErrorLog(
    { app: 'polymarket-markets-data-engineer', kind: 'run_failed', error },
    { path, now: new Date('2026-10-17T10:00:00.000Z') },
  )
  const record = JSON.parse(readFileSync(path, 'utf8').trimEnd()) as { message: string, stack: string }
  assert.equal(record.message, 'connect failed: password=[REDACTED]')
  assert.ok(!record.stack.includes(secret), 'the stack must be redacted in the file')
  assert.ok(record.stack.includes(REDACTED))
  assert.ok(record.stack.endsWith(TRUNCATION_MARKER), 'a cut stack must carry the truncation marker')
  assert.ok(record.stack.length <= 2048 + TRUNCATION_MARKER.length, `stack too long: ${record.stack.length}`)
})

test('MYBOON_ERROR_LOG is honoured when non-blank; the default sits under ~/myboon-logs', () => {
  assert.equal(resolveErrorLogPath({ MYBOON_ERROR_LOG: '/tmp/ops/errors.jsonl' }), '/tmp/ops/errors.jsonl')
  const fallback = join(homedir(), 'myboon-logs', 'errors.jsonl')
  assert.equal(resolveErrorLogPath({ MYBOON_ERROR_LOG: '   ' }), fallback)
  assert.equal(resolveErrorLogPath({}), fallback)
})

test('a failed append falls back to stderr exactly once and never throws or leaks the secret', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'error-log-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const blocker = join(dir, 'afile')
  writeFileSync(blocker, 'not a directory')
  const path = join(blocker, 'errors.jsonl')
  const consoleError = t.mock.method(console, 'error', () => {})
  assert.doesNotThrow(() => appendErrorLog(
    { app: 'editor-draft', kind: 'cycle_failed', error: new Error('connect failed: password=hunter22') },
    { path, now: new Date('2026-10-17T10:00:00.000Z') },
  ))
  assert.equal(consoleError.mock.callCount(), 1)
  const args = consoleError.mock.calls[0].arguments
  assert.equal(args[0], '[error-log] write failed; falling back to stderr:')
  const fallback = String(args[1])
  assert.ok(!fallback.includes('hunter22'), 'the stderr fallback must be redacted too')
  assert.ok(fallback.includes(REDACTED))
  assert.ok(!fallback.endsWith('\n'), 'the fallback line carries no trailing newline of its own')
})

test('process handlers: an unhandled rejection logs and continues, an uncaught exception logs then exits 1', (t) => {
  const consoleError = t.mock.method(console, 'error', () => {})
  const appended: ErrorLogEntry[] = []
  const exits: number[] = []
  const { onUnhandledRejection, onUncaughtException } = createProcessErrorHandlers('editor-draft', {
    exit: (code) => { exits.push(code) },
    append: (entry) => { appended.push(entry) },
  })
  onUnhandledRejection(new Error('late async failure'))
  onUncaughtException(new Error('sync crash'))
  assert.deepEqual(appended.map((entry) => ({ app: entry.app, kind: entry.kind })), [
    { app: 'editor-draft', kind: 'unhandled_rejection' },
    { app: 'editor-draft', kind: 'uncaught_exception' },
  ])
  assert.deepEqual(exits, [1])
  assert.equal(consoleError.mock.callCount(), 2)
})

test('installProcessErrorLogging registers the process handlers exactly once', () => {
  const before = {
    rejection: process.listenerCount('unhandledRejection'),
    exception: process.listenerCount('uncaughtException'),
    rejectionListeners: process.listeners('unhandledRejection'),
    exceptionListeners: process.listeners('uncaughtException'),
  }
  installProcessErrorLogging('error-log-test', { exit: () => undefined })
  installProcessErrorLogging('error-log-test', { exit: () => undefined })
  assert.equal(process.listenerCount('unhandledRejection'), before.rejection + 1)
  assert.equal(process.listenerCount('uncaughtException'), before.exception + 1)
  // Leave the test process as it was: remove exactly the handlers this test
  // added, so later tests run against an unmodified process.
  for (const listener of process.listeners('unhandledRejection')) {
    if (!before.rejectionListeners.includes(listener)) {
      process.removeListener('unhandledRejection', listener)
    }
  }
  for (const listener of process.listeners('uncaughtException')) {
    if (!before.exceptionListeners.includes(listener)) {
      process.removeListener('uncaughtException', listener)
    }
  }
  assert.equal(process.listenerCount('unhandledRejection'), before.rejection)
  assert.equal(process.listenerCount('uncaughtException'), before.exception)
})

test('formatErrorLogLine redacts before truncating so a redaction marker inside bounds survives', () => {
  const longUrl = `see ${('postgres' + ':' + '//' + 'user' + ':' + 'hunter22' + '@db.internal/').padEnd(1200, 'a')} for details`
  const line = formatErrorLogLine(
    { app: 'publisher', kind: 'recovery_failed', error: new Error(longUrl) },
    new Date('2026-10-17T10:00:00.000Z'),
  )
  assert.ok(line.startsWith('{'), 'output stays a single JSON line')
  const record = JSON.parse(line) as { message: string }
  assert.ok(!record.message.includes('hunter22'))
  assert.ok(record.message.includes(REDACTED))
  assert.ok(record.message.length <= 1000 + TRUNCATION_MARKER.length)
})