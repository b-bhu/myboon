import { createHash } from 'node:crypto'
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, resolve } from 'node:path'
import { redactControlPlaneValue } from './control-plane-format'
import {
  LIVE_LOAD_EVIDENCE_SCHEMA_VERSION,
  type LiveLoadEvidenceV1,
  validateLiveLoadEvidence,
} from './operational-evidence'
import { verifyOperationalEvidenceRawArtifacts } from './operational-evidence-bundle'
import {
  assertOperationalEvidencePolicyCurrent,
  type OperationalEvidencePolicyV1,
  validateOperationalEvidencePolicy,
} from './operational-evidence-policy'

export const LIVE_LOAD_PLAN_SCHEMA_VERSION = 'myboon.feed_v3_live_load_plan.v1' as const

export interface LiveLoadPlanV1 {
  schemaVersion: typeof LIVE_LOAD_PLAN_SCHEMA_VERSION
  mode: 'dry-run'
  policyPath: string
  policySha256: string
  outputPath: string
  artifactDirectory: string
  sourceTypes: Array<'news' | 'polymarket' | 'market_calendar' | 'x'>
  durationSeconds: number
  baselineAdmittedArrivalsPerSecond: number
  evidenceSchemaVersion: typeof LIVE_LOAD_EVIDENCE_SCHEMA_VERSION
  executesProviders: false
}

export interface LiveLoadCommand {
  execute: boolean
  policy: OperationalEvidencePolicyV1
  plan: LiveLoadPlanV1
}

/** The production-facing implementation must be supplied out of process. */
export interface LiveLoadEvidenceCollector {
  collect(plan: Readonly<LiveLoadPlanV1>): Promise<unknown>
}

export function parseLiveLoadArgs(argv: string[]): LiveLoadCommand {
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
    if (!flag.startsWith('--') || value === undefined || value.startsWith('--')) throw new Error(`Expected --flag value near ${flag}`)
    if (values.has(flag)) throw new Error(`Duplicate argument: ${flag}`)
    values.set(flag, value); index += 1
  }
  const allowed = new Set(['--policy', '--output', '--artifact-dir', '--source-types', '--duration-seconds', '--baseline-arrivals-per-second'])
  for (const flag of values.keys()) if (!allowed.has(flag)) throw new Error(`Unknown argument: ${flag}`)
  const policyPath = absolute(required(values, '--policy'), '--policy')
  const outputPath = absolute(required(values, '--output'), '--output')
  const artifactDirectory = absolute(required(values, '--artifact-dir'), '--artifact-dir')
  const policyFile = readPolicy(policyPath)
  assertOperationalEvidencePolicyCurrent(policyFile.policy)
  if (policyFile.policy.evidenceKind !== 'live-load') throw new Error('reviewed policy must apply to live-load evidence')
  const sourceTypes = parseSources(required(values, '--source-types'))
  const durationSeconds = positiveInteger(values.get('--duration-seconds') ?? '300', '--duration-seconds')
  const baselineAdmittedArrivalsPerSecond = positiveNumber(
    values.get('--baseline-arrivals-per-second') ?? '1', '--baseline-arrivals-per-second',
  )
  return {
    execute,
    policy: policyFile.policy,
    plan: {
      schemaVersion: LIVE_LOAD_PLAN_SCHEMA_VERSION,
      mode: 'dry-run',
      policyPath,
      policySha256: policyFile.sha256,
      outputPath,
      artifactDirectory,
      sourceTypes,
      durationSeconds,
      baselineAdmittedArrivalsPerSecond,
      evidenceSchemaVersion: LIVE_LOAD_EVIDENCE_SCHEMA_VERSION,
      executesProviders: false,
    },
  }
}

export async function runLiveLoadCommand(input: {
  command: LiveLoadCommand
  collector?: LiveLoadEvidenceCollector
}): Promise<{ plan: LiveLoadPlanV1; evidence: LiveLoadEvidenceV1 | null; wroteOutput: boolean }> {
  const { command } = input
  assertPaths(command.plan, command.execute)
  if (!command.execute) return { plan: command.plan, evidence: null, wroteOutput: false }
  if (!input.collector) {
    throw new Error('Live load execution is unavailable in this CLI; supply an independently reviewed collector implementation')
  }
  const collected = await input.collector.collect(Object.freeze({ ...command.plan }))
  const evidence = validateLiveLoadEvidence(collected, command.policy)
  if (evidence.policySha256 !== command.plan.policySha256) throw new Error('collected evidence policySha256 does not match policy bytes')
  verifyOperationalEvidenceRawArtifacts(evidence, [command.plan.outputPath, command.plan.policyPath])
  writeFileSync(command.plan.outputPath, `${formatLiveLoadResult(evidence)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
  return { plan: command.plan, evidence, wroteOutput: true }
}

export function formatLiveLoadResult(value: LiveLoadPlanV1 | LiveLoadEvidenceV1): string {
  return JSON.stringify(redactControlPlaneValue(value), null, 2)
}

function assertPaths(plan: LiveLoadPlanV1, execute: boolean): void {
  if (plan.outputPath === plan.policyPath) throw new Error('--output and --policy must differ')
  if (!existsSync(plan.artifactDirectory) || !statSync(plan.artifactDirectory).isDirectory()) {
    throw new Error('--artifact-dir must be an existing directory')
  }
  if (!execute) return
  if (existsSync(plan.outputPath)) throw new Error('--output must not already exist')
  if (!existsSync(dirname(plan.outputPath)) || !statSync(dirname(plan.outputPath)).isDirectory()) {
    throw new Error('--output parent must be an existing directory')
  }
}

function readPolicy(path: string): { policy: OperationalEvidencePolicyV1; sha256: string } {
  let bytes: Buffer
  try { bytes = readFileSync(path) } catch { throw new Error('reviewed policy could not be read') }
  let value: unknown
  try { value = JSON.parse(bytes.toString('utf8')) as unknown } catch { throw new Error('reviewed policy is not valid JSON') }
  return { policy: validateOperationalEvidencePolicy(value), sha256: createHash('sha256').update(bytes).digest('hex') }
}

function parseSources(raw: string): LiveLoadPlanV1['sourceTypes'] {
  const allowed = new Set<LiveLoadPlanV1['sourceTypes'][number]>(['news', 'polymarket', 'market_calendar', 'x'])
  const values = raw.split(',').map((value) => value.trim())
  if (values.length === 0 || values.some((value) => !allowed.has(value as LiveLoadPlanV1['sourceTypes'][number]))) {
    throw new Error('--source-types must be a comma-separated list of known sources')
  }
  if (new Set(values).size !== values.length) throw new Error('--source-types must not contain duplicates')
  return values as LiveLoadPlanV1['sourceTypes']
}

function required(values: ReadonlyMap<string, string>, flag: string): string {
  const value = values.get(flag)?.trim(); if (!value) throw new Error(`${flag} is required`); return value
}
function absolute(path: string, flag: string): string {
  if (!isAbsolute(path)) throw new Error(`${flag} must be an absolute path`); return resolve(path)
}
function positiveInteger(raw: string, flag: string): number {
  const value = Number(raw); if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${flag} must be a positive integer`); return value
}
function positiveNumber(raw: string, flag: string): number {
  const value = Number(raw); if (!Number.isFinite(value) || value <= 0) throw new Error(`${flag} must be a positive number`); return value
}
