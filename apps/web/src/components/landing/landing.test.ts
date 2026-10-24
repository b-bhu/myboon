import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CONFIRM_AT, initialSlider, sliderReducer, type SliderEvent, type SliderState } from './slider'
import { curve } from './route'
import { appTiles } from './data'

const run = (evs: SliderEvent[], s: SliderState = initialSlider) => evs.reduce(sliderReducer, s)

test('drag past the threshold and release confirms', () => {
  assert.deepEqual(run([{ type: 'drag', p: 0.5 }, { type: 'drag', p: 0.95 }, { type: 'release' }]), { phase: 'done', p: 1 })
})

test('short drag snaps back', () => {
  assert.deepEqual(run([{ type: 'drag', p: CONFIRM_AT - 0.01 }, { type: 'release' }]), initialSlider)
})

test('drag is clamped to the track', () => {
  assert.equal(run([{ type: 'drag', p: 3 }]).p, 1)
  assert.equal(run([{ type: 'drag', p: -1 }]).p, 0)
  assert.equal(run([{ type: 'drag', p: Number.NaN }]).p, 0)
})

test('Enter, Space and ArrowRight confirm; other keys do nothing', () => {
  for (const key of ['Enter', ' ', 'ArrowRight']) assert.equal(run([{ type: 'key', key }]).phase, 'done')
  assert.deepEqual(run([{ type: 'key', key: 'a' }]), initialSlider)
})

test('confirmed state ignores input until reset, then returns to idle', () => {
  const done = run([{ type: 'key', key: 'Enter' }])
  assert.equal(sliderReducer(done, { type: 'drag', p: 0.1 }), done)
  assert.deepEqual(sliderReducer(done, { type: 'reset' }), initialSlider)
})

test('curve passes through every point', () => {
  const d = curve([[0, 0], [100, 50], [200, 50]], 'y')
  assert.match(d, /^M0,0 C0,25 100,25 100,50 L200,50$/)
  assert.equal(curve([], 'x'), '')
})

test('apps: 7 tiles on desktop, 5 on mobile, tilts -18..14, sizes 56..88 desktop, one route node', () => {
  assert.equal(appTiles.length, 7)
  assert.equal(appTiles.filter((a) => a.m).length, 5)
  for (const a of appTiles) {
    assert.ok(a.d.r >= -18 && a.d.r <= 14, a.name)
    assert.ok(a.d.w >= 56 && a.d.w <= 88, a.name)
  }
  assert.equal(appTiles.filter((a) => a.node).length, 1)
})
