import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { RESEARCH_WORK_SCHEMA_VERSION, type ResearchWorkItem } from '../signal-platform/contracts'
import { SqliteSignalPlatformStore } from '../signal-platform/sqlite-platform-store'
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
      standardSearch: { schemaVersion: 'myboon.standard_search_status.v1', enabled: false, connectorId: null, policyVersion: null },
      gateway: {
        schemaVersion: 'myboon.inference_gateway_status.v1', hermesProfileConfigured: false,
        investigate: { enabled: false, fallbackEnabled: false }, routes: [],
      },
      circuits: { schemaVersion: 'myboon.inference_circuit_status.v1', capturedAt: '2026-08-26T12:00:00.000Z', workloads: [] },
      deepEnabled: false,
    },
    runCycle: async () => { onCycle(); return [] },
    stop: async () => undefined,
    close: () => undefined,
  }
}

test('off mode stays resident without constructing stores, providers, or runtimes', async () => {
  let creates = 0
  let reports = 0
  const controller = new AbortController()
  await runSharedResearchLoop({
    env: { [SHARED_RESEARCH_ENV.intervalMs]: '100' },
    signal: controller.signal,
    createRuntime: () => { creates += 1; throw new Error('must not construct') },
    onResult: () => { reports += 1 },
    wait: async () => { controller.abort() },
  })
  assert.equal(creates, 0)
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

test('active config exposes dedicated disjoint priority pools', () => {
  const config = loadSharedResearchRunnerConfig({
    FEED_V3_RESEARCH_MODE: 'active', FEED_V3_RESEARCH_ACTIVE_SOURCES: 'news',
    FEED_V3_LEGACY_RESEARCH_DISABLED_SOURCES: 'news',
    [SHARED_RESEARCH_ENV.urgentPriorities]: 'P0,P1',
    [SHARED_RESEARCH_ENV.backgroundPriorities]: 'P2,P3',
  })
  assert.deepEqual(config.urgentPriorities, ['P0', 'P1'])
  assert.deepEqual(config.backgroundPriorities, ['P2', 'P3'])
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

function researchWork(workId: string, depth: ResearchWorkItem['researchDepth']): ResearchWorkItem {
  return {
    schemaVersion: RESEARCH_WORK_SCHEMA_VERSION, workId, signalId: `signal-${workId}`, sourceType: 'news',
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
