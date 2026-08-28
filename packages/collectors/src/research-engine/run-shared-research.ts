import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'
import { loadDotenvChain } from '../pipeline-store/cli-env'
import {
  createProductionDeepResearchRuntime,
  SqliteDeepResearchExecutionRegistry,
  type DeepResearchWorkerOutcome,
  type ProductionDeepResearchRuntime,
  deepResearchRuntimeSnapshot,
  type DeepResearchRuntimeSnapshotV1,
} from '../deep-research'
import {
  InferenceGatewayStageReadiness,
  createConfiguredInferenceGateway,
  type InferenceCircuitStatusSnapshot,
  type InferenceGatewayStatusSnapshot,
  type InferenceTelemetry,
} from '../inference-gateway'
import type { PriorityClass, ResearchDepth, ResearchWorkItem, Signal } from '../signal-platform/contracts'
import type { ExecutionTraceEvent } from '../signal-platform/contracts'
import type { ExecutionLedger } from '../signal-platform/execution-ledger'
import { assertActiveCutoverReceipts } from '../signal-platform/cutover-receipt'
import { assertPhase1CutoverPolicy } from '../signal-platform/phase1-cutover'
import { SqliteExecutionLedger } from '../signal-platform/sqlite-execution-ledger'
import {
  loadFeedV3RuntimeConfig,
  type FeedV3RuntimeConfig,
  type FeedV3WorkerMode,
} from '../signal-platform/runtime-config'
import {
  SharedResearchScheduler,
  type ClaimNextCommand,
  type GlobalSchedulerQuery,
} from '../signal-platform/shared-scheduler'
import { SqliteSignalPlatformStore } from '../signal-platform/sqlite-platform-store'
import {
  FileSqliteWriteHealthJournal,
  resolveSqliteWriteHealthJournalPath,
} from '../signal-platform/sqlite-write-error-journal'
import { SqliteResearchShadowStore } from '../signal-platform/sqlite-research-shadow-store'
import {
  FileRuntimeControlStore,
  resolveRuntimeControlPath,
  stageRuntimeControl,
  type RuntimeControlReadPort,
  type RuntimeStageControl,
} from '../signal-platform/runtime-control'
import { compareResearchWorkPriority, type WorkLease } from '../signal-platform/store-adapter'
import { DeterministicRetriever } from './deterministic-retrieval'
import { ResearchShadowEvaluator, type ShadowEvaluationOutcome } from './shadow-evaluator'
import {
  SharedResearchWorker,
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
import {
  AtomicResearchRuntimeStatusFile,
  awaitDrainWithin,
  type ResearchRuntimeRecoverySnapshot,
  type ResearchRuntimeStatusWriter,
} from './research-runtime-lifecycle'

export const SHARED_RESEARCH_ENV = Object.freeze({
  runOnce: 'FEED_V3_RESEARCH_RUN_ONCE',
  intervalMs: 'FEED_V3_RESEARCH_INTERVAL_MS',
  batchSize: 'FEED_V3_RESEARCH_BATCH_SIZE',
  promptVersion: 'FEED_V3_RESEARCH_PROMPT_VERSION',
  urgentPriorities: 'FEED_V3_RESEARCH_URGENT_PRIORITIES',
  backgroundPriorities: 'FEED_V3_RESEARCH_BACKGROUND_PRIORITIES',
  maxConsecutiveClaimsPerSource: 'FEED_V3_RESEARCH_MAX_CONSECUTIVE_CLAIMS_PER_SOURCE',
  recoveryIntervalMs: 'FEED_V3_RESEARCH_RECOVERY_INTERVAL_MS',
  recoveryLimitPerSource: 'FEED_V3_RESEARCH_RECOVERY_LIMIT_PER_SOURCE',
  drainGraceMs: 'FEED_V3_RESEARCH_DRAIN_GRACE_MS',
  runtimeStatusPath: 'FEED_V3_RESEARCH_RUNTIME_STATUS_PATH',
})

type SupportedResearchSource = Signal['sourceType']

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
  maxConsecutiveClaimsPerSource: number
  recoveryIntervalMs: number
  recoveryLimitPerSource: number
  drainGraceMs: number
  runtimeStatusPath: string
  runtimeControlPath: string
  cutoverReceiptPath: string | null
  runtimeConfig: FeedV3RuntimeConfig
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
  sourceFairness: { maxConsecutiveClaimsPerSource: number }
  standardSearch: StandardSearchStatusSnapshot
  gateway: InferenceGatewayStatusSnapshot
  circuits: InferenceCircuitStatusSnapshot
  circuitNextProbes: Array<{
    workload: string
    provider: string
    model: string
    nextProbeAt: string | null
  }>
  providerObservation: {
    lastCompletedAt: string | null
    lastSucceededAt: string | null
    workload: string | null
    provider: string | null
    model: string | null
    succeeded: boolean | null
    durationMs: number | null
    providerCalls: number
    repairCalls: number
    failureCategory: InferenceTelemetry['failureCategory']
  }
  deepEnabled: boolean
  deep?: DeepResearchRuntimeSnapshotV1
}

