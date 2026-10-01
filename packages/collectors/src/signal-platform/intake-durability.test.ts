import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import type { NewsSignal, Signal } from './contracts'
import { SIGNAL_SCHEMA_VERSION } from './contracts'
import { ImmutableRecordConflictError } from './platform-store'
import { SqliteSignalPlatformStore } from './sqlite-platform-store'
import { CanonicalSourceSignalIntake, deliverCanonicalSignals } from './source-intake'
import {
  createActiveIntakeDisposition,
  createNoAdmissionDisposition,
} from './intake-admission'
import {
  createPriorityPolicyV1,
  createResearchWorkItemFromDecision,
  RulesFirstTriageEngine,
  type ResearchWorkCreationPolicy,
} from './triage-engine'
import type { RulesFirstTriageInput, TriageCapacitySnapshot } from './triage-contracts'

const nodeRequire = createRequire(__filename)
const { DatabaseSync } = nodeRequire('node:sqlite') as {
  DatabaseSync: new (path: string) => {
    exec(sql: string): void
    prepare(sql: string): { run(...params: unknown[]): unknown }
    close(): void
  }
}

const NOW = '2026-08-26T12:00:00.000Z'
const PRIORITY_POLICY_VERSION = 'intake-test.triage.v1'
const BUDGET_POLICY_VERSION = 'intake-test.budget.v1'

function signal(overrides: Partial<NewsSignal> = {}): Extract<Signal, { sourceType: 'news' }> {
  return {
    schemaVersion: SIGNAL_SCHEMA_VERSION,
    signalId: 'signal-intake-1',
    sourceType: 'news',
    sourceId: 'source:article:1',
    contentKind: 'article',
    content: { schemaVersion: 'myboon.signal_content.article.v1' },
    observedAt: NOW,
    publishedAt: '2026-08-26T11:55:00.000Z',
    canonicalUrl: 'https://example.com/article',
    title: 'Canonical article',
    visibleSummary: 'Summary',
    media: { imageUrl: null, attribution: 'Example' },
    sourceHints: { entities: [], assets: [], eventId: null, deadline: null },
    provenance: { provider: 'fixture', upstreamSource: 'Example', rawPayloadRef: 'raw-1' },
    idempotencyKey: 'intake-key-1',
    ...overrides,
  }
}

function openCapacity(available = 10): TriageCapacitySnapshot {
  const bucket = { available, reservedAvailable: 2, utilization: 0 }
  return {
    byPriority: {
      P0: { ...bucket }, P1: { ...bucket }, P2: { ...bucket }, P3: { ...bucket },
    },
    byDepth: { light: { ...bucket }, standard: { ...bucket }, deep: { ...bucket } },
  }
}

function triageInput(item: Signal, overrides: Partial<RulesFirstTriageInput> = {}): RulesFirstTriageInput {
  return {
    signal: item,
    now: NOW,
    sourceAuthorityScore: 0.9,
    officialSource: true,
    dedupeOutcome: 'new_observation',
    novelty: 'material',
    entityCanonOverlap: true,
    materialityTags: ['market_material'],
    eventDeadline: null,
    providerHealth: 'healthy',
    capacity: openCapacity(),
    ambiguity: { isAmbiguous: false, reasons: [] },
    deepEscalation: null,
    ...overrides,
  }
}

const retrievalPolicy: ResearchWorkCreationPolicy = {
  policyVersion: 'intake-test.retrieval.v1',
  allowedDomains: ['example.com'],
  maxExternalSourcesByDepth: { light: 1, standard: 3, deep: 5 },
}

interface CountingTriage {
  calls: number
  decide(input: RulesFirstTriageInput): Promise<Awaited<ReturnType<RulesFirstTriageEngine['decide']>>>
}

function countingTriage(): CountingTriage {
  const engine = new RulesFirstTriageEngine({
    policy: createPriorityPolicyV1({
      policyVersion: PRIORITY_POLICY_VERSION,
      budgetPolicyVersion: BUDGET_POLICY_VERSION,
    }),
  })
  return {
    calls: 0,
    async decide(input) {
      this.calls += 1
      return engine.decide(input)
    },
  }
}

