-- Bring databases that already applied the draft Entity Manager migration
-- onto the finalized primary-entity memory model.

ALTER TABLE public.entities
  ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'active';

CREATE INDEX IF NOT EXISTS entities_status_idx
  ON public.entities (status, updated_at DESC);

CREATE TABLE IF NOT EXISTS public.entity_memories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id uuid REFERENCES public.entities(id) ON DELETE CASCADE,
  source text NOT NULL,
  source_area text NOT NULL,
  source_type text NOT NULL,
  source_ref_id text NOT NULL,
  source_research_id text NOT NULL,
  memory_type text NOT NULL CHECK (
    memory_type IN (
      'research_note',
      'market_signal',
      'news_event',
      'social_signal',
      'timeline_event',
      'metric_change',
      'source_marker'
    )
  ),
  title text NOT NULL,
  summary text NOT NULL,
  body text,
  event_at timestamptz,
  observed_at timestamptz NOT NULL,
  confidence numeric CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
  evidence jsonb NOT NULL DEFAULT '[]'::jsonb,
  mentions jsonb NOT NULL DEFAULT '[]'::jsonb,
  metrics jsonb NOT NULL DEFAULT '{}'::jsonb,
  context jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (entity_id IS NOT NULL OR memory_type = 'source_marker')
);

CREATE UNIQUE INDEX IF NOT EXISTS entity_memories_source_unique_idx
  ON public.entity_memories (
    source,
    source_area,
    source_research_id,
    entity_id,
    memory_type,
    title
  ) NULLS NOT DISTINCT;

CREATE INDEX IF NOT EXISTS entity_memories_entity_time_idx
  ON public.entity_memories (entity_id, observed_at DESC)
  WHERE entity_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS entity_memories_source_research_idx
  ON public.entity_memories (source, source_area, source_research_id);

CREATE INDEX IF NOT EXISTS entity_memories_source_ref_idx
  ON public.entity_memories (source, source_area, source_type, source_ref_id);

CREATE INDEX IF NOT EXISTS entity_memories_type_time_idx
  ON public.entity_memories (memory_type, observed_at DESC);

CREATE INDEX IF NOT EXISTS entity_memories_mentions_idx
  ON public.entity_memories USING GIN (mentions);

CREATE INDEX IF NOT EXISTS entity_memories_evidence_idx
  ON public.entity_memories USING GIN (evidence);

ALTER TABLE public.entity_memories ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF to_regclass('public.entity_memory_items') IS NOT NULL THEN
    INSERT INTO public.entity_memories (
      entity_id,
      source,
      source_area,
      source_type,
      source_ref_id,
      source_research_id,
      memory_type,
      title,
      summary,
      event_at,
      observed_at,
      evidence,
      context
    )
    SELECT
      NULL,
      legacy.source,
      legacy.source_area,
      'legacy_marker',
      legacy.source_research_id,
      legacy.source_research_id,
      'source_marker',
      legacy.title,
      legacy.summary,
      legacy.observed_at,
      legacy.observed_at,
      legacy.evidence,
      jsonb_build_object('legacy_table', 'entity_memory_items', 'legacy_item_id', legacy.id)
    FROM public.entity_memory_items AS legacy
    WHERE legacy.item_type = 'source_observation'
      AND legacy.title IN ('entity_manager:processed', 'entity_manager:failed')
    ON CONFLICT (source, source_area, source_research_id, entity_id, memory_type, title)
    DO NOTHING;
  END IF;
END $$;
