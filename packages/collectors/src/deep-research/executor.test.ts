import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'
import {
  InferenceGateway,
  type StructuredProviderAdapter,
} from '../inference-gateway'
import {
  RESEARCH_PACKET_SCHEMA_VERSION,
  RESEARCH_WORK_SCHEMA_VERSION,
  SIGNAL_SCHEMA_VERSION,
  type ResearchWorkItem,
  type RetrievedEvidence,
  type Signal,
} from '../signal-platform/contracts'
import { DeepResearchError } from './errors'
import {
  DeepResearchExecutor,
  InMemoryDeepResearchExecutionRegistry,
  buildDeepResearchUnitName,
  type DeepResearchFileSystem,
} from './executor'
import { DeepResearchGatewayPort } from './gateway-port'
import type {
  DeepResearchProcess,
  DeepResearchSpawnOptions,
  DeepResearchSystemdController,
} from './systemd-controller'
import {
  DEEP_RESEARCH_FETCHED_EVIDENCE_SCHEMA_VERSION,
  DEEP_RESEARCH_USAGE_SCHEMA_VERSION,
  type DeepResearchJob,
} from './types'

const SIGNAL: Signal = {
  schemaVersion: SIGNAL_SCHEMA_VERSION,
  signalId: 'signal_deep_1',
  sourceId: 'source_1',
  sourceType: 'news',
  contentKind: 'article',
  content: { schemaVersion: 'myboon.signal_content.article.v1' },
  observedAt: '2026-08-26T12:00:00.000Z',
  publishedAt: '2026-08-26T11:55:00.000Z',
  canonicalUrl: 'https://source.example/story',
  title: 'Conflicting protocol statements',
  visibleSummary: 'Two primary statements conflict.',
  media: { imageUrl: null, attribution: null },
  sourceHints: { entities: [], assets: [], eventId: null, deadline: null },
  provenance: { provider: 'feed', upstreamSource: null, rawPayloadRef: 'raw:deep:1' },
  idempotencyKey: 'deep:1',
}

const WORK: ResearchWorkItem = {
  schemaVersion: RESEARCH_WORK_SCHEMA_VERSION,
  workId: 'work_deep_1',
  signalId: SIGNAL.signalId,
  sourceType: SIGNAL.sourceType,
  researchDepth: 'deep',
  deepReason: 'conflicting_primary_sources',
  priorityClass: 'P1',
  priorityScore: 0.95,
  freshnessDeadline: '2026-08-27T12:00:00.000Z',
  policyVersion: 'deep-policy.v1',
  researchContractVersion: RESEARCH_PACKET_SCHEMA_VERSION,
  retrievalPlan: {
    sourceUrl: SIGNAL.canonicalUrl,
    allowedDomains: ['source.example', 'corroboration.example'],
    maxExternalSources: 2,
  },
  budget: {
    maxProviderCalls: 5,
    maxRepairCalls: 0,
    maxInputTokens: 20_000,
    maxOutputTokens: 4_000,
    maxToolCalls: 10,
    maxWallTimeMs: 300_000,
  },
  status: 'research_pending',
  attemptCount: 0,
  nextAttemptAt: null,
  leaseOwner: null,
  leaseId: null,
  leaseExpiresAt: null,
  failureCategory: null,
  failureDetail: null,
  traceId: 'trace_deep_1',
  createdAt: '2026-08-26T12:00:00.000Z',
  updatedAt: '2026-08-26T12:00:00.000Z',
}

const EVIDENCE: RetrievedEvidence = {
  schemaVersion: 'myboon.evidence.v1',
  evidenceId: 'evidence_deep_1',
  workId: WORK.workId,
  requestedUrl: 'https://source.example/story',
  finalUrl: 'https://source.example/story',
  authority: 'source_url',
  authorityId: 'source-plan',
  contentHash: 'hash1',
  contentType: 'text/html',
  httpStatus: 200,
  retrievalMethod: 'safe_http',
  retrievedAt: '2026-08-26T12:01:00.000Z',
  text: 'Bounded source text.',
  truncated: false,
  byteLength: 20,
}

