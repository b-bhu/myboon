import assert from 'node:assert/strict'
import test from 'node:test'
import { ARTICLE_PLACEMENT_SAVE_UNCERTAIN_ENV, parseArticlePlacementSaveUncertain } from './article-placement'

// #343: Bucket's save-uncertain switch is pinned off in PM2 until Bucket says
// yes. A shell or collectors/.env value must not be able to turn it on.
test('PM2 pins ARTICLE_PLACEMENT_SAVE_UNCERTAIN off for the shared Research runner only', () => {
  const path = require.resolve('../../../../ecosystem.config.cjs')
  const previous = process.env[ARTICLE_PLACEMENT_SAVE_UNCERTAIN_ENV]
  process.env[ARTICLE_PLACEMENT_SAVE_UNCERTAIN_ENV] = 'true'
  delete require.cache[path]
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const ecosystem = require(path) as { apps: Array<{ name: string, env?: Record<string, string> }> }
    const research = ecosystem.apps.find((app) => app.name === 'myboon-feed-v3-research')
    assert.ok(research?.env)
    assert.equal(research.env[ARTICLE_PLACEMENT_SAVE_UNCERTAIN_ENV], 'false')
    assert.equal(parseArticlePlacementSaveUncertain(research.env), false)
    const others = ecosystem.apps.filter((app) => app.name !== 'myboon-feed-v3-research'
      && app.env && Object.hasOwn(app.env, ARTICLE_PLACEMENT_SAVE_UNCERTAIN_ENV))
    assert.deepEqual(others.map((app) => app.name), [])
  } finally {
    if (previous === undefined) delete process.env[ARTICLE_PLACEMENT_SAVE_UNCERTAIN_ENV]
    else process.env[ARTICLE_PLACEMENT_SAVE_UNCERTAIN_ENV] = previous
    delete require.cache[path]
  }
})
