import { randomUUID, createHash } from 'node:crypto'
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { isIP } from 'node:net'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import {
  RESEARCH_WORK_SCHEMA_VERSION,
  RETRIEVED_EVIDENCE_SCHEMA_VERSION,
  SIGNAL_SCHEMA_VERSION,
  type DeepEscalationReason,
} from '../signal-platform/contracts'
import { DeepResearchError } from './errors'
import type {
  DeepResearchBudget,
  DeepResearchCapability,
  DeepResearchExecutionMetadata,
  DeepResearchFetchedEvidence,
  DeepResearchJob,
  DeepResearchMeasuredUsage,
  DeepResearchResult,
} from './types'
import {
  DEEP_RESEARCH_JOB_SCHEMA_VERSION,
  DEEP_RESEARCH_FETCHED_EVIDENCE_SCHEMA_VERSION,
  DEEP_RESEARCH_RESULT_SCHEMA_VERSION,
  DEEP_RESEARCH_USAGE_SCHEMA_VERSION,
} from './types'
import {
  NodeSystemdController,
  type DeepResearchProcess,
  type DeepResearchSystemdController,
} from './systemd-controller'

const REASONS = new Set<DeepEscalationReason>([
  'conflicting_primary_sources',
  'insufficient_primary_evidence',
  'rendering_required_for_material_fact',
  'entity_identity_ambiguous',
  'regulatory_interpretation_required',
  'manual_analyst_request',
])
const CAPABILITIES = new Set<DeepResearchCapability>([
  'browser_navigation',
  'registered_search',
  'http_fetch',
])

export const DEEP_RESEARCH_STATIC_SYSTEMD_PROPERTIES = Object.freeze([
  'PrivateTmp=yes',
  'ProtectSystem=strict',
  'ProtectHome=yes',
  'NoNewPrivileges=yes',
  'KillMode=control-group',
  'RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6',
  'RestrictSUIDSGID=yes',
  'LockPersonality=yes',
])

export interface DeepResearchFileSystem {
  makeTempDir(prefix: string): Promise<string>
  makeDir(path: string): Promise<void>
  writePrivateFile(path: string, contents: string): Promise<void>
  readPrivateFile(path: string, maxBytes: number): Promise<string>
  removeTree(path: string): Promise<void>
  exists(path: string): Promise<boolean>
}

export interface DeepResearchExecutionRegistry {
  register(metadata: DeepResearchExecutionMetadata): void
  unregister(unitName: string): void
  list(): readonly DeepResearchExecutionMetadata[]
}

export class InMemoryDeepResearchExecutionRegistry implements DeepResearchExecutionRegistry {
  private readonly active = new Map<string, DeepResearchExecutionMetadata>()

  register(metadata: DeepResearchExecutionMetadata): void {
    if (this.active.has(metadata.unitName)) throw new Error(`Duplicate deep-research unit ${metadata.unitName}`)
    this.active.set(metadata.unitName, Object.freeze({ ...metadata }))
  }

  unregister(unitName: string): void {
    this.active.delete(unitName)
  }

  list(): readonly DeepResearchExecutionMetadata[] {
    return [...this.active.values()].map((item) => ({ ...item }))
  }
}

export interface DeepResearchWorkerCommand {
  executable: string
  args?: readonly string[]
}

export interface DeepResearchExecutorOptions {
  /** Must be explicitly true. Phase 6 is disabled by default. */
  enabled?: boolean
  worker: DeepResearchWorkerCommand
  systemd?: DeepResearchSystemdController
  fileSystem?: DeepResearchFileSystem
  registry?: DeepResearchExecutionRegistry
  platform?: NodeJS.Platform
  tempRoot?: string
  terminationGraceMs?: number
  inactivePollMs?: number
  inactiveTimeoutMs?: number
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  uniqueId?: () => string
}

export interface DeepResearchExecuteOptions {
  signal?: AbortSignal
  /** Called only after the transient service has successfully spawned. */
  onExecutionStarted?: () => boolean | Promise<boolean>
}

interface ProcessCompletion {
  kind: 'close' | 'error' | 'terminated'
  code: number | null
  signal: NodeJS.Signals | null
  error?: unknown
}

