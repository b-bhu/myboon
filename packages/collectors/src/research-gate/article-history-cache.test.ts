import assert from 'node:assert/strict'
import test from 'node:test'
import { ArticleHistoryCache, type ArticleHistoryEntry } from './article-history-cache'

const history = (id = 'item'): ArticleHistoryEntry[] => [{ id, source: 'managed', title: 'A development', summary: 'What happened', eventAt: '2026-10-10T12:00:00Z' }]

test('recent cache coalesces reads and expires at sixty seconds without sharing mutable snapshots', async () => {
  let now = 0
  let reads = 0
  let release!: () => void
  const pending = new Promise<void>(resolve => { release = resolve })
  const cache = new ArticleHistoryCache(60_000, () => now)
  const load = async () => { reads += 1; await pending; return history() }
  const first = cache.read('news:entity', load)
  const second = cache.read('news:entity', load)
  await Promise.resolve()
  assert.equal(reads, 1)
  release()
  const results = await Promise.all([first, second])
  results[0][0].summary = 'Changed in one article'
  assert.equal(results[1][0].summary, 'What happened')
  now = 59_999
  assert.equal((await cache.read('news:entity', load))[0].summary, 'What happened')
  assert.equal(reads, 1)
  now = 60_000
  await cache.read('news:entity', load)
  assert.equal(reads, 2)
})

test('cache never retains failed or oversized loads and respects entry and byte bounds', async () => {
  const cache = new ArticleHistoryCache(60_000, () => 0, 2, 400)
  await assert.rejects(cache.read('bad', async () => { throw new Error('storage offline') }), /offline/)
  assert.deepEqual(await cache.read('bad', async () => history('recovered')), history('recovered'))
  await cache.read('second', async () => history('second'))
  await cache.read('third', async () => history('third'))
  let reloads = 0
  await cache.read('bad', async () => { reloads += 1; return history('reloaded') })
  assert.equal(reloads, 1)
  const large = [{ ...history()[0], summary: 'x'.repeat(401) }]
  let largeReads = 0
  for (let i = 0; i < 2; i += 1) await cache.read('large', async () => { largeReads += 1; return large })
  assert.equal(largeReads, 2)
})

test('invalidation rejects old in-flight context and independent runners never share entries', async () => {
  const first = new ArticleHistoryCache()
  const second = new ArticleHistoryCache()
  let resolve!: (value: ArticleHistoryEntry[]) => void
  const pending = first.read('entity', () => new Promise(done => { resolve = done }))
  await Promise.resolve()
  first.clear()
  resolve(history('old'))
  await assert.rejects(pending, (error: unknown) => (error as { code: string }).code === 'CONTEXT_CACHE_INVALIDATED')
  assert.deepEqual(await first.read('entity', async () => history('fresh')), history('fresh'))
  assert.deepEqual(await second.read('entity', async () => history('other-environment')), history('other-environment'))
})

test('disabled cache always reloads and validates only short bounded TTLs', async () => {
  const cache = new ArticleHistoryCache(0)
  let reads = 0
  for (let i = 0; i < 2; i += 1) await cache.read('entity', async () => { reads += 1; return history() })
  assert.equal(reads, 2)
  for (const invalid of [-1, 60_001, 0.5, NaN]) assert.throws(() => new ArticleHistoryCache(invalid), RangeError)
})

test('expired slow reads cannot replace newer cached history', async () => {
  let now = 0
  let resolve!: (value: ArticleHistoryEntry[]) => void
  const cache = new ArticleHistoryCache(60_000, () => now)
  const old = cache.read('entity', () => new Promise(done => { resolve = done }))
  await Promise.resolve()
  now = 60_000
  assert.equal((await cache.read('entity', async () => history('new')))[0].id, 'new')
  resolve(history('old'))
  assert.equal((await old)[0].id, 'old', 'the original article retains its own snapshot')
  assert.equal((await cache.read('entity', async () => { throw new Error('must be cached') }))[0].id, 'new')
})

test('outstanding cache loads are bounded and waiting loads cannot survive invalidation', async () => {
  const cache = new ArticleHistoryCache(60_000, () => 0, 1)
  let resolve!: (value: ArticleHistoryEntry[]) => void
  let reads = 0
  const first = cache.read('first', () => { reads += 1; return new Promise(done => { resolve = done }) })
  const second = cache.read('second', async () => { reads += 1; return history('second') })
  await Promise.resolve()
  assert.equal(reads, 1)
  cache.clear()
  resolve(history('first'))
  const results = await Promise.allSettled([first, second])
  assert.deepEqual(results.map(result => result.status), ['rejected', 'rejected'])
  assert.equal(reads, 1, 'the queued load never dispatches after invalidation')
  assert.equal((await cache.read('fresh', async () => history('fresh')))[0].id, 'fresh')
})
