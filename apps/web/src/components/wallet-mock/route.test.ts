import { test } from 'node:test'
import assert from 'node:assert/strict'
import { check, hop, list, plan, type MoveInput } from './route'
import type { Token } from './data'
import { moveReducer, initialMove } from './moveReducer'

const m = (from: string, to: string, ft: Token = 'USDC', tt: Token = 'USDC', amount = '100'): MoveInput => ({ from, to, ft, tt, amount })

test('Polymarket → Pacifica hops through Solana', () => {
  assert.equal(hop('polymarket', 'pacifica'), 'solana')
  const P = plan(m('polymarket', 'pacifica'))
  assert.deepEqual(P.nodes, ['polymarket', 'solana', 'pacifica'])
  assert.deepEqual(P.steps.map((s) => s.label), ['Withdrawing USDC from Polymarket', 'Bridging to Solana', 'Depositing USDC to Pacifica'])
  assert.equal(P.steps.at(-1)!.node, 2)
})

test('Polymarket USDC → Phoenix SOL adds a swap node and step', () => {
  const P = plan(m('polymarket', 'phoenix', 'USDC', 'SOL'))
  assert.deepEqual(P.nodes, ['polymarket', 'solana', 'swapB', 'phoenix'])
  assert.ok(P.steps.some((s) => s.label === 'Swapping USDC → SOL'))
})

test('app → app on the same chain shows that chain as the hop (as in the reference)', () => {
  assert.equal(hop('phoenix', 'pacifica'), 'solana')
  assert.deepEqual(plan(m('phoenix', 'pacifica')).steps.map((s) => s.label), ['Withdrawing USDC from Phoenix', 'Depositing USDC to Pacifica'])
  assert.equal(hop('solana', 'phoenix'), null)
})

test('chain → chain bridges directly', () => {
  const P = plan(m('solana', 'base'))
  assert.deepEqual(P.nodes, ['solana', 'base'])
  assert.deepEqual(P.steps.map((s) => s.label), ['Bridging to Base'])
})

test('over balance is flagged', () => {
  const c = check(m('pacifica', 'phoenix', 'USDC', 'USDC', '500'))
  assert.equal(c.over, true)
  assert.equal(c.ok, false)
  assert.equal(check(m('pacifica', 'phoenix')).ok, true)
})

test('From list puts funded endpoints first; both lists have both sections', () => {
  const f = list('f').filter((x) => !('grp' in x)).map((x) => ('k' in x ? x.k : ''))
  assert.deepEqual(f.slice(0, 3), ['polymarket', 'phoenix', 'pacifica'])
  assert.equal(list('t').filter((x) => 'grp' in x).length, 2)
})

test('reducer: picking current To as From swaps the pair', () => {
  const s = moveReducer(initialMove(), { type: 'pick', side: 'f', k: 'pacifica' })
  assert.equal(s.from, 'pacifica')
  assert.equal(s.to, 'polymarket')
})

test('reducer: zero-balance From and To = From give notes', () => {
  let s = moveReducer(initialMove(), { type: 'pick', side: 'f', k: 'meteora' })
  assert.equal(s.from, 'polymarket')
  assert.match(s.note.f, /nothing to move/)
  s = moveReducer(initialMove(), { type: 'pick', side: 't', k: 'polymarket' })
  assert.match(s.note.t, /already your From/)
})

test('reducer: token cycles in place and run steps to done then resets', () => {
  let s = moveReducer(initialMove(), { type: 'pick', side: 't', k: 'phoenix' })
  s = moveReducer(s, { type: 'cycleToken', side: 't' })
  assert.equal(s.tt, 'SOL')
  s = moveReducer(s, { type: 'cycleToken', side: 't' })
  assert.equal(s.tt, 'USDC')
  s = moveReducer(s, { type: 'run' })
  assert.equal(s.stage, 'pending')
  const n = plan(s).steps.length
  for (let i = 0; i < n; i++) s = moveReducer(s, { type: 'tick' })
  assert.equal(s.stage, 'success')
  assert.equal(moveReducer(s, { type: 'reset' }).stage, 'ready')
})
