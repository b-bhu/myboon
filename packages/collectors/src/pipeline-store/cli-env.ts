/**
 * Shared CLI entrypoint boilerplate: dotenv loading and env-var parsing
 * helpers.
 *
 * Every `run-*.ts` entrypoint across the polymarket/, entity-manager/,
 * editor-draft/, publisher/, hyperliquid/, news/, and pipeline-store/ lanes
 * copy-pasted the same handful of tiny functions (`requiredEnv`,
 * `positiveInteger`, `envFlag`) and the same three-line dotenv load chain.
 * This does not unify the lanes' storage or scheduling (that's
 * `interval-runner.ts`, and PipelineStore itself) - it only removes the
 * copy-pasted parsing/boilerplate layer sitting on top, which had already
 * drifted into two different shapes (top-level three-liner vs. a private
 * `loadRuntimeEnv()` wrapper) despite being character-for-character
 * identical logic everywhere it appeared.
 *
 * Not included here: `envNumber`/inline `Number(...) || fallback` parsing.
 * Those exist in at least two incompatible shapes across the codebase
 * (`Number.isFinite`-based vs `||`-based, with different treatment of `0`
 * and negatives) and unifying them requires auditing each call site's
 * intended semantics - out of scope for a duplication-only extraction.
 */

import { config as loadEnv } from 'dotenv'

/**
 * Loads `.env` from the current working directory, then `../../.env` (the
 * monorepo root, when run from `packages/collectors`), then whatever
 * `dotenv`'s own default resolution finds. Later calls do not override
 * variables a prior call already set (dotenv's default behavior), so this
 * order is: package-local .env wins, then repo-root .env, then dotenv's
 * default search.
 */
export function loadDotenvChain(): void {
  loadEnv({ path: '.env' })
  loadEnv({ path: '../../.env' })
  loadEnv()
}

/** Throws if `name` is not set (or is empty) in `process.env`; otherwise returns it. */
export function requiredEnv(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`Missing required env var: ${name}`)
  return value
}

/**
 * Parses `value` as a positive integer, falling back to `fallback` for
 * anything missing, non-integer, zero, or negative.
 */
export function positiveInteger(value: string | undefined, fallback: number): number {
  if (!value) return fallback
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback
}

/** Parses a boolean CLI/env flag: true for `'1'` or `'true'` (case-insensitive), false otherwise. */
export function envFlag(value: string | undefined): boolean {
  return value === '1' || value?.toLowerCase() === 'true'
}
