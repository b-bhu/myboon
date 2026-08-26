import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'
import {
  InferenceGatewayStageReadiness,
  createConfiguredInferenceGateway,
  type InferenceCircuitStatusSnapshot,
  type InferenceGatewayStatusSnapshot,
} from '../inference-gateway'
import type { PriorityClass, ResearchWorkItem, Signal } from '../signal-platform/contracts'
import type { ExecutionTraceEvent } from '../signal-platform/contracts'
import type { ExecutionLedger } from '../signal-platform/execution-ledger'
import { SqliteExecutionLedger } from '../signal-platform/sqlite-execution-ledger'
import { loadFeedV3RuntimeConfig, type FeedV3WorkerMode } from '../signal-platform/runtime-config'
import { type ClaimNextCommand, type GlobalSchedulerQuery } from '../signal-platform/shared-scheduler'
import { SqliteSignalPlatformStore } from '../signal-platform/sqlite-platform-store'
import { SqliteResearchShadowStore } from '../signal-platform/sqlite-research-shadow-store'
import { compareResearchWorkPriority, type WorkLease } from '../signal-platform/store-adapter'
import { DeterministicRetriever } from './deterministic-retrieval'
import { ResearchShadowEvaluator, type ShadowEvaluationOutcome } from './shadow-evaluator'
import {
  SharedResearchWorker,
  type DeepResearchPort,
  type SharedResearchRunOutcome,
  type SharedResearchSchedulerPort,
  type SharedResearchWorkPort,
} from './shared-worker'
import {
  createConfiguredStandardSearch,
  loadStandardSearchConfiguration,
  standardSearchStatus,
  type RegisteredSearchConnectorFactories,
  type StandardSearchStatusSnapshot,
} from './standard-search-configuration'
import { StructuredResearchSynthesizer } from './structured-synthesizer'

export const SHARED_RESEARCH_ENV = Object.freeze({
  runOnce: 'FEED_V3_RESEARCH_RUN_ONCE',
  intervalMs: 'FEED_V3_RESEARCH_INTERVAL_MS',
  batchSize: 'FEED_V3_RESEARCH_BATCH_SIZE',
  promptVersion: 'FEED_V3_RESEARCH_PROMPT_VERSION',
  urgentPriorities: 'FEED_V3_RESEARCH_URGENT_PRIORITIES',
  backgroundPriorities: 'FEED_V3_RESEARCH_BACKGROUND_PRIORITIES',
})

type SupportedResearchSource = Extract<Signal['sourceType'], 'news' | 'polymarket'>

export interface SharedResearchRunnerConfig {
  mode: FeedV3WorkerMode
  sources: SupportedResearchSource[]
  batchSize: number
  intervalMs: number
  runOnce: boolean
  promptVersion: string
  sampleBasisPoints: number
  deepEnabled: boolean
  urgentPriorities: PriorityClass[]
  backgroundPriorities: PriorityClass[]
  newsPath: string
  pipelinePath: string
  env: Readonly<Record<string, string | undefined>>
}

export interface SharedResearchRuntimeStatus {
  schemaVersion: 'myboon.shared_research_runtime_status.v1'
  mode: Exclude<FeedV3WorkerMode, 'off'>
  sources: SupportedResearchSource[]
  supportedDepths: ResearchWorkItem['researchDepth'][]
  priorityPools: Array<{ name: 'urgent' | 'background', priorities: PriorityClass[] }>
  standardSearch: StandardSearchStatusSnapshot
  gateway: InferenceGatewayStatusSnapshot
  circuits: InferenceCircuitStatusSnapshot
  deepEnabled: boolean
}

export interface SharedResearchRunnerRuntime {
  readonly status: SharedResearchRuntimeStatus
  runCycle(): Promise<Array<SharedResearchRunOutcome | ShadowEvaluationOutcome>>
  stop(): Promise<void>
  close(): void
}

export interface RunSharedResearchOptions {
  env?: Readonly<Record<string, string | undefined>>
  signal?: AbortSignal
  createRuntime?: (config: SharedResearchRunnerConfig) => SharedResearchRunnerRuntime
  onResult?: (result: SharedResearchRunnerCycleResult) => void
  wait?: (ms: number, signal?: AbortSignal) => Promise<void>
}

export type SharedResearchRunnerCycleResult =
  | { kind: 'disabled' }
  | { kind: 'completed', status: SharedResearchRuntimeStatus, outcomes: Array<SharedResearchRunOutcome | ShadowEvaluationOutcome> }

export interface CreateLiveSharedResearchRuntimeOptions {
  standardSearchFactories?: RegisteredSearchConnectorFactories
  /** No production deep factory is registered yet; explicit deep enablement fails closed without one. */
  createDeepRuntime?: (input: { stores: SharedResearchWorkPort[] }) => {
    enqueue: DeepResearchPort
    runCycle(): Promise<SharedResearchRunOutcome[]>
    stop(): Promise<void>
    close(): void
  }
}