export interface SharedResearchRunnerRuntime {
  readonly status: SharedResearchRuntimeStatus
  runCycle(): Promise<Array<SharedResearchRunOutcome | ShadowEvaluationOutcome | DeepResearchWorkerOutcome>>
  /** Active mode only. Recovery changes no attempt counters. */
  recoverExpired?(input: { now: string, limitPerSource: number }): Promise<Readonly<Record<string, readonly string[]>>>
  stop(): Promise<void>
  close(): void
}

export interface RunSharedResearchOptions {
  env?: Readonly<Record<string, string | undefined>>
  signal?: AbortSignal
  createRuntime?: (config: SharedResearchRunnerConfig) => SharedResearchRunnerRuntime
  onResult?: (result: SharedResearchRunnerCycleResult) => void
  wait?: (ms: number, signal?: AbortSignal) => Promise<void>
  now?: () => number
  createStatusWriter?: (path: string) => ResearchRuntimeStatusWriter
  createRuntimeControl?: (path: string) => RuntimeControlReadPort
}

export type SharedResearchRunnerCycleResult =
  | { kind: 'disabled' }
  | {
    kind: 'draining'
    status: SharedResearchRuntimeStatus
    control: RuntimeStageControl
    reason: 'operator_requested' | 'control_unreadable'
  }
  | { kind: 'completed', status: SharedResearchRuntimeStatus, outcomes: Array<SharedResearchRunOutcome | ShadowEvaluationOutcome | DeepResearchWorkerOutcome> }

export interface CreateLiveSharedResearchRuntimeOptions {
  standardSearchFactories?: RegisteredSearchConnectorFactories
  runtimeControl?: RuntimeControlReadPort
  createDeepRuntime?: (input: {
    stores: SharedResearchWorkPort[]
    executionLedger: Pick<ExecutionLedger, 'append'>
    env: Readonly<Record<string, string | undefined>>
    executionRegistries: Array<{
      sourceType: Signal['sourceType']
      registry: SqliteDeepResearchExecutionRegistry
    }>
    gateway: ReturnType<typeof createConfiguredInferenceGateway>['gateway']
  }) => ProductionDeepResearchRuntime
}

const PACKAGE_DIR = resolve(__dirname, '..', '..')

export function loadSharedResearchRunnerConfig(
  env: Readonly<Record<string, string | undefined>> = process.env,
): SharedResearchRunnerConfig {
  const feed = loadFeedV3RuntimeConfig(env)
  const selected = feed.researchMode === 'active' ? feed.researchActiveSources : feed.researchShadowSources
  const sources = [...selected]
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
    maxConsecutiveClaimsPerSource: integer(
      env[SHARED_RESEARCH_ENV.maxConsecutiveClaimsPerSource], 1, 100, 2,
      'research maximum consecutive claims per source',
    ),
    recoveryIntervalMs: integer(env[SHARED_RESEARCH_ENV.recoveryIntervalMs], 100, 24 * 60 * 60_000, 30_000, 'research recovery interval'),
    recoveryLimitPerSource: integer(env[SHARED_RESEARCH_ENV.recoveryLimitPerSource], 1, 1_000, 100, 'research recovery limit'),
    drainGraceMs: integer(env[SHARED_RESEARCH_ENV.drainGraceMs], 100, 15 * 60_000, 150_000, 'research drain grace'),
    runtimeStatusPath: databasePath(env[SHARED_RESEARCH_ENV.runtimeStatusPath], '.data/feed-v3-research-runtime-status.json'),
    runtimeControlPath: resolveRuntimeControlPath(env, PACKAGE_DIR),
    cutoverReceiptPath: feed.cutoverReceiptPath,
    runtimeConfig: feed,
    newsPath: databasePath(env.NEWS_SQLITE_PATH, '.data/news.sqlite'),
    pipelinePath: databasePath(env.PIPELINE_SQLITE_PATH, '.data/pipeline.sqlite'),
    env,
  })
}

