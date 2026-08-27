import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  RESEARCH_WORK_SCHEMA_VERSION,
  SIGNAL_SCHEMA_VERSION,
  type ResearchWorkItem,
  type Signal,
} from '../signal-platform/contracts'
import { SharedResearchScheduler } from '../signal-platform/shared-scheduler'
import { SqliteSignalPlatformStore } from '../signal-platform/sqlite-platform-store'
import { defaultRuntimeControl, FileRuntimeControlStore } from '../signal-platform/runtime-control'
import type { SharedResearchWorkPort } from './shared-worker'
import {
  ResearchDepthFilteredScheduler,
  SHARED_RESEARCH_ENV,
  createLiveSharedResearchRuntime,
  loadSharedResearchRunnerConfig,
  runSharedResearchLoop,
  type SharedResearchRunnerRuntime,
} from './run-shared-research'

const nodeRequire = createRequire(__filename)
const TEST_CUTOVER_RECEIPT_PATH = '/tmp/feed-v3-test-cutover-receipt.json'
const { DatabaseSync } = nodeRequire('node:sqlite') as {
  DatabaseSync: new(path: string, options: { readOnly: boolean, open: boolean }) => {
    prepare(sql: string): { get(...params: unknown[]): unknown }; close(): void
  }
}

function runtime(mode: 'active' | 'shadow', onCycle: () => void): SharedResearchRunnerRuntime {
  return {
    status: {
      schemaVersion: 'myboon.shared_research_runtime_status.v1', mode, sources: ['news'],
      supportedDepths: ['light'],
      priorityPools: [{ name: 'urgent', priorities: ['P0', 'P1'] }, { name: 'background', priorities: ['P2', 'P3'] }],
      sourceFairness: { maxConsecutiveClaimsPerSource: 2 },
      standardSearch: { schemaVersion: 'myboon.standard_search_status.v1', enabled: false, connectorId: null, policyVersion: null },
      gateway: {
        schemaVersion: 'myboon.inference_gateway_status.v1', hermesProfileConfigured: false,
        investigate: { enabled: false, fallbackEnabled: false }, routes: [],
      },
      circuits: { schemaVersion: 'myboon.inference_circuit_status.v1', capturedAt: '2026-08-26T12:00:00.000Z', workloads: [] },
      circuitNextProbes: [],
      providerObservation: {
        lastCompletedAt: null, lastSucceededAt: null, workload: null, provider: null, model: null,
        succeeded: null, durationMs: null, providerCalls: 0, repairCalls: 0, failureCategory: null,
      },
      deepEnabled: false,
    },
    runCycle: async () => { onCycle(); return [] },
    stop: async () => undefined,
    close: () => undefined,
  }
}

test('off mode stays resident without constructing stores, providers, or runtimes', async () => {
  let creates = 0
  let statusCreates = 0
  let controlCreates = 0
  let reports = 0
  const controller = new AbortController()
  await runSharedResearchLoop({
    env: { [SHARED_RESEARCH_ENV.intervalMs]: '100' },
    signal: controller.signal,
    createRuntime: () => { creates += 1; throw new Error('must not construct') },
    createStatusWriter: () => { statusCreates += 1; throw new Error('must not construct status writer') },
    createRuntimeControl: () => { controlCreates += 1; throw new Error('must not construct runtime control') },
    onResult: () => { reports += 1 },
    wait: async () => { controller.abort() },
  })
  assert.equal(creates, 0)
  assert.equal(statusCreates, 0)
  assert.equal(controlCreates, 0)
  assert.equal(reports, 1)
})

test('shadow delegates cycles to the evaluator runtime and active requires explicit topology ownership', async () => {
  let shadowCycles = 0
  await runSharedResearchLoop({
    env: {
      FEED_V3_RESEARCH_MODE: 'shadow', FEED_V3_RESEARCH_SHADOW_SOURCES: 'news',
      FEED_V3_SHADOW_SAMPLE_BASIS_POINTS: '100', [SHARED_RESEARCH_ENV.runOnce]: '1',
    },
    createRuntime: (config) => {
      assert.equal(config.mode, 'shadow')
      return runtime('shadow', () => { shadowCycles += 1 })
    },
  })
  assert.equal(shadowCycles, 1)
  assert.throws(() => loadSharedResearchRunnerConfig({
    FEED_V3_RESEARCH_MODE: 'active', FEED_V3_RESEARCH_ACTIVE_SOURCES: 'news',
  }), /legacy-disabled/)
})

