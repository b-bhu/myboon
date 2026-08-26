-- Stable Entity Memory replay identity.
--
-- Existing rows are retained one-for-one. Their compatibility identity hashes
-- the exact columns in the former unique tuple, including title, so the
-- backfill cannot merge or reinterpret legacy memories. Canonical Feed V3
-- writers provide a title-independent myboon.memory_identity.v1 key instead.

CREATE SCHEMA IF NOT EXISTS extensions;
CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions;

ALTER TABLE public.entity_memories
  ADD COLUMN memory_identity_key text;

UPDATE public.entity_memories
SET memory_identity_key =
  'myboon.memory_identity.v1:legacy:' ||
  encode(
    extensions.digest(
      convert_to(
        concat_ws(
          chr(31),
          source,
          source_area,
          source_research_id,
          COALESCE(entity_id::text, ''),
          memory_type,
          title
        ),
        'UTF8'
      ),
      'sha256'
    ),
    'hex'
  );

ALTER TABLE public.entity_memories
  ALTER COLUMN memory_identity_key SET NOT NULL,
  ADD CONSTRAINT entity_memories_identity_key_format_check CHECK (
    memory_identity_key ~ '^myboon\.memory_identity\.v1:(legacy:)?[0-9a-f]{64}$'
  );

CREATE UNIQUE INDEX entity_memories_identity_key_unique_idx
  ON public.entity_memories (memory_identity_key);

COMMENT ON COLUMN public.entity_memories.memory_identity_key IS
  'Code-owned myboon.memory_identity.v1 replay identity; canonical keys do not depend on generated wording.';
