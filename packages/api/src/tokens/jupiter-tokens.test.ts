import assert from 'node:assert/strict'
import test from 'node:test'
import {
  __clearJupiterCacheForTest,
  getCachedJupiterToken,
  unknownMints,
  warmJupiterTokens,
} from './jupiter-tokens.js'

const MINT_A = 'CWZ6BsdnjkDVTGkmL6bGbJXXig6ceef12KvyGQW14cMt'
const MINT_B = 'XSTuo1fV7HHMhs4BYiwtrWSLsMCJNrooH2AssWTYZqP'

function stubFetch(rows: unknown[], onCall?: (url: string) => void) {
  return (async (input: RequestInfo | URL) => {
    onCall?.(String(input))
    return Response.json(rows)
  }) as typeof fetch
}

test('warms a mint from Jupiter and serves it synchronously afterwards', async () => {
  __clearJupiterCacheForTest()
  // Reading before any warm pass must not throw or block — resolveRef is pure
  // and synchronous, so a cold mint simply has no identity yet.
  assert.equal(getCachedJupiterToken(MINT_A), null)

  await warmJupiterTokens([MINT_A], stubFetch([
    { id: MINT_A, symbol: 'ANTFUN', name: 'Ant Fun', icon: 'https://ipfs.io/ipfs/abc', decimals: 6, isVerified: true },
  ]))

  const info = getCachedJupiterToken(MINT_A)
  assert.equal(info?.symbol, 'ANTFUN')
  assert.equal(info?.decimals, 6)
  assert.equal(info?.verified, true)
  assert.equal(info?.iconUrl, 'https://ipfs.io/ipfs/abc')
})

test('accepts the older address/logoURI shape as well as id/icon', async () => {
  // Jupiter has shipped both shapes; a change upstream should degrade to a
  // miss, never a crash.
  __clearJupiterCacheForTest()
  await warmJupiterTokens([MINT_B], stubFetch([
    { address: MINT_B, symbol: 'XST', logoURI: 'https://arweave.net/xyz', decimals: 6 },
  ]))
  assert.equal(getCachedJupiterToken(MINT_B)?.iconUrl, 'https://arweave.net/xyz')
})

test('a mint Jupiter does not return is cached as a miss, and retried sooner than a hit', async () => {
  __clearJupiterCacheForTest()
  await warmJupiterTokens([MINT_A], stubFetch([]))
  // Cached as "no identity" rather than left unknown, so a list of 50 rows does
  // not re-ask on every render...
  assert.equal(getCachedJupiterToken(MINT_A), null)
  assert.deepEqual(unknownMints([MINT_A]), [], 'a miss counts as known for now')
})

test('only unknown mints are looked up, and only once for concurrent callers', async () => {
  __clearJupiterCacheForTest()
  const calls: string[] = []
  const fetchImpl = stubFetch(
    [{ id: MINT_A, symbol: 'ANTFUN', icon: 'https://ipfs.io/ipfs/abc', decimals: 6 }],
    (url) => calls.push(url),
  )

  // Two concurrent warms for the same mint share one in-flight request.
  await Promise.all([
    warmJupiterTokens([MINT_A], fetchImpl),
    warmJupiterTokens([MINT_A], fetchImpl),
  ])
  assert.equal(calls.length, 1, 'concurrent callers share one request')

  // Already warm: no further upstream call.
  await warmJupiterTokens([MINT_A], fetchImpl)
  assert.equal(calls.length, 1, 'a warm mint is never re-fetched')
})

test('an upstream failure never throws — rows fall back instead', async () => {
  __clearJupiterCacheForTest()
  const failing = (async () => { throw new Error('network down') }) as typeof fetch
  await warmJupiterTokens([MINT_A], failing) // must not reject
  assert.equal(getCachedJupiterToken(MINT_A), null)
})

test('batches large mint sets rather than sending one huge query', async () => {
  __clearJupiterCacheForTest()
  const calls: string[] = []
  const mints = Array.from({ length: 25 }, (_, i) => `Mint${String(i).padStart(38, '0')}`)
  await warmJupiterTokens(mints, stubFetch([], (url) => calls.push(url)))
  assert.equal(calls.length, 3, '25 mints at 10 per request = 3 calls')
})
