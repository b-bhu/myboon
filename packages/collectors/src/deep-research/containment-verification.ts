import { link, lstat, open, realpath, unlink, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import {
  RESEARCH_PACKET_SCHEMA_VERSION,
  RESEARCH_WORK_SCHEMA_VERSION,
  RETRIEVED_EVIDENCE_SCHEMA_VERSION,
  SIGNAL_SCHEMA_VERSION,
  type NewsSignal,
  type ResearchWorkItem,
  type RetrievedEvidence,
} from '../signal-platform/contracts'
import { DeepResearchError } from './errors'
import { DeepResearchExecutor } from './executor'
import { SqliteDeepResearchExecutionRegistry } from './sqlite-execution-registry'
import { NodeSystemdController } from './systemd-controller'
import { DEEP_RESEARCH_JOB_SCHEMA_VERSION, type DeepResearchJob } from './types'

export interface DeepContainmentVerificationCommand {
  apply: true
  fixture: 'descendant-timeout-v1'
  registryPath: string
  artifactPath: string
  protectedPaths: readonly string[]
}

export interface DeepContainmentVerificationArtifact {
  schemaVersion: 'myboon.deep_containment_verification.v1'
  fixture: 'descendant-timeout-v1'
  executedAt: string
  systemdAvailable: boolean
  timeoutObserved: boolean
  descendantUnitInactive: boolean
  registryCleared: boolean
  temporaryWorkspaceRemoved: boolean
  passed: boolean
  /** This artifact is host evidence only; it does not enable the feature. */
  enablesDeepResearch: false
}

export interface DeepContainmentVerificationDependencies {
  execute(command: DeepContainmentVerificationCommand): Promise<DeepContainmentVerificationArtifact>
  writeArtifact(path: string, artifact: DeepContainmentVerificationArtifact): Promise<void>
}

export function parseDeepContainmentVerificationArgs(
  argv: string[],
  env: Readonly<Record<string, string | undefined>> = process.env,
): DeepContainmentVerificationCommand {
  const values = new Map<string, string>()
  let apply = false
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index]!
    if (item === '--apply') {
      if (apply) throw new Error('Duplicate --apply flag')
      apply = true
      continue
    }
    if (!['--fixture', '--registry', '--artifact'].includes(item) || !argv[index + 1]) throw new Error(verificationUsage())
    if (values.has(item)) throw new Error(`Duplicate ${item} flag`)
    values.set(item, argv[++index]!)
  }
  if (!apply || values.get('--fixture') !== 'descendant-timeout-v1') throw new Error(verificationUsage())
  const registryPath = values.get('--registry')!
  const artifactPath = values.get('--artifact')!
  if (!registryPath || !artifactPath || !isAbsolute(registryPath) || !isAbsolute(artifactPath)) {
    throw new Error('Containment verification requires explicit absolute --registry and --artifact paths')
  }
  return {
    apply: true, fixture: 'descendant-timeout-v1', registryPath, artifactPath,
    protectedPaths: [env.NEWS_SQLITE_PATH?.trim() || '.data/news.sqlite', env.PIPELINE_SQLITE_PATH?.trim() || '.data/pipeline.sqlite']
      .map((path) => resolve(path)),
  }
}

export async function runDeepContainmentVerification(
  command: DeepContainmentVerificationCommand,
  dependencies: Partial<DeepContainmentVerificationDependencies> = {},
): Promise<DeepContainmentVerificationArtifact> {
  await reserveFreshScratchTargets(command)
  const artifact = await (dependencies.execute ?? DEFAULT_DEPENDENCIES.execute)(command)
  await (dependencies.writeArtifact ?? DEFAULT_DEPENDENCIES.writeArtifact)(command.artifactPath, artifact)
  return artifact
}

