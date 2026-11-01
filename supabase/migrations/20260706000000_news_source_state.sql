-- News source lane state.
-- Mirrors the local SQLite news tables closely enough for the collector and
-- Entity Manager handoff while keeping production access service-role only.

CREATE TABLE IF NOT EXISTS public.news_source_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id text NOT NULL UNIQUE,
  source_id text NOT NULL,
  source_name text NOT NULL,
  source_type text NOT NULL DEFAULT 'curated_news' CHECK (source_type IN ('curated_news')),
  url_id text NOT NULL,
  url_label text NOT NULL,
  source_url text NOT NULL,
  task_type text NOT NULL DEFAULT 'source_scout' CHECK (task_type IN ('source_scout')),
  status text NOT NULL DEFAULT 'queued' CHECK (
    status IN (
      'queued',
      'running',
      'succeeded',
      'result_validated',
      'candidates_classified',
      'candidates_ingested',
      'failed_transient',
      'retry_scheduled',
      'failed_permanent'
    )
  ),
  observed_at timestamptz,
  started_at timestamptz,
  finished_at timestamptz,
  candidates_found integer NOT NULL DEFAULT 0 CHECK (candidates_found >= 0),
  candidates_new integer NOT NULL DEFAULT 0 CHECK (candidates_new >= 0),
  candidates_unchanged integer NOT NULL DEFAULT 0 CHECK (candidates_unchanged >= 0),
  candidates_materially_changed integer NOT NULL DEFAULT 0 CHECK (candidates_materially_changed >= 0),
  candidates_invalid integer NOT NULL DEFAULT 0 CHECK (candidates_invalid >= 0),
  raw_response jsonb,
  validated_payload jsonb,
  error text CHECK (error IS NULL OR char_length(error) <= 4000),
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  next_retry_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS news_source_runs_source_url_time_idx
  ON public.news_source_runs (source_id, url_id, created_at DESC);

CREATE INDEX IF NOT EXISTS news_source_runs_status_idx
  ON public.news_source_runs (status, next_retry_at, created_at DESC);

CREATE TABLE IF NOT EXISTS public.news_candidate_observations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_run_id uuid REFERENCES public.news_source_runs(id) ON DELETE SET NULL,
  source_id text NOT NULL,
  source_name text NOT NULL,
  url_id text NOT NULL,
  url_label text NOT NULL,
  source_url text NOT NULL,
  canonical_article_url text NOT NULL,
  headline text NOT NULL,
  visible_summary text,
  published_at timestamptz,
  observed_at timestamptz NOT NULL,
  headline_hash text NOT NULL,
  summary_hash text,
  content_hash text NOT NULL,
  article_identity_key text NOT NULL,
  observation_dedupe_key text NOT NULL UNIQUE,
  dedupe_outcome text NOT NULL CHECK (
    dedupe_outcome IN ('new_candidate', 'known_materially_changed')
  ),
  status text NOT NULL DEFAULT 'pending_research' CHECK (
    status IN (
      'pending_research',
      'research_queued',
      'researching',
      'researched',
      'handed_to_entity_memory',
      'rejected',
      'failed_research'
    )
  ),
  last_research_job_id text,
  research_worker_status text,
  research_error text CHECK (research_error IS NULL OR char_length(research_error) <= 4000),
  research_raw_response text CHECK (research_raw_response IS NULL OR char_length(research_raw_response) <= 16000),
  research_stderr text CHECK (research_stderr IS NULL OR char_length(research_stderr) <= 8000),
  raw_candidate jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS news_candidate_observations_source_url_time_idx
  ON public.news_candidate_observations (source_id, url_id, observed_at DESC);

CREATE INDEX IF NOT EXISTS news_candidate_observations_article_identity_idx
  ON public.news_candidate_observations (article_identity_key, observed_at DESC);

CREATE INDEX IF NOT EXISTS news_candidate_observations_status_idx
  ON public.news_candidate_observations (status, observed_at DESC);

CREATE TABLE IF NOT EXISTS public.news_research_results (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  candidate_observation_id uuid NOT NULL REFERENCES public.news_candidate_observations(id) ON DELETE CASCADE,
  source_id text NOT NULL,
  source_name text NOT NULL,
  url_id text NOT NULL,
  url_label text NOT NULL,
  source_url text NOT NULL,
  canonical_article_url text NOT NULL,
  article_identity_key text NOT NULL,
  observation_dedupe_key text NOT NULL,
  research_job_id text NOT NULL UNIQUE,
  status text NOT NULL CHECK (
    status IN (
      'pending_entity_memory',
      'not_ready_for_entity_memory',
      'handed_to_entity_memory',
      'failed_entity_memory'
    )
  ),
  response_status text NOT NULL CHECK (
    response_status IN ('ready_for_entity_memory', 'needs_followup', 'failed')
  ),
  source_signal jsonb NOT NULL,
  research_summary jsonb NOT NULL,
  article_claims jsonb NOT NULL,
  verified_facts jsonb NOT NULL,
  unresolved_claims jsonb NOT NULL,
  entity_hints jsonb NOT NULL,
  evidence jsonb NOT NULL,
  open_questions jsonb NOT NULL,
  limitations jsonb NOT NULL,
  errors jsonb NOT NULL,
  raw_response jsonb NOT NULL,
  researched_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (candidate_observation_id)
);

CREATE INDEX IF NOT EXISTS news_research_results_status_time_idx
  ON public.news_research_results (status, researched_at DESC);

CREATE INDEX IF NOT EXISTS news_research_results_source_time_idx
  ON public.news_research_results (source_id, url_id, researched_at DESC);

CREATE INDEX IF NOT EXISTS news_research_results_candidate_idx
  ON public.news_research_results (candidate_observation_id);

ALTER TABLE public.news_source_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.news_candidate_observations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.news_research_results ENABLE ROW LEVEL SECURITY;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.news_source_runs TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.news_candidate_observations TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.news_research_results TO service_role;
