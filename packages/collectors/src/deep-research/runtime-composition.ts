import { realpathSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, isAbsolute, relative, resolve } from 'node:path'
import type { ExecutionLedger } from '../signal-platform/execution-ledger'
import type { RetrievedEvidence, ResearchWorkItem, Signal } from '../signal-platform/contracts'
import type { DeepResearchPort } from '../research-engine/shared-worker'
import { DeepResearchExecutor, type DeepResearchExecutionRegistry } from './executor'
import { NodeSystemdController, type DeepResearchSystemdController } from './systemd-controller'
import type { DeepResearchCapability, DeepResearchJob } from './types'
import { InferenceGateway } from '../inference-gateway'
import { DeepResearchGatewayPort } from './gateway-port'
import {
  NodeDeepResearchOrphanInspector,
  discoverDeepResearchOrphans,
  type DeepResearchOrphanInspectionPort,
} from './orphan-discovery'
import {
  AtomicDeepResearchRuntimeStatusFile,
  deepResearchRuntimeSnapshot,
  type DeepResearchRuntimeSnapshotV1,
} from './runtime-status'
import {
  DeepResearchSideQueueWorker,
  buildDeepResearchJob,
  type DeepResearchJobPolicy,
  type DeepResearchPreflightPort,
  type DeepResearchWorkStore,
  type DeepResearchWorkerOutcome,
} from './worker'

export const DEEP_RESEARCH_RUNTIME_ENV = Object.freeze({
  workerExecutable: 'FEED_V3_DEEP_RESEARCH_WORKER_EXECUTABLE',
  workerContractVersion: 'FEED_V3_DEEP_RESEARCH_WORKER_CONTRACT_VERSION',
  workerArgsJson: 'FEED_V3_DEEP_RESEARCH_WORKER_ARGS_JSON',
  approvedDomains: 'FEED_V3_DEEP_RESEARCH_APPROVED_DOMAINS',
  capabilities: 'FEED_V3_DEEP_RESEARCH_CAPABILITIES',
  provider: 'FEED_V3_DEEP_RESEARCH_PROVIDER',
  model: 'FEED_V3_DEEP_RESEARCH_MODEL',
  promptVersion: 'FEED_V3_DEEP_RESEARCH_PROMPT_VERSION',
  maxBrowserNavigations: 'FEED_V3_DEEP_RESEARCH_MAX_BROWSER_NAVIGATIONS',
  maxSearchQueries: 'FEED_V3_DEEP_RESEARCH_MAX_SEARCH_QUERIES',
  maxHttpFetches: 'FEED_V3_DEEP_RESEARCH_MAX_HTTP_FETCHES',
  maxOutputBytes: 'FEED_V3_DEEP_RESEARCH_MAX_OUTPUT_BYTES',
  cpuQuotaPercent: 'FEED_V3_DEEP_RESEARCH_CPU_QUOTA_PERCENT',
  memoryMaxBytes: 'FEED_V3_DEEP_RESEARCH_MEMORY_MAX_BYTES',
  tasksMax: 'FEED_V3_DEEP_RESEARCH_TASKS_MAX',
  reasoningEffort: 'FEED_V3_DEEP_RESEARCH_REASONING_EFFORT',
  maxConcurrency: 'FEED_V3_DEEP_RESEARCH_MAX_CONCURRENCY',
  rateMaxCalls: 'FEED_V3_DEEP_RESEARCH_RATE_MAX_CALLS',
  rateWindowMs: 'FEED_V3_DEEP_RESEARCH_RATE_WINDOW_MS',
  auditTempRoots: 'FEED_V3_DEEP_RESEARCH_AUDIT_TEMP_ROOTS',
  auditProfileRoots: 'FEED_V3_DEEP_RESEARCH_AUDIT_PROFILE_ROOTS',
  auditLimit: 'FEED_V3_DEEP_RESEARCH_AUDIT_LIMIT',
  auditIntervalMs: 'FEED_V3_DEEP_RESEARCH_AUDIT_INTERVAL_MS',
  runtimeStatusPath: 'FEED_V3_DEEP_RESEARCH_RUNTIME_STATUS_PATH',
})