function job(overrides: Partial<DeepResearchJob> = {}): DeepResearchJob {
  return {
    schemaVersion: 'myboon.deep_research_job.v1',
    jobId: 'deep_job_1',
    signal: SIGNAL,
    workItem: WORK,
    evidence: [EVIDENCE],
    escalation: {
      reason: 'conflicting_primary_sources',
      unresolvedQuestion: 'Which primary statement reflects the current protocol behavior?',
      supportingEvidenceRefs: [EVIDENCE.evidenceId],
    },
    approvedDomains: ['source.example', 'corroboration.example'],
    capabilities: ['browser_navigation', 'registered_search', 'http_fetch'],
    inference: { provider: 'primary', model: 'deep', reasoningEffort: 'low' },
    budget: {
      maxProviderCalls: 5,
      maxInputTokens: 20_000,
      maxOutputTokens: 4_000,
      maxToolCalls: 5,
      maxBrowserNavigations: 3,
      maxSearchQueries: 2,
      maxHttpFetches: 3,
      maxWallTimeMs: 1_000,
      maxOutputBytes: 4_096,
      cpuQuotaPercent: 50,
      memoryMaxBytes: 536_870_912,
      tasksMax: 32,
    },
    ...overrides,
  }
}

class FakeChild extends EventEmitter implements DeepResearchProcess {
  stdout = new EventEmitter()
  stderr = new EventEmitter()
}

class FakeSystemd implements DeepResearchSystemdController {
  available = true
  active = false
  surviveKill = false
  readonly child = new FakeChild()
  readonly spawnCalls: Array<{ args: string[], options: DeepResearchSpawnOptions }> = []
  readonly kills: Array<{ unit: string, signal: 'TERM' | 'KILL' }> = []
  onSpawn?: (child: FakeChild) => void

  async isAvailable() { return this.available }
  spawnTransient(args: string[], options: DeepResearchSpawnOptions) {
    this.spawnCalls.push({ args, options })
    this.active = true
    if (this.onSpawn) setImmediate(() => this.onSpawn?.(this.child))
    return this.child
  }
  async killUnit(unit: string, signal: 'TERM' | 'KILL') {
    this.kills.push({ unit, signal })
    if (signal === 'KILL' && !this.surviveKill) this.active = false
  }
  async isUnitActive() { return this.active }
}

class FakeFileSystem implements DeepResearchFileSystem {
  readonly root = '/tmp/deep-fixture'
  readonly dirs: string[] = []
  readonly files = new Map<string, string>()
  removed = false
  cleanupSurvives = false

  async makeTempDir() { this.dirs.push(this.root); return this.root }
  async makeDir(path: string) { this.dirs.push(path) }
  async writePrivateFile(path: string, contents: string) { this.files.set(path, contents) }
  async readPrivateFile(path: string, maxBytes: number) {
    const value = this.files.get(path)
    if (value === undefined) throw new Error('missing private file')
    if (Buffer.byteLength(value) > maxBytes) throw new Error('private file too large')
    return value
  }
  async removeTree() { this.removed = true; if (!this.cleanupSurvives) this.files.clear() }
  async exists() { return this.cleanupSurvives }
}