test('active runner recovers at startup and on a bounded cadence before further claims', async () => {
  const controller = new AbortController()
  let current = Date.parse('2026-08-26T12:00:00.000Z')
  let cycles = 0
  let waits = 0
  const recoveries: string[] = []
  const writes: string[] = []
  const active = runtime('active', () => { cycles += 1 })
  active.recoverExpired = async ({ now, limitPerSource }) => {
    assert.equal(limitPerSource, 7)
    recoveries.push(now)
    return { news: recoveries.length === 1 ? ['expired-work'] : [] }
  }
  await runSharedResearchLoop({
    env: {
      FEED_V3_RESEARCH_MODE: 'active', FEED_V3_RESEARCH_ACTIVE_SOURCES: 'news',
      FEED_V3_LEGACY_RESEARCH_DISABLED_SOURCES: 'news',
      FEED_V3_CUTOVER_RECEIPT_PATH: TEST_CUTOVER_RECEIPT_PATH,
      [SHARED_RESEARCH_ENV.intervalMs]: '100', [SHARED_RESEARCH_ENV.recoveryIntervalMs]: '200',
      [SHARED_RESEARCH_ENV.recoveryLimitPerSource]: '7',
    },
    signal: controller.signal, now: () => current,
    createRuntime: () => active,
    createStatusWriter: () => ({ write: async ({ lifecycleState }) => { writes.push(lifecycleState) } }),
    wait: async (ms) => {
      current += ms
      waits += 1
      if (waits === 3) controller.abort()
    },
  })
  assert.equal(cycles, 3)
  assert.deepEqual(recoveries, ['2026-08-26T12:00:00.000Z', '2026-08-26T12:00:00.200Z'])
  assert.equal(writes.at(-1), 'stopped')
})

test('SIGTERM-equivalent abort gates new claims immediately and waits for the active call to drain', async () => {
  const controller = new AbortController()
  let entered!: () => void
  let release!: () => void
  const started = new Promise<void>((resolve) => { entered = resolve })
  const gate = new Promise<void>((resolve) => { release = resolve })
  let stopping = false
  let closed = false
  const live: SharedResearchRunnerRuntime = {
    ...runtime('active', () => undefined),
    async runCycle() { entered(); await gate; return [] },
    async stop() { stopping = true; await gate },
    close() { closed = true },
  }
  const running = runSharedResearchLoop({
    env: {
      FEED_V3_RESEARCH_MODE: 'active', FEED_V3_RESEARCH_ACTIVE_SOURCES: 'news',
      FEED_V3_LEGACY_RESEARCH_DISABLED_SOURCES: 'news', [SHARED_RESEARCH_ENV.drainGraceMs]: '1000',
      FEED_V3_CUTOVER_RECEIPT_PATH: TEST_CUTOVER_RECEIPT_PATH,
    },
    signal: controller.signal, createRuntime: () => live,
    createStatusWriter: () => ({ write: async () => undefined }),
  })
  await started
  controller.abort()
  assert.equal(stopping, true)
  assert.equal(closed, false)
  release()
  await running
  assert.equal(closed, true)
})