function makeIntake(store: SqliteSignalPlatformStore, overrides: {
  mode?: 'observe' | 'active'
  triage?: CountingTriage
  policy?: ResearchWorkCreationPolicy
  clock?: () => string
  capacity?: () => TriageCapacitySnapshot
} = {}): { intake: CanonicalSourceSignalIntake; triage: CountingTriage } {
  const triage = overrides.triage ?? countingTriage()
  const intake = new CanonicalSourceSignalIntake({
    mode: overrides.mode ?? 'active',
    // Observe mode only evaluates when explicitly asked to.
    evaluate: (overrides.mode ?? 'active') === 'observe',
    store,
    triage,
    retrievalPolicy: overrides.policy ?? retrievalPolicy,
    decisionPolicy: {
      priorityPolicyVersion: PRIORITY_POLICY_VERSION,
      budgetPolicyVersion: BUDGET_POLICY_VERSION,
    },
    buildTriageInput: async (item) => triageInput(item, {
      now: overrides.clock?.() ?? NOW,
      capacity: overrides.capacity?.() ?? openCapacity(),
    }),
  })
  return { intake, triage }
}

function fixture(name: string): { dir: string; path: string } {
  const dir = mkdtempSync(join(tmpdir(), `intake-durability-${name}-`))
  return { dir, path: join(dir, 'store.sqlite') }
}

/** Simulates a crash that lost the work row after the decision/disposition landed. */
function deleteWorkRow(path: string, workId: string): void {
  const db = new DatabaseSync(path)
  try {
    db.exec('PRAGMA busy_timeout = 5000;')
    db.prepare('DELETE FROM signal_platform_research_work WHERE work_id = ?').run(workId)
  } finally {
    db.close()
  }
}

test('a failure between intake inserts rolls the whole unit back but keeps the signal', async () => {
  const temp = fixture('rollback')
  const store = new SqliteSignalPlatformStore(temp.path, 'news')
  const blocker = new DatabaseSync(temp.path)
  try {
    const { intake } = makeIntake(store)
    // The signal is saved first, outside the intake unit's transaction.
    assert.equal(store.appendSignal(signal()).inserted, true)
    blocker.exec(`
      CREATE TRIGGER fail_intake_work BEFORE INSERT ON signal_platform_research_work
      BEGIN SELECT RAISE(ABORT, 'injected work insert failure'); END;
    `)
    await assert.rejects(intake.ingest(signal()), /injected work insert failure/)

    blocker.exec('DROP TRIGGER fail_intake_work')
    assert.equal(store.listTriageDecisionsBySignal('signal-intake-1', 10).length, 0, 'decision must roll back')
    assert.equal(store.listOwedActiveAdmissions({ limit: 10 }).length, 0, 'disposition must roll back')
    assert.equal(store.listResearchWorkBySignal('signal-intake-1', 10).length, 0, 'work must roll back')
    assert.ok(store.getSignal('signal-intake-1'), 'the already saved signal survives')

    const retry = await intake.ingest(signal())
    assert.equal(retry.workInserted, true)
    assert.equal(retry.held, null)
  } finally {
    blocker.close(); store.close(); rmSync(temp.dir, { recursive: true, force: true })
  }
})

test('repeated and concurrent delivery converge on one immutable job with one triage call', async () => {
  const temp = fixture('replay')
  const store = new SqliteSignalPlatformStore(temp.path, 'news')
  const other = new SqliteSignalPlatformStore(temp.path, 'news')
  try {
    const { intake, triage } = makeIntake(store)
    const first = await intake.ingest(signal())
    const second = await intake.ingest(signal())
    assert.equal(triage.calls, 1, 're-entry must not rerun triage')
    assert.equal(second.workInserted, false)
    assert.equal(second.recovered, true)
    assert.equal(second.work?.workId, first.work?.workId)

    // A second connection delivering the same observation concurrently.
    const { intake: concurrent } = makeIntake(other)
    const [a, b] = await Promise.all([concurrent.ingest(signal()), concurrent.ingest(signal())])
    assert.equal(a.workInserted, false)
    assert.equal(b.workInserted, false)
    assert.equal(a.work?.workId, first.work?.workId)
    assert.equal(b.work?.workId, first.work?.workId)
    assert.equal(store.listResearchWorkBySignal('signal-intake-1', 10).length, 1)
  } finally {
    other.close(); store.close(); rmSync(temp.dir, { recursive: true, force: true })
  }
})