/** Disabled mode never invokes createRuntime and remains resident until signal. */
export async function runSharedResearchLoop(options: RunSharedResearchOptions = {}): Promise<void> {
  const config = loadSharedResearchRunnerConfig(options.env)
  const wait = options.wait ?? abortableWait
  const now = options.now ?? Date.now
  if (config.mode === 'off') {
    options.onResult?.({ kind: 'disabled' })
    if (config.runOnce) return
    while (!options.signal?.aborted) await wait(config.intervalMs, options.signal)
    return
  }
  const runtimeControl = (options.createRuntimeControl ?? ((path) => new FileRuntimeControlStore(path)))(
    config.runtimeControlPath,
  )
  let controlObservation = readResearchRuntimeControl(runtimeControl)
  let operatorControl = controlObservation.control
  const runtime = (options.createRuntime ?? ((input) => createLiveSharedResearchRuntime(input, { runtimeControl })))(config)
  const statusWriter = (options.createStatusWriter ?? ((path) => new AtomicResearchRuntimeStatusFile(path)))(
    config.runtimeStatusPath,
  )
  let recovery: ResearchRuntimeRecoverySnapshot = Object.freeze({ lastRunAt: null, recoveredBySource: {} })
  let drainStartedAt: number | null = null
  let drainFailure: unknown
  let drainPromise: Promise<void> | null = null
  let abortResolve: (() => void) | undefined
  const aborted = new Promise<void>((resolveAbort) => { abortResolve = resolveAbort })
  const writeStatus = (lifecycleState: 'running' | 'draining' | 'stopped') => statusWriter.write({
    capturedAt: new Date(now()).toISOString(), lifecycleState, runtime: runtime.status, recovery,
  })
  const requestDrain = () => {
    if (drainPromise === null) {
      drainStartedAt = now()
      drainPromise = runtime.stop().catch((error) => { drainFailure = error })
      // Best effort in the signal callback. The serialized final write below is
      // authoritative and reports stopped only after every active call drains.
      void writeStatus('draining').catch(() => undefined)
    }
    abortResolve?.()
  }
  const onAbort = () => requestDrain()
  options.signal?.addEventListener('abort', onAbort, { once: true })
  if (options.signal?.aborted) requestDrain()
  try {
    await writeStatus(drainPromise === null && operatorControl.desiredState === 'running' ? 'running' : 'draining')
    let nextCycleAt = now()
    let nextRecoveryAt = runtime.recoverExpired === undefined ? Number.POSITIVE_INFINITY : now()
    let lastReportedControlState: 'running' | 'operator_requested' | 'control_unreadable' | null = null
    while (drainPromise === null) {
      const observedAt = now()
      const wakeAt = Math.min(nextCycleAt, nextRecoveryAt)
      if (observedAt < wakeAt) {
        await wait(Math.max(1, wakeAt - observedAt), options.signal)
        continue
      }
      controlObservation = readResearchRuntimeControl(runtimeControl)
      operatorControl = controlObservation.control
      if (runtime.recoverExpired !== undefined && observedAt >= nextRecoveryAt) {
        const recovered = await runtime.recoverExpired({
          now: new Date(observedAt).toISOString(), limitPerSource: config.recoveryLimitPerSource,
        })
        recovery = Object.freeze({ lastRunAt: new Date(observedAt).toISOString(), recoveredBySource: recovered })
        nextRecoveryAt = now() + config.recoveryIntervalMs
        await writeStatus(operatorControl.desiredState === 'running' ? 'running' : 'draining')
        if (drainPromise !== null) break
      }
      if (now() < nextCycleAt) continue
      controlObservation = readResearchRuntimeControl(runtimeControl)
      operatorControl = controlObservation.control
      if (operatorControl.desiredState === 'draining') {
        const reason = controlObservation.unreadable ? 'control_unreadable' : 'operator_requested'
        if (lastReportedControlState !== reason) {
          options.onResult?.({ kind: 'draining', status: runtime.status, control: operatorControl, reason })
        }
        lastReportedControlState = reason
        await writeStatus('draining')
        if (config.runOnce) break
        nextCycleAt = now() + config.intervalMs
        continue
      }
      lastReportedControlState = 'running'
      const cycle = runtime.runCycle()
      const outcome = await Promise.race([
        cycle.then((outcomes) => ({ kind: 'completed' as const, outcomes })),
        aborted.then(() => ({ kind: 'aborted' as const })),
      ])
      if (outcome.kind === 'aborted') break
      options.onResult?.({ kind: 'completed', status: runtime.status, outcomes: outcome.outcomes })
      await writeStatus('running')
      if (config.runOnce) break
      nextCycleAt = now() + config.intervalMs
    }
  } finally {
    options.signal?.removeEventListener('abort', onAbort)
    requestDrain()
    const elapsed = drainStartedAt === null ? 0 : Math.max(0, now() - drainStartedAt)
    const remainingGrace = Math.max(1, config.drainGraceMs - elapsed)
    await awaitDrainWithin(drainPromise!, remainingGrace)
    if (drainFailure !== undefined) throw drainFailure
    try {
      await writeStatus('stopped')
    } finally {
      runtime.close()
    }
  }
}

