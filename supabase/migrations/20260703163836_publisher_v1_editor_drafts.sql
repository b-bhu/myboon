-- Publisher V1: deterministic publishing from editor_drafts into the public feed.
-- Additive/backwards-compatible for existing published_narratives rows.

ALTER TABLE public.editor_drafts
  DROP CONSTRAINT IF EXISTS editor_drafts_status_check;

ALTER TABLE public.editor_drafts
  ADD CONSTRAINT editor_drafts_status_check CHECK (
    status IN (
      'drafted',
      'watching',
      'skipped',
      'needs_more_research',
      'merged',
      'published'
    )
  );

ALTER TABLE public.published_narratives
  ADD COLUMN IF NOT EXISTS title text;

ALTER TABLE public.published_narratives
  ADD COLUMN IF NOT EXISTS published_at timestamptz;

UPDATE public.published_narratives
SET published_at = COALESCE(published_at, created_at, now())
WHERE published_at IS NULL;

ALTER TABLE public.published_narratives
  ALTER COLUMN published_at SET DEFAULT now();

ALTER TABLE public.published_narratives
  ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'published';

ALTER TABLE public.published_narratives
  DROP CONSTRAINT IF EXISTS published_narratives_status_check;

ALTER TABLE public.published_narratives
  ADD CONSTRAINT published_narratives_status_check CHECK (
    status IN ('published', 'archived')
  );

ALTER TABLE public.published_narratives
  ADD COLUMN IF NOT EXISTS editor_draft_id uuid REFERENCES public.editor_drafts(id) ON DELETE SET NULL;

ALTER TABLE public.published_narratives
  ADD COLUMN IF NOT EXISTS entity_id uuid REFERENCES public.entities(id) ON DELETE SET NULL;

ALTER TABLE public.published_narratives
  ADD COLUMN IF NOT EXISTS entity_slug text;

ALTER TABLE public.published_narratives
  ADD COLUMN IF NOT EXISTS entity_name text;

ALTER TABLE public.published_narratives
  ADD COLUMN IF NOT EXISTS entity_type text;

ALTER TABLE public.published_narratives
  ADD COLUMN IF NOT EXISTS entity_category text;

ALTER TABLE public.published_narratives
  ADD COLUMN IF NOT EXISTS source_memory_ids jsonb NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE public.published_narratives
  ADD COLUMN IF NOT EXISTS source_memory_hash text;

ALTER TABLE public.published_narratives
  ADD COLUMN IF NOT EXISTS source_area text;

ALTER TABLE public.published_narratives
  ADD COLUMN IF NOT EXISTS angle text;

ALTER TABLE public.published_narratives
  ADD COLUMN IF NOT EXISTS evidence_quality text CHECK (
    evidence_quality IS NULL OR evidence_quality IN ('strong', 'medium', 'weak')
  );

ALTER TABLE public.published_narratives
  ADD COLUMN IF NOT EXISTS confidence numeric CHECK (
    confidence IS NULL OR (confidence >= 0 AND confidence <= 1)
  );

WITH duplicate_editor_drafts AS (
  SELECT
    id,
    row_number() OVER (
      PARTITION BY editor_draft_id
      ORDER BY published_at DESC NULLS LAST, created_at DESC NULLS LAST, id DESC
    ) AS duplicate_rank
  FROM public.published_narratives
  WHERE editor_draft_id IS NOT NULL
)
DELETE FROM public.published_narratives p
USING duplicate_editor_drafts d
WHERE p.id = d.id
  AND d.duplicate_rank > 1;

CREATE UNIQUE INDEX IF NOT EXISTS published_narratives_editor_draft_unique_idx
  ON public.published_narratives (editor_draft_id)
  WHERE editor_draft_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS published_narratives_status_published_idx
  ON public.published_narratives (status, published_at DESC, priority DESC);

CREATE INDEX IF NOT EXISTS published_narratives_entity_published_idx
  ON public.published_narratives (entity_id, published_at DESC)
  WHERE entity_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS published_narratives_source_memory_ids_v1_idx
  ON public.published_narratives USING GIN (source_memory_ids);

CREATE TABLE IF NOT EXISTS public.entity_published_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  published_narrative_id uuid NOT NULL REFERENCES public.published_narratives(id) ON DELETE CASCADE,
  entity_id uuid REFERENCES public.entities(id) ON DELETE SET NULL,
  entity_slug text,
  title text,
  angle text,
  summary text,
  content text,
  source text,
  source_area text,
  published_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS entity_published_history_narrative_unique_idx
  ON public.entity_published_history (published_narrative_id);

CREATE INDEX IF NOT EXISTS entity_published_history_entity_idx
  ON public.entity_published_history (entity_id, published_at DESC)
  WHERE entity_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS entity_published_history_slug_idx
  ON public.entity_published_history (entity_slug, published_at DESC)
  WHERE entity_slug IS NOT NULL;

ALTER TABLE public.entity_published_history ENABLE ROW LEVEL SECURITY;
