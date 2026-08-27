import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  assertHarnessPathsSafe,
  formatLoadSoakArtifact,
  parseLoadSoakArgs,
  runLoadSoakCommand,
} from './load-soak-command'
import { LOAD_SOAK_ARTIFACT_VERSION } from './load-soak-harness'

interface Statement { all(...params: unknown[]): unknown[] }
interface Database { close(): void; prepare(sql: string): Statement }
const nodeRequire = createRequire(__filename)
const { DatabaseSync } = nodeRequire('node:sqlite') as { DatabaseSync: new(path: string) => Database }

const GENERATED_AT = '2026-08-26T12:00:00.000Z'

test('CLI is dry-run by default, requires explicit absolute paths, and applies bounded short defaults', () => {
  const parsed = parseLoadSoakArgs([
    '--fixture-db', '/tmp/feed-v3-load.sqlite',
    '--output', '/tmp/feed-v3-load.json',
  ])
  assert.equal(parsed.execute, false)
  assert.equal(parsed.config.durationSeconds, 5)
  assert.equal(parsed.config.tickSeconds, 1)
  assert.equal(parsed.config.admittedArrivalMultiplier, 1)
  assert.equal(parsed.config.baselineAdmittedArrivalsPerSecond, 10)
  assert.equal(parsed.config.completionCapacityPerSecond, 20)
  assert.equal(parseLoadSoakArgs([
    '--', '--fixture-db', '/tmp/feed-v3-load.sqlite', '--output', '/tmp/feed-v3-load.json',
  ]).execute, false)
  assert.throws(() => parseLoadSoakArgs([]), /--fixture-db is required/)
  assert.throws(() => parseLoadSoakArgs([
    '--fixture-db', 'relative.sqlite', '--output', '/tmp/out.json',
  ]), /absolute path/)
  assert.throws(() => parseLoadSoakArgs([
    '--fixture-db', '/tmp/load.sqlite', '--output', '/tmp/out.json',
    '--duration-seconds', '86401',
  ]), /between 1 and 86400/)
  assert.throws(() => parseLoadSoakArgs([
    '--fixture-db', '/tmp/load.sqlite', '--output', '/tmp/out.json', '--execute', '--execute',
  ]), /Duplicate argument/)
})

