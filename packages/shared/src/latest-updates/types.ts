/**
 * Response types for `GET /latest-updates`, exactly as in the #623 "API contract".
 * Timestamps are ISO-8601 strings. Internal columns (`claims`, `model`, `run_id`,
 * `visibility`) are never returned and are deliberately not part of these types.
 */

/** One source item behind a latest update (from `latest_update_items` joined to `entity_items`). */
export interface LatestUpdateSource {
  /** `atlas.entity_items.id` (uuid). */
  itemId: string
  title: string
  /** Origin signal link, `https://…`. */
  link: string
  /** ISO-8601 time the source event happened. */
  occurredAt: string
}

/** A published latest update for one entity. */
export interface LatestUpdate {
  /** `atlas.latest_updates.id` (uuid). */
  id: string
  entitySlug: string
  entityName: string
  /** Atlas entity type, for example `asset`, `organization` or `protocol`. */
  entityType: string
  headline: string
  whatHappened: string
  howWeGotHere: string
  whatToWatch: string
  sources: LatestUpdateSource[]
  /** ISO-8601 publish time. */
  publishedAt: string
}

/** `GET /latest-updates` response. `updates` is empty (HTTP 200) when nothing is live. */
export interface LatestUpdatesResponse {
  updates: LatestUpdate[]
}