const nodeFileSystem: DeepResearchFileSystem = {
  makeTempDir: (prefix) => mkdtemp(prefix),
  makeDir: async (path) => { await mkdir(path, { recursive: true, mode: 0o700 }) },
  writePrivateFile: async (path, contents) => { await writeFile(path, contents, { encoding: 'utf8', mode: 0o600 }) },
  readPrivateFile: async (path, maxBytes) => {
    const contents = await readFile(path)
    if (contents.length > maxBytes) throw new Error(`Private file exceeded ${maxBytes} bytes`)
    return contents.toString('utf8')
  },
  removeTree: async (path) => { await rm(path, { recursive: true, force: true }) },
  exists: async (path) => {
    try {
      await access(path)
      return true
    } catch {
      return false
    }
  },
}

export class DeepResearchExecutor {
  private readonly enabled: boolean
  private readonly worker: DeepResearchWorkerCommand
  private readonly systemd: DeepResearchSystemdController
  private readonly fileSystem: DeepResearchFileSystem
  readonly registry: DeepResearchExecutionRegistry
  private readonly platform: NodeJS.Platform
  private readonly tempRoot: string
  private readonly terminationGraceMs: number
  private readonly inactivePollMs: number
  private readonly inactiveTimeoutMs: number
  private readonly now: () => number
  private readonly sleep: (ms: number) => Promise<void>
  private readonly uniqueId: () => string

  constructor(options: DeepResearchExecutorOptions) {
    this.enabled = options.enabled ?? false
    this.worker = validateWorker(options.worker)
    this.systemd = options.systemd ?? new NodeSystemdController()
    this.fileSystem = options.fileSystem ?? nodeFileSystem
    this.registry = options.registry ?? new InMemoryDeepResearchExecutionRegistry()
    this.platform = options.platform ?? process.platform
    this.tempRoot = options.tempRoot ?? tmpdir()
    this.terminationGraceMs = positiveInteger(options.terminationGraceMs ?? 5_000, 'terminationGraceMs')
    this.inactivePollMs = positiveInteger(options.inactivePollMs ?? 100, 'inactivePollMs')
    this.inactiveTimeoutMs = positiveInteger(options.inactiveTimeoutMs ?? 5_000, 'inactiveTimeoutMs')
    this.now = options.now ?? Date.now
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
    this.uniqueId = options.uniqueId ?? randomUUID
  }