function executor(
  systemd: FakeSystemd,
  fileSystem = new FakeFileSystem(),
  overrides: Partial<ConstructorParameters<typeof DeepResearchExecutor>[0]> = {},
) {
  if (!fileSystem.files.has('/tmp/deep-fixture/usage.json')) {
    fileSystem.files.set('/tmp/deep-fixture/usage.json', JSON.stringify({
      schemaVersion: DEEP_RESEARCH_USAGE_SCHEMA_VERSION,
      providerCalls: 2,
      inputTokens: 1_200,
      outputTokens: 300,
      toolCalls: 3,
      browserNavigations: 1,
      searchQueries: 1,
      httpFetches: 1,
    }))
  }
  if (!fileSystem.files.has('/tmp/deep-fixture/fetched-evidence.json')) {
    fileSystem.files.set('/tmp/deep-fixture/fetched-evidence.json', JSON.stringify({
      schemaVersion: DEEP_RESEARCH_FETCHED_EVIDENCE_SCHEMA_VERSION,
      jobId: 'deep_job_1', workId: 'work_deep_1', traceId: 'trace_deep_1', results: [],
    }))
  }
  const registry = new InMemoryDeepResearchExecutionRegistry()
  return {
    fileSystem,
    registry,
    value: new DeepResearchExecutor({
      enabled: true,
      worker: { executable: '/opt/myboon/bin/deep-worker', args: ['--json'] },
      systemd,
      fileSystem,
      registry,
      platform: 'linux',
      tempRoot: '/tmp',
      terminationGraceMs: 1,
      inactivePollMs: 1,
      inactiveTimeoutMs: 2,
      sleep: async () => undefined,
      uniqueId: () => 'unique-1',
      ...overrides,
    }),
  }
}

test('builds an argv-only transient service with exact containment properties and cleans temp state', async () => {
  const systemd = new FakeSystemd()
  systemd.onSpawn = (child) => {
    child.stdout.emit('data', Buffer.from('{"answer":"ok"}'))
    systemd.active = false
    child.emit('close', 0, null)
  }
  const context = executor(systemd)
  const result = await context.value.execute(job())
  const args = systemd.spawnCalls[0].args

  assert.deepEqual(args.slice(0, 4), [
    '--wait', '--collect', '--pipe', `--unit=${result.unitName}`,
  ])
  for (const property of [
    '--property=CPUQuota=50%',
    '--property=MemoryMax=536870912',
    '--property=TasksMax=32',
    '--property=RuntimeMaxSec=1s',
    '--property=PrivateTmp=yes',
    '--property=ProtectSystem=strict',
    '--property=ProtectHome=yes',
    '--property=NoNewPrivileges=yes',
    '--property=KillMode=control-group',
    '--property=RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6',
    '--property=BindPaths=/tmp/deep-fixture',
  ]) assert.ok(args.includes(property), property)
  assert.equal(args.includes('--scope'), false)
  assert.equal(args[args.indexOf('--') + 1], '/opt/myboon/bin/deep-worker')
  assert.equal(args.some((arg) => arg.includes('toolsets') || arg.includes('terminal')), false)
  assert.deepEqual(systemd.spawnCalls[0].options.env, {
    PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
    LANG: 'C.UTF-8',
  })
  assert.equal(result.status, 'succeeded')
  assert.equal(result.stdout, '{"answer":"ok"}')
  assert.deepEqual(result.budgetUsed, {
    providerCalls: 2, inputTokens: 1_200, outputTokens: 300, toolCalls: 3,
    browserNavigations: 1, searchQueries: 1, httpFetches: 1,
    wallTimeMs: result.durationMs, outputBytes: 15,
  })
  assert.ok(args.includes('--usage-file=/tmp/deep-fixture/usage.json'))
  assert.ok(args.includes('--evidence-manifest-file=/tmp/deep-fixture/fetched-evidence.json'))
  assert.equal(context.fileSystem.removed, true)
  assert.deepEqual(context.registry.list(), [])
})

