-- #443 throwaway search proof: local only, never applied to prod (prod indexes are out of scope).
-- FTS + pg_trgm on entity names/aliases, merged by reciprocal rank fusion (k = 60). No pgvector.
create extension if not exists pg_trgm;
create schema if not exists search_test;

-- One row per searchable term (name + each alias), lower-cased.
create table search_test.entity_terms as
select s.id as entity_id, lower(t.term) as term
from atlas.entities s
cross join lateral (select s.name union select unnest(s.aliases)) t(term)
where coalesce(t.term, '') <> '';
create index on search_test.entity_terms (term);
create index on search_test.entity_terms using gin (term gin_trgm_ops);

create table search_test.entity_doc as
select s.id as entity_id,
       setweight(to_tsvector('simple', s.name || ' ' || array_to_string(s.aliases, ' ')), 'A')
       || setweight(to_tsvector('english', coalesce(s.summary, '')), 'C') as doc
from atlas.entities s;
create index on search_test.entity_doc using gin (doc);
analyze search_test.entity_terms; analyze search_test.entity_doc;

-- Lists: exact term, FTS (OR of the query's words), trigram word_similarity of a term inside the query.
create or replace function search_test.search(q text, lim int default 5)
returns table (rank int, slug text, score double precision, exact_r int, fts_r int, trgm_r int)
language sql stable as $$
with qn as (select lower(q) as lq,
                   (select string_agg(quote_literal(w), ' | ')::tsquery
                      from (select distinct unnest(tsvector_to_array(to_tsvector('simple', q))) w) x) as tq_simple,
                   (select string_agg(quote_literal(w), ' | ')::tsquery
                      from (select distinct unnest(tsvector_to_array(to_tsvector('english', q))) w) x) as tq_en),
exact as (
  select t.entity_id, row_number() over (order by length(t.term) desc)::int r
  from search_test.entity_terms t, qn where t.term = qn.lq
  group by t.entity_id, t.term),
fts as (
  select d.entity_id, row_number() over (order by ts_rank_cd(d.doc, qn.tq_simple || qn.tq_en, 1) desc)::int r
  from search_test.entity_doc d, qn
  where d.doc @@ (qn.tq_simple || qn.tq_en)
  order by 2 limit 50),
trgm as (
  select entity_id, row_number() over (order by max(ws) desc, max(len) desc)::int r
  from (select t.entity_id, word_similarity(t.term, qn.lq) ws, length(t.term) len
        from search_test.entity_terms t, qn
        where t.term <% qn.lq and length(t.term) >= 3) x
  group by entity_id order by 2 limit 50),
fused as (
  select entity_id, sum(1.0 / (60 + r)) score,
         max(r) filter (where src = 'e') e, max(r) filter (where src = 'f') f, max(r) filter (where src = 't') t
  from (select entity_id, r, 'e' src from exact union all
        select entity_id, r, 'f' from fts union all
        select entity_id, r, 't' from trgm) u
  group by entity_id)
select row_number() over (order by f.score desc, s.slug)::int, s.slug, f.score::float8, f.e, f.f, f.t
from fused f join atlas.entities s on s.id = f.entity_id
order by f.score desc, s.slug limit lim
$$;