  async execute(job: DeepResearchJob, options: DeepResearchExecuteOptions = {}): Promise<DeepResearchResult> {
    if (!this.enabled) throw deepError('containment_disabled', 'Deep research containment is disabled', false)
    if (this.platform !== 'linux') throw deepError('unsupported_platform', 'Deep research requires Linux systemd', false)
    validateDeepResearchJob(job)
    if (options.signal?.aborted) throw deepError('cancelled', 'Deep research was cancelled before start', true)
    if (!await this.systemd.isAvailable()) {
      throw deepError('systemd_unavailable', 'systemd-run/systemctl are unavailable', false)
    }

    const startedAtMs = this.now()
    const tempPath = await this.fileSystem.makeTempDir(join(this.tempRoot, 'myboon-deep-'))
    const profilePath = join(tempPath, 'profile')
    const isolatedTmpPath = join(tempPath, 'tmp')
    const jobPath = join(tempPath, 'job.json')
    const usagePath = join(tempPath, 'usage.json')
    const evidenceManifestPath = join(tempPath, 'fetched-evidence.json')
    try {
      await this.fileSystem.makeDir(profilePath)
      await this.fileSystem.makeDir(isolatedTmpPath)
      await this.fileSystem.writePrivateFile(jobPath, JSON.stringify(job))
    } catch (error) {
      try {
        await this.fileSystem.removeTree(tempPath)
        if (await this.fileSystem.exists(tempPath)) throw new Error('temporary path still exists')
      } catch (cleanupError) {
        throw deepError(
          'containment_cleanup_failed',
          'Failed to verify cleanup after deep-research workspace preparation error',
          false,
          undefined,
          cleanupError,
        )
      }
      throw deepError('execution_failed', 'Failed to prepare isolated deep-research workspace', true, undefined, error)
    }

    const unitName = buildDeepResearchUnitName(job.workItem.workId, job.workItem.traceId, this.uniqueId())
    const metadata: DeepResearchExecutionMetadata = Object.freeze({
      jobId: job.jobId,
      workId: job.workItem.workId,
      traceId: job.workItem.traceId,
      sourceType: job.workItem.sourceType,
      unitName,
      startedAt: new Date(startedAtMs).toISOString(),
      deadlineAt: new Date(startedAtMs + job.budget.maxWallTimeMs).toISOString(),
      tempPath,
      profilePath,
    })
    try {
      this.registry.register(metadata)
    } catch (error) {
      try {
        await this.fileSystem.removeTree(tempPath)
        if (await this.fileSystem.exists(tempPath)) throw new Error('temporary path still exists')
      } catch (cleanupError) {
        throw deepError(
          'containment_cleanup_failed',
          'Failed to verify cleanup after durable execution registration failure',
          false, metadata, cleanupError,
        )
      }
      throw deepError('execution_failed', 'Failed to durably register deep-research execution', true, metadata, error)
    }

    let child: DeepResearchProcess
    try {
      child = this.systemd.spawnTransient(
        buildSystemdRunArgs(job, metadata, jobPath, usagePath, evidenceManifestPath, isolatedTmpPath, this.worker),
        { cwd: tempPath, env: minimalEnvironment() },
      )
    } catch (error) {
      await this.cleanupInactive(metadata)
      throw deepError('execution_failed', 'Failed to start transient deep-research service', true, metadata, error)
    }
    if (options.onExecutionStarted && !await options.onExecutionStarted()) {
      await this.terminateAndVerify(metadata)
      throw deepError('cancelled', 'Lease fence was lost after contained execution start', true, metadata)
    }

    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    let outputBytes = 0
    let terminationError: DeepResearchError | null = null
    let resolveCompletion: (completion: ProcessCompletion) => void = () => undefined
    const completion = new Promise<ProcessCompletion>((resolve) => { resolveCompletion = resolve })
    let terminationStarted = false

    const triggerTermination = (error: DeepResearchError) => {
      if (terminationStarted) return
      terminationStarted = true
      terminationError = error
      void this.terminateAndVerify(metadata).then(
        () => resolveCompletion({ kind: 'terminated', code: null, signal: null }),
        (terminationFailure) => resolveCompletion({
          kind: 'error', code: null, signal: null, error: terminationFailure,
        }),
      )
    }
    const capture = (target: Buffer[], chunk: unknown) => {
      const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))
      const remaining = Math.max(0, job.budget.maxOutputBytes - outputBytes)
      if (remaining > 0) target.push(value.subarray(0, remaining))
      outputBytes += value.length
      if (outputBytes > job.budget.maxOutputBytes) {
        triggerTermination(deepError(
          'budget_exceeded',
          `Deep-research output exceeded ${job.budget.maxOutputBytes} bytes`,
          false,
          metadata,
        ))
      }
    }
    child.stdout?.on('data', (chunk) => capture(stdout, chunk))
    child.stderr?.on('data', (chunk) => capture(stderr, chunk))
    child.once('error', (error) => {
      if (!terminationStarted) resolveCompletion({ kind: 'error', code: null, signal: null, error })
    })
    child.once('close', (code, signal) => {
      if (!terminationStarted) resolveCompletion({ kind: 'close', code, signal })
    })

    const timeout = setTimeout(() => triggerTermination(deepError(
      'timed_out',
      `Deep research exceeded ${job.budget.maxWallTimeMs}ms`,
      true,
      metadata,
    )), job.budget.maxWallTimeMs)
    const onAbort = () => triggerTermination(deepError(
      'cancelled', 'Deep research was cancelled', true, metadata,
    ))
    options.signal?.addEventListener('abort', onAbort, { once: true })

    try {
      const processResult = await completion
      clearTimeout(timeout)
      options.signal?.removeEventListener('abort', onAbort)
      if (processResult.kind === 'error') {
        if (processResult.error instanceof DeepResearchError
          && processResult.error.category === 'containment_cleanup_failed') {
          throw processResult.error
        }
        await this.terminateAndVerify(metadata)
        throw deepError('execution_failed', 'Transient deep-research service failed', true, metadata, processResult.error)
      }
      if (processResult.kind === 'terminated') {
        await this.cleanupInactive(metadata)
        throw terminationError ?? deepError('execution_failed', 'Deep research terminated', true, metadata)
      }

      const inactive = await this.waitUntilInactive(metadata.unitName)
      if (!inactive) await this.terminateAndVerify(metadata)
      let measuredUsage: DeepResearchMeasuredUsage
      let fetchedEvidence: DeepResearchFetchedEvidence[]
      try {
        measuredUsage = await this.readMeasuredUsage(usagePath, job)
        fetchedEvidence = await this.readFetchedEvidenceManifest(evidenceManifestPath, job)
        const manifestedByMethod = {
          browserNavigations: fetchedEvidence.filter((item) => item.retrievalMethod === 'browser_navigation').length,
          searchQueries: fetchedEvidence.filter((item) => item.retrievalMethod === 'registered_search').length,
          httpFetches: fetchedEvidence.filter((item) => item.retrievalMethod === 'http_fetch').length,
        }
        for (const [field, manifested] of Object.entries(manifestedByMethod) as Array<[keyof typeof manifestedByMethod, number]>) {
          if (manifested > measuredUsage[field]) {
            throw deepError('invalid_job', `Fetched-evidence manifest exceeds measured ${field}`, false)
          }
        }
      } catch (error) {
        await this.cleanupInactive(metadata)
        throw error
      }
      await this.cleanupInactive(metadata)
      const finishedAtMs = this.now()
      return {
        schemaVersion: DEEP_RESEARCH_RESULT_SCHEMA_VERSION,
        jobId: job.jobId,
        workId: job.workItem.workId,
        traceId: job.workItem.traceId,
        unitName,
        status: processResult.code === 0 ? 'succeeded' : 'failed',
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
        exitCode: processResult.code,
        signal: processResult.signal,
        startedAt: metadata.startedAt,
        finishedAt: new Date(finishedAtMs).toISOString(),
        durationMs: Math.max(0, finishedAtMs - startedAtMs),
        capabilities: [...job.capabilities],
        fetchedEvidence,
        budgetUsed: {
          providerCalls: measuredUsage.providerCalls,
          inputTokens: measuredUsage.inputTokens,
          outputTokens: measuredUsage.outputTokens,
          toolCalls: measuredUsage.toolCalls,
          browserNavigations: measuredUsage.browserNavigations,
          searchQueries: measuredUsage.searchQueries,
          httpFetches: measuredUsage.httpFetches,
          wallTimeMs: Math.max(0, finishedAtMs - startedAtMs),
          outputBytes: Math.min(outputBytes, job.budget.maxOutputBytes),
        },
      }
    } finally {
      clearTimeout(timeout)
      options.signal?.removeEventListener('abort', onAbort)
    }
  }

  private async readMeasuredUsage(usagePath: string, job: DeepResearchJob): Promise<DeepResearchMeasuredUsage> {
    let value: unknown
    try {
      value = JSON.parse(await this.fileSystem.readPrivateFile(usagePath, 4_096))
    } catch (error) {
      throw deepError(
        'invalid_job',
        'Contained worker did not produce a valid measured-usage record',
        false,
        undefined,
        error,
      )
    }
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw deepError('invalid_job', 'Contained measured usage must be one object', false)
    }
    const record = value as Record<string, unknown>
    const expected = [
      'schemaVersion', 'providerCalls', 'inputTokens', 'outputTokens', 'toolCalls',
      'browserNavigations', 'searchQueries', 'httpFetches',
    ].sort()
    const actual = Object.keys(record).sort()
    if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])
      || record.schemaVersion !== DEEP_RESEARCH_USAGE_SCHEMA_VERSION) {
      throw deepError('invalid_job', 'Contained measured usage has an invalid schema', false)
    }
    const limits = {
      providerCalls: job.budget.maxProviderCalls,
      inputTokens: job.budget.maxInputTokens,
      outputTokens: job.budget.maxOutputTokens,
      toolCalls: job.budget.maxToolCalls,
      browserNavigations: job.budget.maxBrowserNavigations,
      searchQueries: job.budget.maxSearchQueries,
      httpFetches: job.budget.maxHttpFetches,
    } as const
    for (const [field, limit] of Object.entries(limits) as Array<[keyof typeof limits, number]>) {
      const measured = record[field]
      if (!Number.isInteger(measured) || (measured as number) < 0) {
        throw deepError('invalid_job', `Contained measured ${field} is invalid`, false)
      }
      if ((measured as number) > limit) {
        throw deepError('budget_exceeded', `Contained measured ${field} exceeded its executable budget`, false)
      }
    }
    if (record.toolCalls !== (record.browserNavigations as number)
      + (record.searchQueries as number) + (record.httpFetches as number)) {
      throw deepError('invalid_job', 'Contained measured toolCalls must equal allowlisted capability calls', false)
    }
    return record as unknown as DeepResearchMeasuredUsage
  }

  private async readFetchedEvidenceManifest(
    path: string,
    job: DeepResearchJob,
  ): Promise<DeepResearchFetchedEvidence[]> {
    let value: unknown
    try {
      value = JSON.parse(await this.fileSystem.readPrivateFile(path, Math.min(job.budget.maxOutputBytes, 256_000)))
    } catch (error) {
      throw deepError('invalid_job', 'Contained worker did not produce a valid fetched-evidence manifest', false, undefined, error)
    }
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw deepError('invalid_job', 'Contained fetched-evidence manifest must be one object', false)
    }
    const manifest = value as Record<string, unknown>
    const expected = ['schemaVersion', 'jobId', 'workId', 'traceId', 'results'].sort()
    const actual = Object.keys(manifest).sort()
    if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])
      || manifest.schemaVersion !== DEEP_RESEARCH_FETCHED_EVIDENCE_SCHEMA_VERSION
      || manifest.jobId !== job.jobId || manifest.workId !== job.workItem.workId
      || manifest.traceId !== job.workItem.traceId || !Array.isArray(manifest.results)) {
      throw deepError('invalid_job', 'Contained fetched-evidence manifest has invalid schema or linkage', false)
    }
    if (manifest.results.length > job.budget.maxBrowserNavigations + job.budget.maxSearchQueries + job.budget.maxHttpFetches) {
      throw deepError('budget_exceeded', 'Contained fetched-evidence manifest exceeded its executable result budget', false)
    }
    const refs = new Set<string>()
    return manifest.results.map((raw, index) => validateFetchedEvidence(raw, index, job, refs))
  }

  private async terminateAndVerify(metadata: DeepResearchExecutionMetadata): Promise<void> {
    try {
      await this.systemd.killUnit(metadata.unitName, 'TERM')
    } catch {
      // The unit may have exited between the trigger and systemctl. Inactive
      // verification below is the authority, not the kill command exit code.
    }
    await this.sleep(this.terminationGraceMs)
    if (await this.systemd.isUnitActive(metadata.unitName)) {
      try {
        await this.systemd.killUnit(metadata.unitName, 'KILL')
      } catch {
        // As above, verify actual unit state below.
      }
    }
    if (!await this.waitUntilInactive(metadata.unitName)) {
      throw deepError(
        'containment_cleanup_failed',
        `Transient unit ${metadata.unitName} remained active after TERM and KILL`,
        false,
        metadata,
      )
    }
  }

  private async waitUntilInactive(unitName: string): Promise<boolean> {
    const attempts = Math.max(1, Math.ceil(this.inactiveTimeoutMs / this.inactivePollMs))
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      if (!await this.systemd.isUnitActive(unitName)) return true
      await this.sleep(this.inactivePollMs)
    }
    return !await this.systemd.isUnitActive(unitName)
  }

  private async cleanupInactive(metadata: DeepResearchExecutionMetadata): Promise<void> {
    if (await this.systemd.isUnitActive(metadata.unitName)) {
      throw deepError('containment_cleanup_failed', 'Refusing cleanup while transient unit is active', false, metadata)
    }
    try {
      await this.fileSystem.removeTree(metadata.tempPath)
      if (await this.fileSystem.exists(metadata.tempPath)) {
        throw new Error('temporary path still exists')
      }
      this.registry.unregister(metadata.unitName)
    } catch (error) {
      throw deepError('containment_cleanup_failed', 'Deep-research temporary directory cleanup was not verified', false, metadata, error)
    }
  }
}

