import assert from 'node:assert/strict'
import test from 'node:test'
import { Hono } from 'hono'
import { createClobRoutes } from './clob.js'

test('createClobRoutes returns a Hono app', () => {
  assert.ok(createClobRoutes() instanceof Hono)
})

test('createClobRoutes returns independent instances (no import-time registration)', () => {
  const first = createClobRoutes()
  const second = createClobRoutes()
  assert.notEqual(first, second)
})

test('a known /clob path from the builder-sign group is registered', async () => {
  const routes = createClobRoutes()
  const response = await routes.request('/builder/sign', { method: 'POST' })
  // Without POLYMARKET_BUILDER_* env the route refuses with 500 (or 401 on a
  // missing proof when configured) — either way the path is registered, not a
  // 404. The full request contract is covered in polymarket/trading/routes/*.test.ts.
  assert.notEqual(response.status, 404)
  assert.ok(response.status >= 400, `expected a 4xx/5xx refusal, got ${response.status}`)
})
