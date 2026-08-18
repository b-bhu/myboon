import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
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
