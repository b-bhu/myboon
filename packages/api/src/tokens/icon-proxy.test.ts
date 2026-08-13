import assert from 'node:assert/strict'
import test from 'node:test'
import {
  __clearIconCacheForTest,
  getIcon,
  ICON_MISS_CACHE_CONTROL,
  ICON_NEGATIVE_TTL_MS,
  ICON_TRANSIENT_TTL_MS,
} from './icon-proxy.js'

function fetchCounter(handler: (url: string) => Response) {
  let calls = 0
  const fetchImpl = (async (input: RequestInfo | URL) => {
    calls += 1
    return handler(String(input))
  }) as typeof fetch
  return { fetchImpl, count: () => calls }
}

test('first request fetches upstream and caches; a second within TTL serves without refetching', async () => {
  __clearIconCacheForTest()
  const { fetchImpl, count } = fetchCounter(() => new Response('<svg>a</svg>', { status: 200, headers: { 'Content-Type': 'image/svg+xml' } }))
  const lookup = async () => 'https://example.test/icons/A.svg'

  const first = await getIcon('asset-a', lookup, fetchImpl)
  assert.ok(first)
  assert.equal(count(), 1)

  const second = await getIcon('asset-a', lookup, fetchImpl)
  assert.ok(second)
  assert.equal(count(), 1, 'second request within TTL must not refetch upstream')
  assert.deepEqual(Array.from(second!.bytes), Array.from(first!.bytes))
})

test('an upstream 404 negative-caches and a re-request inside the hour does not refetch', async () => {
  __clearIconCacheForTest()
  const { fetchImpl, count } = fetchCounter(() => new Response(null, { status: 404 }))
  const lookup = async () => 'https://example.test/icons/missing.svg'

  const first = await getIcon('asset-missing', lookup, fetchImpl)
  assert.equal(first, null)
  assert.equal(count(), 1)

  const second = await getIcon('asset-missing', lookup, fetchImpl)
  assert.equal(second, null)
  assert.equal(count(), 1, 'a re-request inside the negative-cache TTL must not refetch')
})

test('an unknown assetId (no source url) negative-caches without ever calling fetch', async () => {
  __clearIconCacheForTest()
  const { fetchImpl, count } = fetchCounter(() => new Response('should not be called', { status: 200 }))
  const lookup = async () => null

  const result = await getIcon('asset-unknown', lookup, fetchImpl)
  assert.equal(result, null)
  assert.equal(count(), 0)
})

test('content-type passthrough for SVG vs PNG', async () => {
  __clearIconCacheForTest()
  const svgFetch = fetchCounter(() => new Response('<svg/>', { status: 200, headers: { 'Content-Type': 'image/svg+xml; charset=utf-8' } }))
  const svgResult = await getIcon('asset-svg', async () => 'https://example.test/icons/x.svg', svgFetch.fetchImpl)
  assert.equal(svgResult?.contentType, 'image/svg+xml; charset=utf-8')

  __clearIconCacheForTest()
  const pngFetch = fetchCounter(() => new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { 'Content-Type': 'image/png' } }))
  const pngResult = await getIcon('asset-png', async () => 'https://example.test/icons/x.png', pngFetch.fetchImpl)
  assert.equal(pngResult?.contentType, 'image/png')
})

test('correct Cache-Control on hit (max-age=604800) and miss (max-age=3600)', async () => {
  __clearIconCacheForTest()
  const hitFetch = fetchCounter(() => new Response('<svg/>', { status: 200, headers: { 'Content-Type': 'image/svg+xml' } }))
  const hit = await getIcon('asset-hit', async () => 'https://example.test/icons/x.svg', hitFetch.fetchImpl)
  assert.equal(hit?.cacheControl, 'public, max-age=604800')

  assert.equal(ICON_MISS_CACHE_CONTROL, 'public, max-age=3600')
})

test('a thrown fetch (transient) caches far more briefly than a definitive 404', async () => {
  // A 404 is an answer — "there is no icon for this asset" — and is worth
  // remembering for an hour. A thrown fetch (DNS failure, timeout, reset) is
  // NOT an answer; it means we could not find out. Caching that for the same
  // hour blanks the icon app-wide long after the network recovered, so it gets
  // a much shorter TTL. This assertion pins the two apart so a future
  // simplification cannot quietly collapse them back together.
  assert.ok(
    ICON_TRANSIENT_TTL_MS < ICON_NEGATIVE_TTL_MS,
    'transient failures must expire sooner than definitive misses',
  )

  __clearIconCacheForTest()
  const throwing = (async () => {
    throw new Error('ECONNRESET')
  }) as unknown as typeof fetch
  const failed = await getIcon('asset-transient', async () => 'https://example.test/icons/t.svg', throwing)
  assert.equal(failed, null, 'a transient failure still degrades to null, never throws at the caller')

  // Once upstream recovers, the short TTL must let a retry through rather than
  // serving the cached blank. Same assetId, now-healthy fetch.
  const recovered = fetchCounter(() => new Response('<svg>ok</svg>', { status: 200, headers: { 'Content-Type': 'image/svg+xml' } }))
  __clearIconCacheForTest() // stands in for the short TTL elapsing
  const after = await getIcon('asset-transient', async () => 'https://example.test/icons/t.svg', recovered.fetchImpl)
  assert.ok(after, 'a recovered upstream serves real bytes again')
  assert.equal(recovered.count(), 1)
})
