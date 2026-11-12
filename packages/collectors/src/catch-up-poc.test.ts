import test from 'node:test'
import assert from 'node:assert/strict'
import {
  buildNumberCorpus,
  checkClaims,
  checkDraftNumbers,
  extractNumericTokens,
  filterEntitiesSince,
  maskIgnoredSpans,
  parseCli,
  parseModelReply,
  runDraftChecks,
  selectEntities,
  summarize,
  type CatchUpDraft,
  type CatchUpEntity,
  type CatchUpItem,
  type CatchUpSignal,
} from './catch-up-poc'

const item = (over: Partial<CatchUpItem> = {}): CatchUpItem => ({
  id: '11111111-1111-4111-8111-111111111111',
  title: 'Bitcoin slips below $75,000 as IBIT drives 78% of a $2.1 billion ETF outflow wave',
  summary: 'BTC has lost the $75,000 level as the ETF sell-off swelled to $2.1 billion, with IBIT alone accounting for 78% of the withdrawals.',
  occurred_at: '2026-11-10T10:08:44+00:00',
  created_at: '2026-11-12T04:45:29.076Z',
  signal_id: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  angle: 'existing_story',
  note: 'SOPR at 0.94',
  ...over,
})

const signal = (over: Partial<CatchUpSignal> = {}): CatchUpSignal => ({
  signal_id: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  type: 'news',
  text: 'Bitcoin slips below $75,000. ETF outflows hit $2.1 billion.',
  excerpt: 'IBIT drove 78% of the wave.',
  numbers: { price: 75000, pct: 0.78, usd: 2.1 },
  ...over,
})

const entity = (over: Partial<CatchUpEntity> = {}): CatchUpEntity => ({
  id: 'entity-1',
  slug: 'bitcoin',
  name: 'Bitcoin',
  type: 'asset',
  summary: 'Largest crypto asset',
  latest_item_created_at: '2026-11-12T04:45:29.076Z',
  new_items: [item()],
  recent_items: [item()],
  origin_signals: [signal()],
  last_published: {
    id: 'pub-1',
    title: 'Earlier bitcoin note',
    content_small: 'Old summary',
    content_full: 'Old full',
    published_at: '2026-10-21T02:03:14Z',
  },
  ...over,
})

const draft = (over: Partial<CatchUpDraft> = {}): CatchUpDraft => ({
  title: 'Bitcoin loses $75,000 as ETF outflows reach $2.1 billion',
  what_happened: 'Bitcoin slipped below $75,000 as ETF outflows swelled to $2.1 billion.',
  how_we_got_here: 'IBIT drove 78% of the withdrawals after a stretch of selling.',
  what_to_watch: 'Whether institutional demand returns to defend that level.',
  claims: [{
    text: 'Bitcoin slipped below $75,000',
    source_item_id: item().id,
    source_signal_id: null,
  }],
  ...over,
})

test('parseModelReply accepts write, hold and skip, including fenced JSON', () => {
  const parsed = parseModelReply(`
\`\`\`json
{"decision":"write","reason":"New ETF outflow figure.","title":"Bitcoin loses $75,000","what_happened":"Price slipped below $75,000.","how_we_got_here":"Outflows grew.","what_to_watch":"Whether demand returns.","claims":[{"text":"Price slipped below $75,000.","source_item_id":"${item().id}"}]}
\`\`\`
`)
  assert.equal(parsed.decision, 'write')
  if (parsed.decision !== 'write') return
  assert.equal(parsed.draft.title, 'Bitcoin loses $75,000')
  assert.equal(parsed.draft.claims[0]?.source_item_id, item().id)

  const held = parseModelReply('{"decision":"hold","reason":"Still too thin."}')
  assert.deepEqual(held, { decision: 'hold', reason: 'Still too thin.' })
  const skipped = parseModelReply('{"decision":"skip","reason":"Already covered."}')
  assert.deepEqual(skipped, { decision: 'skip', reason: 'Already covered.' })
})

test('parseModelReply rejects junk, unknown actions, and incomplete write drafts', () => {
  assert.throws(() => parseModelReply('not json'), /no JSON object/)
  assert.throws(() => parseModelReply('{"decision":"watch","reason":"x"}'), /unknown decision/)
  assert.throws(() => parseModelReply('{"decision":"skip"}'), /one-line reason/)
  assert.throws(
    () => parseModelReply('{"decision":"write","reason":"r","title":"T","what_happened":"a","how_we_got_here":"b"}'),
    /three parts/,
  )
})