async function executeSyntheticTimeout(
  command: DeepContainmentVerificationCommand,
): Promise<DeepContainmentVerificationArtifact> {
  const systemd = new NodeSystemdController()
  const systemdAvailable = process.platform === 'linux' && await systemd.isAvailable()
  if (!systemdAvailable) throw new Error('Linux transient systemd services are unavailable; verification was not run')
  const registry = new SqliteDeepResearchExecutionRegistry(command.registryPath)
  let timeoutObserved = false
  let descendantUnitInactive = false
  let temporaryWorkspaceRemoved = false
  try {
    const executor = new DeepResearchExecutor({
      enabled: true,
      worker: {
        executable: process.execPath,
        args: [resolve(__dirname, 'containment-timeout-fixture.cjs')],
      },
      systemd,
      registry,
      terminationGraceMs: 250,
      inactivePollMs: 50,
      inactiveTimeoutMs: 2_000,
    })
    try {
      await executor.execute(syntheticTimeoutJob())
      throw new Error('Synthetic timeout fixture exited successfully; containment was not verified')
    } catch (error) {
      if (!(error instanceof DeepResearchError) || error.category !== 'timed_out' || error.metadata === undefined) throw error
      timeoutObserved = true
      descendantUnitInactive = !await systemd.isUnitActive(error.metadata.unitName)
      const { access } = await import('node:fs/promises')
      try { await access(error.metadata.tempPath) } catch { temporaryWorkspaceRemoved = true }
    }
    const registryCleared = registry.list().length === 0
    const passed = timeoutObserved && descendantUnitInactive && registryCleared && temporaryWorkspaceRemoved
    return {
      schemaVersion: 'myboon.deep_containment_verification.v1',
      fixture: command.fixture,
      executedAt: new Date().toISOString(),
      systemdAvailable,
      timeoutObserved,
      descendantUnitInactive,
      registryCleared,
      temporaryWorkspaceRemoved,
      passed,
      enablesDeepResearch: false,
    }
  } finally {
    registry.close()
  }
}

