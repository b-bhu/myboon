/**
 * #571 task 1: the analyst now reads the whole atlas.signals row for the handoff, but analyst_worker
 * only has column grants for the claim path. Until DB Guy's task 2 migration grants these columns,
 * the DB tests apply the same grant on their throwaway database. Prod needs that migration first.
 */
export const HANDOFF_SIGNAL_GRANT =
  'grant select (schema_version, type, priority, fetched_at, numbers, raw_ids, unusual_score, raw_hash) on atlas.signals to analyst_worker';
