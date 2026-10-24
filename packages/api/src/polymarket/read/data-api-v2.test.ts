import assert from 'node:assert/strict'
import test from 'node:test'
import {
  DataApiV2Error,
  DataApiV2ParamError,
  dataApiV2Get,
  dataApiV2List,
} from './data-api-v2.js'

/** Fetch mock that serves scripted pages and records every requested URL. */
function fetchMock(pages: unknown[]): { fetch: typeof globalThis.fetch; urls: string[] } {
  const urls: string[] = []
  const fetch = async (input: Parameters<typeof globalThis.fetch>[0]) => {
    urls.push(String(input))
    const page = pages[urls.length - 1]
    if (page instanceof Response) return page
    return Response.json(page as unknown)
  }
  return { fetch: fetch as typeof globalThis.fetch, urls }
}

test('unwraps the {"data": ...} envelope', async () => {
  const { fetch, urls } = fetchMock([{ data: [{ id: 'row-1' }, { id: 'row-2' }] }])

  const rows = await dataApiV2List('positions', { user: '0xabc' }, { fetch })

  assert.deepEqual(rows, [{ id: 'row-1' }, { id: 'row-2' }])
  assert.deepEqual(urls, ['https://data-api.polymarket.com/v2/positions?user=0xabc'])
})

test('treats data:null and data:[] as empty', async () => {
  const missing = fetchMock([{ data: null }])
  const empty = fetchMock([{ data: [] }])

  assert.deepEqual(await dataApiV2List('positions', {}, { fetch: missing.fetch }), [])
  assert.deepEqual(await dataApiV2List('positions', {}, { fetch: empty.fetch }), [])
})

test('walks pagination.next_cursor across 3 pages then stops at null', async () => {
  const { fetch, urls } = fetchMock([
    { data: [{ n: 1 }], pagination: { has_more: true, next_cursor: 'cursor-2' } },
    { data: [{ n: 2 }], pagination: { has_more: true, next_cursor: 'cursor-3' } },
    { data: [{ n: 3 }], pagination: { has_more: false, next_cursor: null } },
  ])

  const rows = await dataApiV2List('activity', { user: '0xabc' }, { fetch })

  assert.deepEqual(rows, [{ n: 1 }, { n: 2 }, { n: 3 }])
  assert.equal(urls.length, 3)
  assert.ok(!urls[0].includes('cursor='))
  assert.ok(urls[1].endsWith('cursor=cursor-2'))
  assert.ok(urls[2].endsWith('cursor=cursor-3'))
})

test('cap truncation stops fetching further pages', async () => {
  const { fetch, urls } = fetchMock([
    { data: [{ n: 1 }, { n: 2 }, { n: 3 }], pagination: { next_cursor: 'cursor-2' } },
    { data: [{ n: 4 }, { n: 5 }, { n: 6 }], pagination: { next_cursor: 'cursor-3' } },
    { data: [{ n: 7 }], pagination: { next_cursor: null } },
  ])

  const rows = await dataApiV2List('positions', {}, { cap: 5, fetch })

  assert.deepEqual(rows, [{ n: 1 }, { n: 2 }, { n: 3 }, { n: 4 }, { n: 5 }])
  assert.equal(urls.length, 2)
})

test('non-OK HTTP throws the typed DataApiV2Error with the upstream status', async () => {
  const { fetch } = fetchMock([new Response('page size too large', { status: 400 })])

  await assert.rejects(
    dataApiV2List('positions', {}, { fetch }),
    (err: unknown) => {
      assert.ok(err instanceof DataApiV2Error)
      assert.equal(err.status, 400)
      assert.equal(err.route, 'positions')
      assert.equal(err.name, 'DataApiV2Error')
      assert.match(err.message, /HTTP 400/)
      return true
    },
  )
})

test('rejects v1-only params (offset) before sending a request', async () => {
  const { fetch, urls } = fetchMock([{ data: [] }])

  await assert.rejects(
    dataApiV2List('positions', { user: '0xabc', offset: '10' }, { fetch }),
    (err: unknown) => {
      assert.ok(err instanceof DataApiV2ParamError)
      assert.equal(err.param, 'offset')
      assert.equal(err.status, 400)
      assert.match(err.message, /offset/)
      return true
    },
  )
  assert.equal(urls.length, 0)
})

test('rejects market/market_id/marketId params on get as well', async () => {
  for (const param of ['market', 'market_id', 'marketId']) {
    const { fetch, urls } = fetchMock([{ data: {} }])
    await assert.rejects(
      dataApiV2Get('value', { user: '0xabc', [param]: 'x' }, { fetch }),
      (err: unknown) => {
        assert.ok(err instanceof DataApiV2ParamError)
        assert.equal(err.param, param)
        return true
      },
    )
    assert.equal(urls.length, 0)
  }
})

test('dataApiV2Get unwraps the single-object envelope and nulls a miss', async () => {
  const hit = fetchMock([{ data: { proxy_wallet: '0xabc', value: '1234.5000' } }])
  const miss = fetchMock([{ data: null }])

  const value = await dataApiV2Get<{ proxy_wallet: string; value: string }>('value', { user: '0xabc' }, { fetch: hit.fetch })
  const nothing = await dataApiV2Get('value', { user: '0xabc' }, { fetch: miss.fetch })

  assert.deepEqual(value, { proxy_wallet: '0xabc', value: '1234.5000' })
  assert.deepEqual(nothing, null)
  assert.deepEqual(hit.urls, ['https://data-api.polymarket.com/v2/value?user=0xabc'])
  assert.deepEqual(miss.urls, ['https://data-api.polymarket.com/v2/value?user=0xabc'])
})

test('an out-of-envelope body throws DataApiV2Error', async () => {
  const legacy = fetchMock([[{ user: '0xabc', value: '1' }]]) // bare array (v1 shape)
  const wrap = fetchMock([{ data: { nope: true }, pagination: { next_cursor: 42 } }])

  await assert.rejects(dataApiV2List('value', {}, { fetch: legacy.fetch }), DataApiV2Error)
  await assert.rejects(dataApiV2List('activity', {}, { fetch: wrap.fetch }), DataApiV2Error)
})