export function buildSystemdRunArgs(
  job: DeepResearchJob,
  metadata: DeepResearchExecutionMetadata,
  jobPath: string,
  usagePath: string,
  evidenceManifestPath: string,
  isolatedTmpPath: string,
  worker: DeepResearchWorkerCommand,
): string[] {
  return [
    '--wait',
    '--collect',
    '--pipe',
    `--unit=${metadata.unitName}`,
    `--property=CPUQuota=${job.budget.cpuQuotaPercent}%`,
    `--property=MemoryMax=${job.budget.memoryMaxBytes}`,
    `--property=TasksMax=${job.budget.tasksMax}`,
    `--property=RuntimeMaxSec=${Math.ceil(job.budget.maxWallTimeMs / 1000)}s`,
    ...DEEP_RESEARCH_STATIC_SYSTEMD_PROPERTIES.map((property) => `--property=${property}`),
    `--property=BindPaths=${metadata.tempPath}`,
    `--working-directory=${metadata.tempPath}`,
    `--setenv=HOME=${metadata.profilePath}`,
    `--setenv=TMPDIR=${isolatedTmpPath}`,
    '--',
    worker.executable,
    ...(worker.args ?? []),
    `--job-file=${jobPath}`,
    `--usage-file=${usagePath}`,
    `--evidence-manifest-file=${evidenceManifestPath}`,
    `--profile-dir=${metadata.profilePath}`,
  ]
}

