import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync } from 'node:fs'
import test from 'node:test'
import {
  DEEP_RESEARCH_RUNTIME_ENV,
  SourceRoutedDeepResearchExecutionRegistry,
  createProductionDeepResearchRuntime,
  loadDeepResearchRuntimeConfiguration,
} from './runtime-composition'
import type { DeepResearchExecutionMetadata } from './types'
import type { DeepResearchWorkStore } from './worker'
import { InferenceGateway } from '../inference-gateway'

const auditRoot = mkdtempSync('/var/tmp/myboon-deep-runtime-test-')
const nestedAuditRoot = `${auditRoot}/myboon-deep-nested`
mkdirSync(nestedAuditRoot)

function validEnv(): Record<string, string> {
  return {
    [DEEP_RESEARCH_RUNTIME_ENV.workerExecutable]: '/opt/myboon/bin/deep-worker',
    [DEEP_RESEARCH_RUNTIME_ENV.workerContractVersion]: 'myboon.deep_worker.v1',
    [DEEP_RESEARCH_RUNTIME_ENV.workerArgsJson]: '["--contract=myboon.deep-worker.v1"]',
    [DEEP_RESEARCH_RUNTIME_ENV.approvedDomains]: 'news.example,primary.example',
    [DEEP_RESEARCH_RUNTIME_ENV.capabilities]: 'browser_navigation,registered_search,http_fetch',
    [DEEP_RESEARCH_RUNTIME_ENV.provider]: 'ollama-cloud',
    [DEEP_RESEARCH_RUNTIME_ENV.model]: 'deepseek-v4-flash',
    [DEEP_RESEARCH_RUNTIME_ENV.promptVersion]: 'research.deep.prompt.v1',
    [DEEP_RESEARCH_RUNTIME_ENV.maxBrowserNavigations]: '3',
    [DEEP_RESEARCH_RUNTIME_ENV.maxSearchQueries]: '3',
    [DEEP_RESEARCH_RUNTIME_ENV.maxHttpFetches]: '4',
    [DEEP_RESEARCH_RUNTIME_ENV.maxOutputBytes]: '100000',
    [DEEP_RESEARCH_RUNTIME_ENV.cpuQuotaPercent]: '50',
    [DEEP_RESEARCH_RUNTIME_ENV.memoryMaxBytes]: '536870912',
    [DEEP_RESEARCH_RUNTIME_ENV.tasksMax]: '64',
    [DEEP_RESEARCH_RUNTIME_ENV.reasoningEffort]: 'low',
    [DEEP_RESEARCH_RUNTIME_ENV.maxConcurrency]: '4',
    [DEEP_RESEARCH_RUNTIME_ENV.rateMaxCalls]: '60',
    [DEEP_RESEARCH_RUNTIME_ENV.rateWindowMs]: '60000',
    [DEEP_RESEARCH_RUNTIME_ENV.auditTempRoots]: auditRoot,
    [DEEP_RESEARCH_RUNTIME_ENV.auditProfileRoots]: auditRoot,
    [DEEP_RESEARCH_RUNTIME_ENV.auditLimit]: '100',
    [DEEP_RESEARCH_RUNTIME_ENV.runtimeStatusPath]: '/tmp/deep-status.json',
  }
}

test('deep production configuration requires explicit strict routes, policy, and sidecar-capable command', () => {
  const config = loadDeepResearchRuntimeConfiguration(validEnv())
  assert.equal(config.workerExecutable, '/opt/myboon/bin/deep-worker')
  assert.equal(config.workerContractVersion, 'myboon.deep_worker.v1')
  assert.deepEqual(config.workerArgs, ['--contract=myboon.deep-worker.v1'])
  assert.deepEqual([...config.approvedDomains], ['news.example', 'primary.example'])
  assert.deepEqual(config.policy.capabilities, ['browser_navigation', 'registered_search', 'http_fetch'])
})

test('deep production configuration rejects missing contract, unsafe tools, wildcard domains, and relative executables', () => {
  for (const mutate of [
    (env: Record<string, string>) => { delete env[DEEP_RESEARCH_RUNTIME_ENV.workerContractVersion] },
    (env: Record<string, string>) => { env[DEEP_RESEARCH_RUNTIME_ENV.capabilities] = 'terminal' },
    (env: Record<string, string>) => { env[DEEP_RESEARCH_RUNTIME_ENV.approvedDomains] = '*.example.com' },
    (env: Record<string, string>) => { env[DEEP_RESEARCH_RUNTIME_ENV.workerExecutable] = './worker' },
  ]) {
    const env = validEnv()
    mutate(env)
    assert.throws(() => loadDeepResearchRuntimeConfiguration(env))
  }
})

