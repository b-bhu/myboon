import assert from 'node:assert/strict'
import type {
  CalendarHistoryMarket,
  CalendarHistoryMove,
  CalendarHistoryRelease,
  CalendarHistoryResponse,
} from './index.js'

// Compile-time checks run under `pnpm --filter @myboon/shared typecheck`;
// `tsx` only strips types, so the runtime asserts below cover the fixtures.

const market: CalendarHistoryMarket = {
  symbol: 'xyz:CL',
  displaySymbol: 'WTI',
  displayName: 'WTI crude oil',
  rank: 1,
}

// rank is 1, 2 or 3.
// @ts-expect-error rank must be 1, 2 or 3
const badRank: CalendarHistoryMarket = { ...market, rank: 4 }
// @ts-expect-error symbol is a string
const numberSymbol: CalendarHistoryMarket = { ...market, symbol: 7 }
void [badRank, numberSymbol]

// A required field cannot be dropped.
// @ts-expect-error `displayName` is required
const missingName: CalendarHistoryMarket = { ...market, displayName: undefined }
void missingName

const moveNull: CalendarHistoryMove = { symbol: 'BTC', changePct: null }
const movePriced: CalendarHistoryMove = { symbol: 'xyz:CL', changePct: -1.25 }
// @ts-expect-error changePct is a number or null
const stringMove: CalendarHistoryMove = { ...movePriced, changePct: '-1.25' }
void [moveNull, movePriced, stringMove]

const release: CalendarHistoryRelease = {
  date: '2026-10-13',
  startsAt: '2026-10-13T13:30:00+00:00',
  title: 'Inflation Rate YoY',
  period: 'Oct',
  unit: '%',
  actual: 3.1,
  estimate: 3.0,
  previous: 2.9,
  moves: [movePriced, moveNull],
}

const dateOnlyRelease: CalendarHistoryRelease = {
  ...release,
  startsAt: null,
  moves: [moveNull],
}
// @ts-expect-error startsAt is a string or null
const numberStartsAt: CalendarHistoryRelease = { ...release, startsAt: 1 }
// @ts-expect-error actual is a number or null
const stringActual: CalendarHistoryRelease = { ...release, actual: '3.1' }
// @ts-expect-error moves is required
const missingMoves: CalendarHistoryRelease = { ...release, moves: undefined }
void [dateOnlyRelease, numberStartsAt, stringActual, missingMoves]

const response: CalendarHistoryResponse = {
  entity: { slug: 'us-cpi', name: 'US CPI' },
  markets: [market],
  releases: [release],
}
// @ts-expect-error entity is required
const missingEntity: CalendarHistoryResponse = { markets: [], releases: [] }
void [response, missingEntity]

function testDocumentedFieldsOnly(): void {
  assert.deepEqual(Object.keys(market).sort(), ['displayName', 'displaySymbol', 'rank', 'symbol'])
  assert.deepEqual(Object.keys(movePriced).sort(), ['changePct', 'symbol'])
  assert.deepEqual(Object.keys(release).sort(), [
    'actual', 'date', 'estimate', 'moves', 'period', 'previous', 'startsAt', 'title', 'unit',
  ])
  assert.deepEqual(Object.keys(response).sort(), ['entity', 'markets', 'releases'])
  assert.equal(moveNull.changePct, null)
  assert.equal(dateOnlyRelease.startsAt, null)
  assert.deepEqual(response.entity, { slug: 'us-cpi', name: 'US CPI' })
  assert.equal(release.moves.length, 2)
}

testDocumentedFieldsOnly()

console.log('Calendar history shared type tests passed')