test('proven active admission repair reuses the saved payload and makes no triage call', async () => {
  const temp = fixture('repair')
  const store = new SqliteSignalPlatformStore(temp.path, 'news')
  try {
    const { intake, triage } = makeIntake(store)
    const admitted = await intake.ingest(signal())
    const frozenWork = admitted.work!
    assert.ok(frozenWork)
    deleteWorkRow(temp.path, frozenWork.workId)

    // A completely different clock, capacity, and retrieval policy today.
    const { intake: repairIntake, triage: repairTriage } = makeIntake(store, {
      clock: () => '2026-09-30T23:59:59.000Z',
      capacity: () => openCapacity(0),
      policy: {
        policyVersion: 'intake-test.retrieval.v2',
        allowedDomains: ['changed.example'],
        maxExternalSourcesByDepth: { light: 9, standard: 9, deep: 9 },
      },
    })
    const report = await repairIntake.repairAdmissions(10)
    assert.equal(repairTriage.calls, 0, 'repair must not call triage')
    assert.deepEqual(report.repairedWorkIds, [frozenWork.workId])
    assert.deepEqual(report.held, [])

    const repaired = store.getResearchWork(frozenWork.workId)
    assert.deepEqual(repaired, frozenWork, 'the saved payload is replayed verbatim')
    const owed = store.listOwedActiveAdmissions({ limit: 10 })
    assert.deepEqual(owed, [])
  } finally {
    store.close(); rmSync(temp.dir, { recursive: true, force: true })
  }
})

test('a changed clock, capacity, and retrieval policy cannot alter a saved payload', async () => {
  const temp = fixture('frozen')
  const store = new SqliteSignalPlatformStore(temp.path, 'news')
  try {
    const { intake } = makeIntake(store)
    const first = await intake.ingest(signal())
    const savedWork = first.work!
    const savedDisposition = store.findIntakeUnit({
      signalId: 'signal-intake-1',
      priorityPolicyVersion: PRIORITY_POLICY_VERSION,
      budgetPolicyVersion: BUDGET_POLICY_VERSION,
    })
    assert.ok(savedDisposition)

    const { intake: later, triage } = makeIntake(store, {
      clock: () => '2026-10-01T06:00:00.000Z',
      capacity: () => openCapacity(0),
      policy: {
        policyVersion: 'intake-test.retrieval.v9',
        allowedDomains: ['changed.example'],
        maxExternalSourcesByDepth: { light: 7, standard: 7, deep: 7 },
      },
    })
    const replay = await later.ingest(signal())
    assert.equal(triage.calls, 0)
    assert.deepEqual(replay.work, savedWork)
    const reread = store.findIntakeUnit({
      signalId: 'signal-intake-1',
      priorityPolicyVersion: PRIORITY_POLICY_VERSION,
      budgetPolicyVersion: BUDGET_POLICY_VERSION,
    })
    assert.ok(reread)
    assert.deepEqual(reread.disposition, savedDisposition.disposition)
    assert.equal(reread.disposition?.retrievalPolicyVersion, retrievalPolicy.policyVersion)
    assert.equal(replay.work?.retrievalPlan.allowedDomains.join(','), 'example.com')
  } finally {
    store.close(); rmSync(temp.dir, { recursive: true, force: true })
  }
})

test('an observe decision is never promoted into work by a later active delivery', async () => {
  const temp = fixture('observe-to-active')
  const store = new SqliteSignalPlatformStore(temp.path, 'news')
  try {
    const { intake: observed } = makeIntake(store, { mode: 'observe' })
    const observation = await observed.ingest(signal())
    assert.equal(observation.decisionInserted, true)
    assert.equal(observation.workInserted, false)
    assert.equal(observation.held, null)

    const { intake: activated, triage } = makeIntake(store, { mode: 'active' })
    const activation = await activated.ingest(signal())
    assert.equal(triage.calls, 0, 'the saved observe decision is reused, not re-triaged')
    assert.equal(activation.workInserted, false)
    assert.equal(activation.work, null)
    assert.equal(store.listResearchWorkBySignal('signal-intake-1', 10).length, 0)
    const saved = store.findIntakeUnit({ signalId: 'signal-intake-1' })
    assert.ok(saved)
    assert.equal(saved.disposition?.authorization, 'observe_evaluation')
    assert.equal(saved.disposition?.mode, 'observe')
  } finally {
    store.close(); rmSync(temp.dir, { recursive: true, force: true })
  }
})

