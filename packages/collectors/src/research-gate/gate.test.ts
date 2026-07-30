import assert from 'node:assert/strict'
import test from 'node:test'
import { HermesService } from '../hermes'
import { gateSignal } from './gate'
import type { EntityMemoryReader, GateEntity, GateMemory, GateSignal } from './types'

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
