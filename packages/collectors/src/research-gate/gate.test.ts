import assert from 'node:assert/strict'
import test from 'node:test'
import { HermesService } from '../hermes'
import { ClassificationDoubleFailureError, type ClassificationRequest } from '../inference-gateway'
import { InferenceGatewayError } from '../inference-gateway/errors'
import { gateSignal } from './gate'
import type { EntityMemoryReader, GateEntity, GateMemory, GateNoveltyEvidence, GateSignal } from './types'

const SIGNAL: GateSignal = {
  source: 'polymarket',
  sourceRefId: 'us-recession-by-end-of-2026',
  title: 'US recession by end of 2026?',
  whatChanged: 'Yes odds moved from 41% to 58% in 6 hours.',
  observedAt: '2026-07-30T10:00:00.000Z',
}

const ENTITY: GateEntity = {
  id: 'entity-1',
  slug: 'us-recession-2026',
  name: 'US recession 2026',
  summary: 'Tracks whether the US enters a recession in 2026.',
}

const MEMORY: GateMemory = {
  entityId: 'entity-1',
  memoryType: 'market_signal',
  title: 'Recession odds repricing',
  summary: 'Polymarket odds for a 2026 US recession moved from 30% to 41% after weak jobs data.',
  eventAt: '2026-07-28T00:00:00.000Z',
}

function reader(overrides: Partial<EntityMemoryReader> = {}): EntityMemoryReader {
  return {
    entityIdsForSourceRef: async () => ['entity-1'],
    entitiesByIds: async () => [ENTITY],
    recentMemories: async () => [MEMORY],
    ...overrides,
  }
}

/** HermesService whose oneshot returns canned stdout; records prompts. */
function fakeHermes(stdout: string | Error) {
  const prompts: string[] = []
  const service = new HermesService({
    command: 'hermes',
    execFileImpl: async (_command, args) => {
      prompts.push(args[args.length - 1])
      if (stdout instanceof Error) throw stdout
      return { stdout, stderr: '' }
    },
  })
  return { prompts, service }
}

test('returns no_prior_entity without calling hermes when no entity has filed under this source ref', async () => {
  const { prompts, service } = fakeHermes('{"verdict":"already_known","reason":"should never be called"}')
  const decision = await gateSignal(SIGNAL, {
    hermes: service,
    reader: reader({ entityIdsForSourceRef: async () => [] }),
  })

  assert.equal(decision.verdict, 'no_prior_entity')
  assert.equal(decision.proceed, true)
  assert.equal(decision.entityContext, null)
  assert.equal(prompts.length, 0)
})

test('returns already_known with proceed=false when the model says the timeline covers the signal', async () => {
  const { service } = fakeHermes('{"verdict":"already_known","reason":"Timeline already records the move to 58%."}')
  const decision = await gateSignal(SIGNAL, { hermes: service, reader: reader() })

  assert.equal(decision.verdict, 'already_known')
  assert.equal(decision.proceed, false)
  assert.deepEqual(decision.entityIds, ['entity-1'])
  assert.equal(decision.memoriesConsulted, 1)
  assert.equal(decision.reason, 'Timeline already records the move to 58%.')
})

test('returns new_information with the entity timeline attached as research context', async () => {
  const { service } = fakeHermes('{"verdict":"new_information","reason":"The timeline stops at 41%."}')
  const decision = await gateSignal(SIGNAL, { hermes: service, reader: reader() })

  assert.equal(decision.verdict, 'new_information')
  assert.equal(decision.proceed, true)
  assert.ok(decision.entityContext)
  assert.deepEqual(decision.entityContext?.entities, [ENTITY])
  assert.deepEqual(decision.entityContext?.recentMemories, [MEMORY])
})

test('passes contradicts_prior through as a proceed verdict', async () => {
  const { service } = fakeHermes('{"verdict":"contradicts_prior","reason":"Timeline says odds were falling."}')
  const decision = await gateSignal(SIGNAL, { hermes: service, reader: reader() })

  assert.equal(decision.verdict, 'contradicts_prior')
  assert.equal(decision.proceed, true)
})

