import assert from 'node:assert/strict'
import test from 'node:test'
import { PolymarketSearchService } from '../read/search.js'
import { createPolymarketSearchRoutes } from './search.js'

test('normalizes active event, tag, and locally matched team results', async () => {
  let requestedPath = ''
  const service = new PolymarketSearchService({
    fetchSearch: async (path) => {
      requestedPath = path
      return {
        hasMore: true,
        events: [{
          id: 'event-1',
          slug: 'epl-ast-ars-2026-08-31',
          title: 'Aston Villa FC vs. Arsenal FC',
          active: true,
          closed: false,
          image: 'https://example.com/epl.png',
          endDate: '2026-08-31T19:00:00Z',
          markets: [{
            sportsMarketType: 'moneyline',
            outcomes: JSON.stringify(['Aston Villa', 'Arsenal', 'Draw']),
            outcomePrices: JSON.stringify(['0.30', '0.45', '0.25']),
            volume24hr: 1250,
          }],
        }, {
          id: 'closed-event',
          slug: 'closed-event',
          title: 'Closed event',
          closed: true,
        }],
        tags: [{ id: 235, slug: 'arsenal', label: 'Arsenal' }],
      }
    },
    fetchTeams: async () => [{
      id: 100001,
      name: 'Arsenal FC',
      league: 'epl',
      logo: 'https://example.com/arsenal.png',
      abbreviation: 'ars',
      alias: 'Arsenal',
    }, {
      id: 200001,
      name: 'Chelsea FC',
      league: 'epl',
    }],
  })

  const result = await service.search('  Arsenal  ', 1, 10)

  assert.match(requestedPath, /^public-search\?/)
  const params = new URLSearchParams(requestedPath.split('?')[1])
  assert.equal(params.get('q'), 'Arsenal')
  assert.equal(params.get('events_status'), 'active')
  assert.equal(params.get('search_profiles'), 'false')
  assert.equal(result.hasMore, true)
  assert.equal(result.events.length, 1)
  assert.equal(result.events[0]?.kind, 'sports')
  assert.equal(result.events[0]?.detailSlug, 'epl-ast-ars-2026-08-31')
  assert.equal(result.events[0]?.volume24h, 1250)
  assert.deepEqual(result.events[0]?.outcomes.map((outcome) => outcome.label), ['Aston Villa', 'Arsenal', 'Draw'])
  assert.deepEqual(result.tags, [{ id: '235', slug: 'arsenal', label: 'Arsenal' }])
  assert.deepEqual(result.teams, [{
    id: '100001',
    name: 'Arsenal FC',
    league: 'epl',
    logo: 'https://example.com/arsenal.png',
    abbreviation: 'ars',
    alias: 'Arsenal',
  }])
})

test('search route validates query length and reports upstream failures honestly', async () => {
  const app = createPolymarketSearchRoutes({
    service: { async search() { throw new Error('Gamma unavailable') } },
  })

  assert.equal((await app.request('/search?q=b')).status, 400)
  assert.equal((await app.request('/search?q=bitcoin')).status, 502)
})