test('deep audit roots require dedicated existing non-overlapping locations while allowing one shared root', () => {
  assert.deepEqual(loadDeepResearchRuntimeConfiguration(validEnv()).audit.tempRoots, [auditRoot])
  for (const [name, value] of [
    [DEEP_RESEARCH_RUNTIME_ENV.auditTempRoots, ''],
    [DEEP_RESEARCH_RUNTIME_ENV.auditTempRoots, '/'],
    [DEEP_RESEARCH_RUNTIME_ENV.auditTempRoots, '/tmp'],
    [DEEP_RESEARCH_RUNTIME_ENV.auditTempRoots, '/var/tmp/myboon-deep-does-not-exist'],
    [DEEP_RESEARCH_RUNTIME_ENV.auditTempRoots, `${auditRoot},${nestedAuditRoot}`],
  ] as const) {
    const env = validEnv()
    env[name] = value
    assert.throws(() => loadDeepResearchRuntimeConfiguration(env))
  }
})

test('production deep runtime checks Linux systemd readiness before any queue claim', async () => {
  let claims = 0
  let auditScans = 0
  let registryClosed = false
  const store = new Proxy({ sourceType: 'news', peekSchedulable: async () => [] }, {
    get(target, property, receiver) {
      if (property === 'claimWithLease') claims += 1
      return Reflect.get(target, property, receiver)
    },
  }) as unknown as DeepResearchWorkStore
  const registry = {
    register: (_metadata: DeepResearchExecutionMetadata) => undefined,
    unregister: (_unitName: string) => undefined,
    list: () => [],
    close: () => { registryClosed = true },
  }
  const gateway = new InferenceGateway({
    adapter: { generate: async () => ({ value: {} }) },
    routes: { 'research.deep': { primary: { provider: 'ollama-cloud', model: 'deepseek-v4-flash' }, reasoningEffort: 'low', maxConcurrency: 4, rateLimit: { maxCalls: 60, windowMs: 60_000 } } },
  })
  const runtime = createProductionDeepResearchRuntime({
    env: validEnv(), stores: [store], platform: 'linux',
    systemd: {
      isAvailable: async () => false,
      spawnTransient: () => { throw new Error('must not spawn') },
      killUnit: async () => undefined,
      isUnitActive: async () => false,
    },
    executionRegistries: [{ sourceType: 'news', registry }],
    gateway,
    orphanInspector: {
      listTransientUnits: async () => { auditScans += 1; return [] },
      listRootEntries: async () => [], listSandboxExecutors: async () => [],
    },
    statusWriter: { write: async () => undefined },
  })
  assert.deepEqual(await runtime.runCycle(), [{ kind: 'idle' }])
  assert.deepEqual(await runtime.runCycle(), [{ kind: 'idle' }])
  assert.equal(claims, 0)
  assert.equal(auditScans, 1)
  assert.equal(gateway.investigationEnabled, true)
  runtime.close()
  assert.equal(registryClosed, true)
})

test('durable deep execution registry routes by canonical source and shares one pipeline registry safely', () => {
  const writes: Record<string, DeepResearchExecutionMetadata[]> = { news: [], pipeline: [] }
  const closes: string[] = []
  const registry = (name: 'news' | 'pipeline') => ({
    register: (metadata: DeepResearchExecutionMetadata) => { writes[name].push(metadata) },
    unregister: (_unitName: string) => undefined,
    list: () => writes[name],
    close: () => { closes.push(name) },
  })
  const news = registry('news')
  const pipeline = registry('pipeline')
  const routed = new SourceRoutedDeepResearchExecutionRegistry([
    { sourceType: 'news', registry: news },
    { sourceType: 'polymarket', registry: pipeline },
    { sourceType: 'market_calendar', registry: pipeline },
    { sourceType: 'x', registry: pipeline },
  ])
  const metadata = (sourceType: DeepResearchExecutionMetadata['sourceType']): DeepResearchExecutionMetadata => ({
    jobId: `job-${sourceType}`, workId: `work-${sourceType}`, traceId: `trace-${sourceType}`, sourceType,
    unitName: `myboon-deep-${sourceType}.service`, startedAt: '2026-08-26T00:00:00.000Z',
    deadlineAt: '2026-08-26T00:01:00.000Z', tempPath: `/tmp/${sourceType}`, profilePath: `/tmp/${sourceType}/profile`,
  })
  routed.register(metadata('news'))
  routed.register(metadata('x'))
  assert.deepEqual(writes.news.map((item) => item.sourceType), ['news'])
  assert.deepEqual(writes.pipeline.map((item) => item.sourceType), ['x'])
  routed.close()
  assert.deepEqual(closes.sort(), ['news', 'pipeline'])
})
