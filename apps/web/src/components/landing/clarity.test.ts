import { test } from 'node:test'
import assert from 'node:assert/strict'
import { TICK_MS, nextTick, STRIP_STEPS, TILE_DEFS, TIMELINE_STEPS } from './clarity-data'

test('tick cycles 0 → 1 → 2 → 0 on a 1.6s cadence', () => {
  assert.equal(TICK_MS, 1600)
  assert.deepEqual([0, 1, 2].map(nextTick), [1, 2, 0])
})

test('strip: three phones in Read → Pick → Act order with real screenshots', () => {
  assert.equal(STRIP_STEPS.length, 3)
  assert.deepEqual(STRIP_STEPS.map((p) => p.cap), ['Read', 'Pick', 'Act'])
  for (const p of STRIP_STEPS) {
    assert.ok(p.img.startsWith('/landing/'), p.img)
    assert.ok(p.img.endsWith('-phone.png'), p.img)
    assert.ok(p.w > 0 && p.h > 0)
  }
})

test('tiles: Polymarket, Pacifica, Phoenix, Meteora with a kind and a viz', () => {
  assert.deepEqual(TILE_DEFS.map((t) => t.name), ['Polymarket', 'Pacifica', 'Phoenix', 'Meteora'])
  assert.deepEqual(TILE_DEFS.map((t) => t.kind), ['Polymarket', 'Perps', 'Spot', 'Earn'])
  for (const t of TILE_DEFS) {
    assert.ok(t.logo.startsWith('/landing/logo-'), t.logo)
    assert.ok(['odds', 'perps', 'spot', 'earn'].includes(t.viz), t.viz)
  }
})

test('timeline: News → Why it moved → Swapped', () => {
  assert.deepEqual(TIMELINE_STEPS.map((x) => x.time), ['09:12', '09:13', '09:14'])
  assert.deepEqual(TIMELINE_STEPS.map((x) => x.label), ['News', 'Why it moved', 'Swapped'])
})
