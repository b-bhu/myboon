-- Editor Draft V1: internal editorial decisions over entity memory bundles.
-- Entity memories remain append-only; a memory is considered reviewed once its
-- id appears in editor_drafts.source_memory_ids.

CREATE TABLE IF NOT EXISTS public.editor_drafts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id uuid NOT NULL REFERENCES public.entities(id) ON DELETE CASCADE,
  entity_slug text NOT NULL,
  entity_name text NOT NULL,
  entity_type text NOT NULL,
  bundle_key text NOT NULL,
  source_memory_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  source_memory_hash text NOT NULL,
  source text,
  source_area text,
  action text NOT NULL CHECK (
    action IN (
      'draft_post',
      'watch',
      'skip_repetitive',
      'needs_more_research',
      'merge_with_existing_draft'
    )
  ),
  status text NOT NULL CHECK (
    status IN (
      'drafted',
      'watching',
      'skipped',
      'needs_more_research',
      'merged'
    )
  ),
  title text,
  angle text,
  summary text,
  body text,
  reasoning text NOT NULL,
  reason_codes jsonb NOT NULL DEFAULT '[]'::jsonb,
  evidence_quality text CHECK (
    evidence_quality IS NULL OR evidence_quality IN ('strong', 'medium', 'weak')
  ),
  priority numeric CHECK (priority IS NULL OR (priority >= 0 AND priority <= 100)),
  confidence numeric CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
  merge_target_draft_id uuid REFERENCES public.editor_drafts(id) ON DELETE SET NULL,
  related_draft_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  follow_up_questions jsonb NOT NULL DEFAULT '[]'::jsonb,
  research_instructions text,
  backend text NOT NULL DEFAULT 'hermes_cli',
  model text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS editor_drafts_bundle_key_unique_idx
  ON public.editor_drafts (bundle_key);

CREATE INDEX IF NOT EXISTS editor_drafts_entity_created_idx
  ON public.editor_drafts (entity_id, created_at DESC);

CREATE INDEX IF NOT EXISTS editor_drafts_action_status_idx
  ON public.editor_drafts (action, status, created_at DESC);

CREATE INDEX IF NOT EXISTS editor_drafts_source_idx
  ON public.editor_drafts (source, source_area, created_at DESC);

CREATE INDEX IF NOT EXISTS editor_drafts_source_memory_ids_idx
  ON public.editor_drafts USING GIN (source_memory_ids);

ALTER TABLE public.editor_drafts ENABLE ROW LEVEL SECURITY;