export interface DeepResearchRuntimeConfiguration {
  workerExecutable: string
  workerContractVersion: 'myboon.deep_worker.v1'
  workerArgs: readonly string[]
  approvedDomains: ReadonlySet<string>
  policy: DeepResearchJobPolicy
  gatewayPolicy: {
    reasoningEffort: 'low' | 'medium' | 'high'
    maxConcurrency: number
    rateLimit: { maxCalls: number, windowMs: number }
  }
  audit: { tempRoots: readonly string[], profileRoots: readonly string[], limit: number, intervalMs: number, runtimeStatusPath: string }
}

export interface ProductionDeepResearchRuntime {
  enqueue: DeepResearchPort
  runCycle(): Promise<DeepResearchWorkerOutcome[]>
  stop(): Promise<void>
  close(): void
  circuitStatusSnapshot(): ReturnType<InferenceGateway['circuitStatusSnapshot']>
  readonly status: DeepResearchRuntimeSnapshotV1
}

export interface CreateProductionDeepResearchRuntimeOptions {
  env?: Readonly<Record<string, string | undefined>>
  stores: DeepResearchWorkStore[]
  workerId?: string
  executionLedger?: Pick<ExecutionLedger, 'append'>
  systemd?: DeepResearchSystemdController
  executionRegistries: Array<{
    sourceType: Signal['sourceType']
    registry: DeepResearchExecutionRegistry & { close(): void }
  }>
  platform?: NodeJS.Platform
  gateway: InferenceGateway
  orphanInspector?: DeepResearchOrphanInspectionPort
  statusWriter?: Pick<AtomicDeepResearchRuntimeStatusFile, 'write'>
  now?: () => Date
}

const CAPABILITIES = new Set<DeepResearchCapability>([
  'browser_navigation', 'registered_search', 'http_fetch',
])