test('skips the hermes call and proceeds when entities exist but the timeline is empty', async () => {
  const { prompts, service } = fakeHermes('{"verdict":"already_known","reason":"should never be called"}')
  const decision = await gateSignal(SIGNAL, {
    hermes: service,
    reader: reader({ recentMemories: async () => [] }),
  })

  assert.equal(decision.verdict, 'new_information')
  assert.equal(decision.proceed, true)
  assert.equal(prompts.length, 0)
  assert.deepEqual(decision.entityContext?.entities, [ENTITY])
})

test('fails OPEN when the hermes call throws: gate_unavailable still proceeds to research', async () => {
  const { service } = fakeHermes(new Error('spawn hermes ENOENT'))
  const decision = await gateSignal(SIGNAL, { hermes: service, reader: reader() })

  assert.equal(decision.verdict, 'gate_unavailable')
  assert.equal(decision.proceed, true)
  assert.match(decision.reason, /ENOENT/)
  assert.ok(decision.entityContext, 'timeline context is still attached so research can use it')
})

test('fails OPEN when the model returns no parseable JSON', async () => {
  const { service } = fakeHermes('I think this is probably new information.')
  const decision = await gateSignal(SIGNAL, { hermes: service, reader: reader() })

  assert.equal(decision.verdict, 'gate_unavailable')
  assert.equal(decision.proceed, true)
})

test('fails OPEN when the model invents a verdict outside the contract', async () => {
  const { service } = fakeHermes('{"verdict":"probably_fine","reason":"?"}')
  const decision = await gateSignal(SIGNAL, { hermes: service, reader: reader() })

  assert.equal(decision.verdict, 'gate_unavailable')
  assert.equal(decision.proceed, true)
})

test('fails OPEN when the entity reader itself fails', async () => {
  const { service } = fakeHermes('{"verdict":"already_known","reason":"unused"}')
  const decision = await gateSignal(SIGNAL, {
    hermes: service,
    reader: reader({ entityIdsForSourceRef: async () => { throw new Error('supabase down') } }),
  })

  assert.equal(decision.verdict, 'gate_unavailable')
  assert.equal(decision.proceed, true)
  assert.match(decision.reason, /supabase down/)
})

test('the gate prompt shows the timeline and forbids significance judgment', async () => {
  const { prompts, service } = fakeHermes('{"verdict":"new_information","reason":"ok"}')
  await gateSignal(SIGNAL, { hermes: service, reader: reader() })

  assert.equal(prompts.length, 1)
  const prompt = prompts[0]
  assert.match(prompt, /Recession odds repricing/, 'timeline memory titles are shown to the model')
  assert.match(prompt, /41% to 58%/, 'the new signal is shown to the model')
  assert.match(prompt, /Do NOT judge importance/, 'role boundary: novelty only, never significance')
  assert.match(prompt, /already_known/, 'verdict vocabulary is defined in the prompt')
})

test('uses the shared classification contract and records the downstream policy outcome', async () => {
  const requests: unknown[] = []
  const outcomes: unknown[] = []
  const decision = await gateSignal(SIGNAL, {
    reader: reader(),
    classification: {
      async classify<TDecision>(request: ClassificationRequest) {
        requests.push(request)
        return {
          decisionId: 'classification-1', workload: request.workload, decisionVersion: request.decisionVersion,
          value: { verdict: 'already_known' as const, reason: 'The timeline already contains the same repricing.' } as TDecision,
          configuredPrimary: { provider: 'typesafe', model: 'jev-1.13.0' }, configuredFallback: null,
          actualProvider: 'ollama-cloud', actualModel: 'glm-5.3-flash', fallbackUsed: false,
          fallbackReason: null, answers: null, usage: { inputTokens: 1, outputTokens: 1 }, durationMs: 1,
        }
      },
      async recordPolicyOutcome(value) { outcomes.push(value) },
    },
  })
  assert.equal(decision.verdict, 'already_known')
  assert.equal(decision.proceed, false)
  assert.equal((requests[0] as { workload: string }).workload, 'research.novelty')
  assert.deepEqual(outcomes, [{
    decisionId: 'classification-1', consumer: 'research-gate',
    policyVersion: 'research-gate.novelty-policy.v1', outcome: 'hold', reasonCode: 'already_known',
  }])
})