export function createLiveSharedResearchRuntime(
  config: SharedResearchRunnerConfig,
  options: CreateLiveSharedResearchRuntimeOptions = {},
): SharedResearchRunnerRuntime {
  const runtimeMode = config.mode
  if (runtimeMode === 'off') throw new Error('Disabled research must not construct a live runtime')
  if (runtimeMode === 'active') {
    if (config.runtimeConfig.cutoverPolicy === 'phase1') {
      // Phase 1 admits only news/polymarket with all invariants valid and
      // never evaluates active cutover receipts or dereferences a null path.
      assertPhase1CutoverPolicy(config.runtimeConfig, 'research')
    } else {
      assertActiveCutoverReceipts({
        path: config.cutoverReceiptPath!,
        required: config.sources.map((sourceType) => ({ sourceType, stage: 'research' as const })),
      })
    }
  }
  const paths = sourceDatabasePaths(config)
  for (const source of config.sources) {
    const path = paths.get(source)!
    if (!existsSync(path)) throw new Error(`${source} SQLite database does not exist at ${path}`)
  }
  const writeHealthJournal = new FileSqliteWriteHealthJournal(
    resolveSqliteWriteHealthJournalPath(config.env), { readOnly: config.mode === 'shadow' },
  )
  const stores = config.sources.map((source) => new SqliteSignalPlatformStore(paths.get(source)!, source, {
    readOnly: config.mode === 'shadow', writeHealthJournal,
  }))
  let standardConfiguration: ReturnType<typeof loadStandardSearchConfiguration>
  let standardSearch: ReturnType<typeof createConfiguredStandardSearch>
  let gatewayRuntime: ReturnType<typeof createConfiguredInferenceGateway>
  const providerObservation = new ProviderObservation()
  const runtimeControl = options.runtimeControl ?? new FileRuntimeControlStore(config.runtimeControlPath)
  // A malformed or temporarily unreadable durable control file is a fail-closed
  // claim gate, not a process-fatal condition. The outer loop keeps polling so
  // an operator can repair the file and resume without a PM2 restart loop.
  const claimsEnabled = () => {
    const observed = readResearchRuntimeControl(runtimeControl)
    return !observed.unreadable && observed.control.desiredState === 'running'
  }
  try {
    standardConfiguration = loadStandardSearchConfiguration(config.env)
    standardSearch = createConfiguredStandardSearch({
      configuration: standardConfiguration,
      factories: options.standardSearchFactories,
    })
    gatewayRuntime = createConfiguredInferenceGateway({
      env: config.env,
      observer: (event) => providerObservation.observe(event),
    })
  } catch (error) {
    stores.forEach((store) => store.close())
    throw error
  }
  const synthesizer = new StructuredResearchSynthesizer({ gateway: gatewayRuntime.gateway, promptVersion: config.promptVersion })
  // Phase 1 intersects available capabilities with its exact light-only
  // admission policy. Full policy preserves the pre-Phase-1 capability set.
  const supportedDepths = resolveSupportedResearchDepths({
    cutoverPolicy: config.runtimeConfig.cutoverPolicy,
    triageAllowedDepths: config.runtimeConfig.triageAllowedDepths,
    standardAvailable: standardSearch !== undefined,
    deepAvailable: config.deepEnabled,
  })
  let deepRuntime: ProductionDeepResearchRuntime | undefined
  const runtimeStatus = (): SharedResearchRuntimeStatus => {
    const circuits = gatewayRuntime.gateway.circuitStatusSnapshot()
    const capturedAtMs = Date.parse(circuits.capturedAt)
    return Object.freeze({
      schemaVersion: 'myboon.shared_research_runtime_status.v1', mode: runtimeMode,
      sources: [...config.sources], supportedDepths: [...supportedDepths],
      priorityPools: [
        { name: 'urgent' as const, priorities: [...config.urgentPriorities] },
        { name: 'background' as const, priorities: [...config.backgroundPriorities] },
      ],
      sourceFairness: { maxConsecutiveClaimsPerSource: config.maxConsecutiveClaimsPerSource },
      standardSearch: standardSearchStatus(standardConfiguration), gateway: gatewayRuntime.status,
      circuits,
      circuitNextProbes: circuits.workloads.flatMap((workload) => workload.targets.map((target) => ({
        workload: workload.workload,
        provider: target.provider,
        model: target.model,
        nextProbeAt: target.circuitOpen && target.retryAfterMs !== null
          ? new Date(capturedAtMs + target.retryAfterMs).toISOString() : null,
      }))),
      providerObservation: providerObservation.snapshot(),
      deepEnabled: config.deepEnabled,
      deep: deepRuntime?.status ?? deepResearchRuntimeSnapshot({ enabled: false }),
    })
  }
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
      let stopping = false
      const active = new Set<Promise<ShadowEvaluationOutcome[]>>()
      return {
        get status() { return runtimeStatus() },
        runCycle() {
          if (stopping || !claimsEnabled()) return Promise.resolve([])
          const cycle = evaluator.runBatch(config.batchSize)
          active.add(cycle)
          void cycle.then(() => active.delete(cycle), () => active.delete(cycle))
          return cycle
        },
        async stop() {
          stopping = true
          await Promise.allSettled([...active])
        },
        close: () => { shadowStores.forEach(({ store }) => store.close()); stores.forEach((store) => store.close()) },
      }
    } catch (error) {
      shadowStores.forEach(({ store }) => store.close())
      stores.forEach((store) => store.close())
      throw error
    }
  }

  const ledgers: Array<{ source: SupportedResearchSource, ledger: SqliteExecutionLedger }> = []
  const deepRegistries = new Map<string, SqliteDeepResearchExecutionRegistry>()
  try {
    for (const source of config.sources) ledgers.push({ source, ledger: new SqliteExecutionLedger(paths.get(source)!) })
    const executionLedger = new SourceExecutionLedger(ledgers)
    if (config.deepEnabled) {
      const executionRegistries = config.sources.map((sourceType) => {
        const path = paths.get(sourceType)!
        let registry = deepRegistries.get(path)
        if (!registry) {
          registry = new SqliteDeepResearchExecutionRegistry(path)
          deepRegistries.set(path, registry)
        }
        return { sourceType, registry }
      })
      deepRuntime = (options.createDeepRuntime ?? ((input) => createProductionDeepResearchRuntime(input)))({
        stores, executionLedger, env: config.env, executionRegistries, gateway: gatewayRuntime.gateway,
      })
    }
    const scheduler = new ResearchDepthFilteredScheduler(
      stores, supportedDepths, claimsEnabled, config.maxConsecutiveClaimsPerSource,
    )
    const recoveryScheduler = new SharedResearchScheduler(stores)
    const readiness = new InferenceGatewayStageReadiness(gatewayRuntime.gateway)
    const makeWorker = (name: 'urgent' | 'background', priorityClasses: PriorityClass[]) => new SharedResearchWorker({
      workerId: `feed-v3-research-${name}-${process.pid}`,
      stores, scheduler, retriever: new DeterministicRetriever(), synthesizer, standardSearch,
      deepResearch: deepRuntime?.enqueue, executionLedger, readiness, mode: 'active',
      ownership: 'shared', legacyClaimersActive: false, priorityClasses,
    })
    const workers = [makeWorker('urgent', config.urgentPriorities), makeWorker('background', config.backgroundPriorities)]
    let stopping = false
    let stopPromise: Promise<void> | null = null
    return {
      get status() { return runtimeStatus() },
      recoverExpired: ({ now, limitPerSource }) => recoveryScheduler.recoverExpiredLeases({
        now, limitPerStore: limitPerSource,
      }),
      async runCycle() {
        if (stopping || !claimsEnabled()) return []
        const batches = await Promise.all(workers.map((worker) => worker.runBatch(config.batchSize)))
        const deep = deepRuntime && !stopping && claimsEnabled() ? await deepRuntime.runCycle() : []
        return [...batches.flat(), ...deep]
      },
      stop() {
        if (stopPromise === null) {
          stopping = true
          stopPromise = (async () => {
            const drains = workers.map((worker) => worker.stop({ drain: true }))
            const deepDrain = deepRuntime?.stop()
            await Promise.all([...drains, ...(deepDrain ? [deepDrain] : [])])
          })()
        }
        return stopPromise
      },
      close() {
        deepRuntime?.close()
        ledgers.forEach(({ ledger }) => ledger.close())
        stores.forEach((store) => store.close())
      },
    }
  } catch (error) {
    if (deepRuntime) deepRuntime.close()
    else for (const registry of deepRegistries.values()) registry.close()
    ledgers.forEach(({ ledger }) => ledger.close())
    stores.forEach((store) => store.close())
    throw error
  }
}

