-- LOCAL-ONLY behavioural assertions for #365 (never run against prod).
-- Runs against the throwaway Postgres built by
-- 20261019180000_published_narratives_enable_rls.local-setup.sql: it FAILS
-- before the migration (anon sees the fixture rows) and must PASS after
-- 20261019180000_published_narratives_enable_rls.sql. Each section runs as its
-- role via SET ROLE; RESET ROLE between sections. Any failed assertion raises,
-- so drive it with ON_ERROR_STOP=1.

SET ROLE anon;

DO $assert$
DECLARE
  visible bigint;
  touched bigint;
BEGIN
  SELECT count(*) INTO visible FROM public.published_narratives;
  IF visible <> 0 THEN
    RAISE EXCEPTION 'anon expected 0 visible rows after RLS, saw %', visible;
  END IF;

  UPDATE public.published_narratives SET content_small = 'x';
  GET DIAGNOSTICS touched = ROW_COUNT;
  IF touched <> 0 THEN
    RAISE EXCEPTION 'anon UPDATE touched % rows, expected 0', touched;
  END IF;

  DELETE FROM public.published_narratives;
  GET DIAGNOSTICS touched = ROW_COUNT;
  IF touched <> 0 THEN
    RAISE EXCEPTION 'anon DELETE touched % rows, expected 0', touched;
  END IF;

  BEGIN
    INSERT INTO public.published_narratives (content_small) VALUES ('anon probe');
    RAISE EXCEPTION 'anon INSERT unexpectedly succeeded';
  EXCEPTION
    WHEN insufficient_privilege THEN
      RAISE NOTICE 'anon INSERT blocked as expected (SQLSTATE %, %)', SQLSTATE, SQLERRM;
  END;
END
$assert$;

RESET ROLE;

SET ROLE authenticated;

DO $assert$
DECLARE
  visible bigint;
  touched bigint;
BEGIN
  SELECT count(*) INTO visible FROM public.published_narratives;
  IF visible <> 0 THEN
    RAISE EXCEPTION 'authenticated expected 0 visible rows after RLS, saw %', visible;
  END IF;

  UPDATE public.published_narratives SET content_small = 'x';
  GET DIAGNOSTICS touched = ROW_COUNT;
  IF touched <> 0 THEN
    RAISE EXCEPTION 'authenticated UPDATE touched % rows, expected 0', touched;
  END IF;

  DELETE FROM public.published_narratives;
  GET DIAGNOSTICS touched = ROW_COUNT;
  IF touched <> 0 THEN
    RAISE EXCEPTION 'authenticated DELETE touched % rows, expected 0', touched;
  END IF;

  BEGIN
    INSERT INTO public.published_narratives (content_small) VALUES ('authenticated probe');
    RAISE EXCEPTION 'authenticated INSERT unexpectedly succeeded';
  EXCEPTION
    WHEN insufficient_privilege THEN
      RAISE NOTICE 'authenticated INSERT blocked as expected (SQLSTATE %, %)', SQLSTATE, SQLERRM;
  END;
END
$assert$;

RESET ROLE;

SET ROLE service_role;

DO $assert$
DECLARE
  visible bigint;
  touched bigint;
  probe_id uuid;
BEGIN
  SELECT count(*) INTO visible FROM public.published_narratives;
  IF visible <> 3 THEN
    RAISE EXCEPTION 'service_role expected 3 visible rows (BYPASSRLS), saw %', visible;
  END IF;

  INSERT INTO public.published_narratives (content_small)
    VALUES ('service_role probe')
    RETURNING id INTO probe_id;
  RAISE NOTICE 'service_role INSERT succeeded (%)', probe_id;

  UPDATE public.published_narratives SET content_small = content_small
    WHERE id = probe_id;
  GET DIAGNOSTICS touched = ROW_COUNT;
  IF touched < 1 THEN
    RAISE EXCEPTION 'service_role UPDATE touched % rows, expected >= 1', touched;
  END IF;

  DELETE FROM public.published_narratives WHERE id = probe_id;
  GET DIAGNOSTICS touched = ROW_COUNT;
  IF touched <> 1 THEN
    RAISE EXCEPTION 'service_role DELETE touched % rows, expected 1', touched;
  END IF;
END
$assert$;

RESET ROLE;

DO $done$
BEGIN
  RAISE NOTICE 'published_narratives RLS local assertions passed';
END
$done$;