test('legacy research decisions without an admission disposition are held, not guessed', async () => {
  const temp = fixture('ambiguous')
  const store = new SqliteSignalPlatformStore(temp.path, 'news')
  try {
    const { intake } = makeIntake(store)
    const item = signal()
    store.appendSignal(item)
    const engine = new RulesFirstTriageEngine({
      policy: createPriorityPolicyV1({
        policyVersion: PRIORITY_POLICY_VERSION,
        budgetPolicyVersion: BUDGET_POLICY_VERSION,
      }),
    })
    const legacyDecision = await engine.decide(triageInput(item))
    // A pre-disposition store wrote the decision only.
    store.appendTriageDecision(legacyDecision)

    const report = await intake.repairAdmissions(10)
    assert.deepEqual(report.repairedWorkIds, [])
    assert.equal(report.held.length, 1)
    assert.equal(report.held[0]?.decisionId, legacyDecision.decisionId)
    assert.equal(store.listResearchWorkBySignal('signal-intake-1', 10).length, 0)
  } finally {
    store.close(); rmSync(temp.dir, { recursive: true, force: true })
  }
})

test('repair and re-delivery never reset advanced work state, attempts, or a lease', async () => {
  const temp = fixture('advanced')
  const store = new SqliteSignalPlatformStore(temp.path, 'news')
  try {
    const { intake } = makeIntake(store)
    const admitted = await intake.ingest(signal())
    const workId = admitted.work!.workId
    assert.ok(await store.claimWithLease({
      workId, expectedStatus: 'research_pending', leaseOwner: 'worker',
      leaseId: 'lease-1', leaseExpiresAt: '2026-08-26T12:05:00.000Z', now: NOW,
    }))
    assert.equal(await store.beginAttempt({
      workId, expectedStatus: 'retrieval_leased', leaseOwner: 'worker',
      leaseId: 'lease-1', now: '2026-08-26T12:00:10.000Z',
    }), true)
    assert.equal(await store.transitionLeased({
      workId, expectedStatus: 'retrieval_leased', leaseOwner: 'worker', leaseId: 'lease-1',
      nextStatus: 'synthesis_pending', attemptDelta: 0, now: '2026-08-26T12:00:30.000Z',
    }), true)

    const advanced = store.getResearchWork(workId)!
    assert.equal(advanced.status, 'synthesis_pending')
    assert.equal(advanced.attemptCount, 1)

    const replay = await intake.ingest(signal())
    assert.deepEqual(replay.work, advanced, 're-delivery returns the advanced row unchanged')

    const report = await intake.repairAdmissions(10)
    assert.deepEqual(report.repairedWorkIds, [])
    assert.deepEqual(report.alreadyPresentWorkIds, [])
    assert.deepEqual(store.getResearchWork(workId), advanced)
  } finally {
    store.close(); rmSync(temp.dir, { recursive: true, force: true })
  }
})