test('durable operator drain survives restart, stays resident, and resume re-enables cycles', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'shared-research-control-'))
  const controlPath = join(dir, 'control.json')
  const control = new FileRuntimeControlStore(controlPath)
  control.run({ stage: 'research', action: 'drain', apply: true, now: '2026-08-26T12:00:00.000Z' })
  const baseEnv = {
    FEED_V3_RESEARCH_MODE: 'active', FEED_V3_RESEARCH_ACTIVE_SOURCES: 'news',
    FEED_V3_LEGACY_RESEARCH_DISABLED_SOURCES: 'news', FEED_V3_CUTOVER_RECEIPT_PATH: TEST_CUTOVER_RECEIPT_PATH,
    FEED_V3_RUNTIME_CONTROL_PATH: controlPath, [SHARED_RESEARCH_ENV.runOnce]: '1',
  }
  try {
    for (let restart = 0; restart < 2; restart += 1) {
      let cycles = 0
      const reports: string[] = []
      await runSharedResearchLoop({
        env: baseEnv, createRuntime: () => runtime('active', () => { cycles += 1 }),
        createStatusWriter: () => ({ write: async () => undefined }),
        onResult: (result) => { reports.push(result.kind) },
      })
      assert.equal(cycles, 0)
      assert.deepEqual(reports, ['draining'])
    }

    const controller = new AbortController()
    let current = Date.parse('2026-08-26T12:02:00.000Z')
    let cycles = 0
    const reports: string[] = []
    await runSharedResearchLoop({
      env: { ...baseEnv, [SHARED_RESEARCH_ENV.runOnce]: '0', [SHARED_RESEARCH_ENV.intervalMs]: '100' },
      signal: controller.signal, now: () => current,
      createRuntime: () => runtime('active', () => { cycles += 1 }),
      createStatusWriter: () => ({ write: async () => undefined }),
      wait: async (ms) => {
        current += ms
        control.run({ stage: 'research', action: 'resume', apply: true, now: new Date(current).toISOString() })
      },
      onResult: (result) => {
        reports.push(result.kind)
        if (result.kind === 'completed') controller.abort()
      },
    })
    assert.equal(cycles, 1)
    assert.deepEqual(reports, ['draining', 'completed'])
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('unreadable durable control fails closed while resident and resumes after repair', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'shared-research-control-repair-'))
  const controlPath = join(dir, 'control.json')
  writeFileSync(controlPath, '{malformed', 'utf8')
  const controller = new AbortController()
  let current = Date.parse('2026-08-26T12:00:00.000Z')
  let cycles = 0
  let waits = 0
  const reports: Array<{ kind: string, reason?: string }> = []
  const lifecycle: string[] = []
  try {
    await runSharedResearchLoop({
      env: {
        FEED_V3_RESEARCH_MODE: 'active', FEED_V3_RESEARCH_ACTIVE_SOURCES: 'news',
        FEED_V3_LEGACY_RESEARCH_DISABLED_SOURCES: 'news',
        FEED_V3_CUTOVER_RECEIPT_PATH: TEST_CUTOVER_RECEIPT_PATH,
        FEED_V3_RUNTIME_CONTROL_PATH: controlPath, [SHARED_RESEARCH_ENV.intervalMs]: '100',
      },
      signal: controller.signal,
      now: () => current,
      createRuntime: () => runtime('active', () => { cycles += 1 }),
      createStatusWriter: () => ({ write: async ({ lifecycleState }) => { lifecycle.push(lifecycleState) } }),
      wait: async (ms) => {
        waits += 1
        current += ms
        writeFileSync(controlPath, `${JSON.stringify(defaultRuntimeControl())}\n`, { mode: 0o600 })
      },
      onResult: (result) => {
        reports.push({ kind: result.kind, ...('reason' in result ? { reason: result.reason } : {}) })
        if (result.kind === 'completed') controller.abort()
      },
    })
    assert.equal(waits, 1)
    assert.equal(cycles, 1)
    assert.deepEqual(reports, [
      { kind: 'draining', reason: 'control_unreadable' },
      { kind: 'completed' },
    ])
    assert.equal(lifecycle.includes('draining'), true)
    assert.equal(lifecycle.at(-1), 'stopped')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('active config exposes dedicated disjoint priority pools', () => {
  const config = loadSharedResearchRunnerConfig({
    FEED_V3_RESEARCH_MODE: 'active', FEED_V3_RESEARCH_ACTIVE_SOURCES: 'news',
    FEED_V3_LEGACY_RESEARCH_DISABLED_SOURCES: 'news',
    FEED_V3_CUTOVER_RECEIPT_PATH: TEST_CUTOVER_RECEIPT_PATH,
    [SHARED_RESEARCH_ENV.urgentPriorities]: 'P0,P1',
    [SHARED_RESEARCH_ENV.backgroundPriorities]: 'P2,P3',
  })
  assert.deepEqual(config.urgentPriorities, ['P0', 'P1'])
  assert.deepEqual(config.backgroundPriorities, ['P2', 'P3'])
  assert.equal(config.maxConsecutiveClaimsPerSource, 2)
})

test('active composition validates cutover evidence before opening a source database or provider', () => {
  const config = loadSharedResearchRunnerConfig({
    FEED_V3_RESEARCH_MODE: 'active', FEED_V3_RESEARCH_ACTIVE_SOURCES: 'news',
    FEED_V3_LEGACY_RESEARCH_DISABLED_SOURCES: 'news',
    FEED_V3_CUTOVER_RECEIPT_PATH: '/does/not/exist/cutover.json',
    NEWS_SQLITE_PATH: '/does/not/exist/news.sqlite',
  })
  assert.throws(() => createLiveSharedResearchRuntime(config), /receipt manifest/i)
})

test('full policy rejects missing and invalid receipts before any dependency construction', () => {
  const missing = loadSharedResearchRunnerConfig({
    FEED_V3_RESEARCH_MODE: 'active', FEED_V3_RESEARCH_ACTIVE_SOURCES: 'news',
    FEED_V3_LEGACY_RESEARCH_DISABLED_SOURCES: 'news',
    FEED_V3_CUTOVER_RECEIPT_PATH: '/does/not/exist/cutover.json',
    NEWS_SQLITE_PATH: '/does/not/exist/news.sqlite',
  })
  // The guard must throw before the SQLite existence check, so a missing
  // database path must never surface as the failure.
  assert.throws(() => createLiveSharedResearchRuntime(missing), /receipt manifest/i)

  const dir = mkdtempSync(join(tmpdir(), 'shared-research-full-invalid-'))
  try {
    const invalidPath = join(dir, 'cutover-receipts.json')
    writeFileSync(invalidPath, JSON.stringify({
      schemaVersion: 'myboon.feed_v3_cutover_manifest.v1', receipts: [],
    }))
    const invalid = loadSharedResearchRunnerConfig({
      FEED_V3_RESEARCH_MODE: 'active', FEED_V3_RESEARCH_ACTIVE_SOURCES: 'news',
      FEED_V3_LEGACY_RESEARCH_DISABLED_SOURCES: 'news',
      FEED_V3_CUTOVER_RECEIPT_PATH: invalidPath,
      NEWS_SQLITE_PATH: join(dir, 'news.sqlite'),
    })
    assert.throws(() => createLiveSharedResearchRuntime(invalid), /Cutover receipt missing for research:news/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('phase1 accepts news and polymarket with no receipt when all invariants are valid', () => {
  const dir = mkdtempSync(join(tmpdir(), 'shared-research-phase1-accept-'))
  const newsPath = join(dir, 'news.sqlite')
  const pipelinePath = join(dir, 'pipeline.sqlite')
  new SqliteSignalPlatformStore(newsPath, 'news').close()
  new SqliteSignalPlatformStore(pipelinePath, 'polymarket').close()
  try {
    const config = loadSharedResearchRunnerConfig({
      FEED_V3_CUTOVER_POLICY: 'phase1',
      FEED_V3_RESEARCH_MODE: 'active', FEED_V3_RESEARCH_ACTIVE_SOURCES: 'news,polymarket',
      FEED_V3_LEGACY_RESEARCH_DISABLED_SOURCES: 'news,polymarket',
      FEED_V3_TRIAGE_PROVIDER_HEALTH: 'healthy',
      NEWS_SQLITE_PATH: newsPath, PIPELINE_SQLITE_PATH: pipelinePath,
    })
    assert.equal(config.cutoverReceiptPath, null)
    const live = createLiveSharedResearchRuntime(config)
    assert.deepEqual(live.status.sources, ['news', 'polymarket'])
    live.close()
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('phase1 rejects invalid invariants before any dependency construction', () => {
  const dir = mkdtempSync(join(tmpdir(), 'shared-research-phase1-reject-'))
  const newsPath = join(dir, 'news.sqlite')
  const pipelinePath = join(dir, 'pipeline.sqlite')
  new SqliteSignalPlatformStore(newsPath, 'news').close()
  new SqliteSignalPlatformStore(pipelinePath, 'polymarket').close()
  const base = {
    FEED_V3_CUTOVER_POLICY: 'phase1',
    FEED_V3_RESEARCH_MODE: 'active', FEED_V3_RESEARCH_ACTIVE_SOURCES: 'news,polymarket',
    FEED_V3_LEGACY_RESEARCH_DISABLED_SOURCES: 'news,polymarket',
    FEED_V3_TRIAGE_PROVIDER_HEALTH: 'healthy',
    NEWS_SQLITE_PATH: newsPath, PIPELINE_SQLITE_PATH: pipelinePath,
  }
  const cases: Array<{ env: Record<string, string>, pattern: RegExp }> = [
    // standard depth admitted
    { env: { FEED_V3_TRIAGE_ALLOWED_DEPTHS: 'light,standard' }, pattern: /exactly light/ },
    // deep research enabled
    { env: { FEED_V3_DEEP_RESEARCH_ENABLED: '1' }, pattern: /deep research to be disabled/ },
    // triage classifier enabled
    { env: { FEED_V3_TRIAGE_CLASSIFIER_ENABLED: '1' }, pattern: /triage classifier to be disabled/ },
    // non-healthy provider
    { env: { FEED_V3_TRIAGE_PROVIDER_HEALTH: 'degraded' }, pattern: /healthy triage provider health/ },
    // unsupported source
    { env: { FEED_V3_RESEARCH_ACTIVE_SOURCES: 'news,market_calendar', FEED_V3_LEGACY_RESEARCH_DISABLED_SOURCES: 'news,market_calendar' }, pattern: /does not admit active research source: market_calendar/ },
    // missing legacy-disabled ownership (rejected by the config loader before
    // the phase1 guard, still before any dependency construction)
    { env: { FEED_V3_LEGACY_RESEARCH_DISABLED_SOURCES: 'news' }, pattern: /legacy-disabled sources: polymarket/ },
  ]
  try {
    for (const { env, pattern } of cases) {
      // The guard (or the config loader for the missing-legacy case) must fail
      // closed before the SQLite existence check, so a valid database path
      // must never be reached on a rejected config.
      assert.throws(() => createLiveSharedResearchRuntime(loadSharedResearchRunnerConfig({ ...base, ...env })), pattern)
    }
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('off and shadow research never evaluate active cutover authorization', async () => {
  let creates = 0
  const controller = new AbortController()
  await runSharedResearchLoop({
    env: { [SHARED_RESEARCH_ENV.intervalMs]: '100' },
    signal: controller.signal,
    createRuntime: () => { creates += 1; throw new Error('must not construct') },
    createStatusWriter: () => { creates += 1; throw new Error('must not construct status writer') },
    createRuntimeControl: () => { creates += 1; throw new Error('must not construct runtime control') },
    wait: async () => { controller.abort() },
  })
  assert.equal(creates, 0)

  const dir = mkdtempSync(join(tmpdir(), 'shared-research-phase1-shadow-'))
  const newsPath = join(dir, 'news.sqlite')
  new SqliteSignalPlatformStore(newsPath, 'news').close()
  try {
    const config = loadSharedResearchRunnerConfig({
      FEED_V3_CUTOVER_POLICY: 'phase1',
      FEED_V3_RESEARCH_MODE: 'shadow', FEED_V3_RESEARCH_SHADOW_SOURCES: 'news',
      FEED_V3_SHADOW_SAMPLE_BASIS_POINTS: '100', NEWS_SQLITE_PATH: newsPath,
    })
    // Shadow mode must not require a receipt path or evaluate active cutover.
    assert.equal(config.cutoverReceiptPath, null)
    const live = createLiveSharedResearchRuntime(config)
    assert.deepEqual(await live.runCycle(), [{ kind: 'idle' }])
    await live.stop()
    live.close()
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('calendar and X use the registered pipeline store without a source-specific Research runner', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'shared-research-sources-'))
  const pipelinePath = join(dir, 'pipeline.sqlite')
  const bootstrap = new SqliteSignalPlatformStore(pipelinePath, 'market_calendar')
  bootstrap.close()
  try {
    const config = loadSharedResearchRunnerConfig({
      FEED_V3_RESEARCH_MODE: 'shadow', FEED_V3_RESEARCH_SHADOW_SOURCES: 'market_calendar,x',
      FEED_V3_SHADOW_SAMPLE_BASIS_POINTS: '100', PIPELINE_SQLITE_PATH: pipelinePath,
    })
    assert.deepEqual(config.sources, ['market_calendar', 'x'])
    const live = createLiveSharedResearchRuntime(config)
    assert.deepEqual(await live.runCycle(), [{ kind: 'idle' }])
    assert.deepEqual(live.status.sources, ['market_calendar', 'x'])
    await live.stop()
    live.close()
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('live shadow composition writes its result table inside the source database boundary', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'shared-research-shadow-'))
  const newsPath = join(dir, 'news.sqlite')
  const canonical = new SqliteSignalPlatformStore(newsPath, 'news')
  canonical.close()
  try {
    const config = loadSharedResearchRunnerConfig({
      FEED_V3_RESEARCH_MODE: 'shadow', FEED_V3_RESEARCH_SHADOW_SOURCES: 'news',
      FEED_V3_SHADOW_SAMPLE_BASIS_POINTS: '100', NEWS_SQLITE_PATH: newsPath,
    })
    const live = createLiveSharedResearchRuntime(config)
    assert.deepEqual(await live.runCycle(), [{ kind: 'idle' }])
    await live.stop()
    live.close()
    const db = new DatabaseSync(newsPath, { readOnly: true, open: true })
    const table = db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'signal_platform_research_shadow_results'",
    ).get() as { name?: unknown } | undefined
    db.close()
    assert.equal(table?.name, 'signal_platform_research_shadow_results')
    assert.equal(existsSync(join(dir, 'feed-v3-research-shadow.sqlite')), false)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('depth-filtered scheduler excludes standard and deep work before claim in light-only mode', async () => {
  const work = [
    ...Array.from({ length: 251 }, (_, index) => researchWork(`standard-${index}`, 'standard')),
    researchWork('light', 'light'), researchWork('deep', 'deep'),
  ]
  const claimed: string[] = []
  const depthQueries: unknown[] = []
  const store = {
    sourceType: 'news',
    peekSchedulable: async (query: { limit: number, researchDepths?: ResearchWorkItem['researchDepth'][] }) => {
      depthQueries.push(query.researchDepths)
      return work.filter((item) => query.researchDepths?.includes(item.researchDepth) ?? true).slice(0, query.limit)
    },
    claimWithLease: async (command: { workId: string }) => {
      claimed.push(command.workId)
      const selected = work.find((item) => item.workId === command.workId)!
      return { work: selected, leaseOwner: 'worker', leaseId: 'lease', leaseExpiresAt: selected.freshnessDeadline, queuedAt: selected.updatedAt }
    },
  } as unknown as SharedResearchWorkPort
  const scheduler = new ResearchDepthFilteredScheduler([store], ['light'])
  assert.deepEqual((await scheduler.peekGlobal({ now: '2026-08-26T12:00:00.000Z', limit: 10 })).map((item) => item.workId), ['light'])
  const lease = await scheduler.claimNext({ now: '2026-08-26T12:00:00.000Z', leaseOwner: 'worker', leaseTtlMs: 1_000 })
  assert.equal(lease?.work.workId, 'light')
  assert.deepEqual(claimed, ['light'])
  assert.deepEqual(depthQueries, [['light'], ['light']])
})

test('dedicated background pool pushes priority filtering before the bounded store head', async () => {
  const urgent = Array.from({ length: 251 }, (_, index) => ({
    ...researchWork(`urgent-${index}`, 'light'), priorityClass: 'P0' as const,
  }))
  const background = { ...researchWork('background', 'light'), priorityClass: 'P3' as const }
  let receivedPriorities: unknown
  const store = {
    sourceType: 'news',
    peekSchedulable: async (query: { limit: number, priorityClasses?: ResearchWorkItem['priorityClass'][] }) => {
      receivedPriorities = query.priorityClasses
      return [...urgent, background]
        .filter((item) => query.priorityClasses?.includes(item.priorityClass) ?? true)
        .slice(0, query.limit)
    },
  } as unknown as SharedResearchWorkPort
  const scheduler = new ResearchDepthFilteredScheduler([store], ['light'])
  const work = await scheduler.peekGlobal({
    now: '2026-08-26T12:00:00.000Z', limit: 1, priorityClasses: ['P3'],
  })
  assert.deepEqual(receivedPriorities, ['P3'])
  assert.equal(work[0]?.workId, 'background')
})

test('same-priority source fairness prevents one adapter from consuming every claim in a batch', async () => {
  const pending = new Map<'news' | 'polymarket', string[]>([
    ['news', Array.from({ length: 251 }, (_, index) => `news-${String(index).padStart(3, '0')}`)],
    ['polymarket', ['poly-z']],
  ])
  const claims: string[] = []
  const store = (sourceType: 'news' | 'polymarket') => ({
    sourceType,
    peekSchedulable: async (query: { limit: number }) => (pending.get(sourceType) ?? [])
      .slice(0, query.limit).map((id) => researchWork(id, 'light', sourceType)),
    claimWithLease: async (command: { workId: string; leaseOwner: string; leaseId: string; leaseExpiresAt: string }) => {
      const rows = pending.get(sourceType) ?? []
      const index = rows.indexOf(command.workId)
      if (index < 0) return null
      rows.splice(index, 1)
      claims.push(command.workId)
      const work = researchWork(command.workId, 'light', sourceType)
      return {
        work: { ...work, status: 'retrieval_leased' as const }, leaseOwner: command.leaseOwner,
        leaseId: command.leaseId, leaseExpiresAt: command.leaseExpiresAt, queuedAt: work.updatedAt,
      }
    },
  }) as unknown as SharedResearchWorkPort
  const scheduler = new ResearchDepthFilteredScheduler(
    [store('news'), store('polymarket')], ['light'], () => true, 2,
  )
  for (let index = 0; index < 3; index += 1) await scheduler.claimNext({
    now: '2026-08-26T12:00:00.000Z', leaseOwner: 'worker', leaseTtlMs: 1_000,
  })
  assert.deepEqual(claims, ['news-000', 'news-001', 'poly-z'])
})

test('claim gate is rechecked after peek so a mid-cycle drain prevents the CAS claim', async () => {
  let enabled = true
  let claims = 0
  const item = researchWork('controlled', 'light')
  const store = {
    sourceType: 'news',
    peekSchedulable: async () => { enabled = false; return [item] },
    claimWithLease: async () => { claims += 1; throw new Error('must remain gated') },
  } as unknown as SharedResearchWorkPort
  const scheduler = new ResearchDepthFilteredScheduler([store], ['light'], () => enabled)
  assert.equal(await scheduler.claimNext({
    now: '2026-08-26T12:00:00.000Z', leaseOwner: 'worker', leaseTtlMs: 1_000,
  }), null)
  assert.equal(claims, 0)
})

test('recovery resumes expired leases and due retries once without inflating attempts', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'shared-research-recovery-'))
  const store = new SqliteSignalPlatformStore(join(dir, 'store.sqlite'), 'news')
  try {
    const expired = researchWork('expired', 'light')
    const retry = researchWork('retry', 'light')
    store.appendSignal(researchSignal(expired.signalId))
    store.appendSignal(researchSignal(retry.signalId))
    store.admitResearchWork(expired)
    store.admitResearchWork(retry)
    await store.claimWithLease({
      workId: expired.workId, expectedStatus: 'research_pending', leaseOwner: 'crashed', leaseId: 'expired-lease',
      now: '2026-08-26T11:58:00.000Z', leaseExpiresAt: '2026-08-26T11:59:00.000Z',
    })
    await store.claimWithLease({
      workId: retry.workId, expectedStatus: 'research_pending', leaseOwner: 'failed', leaseId: 'retry-lease',
      now: '2026-08-26T11:58:00.000Z', leaseExpiresAt: '2026-08-26T12:05:00.000Z',
    })
    assert.equal(await store.transitionLeased({
      workId: retry.workId, expectedStatus: 'retrieval_leased', leaseOwner: 'failed', leaseId: 'retry-lease',
      nextStatus: 'retry_wait', nextAttemptAt: '2026-08-26T11:59:30.000Z',
      failureCategory: 'retrieval_timeout', failureDetail: 'failure:retrieval_timeout',
      attemptDelta: 1, now: '2026-08-26T11:58:30.000Z',
    }), true)
    const scheduler = new SharedResearchScheduler([store])
    const recovered = await scheduler.recoverExpiredLeases({ now: '2026-08-26T12:00:00.000Z', limitPerStore: 10 })
    assert.deepEqual(new Set(recovered.news), new Set([expired.workId, retry.workId]))
    assert.equal(store.getResearchWork(expired.workId)?.attemptCount, 0)
    assert.equal(store.getResearchWork(retry.workId)?.attemptCount, 1)
    assert.deepEqual(await scheduler.recoverExpiredLeases({
      now: '2026-08-26T12:00:00.000Z', limitPerStore: 10,
    }), { news: [] })
    const command = { now: '2026-08-26T12:00:01.000Z', leaseOwner: 'resumed', leaseTtlMs: 60_000, stages: ['retrieval' as const] }
    const resumed = [await scheduler.claimNext(command), await scheduler.claimNext(command)]
    assert.deepEqual(new Set(resumed.map((lease) => lease?.work.workId)), new Set([expired.workId, retry.workId]))
    assert.equal(await scheduler.claimNext(command), null)
  } finally {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

function researchWork(
  workId: string,
  depth: ResearchWorkItem['researchDepth'],
  sourceType: Signal['sourceType'] = 'news',
): ResearchWorkItem {
  return {
    schemaVersion: RESEARCH_WORK_SCHEMA_VERSION, workId, signalId: `signal-${workId}`, sourceType,
    researchDepth: depth, deepReason: depth === 'deep' ? 'manual_analyst_request' : null,
    priorityClass: 'P2', priorityScore: 0.5, freshnessDeadline: '2026-08-27T12:00:00.000Z',
    policyVersion: 'policy.v1', researchContractVersion: 'myboon.research_packet.v1',
    retrievalPlan: { sourceUrl: 'https://example.com/item', allowedDomains: ['example.com'], maxExternalSources: 1 },
    budget: { maxProviderCalls: 2, maxRepairCalls: 1, maxInputTokens: 1000, maxOutputTokens: 500, maxToolCalls: 0, maxWallTimeMs: 10000 },
    status: 'research_pending', attemptCount: 0, nextAttemptAt: null, leaseOwner: null, leaseId: null,
    leaseExpiresAt: null, failureCategory: null, failureDetail: null, traceId: `trace-${workId}`,
    createdAt: '2026-08-26T12:00:00.000Z', updatedAt: '2026-08-26T12:00:00.000Z',
  }
}

function researchSignal(signalId: string): Signal {
  return {
    schemaVersion: SIGNAL_SCHEMA_VERSION, signalId, sourceType: 'news', sourceId: `news:${signalId}`,
    contentKind: 'article', content: { schemaVersion: 'myboon.signal_content.article.v1' },
    observedAt: '2026-08-26T11:50:00.000Z', publishedAt: '2026-08-26T11:49:00.000Z',
    canonicalUrl: 'https://example.com/item', title: 'Runner recovery', visibleSummary: null,
    media: { imageUrl: null, attribution: null }, sourceHints: { entities: [], assets: [], eventId: null, deadline: null },
    provenance: { provider: 'fixture', upstreamSource: null, rawPayloadRef: 'fixture:runner' },
    idempotencyKey: `fixture:${signalId}`,
  }
}