test('classification double failure records fail-open and never loses the signal', async () => {
  const outcomes: unknown[] = []
  const cause = new InferenceGatewayError('down', { category: 'provider_unavailable', retryable: true })
  const decision = await gateSignal(SIGNAL, {
    reader: reader(),
    classification: {
      async classify() { throw new ClassificationDoubleFailureError('classification-failed', 'provider_timeout', cause) },
      async recordPolicyOutcome(value) { outcomes.push(value) },
    },
  })
  assert.equal(decision.verdict, 'gate_unavailable')
  assert.equal(decision.proceed, true)
  assert.equal((outcomes[0] as { reasonCode: string }).reasonCode, 'classification_double_failure_fail_open')
})

// --- Stage-3 novelty context rules (PRD v4 §5.2): an empty, failed,
// --- truncated, or unrelated novelty lookup can NEVER justify
// --- already_known; the suppression lives in gate.ts finalizeVerdict.

const EVIDENCE: GateNoveltyEvidence = {
  itemRefs: ['item-1', 'item-2'],
  timeCoverage: { oldestEventAt: '2026-07-01T00:00:00.000Z', newestEventAt: '2026-07-29T00:00:00.000Z' },
  digest: 'ev-digest-1',
  failures: [],
}

/** Legacy reader plus the optional stage-3 richer evidence lookup. */
function readerWithEvidence(evidence: GateNoveltyEvidence): EntityMemoryReader {
  return { ...reader(), noveltyEvidence: async () => evidence }
}

test('an evidence lookup that returned no references can never justify already_known', async () => {
  const { service } = fakeHermes('{"verdict":"already_known","reason":"Timeline already records it."}')
  const decision = await gateSignal(SIGNAL, {
    hermes: service,
    reader: readerWithEvidence({ ...EVIDENCE, itemRefs: [], digest: 'ev-empty' }),
  })

  assert.equal(decision.proceed, true, 'suppression: an empty lookup cannot drop the signal')
  assert.match(decision.reason, /Suppressed already_known/)
  assert.match(decision.reason, /no related references/)
  assert.equal(decision.noveltyContext?.evidenceRan, true)
})

test('a truncated evidence lookup can never justify already_known', async () => {
  const { service } = fakeHermes('{"verdict":"already_known","reason":"Timeline already records it."}')
  const decision = await gateSignal(SIGNAL, {
    hermes: service,
    reader: readerWithEvidence({ ...EVIDENCE, itemRefs: ['item-1'], truncated: true, digest: 'ev-trunc' }),
  })

  assert.equal(decision.proceed, true, 'the unseen body may hold new information')
  assert.match(decision.reason, /truncated/)
  assert.equal(decision.noveltyContext?.truncated, true)
})

test('a failed evidence lookup is recorded and never justifies already_known (nor fails the gate)', async () => {
  const { service } = fakeHermes('{"verdict":"already_known","reason":"Timeline already records it."}')
  const decision = await gateSignal(SIGNAL, {
    hermes: service,
    reader: { ...reader(), noveltyEvidence: async () => { throw new Error('evidence db down') } },
  })

  assert.equal(decision.verdict, 'new_information')
  assert.equal(decision.proceed, true)
  assert.match(decision.reason, /Suppressed already_known/)
  assert.match(decision.reason, /evidence db down/)
  assert.equal(decision.noveltyContext?.lookupFailures.length, 1)
  assert.match(decision.noveltyContext?.digest ?? '', /^sha256:/, 'base digest still present')
})

test('an unrelated evidence lookup can never justify already_known', async () => {
  const { service } = fakeHermes('{"verdict":"already_known","reason":"Timeline already records it."}')
  const decision = await gateSignal(SIGNAL, {
    hermes: service,
    reader: readerWithEvidence({ ...EVIDENCE, itemRefs: ['elsewhere-1'], unrelated: true, digest: 'ev-unrel' }),
  })

  assert.equal(decision.proceed, true)
  assert.match(decision.reason, /different subject/)
  assert.equal(decision.noveltyContext?.unrelated, true)
})

