import assert from 'node:assert/strict'
import test from 'node:test'

import { packageScriptArgs } from './cli-args'

test('packageScriptArgs removes one pnpm separator', () => {
  assert.deepEqual(packageScriptArgs(['--', '--source', 'news']), ['--source', 'news'])
})

test('packageScriptArgs preserves direct invocation arguments', () => {
  assert.deepEqual(packageScriptArgs(['--source', 'news']), ['--source', 'news'])
})

test('packageScriptArgs preserves a second separator for strict downstream validation', () => {
  assert.deepEqual(packageScriptArgs(['--', '--', '--source', 'news']), ['--', '--source', 'news'])
})
