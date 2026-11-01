-- Feed V3 reset: Polymarket Editor.

ALTER TABLE public.polymarket_market_candidate_research
  DROP CONSTRAINT IF EXISTS polymarket_market_candidate_research_status_check;

ALTER TABLE public.polymarket_market_candidate_research
  ADD CONSTRAINT polymarket_market_candidate_research_status_check CHECK (
    status IN (
      'pending_editor',
      'editing',
      'edited',
      'rejected',
      'needs_more_research',
      'published'
    )
  );

CREATE TABLE IF NOT EXISTS public.polymarket_market_editor_decisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source text NOT NULL DEFAULT 'polymarket',
  area text NOT NULL DEFAULT 'markets',
  research_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  decision text NOT NULL CHECK (
    decision IN ('publish', 'reject', 'needs_more_research')
  ),
  status text NOT NULL CHECK (
    status IN ('pending_publisher', 'rejected', 'needs_more_research', 'published')
  ),
  angle text,
  why_this_matters text,
  reasoning text NOT NULL,
  reason_codes jsonb NOT NULL DEFAULT '[]'::jsonb,
  evidence_quality text NOT NULL CHECK (
    evidence_quality IN ('strong', 'medium', 'weak')
  ),
  primary_topic text,
  related_topics jsonb NOT NULL DEFAULT '[]'::jsonb,
  topic_confidence text CHECK (
    topic_confidence IS NULL OR topic_confidence IN ('high', 'medium', 'low')
  ),
  publisher_notes text,
  follow_up_questions jsonb NOT NULL DEFAULT '[]'::jsonb,
  research_instructions text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS polymarket_market_editor_decisions_status_idx
  ON public.polymarket_market_editor_decisions (status, created_at DESC);

CREATE INDEX IF NOT EXISTS polymarket_market_editor_decisions_source_area_idx
  ON public.polymarket_market_editor_decisions (source, area, created_at DESC);

CREATE INDEX IF NOT EXISTS polymarket_market_editor_decisions_research_ids_idx
  ON public.polymarket_market_editor_decisions USING GIN (research_ids);

ALTER TABLE public.polymarket_market_editor_decisions ENABLE ROW LEVEL SECURITY;
