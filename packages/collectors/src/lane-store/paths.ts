import { basename, resolve } from 'node:path'

/**
 * SQLite file placement for the two source lanes (issue #369). Every reader
 * and writer resolves its database path through `resolveLaneSqlitePath` so a
 * configured legacy filename (`news.sqlite`, `pipeline.sqlite`) fails loudly
 * instead of silently round-tripping data through the retired store files.
 */
export type SqliteLane = 'news' | 'polymarket'

export const LANE_SQLITE_FILENAMES: Readonly<Record<SqliteLane, string>> = {
  news: 'news-lane.sqlite',
  polymarket: 'polymarket-lane.sqlite',
}

/** Basenames the helper refuses to build a path from; see #369. */
export const RETIRED_LANE_SQLITE_FILENAMES: readonly string[] = ['news.sqlite', 'pipeline.sqlite']

export const COLLECTORS_DATA_DIR = resolve(__dirname, '..', '..', '.data')

export const DEFAULT_NEWS_LANE_SQLITE_PATH = resolve(COLLECTORS_DATA_DIR, LANE_SQLITE_FILENAMES.news)
export const DEFAULT_POLYMARKET_LANE_SQLITE_PATH = resolve(COLLECTORS_DATA_DIR, LANE_SQLITE_FILENAMES.polymarket)

export class RetiredLaneSqlitePathError extends Error {}

const LANE_ENV_KEYS: Readonly<Record<SqliteLane, string>> = {
  news: 'NEWS_SQLITE_PATH',
  polymarket: 'PIPELINE_SQLITE_PATH',
}

const LANE_DEFAULT_PATHS: Readonly<Record<SqliteLane, string>> = {
  news: DEFAULT_NEWS_LANE_SQLITE_PATH,
  polymarket: DEFAULT_POLYMARKET_LANE_SQLITE_PATH,
}

/**
 * Resolve a lane's SQLite path. Blank falls back to the lane's default
 * `.data` path; `:memory:` passes through unchanged; a retired basename
 * (`news.sqlite` / `pipeline.sqlite`, exact match) throws; absolute paths are
 * normalized and relative paths anchor at `options.baseDir` (or cwd).
 */
export function resolveLaneSqlitePath(
  lane: SqliteLane,
  path?: string | null,
  options?: { baseDir?: string },
): string {
  const configured = path?.trim()
  if (!configured) return LANE_DEFAULT_PATHS[lane]
  if (configured === ':memory:') return configured
  if (RETIRED_LANE_SQLITE_FILENAMES.includes(basename(configured))) {
    throw new RetiredLaneSqlitePathError(
      `Refusing to resolve ${lane} lane SQLite path: '${basename(configured)}' is a retired store file`
        + ` (given path: '${path}'). Use '${LANE_SQLITE_FILENAMES[lane]}' instead; see #369.`,
    )
  }
  return resolve(options?.baseDir ?? process.cwd(), configured)
}

/**
 * Same resolution from an env-like record: NEWS_SQLITE_PATH for the news
 * lane, PIPELINE_SQLITE_PATH for the polymarket lane.
 */
export function resolveLaneSqlitePathFromEnv(
  lane: SqliteLane,
  env: NodeJS.ProcessEnv | Record<string, string | undefined>,
  options?: { baseDir?: string },
): string {
  return resolveLaneSqlitePath(lane, env[LANE_ENV_KEYS[lane]], options)
}