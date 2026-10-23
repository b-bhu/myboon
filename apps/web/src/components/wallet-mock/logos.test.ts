import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { ALL, LOGO } from './data'

test('every app and chain has a local logo file (#435)', () => {
  assert.equal(ALL.length, 22)
  for (const x of ALL) {
    const src = LOGO[x.k]
    assert.ok(src, `missing logo for ${x.k}`)
    assert.match(src, /^\/wallet-mock\//)
    assert.ok(existsSync(join(process.cwd(), 'public', src)), `file missing: ${src}`)
  }
})
