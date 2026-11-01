-- Production pipeline run ledger.
-- Compact stage-level receipts only; do not store raw source/research payloads here.

CREATE TABLE IF NOT EXISTS public.pipeline_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source text NOT NULL,
  source_area text,
  stage text NOT NULL,
  status text NOT NULL CHECK (
    status IN ('running', 'succeeded', 'failed', 'skipped', 'partial')
  ),
  input_ref text,
  output_ref text,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  counts jsonb NOT NULL DEFAULT '{}'::jsonb,
  error text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS pipeline_runs_source_stage_started_idx
  ON public.pipeline_runs (source, source_area, stage, started_at DESC);

CREATE INDEX IF NOT EXISTS pipeline_runs_status_started_idx
  ON public.pipeline_runs (status, started_at DESC);

CREATE INDEX IF NOT EXISTS pipeline_runs_created_idx
  ON public.pipeline_runs (created_at DESC);

ALTER TABLE public.pipeline_runs ENABLE ROW LEVEL SECURITY;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.pipeline_runs TO service_role;
