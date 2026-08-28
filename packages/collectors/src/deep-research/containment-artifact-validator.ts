import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import {
  deepContainmentArtifactPayloadSha256,
  deepContainmentConfigurationSha256,
  deepContainmentFixturePath,
  type DeepContainmentVerificationArtifact,
} from './containment-verification'

export interface DeepContainmentArtifactValidationCommand {
  artifactPath: string
  fixturePath: string
  hostExecutablePath: string
}

export interface DeepContainmentArtifactValidationReport {
  schemaVersion: 'myboon.deep_containment_artifact_validation.v1'
  validatedAt: string
  offline: true
  artifactSha256: string
  artifactPassed: boolean
  complete: boolean
  passed: boolean
  checks: {
    artifactPayload: 'passed' | 'mismatch'
    configuration: 'passed' | 'mismatch'
    fixture: 'passed' | 'mismatch' | 'incomplete'
    hostExecutable: 'passed' | 'mismatch' | 'incomplete'
  }
  errors: string[]
}

export function parseDeepContainmentArtifactValidationArgs(argv: string[]): DeepContainmentArtifactValidationCommand {
  const values = new Map<string, string>()
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index]
    const value = argv[index + 1]?.trim()
    if (!flag || !['--artifact', '--fixture-file', '--host-executable'].includes(flag) || !value) {
      throw new Error(validationUsage())
    }
    if (values.has(flag)) throw new Error(`Duplicate ${flag} flag`)
    values.set(flag, value)
  }
  const artifactPath = values.get('--artifact')
  if (!artifactPath || !isAbsolute(artifactPath)) throw new Error('Containment artifact validation requires an absolute --artifact path')
  const fixturePath = values.get('--fixture-file') ?? deepContainmentFixturePath()
  const hostExecutablePath = values.get('--host-executable') ?? process.execPath
  if (!isAbsolute(fixturePath) || !isAbsolute(hostExecutablePath)) {
    throw new Error('Containment identity inputs must be absolute paths')
  }
  return { artifactPath, fixturePath, hostExecutablePath }
}

/** Purely reads and hashes local files. It never starts a fixture or contacts a provider. */
export async function validateDeepContainmentArtifact(
  command: DeepContainmentArtifactValidationCommand,
  now: () => Date = () => new Date(),
): Promise<DeepContainmentArtifactValidationReport> {
  const bytes = await readFile(command.artifactPath)
  if (bytes.length > 64 * 1024) throw new Error('Containment artifact exceeds 64 KiB')
  const artifact = parseArtifact(bytes.toString('utf8'))
  const errors: string[] = []
  const artifactPayload = deepContainmentArtifactPayloadSha256(artifact) === artifact.identity.artifactPayloadSha256
    ? 'passed' : 'mismatch'
  if (artifactPayload === 'mismatch') errors.push('artifact_payload_digest_mismatch')
  const configuration = deepContainmentConfigurationSha256() === artifact.identity.configurationSha256
    ? 'passed' : 'mismatch'
  if (configuration === 'mismatch') errors.push('configuration_digest_mismatch')
  const fixture = await compareFile(command.fixturePath, artifact.identity.fixtureSha256)
  if (fixture === 'mismatch') errors.push('fixture_digest_mismatch')
  if (fixture === 'incomplete') errors.push('fixture_identity_unavailable')
  const hostExecutable = await compareFile(command.hostExecutablePath, artifact.identity.hostExecutableSha256)
  if (hostExecutable === 'mismatch') errors.push('host_executable_digest_mismatch')
  if (hostExecutable === 'incomplete') errors.push('host_executable_identity_unavailable')
  if (!artifact.passed) errors.push('containment_artifact_did_not_pass')
  const complete = fixture !== 'incomplete' && hostExecutable !== 'incomplete'
  return {
    schemaVersion: 'myboon.deep_containment_artifact_validation.v1',
    validatedAt: now().toISOString(),
    offline: true,
    artifactSha256: createHash('sha256').update(bytes).digest('hex'),
    artifactPassed: artifact.passed,
    complete,
    passed: complete && errors.length === 0,
    checks: { artifactPayload, configuration, fixture, hostExecutable },
    errors,
  }
}

function parseArtifact(json: string): DeepContainmentVerificationArtifact {
  let value: unknown
  try { value = JSON.parse(json) } catch { throw new Error('Containment artifact is not valid JSON') }
  if (!record(value)) throw new Error('Containment artifact must be one object')
  exactKeys(value, [
    'schemaVersion', 'fixture', 'executedAt', 'systemdAvailable', 'timeoutObserved',
    'descendantUnitInactive', 'registryCleared', 'temporaryWorkspaceRemoved',
    'passed', 'identity', 'enablesDeepResearch',
  ], 'artifact')
  if (value.schemaVersion !== 'myboon.deep_containment_verification.v2'
    || value.fixture !== 'descendant-timeout-v1'
    || typeof value.executedAt !== 'string' || !Number.isFinite(Date.parse(value.executedAt))
    || value.enablesDeepResearch !== false) throw new Error('Containment artifact identity is invalid')
  for (const field of [
    'systemdAvailable', 'timeoutObserved', 'descendantUnitInactive', 'registryCleared',
    'temporaryWorkspaceRemoved', 'passed',
  ]) {
    if (typeof value[field] !== 'boolean') throw new Error(`Containment artifact ${field} must be boolean`)
  }
  if (!record(value.identity)) throw new Error('Containment artifact identity must be one object')
  exactKeys(value.identity, [
    'digestAlgorithm', 'configurationSha256', 'fixtureSha256',
    'hostExecutableSha256', 'artifactPayloadSha256',
  ], 'identity')
  if (value.identity.digestAlgorithm !== 'sha256') throw new Error('Containment artifact digest algorithm is invalid')
  for (const field of ['configurationSha256', 'fixtureSha256', 'hostExecutableSha256', 'artifactPayloadSha256']) {
    if (typeof value.identity[field] !== 'string' || !/^[a-f0-9]{64}$/.test(value.identity[field])) {
      throw new Error(`Containment artifact identity ${field} is invalid`)
    }
  }
  const outcomes = [
    value.systemdAvailable, value.timeoutObserved, value.descendantUnitInactive,
    value.registryCleared, value.temporaryWorkspaceRemoved,
  ]
  if (value.passed !== outcomes.every((item) => item === true)) {
    throw new Error('Containment artifact pass claim contradicts its outcomes')
  }
  return value as unknown as DeepContainmentVerificationArtifact
}

async function compareFile(path: string, expected: string): Promise<'passed' | 'mismatch' | 'incomplete'> {
  try { return await sha256File(path) === expected ? 'passed' : 'mismatch' } catch { return 'incomplete' }
}

async function sha256File(path: string): Promise<string> {
  const digest = createHash('sha256')
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(path)
    stream.on('data', (chunk) => digest.update(chunk))
    stream.once('error', reject)
    stream.once('end', resolve)
  })
  return digest.digest('hex')
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function exactKeys(value: Record<string, unknown>, expected: string[], label: string): void {
  const actual = Object.keys(value).sort()
  const sorted = [...expected].sort()
  if (actual.length !== sorted.length || actual.some((item, index) => item !== sorted[index])) {
    throw new Error(`Containment ${label} contains unexpected or missing fields`)
  }
}

function validationUsage(): string {
  return 'Usage: feed-v3:validate-deep-containment --artifact /absolute/report.json [--fixture-file /absolute/fixture.cjs] [--host-executable /absolute/executable]'
}
