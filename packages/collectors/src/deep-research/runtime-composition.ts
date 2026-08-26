import { isAbsolute } from 'node:path'
import type { ExecutionLedger } from '../signal-platform/execution-ledger'
import type { RetrievedEvidence, ResearchWorkItem, Signal } from '../signal-platform/contracts'
import type { DeepResearchPort } from '../research-engine/shared-worker'
import { DeepResearchExecutor, type DeepResearchExecutionRegistry } from './executor'
import { NodeSystemdController, type DeepResearchSystemdController } from './systemd-controller'
import type { DeepResearchCapability, DeepResearchJob } from './types'
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
})

export interface DeepResearchRuntimeConfiguration {
  workerExecutable: string
  workerContractVersion: 'myboon.deep_worker.v1'
  workerArgs: readonly string[]
  approvedDomains: ReadonlySet<string>
  policy: DeepResearchJobPolicy
}

export interface ProductionDeepResearchRuntime {
  enqueue: DeepResearchPort
  runCycle(): Promise<DeepResearchWorkerOutcome[]>
  stop(): Promise<void>
  close(): void
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
  })
  const preflight = productionPreflight(configuration, systemd, options.platform ?? process.platform)
  const worker = new DeepResearchSideQueueWorker({
    workerId: options.workerId ?? `feed-v3-deep-research-${process.pid}`,
    stores: options.stores,
    executor,
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
    enqueue,
    runCycle: async () => [await worker.runOnce()],
    stop: () => worker.stop({ drain: true }),
    close: () => registry.close(),
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
): DeepResearchPreflightPort {
  const stage = async () => {
    if (platform !== 'linux') {
      return { ready: false as const, reason: 'unsupported_platform' as const, detail: 'Linux is required' }
    }
    if (!await systemd.isAvailable()) {
      return { ready: false as const, reason: 'systemd_unavailable' as const, detail: 'systemd unavailable' }
    }
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
        return { ready: false, reason: 'containment_disabled', detail: 'Deep job violates configured policy' }
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