test('recorded lookup failures suppress already_known even when references are present', async () => {
  const { service } = fakeHermes('{"verdict":"already_known","reason":"Timeline already records it."}')
  const decision = await gateSignal(SIGNAL, {
    hermes: service,
    reader: readerWithEvidence({ ...EVIDENCE, itemRefs: ['item-1'], failures: ['evidence search timed out'], digest: 'ev-fail' }),
  })

  assert.equal(decision.proceed, true)
  assert.match(decision.reason, /evidence search timed out/)
  assert.deepEqual(decision.noveltyContext?.lookupFailures, ['evidence search timed out'])
})

test('legacy shape: a reader without the evidence port keeps the plain already_known verdict', async () => {
  const { service } = fakeHermes('{"verdict":"already_known","reason":"Timeline already records it."}')
  const decision = await gateSignal(SIGNAL, { hermes: service, reader: reader() })

  assert.equal(decision.verdict, 'already_known', 'suppression must not fire for a complete basic comparison')
  assert.equal(decision.proceed, false)
  assert.equal(decision.noveltyContext?.evidenceRan, false, 'record rests on the basic timeline lookups only')
  assert.equal(decision.noveltyContext?.truncated, false)
  assert.deepEqual(decision.noveltyContext?.lookupFailures, [])
})

test('no novelty record attaches when no comparison completed (short-circuit paths)', async () => {
  const { service } = fakeHermes('{"verdict":"already_known","reason":"would never be called"}')

  const unknownSubject = await gateSignal(SIGNAL, {
    hermes: service,
    reader: reader({ entityIdsForSourceRef: async () => [] }),
  })
  assert.ok(!('noveltyContext' in unknownSubject), 'no entities: no comparison ran')

  const emptyTimeline = await gateSignal(SIGNAL, {
    hermes: service,
    reader: reader({ recentMemories: async () => [] }),
  })
  assert.ok(!('noveltyContext' in emptyTimeline), 'empty timeline: no comparison ran')
})

test('a complete evidence lookup still lets already_known hold and attaches the bounded record', async () => {
  const { service } = fakeHermes('{"verdict":"already_known","reason":"Timeline already records it."}')
  const decision = await gateSignal(SIGNAL, { hermes: service, reader: readerWithEvidence(EVIDENCE) })

  assert.equal(decision.verdict, 'already_known', 'suppression is bounded: complete evidence does not fire')
  assert.equal(decision.proceed, false)
  assert.deepEqual(decision.noveltyContext?.resolvedCandidateRefs, ['entity-1'])
  assert.deepEqual(decision.noveltyContext?.itemRefs, ['item-1', 'item-2'])
  assert.deepEqual(decision.noveltyContext?.timeCoverage, {
    oldestEventAt: '2026-07-01T00:00:00.000Z',
    newestEventAt: '2026-07-29T00:00:00.000Z',
  })
  assert.equal(decision.noveltyContext?.truncated, false)
  assert.equal(decision.noveltyContext?.unrelated, false)
  assert.deepEqual(decision.noveltyContext?.lookupFailures, [])
  assert.match(decision.noveltyContext?.digest ?? '', /\+evidence:ev-digest-1$/, 'digest covers consulted content')
})

test('noveltyContext is attached to proceed verdicts too, for downstream reporting', async () => {
  const { service } = fakeHermes('{"verdict":"new_information","reason":"The timeline stops at 41%."}')
  const decision = await gateSignal(SIGNAL, { hermes: service, reader: readerWithEvidence(EVIDENCE) })

  assert.equal(decision.verdict, 'new_information')
  assert.equal(decision.proceed, true)
  assert.ok(decision.noveltyContext)
  assert.equal(decision.noveltyContext?.evidenceRan, true)
})

test('a timeline lookup that hit its limit counts as truncated (no evidence port needed)', async () => {
  const { service } = fakeHermes('{"verdict":"already_known","reason":"Timeline already records it."}')
  const fullTimeline = Array.from({ length: 12 }, (_, i) => ({ ...MEMORY, title: `Repricing ${i}` }))
  const decision = await gateSignal(SIGNAL, {
    hermes: service,
    reader: reader({ recentMemories: async () => fullTimeline }),
  })

  assert.equal(decision.proceed, true, 'a bounded timeline cannot prove everything was seen')
  assert.match(decision.reason, /truncated/)
  assert.equal(decision.noveltyContext?.truncated, true)
  assert.equal(decision.noveltyContext?.evidenceRan, false, 'basic lookups still build a record')
})