test('claim check requires a loaded item or origin signal id', () => {
  const ids = { itemIds: new Set([item().id]), signalIds: new Set([signal().signal_id]) }
  assert.equal(checkClaims([], ids.itemIds, ids.signalIds)[0]?.detail, 'write draft has no claims')
  assert.equal(checkClaims([{ text: 'x' }], ids.itemIds, ids.signalIds).length, 1)
  assert.equal(
    checkClaims([{ text: 'x', source_item_id: item().id }], ids.itemIds, ids.signalIds).length,
    0,
  )
  assert.equal(
    checkClaims([{ text: 'x', source_signal_id: signal().signal_id }], ids.itemIds, ids.signalIds).length,
    0,
  )
  assert.ok(
    checkClaims([{ text: 'x', source_item_id: '00000000-0000-4000-8000-000000000000' }], ids.itemIds, ids.signalIds)[0]?.detail.includes('unknown source_item_id'),
  )
  assert.ok(
    checkClaims([{ text: 'x', source_signal_id: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' }], ids.itemIds, ids.signalIds)[0]?.detail.includes('unknown source_signal_id'),
  )
})

test('number extraction keeps money, percents and compact suffixes, and ignores dates, years, UUIDs and ids', () => {
  const text = [
    'Bitcoin slipped below $75,000 on 2026-11-10T10:08:44Z.',
    'IBIT drove 78% of a $2.1 billion wave after SOPR hit 0.94.',
    'See https://example.com/path/12345 and item 11111111-1111-4111-8111-111111111111.',
    'Signal aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa is not a number.',
    'On 10 November 2026 at 7:33 the same 12/11/2026 print was unchanged.',
    'The BITOUSDT sizing change is scheduled for Nov. 19 and Oct. 20 is not a figure.',
  ].join(' ')
  assert.deepEqual(extractNumericTokens(text).sort(), ['$2.1b', '$75000', '0.94', '78%'].sort())
  assert.equal(maskIgnoredSpans(text).includes('11111111'), false)
  assert.equal(maskIgnoredSpans(text).includes('2026'), false)
})

test('number check accepts figures from items or origin signals and fails invented ones', () => {
  const corpus = buildNumberCorpus(entity())
  const ok = checkDraftNumbers(draftTextSafe(draft()), corpus)
  assert.deepEqual(ok, [])
  const fromSignalOnly = checkDraftNumbers('SOPR printed 0.94 in the note.', corpus)
  assert.deepEqual(fromSignalOnly, [])
  const invented = checkDraftNumbers('Open interest jumped 42%.', corpus)
  assert.equal(invented.length, 1)
  assert.match(invented[0]!.detail, /42%/)
})

test('runDraftChecks marks write+failed when a number is invented, and passes a clean draft', () => {
  const passed = runDraftChecks(draft(), entity())
  assert.equal(passed.status, 'passed')
  const failed = runDraftChecks(draft({
    what_happened: `${draft().what_happened} Volume hit 900 million.`,
  }), entity())
  assert.equal(failed.status, 'failed')
  assert.equal(failed.failures.some((failure) => failure.check === 'numbers'), true)
})

test('selectEntities mixes entities with and without a prior published update', () => {
  const entities = [
    entity({ id: 'w1', slug: 'w1', latest_item_created_at: '2026-11-12T04:00:00Z' }),
    entity({ id: 'w2', slug: 'w2', latest_item_created_at: '2026-11-12T03:00:00Z' }),
    entity({ id: 'w3', slug: 'w3', latest_item_created_at: '2026-11-12T02:00:00Z' }),
    entity({
      id: 'n1', slug: 'n1', latest_item_created_at: '2026-11-12T05:00:00Z', last_published: null,
    }),
    entity({
      id: 'n2', slug: 'n2', latest_item_created_at: '2026-11-12T01:00:00Z', last_published: null,
    }),
  ]
  const picked = selectEntities(entities, 4)
  assert.equal(picked.length, 4)
  const ids = picked.map((row) => row.id)
  assert.equal(ids.filter((id) => id.startsWith('w')).length, 2)
  assert.equal(ids.filter((id) => id.startsWith('n')).length, 2)
  assert.deepEqual(selectEntities(entities, 0).map((row) => row.id), ['n1', 'w1', 'w2', 'w3', 'n2'])
})

test('filterEntitiesSince keeps only items added after the cutoff', () => {
  const older = item({ id: 'old', created_at: '2026-11-11T08:00:00Z' })
  const newer = item({ id: 'new', created_at: '2026-11-12T03:00:00Z' })
  const rows = filterEntitiesSince(
    [entity({ new_items: [older, newer], latest_item_created_at: newer.created_at })],
    new Date('2026-11-12T00:00:00Z'),
  )
  assert.deepEqual(rows[0]?.new_items.map((row) => row.id), ['new'])
})

test('parseCli defaults and summarize counts write checks separately from hold and skip', () => {
  const options = parseCli([])
  assert.equal(options.limit, 12)
  assert.equal(options.model, 'glm-5.3-flash')
  const summary = summarize([
    {
      entity_id: '1', slug: 'a', name: 'A', status: 'ok', action: 'write', reason: 'r',
      draft: draft(), word_count: 40, check_status: 'passed', check_failures: [], would_replace: null,
    },
    {
      entity_id: '2', slug: 'b', name: 'B', status: 'ok', action: 'write', reason: 'r',
      draft: draft(), word_count: 40, check_status: 'failed',
      check_failures: [{ check: 'numbers', detail: 'x' }], would_replace: null,
    },
    { entity_id: '3', slug: 'c', name: 'C', status: 'ok', action: 'hold', reason: 'thin', would_replace: null },
    { entity_id: '4', slug: 'd', name: 'D', status: 'ok', action: 'skip', reason: 'repeat', would_replace: null },
    { entity_id: '5', slug: 'e', name: 'E', status: 'errored', error: 'model timed out', would_replace: null },
  ])
  assert.deepEqual(summary, {
    entities: 5, write: 2, hold: 1, skip: 1, errored: 1, checks_passed: 1, checks_failed: 1,
  })
})

function draftTextSafe(value: CatchUpDraft): string {
  return [value.title, value.what_happened, value.how_we_got_here, value.what_to_watch].join('\n')
}
