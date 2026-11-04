import type { Pool } from 'pg';

/** Fill atlas.entity_aliases (#566) from each entity's name, slug and alias array, like the backfill. */
export async function seedAliases(p: Pool): Promise<void> {
  await p.query(`insert into atlas.entity_aliases (entity_id, type, alias)
    select e.id, e.type, a from atlas.entities e, unnest(array[e.name, replace(e.slug, '-', ' ')] || coalesce(e.aliases, '{}')) a
    on conflict do nothing`);
}
