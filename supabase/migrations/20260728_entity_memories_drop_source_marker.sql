-- Close the door that let pipeline bookkeeping into entity_memories.
--
-- The entity manager used to record its own progress as rows in
-- entity_memories with memory_type = 'source_marker' (titled
-- 'entity_manager:processed' / 'entity_manager:failed'), then read them back
-- each run to find where it left off. Those rows carry no entity_id and are not
-- memories about anything -- they are the pipeline talking to itself inside the
-- product table. At their peak they were 858 of 1821 rows.
--
-- The 858 rows were deleted ahead of this migration. This removes the schema
-- exception that permitted them, so the database now rejects any memory that
-- does not belong to an entity. Progress tracking moves to the local pipeline
-- store (see the entity pipeline rebuild PRD, issue #256).

-- Guard: refuse to apply if any source_marker rows remain. Running this against
-- a database that still has them would fail on the constraint rebuild below
-- with a less obvious error.
DO $$
DECLARE
  marker_count bigint;
  orphan_count bigint;
BEGIN
  SELECT count(*) INTO marker_count
  FROM public.entity_memories
  WHERE memory_type = 'source_marker';

  IF marker_count > 0 THEN
    RAISE EXCEPTION
      'entity_memories still has % source_marker row(s); delete them before applying this migration',
      marker_count;
  END IF;

  SELECT count(*) INTO orphan_count
  FROM public.entity_memories
  WHERE entity_id IS NULL;

  IF orphan_count > 0 THEN
    RAISE EXCEPTION
      'entity_memories has % row(s) with a null entity_id; every memory must belong to an entity',
      orphan_count;
  END IF;
END $$;

-- 1. Drop the table-level exception that allowed a null entity_id.
--    Postgres named this anonymously; entity_memories_check is the literal name.
ALTER TABLE public.entity_memories
  DROP CONSTRAINT IF EXISTS entity_memories_check;

-- 2. Every memory must now belong to an entity. Enforced by the column itself
--    rather than by a conditional check.
ALTER TABLE public.entity_memories
  ALTER COLUMN entity_id SET NOT NULL;

-- 3. Remove 'source_marker' from the allowed memory types so the type cannot
--    come back.
ALTER TABLE public.entity_memories
  DROP CONSTRAINT IF EXISTS entity_memories_memory_type_check;

ALTER TABLE public.entity_memories
  ADD CONSTRAINT entity_memories_memory_type_check CHECK (
    memory_type IN (
      'research_note',
      'market_signal',
      'news_event',
      'social_signal',
      'timeline_event',
      'metric_change'
    )
  );

-- 4. The partial index on (entity_id, observed_at) carried a
--    WHERE entity_id IS NOT NULL clause that is now redundant, since the column
--    is NOT NULL. Rebuild it without the predicate so the planner can use it
--    unconditionally.
DROP INDEX IF EXISTS public.entity_memories_entity_time_idx;

CREATE INDEX IF NOT EXISTS entity_memories_entity_time_idx
  ON public.entity_memories (entity_id, observed_at DESC);