export function loadDeepResearchRuntimeConfiguration(
  env: Readonly<Record<string, string | undefined>>,
): DeepResearchRuntimeConfiguration {
  const executable = required(env, DEEP_RESEARCH_RUNTIME_ENV.workerExecutable)
  if (!isAbsolute(executable) || executable.includes('\0')) {
    throw new Error(`${DEEP_RESEARCH_RUNTIME_ENV.workerExecutable} must be an absolute executable path`)
  }
  const capabilities = csv(env, DEEP_RESEARCH_RUNTIME_ENV.capabilities) as DeepResearchCapability[]
  if (capabilities.some((value) => !CAPABILITIES.has(value))) {
    throw new Error('Deep research capabilities contain a forbidden tool class')
  }
  const approvedDomains = new Set(csv(env, DEEP_RESEARCH_RUNTIME_ENV.approvedDomains).map(validateDomain))
  const workerContractVersion = required(env, DEEP_RESEARCH_RUNTIME_ENV.workerContractVersion)
  if (workerContractVersion !== 'myboon.deep_worker.v1') {
    throw new Error(`${DEEP_RESEARCH_RUNTIME_ENV.workerContractVersion} must be myboon.deep_worker.v1`)
  }
  const workerArgs = parseArgs(env[DEEP_RESEARCH_RUNTIME_ENV.workerArgsJson])
  const policy: DeepResearchJobPolicy = {
    promptVersion: safe(required(env, DEEP_RESEARCH_RUNTIME_ENV.promptVersion), 'deep prompt version'),
    provider: safe(required(env, DEEP_RESEARCH_RUNTIME_ENV.provider), 'deep provider'),
    model: safe(required(env, DEEP_RESEARCH_RUNTIME_ENV.model), 'deep model'),
    reasoningEffort: 'low',
    capabilities,
    maxBrowserNavigations: integer(env, DEEP_RESEARCH_RUNTIME_ENV.maxBrowserNavigations, 0, 100),
    maxSearchQueries: integer(env, DEEP_RESEARCH_RUNTIME_ENV.maxSearchQueries, 0, 100),
    maxHttpFetches: integer(env, DEEP_RESEARCH_RUNTIME_ENV.maxHttpFetches, 0, 100),
    maxOutputBytes: integer(env, DEEP_RESEARCH_RUNTIME_ENV.maxOutputBytes, 1_024, 10_000_000),
    cpuQuotaPercent: integer(env, DEEP_RESEARCH_RUNTIME_ENV.cpuQuotaPercent, 1, 100),
    memoryMaxBytes: integer(env, DEEP_RESEARCH_RUNTIME_ENV.memoryMaxBytes, 16 * 1024 * 1024, 16 * 1024 ** 3),
    tasksMax: integer(env, DEEP_RESEARCH_RUNTIME_ENV.tasksMax, 1, 1_024),
    unresolvedQuestion: ({ workItem }) =>
      `Resolve the policy-admitted ${workItem.deepReason} question using only the canonical evidence and approved public domains.`,
  }
  const reasoningEffort = required(env, DEEP_RESEARCH_RUNTIME_ENV.reasoningEffort)
  if (!['low', 'medium', 'high'].includes(reasoningEffort)) throw new Error('Deep reasoning effort must be low, medium, or high')
  const gatewayPolicy = {
    reasoningEffort: reasoningEffort as 'low' | 'medium' | 'high',
    maxConcurrency: integer(env, DEEP_RESEARCH_RUNTIME_ENV.maxConcurrency, 1, 100),
    rateLimit: {
      maxCalls: integer(env, DEEP_RESEARCH_RUNTIME_ENV.rateMaxCalls, 1, 10_000),
      windowMs: integer(env, DEEP_RESEARCH_RUNTIME_ENV.rateWindowMs, 1_000, 86_400_000),
    },
  }
  policy.reasoningEffort = gatewayPolicy.reasoningEffort
  const tempRoots = validatedAuditRoots(env, DEEP_RESEARCH_RUNTIME_ENV.auditTempRoots)
  const profileRoots = validatedAuditRoots(env, DEEP_RESEARCH_RUNTIME_ENV.auditProfileRoots)
  const audit = {
    tempRoots, profileRoots,
    limit: integer(env, DEEP_RESEARCH_RUNTIME_ENV.auditLimit, 1, 10_000),
    intervalMs: optionalInteger(env, DEEP_RESEARCH_RUNTIME_ENV.auditIntervalMs, 300_000, 10_000, 86_400_000),
    runtimeStatusPath: absolute(required(env, DEEP_RESEARCH_RUNTIME_ENV.runtimeStatusPath), DEEP_RESEARCH_RUNTIME_ENV.runtimeStatusPath),
  }
  const capabilityLimits: Array<[DeepResearchCapability, number]> = [
    ['browser_navigation', policy.maxBrowserNavigations],
    ['registered_search', policy.maxSearchQueries],
    ['http_fetch', policy.maxHttpFetches],
  ]
  if (capabilityLimits.some(([capability, limit]) => capabilities.includes(capability) !== (limit > 0))) {
    throw new Error('Each deep capability must have a positive bound, and disabled capabilities must have a zero bound')
  }
  // The worker constructor performs the final cross-field capability/limit validation.
  return Object.freeze({
    workerExecutable: executable,
    workerContractVersion,
    workerArgs: Object.freeze(workerArgs),
    approvedDomains,
    policy,
    gatewayPolicy,
    audit,
  })
}

