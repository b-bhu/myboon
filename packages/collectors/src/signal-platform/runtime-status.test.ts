import assert from 'node:assert/strict'
import test from 'node:test'

import { readFeedV3RuntimeStatusAvailability } from './runtime-status'

test('Feed V3 runtime status reports Research and Entity availability independently', async () => {
  const paths: string[] = []
  const result = await readFeedV3RuntimeStatusAvailability({
    researchPath: '/research-status.json', researchStaleAfterMs: 1_000,
    entityPath: '/entity-status.json', entityStaleAfterMs: 2_000,
  }, {
    async readResearch(input) {
      paths.push(`${input.path}:${input.staleAfterMs}`)
      return { availability: 'missing', snapshot: null }
    },
    async readEntity(input) {
      paths.push(`${input.path}:${input.staleAfterMs}`)
      throw new Error('unreadable Entity health')
    },
  })

  assert.deepEqual(paths.sort(), ['/entity-status.json:2000', '/research-status.json:1000'])
  assert.deepEqual(result, {
    researchRuntime: { availability: 'missing', snapshot: null },
    entityRuntime: { availability: 'invalid', snapshot: null },
  })
})