test('conflicting admission identity and tampered payloads fail closed', async () => {
  const temp = fixture('conflict')
  const store = new SqliteSignalPlatformStore(temp.path, 'news')
  try {
    const { intake } = makeIntake(store)
    const result = await intake.ingest(signal())
    const saved = store.findIntakeUnit({ signalId: 'signal-intake-1' })
    assert.ok(saved)
    const decision = saved.decision
    const disposition = saved.disposition!

    assert.throws(() => store.appendIntakeUnit({
      decision,
      disposition: { ...disposition, reason: 'A different reason under the same identity.' },
      work: disposition.workPayload,
    }), ImmutableRecordConflictError)

    assert.throws(() => store.appendIntakeUnit({
      decision,
      disposition: { ...disposition, workPayloadDigest: '0'.repeat(64) },
      work: disposition.workPayload,
    }), /workPayloadDigest/)

    // A disposition that claims a different signal than the work it froze.
    const otherSignal = signal({ signalId: 'signal-intake-2', idempotencyKey: 'intake-key-2' })
    store.appendSignal(otherSignal)
    assert.throws(() => store.appendIntakeUnit({
      decision,
      disposition: { ...disposition, signalId: otherSignal.signalId },
      work: disposition.workPayload,
    }), /must match the disposition signal and work identity/)

    // A disposition whose decision identity disagrees with the decision it accompanies.
    const otherDecision = { ...decision, decisionId: 'triage_not_this_one' }
    assert.throws(() => store.appendIntakeUnit({
      decision: otherDecision,
      disposition,
      work: disposition.workPayload,
    }), /does not match its decision identity/)

    // A disposition that demands work the unit does not carry.
    assert.throws(() => store.appendIntakeUnit({
      decision,
      disposition,
      work: null,
    }), /disagree about admission/)

    // Work that is not byte-identical to the frozen disposition payload.
    const frozen = disposition.workPayload!
    assert.throws(() => store.appendIntakeUnit({
      decision,
      disposition,
      work: { ...frozen, retrievalPlan: { ...frozen.retrievalPlan, maxExternalSources: 99 } },
    }), /exactly match the frozen active-admission payload/)

    // An identical replay is accepted without rewriting anything.
    const replay = store.appendIntakeUnit({ decision, disposition, work: disposition.workPayload })
    assert.equal(replay.decision.inserted, false)
    assert.equal(replay.disposition.inserted, false)
    assert.equal(replay.work?.inserted, false)

    const mismatchedWork = createResearchWorkItemFromDecision({
      signal: signal(),
      decision,
      retrievalPolicy,
    })
    assert.throws(() => createActiveIntakeDisposition({
      signal: signal(),
      decision,
      work: { ...mismatchedWork, workId: 'work-other' },
      retrievalPolicy,
      recordedAt: NOW,
    }), /derived from this decision/)
    assert.equal(result.workInserted, true)
  } finally {
    store.close(); rmSync(temp.dir, { recursive: true, force: true })
  }
})

test('observe, defer, and archive keep their no-work semantics on a real store', async () => {
  const temp = fixture('no-work')
  const store = new SqliteSignalPlatformStore(temp.path, 'news')
  try {
    const { intake: observed } = makeIntake(store, { mode: 'observe' })
    await observed.ingest(signal())
    assert.equal((await store.getSchedulerStatus({ now: NOW })).total, 0)

    const archiveItem = signal({ signalId: 'signal-archive', idempotencyKey: 'intake-key-archive' })
    const { intake: archiving } = makeIntake(store, {
      mode: 'active',
      triage: {
        calls: 0,
        async decide() {
          return new RulesFirstTriageEngine({
            policy: createPriorityPolicyV1({
              policyVersion: PRIORITY_POLICY_VERSION,
              budgetPolicyVersion: BUDGET_POLICY_VERSION,
            }),
          }).decide(triageInput(archiveItem, { dedupeOutcome: 'exact_duplicate' }))
        },
      },
    })
    const archived = await archiving.ingest(archiveItem)
    assert.equal(archived.decision?.outcome, 'archive')
    assert.equal(archived.workInserted, false)
    const archiveUnit = store.findIntakeUnit({ signalId: 'signal-archive' })
    assert.ok(archiveUnit)
    assert.equal(archiveUnit.disposition?.authorization, 'no_work_outcome')
    assert.equal(archiveUnit.disposition?.requiresWork, false)

    const deferItem = signal({ signalId: 'signal-defer', idempotencyKey: 'intake-key-defer' })
    const { intake: deferring } = makeIntake(store, {
      mode: 'active',
      capacity: () => openCapacity(0),
      clock: () => NOW,
    })
    const deferred = await deferring.ingest(deferItem)
    assert.equal(deferred.decision?.outcome, 'defer')
    assert.equal(deferred.workInserted, false)
    const deferUnit = store.findIntakeUnit({ signalId: 'signal-defer' })
    assert.ok(deferUnit)
    assert.equal(deferUnit.disposition?.authorization, 'no_work_outcome')
    assert.equal((await store.getSchedulerStatus({ now: NOW })).total, 0)
  } finally {
    store.close(); rmSync(temp.dir, { recursive: true, force: true })
  }
})

