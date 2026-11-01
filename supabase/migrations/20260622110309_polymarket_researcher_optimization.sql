-- Feed V3: lightweight Polymarket Researcher optimization metadata.
-- Keep this scoped to existing tables; no new cache/audit tables in this pass.

ALTER TABLE public.polymarket_market_candidates
  ADD COLUMN IF NOT EXISTS research_retry_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS research_next_retry_at timestamptz,
  ADD COLUMN IF NOT EXISTS research_last_error_kind text,
  ADD COLUMN IF NOT EXISTS research_family_key text,
  ADD COLUMN IF NOT EXISTS research_cluster_key text,
  ADD COLUMN IF NOT EXISTS research_depth text;

ALTER TABLE public.polymarket_market_candidates
  DROP CONSTRAINT IF EXISTS polymarket_market_candidates_research_depth_check;

ALTER TABLE public.polymarket_market_candidates
  ADD CONSTRAINT polymarket_market_candidates_research_depth_check CHECK (
    research_depth IS NULL OR research_depth IN (
      'market_structure_only',
      'reuse_prior',
      'deep_web'
    )
  );

CREATE INDEX IF NOT EXISTS polymarket_market_candidates_retry_idx
  ON public.polymarket_market_candidates (status, research_next_retry_at, research_retry_count);

CREATE INDEX IF NOT EXISTS polymarket_market_candidates_research_family_idx
  ON public.polymarket_market_candidates (research_family_key, observed_at DESC);

ALTER TABLE public.polymarket_market_candidate_research
  ADD COLUMN IF NOT EXISTS research_family_key text,
  ADD COLUMN IF NOT EXISTS research_cluster_key text,
  ADD COLUMN IF NOT EXISTS research_depth text NOT NULL DEFAULT 'deep_web',
  ADD COLUMN IF NOT EXISTS evidence_quality text NOT NULL DEFAULT 'medium',
  ADD COLUMN IF NOT EXISTS catalyst_found boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS recommended_editor_action text NOT NULL DEFAULT 'needs_more_research',
  ADD COLUMN IF NOT EXISTS duplicate_of_research_id uuid REFERENCES public.polymarket_market_candidate_research(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS research_backend text NOT NULL DEFAULT 'hermes_cli',
  ADD COLUMN IF NOT EXISTS research_model text;

ALTER TABLE public.polymarket_market_candidate_research
  DROP CONSTRAINT IF EXISTS polymarket_market_candidate_research_depth_check;

ALTER TABLE public.polymarket_market_candidate_research
  ADD CONSTRAINT polymarket_market_candidate_research_depth_check CHECK (
    research_depth IN (
      'market_structure_only',
      'reuse_prior',
      'deep_web'
    )
  );

ALTER TABLE public.polymarket_market_candidate_research
  DROP CONSTRAINT IF EXISTS polymarket_market_candidate_research_evidence_quality_check;

ALTER TABLE public.polymarket_market_candidate_research
  ADD CONSTRAINT polymarket_market_candidate_research_evidence_quality_check CHECK (
    evidence_quality IN ('strong', 'medium', 'weak')
  );

ALTER TABLE public.polymarket_market_candidate_research
  DROP CONSTRAINT IF EXISTS polymarket_market_candidate_research_editor_action_check;

ALTER TABLE public.polymarket_market_candidate_research
  ADD CONSTRAINT polymarket_market_candidate_research_editor_action_check CHECK (
    recommended_editor_action IN (
      'publish_candidate',
      'reject_thin',
      'needs_more_research'
    )
  );

CREATE INDEX IF NOT EXISTS polymarket_market_candidate_research_family_time_idx
  ON public.polymarket_market_candidate_research (research_family_key, researched_at DESC);

CREATE INDEX IF NOT EXISTS polymarket_market_candidate_research_depth_time_idx
  ON public.polymarket_market_candidate_research (research_depth, researched_at DESC);