const PACKAGE_DIR = resolve(__dirname, '..', '..')

export function loadSharedResearchRunnerConfig(
  env: Readonly<Record<string, string | undefined>> = process.env,
): SharedResearchRunnerConfig {
  const feed = loadFeedV3RuntimeConfig(env)
  const selected = feed.researchMode === 'active' ? feed.researchActiveSources : feed.researchShadowSources
  const sources = [...selected].map((source) => {
    if (source !== 'news' && source !== 'polymarket') throw new Error(`Research runtime has no registered store for ${source}`)
    return source
  })
  return Object.freeze({
    mode: feed.researchMode,
    sources,
    batchSize: integer(env[SHARED_RESEARCH_ENV.batchSize], 1, 250, 10, 'research batch size'),
    intervalMs: integer(env[SHARED_RESEARCH_ENV.intervalMs], 100, 24 * 60 * 60_000, 5_000, 'research interval'),
    runOnce: flag(env[SHARED_RESEARCH_ENV.runOnce], false, 'research run once'),
    promptVersion: safeValue(env[SHARED_RESEARCH_ENV.promptVersion] ?? 'research.synthesis.prompt.v1', 'research prompt version'),
    sampleBasisPoints: feed.shadowSampleBasisPoints,
    deepEnabled: feed.deepResearchEnabled,
    urgentPriorities: priorities(env[SHARED_RESEARCH_ENV.urgentPriorities], ['P0', 'P1']),
    backgroundPriorities: priorities(env[SHARED_RESEARCH_ENV.backgroundPriorities], ['P2', 'P3']),
    newsPath: databasePath(env.NEWS_SQLITE_PATH, '.data/news.sqlite'),
    pipelinePath: databasePath(env.PIPELINE_SQLITE_PATH, '.data/pipeline.sqlite'),
    env,
  })
}

/** Disabled mode never invokes createRuntime and remains resident until signal. */
export async function runSharedResearchLoop(options: RunSharedResearchOptions = {}): Promise<void> {
  const config = loadSharedResearchRunnerConfig(options.env)
  const wait = options.wait ?? abortableWait
  if (config.mode === 'off') {
    options.onResult?.({ kind: 'disabled' })
    if (config.runOnce) return
    while (!options.signal?.aborted) await wait(config.intervalMs, options.signal)
    return
  }
  const runtime = (options.createRuntime ?? ((input) => createLiveSharedResearchRuntime(input)))(config)
  try {
    do {
      if (options.signal?.aborted) break
      const outcomes = await runtime.runCycle()
      options.onResult?.({ kind: 'completed', status: runtime.status, outcomes })
      if (config.runOnce) break
      await wait(config.intervalMs, options.signal)
    } while (!options.signal?.aborted)
  } finally {
    await runtime.stop()
    runtime.close()
  }
}

