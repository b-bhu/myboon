import assert from 'node:assert/strict'
import test from 'node:test'

import type { NewsSignal, Signal } from './contracts'
import { normalizeWithSignalAdapter, type SignalSourceAdapter } from './signal-source-adapter'

const news: NewsSignal = {
  schemaVersion: 'myboon.signal.v1', signalId: 'signal-1', sourceType: 'news', sourceId: 'source-1',
  contentKind: 'article', content: { schemaVersion: 'myboon.signal_content.article.v1' },
  observedAt: '2026-08-26T12:00:00.000Z', publishedAt: null, canonicalUrl: null,
  title: 'News', visibleSummary: null, media: { imageUrl: null, attribution: null },
  sourceHints: { entities: [], assets: [], eventId: null, deadline: null },
  provenance: { provider: 'test', upstreamSource: null, rawPayloadRef: 'raw-1' }, idempotencyKey: 'key-1',
}

test('source adapter boundary validates the canonical discriminants', () => {
  const adapter: SignalSourceAdapter<{ title: string }, NewsSignal> = {
    sourceType: 'news', contentKind: 'article', normalize: (raw) => ({ ...news, title: raw.title }),
  }
  assert.equal(normalizeWithSignalAdapter(adapter, { title: 'Normalized' }).title, 'Normalized')
  const lying: SignalSourceAdapter<{ title: string }, Signal> = {
    sourceType: 'polymarket', contentKind: 'article', normalize: adapter.normalize,
  }
  assert.throws(() => normalizeWithSignalAdapter(lying, { title: 'Wrong' }), /declared polymarket/)
})
