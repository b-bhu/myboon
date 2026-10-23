-- #336 item 1 (PR B): execute the fixed article_writer_v1 call set as the
-- dedicated writer login. THROWAWAY CLUSTER ONLY. Requires w2_inputs from the
-- inputs.sql file (same session), and a transaction the caller wraps around
-- everything (BEGIN before inputs.sql, ROLLBACK after this file).
\set ON_ERROR_STOP on
DROP TABLE IF EXISTS w2_results;
CREATE TEMP TABLE w2_results(k text PRIMARY KEY, state text, detail text, out_json text, ms numeric);
GRANT SELECT, INSERT ON w2_results TO myboon_v4_worker;
GRANT SELECT ON w2_inputs TO myboon_v4_worker;
SET SESSION AUTHORIZATION myboon_v4_worker;
DO $call$
DECLARE r record; t0 timestamptz; st text; dt text; ok boolean; result jsonb;
BEGIN
  FOR r IN SELECT k, kind, input FROM w2_inputs ORDER BY k LOOP
    t0 := clock_timestamp(); ok := true; result := NULL; st := 'OK'; dt := NULL;
    BEGIN
      result := managed_knowledge_private.article_writer_v1(r.kind, r.input);
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS st = RETURNED_SQLSTATE, dt = PG_EXCEPTION_DETAIL;
      ok := false;
    END;
    INSERT INTO w2_results(k, state, detail, out_json, ms) VALUES (r.k, st, coalesce(left(dt,120),'-'),
      CASE WHEN NOT ok THEN NULL
           WHEN r.kind = 'source' THEN result::text
           ELSE ((result->'receipt') - 'committedAt')::text END,
      round(extract(epoch from clock_timestamp() - t0) * 1000)::numeric(12,1));
    RAISE NOTICE 'w2call % kind=% ms=% state=% detail=%', r.k, r.kind,
      round(extract(epoch from clock_timestamp() - t0) * 1000)::numeric(12,1), st, coalesce(left(dt,80),'-');
  END LOOP;
END
$call$;
RESET SESSION AUTHORIZATION;
\pset footer off
\echo == w2 results (normalized outputs)
SELECT k, state, ms, detail, out_json FROM w2_results ORDER BY k;