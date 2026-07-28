-- Dedicated idempotency log for manual Entity commands (dashboard/CLI/Codex).
--
-- `entity-manager/entity-service.ts`'s `findAppliedCommand` used to record a
-- `manual_change:applied` marker as an entity_memories row with
-- memory_type = 'source_marker' and entity_id = null, purely so a replayed
-- requestId could be recognized and rejected (or accepted as a no-op) instead
-- of re-applying. entity_memories no longer allows either a null entity_id or
-- memory_type = 'source_marker' (see entity_memories_drop_source_marker), and
-- a manual command that CREATES an entity has no entity_id to attach to at
-- write time anyway, so this bookkeeping gets its own tiny table instead of
-- trying to force it back into the product entity graph.

CREATE TABLE IF NOT EXISTS public.manual_command_log (
  request_id text PRIMARY KEY,
  command_hash text NOT NULL,
  actor jsonb NOT NULL,
  entity_id uuid REFERENCES public.entities(id) ON DELETE SET NULL,
  applied_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.manual_command_log ENABLE ROW LEVEL SECURITY;
