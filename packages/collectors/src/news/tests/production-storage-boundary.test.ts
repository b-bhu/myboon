import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'

const repoRoot = resolve(__dirname, '..', '..', '..', '..', '..')

test('PM2 news workers share the local SQLite store entrypoints', () => {
  const ecosystem = readFileSync(resolve(repoRoot, 'ecosystem.config.cjs'), 'utf8')

  assert.match(ecosystem, /name: 'myboon-news-feed-ingestor'[\s\S]*?script: 'src\/news\/run-news-feed-ingestor\.ts'[\s\S]*?NEWS_SQLITE_PATH: '\.data\/news\.sqlite'/)
  assert.match(ecosystem, /name: 'myboon-news-researcher'[\s\S]*?script: 'src\/news\/run-news\.ts'[\s\S]*?NEWS_SQLITE_PATH: '\.data\/news\.sqlite'/)
  assert.match(ecosystem, /name: 'myboon-news-entity-manager'[\s\S]*?script: 'src\/entity-manager\/run-news\.ts'[\s\S]*?NEWS_SQLITE_PATH: '\.data\/news\.sqlite'/)

  assert.doesNotMatch(ecosystem, /myboon-news-(?:feed-ingestor|researcher|entity-manager)[\s\S]*?run-news[^'\n]*-supabase/)
})

test('continuous local news workers schedule their configured intervals', () => {
  const researcher = readFileSync(resolve(repoRoot, 'packages/collectors/src/news/run-news.ts'), 'utf8')
  const entityManager = readFileSync(resolve(repoRoot, 'packages/collectors/src/entity-manager/run-news.ts'), 'utf8')

  assert.match(researcher, /startIntervalRunner\([\s\S]*?NEWS_RESEARCHER_INTERVAL_MS|newsResearchIntervalMs\(\)/)
  assert.match(entityManager, /startIntervalRunner\([\s\S]*?ENTITY_MANAGER_NEWS_INTERVAL_MS/)
  assert.match(researcher, /new SqliteNewsStore\(process\.env\.NEWS_SQLITE_PATH\)/)
  assert.match(entityManager, /new SqliteNewsStore\(process\.env\.NEWS_SQLITE_PATH\)/)
  assert.match(entityManager, /new SupabaseEntityMemoryStore\(supabase\)/)
})

test('retired Supabase news entrypoints and scripts stay removed', () => {
  const retiredEntrypoints = [
    'packages/collectors/src/news/supabase-store.ts',
    'packages/collectors/src/news/run-news-supabase.ts',
    'packages/collectors/src/news/run-news-feed-ingestor-supabase.ts',
    'packages/collectors/src/entity-manager/run-news-supabase.ts',
  ]

  for (const entrypoint of retiredEntrypoints) {
    assert.equal(existsSync(resolve(repoRoot, entrypoint)), false, `${entrypoint} must remain retired`)
  }

  const packageJson = JSON.parse(
    readFileSync(resolve(repoRoot, 'packages/collectors/package.json'), 'utf8')
  ) as { scripts?: Record<string, string> }
  const scripts = packageJson.scripts ?? {}

  assert.equal(scripts['news:research:supabase'], undefined)
  assert.equal(scripts['news:feed:ingest:supabase'], undefined)
  assert.equal(scripts['entity-manager:news:supabase'], undefined)

  const newsIndex = readFileSync(resolve(repoRoot, 'packages/collectors/src/news/index.ts'), 'utf8')
  assert.doesNotMatch(newsIndex, /supabase-store/)
})

test('retirement migration drops only the approved temporary pipeline tables', () => {
  const migrationsDir = resolve(repoRoot, 'supabase/migrations')
  const matches = readdirSync(migrationsDir).filter((name) => name.endsWith('_drop_retired_pipeline_tables.sql'))
  assert.deepEqual(matches, ['20260818113845_drop_retired_pipeline_tables.sql'])

  const migration = readFileSync(resolve(migrationsDir, matches[0]), 'utf8')
  const droppedTables = [...migration.matchAll(/drop table if exists public\.([a-z0-9_]+);/gi)].map(
    (match) => match[1]
  )

  assert.deepEqual(droppedTables, [
    'news_research_results',
    'news_candidate_observations',
    'news_source_runs',
    'polymarket_market_editor_decisions',
    'polymarket_market_candidate_research',
    'polymarket_market_candidates',
    'polymarket_market_watchlist',
    'editor_drafts',
  ])
  assert.doesNotMatch(migration, /drop\s+table[^;\n]*\bcascade\b/i)

  for (const keptTable of [
    'entities',
    'entity_memories',
    'entity_published_history',
    'published_narratives',
    'pipeline_runs',
  ]) {
    assert.doesNotMatch(migration, new RegExp(`drop\\s+table[^;]*\\b${keptTable}\\b`, 'i'))
  }
})
