-- Entity tags: coarse grouping labels (macro, fed, crypto, geopolitics, ...)
-- distinct from aliases (naming variants used for resolution). Used by feed
-- grouping, the canon shortlist, and - later - the research gate's subject
-- resolution. Additive and nullable-free; existing rows default to empty.
-- Values get seeded by the entity merge/rename pass (reviewed plan) and by
-- the canon-aware extractor for newly created entities.
alter table entities add column if not exists tags text[] not null default '{}';
create index if not exists entities_tags_idx on entities using gin (tags);
