import { existsSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, extname, isAbsolute, join, resolve } from 'node:path'
import { redactControlPlaneValue } from './control-plane-format'
import {
  type LoadSoakHarnessArtifact,
  type LoadSoakHarnessConfig,
  type LoadSoakHarnessRuntime,
  planLoadSoakHarness,
  runLoadSoakHarness,
} from './load-soak-harness'

export interface LoadSoakCommand {
  execute: boolean
  fixtureDatabasePath: string
  outputPath: string
  config: LoadSoakHarnessConfig
}

export function parseLoadSoakArgs(argv: string[]): LoadSoakCommand {
  const args = argv[0] === '--' ? argv.slice(1) : argv
  const values = new Map<string, string>()
  let execute = false
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index]!
    if (flag === '--execute') {
      if (execute) throw new Error('Duplicate argument: --execute')
      execute = true
      continue
    }
    const value = args[index + 1]
    if (!flag.startsWith('--') || value === undefined || value.startsWith('--')) {
      throw new Error(`Expected --flag value near ${flag}`)
    }
    if (values.has(flag)) throw new Error(`Duplicate argument: ${flag}`)
    values.set(flag, value)
    index += 1
  }
  const allowed = new Set([
    '--fixture-db', '--output', '--duration-seconds', '--tick-seconds',
    '--baseline-arrivals-per-second', '--arrival-multiplier',
    '--completion-capacity-per-second', '--duplicate-every', '--collision-every',
    '--failure-every', '--logical-start', '--max-queue-depth',
    '--min-completion-ratio', '--max-sqlite-errors', '--max-transition-failures',
  ])
  for (const flag of values.keys()) if (!allowed.has(flag)) throw new Error(`Unknown argument: ${flag}`)
  const fixtureDatabasePath = absolutePath(required(values, '--fixture-db'), '--fixture-db')
  const outputPath = absolutePath(required(values, '--output'), '--output')
  if (extname(fixtureDatabasePath) !== '.sqlite') throw new Error('--fixture-db must end in .sqlite')
  if (extname(outputPath) !== '.json') throw new Error('--output must end in .json')
  const config: LoadSoakHarnessConfig = {
    fixtureDatabasePath,
    durationSeconds: integer(values.get('--duration-seconds') ?? '5', '--duration-seconds'),
    tickSeconds: integer(values.get('--tick-seconds') ?? '1', '--tick-seconds'),
    baselineAdmittedArrivalsPerSecond: number(
      values.get('--baseline-arrivals-per-second') ?? '10', '--baseline-arrivals-per-second',
    ),
    admittedArrivalMultiplier: number(
      values.get('--arrival-multiplier') ?? '1', '--arrival-multiplier',
    ),
    completionCapacityPerSecond: number(
      values.get('--completion-capacity-per-second') ?? '20', '--completion-capacity-per-second',
    ),
    duplicateEvery: integer(values.get('--duplicate-every') ?? '10', '--duplicate-every'),
    collisionEvery: integer(values.get('--collision-every') ?? '0', '--collision-every'),
    failureEvery: integer(values.get('--failure-every') ?? '0', '--failure-every'),
    logicalStart: values.get('--logical-start') ?? '2026-08-26T00:00:00.000Z',
    thresholds: {
      maxQueueDepth: integer(values.get('--max-queue-depth') ?? '100', '--max-queue-depth'),
      minCompletionRatio: number(
        values.get('--min-completion-ratio') ?? '0.95', '--min-completion-ratio',
      ),
      maxSqliteErrors: integer(values.get('--max-sqlite-errors') ?? '0', '--max-sqlite-errors'),
      maxTransitionFailures: integer(
        values.get('--max-transition-failures') ?? '0', '--max-transition-failures',
      ),
    },
  }
  // The harness validator owns detailed range and total-work bounds.
  planLoadSoakHarness(config, config.logicalStart)
  return { execute, fixtureDatabasePath, outputPath, config }
}

export async function runLoadSoakCommand(input: {
  command: LoadSoakCommand
  protectedDatabasePaths: string[]
  generatedAt?: string
  runtime?: LoadSoakHarnessRuntime
}): Promise<{ artifact: LoadSoakHarnessArtifact, wroteOutput: boolean }> {
  assertHarnessPathsSafe({
    fixtureDatabasePath: input.command.fixtureDatabasePath,
    outputPath: input.command.outputPath,
    protectedDatabasePaths: input.protectedDatabasePaths,
    requireFreshWritablePaths: input.command.execute,
  })
  if (!input.command.execute) return {
    artifact: planLoadSoakHarness(input.command.config, input.generatedAt),
    wroteOutput: false,
  }
  const artifact = await runLoadSoakHarness(input.command.config, input.generatedAt, input.runtime)
  writeFileSync(input.command.outputPath, `${formatLoadSoakArtifact(artifact)}\n`, {
    encoding: 'utf8', flag: 'wx', mode: 0o600,
  })
  return { artifact, wroteOutput: true }
}

export function assertHarnessPathsSafe(input: {
  fixtureDatabasePath: string
  outputPath: string
  protectedDatabasePaths: string[]
  requireFreshWritablePaths: boolean
}): void {
  const fixture = canonicalCandidate(input.fixtureDatabasePath)
  const output = canonicalCandidate(input.outputPath)
  if (fixture === output) throw new Error('Fixture database and output artifact paths must differ')
  const protectedPaths = new Set(input.protectedDatabasePaths.map(canonicalCandidate))
  if (protectedPaths.has(fixture)) throw new Error('Refusing configured production database as harness fixture')
  if (protectedPaths.has(output)) throw new Error('Refusing configured production database as harness output')
  if (!input.requireFreshWritablePaths) return
  if (existsSync(input.fixtureDatabasePath)) throw new Error('Harness fixture database must not already exist')
  if (existsSync(input.outputPath)) throw new Error('Harness output artifact must not already exist')
  requireDirectory(dirname(input.fixtureDatabasePath), 'fixture')
  requireDirectory(dirname(input.outputPath), 'output')
}

export function formatLoadSoakArtifact(artifact: LoadSoakHarnessArtifact): string {
  return JSON.stringify(redactControlPlaneValue(artifact), null, 2)
}

function canonicalCandidate(path: string): string {
  const absolute = resolve(path)
  let parent = dirname(absolute)
  try { parent = realpathSync(parent) } catch { /* validation handles missing parents before execution */ }
  return join(parent, basename(absolute))
}

function requireDirectory(path: string, label: string): void {
  if (!existsSync(path) || !statSync(path).isDirectory()) {
    throw new Error(`Harness ${label} parent directory must already exist`)
  }
}

function required(values: ReadonlyMap<string, string>, flag: string): string {
  const value = values.get(flag)?.trim()
  if (!value) throw new Error(`${flag} is required`)
  return value
}

function absolutePath(value: string, flag: string): string {
  if (!isAbsolute(value)) throw new Error(`${flag} must be an absolute path`)
  return resolve(value)
}

function integer(raw: string, flag: string): number {
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${flag} must be a non-negative integer`)
  return value
}

function number(raw: string, flag: string): number {
  const value = Number(raw)
  if (!Number.isFinite(value) || value < 0) throw new Error(`${flag} must be a non-negative number`)
  return value
}