export function buildDeepResearchUnitName(workId: string, traceId: string, unique: string): string {
  const safeWork = workId.toLowerCase().replace(/[^a-z0-9_.-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'work'
  const digest = createHash('sha256').update(`${workId}\0${traceId}\0${unique}`).digest('hex').slice(0, 16)
  return `myboon-deep-${safeWork}-${digest}.service`
}

function validateFetchedEvidence(
  value: unknown,
  index: number,
  job: DeepResearchJob,
  refs: Set<string>,
): DeepResearchFetchedEvidence {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw deepError('invalid_job', `Contained fetched evidence result ${index} must be an object`, false)
  }
  const record = value as Record<string, unknown>
  const expected = ['resultRef', 'title', 'url', 'observedAt', 'note', 'contentHash', 'retrievalMethod'].sort()
  const actual = Object.keys(record).sort()
  if (actual.length !== expected.length || actual.some((key, keyIndex) => key !== expected[keyIndex])) {
    throw deepError('invalid_job', `Contained fetched evidence result ${index} has invalid schema`, false)
  }
  const string = (field: string, max: number): string => {
    const item = record[field]
    if (typeof item !== 'string' || !item.trim() || item.length > max || item.includes('\0')) {
      throw deepError('invalid_job', `Contained fetched evidence ${field} is invalid`, false)
    }
    return item
  }
  const resultRef = string('resultRef', 300)
  if (!safeIdentifier(resultRef) || refs.has(resultRef) || job.evidence.some((item) => item.evidenceId === resultRef)) {
    throw deepError('invalid_job', 'Contained fetched evidence resultRef is invalid, duplicate, or colliding', false)
  }
  refs.add(resultRef)
  const url = string('url', 2_000)
  let parsed: URL
  try { parsed = new URL(url) } catch (error) {
    throw deepError('invalid_job', 'Contained fetched evidence URL is invalid', false, undefined, error)
  }
  const hostname = parsed.hostname.toLowerCase()
  if ((parsed.protocol !== 'https:' && parsed.protocol !== 'http:') || parsed.username || parsed.password || parsed.hash
    || !job.approvedDomains.some((domain) => hostname === domain || hostname.endsWith(`.${domain}`))) {
    throw deepError('invalid_job', 'Contained fetched evidence URL is outside approved domains', false)
  }
  const retrievalMethod = record.retrievalMethod
  if (!CAPABILITIES.has(retrievalMethod as DeepResearchCapability)
    || !job.capabilities.includes(retrievalMethod as DeepResearchCapability)) {
    throw deepError('invalid_job', 'Contained fetched evidence retrieval method is not an enabled capability', false)
  }
  const observedAt = record.observedAt
  if (observedAt !== null && (typeof observedAt !== 'string' || !Number.isFinite(Date.parse(observedAt)))) {
    throw deepError('invalid_job', 'Contained fetched evidence observedAt is invalid', false)
  }
  const note = record.note
  if (note !== null && (typeof note !== 'string' || note.length > 1_000 || note.includes('\0'))) {
    throw deepError('invalid_job', 'Contained fetched evidence note is invalid', false)
  }
  const contentHash = string('contentHash', 200)
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(contentHash)) {
    throw deepError('invalid_job', 'Contained fetched evidence contentHash is unsafe', false)
  }
  return {
    resultRef,
    title: string('title', 500),
    url: parsed.toString(),
    observedAt: observedAt as string | null,
    note: note as string | null,
    contentHash,
    retrievalMethod: retrievalMethod as DeepResearchCapability,
  }
}