export function createProductionDeepResearchRuntime(
  options: CreateProductionDeepResearchRuntimeOptions,
): ProductionDeepResearchRuntime {
  const configuration = loadDeepResearchRuntimeConfiguration(options.env ?? process.env)
  const systemd = options.systemd ?? new NodeSystemdController()
  const registry = new SourceRoutedDeepResearchExecutionRegistry(options.executionRegistries)
  const executor = new DeepResearchExecutor({
    enabled: true,
    worker: { executable: configuration.workerExecutable, args: configuration.workerArgs },
    registry,
    systemd,
    platform: options.platform,
    tempRoot: configuration.audit.tempRoots[0],
  })
  const gateway = options.gateway
  const configuredRoute = gateway.resolveRoute('research.deep', 'investigate')
  if (configuredRoute.primary.provider !== configuration.policy.provider
    || configuredRoute.primary.model !== configuration.policy.model
    || configuredRoute.reasoningEffort !== configuration.gatewayPolicy.reasoningEffort
    || configuredRoute.maxConcurrency !== configuration.gatewayPolicy.maxConcurrency
    || configuredRoute.rateLimit?.maxCalls !== configuration.gatewayPolicy.rateLimit.maxCalls
    || configuredRoute.rateLimit?.windowMs !== configuration.gatewayPolicy.rateLimit.windowMs) {
    throw new Error('Deep runtime policy must exactly match the central gateway route')
  }
  gateway.attachInvestigationPort(new DeepResearchGatewayPort(executor))
  const inspector = options.orphanInspector ?? new NodeDeepResearchOrphanInspector()
  const statusWriter = options.statusWriter ?? new AtomicDeepResearchRuntimeStatusFile(configuration.audit.runtimeStatusPath)
  let lastAudit: Awaited<ReturnType<typeof discoverDeepResearchOrphans>> | null = null
  let nextAuditAt = 0
  let status = deepResearchRuntimeSnapshot({ enabled: true })
  const now = options.now ?? (() => new Date())
  const refreshStatus = async (forceAudit = false) => {
    const currentTime = now()
    let activeExecutions = 0
    try {
      const registered = registry.list()
      activeExecutions = registered.length
      if (forceAudit || lastAudit === null || currentTime.getTime() >= nextAuditAt) {
        lastAudit = await discoverDeepResearchOrphans({
          registered, inspector, tempRoots: configuration.audit.tempRoots,
          profileRoots: configuration.audit.profileRoots,
          sandboxExecutables: [configuration.workerExecutable], limit: configuration.audit.limit,
          now: () => currentTime,
        })
        nextAuditAt = currentTime.getTime() + configuration.audit.intervalMs
      }
    } catch {
      lastAudit = Object.freeze({
        auditedAt: currentTime.toISOString(), activeExecutions, suspectedOrphans: 0,
        unregisteredArtifacts: Object.freeze([]), incomplete: true,
        errors: Object.freeze(['registry_or_audit_failed']),
      })
    }
    status = deepResearchRuntimeSnapshot({ enabled: true, audit: lastAudit, activeExecutions, now: () => currentTime })
    try { await statusWriter.write(status) } catch {
      status = Object.freeze({ ...status, incomplete: true, errors: Object.freeze([...new Set([...status.errors, 'runtime_status_write_failed'])]) })
    }
    return status
  }
  const gatewayExecutor = {
    execute: (job: DeepResearchJob, executeOptions?: { signal?: AbortSignal, onExecutionStarted?: () => boolean | Promise<boolean> }) => gateway.investigate<import('./types').DeepResearchResult>({
      workload: 'research.deep', purpose: 'research.deep.contained', prompt: `Execute canonical contained job ${job.jobId}`,
      promptVersion: configuration.policy.promptVersion, policyVersion: job.workItem.policyVersion,
      budget: { ...job.budget, maxRepairCalls: 0 }, allowedCapabilities: job.capabilities, job,
      signal: executeOptions?.signal,
      onExecutionStarted: executeOptions?.onExecutionStarted,
    }),
  }
  const preflight = productionPreflight(configuration, systemd, options.platform ?? process.platform, gateway)
  const worker = new DeepResearchSideQueueWorker({
    workerId: options.workerId ?? `feed-v3-deep-research-${process.pid}`,
    stores: options.stores,
    executor: gatewayExecutor,
    policy: configuration.policy,
    preflight,
    executionLedger: options.executionLedger,
  })
  const enqueue: DeepResearchPort = {
    enqueue: async ({ workItem, signal, evidence }) => {
      const job = buildDeepResearchJob({ workItem, signal, evidence, policy: configuration.policy })
      assertJobPolicy(job, configuration)
    },
  }
  return {
    get status() { return status },
    enqueue,
    runCycle: async () => {
      const observed = await refreshStatus(lastAudit === null)
      if (observed.incomplete) return [{ kind: 'idle' }]
      const outcome = await worker.runOnce()
      const forceAudit = (outcome.kind === 'retry_wait' || outcome.kind === 'dead_letter' || outcome.kind === 'expired')
        && (outcome.category === 'provider_timeout' || outcome.category === 'storage_permanent')
      await refreshStatus(forceAudit)
      return [outcome]
    },
    stop: () => worker.stop({ drain: true }),
    close: () => registry.close(),
    circuitStatusSnapshot: () => gateway.circuitStatusSnapshot(),
  }
}