test('a failing repair reports a redacted code and never breaks source collection', async () => {
  const temp = fixture('cycle-repair-failure')
  const store = new SqliteSignalPlatformStore(temp.path, 'news')
  try {
    const { intake } = makeIntake(store)
    const owed = (await intake.ingest(signal())).work!
    deleteWorkRow(temp.path, owed.workId)
    const block = new DatabaseSync(temp.path)
    try {
      // Break repair below the store surface; the observation boundary still works.
      block.exec(`
        CREATE TRIGGER block_repair BEFORE INSERT ON signal_platform_research_work
        BEGIN SELECT RAISE(ABORT, 'SUPABASE_SERVICE_ROLE_KEY=never-report raw secret'); END;
      `)
      const laterItem = signal({ signalId: 'signal-intake-later', idempotencyKey: 'intake-key-later' })
      const report = await deliverCanonicalSignals(intake, [laterItem])
      assert.equal(report.repairFailure?.code, 'CANONICAL_ADMISSION_REPAIR_FAILED')
      assert.deepEqual(report.repairedWorkIds, [])
      assert.doesNotMatch(JSON.stringify(report), /SUPABASE_SERVICE_ROLE_KEY|never-report|raw secret/)
      // The owed work stays owed, and source collection kept working.
      assert.equal(store.getResearchWork(owed.workId), null)
      assert.ok(store.getSignal('signal-intake-later'))
      block.exec('DROP TRIGGER block_repair')
    } finally {
      block.close()
    }
  } finally {
    store.close(); rmSync(temp.dir, { recursive: true, force: true })
  }
})

test('the bounded delivery cycle repairs only a proven disposition and holds ambiguous rows', async () => {
  const temp = fixture('cycle-repair')
  const store = new SqliteSignalPlatformStore(temp.path, 'news')
  try {
    // One signal admits real work; its work row is then lost to a crash.
    const { intake } = makeIntake(store)
    const owed = (await intake.ingest(signal())).work!
    deleteWorkRow(temp.path, owed.workId)

    // A second signal has a legacy research decision with no disposition at all.
    const legacyItem = signal({ signalId: 'signal-intake-legacy', idempotencyKey: 'intake-key-legacy' })
    store.appendSignal(legacyItem)
    const legacyDecision = await new RulesFirstTriageEngine({
      policy: createPriorityPolicyV1({
        policyVersion: PRIORITY_POLICY_VERSION,
        budgetPolicyVersion: BUDGET_POLICY_VERSION,
      }),
    }).decide(triageInput(legacyItem))
    store.appendTriageDecision(legacyDecision)

    // A third signal is a deferred decision that must not be woken.
    const deferredItem = signal({ signalId: 'signal-intake-deferred', idempotencyKey: 'intake-key-deferred' })
    const { intake: deferring } = makeIntake(store, { capacity: () => openCapacity(0) })
    await deferring.ingest(deferredItem)

    const { intake: cycling, triage } = makeIntake(store, {
      clock: () => '2026-09-30T23:59:59.000Z',
      capacity: () => openCapacity(0),
      policy: {
        policyVersion: 'intake-test.retrieval.v2',
        allowedDomains: ['changed.example'],
        maxExternalSourcesByDepth: { light: 9, standard: 9, deep: 9 },
      },
    })
    const report = await deliverCanonicalSignals(cycling, [])

    assert.equal(triage.calls, 0, 'the cycle must not rerun triage for saved rows')
    assert.deepEqual(report.repairedWorkIds, [owed.workId])
    assert.deepEqual(report.alreadyPresentWorkIds, [])
    assert.deepEqual(report.heldAdmissions.map((item) => item.decisionId), [legacyDecision.decisionId])
    assert.equal(report.repairFailure, null)
    assert.equal(report.failures.length, 0)

    // Repaired from the frozen payload, not from today's policy or capacity.
    assert.deepEqual(store.getResearchWork(owed.workId), owed)
    // The deferred signal stays deferred and unscheduled.
    assert.equal(store.listResearchWorkBySignal(deferredItem.signalId, 10).length, 0)
    // Only the proven admission became a queue row.
    assert.equal((await store.getSchedulerStatus({ now: '2026-09-30T23:59:59.000Z' })).total, 1)

    // A second cycle has nothing left to repair and holds the same legacy row.
    const repeat = await deliverCanonicalSignals(cycling, [])
    assert.deepEqual(repeat.repairedWorkIds, [])
    assert.deepEqual(repeat.heldAdmissions.map((item) => item.decisionId), [legacyDecision.decisionId])
    assert.equal((await store.getSchedulerStatus({ now: '2026-09-30T23:59:59.000Z' })).total, 1)
  } finally {
    store.close(); rmSync(temp.dir, { recursive: true, force: true })
  }
})