async function writeAtomicArtifact(path: string, artifact: DeepContainmentVerificationArtifact): Promise<void> {
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`
  await writeFile(temporary, `${JSON.stringify(artifact, null, 2)}\n`, { mode: 0o600, flag: 'wx' })
  try {
    await link(temporary, path)
  } finally {
    await unlink(temporary).catch(() => undefined)
  }
}

async function reserveFreshScratchTargets(command: DeepContainmentVerificationCommand): Promise<void> {
  const registry = await canonicalFreshTarget(command.registryPath, 'registry')
  const artifact = await canonicalFreshTarget(command.artifactPath, 'artifact')
  if (registry === artifact) throw new Error('Verification registry and artifact must be different scratch files')
  const protectedTargets = await Promise.all(command.protectedPaths.map((path) => canonicalPotentialPath(path)))
  if (protectedTargets.includes(registry) || protectedTargets.includes(artifact)) {
    throw new Error('Containment verification refuses a protected News or Pipeline database path')
  }
  // Reserve the registry with exclusive create before systemd execution. SQLite
  // can initialize the empty mode-0600 file, and a concurrent path swap fails.
  const handle = await open(command.registryPath, 'wx', 0o600)
  await handle.close()
}

async function canonicalFreshTarget(path: string, label: string): Promise<string> {
  try {
    await lstat(path)
    throw new Error(`Containment verification ${label} path already exists`)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  let parent: string
  try { parent = await realpath(dirname(path)) } catch {
    throw new Error(`Containment verification ${label} parent directory must already exist`)
  }
  const parentStat = await lstat(parent)
  if (!parentStat.isDirectory()) throw new Error(`Containment verification ${label} parent must be a directory`)
  return join(parent, basename(path))
}

async function canonicalPotentialPath(path: string): Promise<string> {
  try { return await realpath(path) } catch {
    try { return join(await realpath(dirname(path)), basename(path)) } catch { return resolve(path) }
  }
}

const DEFAULT_DEPENDENCIES: DeepContainmentVerificationDependencies = {
  execute: executeSyntheticTimeout,
  writeArtifact: writeAtomicArtifact,
}

function syntheticTimeoutJob(): DeepResearchJob {
  const signal: NewsSignal = {
    schemaVersion: SIGNAL_SCHEMA_VERSION,
    signalId: 'containment-verification-signal', sourceId: 'containment-verification', sourceType: 'news',
    contentKind: 'article', content: { schemaVersion: 'myboon.signal_content.article.v1' },
    observedAt: '2026-08-26T00:00:00.000Z', publishedAt: null,
    canonicalUrl: 'https://example.com/containment-verification', title: 'Synthetic containment verification',
    visibleSummary: null, media: { imageUrl: null, attribution: null },
    sourceHints: { entities: [], assets: [], eventId: null, deadline: null },
    provenance: { provider: 'synthetic-verifier', upstreamSource: null, rawPayloadRef: 'synthetic' },
    idempotencyKey: 'containment-verification-v1',
  }
  const workItem: ResearchWorkItem = {
    schemaVersion: RESEARCH_WORK_SCHEMA_VERSION,
    workId: 'containment-verification-work', signalId: signal.signalId, sourceType: 'news', researchDepth: 'deep',
    deepReason: 'manual_analyst_request', priorityClass: 'P3', priorityScore: 0,
    freshnessDeadline: '2099-01-01T00:00:00.000Z', policyVersion: 'containment-verification.v1',
    researchContractVersion: RESEARCH_PACKET_SCHEMA_VERSION,
    retrievalPlan: { sourceUrl: signal.canonicalUrl, allowedDomains: ['example.com'], maxExternalSources: 1 },
    budget: { maxProviderCalls: 1, maxRepairCalls: 0, maxInputTokens: 1, maxOutputTokens: 1, maxToolCalls: 1, maxWallTimeMs: 500 },
    status: 'deep_pending', attemptCount: 0, nextAttemptAt: null, leaseOwner: null, leaseId: null,
    leaseExpiresAt: null, failureCategory: null, failureDetail: null, traceId: 'containment-verification-trace',
    createdAt: '2026-08-26T00:00:00.000Z', updatedAt: '2026-08-26T00:00:00.000Z',
  }
  const evidence: RetrievedEvidence = {
    schemaVersion: RETRIEVED_EVIDENCE_SCHEMA_VERSION,
    evidenceId: 'containment-verification-evidence', workId: workItem.workId,
    requestedUrl: signal.canonicalUrl!, finalUrl: signal.canonicalUrl!, authority: 'source_url',
    authorityId: signal.signalId, contentHash: 'sha256:synthetic', contentType: 'text/plain', httpStatus: 200,
    retrievalMethod: 'safe_http', retrievedAt: '2026-08-26T00:00:00.000Z', text: 'Synthetic evidence.',
    truncated: false, byteLength: 19,
  }
  return {
    schemaVersion: DEEP_RESEARCH_JOB_SCHEMA_VERSION,
    jobId: 'containment-verification-job', signal, workItem, evidence: [evidence],
    escalation: { reason: 'manual_analyst_request', unresolvedQuestion: 'Verify timeout containment.', supportingEvidenceRefs: [evidence.evidenceId] },
    approvedDomains: ['example.com'], capabilities: ['http_fetch'],
    budget: {
      maxProviderCalls: 1, maxInputTokens: 1, maxOutputTokens: 1, maxToolCalls: 1,
      maxBrowserNavigations: 0, maxSearchQueries: 0, maxHttpFetches: 1, maxWallTimeMs: 500,
      maxOutputBytes: 16_384, cpuQuotaPercent: 25, memoryMaxBytes: 128 * 1024 * 1024, tasksMax: 16,
    },
  }
}

function verificationUsage(): string {
  return 'Usage: feed-v3:verify-deep-containment --apply --fixture descendant-timeout-v1 --registry /absolute/path.sqlite --artifact /absolute/report.json'
}
