import assert from 'node:assert/strict'
import test from 'node:test'
import { EventEmitter } from 'node:events'
import type { ChildProcess } from 'node:child_process'
import { HermesService } from '../hermes'
import { ResearchEngine } from './engine'
import type { ResearchTask } from './types'

const TASK: ResearchTask = {
  taskId: 'polymarket:markets:cand-1',
  source: 'polymarket',
  subject: 'fed-rate-cut',
  title: 'Will the Fed cut rates in September?',
  question: 'What happened after 2026-07-28 that could explain the repricing from 41% to 58%?',
  signal: 'Yes odds moved from 41% to 58% in 6 hours.',
  observedAt: '2026-07-30T10:00:00.000Z',
  known: {
    entities: [{ id: 'e1', slug: 'fed-rate-cut', name: 'Fed rate cut', summary: 'Fed policy tracking.' }],
    recentMemories: [{
      entityId: 'e1',
      memoryType: 'market_signal',
      title: 'Odds at 41% after CPI',
      summary: 'Odds moved to 41% after the June CPI print.',
      eventAt: '2026-07-28T00:00:00.000Z',
    }],
  },
  sourceContext: { market: { yes_price: 0.58 } },
  answerSpec: {
    kind: 'catalyst',
    instruction: 'An answer is a concrete, dated, verifiable catalyst that plausibly explains why traders repriced this market.',
  },
}

class FakeChild extends EventEmitter {
  stdout = new EventEmitter()
  stderr = new EventEmitter()
  kill(): boolean { return true }
}

function engineWith(stdout: string, exitCode = 0): { engine: ResearchEngine, calls: Array<{ command: string, args: string[] }> } {
  const calls: Array<{ command: string, args: string[] }> = []
  const service = new HermesService({
    command: 'hermes',
    spawnImpl: (command, args) => {
      calls.push({ command, args })
      const child = new FakeChild()
      setImmediate(() => {
        if (stdout) child.stdout.emit('data', Buffer.from(stdout))
        child.emit('close', exitCode)
      })
      return child as unknown as ChildProcess
    },
  })
  return { engine: new ResearchEngine({ hermes: service }), calls }
}

const ANSWERED = JSON.stringify({
  outcome: 'answered',
  summary: 'Powell signaled a September cut at the July 29 press conference.',
  what_changed: 'A concrete dovish signal arrived after the timeline\'s last entry.',
  verified_facts: [{
    fact: 'On July 29 Powell said rate cuts are on the table for September.',
    evidence: [{ url: 'https://example.com/fed', title: 'Fed press conference transcript' }],
  }],
  unverified_claims: ['Some traders expect 50bps.'],
  checked: ['fed.gov press releases', 'major wire coverage'],
  open_questions: [],
  evidence_links: [{ url: 'https://example.com/fed', title: 'Fed press conference transcript', note: 'primary source' }],
})

test('runs in chat mode with browser/web toolsets so the model can actually read pages', async () => {
  const { engine, calls } = engineWith(ANSWERED)
  await engine.research(TASK)

  assert.equal(calls.length, 1)
  assert.equal(calls[0].args[0], 'chat')
  const toolsetsIndex = calls[0].args.indexOf('--toolsets')
  assert.ok(toolsetsIndex > 0)
  assert.equal(calls[0].args[toolsetsIndex + 1], 'browser,web')
})

test('the prompt carries the question, the timeline, the answer spec, and permission to conclude nothing', async () => {
  const { engine, calls } = engineWith(ANSWERED)
  await engine.research(TASK)

  const prompt = calls[0].args[calls[0].args.length - 1]
  assert.match(prompt, /What happened after 2026-07-28/)
  assert.match(prompt, /Odds at 41% after CPI/, 'timeline entries shown')
  assert.match(prompt, /concrete, dated, verifiable catalyst/, 'answer spec inlined')
  assert.match(prompt, /GOOD outcome to conclude nothing happened/i, 'nothing_found is legitimized')
  assert.match(prompt, /read the page/i, 'snippet-is-not-verification rule')
})

test('parses an answered conclusion with verified facts and evidence', async () => {
  const { engine } = engineWith(ANSWERED)
  const conclusion = await engine.research(TASK)

  assert.equal(conclusion.outcome, 'answered')
  assert.equal(conclusion.verifiedFacts.length, 1)
  assert.equal(conclusion.verifiedFacts[0].evidence[0].url, 'https://example.com/fed')
  assert.match(conclusion.whatChanged, /dovish signal/)
  assert.equal(conclusion.taskId, TASK.taskId)
})

test('nothing_found with a checked list is a first-class outcome', async () => {
  const { engine } = engineWith(JSON.stringify({
    outcome: 'nothing_found',
    summary: 'No catalyst found.',
    what_changed: 'Nothing new relative to the timeline.',
    verified_facts: [],
    unverified_claims: [],
    checked: ['fed.gov', 'reuters.com', 'reddit r/economics'],
    open_questions: [],
    evidence_links: [],
  }))
  const conclusion = await engine.research(TASK)

  assert.equal(conclusion.outcome, 'nothing_found')
  assert.deepEqual(conclusion.checked, ['fed.gov', 'reuters.com', 'reddit r/economics'])
})

test('laziness guardrail: nothing_found without a checked list downgrades to partial', async () => {
  const { engine } = engineWith(JSON.stringify({
    outcome: 'nothing_found',
    summary: 'Nothing.',
    what_changed: '',
    verified_facts: [],
    unverified_claims: [],
    checked: [],
    open_questions: [],
    evidence_links: [],
  }))
  const conclusion = await engine.research(TASK)

  assert.equal(conclusion.outcome, 'partial')
})

test('honesty guardrail: answered without verified facts downgrades to partial', async () => {
  const { engine } = engineWith(JSON.stringify({
    outcome: 'answered',
    summary: 'Probably Powell.',
    what_changed: 'Sentiment shifted.',
    verified_facts: [],
    unverified_claims: ['Powell might have hinted at cuts.'],
    checked: ['twitter'],
    open_questions: [],
    evidence_links: [],
  }))
  const conclusion = await engine.research(TASK)

  assert.equal(conclusion.outcome, 'partial')
})

test('a failed chat run is engine_failed, never a fabricated conclusion', async () => {
  const { engine } = engineWith('', 3)
  const conclusion = await engine.research(TASK)

  assert.equal(conclusion.outcome, 'engine_failed')
  assert.equal(conclusion.verifiedFacts.length, 0)
})

test('unparseable stdout is engine_failed', async () => {
  const { engine } = engineWith('I browsed around and found some stuff about the Fed.')
  const conclusion = await engine.research(TASK)

  assert.equal(conclusion.outcome, 'engine_failed')
})

test('an outcome value outside the contract is engine_failed', async () => {
  const { engine } = engineWith(JSON.stringify({ outcome: 'great_success', summary: 'x' }))
  const conclusion = await engine.research(TASK)

  assert.equal(conclusion.outcome, 'engine_failed')
})