test('successful units require strict measured usage and reject over-budget metering', async () => {
  for (const [name, usage, category] of [
    ['missing', null, 'invalid_job'],
    ['malformed', { providerCalls: 1 }, 'invalid_job'],
    ['over-provider', {
      schemaVersion: DEEP_RESEARCH_USAGE_SCHEMA_VERSION,
      providerCalls: 6, inputTokens: 1, outputTokens: 1, toolCalls: 1,
      browserNavigations: 1, searchQueries: 1, httpFetches: 1,
    }, 'budget_exceeded'],
    ['over-tool', {
      schemaVersion: DEEP_RESEARCH_USAGE_SCHEMA_VERSION,
      providerCalls: 1, inputTokens: 1, outputTokens: 1, toolCalls: 6,
      browserNavigations: 1, searchQueries: 1, httpFetches: 1,
    }, 'budget_exceeded'],
  ] as const) {
    const systemd = new FakeSystemd()
    systemd.onSpawn = (child) => {
      child.stdout.emit('data', Buffer.from('{"answer":"ok"}'))
      systemd.active = false
      child.emit('close', 0, null)
    }
    const context = executor(systemd)
    if (usage === null) context.fileSystem.files.delete('/tmp/deep-fixture/usage.json')
    else context.fileSystem.files.set('/tmp/deep-fixture/usage.json', JSON.stringify(usage))
    await assert.rejects(context.value.execute(job()), (error: unknown) => {
      assert.ok(error instanceof DeepResearchError, name)
      assert.equal(error.category, category, name)
      return true
    })
    assert.equal(context.fileSystem.removed, true, name)
    assert.deepEqual(context.registry.list(), [], name)
  }
})

test('successful units require a strict trusted fetched-evidence manifest', async () => {
  for (const [name, manifest, category] of [
    ['missing', null, 'invalid_job'],
    ['wrong-linkage', {
      schemaVersion: DEEP_RESEARCH_FETCHED_EVIDENCE_SCHEMA_VERSION,
      jobId: 'wrong', workId: 'work_deep_1', traceId: 'trace_deep_1', results: [],
    }, 'invalid_job'],
    ['outside-domain', {
      schemaVersion: DEEP_RESEARCH_FETCHED_EVIDENCE_SCHEMA_VERSION,
      jobId: 'deep_job_1', workId: 'work_deep_1', traceId: 'trace_deep_1',
      results: [{
        resultRef: 'result-1', title: 'Bad', url: 'https://evil.example/item', observedAt: null,
        note: null, contentHash: 'sha256:abc', retrievalMethod: 'http_fetch',
      }],
    }, 'invalid_job'],
  ] as const) {
    const systemd = new FakeSystemd()
    systemd.onSpawn = (child) => { systemd.active = false; child.emit('close', 0, null) }
    const context = executor(systemd)
    if (manifest === null) context.fileSystem.files.delete('/tmp/deep-fixture/fetched-evidence.json')
    else context.fileSystem.files.set('/tmp/deep-fixture/fetched-evidence.json', JSON.stringify(manifest))
    await assert.rejects(context.value.execute(job()), (error: unknown) => {
      assert.ok(error instanceof DeepResearchError, name)
      assert.equal(error.category, category, name)
      return true
    })
  }
})

test('durable registry failure cleans the workspace and never spawns a unit', async () => {
  const systemd = new FakeSystemd()
  const context = executor(systemd, new FakeFileSystem(), {
    registry: { register: () => { throw new Error('disk unavailable') }, unregister: () => undefined, list: () => [] },
  })
  await assert.rejects(context.value.execute(job()), (error: unknown) => {
    assert.ok(error instanceof DeepResearchError)
    assert.equal(error.category, 'execution_failed')
    return true
  })
  assert.equal(context.fileSystem.removed, true)
  assert.equal(systemd.spawnCalls.length, 0)
})

test('rejects unsafe reasons, evidence refs, domains, capabilities, and arbitrary toolsets', async (t) => {
  const cases: Array<[string, DeepResearchJob]> = [
    ['reason', job({ escalation: { ...job().escalation, reason: 'manual_analyst_request' } })],
    ['evidence', job({ escalation: { ...job().escalation, supportingEvidenceRefs: ['unknown'] } })],
    ['domain', job({ approvedDomains: ['localhost'] })],
    ['capability', job({ capabilities: ['terminal' as never] })],
    ['toolsets', { ...job(), toolsets: ['arbitrary'] } as unknown as DeepResearchJob],
  ]
  for (const [name, unsafe] of cases) {
    await t.test(name, async () => {
      const systemd = new FakeSystemd()
      await assert.rejects(executor(systemd).value.execute(unsafe), (error: unknown) => {
        assert.ok(error instanceof DeepResearchError)
        assert.equal(error.category, 'invalid_job')
        return true
      })
      assert.equal(systemd.spawnCalls.length, 0)
    })
  }
})

