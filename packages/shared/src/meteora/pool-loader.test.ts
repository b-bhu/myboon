import assert from 'node:assert/strict'
import test from 'node:test'
import { createMeteoraPoolLoader } from './pool-loader.js'

test('caches completed reads but deduplicates concurrent fresh reads', async () => {
  let calls = 0
  let release: ((value: string) => void) | undefined
  const loader = createMeteoraPoolLoader(async () => {
    calls += 1
    return new Promise<string>((resolve) => { release = resolve })
  })

  const first = loader.getFresh('pool')
  const second = loader.getFresh('pool')
  assert.equal(first, second)
  await Promise.resolve()
  assert.equal(calls, 1)
  release?.('fresh')
  assert.equal(await first, 'fresh')
  assert.equal(await loader.get('pool'), 'fresh')
  assert.equal(calls, 1)
})

test('failed fresh reads clear stale cache and allow a later retry', async () => {
  let calls = 0
  const loader = createMeteoraPoolLoader(async () => {
    calls += 1
    if (calls === 2) throw new Error('refresh failed')
    return calls === 1 ? 'cached' : 'recovered'
  })

  assert.equal(await loader.get('pool'), 'cached')
  await assert.rejects(loader.getFresh('pool'), /refresh failed/)
  assert.equal(await loader.get('pool'), 'recovered')
  assert.equal(calls, 3)
})

test('a normal read joins an in-flight fresh read instead of returning stale data', async () => {
  let release: ((value: string) => void) | undefined
  const loader = createMeteoraPoolLoader(async () => new Promise<string>((resolve) => { release = resolve }))
  const fresh = loader.getFresh('pool')
  const normal = loader.get('pool')
  assert.equal(normal, fresh)
  await Promise.resolve()
  release?.('new')
  assert.equal(await normal, 'new')
})

test('clear and newer refreshes prevent late results from repopulating cache', async () => {
  const resolves: Array<(value: string) => void> = []
  const loader = createMeteoraPoolLoader(async () => new Promise<string>((resolve) => {
    resolves.push(resolve)
  }))

  const first = loader.getFresh('pool')
  await Promise.resolve()
  loader.clear()
  const second = loader.getFresh('pool')
  await Promise.resolve()
  assert.equal(resolves.length, 2)

  resolves[1]?.('new')
  assert.equal(await second, 'new')
  resolves[0]?.('old')
  assert.equal(await first, 'old')
  assert.equal(await loader.get('pool'), 'new')
})

test('a rejected older refresh cannot remove a newer successful refresh', async () => {
  const outcomes: Array<{ resolve?: (value: string) => void; reject?: (error: Error) => void }> = []
  const loader = createMeteoraPoolLoader(async () => new Promise<string>((resolve, reject) => {
    outcomes.push({ resolve, reject })
  }))

  const first = loader.getFresh('pool')
  await Promise.resolve()
  loader.clear()
  const second = loader.getFresh('pool')
  await Promise.resolve()
  outcomes[1]?.resolve?.('recovered')
  assert.equal(await second, 'recovered')
  outcomes[0]?.reject?.(new Error('old failure'))
  await assert.rejects(first, /old failure/)
  assert.equal(await loader.get('pool'), 'recovered')
})
