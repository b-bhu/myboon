import assert from 'node:assert/strict'
import test from 'node:test'
import { basename, resolve } from 'node:path'
import {
  DEFAULT_NEWS_LANE_SQLITE_PATH,
  DEFAULT_POLYMARKET_LANE_SQLITE_PATH,
  LANE_SQLITE_FILENAMES,
  resolveLaneSqlitePath,
  resolveLaneSqlitePathFromEnv,
  RETIRED_LANE_SQLITE_FILENAMES,
  RetiredLaneSqlitePathError,
} from './paths'

test('blank and missing paths fall back to the lane defaults', () => {
  assert.equal(resolveLaneSqlitePath('news'), DEFAULT_NEWS_LANE_SQLITE_PATH)
  assert.equal(resolveLaneSqlitePath('polymarket'), DEFAULT_POLYMARKET_LANE_SQLITE_PATH)
  assert.equal(resolveLaneSqlitePath('news', null), DEFAULT_NEWS_LANE_SQLITE_PATH)
  assert.equal(resolveLaneSqlitePath('news', '   '), DEFAULT_NEWS_LANE_SQLITE_PATH)
  assert.equal(resolveLaneSqlitePath('polymarket', ''), DEFAULT_POLYMARKET_LANE_SQLITE_PATH)
  assert.equal(basename(DEFAULT_NEWS_LANE_SQLITE_PATH), 'news-lane.sqlite')
  assert.equal(basename(DEFAULT_POLYMARKET_LANE_SQLITE_PATH), 'polymarket-lane.sqlite')
})

test(':memory: passes through unchanged', () => {
  assert.equal(resolveLaneSqlitePath('news', ':memory:'), ':memory:')
  assert.equal(resolveLaneSqlitePath('polymarket', ':memory:'), ':memory:')
})

test('retired basenames throw with the lane, path, expected name, and issue reference', () => {
  for (const [lane, retired] of [['news', 'news.sqlite'], ['polymarket', 'pipeline.sqlite']] as const) {
    for (const given of [retired, `/srv/data/${retired}`, `./nested/${retired}`, ` ${retired} `]) {
      assert.throws(
        () => resolveLaneSqlitePath(lane, given),
        (error: unknown) => {
          assert.ok(error instanceof RetiredLaneSqlitePathError)
          assert.match(error.message, new RegExp(`\\b${lane}\\b`))
          assert.match(error.message, new RegExp(`\\b${retired}\\b`))
          assert.match(error.message, new RegExp(`\\b${LANE_SQLITE_FILENAMES[lane]}\\b`))
          assert.match(error.message, /see #369/)
          return true
        },
        `expected ${lane} path '${given}' to be rejected`,
      )
    }
    for (const otherLane of RETIRED_LANE_SQLITE_FILENAMES.map((name) => (name === 'news.sqlite' ? 'news' : 'polymarket'))) {
      if (otherLane === lane) continue
      assert.throws(() => resolveLaneSqlitePath(otherLane, retired), RetiredLaneSqlitePathError)
    }
  }
})

test('only exact retired basenames are rejected', () => {
  const similar = ['news-lane.sqlite', 'pipeline-lane.sqlite', 'my-pipeline.sqlite', 'pipeline.sqlite.bak',
    'mynews.sqlite', 'news.sqlite.new', 'pipeline2.sqlite', 'backups/news-lane.sqlite', 'news-lane.sqlite.old']
  for (const name of similar) {
    for (const lane of ['news', 'polymarket'] as const) {
      const resolved = resolveLaneSqlitePath(lane, `/tmp/stores/${name}`)
      assert.equal(basename(resolved), basename(name))
    }
  }
})

test('absolute paths are returned normalized, relative paths anchor at baseDir or cwd', () => {
  assert.equal(resolveLaneSqlitePath('news', '/srv/data/news-lane.sqlite'), resolve('/srv/data/news-lane.sqlite'))
  assert.equal(
    resolveLaneSqlitePath('polymarket', 'relative/dir/polymarket-lane.sqlite', { baseDir: '/base' }),
    resolve('/base', 'relative/dir/polymarket-lane.sqlite'),
  )
  assert.equal(
    resolveLaneSqlitePath('news', 'news-lane.sqlite'),
    resolve(process.cwd(), 'news-lane.sqlite'),
  )
})

test('resolveLaneSqlitePathFromEnv reads the lane env vars', () => {
  assert.equal(
    resolveLaneSqlitePathFromEnv('news', { NEWS_SQLITE_PATH: '/run/news-lane.sqlite' }),
    resolve('/run/news-lane.sqlite'),
  )
  assert.equal(
    resolveLaneSqlitePathFromEnv('polymarket', { PIPELINE_SQLITE_PATH: '/run/polymarket-lane.sqlite' }),
    resolve('/run/polymarket-lane.sqlite'),
  )
  assert.equal(
    resolveLaneSqlitePathFromEnv('news', { NEWS_SQLITE_PATH: '  ' }),
    DEFAULT_NEWS_LANE_SQLITE_PATH,
  )
  assert.equal(
    resolveLaneSqlitePathFromEnv('polymarket', {}),
    DEFAULT_POLYMARKET_LANE_SQLITE_PATH,
  )
  assert.throws(() => resolveLaneSqlitePathFromEnv('polymarket', { PIPELINE_SQLITE_PATH: '/x/pipeline.sqlite' }), RetiredLaneSqlitePathError)
  assert.throws(() => resolveLaneSqlitePathFromEnv('news', { NEWS_SQLITE_PATH: '/x/news.sqlite' }), RetiredLaneSqlitePathError)
})