export function validateDeepResearchJob(job: DeepResearchJob): void {
  const value = job as unknown as Record<string, unknown>
  for (const forbidden of ['tools', 'toolsets', 'terminal', 'command', 'executable', 'packages', 'files']) {
    if (Object.prototype.hasOwnProperty.call(value, forbidden)) {
      throw deepError('invalid_job', `Deep-research job forbids ${forbidden}`, false)
    }
  }
  if (job.schemaVersion !== DEEP_RESEARCH_JOB_SCHEMA_VERSION
    || job.signal.schemaVersion !== SIGNAL_SCHEMA_VERSION
    || job.workItem.schemaVersion !== RESEARCH_WORK_SCHEMA_VERSION) {
    throw deepError('invalid_job', 'Deep-research job contains an unsupported schema version', false)
  }
  if (!safeIdentifier(job.jobId)) throw deepError('invalid_job', 'jobId is invalid', false)
  if (!job.inference || !safeRouteValue(job.inference.provider) || !safeRouteValue(job.inference.model)
    || !['low', 'medium', 'high'].includes(job.inference.reasoningEffort)) {
    throw deepError('invalid_job', 'Deep-research inference route policy is invalid', false)
  }
  if (job.workItem.researchDepth !== 'deep' || job.workItem.deepReason === null) {
    throw deepError('invalid_job', 'Deep-research work must have depth deep and an escalation reason', false)
  }
  if (!REASONS.has(job.escalation.reason) || job.escalation.reason !== job.workItem.deepReason) {
    throw deepError('invalid_job', 'Escalation reason must exactly match the canonical work reason', false)
  }
  if (job.signal.signalId !== job.workItem.signalId || job.signal.sourceType !== job.workItem.sourceType) {
    throw deepError('invalid_job', 'Signal/work linkage is invalid', false)
  }
  if (!job.escalation.unresolvedQuestion.trim() || job.escalation.unresolvedQuestion.length > 2_000) {
    throw deepError('invalid_job', 'A bounded unresolved question is required', false)
  }
  if (!Array.isArray(job.capabilities) || job.capabilities.length === 0
    || new Set(job.capabilities).size !== job.capabilities.length
    || job.capabilities.some((capability) => !CAPABILITIES.has(capability))) {
    throw deepError('invalid_job', 'Capabilities must be a unique non-empty subset of the deep-research allowlist', false)
  }
  validateBudgets(job.budget, new Set(job.capabilities))
  if (!Array.isArray(job.approvedDomains) || job.approvedDomains.length === 0) {
    throw deepError('invalid_job', 'At least one approved public domain is required', false)
  }
  for (const domain of job.approvedDomains) validateDomain(domain)
  if (new Set(job.approvedDomains).size !== job.approvedDomains.length) {
    throw deepError('invalid_job', 'Approved domains must be unique', false)
  }
  const evidenceIds = new Set<string>()
  for (const evidence of job.evidence) {
    if (evidence.schemaVersion !== RETRIEVED_EVIDENCE_SCHEMA_VERSION
      || evidence.workId !== job.workItem.workId
      || !safeIdentifier(evidence.evidenceId)
      || evidenceIds.has(evidence.evidenceId)) {
      throw deepError('invalid_job', 'Evidence must be canonical, linked, and uniquely identified', false)
    }
    evidenceIds.add(evidence.evidenceId)
  }
  if (!Array.isArray(job.escalation.supportingEvidenceRefs)
    || job.escalation.supportingEvidenceRefs.length === 0
    || new Set(job.escalation.supportingEvidenceRefs).size !== job.escalation.supportingEvidenceRefs.length
    || job.escalation.supportingEvidenceRefs.some((reference) => !evidenceIds.has(reference))) {
    throw deepError('invalid_job', 'Supporting evidence references must name supplied evidence IDs', false)
  }
}

