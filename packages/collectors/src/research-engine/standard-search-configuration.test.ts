import assert from 'node:assert/strict'
import test from 'node:test'
import {
  STANDARD_SEARCH_ENV,
  createConfiguredStandardSearch,
  loadStandardSearchConfiguration,
  standardSearchStatus,
} from './standard-search-configuration'

test('standard search is disabled by default and performs no factory work', () => {
  let calls = 0
  const configuration = loadStandardSearchConfiguration({})
  assert.equal(createConfiguredStandardSearch({ configuration, factories: { x: () => { calls += 1; throw new Error() } } }), undefined)
  assert.equal(calls, 0)
  assert.deepEqual(standardSearchStatus(configuration), {
    schemaVersion: 'myboon.standard_search_status.v1', enabled: false, connectorId: null, policyVersion: null,
  })
})

test('explicit standard search fails closed unless connector code is registered', () => {
  const configuration = loadStandardSearchConfiguration({
    [STANDARD_SEARCH_ENV.connector]: 'approved-search',
    [STANDARD_SEARCH_ENV.policyVersion]: 'standard-search.v1',
  })
  assert.throws(() => createConfiguredStandardSearch({ configuration }), /not registered/)
  let calls = 0
  const search = createConfiguredStandardSearch({
    configuration,
    factories: {
      'approved-search': () => ({
        connectorId: 'approved-search',
        search: async () => { calls += 1; return [] },
      }),
    },
  })
  assert.ok(search)
  assert.equal(calls, 0)
  assert.deepEqual(standardSearchStatus(configuration), {
    schemaVersion: 'myboon.standard_search_status.v1', enabled: true,
    connectorId: 'approved-search', policyVersion: 'standard-search.v1',
  })
})

test('enabled standard search requires safe policy and exact registered identity', () => {
  assert.throws(() => loadStandardSearchConfiguration({
    [STANDARD_SEARCH_ENV.connector]: 'approved-search',
  }), /policy version/)
  const configuration = loadStandardSearchConfiguration({
    [STANDARD_SEARCH_ENV.connector]: 'approved-search',
    [STANDARD_SEARCH_ENV.policyVersion]: 'standard-search.v1',
  })
  assert.throws(() => createConfiguredStandardSearch({
    configuration,
    factories: { 'approved-search': () => ({ connectorId: 'different', search: async () => [] }) },
  }), /mismatched/)
})
