import assert from 'node:assert/strict'
import test from 'node:test'
import { extractJson } from './json'

test('extractJson parses a plain JSON object', () => {
  assert.deepEqual(extractJson<{ a: number }>('{"a": 1}'), { a: 1 })
})

test('extractJson parses a fenced ```json block', () => {
  const text = '```json\n{"decision": "publish"}\n```'
  assert.deepEqual(extractJson<{ decision: string }>(text), { decision: 'publish' })
})

test('extractJson parses a fence with no language tag', () => {
  assert.deepEqual(extractJson<{ a: boolean }>('```\n{"a": true}\n```'), { a: true })
})

test('extractJson extracts the first JSON object embedded in prose', () => {
  const text = 'Here is my answer:\n{"verdict": "known", "reason": "covered"}\nHope that helps!'
  assert.deepEqual(extractJson<{ verdict: string }>(text), { verdict: 'known', reason: 'covered' })
})

test('extractJson extracts a JSON array embedded in prose', () => {
  assert.deepEqual(extractJson<number[]>('results: [1, 2, 3] end'), [1, 2, 3])
})

test('extractJson survives braces and escaped quotes inside strings', () => {
  const text = 'note {"text": "a \\"quoted\\" brace } inside", "n": 2} tail'
  assert.deepEqual(extractJson<{ text: string, n: number }>(text), { text: 'a "quoted" brace } inside', n: 2 })
})

test('extractJson returns null when no JSON is present', () => {
  assert.equal(extractJson('no structured output here'), null)
})

test('extractJson returns null for a truncated object', () => {
  assert.equal(extractJson('{"a": 1, "b": '), null)
})
