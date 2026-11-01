-- Feed V3 reset: Polymarket Researcher.

ALTER TABLE public.polymarket_market_candidates
  ADD COLUMN IF NOT EXISTS research_error text,
  ADD COLUMN IF NOT EXISTS research_attempted_at timestamptz;

ALTER TABLE public.polymarket_market_candidates
  DROP CONSTRAINT IF EXISTS polymarket_market_candidates_status_check;

ALTER TABLE public.polymarket_market_candidates
  ADD CONSTRAINT polymarket_market_candidates_status_check CHECK (
    status IN (
      'pending_research',
      'researching',
      'researched',
      'skipped_recently_researched',
      'research_failed',
      'rejected',
      'published'
    )
  );

CREATE TABLE IF NOT EXISTS public.polymarket_market_candidate_research (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  candidate_id uuid NOT NULL REFERENCES public.polymarket_market_candidates(id) ON DELETE CASCADE,
  source text NOT NULL DEFAULT 'polymarket',
  area text NOT NULL DEFAULT 'markets',
  slug text NOT NULL,
  title text NOT NULL,
  candidate_type text NOT NULL,
  research_mode text NOT NULL,
  summary text NOT NULL,
  notes text NOT NULL,
  key_findings jsonb NOT NULL DEFAULT '[]'::jsonb,
  evidence_links jsonb NOT NULL DEFAULT '[]'::jsonb,
  related_context jsonb NOT NULL DEFAULT '[]'::jsonb,
  uncertainty text NOT NULL,
  editor_notes text NOT NULL,
  status text NOT NULL DEFAULT 'pending_editor' CHECK (
    status IN ('pending_editor', 'editing', 'edited', 'rejected', 'published')
  ),
  researched_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (candidate_id)
);

CREATE INDEX IF NOT EXISTS polymarket_market_candidate_research_candidate_idx
  ON public.polymarket_market_candidate_research (candidate_id);

CREATE INDEX IF NOT EXISTS polymarket_market_candidate_research_slug_time_idx
  ON public.polymarket_market_candidate_research (slug, researched_at DESC);

CREATE INDEX IF NOT EXISTS polymarket_market_candidate_research_status_idx
  ON public.polymarket_market_candidate_research (status, researched_at DESC);

ALTER TABLE public.polymarket_market_candidate_research ENABLE ROW LEVEL SECURITY;