test('sanitizes and uniquifies transient service unit names', () => {
  const first = buildDeepResearchUnitName('../WORK id/with spaces', 'trace', 'one')
  const second = buildDeepResearchUnitName('../WORK id/with spaces', 'trace', 'two')
  assert.match(first, /^myboon-deep-[a-z0-9_.-]+-[0-9a-f]{16}\.service$/)
  assert.equal(first.includes('/'), false)
  assert.notEqual(first, second)
})

test('timeout sends TERM then KILL, verifies inactive, cleans, and returns typed timeout', async () => {
  const systemd = new FakeSystemd()
  const context = executor(systemd)
  const timed = job({ budget: { ...job().budget, maxWallTimeMs: 5 } })

  await assert.rejects(context.value.execute(timed), (error: unknown) => {
    assert.ok(error instanceof DeepResearchError)
    assert.equal(error.category, 'timed_out')
    assert.ok(error.metadata?.unitName)
    return true
  })
  assert.deepEqual(systemd.kills.map((kill) => kill.signal), ['TERM', 'KILL'])
  assert.equal(systemd.active, false)
  assert.equal(context.fileSystem.removed, true)
  assert.deepEqual(context.registry.list(), [])
})

test('surviving control group is a containment error and retains metadata/temp for sweeper', async () => {
  const systemd = new FakeSystemd()
  systemd.surviveKill = true
  const context = executor(systemd)

  await assert.rejects(context.value.execute(job({
    budget: { ...job().budget, maxWallTimeMs: 5 },
  })), (error: unknown) => {
    assert.ok(error instanceof DeepResearchError)
    assert.equal(error.category, 'containment_cleanup_failed')
    return true
  })
  assert.deepEqual(systemd.kills.map((kill) => kill.signal), ['TERM', 'KILL'])
  assert.equal(context.fileSystem.removed, false)
  assert.equal(context.registry.list().length, 1)
})

test('output cap terminates the unit and never returns bytes beyond the cap', async () => {
  const systemd = new FakeSystemd()
  const context = executor(systemd)
  systemd.onSpawn = (child) => child.stdout.emit('data', Buffer.from('0123456789'))

  await assert.rejects(context.value.execute(job({
    budget: { ...job().budget, maxOutputBytes: 5 },
  })), (error: unknown) => {
    assert.ok(error instanceof DeepResearchError)
    assert.equal(error.category, 'budget_exceeded')
    return true
  })
  assert.deepEqual(systemd.kills.map((kill) => kill.signal), ['TERM', 'KILL'])
  assert.equal(context.fileSystem.removed, true)
})

test('abort cancels the whole unit through TERM then KILL', async () => {
  const systemd = new FakeSystemd()
  const controller = new AbortController()
  systemd.onSpawn = () => controller.abort()
  const context = executor(systemd)

  await assert.rejects(context.value.execute(job(), { signal: controller.signal }), (error: unknown) => {
    assert.ok(error instanceof DeepResearchError)
    assert.equal(error.category, 'cancelled')
    return true
  })
  assert.deepEqual(systemd.kills.map((kill) => kill.signal), ['TERM', 'KILL'])
})

test('a lost attempt fence after spawn terminates and verifies the new unit before returning', async () => {
  const systemd = new FakeSystemd()
  const context = executor(systemd)
  await assert.rejects(context.value.execute(job(), { onExecutionStarted: async () => false }), (error: unknown) => {
    assert.ok(error instanceof DeepResearchError)
    assert.equal(error.category, 'cancelled')
    return true
  })
  assert.equal(systemd.spawnCalls.length, 1)
  assert.deepEqual(systemd.kills.map((kill) => kill.signal), ['TERM', 'KILL'])
  assert.equal(await systemd.isUnitActive(), false)
})

