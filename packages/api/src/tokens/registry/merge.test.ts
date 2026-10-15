import assert from 'node:assert/strict'
import test from 'node:test'
import { mergeTokenRow, type TokenRegistryIncoming, type TokenRegistryRow } from './merge.js'
const base: TokenRegistryRow = { mint: 'm', symbol: 'OLD', name: 'Old', decimals: 6, icon_source_url: 'old-url', verified: true, sources: { symbol: 'jupiter', name: 'jupiter', decimals: 'jupiter', icon_source_url: 'jupiter', verified: 'seed' }, upstream_seen_at: '2026-01-02T00:00:00Z' }
const incoming = (patch: Partial<TokenRegistryIncoming>): TokenRegistryIncoming => ({ ...base, symbol: 'NEW', name: 'New', decimals: 9, icon_source_url: 'new-url', sources: { symbol: 'meteora', name: 'meteora', decimals: 'meteora', icon_source_url: 'meteora', verified: 'jupiter' }, upstream_seen_at: '2026-01-03T00:00:00Z', ...patch })

test('older values never replace newer; null stored fields are filled; incoming null never clears', () => {
  const older = mergeTokenRow(base, incoming({ symbol: 'OLD2', upstream_seen_at: '2026-01-01T00:00:00Z' }))
  assert.equal(older.symbol, 'OLD')
  assert.equal(older.sources.symbol, 'jupiter')
  const filled = mergeTokenRow({ ...base, symbol: null }, incoming({ symbol: 'NEW' }))
  assert.equal(filled.symbol, 'NEW')
  const noClear = mergeTokenRow(base, incoming({ symbol: null, name: null, decimals: null, icon_source_url: null }))
  assert.equal(noClear.symbol, 'OLD'); assert.equal(noClear.name, 'Old'); assert.equal(noClear.decimals, 6); assert.equal(noClear.icon_source_url, 'old-url')
})

test('upstream time uses greatest with null handling and kept values keep provenance', () => {
  assert.equal(mergeTokenRow(base, incoming({ upstream_seen_at: null })).upstream_seen_at, base.upstream_seen_at)
  assert.equal(mergeTokenRow({ ...base, upstream_seen_at: null }, incoming({ upstream_seen_at: null })).upstream_seen_at, null)
  assert.equal(mergeTokenRow({ ...base, upstream_seen_at: null }, incoming({ upstream_seen_at: '2026-01-03T00:00:00Z' })).upstream_seen_at, '2026-01-03T00:00:00Z')
  assert.equal(mergeTokenRow({ ...base, upstream_seen_at: null }, incoming({ upstream_seen_at: '2026-01-03T00:00:00Z' })).symbol, 'NEW')
  const kept = mergeTokenRow(base, incoming({ symbol: 'NEW', sources: { symbol: 'meteora' }, upstream_seen_at: '2026-01-01T00:00:00Z' }))
  assert.equal(kept.sources.symbol, 'jupiter')
})

test('verified follows source rank, with incoming ties winning', () => {
  assert.equal(mergeTokenRow(base, incoming({ verified: false, sources: { verified: 'meteora' }, upstream_seen_at: '2026-01-04T00:00:00Z' })).verified, true)
  assert.equal(mergeTokenRow({ ...base, verified: false, sources: { ...base.sources, verified: 'meteora' } }, incoming({ verified: true, sources: { verified: 'jupiter' } })).verified, true)
})
