-- #621 entity manager: claim by scope. NOT APPLIED: needs DB Guy review before prod.
-- atlas.em_claim takes the oldest pending row, so daily-recycled keep rows with no entity (growth, ~80% of
-- recent claims) return to the head of the queue and starve the rows that have an entity. This adds
-- atlas.em_claim_scoped(worker, scope, lease, max_attempts): same claim as em_claim, restricted to
--   scope 'entity'    handoff.entity is an object (the analyst picked an entity)
--   scope 'no_entity' handoff.entity is null or absent (no match; retried once a day by its own run)
-- atlas.em_claim is NOT changed, so the worker with the flag off keeps working with or without this.
-- Same queue, same columns, same finish/fail functions. A new function only: no table, column or index change.
-- Rollback: supabase/rollbacks/20261113190000_atlas_em_claim_scoped.down.sql
begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';

create or replace function atlas.em_claim_scoped(p_worker text, p_scope text,
                                                 p_lease interval default interval '5 minutes',
                                                 p_max_attempts integer default 3)
  returns table (decision_id uuid, signal_id text, claim_token uuid, attempts integer)
  language plpgsql
  set search_path = ''
as $f$
begin
  if p_scope is null or p_scope not in ('entity', 'no_entity') then
    raise exception 'atlas.em_claim_scoped: scope must be entity or no_entity (got %)', p_scope
      using errcode = 'invalid_parameter_value';
  end if;
  update atlas.decisions d
     set em_status = 'failed',
         em_last_error = 'claim expired after max attempts',
         em_claim_token = null, em_claim_expires_at = null, em_claimed_by = null,
         em_done_at = pg_catalog.now()
   where d.em_status = 'claimed'
     and d.em_claim_expires_at < pg_catalog.now()
     and d.em_attempts >= p_max_attempts;
  return query
    update atlas.decisions d
       set em_status = 'claimed',
           em_claim_token = atlas.uuidv7(),
           em_claim_expires_at = pg_catalog.now() + p_lease,
           em_claimed_by = p_worker,
           em_attempts = d.em_attempts + 1
     where d.id = (
             select c.id from atlas.decisions c
              where ((c.em_status = 'pending' and c.em_next_attempt_at <= pg_catalog.now())
                  or (c.em_status = 'claimed' and c.em_claim_expires_at < pg_catalog.now()))
                and coalesce(pg_catalog.jsonb_typeof(c.handoff -> 'entity') = 'object', false) = (p_scope = 'entity')
              order by c.created_at, c.id
              for update skip locked
              limit 1)
    returning d.id, d.signal_id, d.em_claim_token, d.em_attempts;
end $f$;

revoke all on function atlas.em_claim_scoped(text, text, interval, integer) from public;
grant execute on function atlas.em_claim_scoped(text, text, interval, integer) to entity_worker, service_role;

commit;