test('fails closed when disabled, unsupported, or systemd is unavailable', async () => {
  const systemd = new FakeSystemd()
  await assert.rejects(new DeepResearchExecutor({
    worker: { executable: '/worker' }, systemd, platform: 'linux',
  }).execute(job()), (error: unknown) => error instanceof DeepResearchError && error.category === 'containment_disabled')
  assert.equal(systemd.spawnCalls.length, 0)

  await assert.rejects(executor(systemd, new FakeFileSystem(), { platform: 'darwin' }).value.execute(job()),
    (error: unknown) => error instanceof DeepResearchError && error.category === 'unsupported_platform')
  systemd.available = false
  await assert.rejects(executor(systemd).value.execute(job()),
    (error: unknown) => error instanceof DeepResearchError && error.category === 'systemd_unavailable')
  assert.equal(systemd.spawnCalls.length, 0)
})

test('gateway investigate delegates only to the contained port and never resolves fallback', async () => {
  const calls: DeepResearchJob[] = []
  const contained = new DeepResearchGatewayPort({
    async execute(input: DeepResearchJob) {
      calls.push(input)
      return {
        schemaVersion: 'myboon.deep_research_result.v1',
        jobId: input.jobId,
        workId: input.workItem.workId,
        budgetUsed: { providerCalls: 1, inputTokens: 10, outputTokens: 5, toolCalls: 0, wallTimeMs: 1 },
      } as never
    },
  })
  let structuredCalls = 0
  const adapter: StructuredProviderAdapter = {
    async generate() { structuredCalls += 1; return { value: {} } },
  }
  const gateway = new InferenceGateway({
    adapter,
    routes: {
      'research.deep': {
        primary: { provider: 'primary', model: 'deep' },
        fallback: { provider: 'fallback', model: 'must-not-run' },
        reasoningEffort: 'low',
      },
    },
    investigationPort: contained,
  })
  const result = await gateway.investigate<{ jobId: string }>({
    workload: 'research.deep',
    purpose: 'test.deep',
    prompt: 'ignored by contained job port',
    promptVersion: 'deep.v1',
    policyVersion: WORK.policyVersion,
    budget: {
      maxProviderCalls: job().budget.maxProviderCalls,
      maxRepairCalls: 0,
      maxInputTokens: job().budget.maxInputTokens,
      maxOutputTokens: job().budget.maxOutputTokens,
      maxToolCalls: job().budget.maxToolCalls,
      maxWallTimeMs: job().budget.maxWallTimeMs,
    },
    allowedCapabilities: ['browser_navigation', 'registered_search', 'http_fetch'],
    job: job(),
  })

  assert.equal(result.jobId, 'deep_job_1')
  assert.equal(calls.length, 1)
  assert.equal(structuredCalls, 0)
})

test('gateway contained port rejects capabilities outside or different from the job allowlist', async () => {
  let executions = 0
  const port = new DeepResearchGatewayPort({
    async execute() { executions += 1; return {} as never },
  })
  await assert.rejects(port.execute({
    workload: 'research.deep',
    purpose: 'test.deep.unsafe-tools',
    prompt: 'Deep',
    promptVersion: 'deep.v1',
    policyVersion: WORK.policyVersion,
    budget: { ...WORK.budget },
    allowedCapabilities: ['browser_navigation', 'terminal'],
    job: job(),
  }), (error: unknown) => error instanceof DeepResearchError && error.category === 'invalid_job')
  assert.equal(executions, 0)
})

test('failed temp cleanup is typed and remains registered for a sweeper', async () => {
  const systemd = new FakeSystemd()
  systemd.onSpawn = (child) => {
    systemd.active = false
    child.emit('close', 0, null)
  }
  const fileSystem = new FakeFileSystem()
  fileSystem.cleanupSurvives = true
  const context = executor(systemd, fileSystem)

  await assert.rejects(context.value.execute(job()), (error: unknown) => {
    assert.ok(error instanceof DeepResearchError)
    assert.equal(error.category, 'containment_cleanup_failed')
    return true
  })
  assert.equal(fileSystem.removed, true)
  assert.equal(context.registry.list().length, 1)
})