/** Preserve full-policy capability behavior; Phase 1 alone is admission-bounded. */
export function resolveSupportedResearchDepths(input: {
  cutoverPolicy: FeedV3RuntimeConfig['cutoverPolicy']
  triageAllowedDepths: ReadonlySet<ResearchDepth>
  standardAvailable: boolean
  deepAvailable: boolean
}): ResearchWorkItem['researchDepth'][] {
  const capabilities: ResearchWorkItem['researchDepth'][] = input.standardAvailable
    ? ['light', 'standard']
    : ['light']
  if (input.deepAvailable) capabilities.push('deep')
  return input.cutoverPolicy === 'phase1'
    ? capabilities.filter((depth) => input.triageAllowedDepths.has(depth))
    : capabilities
}

/** Source registration is code-owned; all non-News source queues share pipeline.sqlite. */
function sourceDatabasePaths(config: SharedResearchRunnerConfig): ReadonlyMap<SupportedResearchSource, string> {
  return new Map<SupportedResearchSource, string>([
    ['news', config.newsPath],
    ['polymarket', config.pipelinePath],
    ['market_calendar', config.pipelinePath],
    ['x', config.pipelinePath],
  ])
}

export class ResearchDepthFilteredScheduler implements SharedResearchSchedulerPort {
  private readonly stores: ReadonlyMap<Signal['sourceType'], SharedResearchWorkPort>
  private readonly depths: ReadonlySet<ResearchWorkItem['researchDepth']>
  private lastClaimedSource: Signal['sourceType'] | null = null
  private consecutiveClaims = 0
  constructor(
    stores: SharedResearchWorkPort[],
    depths: ResearchWorkItem['researchDepth'][],
    private readonly claimsEnabled: () => boolean = () => true,
    private readonly maxConsecutiveClaimsPerSource = 2,
  ) {
    this.stores = new Map(stores.map((store) => [store.sourceType, store]))
    this.depths = new Set(depths)
    if (!Number.isInteger(maxConsecutiveClaimsPerSource)
      || maxConsecutiveClaimsPerSource < 1 || maxConsecutiveClaimsPerSource > 100) {
      throw new Error('maxConsecutiveClaimsPerSource must be an integer between 1 and 100')
    }
  }
  async peekGlobal(query: GlobalSchedulerQuery): Promise<ResearchWorkItem[]> {
    return (await this.peekEligibleStoreHeads(
      query, Math.min(250, Math.max(query.limit, 25)),
    )).slice(0, query.limit)
  }
  async claimNext(command: ClaimNextCommand): Promise<WorkLease | null> {
    if (!this.claimsEnabled()) return null
    // Keep a bounded head from every source until after the fairness choice;
    // slicing a global head first can hide an alternate source behind 250 rows.
    const candidates = await this.peekEligibleStoreHeads({ ...command, limit: 250 }, 250)
    const first = candidates[0]
    const fairAlternative = first && this.lastClaimedSource === first.sourceType
      && this.consecutiveClaims >= this.maxConsecutiveClaimsPerSource
      ? candidates.find((candidate) => candidate.sourceType !== first.sourceType
        && candidate.priorityClass === first.priorityClass) : undefined
    const ordered = fairAlternative
      ? [fairAlternative, ...candidates.filter((candidate) => candidate !== fairAlternative)]
      : candidates
    for (const work of ordered) {
      if (!this.claimsEnabled()) return null
      const expectedStatus = work.status === 'research_pending' ? 'research_pending'
        : work.status === 'synthesis_pending' ? 'synthesis_pending'
          : work.status === 'deep_pending' ? 'deep_pending' : null
      if (expectedStatus === null) continue
      const lease = await this.stores.get(work.sourceType)?.claimWithLease({
        workId: work.workId, expectedStatus, leaseOwner: command.leaseOwner,
        leaseId: `lease_${randomUUID()}`,
        leaseExpiresAt: new Date(Date.parse(command.now) + command.leaseTtlMs).toISOString(), now: command.now,
      })
      if (lease) {
        if (this.lastClaimedSource === work.sourceType) this.consecutiveClaims += 1
        else { this.lastClaimedSource = work.sourceType; this.consecutiveClaims = 1 }
        return lease
      }
    }
    return null
  }

