import assert from 'node:assert/strict'
import test from 'node:test'
import { RELEASE_ENTITY_SLUGS, RELEASE_SERIES, matchSeries, parseReleaseTitle } from './series.js'

test('the fixed list holds exactly the six headline series, one entity each', () => {
  assert.deepEqual(RELEASE_ENTITY_SLUGS, [
    'us-cpi', 'us-ppi', 'us-jobs-report-nfp',
    'fomc-rate-decision', 'us-gdp', 'us-retail-sales',
  ])
  assert.equal(new Set(RELEASE_SERIES.map((series) => series.entitySlug)).size, RELEASE_SERIES.length)
})

test('matches the six series titles with their stripped period', () => {
  assert.deepEqual(matchSeries('Inflation Rate YoY (Oct)', 'US'), { entitySlug: 'us-cpi', period: 'Oct' })
  assert.deepEqual(matchSeries('GDP Growth Rate QoQ (Q3)', 'US'), { entitySlug: 'us-gdp', period: 'Q3' })
  assert.deepEqual(matchSeries('Fed Interest Rate Decision', 'US'), {
    entitySlug: 'fomc-rate-decision', period: null,
  })
  assert.deepEqual(matchSeries('Producer Price Index MoM (Oct)', 'US'), { entitySlug: 'us-ppi', period: 'Oct' })
  assert.deepEqual(matchSeries('Non Farm Payrolls (Nov)', 'US'), { entitySlug: 'us-jobs-report-nfp', period: 'Nov' })
  assert.deepEqual(matchSeries('Retail Sales MoM (Dec)', 'US'), { entitySlug: 'us-retail-sales', period: 'Dec' })
})

test('ignores everything outside the fixed list and outside the US', () => {
  assert.equal(matchSeries('Inflation Rate YoY (Nov)', 'JP'), null)
  assert.equal(matchSeries('Inflation Rate YoY (Oct)', null), null)
  // Variants of the same release time must not match: no fuzzy or substring.
  assert.equal(matchSeries('Core Inflation Rate YoY (Oct)', 'US'), null)
  assert.equal(matchSeries('Inflation Rate MoM (Oct)', 'US'), null)
  assert.equal(matchSeries('Nonfarm Payrolls Private (Oct)', 'US'), null)
  assert.equal(matchSeries('Retail Sales Ex Autos MoM (Oct)', 'US'), null)
  assert.equal(matchSeries('Retail Sales Control Group MoM (Oct)', 'US'), null)
  assert.equal(matchSeries('FOMC Statement', 'US'), null)
  assert.equal(matchSeries('FOMC Minutes', 'US'), null)
  assert.equal(matchSeries('FOMC Economic Projections', 'US'), null)
  assert.equal(matchSeries('US Inflation Rate YoY (Oct)', 'US'), null)
  assert.equal(matchSeries('Inflation Rate YoY (October)', 'US'), null)
})

test('normalises: extra inner spaces, padding and different case still match', () => {
  assert.deepEqual(matchSeries('inflation  rate   yoy (OCT)', 'US'), { entitySlug: 'us-cpi', period: 'Oct' })
  assert.deepEqual(matchSeries('producer price index mom (q4)', 'US'), { entitySlug: 'us-ppi', period: 'Q4' })
  // The country compares exactly: lowercase 'us' is not the US series.
  assert.equal(matchSeries('Inflation Rate YoY (Oct)', 'us'), null)
  assert.deepEqual(parseReleaseTitle('  GDP   growth   rate  qoq   '), {
    normalized: 'GDP growth rate qoq', period: null,
  })
})

test('strips one trailing period and never the second one', () => {
  assert.deepEqual(parseReleaseTitle('Inflation Rate YoY (Oct) (Nov)'), {
    normalized: 'Inflation Rate YoY (Oct)', period: 'Nov',
  })
  // The one-period title already matches, so the double-strip leftover never
  // matches the fixed list; the period keeps canonical casing for the check.
  assert.equal(matchSeries('Inflation Rate YoY (Oct) (Nov)', 'US'), null)
  assert.deepEqual(parseReleaseTitle('(Oct)'), { normalized: '(Oct)', period: null })
})