export class SourceRoutedDeepResearchExecutionRegistry implements DeepResearchExecutionRegistry {
  private readonly bySource: ReadonlyMap<Signal['sourceType'], DeepResearchExecutionRegistry & { close(): void }>
  constructor(items: CreateProductionDeepResearchRuntimeOptions['executionRegistries']) {
    const bySource = new Map<Signal['sourceType'], DeepResearchExecutionRegistry & { close(): void }>()
    for (const item of items) {
      if (bySource.has(item.sourceType)) throw new Error(`Duplicate deep execution registry for ${item.sourceType}`)
      bySource.set(item.sourceType, item.registry)
    }
    if (bySource.size === 0) throw new Error('At least one source-local deep execution registry is required')
    this.bySource = bySource
  }
  register(metadata: Parameters<DeepResearchExecutionRegistry['register']>[0]): void {
    const registry = this.bySource.get(metadata.sourceType)
    if (!registry) throw new Error(`No source-local deep execution registry for ${metadata.sourceType}`)
    registry.register(metadata)
  }
  unregister(unitName: string): void {
    for (const registry of new Set(this.bySource.values())) registry.unregister(unitName)
  }
  list() {
    return [...new Set(this.bySource.values())].flatMap((registry) => registry.list())
  }
  close(): void {
    for (const registry of new Set(this.bySource.values())) registry.close()
  }
}

function productionPreflight(
  configuration: DeepResearchRuntimeConfiguration,
  systemd: DeepResearchSystemdController,
  platform: NodeJS.Platform,
  gateway: Pick<InferenceGateway, 'checkReadiness'>,
): DeepResearchPreflightPort {
  const stage = async () => {
    if (platform !== 'linux') {
      return { ready: false as const, reason: 'unsupported_platform' as const, detail: 'Linux is required' }
    }
    if (!await systemd.isAvailable()) {
      return { ready: false as const, reason: 'systemd_unavailable' as const, detail: 'systemd unavailable' }
    }
    const route = gateway.checkReadiness('research.deep')
    if (!route.ready) return { ready: false as const, reason: 'circuit_open' as const, detail: 'Deep gateway route is unavailable' }
    return { ready: true as const }
  }
  return {
    checkStage: stage,
    async check(job) {
      const readiness = await stage()
      if (!readiness.ready) return readiness
      try {
        assertJobPolicy(job, configuration)
        return { ready: true }
      } catch {
        return { ready: false, reason: 'invalid_job_policy', detail: 'Deep job violates configured policy' }
      }
    },
  }
}

function assertJobPolicy(job: DeepResearchJob, configuration: DeepResearchRuntimeConfiguration): void {
  if (job.capabilities.length !== configuration.policy.capabilities.length
    || job.capabilities.some((capability) => !configuration.policy.capabilities.includes(capability))) {
    throw new Error('Deep job capabilities do not exactly match the configured allowlist')
  }
  if (job.approvedDomains.some((domain) => !configuration.approvedDomains.has(domain))) {
    throw new Error('Deep job contains a domain outside the configured production allowlist')
  }
}

function required(env: Readonly<Record<string, string | undefined>>, name: string): string {
  const value = env[name]?.trim()
  if (!value) throw new Error(`${name} is required when deep research is enabled`)
  if (value.length > 2_000 || value.includes('\0')) throw new Error(`${name} is unsafe or unbounded`)
  return value
}

