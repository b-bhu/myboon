import assert from 'node:assert/strict'
import test from 'node:test'
import { createClient } from '@supabase/supabase-js'
import { SupabaseEntityMemoryReader } from './supabase-reader'

function reader(rows: Record<string, unknown>[], requests: URL[]) {
  const db = createClient('https://fixture.invalid', 'fixture-key', {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: async input => {
      requests.push(new URL(String(input)))
      return new Response(JSON.stringify(rows), { status: 200, headers: { 'content-type': 'application/json' } })
    } },
  })
  return new SupabaseEntityMemoryReader(db)
}

const base = { id: 'item', entity_id: 'entity', memory_type: 'news', title: 'Development', summary: 'What happened',
  event_at: null, observed_at: '2026-10-10T12:00:00Z' }

test('history projects only four source URL values and keeps original precedence, types and dates', async () => {
  const variants = [
    { context_url: ' https://one.example ', context_source_url: 'https://two.example', signal_url: 'https://three.example', packet_url: 'https://four.example' },
    { context_url: '  ', context_source_url: 'https://two.example', signal_url: 'https://three.example' },
    { context_url: 123, context_source_url: { url: 'bad' }, signal_url: 'https://three.example', packet_url: 'https://four.example' },
    { context_url: null, context_source_url: false, signal_url: [], packet_url: 'https://four.example' },
    { context_url: {}, context_source_url: null, signal_url: '', packet_url: '\t' },
  ]
  const requests: URL[] = []
  const result = await reader(variants.map((variant, index) => ({ ...base, ...variant, id: `item-${index}` })), requests)
    .recentMemories(['entity'], 5)
  assert.deepEqual(result.map(item => item.sourceUrl), [
    ' https://one.example ', 'https://two.example', 'https://three.example', 'https://four.example', null,
  ])
  assert.equal(result[0].eventAt, base.observed_at)
  const selection = requests[0].searchParams.get('select')!
  assert.equal(selection.split(',').includes('context'), false)
  assert.match(selection, /context_url:context->url/)
  assert.match(selection, /packet_url:context->canonical_packet->sourceSignal->canonicalUrl/)
  assert.equal(requests[0].searchParams.get('order'), 'event_at.desc.nullslast,observed_at.desc.nullslast,id.desc')
  assert.equal(requests[0].searchParams.get('limit'), '5')
})

test('targeted older lookup keeps every URL filter while using the same smaller history projection', async () => {
  const requests: URL[] = []
  const result = await reader([{ ...base, event_at: '2026-10-09T12:00:00Z', packet_url: 'https://four.example' }], requests)
    .findMemoriesForArticle({ entityIds: ['entity'], terms: ['Development'], sourceUrl: 'https://four.example', limit: 10 })
  assert.equal(result[0].eventAt, '2026-10-09T12:00:00Z')
  assert.equal(result[0].sourceUrl, 'https://four.example')
  const filters = requests[0].searchParams.get('or')!
  for (const path of ['context->>url', 'context->>source_url', 'context->source_signal->>canonicalUrl', 'context->canonical_packet->sourceSignal->>canonicalUrl']) {
    assert.ok(filters.includes(path), path)
  }
  assert.equal(requests[0].searchParams.get('select')!.split(',').includes('context'), false)
})