  private async peekEligibleStoreHeads(
    query: GlobalSchedulerQuery,
    perStoreLimit: number,
  ): Promise<ResearchWorkItem[]> {
    const heads = await Promise.all([...this.stores.values()].map((store) => store.peekSchedulable({
      now: query.now, limit: perStoreLimit, stages: query.stages,
      researchDepths: [...this.depths], priorityClasses: query.priorityClasses,
    })))
    const acceptedPriorities = query.priorityClasses === undefined ? null : new Set(query.priorityClasses)
    return heads.flat()
      .filter((work) => this.depths.has(work.researchDepth))
      .filter((work) => acceptedPriorities === null || acceptedPriorities.has(work.priorityClass))
      .sort(compareResearchWorkPriority)
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

class ProviderObservation {
  private lastCompletedAt: string | null = null
  private lastSucceededAt: string | null = null
  private last: InferenceTelemetry | null = null

  observe(event: InferenceTelemetry): void {
    const completedAt = new Date().toISOString()
    this.lastCompletedAt = completedAt
    if (event.failureCategory === null) this.lastSucceededAt = completedAt
    // The gateway telemetry contract contains no prompt or credentials. Keep
    // only measured route, status, call count, and latency fields here.
    this.last = event
  }

  snapshot(): SharedResearchRuntimeStatus['providerObservation'] {
    return Object.freeze({
      lastCompletedAt: this.lastCompletedAt,
      lastSucceededAt: this.lastSucceededAt,
      workload: this.last?.workload ?? null,
      provider: this.last?.actualProvider ?? null,
      model: this.last?.actualModel ?? null,
      succeeded: this.last === null ? null : this.last.failureCategory === null,
      durationMs: this.last?.durationMs ?? null,
      providerCalls: this.last?.providerCalls ?? 0,
      repairCalls: this.last?.repairCalls ?? 0,
      failureCategory: this.last?.failureCategory ?? null,
    })
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

const UNREADABLE_RESEARCH_CONTROL: RuntimeStageControl = Object.freeze({
  desiredState: 'draining',
  changedAt: null,
  operationId: null,
})

function readResearchRuntimeControl(reader: RuntimeControlReadPort): {
  control: RuntimeStageControl
  unreadable: boolean
} {
  try {
    return { control: stageRuntimeControl(reader.read(), 'research'), unreadable: false }
  } catch {
    return { control: UNREADABLE_RESEARCH_CONTROL, unreadable: true }
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

/**
 * Explicit CLI seam: load package/root dotenv sources before any process.env
 * based runtime composition. The injectable loader keeps the behavior testable
 * without reading or exposing real credentials.
 */
export function loadSharedResearchProcessEnvironment(
  loader: () => void = loadDotenvChain,
): void {
  loader()
}

export function isSharedResearchProcessEntrypoint(input: {
  direct: boolean
  nodeAppInstance: string | undefined
} = {
  direct: require.main === module,
  nodeAppInstance: process.env.NODE_APP_INSTANCE,
}): boolean {
  return input.direct || input.nodeAppInstance !== undefined
}

// PM2 executes TypeScript through its process-container wrapper, so
// `require.main` is not this module there. NODE_APP_INSTANCE is PM2's stable
// execution marker and keeps imports/tests inert outside the process manager.
if (isSharedResearchProcessEntrypoint()) {
  loadSharedResearchProcessEnvironment()
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