test('observe and off modes never repair or touch the queue during the cycle', async () => {
  const temp = fixture('cycle-modes')
  const store = new SqliteSignalPlatformStore(temp.path, 'news')
  try {
    const { intake } = makeIntake(store)
    const admitted = (await intake.ingest(signal())).work!
    deleteWorkRow(temp.path, admitted.workId)

    const { intake: observing } = makeIntake(store, { mode: 'observe' })
    const observed = await deliverCanonicalSignals(observing, [])
    assert.deepEqual(observed.repairedWorkIds, [])
    assert.deepEqual(observed.alreadyPresentWorkIds, [])
    assert.equal(observed.repairFailure, null)
    assert.equal(store.getResearchWork(admitted.workId), null, 'observe must not repair owed work')

    const off = await deliverCanonicalSignals(undefined, [])
    assert.deepEqual(off.repairedWorkIds, [])
    assert.equal(off.mode, 'off')
  } finally {
    store.close(); rmSync(temp.dir, { recursive: true, force: true })
  }
})

test('a research outcome cannot be recorded as a deliberate no-work result', async () => {
  const temp = fixture('outcome-consistency')
  const store = new SqliteSignalPlatformStore(temp.path, 'news')
  try {
    const { intake } = makeIntake(store)
    const admitted = await intake.ingest(signal())
    const saved = store.findIntakeUnit({ signalId: 'signal-intake-1' })
    assert.ok(saved)
    const decision = saved.decision
    const active = saved.disposition!
    assert.equal(decision.outcome, 'standard')

    // Downgrading a research outcome to a deliberate no-work record fails closed.
    assert.throws(() => store.appendIntakeUnit({
      decision,
      disposition: createNoAdmissionDisposition({
        signal: signal(),
        decision,
        mode: 'active',
        authorization: 'no_work_outcome',
        reason: 'Downgraded on purpose.',
        recordedAt: NOW,
      }),
      work: null,
    }), /cannot be recorded as a deliberate no-work result/)

    // A disposition identity that is not stable for its decision and mode fails closed.
    assert.throws(() => store.appendIntakeUnit({
      decision,
      disposition: { ...active, dispositionId: 'admission_forged_identity' },
      work: active.workPayload,
    }), /must be stable for its decision and intake mode/)

    // And an archive/defer decision cannot claim a required work admission.
    const archiveItem = signal({ signalId: 'signal-intake-archive', idempotencyKey: 'intake-key-archive' })
    store.appendSignal(archiveItem)
    const archiveDecision = await new RulesFirstTriageEngine({
      policy: createPriorityPolicyV1({
        policyVersion: PRIORITY_POLICY_VERSION,
        budgetPolicyVersion: BUDGET_POLICY_VERSION,
      }),
    }).decide(triageInput(archiveItem, { dedupeOutcome: 'exact_duplicate' }))
    assert.equal(archiveDecision.outcome, 'archive')
    const forgedWork = createResearchWorkItemFromDecision({
      signal: signal(),
      decision,
      retrievalPolicy,
    })
    assert.throws(() => store.appendIntakeUnit({
      decision: archiveDecision,
      disposition: createActiveIntakeDisposition({
        signal: archiveItem,
        decision: archiveDecision,
        work: forgedWork,
        retrievalPolicy,
        recordedAt: NOW,
      }),
      work: forgedWork,
    }), /derived from this decision/)
    assert.equal(admitted.workInserted, true)
  } finally {
    store.close(); rmSync(temp.dir, { recursive: true, force: true })
  }
})

test('a storage failure during re-entry lookup propagates instead of reading as absence', async () => {
  const temp = fixture('lookup-error')
  const store = new SqliteSignalPlatformStore(temp.path, 'news')
  const closing = new SqliteSignalPlatformStore(temp.path, 'news')
  try {
    const { intake } = makeIntake(store)
    await intake.ingest(signal())
    // A closed store must surface its own error, not "no saved decision".
    store.close()
    await assert.rejects(intake.ingest(signal()), /SqliteSignalPlatformStore is closed/)
  } finally {
    try { store.close() } catch { /* already closed */ }
    closing.close(); rmSync(temp.dir, { recursive: true, force: true })
  }
})