test('dry-run creates no files and both fixture and output refuse configured production databases', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'load-soak-plan-'))
  const fixture = join(dir, 'fixture.sqlite')
  const output = join(dir, 'artifact.json')
  const newsProduction = join(dir, 'news.sqlite')
  const pipelineProduction = join(dir, 'pipeline.sqlite')
  try {
    const command = parseLoadSoakArgs(['--fixture-db', fixture, '--output', output])
    const result = await runLoadSoakCommand({
      command, protectedDatabasePaths: [newsProduction, pipelineProduction], generatedAt: GENERATED_AT,
    })
    assert.equal(result.wroteOutput, false)
    assert.equal(result.artifact.mode, 'dry_run')
    assert.equal(result.artifact.passed, false)
    assert.deepEqual(result.artifact.failureReasons, ['HARNESS_NOT_EXECUTED'])
    assert.equal(existsSync(fixture), false)
    assert.equal(existsSync(output), false)

    await assert.rejects(runLoadSoakCommand({
      command: parseLoadSoakArgs(['--fixture-db', newsProduction, '--output', output]),
      protectedDatabasePaths: [newsProduction, pipelineProduction], generatedAt: GENERATED_AT,
    }), /Refusing configured production database as harness fixture/)
    assert.throws(() => assertHarnessPathsSafe({
      fixtureDatabasePath: fixture,
      outputPath: pipelineProduction,
      protectedDatabasePaths: [newsProduction, pipelineProduction],
      requireFreshWritablePaths: false,
    }), /Refusing configured production database as harness output/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('executed 2x fixture run exercises queue transitions and emits a redacted passing artifact', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'load-soak-pass-'))
  const fixture = join(dir, 'fixture.sqlite')
  const output = join(dir, 'artifact.json')
  try {
    const command = parseLoadSoakArgs([
      '--fixture-db', fixture,
      '--output', output,
      '--execute',
      '--duration-seconds', '3',
      '--baseline-arrivals-per-second', '2',
      '--arrival-multiplier', '2',
      '--completion-capacity-per-second', '4',
      '--duplicate-every', '2',
      '--collision-every', '3',
      '--max-queue-depth', '0',
      '--min-completion-ratio', '1',
    ])
    const result = await runLoadSoakCommand({
      command, protectedDatabasePaths: [join(dir, 'news.sqlite'), join(dir, 'pipeline.sqlite')],
      generatedAt: GENERATED_AT,
      runtime: simulatedRuntime(),
    })
    assert.equal(result.wroteOutput, true)
    assert.equal(result.artifact.schemaVersion, LOAD_SOAK_ARTIFACT_VERSION)
    assert.equal(result.artifact.mode, 'executed')
    assert.equal(result.artifact.passed, true)
    assert.deepEqual(result.artifact.counts, {
      offered: 12,
      admitted: 12,
      completed: 12,
      duplicateAppends: 12,
      collisions: 4,
      injectedFailures: 0,
      transitionFailures: 0,
      sqliteErrors: 0,
      unexpectedErrors: 0,
    })
    assert.deepEqual(result.artifact.ratesPerSecond, { offered: 4, admitted: 4, completed: 4 })
    assert.deepEqual(result.artifact.queueDepth, { samples: 3, p95: 0, max: 0, final: 0 })
    assert.ok(result.artifact.limitations.includes('does_not_prove_production_soak'))
    const json = readFileSync(output, 'utf8')
    assert.deepEqual(JSON.parse(json), result.artifact)
    assert.equal(json.includes(dir), false)
    assert.equal(json.includes('NEWS_SQLITE_PATH'), false)
    assert.ok(tables(fixture).every((name) => name.startsWith('signal_platform_')))

    await assert.rejects(runLoadSoakCommand({
      command, protectedDatabasePaths: [], generatedAt: GENERATED_AT,
    }), /fixture database must not already exist/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('over-capacity and injected failures are counted and fail reviewed thresholds', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'load-soak-fail-'))
  const fixture = join(dir, 'fixture.sqlite')
  const output = join(dir, 'artifact.json')
  try {
    const command = parseLoadSoakArgs([
      '--fixture-db', fixture,
      '--output', output,
      '--execute',
      '--duration-seconds', '2',
      '--baseline-arrivals-per-second', '3',
      '--arrival-multiplier', '2',
      '--completion-capacity-per-second', '2',
      '--failure-every', '2',
      '--max-queue-depth', '0',
      '--min-completion-ratio', '1',
    ])
    const { artifact } = await runLoadSoakCommand({
      command, protectedDatabasePaths: [], generatedAt: GENERATED_AT, runtime: simulatedRuntime(),
    })
    assert.equal(artifact.passed, false)
    assert.equal(artifact.counts.offered, 12)
    assert.ok(artifact.counts.completed < artifact.counts.admitted)
    assert.ok(artifact.counts.injectedFailures > 0)
    assert.ok(artifact.queueDepth.max > 0)
    assert.ok(artifact.failureReasons.some((reason) => reason.startsWith('completion_ratio')))
    assert.ok(artifact.failureReasons.some((reason) => reason.startsWith('max_queue_depth')))
    assert.doesNotMatch(formatLoadSoakArtifact(artifact), /provider prompt|supabase key/i)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

function tables(path: string): string[] {
  const db = new DatabaseSync(path)
  try {
    return (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all() as Array<{ name: string }>).map((row) => row.name)
  } finally { db.close() }
}

function simulatedRuntime(): { monotonicNow: () => number, pace: (milliseconds: number) => Promise<void> } {
  let elapsed = 0
  return {
    monotonicNow: () => elapsed,
    pace: (milliseconds) => { elapsed += milliseconds; return Promise.resolve() },
  }
}