function validateBudgets(budget: DeepResearchBudget, capabilities: ReadonlySet<DeepResearchCapability>): void {
  for (const field of [
    'maxProviderCalls', 'maxInputTokens', 'maxOutputTokens', 'maxToolCalls',
    'maxBrowserNavigations', 'maxSearchQueries', 'maxHttpFetches', 'maxWallTimeMs',
    'maxOutputBytes', 'memoryMaxBytes', 'tasksMax',
  ] as const) {
    if (!Number.isInteger(budget[field]) || budget[field] < 0) {
      throw deepError('invalid_job', `${field} must be a non-negative integer`, false)
    }
  }
  for (const field of ['maxProviderCalls', 'maxInputTokens', 'maxOutputTokens', 'maxWallTimeMs', 'maxOutputBytes', 'memoryMaxBytes', 'tasksMax'] as const) {
    if (budget[field] === 0) throw deepError('invalid_job', `${field} must be positive`, false)
  }
  if (!Number.isInteger(budget.cpuQuotaPercent) || budget.cpuQuotaPercent < 1 || budget.cpuQuotaPercent > 100) {
    throw deepError('invalid_job', 'cpuQuotaPercent must be an integer from 1 to 100', false)
  }
  const limits: Array<[DeepResearchCapability, keyof DeepResearchBudget]> = [
    ['browser_navigation', 'maxBrowserNavigations'],
    ['registered_search', 'maxSearchQueries'],
    ['http_fetch', 'maxHttpFetches'],
  ]
  for (const [capability, field] of limits) {
    if (capabilities.has(capability) !== (budget[field] > 0)) {
      throw deepError('invalid_job', `${field} must be positive exactly when ${capability} is enabled`, false)
    }
  }
  const possibleToolCalls = budget.maxBrowserNavigations + budget.maxSearchQueries + budget.maxHttpFetches
  if (budget.maxToolCalls > possibleToolCalls) {
    throw deepError('invalid_job', 'maxToolCalls cannot exceed the sum of capability-specific limits', false)
  }
}