function absolute(value: string, name: string): string {
  if (!isAbsolute(value)) throw new Error(`${name} must contain absolute paths`)
  return value
}

function validatedAuditRoots(env: Readonly<Record<string, string | undefined>>, name: string): string[] {
  const values = csv(env, name).map((value) => absolute(value, name))
  if (values.length === 0) throw new Error(`${name} must contain at least one explicit root`)
  if (values.length > 16) throw new Error(`${name} must contain at most 16 roots`)
  const roots = values.map((value) => {
    let real: string
    try {
      real = realpathSync(value)
      if (!statSync(real).isDirectory()) throw new Error('not directory')
    } catch { throw new Error(`${name} roots must be existing real directories`) }
    const projectRoot = resolve(process.cwd().endsWith('/packages/collectors') ? resolve(process.cwd(), '../..') : process.cwd())
    const protectedBoundaries = [resolve(homedir()), projectRoot]
    if (!basename(real).startsWith('myboon-deep')
      || real === '/'
      || protectedBoundaries.some((boundary) => isWithin(real, boundary) || isWithin(boundary, real))) {
      throw new Error(`${name} must use dedicated roots outside home, repository, and broad system paths`)
    }
    return real
  })
  const unique = [...new Set(roots)]
  for (let index = 0; index < unique.length; index += 1) {
    for (let other = index + 1; other < unique.length; other += 1) {
      if (isWithin(unique[index]!, unique[other]!) || isWithin(unique[other]!, unique[index]!)) {
        throw new Error(`${name} roots must not overlap or nest`)
      }
    }
  }
  return unique
}

function isWithin(candidate: string, boundary: string): boolean {
  const path = relative(boundary, candidate)
  return path === '' || (!path.startsWith('..') && !isAbsolute(path))
}

function csv(env: Readonly<Record<string, string | undefined>>, name: string): string[] {
  const values = required(env, name).split(',').map((value) => value.trim()).filter(Boolean)
  if (values.length === 0 || values.length !== new Set(values).size) throw new Error(`${name} must be a unique non-empty list`)
  return values
}

function parseArgs(raw: string | undefined): string[] {
  if (raw === undefined || !raw.trim()) return []
  let value: unknown
  try { value = JSON.parse(raw) } catch { throw new Error(`${DEEP_RESEARCH_RUNTIME_ENV.workerArgsJson} must be a JSON string array`) }
  if (!Array.isArray(value) || value.length > 32
    || value.some((item) => typeof item !== 'string' || item.length > 2_000 || item.includes('\0'))) {
    throw new Error(`${DEEP_RESEARCH_RUNTIME_ENV.workerArgsJson} must be a bounded JSON string array`)
  }
  const args = value as string[]
  const reserved = ['--job-file', '--usage-file', '--evidence-manifest-file', '--profile-dir']
  if (args.some((item) => reserved.some((prefix) => item === prefix || item.startsWith(`${prefix}=`))
    || /(?:toolsets?|terminal|shell|package-install)/i.test(item))) {
    throw new Error(`${DEEP_RESEARCH_RUNTIME_ENV.workerArgsJson} contains a reserved or forbidden capability argument`)
  }
  return args
}

function integer(env: Readonly<Record<string, string | undefined>>, name: string, min: number, max: number): number {
  const value = Number(required(env, name))
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${name} must be an integer between ${min} and ${max}`)
  return value
}

function optionalInteger(env: Readonly<Record<string, string | undefined>>, name: string, fallback: number, min: number, max: number): number {
  if (env[name] === undefined || !env[name]?.trim()) return fallback
  return integer(env, name, min, max)
}

function safe(value: string, name: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/.test(value)) throw new Error(`${name} is unsafe`)
  return value
}

function validateDomain(value: string): string {
  const domain = value.toLowerCase()
  if (value !== domain || value.length > 253 || value.includes('*')
    || !/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(value)) {
    throw new Error(`Deep approved domain is not an exact public DNS suffix: ${value}`)
  }
  return domain
}