export function createLiveSharedResearchRuntime(
  config: SharedResearchRunnerConfig,
  options: CreateLiveSharedResearchRuntimeOptions = {},
): SharedResearchRunnerRuntime {
  const runtimeMode = config.mode
  if (runtimeMode === 'off') throw new Error('Disabled research must not construct a live runtime')
  const paths = new Map<SupportedResearchSource, string>([['news', config.newsPath], ['polymarket', config.pipelinePath]])
  for (const source of config.sources) {
    const path = paths.get(source)!
    if (!existsSync(path)) throw new Error(`${source} SQLite database does not exist at ${path}`)
  }
  const stores = config.sources.map((source) => new SqliteSignalPlatformStore(paths.get(source)!, source, {
    readOnly: config.mode === 'shadow',
  }))
  let standardConfiguration: ReturnType<typeof loadStandardSearchConfiguration>
  let standardSearch: ReturnType<typeof createConfiguredStandardSearch>
  let gatewayRuntime: ReturnType<typeof createConfiguredInferenceGateway>
  try {
    standardConfiguration = loadStandardSearchConfiguration(config.env)
    standardSearch = createConfiguredStandardSearch({
      configuration: standardConfiguration,
      factories: options.standardSearchFactories,
    })
    gatewayRuntime = createConfiguredInferenceGateway({ env: config.env })
  } catch (error) {
    stores.forEach((store) => store.close())
    throw error
  }
  const synthesizer = new StructuredResearchSynthesizer({ gateway: gatewayRuntime.gateway, promptVersion: config.promptVersion })
  const supportedDepths: ResearchWorkItem['researchDepth'][] = standardSearch ? ['light', 'standard'] : ['light']
  if (config.deepEnabled) supportedDepths.push('deep')
  const runtimeStatus = (): SharedResearchRuntimeStatus => Object.freeze({
    schemaVersion: 'myboon.shared_research_runtime_status.v1', mode: runtimeMode,
    sources: [...config.sources], supportedDepths: [...supportedDepths],
    priorityPools: [
      { name: 'urgent' as const, priorities: [...config.urgentPriorities] },
      { name: 'background' as const, priorities: [...config.backgroundPriorities] },
    ],
    standardSearch: standardSearchStatus(standardConfiguration), gateway: gatewayRuntime.status,
    circuits: gatewayRuntime.gateway.circuitStatusSnapshot(), deepEnabled: config.deepEnabled,
  })
  if (config.mode === 'shadow') {
    const shadowStores: Array<{ source: SupportedResearchSource, store: SqliteResearchShadowStore }> = []
    try {
      for (const source of config.sources) {
        shadowStores.push({ source, store: new SqliteResearchShadowStore(paths.get(source)!) })
      }
      const results = new SourceShadowResultStore(shadowStores)
      const evaluator = new ResearchShadowEvaluator({
        scheduler: new ResearchDepthFilteredScheduler(stores, supportedDepths), stores,
        retriever: new DeterministicRetriever(), synthesizer, results,
        readiness: new InferenceGatewayStageReadiness(gatewayRuntime.gateway),
        standardSearch, sampleBasisPoints: config.sampleBasisPoints,
      })
      return {
        get status() { return runtimeStatus() },
        runCycle: () => evaluator.runBatch(config.batchSize),
        stop: async () => undefined,
        close: () => { shadowStores.forEach(({ store }) => store.close()); stores.forEach((store) => store.close()) },
      }
    } catch (error) {
      shadowStores.forEach(({ store }) => store.close())
      stores.forEach((store) => store.close())
      throw error
    }
  }

  let deepRuntime: ReturnType<NonNullable<CreateLiveSharedResearchRuntimeOptions['createDeepRuntime']>> | undefined
  if (config.deepEnabled) {
    if (!options.createDeepRuntime) {
      stores.forEach((store) => store.close())
      throw new Error('Deep research is enabled but no registered contained deep runtime is configured')
    }
    deepRuntime = options.createDeepRuntime({ stores })
  }
  const ledgers: Array<{ source: SupportedResearchSource, ledger: SqliteExecutionLedger }> = []
  try {
    for (const source of config.sources) ledgers.push({ source, ledger: new SqliteExecutionLedger(paths.get(source)!) })
    const executionLedger = new SourceExecutionLedger(ledgers)
    const scheduler = new ResearchDepthFilteredScheduler(stores, supportedDepths)
    const readiness = new InferenceGatewayStageReadiness(gatewayRuntime.gateway)
    const makeWorker = (name: 'urgent' | 'background', priorityClasses: PriorityClass[]) => new SharedResearchWorker({
      workerId: `feed-v3-research-${name}-${process.pid}`,
      stores, scheduler, retriever: new DeterministicRetriever(), synthesizer, standardSearch,
      deepResearch: deepRuntime?.enqueue, executionLedger, readiness, mode: 'active',
      ownership: 'shared', legacyClaimersActive: false, priorityClasses,
    })
    const workers = [makeWorker('urgent', config.urgentPriorities), makeWorker('background', config.backgroundPriorities)]
    return {
      get status() { return runtimeStatus() },
      async runCycle() {
        const batches = await Promise.all(workers.map((worker) => worker.runBatch(config.batchSize)))
        const deep = deepRuntime ? await deepRuntime.runCycle() : []
        return [...batches.flat(), ...deep]
      },
      async stop() {
        await Promise.all(workers.map((worker) => worker.stop({ drain: true })))
        await deepRuntime?.stop()
      },
      close() {
        deepRuntime?.close()
        ledgers.forEach(({ ledger }) => ledger.close())
        stores.forEach((store) => store.close())
      },
    }
  } catch (error) {
    deepRuntime?.close()
    ledgers.forEach(({ ledger }) => ledger.close())
    stores.forEach((store) => store.close())
    throw error
  }
}