function validateDomain(domain: string): void {
  if (domain !== domain.toLowerCase()
    || domain.length > 253
    || domain.includes('*')
    || isIP(domain) !== 0
    || domain === 'localhost'
    || domain.endsWith('.localhost')
    || domain.endsWith('.local')
    || !/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(domain)) {
    throw deepError('invalid_job', `Approved domain is not a public DNS name: ${domain}`, false)
  }
}

function validateWorker(worker: DeepResearchWorkerCommand): DeepResearchWorkerCommand {
  if (!isAbsolute(worker.executable) || worker.executable.includes('\0')) {
    throw deepError('invalid_job', 'Contained worker executable must be an absolute path', false)
  }
  for (const arg of worker.args ?? []) {
    if (typeof arg !== 'string' || arg.includes('\0') || arg.length > 2_000) {
      throw deepError('invalid_job', 'Contained worker arguments must be bounded strings', false)
    }
  }
  return { executable: worker.executable, args: [...(worker.args ?? [])] }
}

function minimalEnvironment(): NodeJS.ProcessEnv {
  return { PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin', LANG: 'C.UTF-8' }
}

function safeIdentifier(value: string): boolean {
  return typeof value === 'string' && value.length > 0 && value.length <= 200
    && /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value)
}

function safeRouteValue(value: string): boolean {
  return typeof value === 'string' && value.length > 0 && value.length <= 200
    && /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(value)
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`)
  return value
}

function deepError(
  category: DeepResearchError['category'],
  message: string,
  retryable: boolean,
  metadata?: DeepResearchExecutionMetadata,
  cause?: unknown,
): DeepResearchError {
  return new DeepResearchError(message, { category, retryable, metadata, cause })
}