export class ResearchDepthFilteredScheduler implements SharedResearchSchedulerPort {
  private readonly stores: ReadonlyMap<Signal['sourceType'], SharedResearchWorkPort>
  private readonly depths: ReadonlySet<ResearchWorkItem['researchDepth']>
  constructor(stores: SharedResearchWorkPort[], depths: ResearchWorkItem['researchDepth'][]) {
    this.stores = new Map(stores.map((store) => [store.sourceType, store]))
    this.depths = new Set(depths)
  }
  async peekGlobal(query: GlobalSchedulerQuery): Promise<ResearchWorkItem[]> {
    const heads = await Promise.all([...this.stores.values()].map((store) => store.peekSchedulable({
      now: query.now, limit: Math.min(250, Math.max(query.limit, 25)), stages: query.stages,
      researchDepths: [...this.depths], priorityClasses: query.priorityClasses,
    })))
    const acceptedPriorities = query.priorityClasses === undefined ? null : new Set(query.priorityClasses)
    return heads.flat()
      .filter((work) => this.depths.has(work.researchDepth))
      .filter((work) => acceptedPriorities === null || acceptedPriorities.has(work.priorityClass))
      .sort(compareResearchWorkPriority)
      .slice(0, query.limit)
  }
  async claimNext(command: ClaimNextCommand): Promise<WorkLease | null> {
    const candidates = await this.peekGlobal({ ...command, limit: 250 })
    for (const work of candidates) {
      const expectedStatus = work.status === 'research_pending' ? 'research_pending'
        : work.status === 'synthesis_pending' ? 'synthesis_pending'
          : work.status === 'deep_pending' ? 'deep_pending' : null
      if (expectedStatus === null) continue
      const lease = await this.stores.get(work.sourceType)?.claimWithLease({
        workId: work.workId, expectedStatus, leaseOwner: command.leaseOwner,
        leaseId: `lease_${randomUUID()}`,
        leaseExpiresAt: new Date(Date.parse(command.now) + command.leaseTtlMs).toISOString(), now: command.now,
      })
      if (lease) return lease
    }
    return null
  }
}

class SourceExecutionLedger implements Pick<ExecutionLedger, 'append'> {
  private readonly ledgers: ReadonlyMap<Signal['sourceType'], ExecutionLedger>
  constructor(items: Array<{ source: Signal['sourceType'], ledger: ExecutionLedger }>) {
    this.ledgers = new Map(items.map((item) => [item.source, item.ledger]))
  }
  append(event: ExecutionTraceEvent) {
    const ledger = this.ledgers.get(event.sourceType)
    if (!ledger) throw new Error(`No execution ledger for source ${event.sourceType}`)
    return ledger.append(event)
  }
}

class SourceShadowResultStore {
  private readonly stores: ReadonlyMap<Signal['sourceType'], SqliteResearchShadowStore>
  constructor(items: Array<{ source: Signal['sourceType'], store: SqliteResearchShadowStore }>) {
    this.stores = new Map(items.map((item) => [item.source, item.store]))
  }
  get(evaluationId: string) {
    for (const store of this.stores.values()) {
      const value = store.get(evaluationId)
      if (value !== null) return value
    }
    return null
  }
  append(result: Parameters<SqliteResearchShadowStore['append']>[0]) {
    const store = this.stores.get(result.sourceType)
    if (!store) throw new Error(`No shadow result store for source ${result.sourceType}`)
    return store.append(result)
  }
}

function databasePath(value: string | undefined, fallback: string): string {
  const configured = value?.trim() || fallback
  return isAbsolute(configured) ? configured : resolve(PACKAGE_DIR, configured)
}
function priorities(raw: string | undefined, fallback: PriorityClass[]): PriorityClass[] {
  const values = raw === undefined ? fallback : raw.split(',').map((item) => item.trim()).filter(Boolean) as PriorityClass[]
  const allowed = new Set<PriorityClass>(['P0', 'P1', 'P2', 'P3'])
  if (values.length === 0 || new Set(values).size !== values.length || values.some((item) => !allowed.has(item))) {
    throw new Error('Research priority pool must be a non-empty unique subset of P0,P1,P2,P3')
  }
  return values
}
function integer(raw: string | undefined, min: number, max: number, fallback: number, field: string): number {
  const value = raw === undefined ? fallback : Number(raw)
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${field} must be between ${min} and ${max}`)
  return value
}
function flag(raw: string | undefined, fallback: boolean, field: string): boolean {
  if (raw === undefined) return fallback
  if (raw === '1') return true
  if (raw === '0') return false
  throw new Error(`${field} must be 0 or 1`)
}
function safeValue(value: string, field: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/.test(value)) throw new Error(`${field} is unsafe`)
  return value
}
function abortableWait(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve()
  return new Promise((resolveWait) => {
    const timer = setTimeout(finish, ms)
    const onAbort = () => finish()
    function finish() { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); resolveWait() }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

if (require.main === module) {
  const controller = new AbortController()
  process.once('SIGTERM', () => controller.abort())
  process.once('SIGINT', () => controller.abort())
  runSharedResearchLoop({
    signal: controller.signal,
    onResult: (result) => process.stdout.write(`${JSON.stringify(result)}\n`),
  }).catch((error) => {
    process.stderr.write(`[feed-v3-shared-research] ${error instanceof Error ? error.message : 'unknown failure'}\n`)
    process.exitCode = 1
  })
}
