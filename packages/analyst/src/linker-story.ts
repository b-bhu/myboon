/**
 * #479 Linker + Story: one analyst job on the #478 claim and decider slot.
 *
 * Linker (code, in memory): active entities whose aliases appear in
 *   the signal text + excerpt (case-insensitive, whole word; '$' aliases literal),
 *   ranked by distinct alias hits, then total alias length, then slug. Routing
 *   rules (token vs project pairs, e.g. $UNI vs Uniswap) drop one side of a pair
 *   when both matched, BEFORE the cap of 5. No match parks 'no_match' without a
 *   decider call (the no-match path is the next issue).
 * Story inputs (in memory): up to 5 raw items per entity, the newest plus the
 *   newest of each recent week bucket (0-7d .. 28-35d, D25), topped up newest-first.
 * One decider call: the choices are `<slug>/<item id>`, `<slug>/new_story` and
 *   `adds_nothing`. interpret() reads the pick:
 *   - entity p = the summed probability of that entity's choices, margin = the gap
 *     to the next entity (adds_nothing counts as one); item p = the chosen choice,
 *     margin = the gap to the runner-up choice of the same entity.
 *   - cutoffs (provisional): entity >= 0.85 and >= 0.30 ahead; item >= 0.70 and
 *     >= 0.20 ahead. Below -> parked 'below_cutoff: ...'.
 *   - the top choice off the most likely entity -> parked 'disagree: ...'.
 *   The decision row is written either way (one write with the status change).
 * Routing rules are config passed in by the runner, not a table (#479: no new tables).
 */
import type { DecisionCase, DeciderAnswer } from './deciders.js';
import type { Db } from './states.js';

export const ADDS_NOTHING = 'adds_nothing';
export const NEW_STORY = 'new_story';
export const SHORTLIST_MAX = 5;
export const ITEMS_PER_ENTITY = 5;
export const ENTITY_P_MIN = 0.85;
export const ENTITY_MARGIN_MIN = 0.3;
export const ITEM_P_MIN = 0.7;
export const ITEM_MARGIN_MIN = 0.2;

export type RoutingRule = { tokenSlug: string; projectSlug: string; routeTo: string };
export type StoryItem = { id: string; title: string; summary: string | null; occurred_at: string | null };
export type StoryCandidate = { slug: string; name: string; type: string; items: StoryItem[] };
export type StoryState = { signal: { signal_id: string; text: string | null; excerpt: string | null }; candidates: StoryCandidate[] };
export type ShortlistEntry = { entity_id: string; slug: string; name: string; type: string };
export type Interpretation = { status: 'analysed' | 'parked'; parkedReason?: string; fields: Record<string, unknown> };

/** Thrown by buildCase when the signal is parked before any decider call. */
export class ParkSignal extends Error {
  constructor(readonly reason: string) {
    super(`parked: ${reason}`);
    this.name = 'ParkSignal';
  }
}

type SignalIn = { signal_id: string; text: string | null; excerpt: string | null; link: string | null };
type EntityRow = { id: string; slug: string; name: string; type: string; aliases: string[] };

function aliasRegExp(alias: string): RegExp {
  const body = alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?<![\\p{L}\\p{N}_])${body}(?![\\p{L}\\p{N}_])`, 'iu');
}

export function linkShortlist(entities: EntityRow[], rules: readonly RoutingRule[], text: string): EntityRow[] {
  const scored = entities
    .map((entity) => {
      const hits = entity.aliases.filter((a) => a.length > 0 && aliasRegExp(a).test(text));
      return { entity, hits: hits.length, len: hits.reduce((n, a) => n + a.length, 0) };
    })
    .filter((s) => s.hits > 0)
    .sort((a, b) => b.hits - a.hits || b.len - a.len || (a.entity.slug < b.entity.slug ? -1 : a.entity.slug > b.entity.slug ? 1 : 0));
  let list = scored.map((s) => s.entity);
  for (const r of rules) {
    if (!list.some((s) => s.slug === r.tokenSlug) || !list.some((s) => s.slug === r.projectSlug)) continue;
    const drop = r.routeTo === r.tokenSlug ? r.projectSlug : r.tokenSlug;
    list = list.filter((s) => s.slug !== drop);
  }
  return list.slice(0, SHORTLIST_MAX);
}

async function loadItems(db: Db, entityIds: string[]): Promise<Map<string, StoryItem[]>> {
  const { rows } = await db.query<{ entity_id: string; id: string; title: string; summary: string | null; occurred_at: Date | null }>(`
    with items as (
      select i.main_entity_id, i.id, i.title, i.summary, i.occurred_at,
             row_number() over (partition by i.main_entity_id order by i.occurred_at desc, i.id) as rn,
             case when i.occurred_at >= now() - make_interval(days => 35)
                  then floor(extract(epoch from (now() - i.occurred_at)) / 604800.0) end as wk
        from atlas.entity_items i
       where i.main_entity_id = any($1::uuid[]) and i.status = 'active' and i.occurred_at is not null
    ),
    seed as (
      select it.main_entity_id, it.rn from items it
       where it.rn = 1
          or it.rn in (select min(b.rn) from items b where b.main_entity_id = it.main_entity_id and b.wk between 0 and 4 group by b.wk)
    ),
    ranked as (
      select it.main_entity_id, it.rn,
             row_number() over (partition by it.main_entity_id order by (s.rn is null), it.rn) as pick
        from items it left join seed s on s.main_entity_id = it.main_entity_id and s.rn = it.rn
    )
    select it.main_entity_id::text as entity_id, it.id::text as id, it.title, it.summary, it.occurred_at
      from ranked r join items it on it.main_entity_id = r.main_entity_id and it.rn = r.rn
     where r.pick <= ${ITEMS_PER_ENTITY}
     order by it.main_entity_id, it.occurred_at desc, it.id`, [entityIds]);
  const by = new Map<string, StoryItem[]>();
  for (const r of rows) {
    by.set(r.entity_id, [...(by.get(r.entity_id) ?? []), {
      id: r.id, title: r.title, summary: r.summary, occurred_at: r.occurred_at ? new Date(r.occurred_at).toISOString() : null,
    }]);
  }
  return by;
}

const entityOf = (choice: string) => (choice === ADDS_NOTHING ? ADDS_NOTHING : choice.slice(0, choice.indexOf('/')));
const pp = (n: number) => n.toFixed(2);

/** No routing rules until Bucket provides the seed rules (#479 dependency). */
export const DEFAULT_ROUTING_RULES: readonly RoutingRule[] = Object.freeze([]);

export class RoutingRuleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RoutingRuleError';
  }
}

/** Load-time check: non-empty distinct slugs, routeTo on one side of its pair, each pair once. */
export function validateRoutingRules(rules: readonly RoutingRule[]): readonly RoutingRule[] {
  const pairs = new Set<string>();
  rules.forEach((r, i) => {
    const at = `routing rule ${i} (${JSON.stringify(r)})`;
    if (![r.tokenSlug, r.projectSlug, r.routeTo].every((s) => typeof s === 'string' && s.trim() !== '')) {
      throw new RoutingRuleError(`${at}: slugs must be non-empty`);
    }
    if (r.tokenSlug === r.projectSlug) throw new RoutingRuleError(`${at}: token and project slugs must differ`);
    if (r.routeTo !== r.tokenSlug && r.routeTo !== r.projectSlug) {
      throw new RoutingRuleError(`${at}: routeTo must be the token or the project slug`);
    }
    const key = [r.tokenSlug, r.projectSlug].sort().join('|');
    if (pairs.has(key)) throw new RoutingRuleError(`${at}: duplicate pair`);
    pairs.add(key);
  });
  return rules;
}

export function linkerStory(o: { routingRules?: readonly RoutingRule[] } = {}) {
  const routingRules = validateRoutingRules(o.routingRules ?? DEFAULT_ROUTING_RULES);
  async function buildCase(signal: SignalIn, db: Db): Promise<DecisionCase> {
    const text = [signal.text, signal.excerpt].filter(Boolean).join('\n');
    const entities = (await db.query<EntityRow>(
      "select id::text as id, slug, name, type, aliases from atlas.entities where status = 'active'")).rows;
    const shortlist = linkShortlist(entities, routingRules, text);
    if (shortlist.length === 0) throw new ParkSignal('no_match');
    const items = await loadItems(db, shortlist.map((s) => s.id));
    const candidates: StoryCandidate[] = shortlist.map((s) => ({ slug: s.slug, name: s.name, type: s.type, items: items.get(s.id) ?? [] }));
    const choices = candidates.flatMap((e) => [...e.items.map((i) => `${e.slug}/${i.id}`), `${e.slug}/${NEW_STORY}`]);
    choices.push(ADDS_NOTHING);
    const state: StoryState = { signal: { signal_id: signal.signal_id, text: signal.text, excerpt: signal.excerpt }, candidates };
    return {
      question: 'Which entity is this signal mainly about, and which listed item does it update? '
        + `Pick <entity>/<item id>, <entity>/${NEW_STORY} when it starts something none of the items cover, or ${ADDS_NOTHING}.`,
      choices,
      shortlist: shortlist.map((s): ShortlistEntry => ({ entity_id: s.id, slug: s.slug, name: s.name, type: s.type })),
      itemIds: candidates.flatMap((e) => e.items.map((i) => i.id)),
      state,
    };
  }

  function interpret(answer: DeciderAnswer, c: DecisionCase): Interpretation {
    const { choice, probabilities: p } = answer;
    if (!c.choices.includes(choice)) throw new Error(`invalid_answer: ${choice} is not one of the case choices`);
    const mass = new Map<string, number>();
    for (const [k, v] of Object.entries(p)) mass.set(entityOf(k), (mass.get(entityOf(k)) ?? 0) + v);
    const ranked = [...mass.entries()].sort((a, b) => b[1] - a[1]);
    const entity = entityOf(choice);
    const entityP = mass.get(entity) ?? 0;
    const entityMargin = entityP - Math.max(0, ...ranked.filter(([k]) => k !== entity).map(([, v]) => v));
    const itemP = p[choice] ?? 0;
    const itemMargin = itemP - Math.max(0, ...Object.entries(p).filter(([k]) => k !== choice && entityOf(k) === entity).map(([, v]) => v));
    const chosen = (c.shortlist as ShortlistEntry[]).find((s) => s.slug === entity);
    const linkedItem = choice !== ADDS_NOTHING && !choice.endsWith(`/${NEW_STORY}`) ? choice.slice(choice.indexOf('/') + 1) : null;
    const reason = choice === ADDS_NOTHING ? 'adds_nothing' : linkedItem ? 'linked' : 'new_story';
    const fields = {
      reason,
      action: choice === ADDS_NOTHING ? 'skip' : 'keep',
      target_item_id: linkedItem,
      entities: chosen ? [{ entity_id: chosen.entity_id, slug: chosen.slug }] : [],
    };
    let parkedReason: string | undefined;
    if (ranked[0] && ranked[0][0] !== entity && ranked[0][1] > entityP) {
      parkedReason = `disagree: item ${entity}, entity ${ranked[0][0]} (p=${pp(entityP)} vs ${pp(ranked[0][1])})`;
    } else if (choice !== ADDS_NOTHING && (entityP < ENTITY_P_MIN || entityMargin < ENTITY_MARGIN_MIN)) {
      parkedReason = `below_cutoff: entity p=${pp(entityP)} margin=${pp(entityMargin)}`;
    } else if (itemP < ITEM_P_MIN || itemMargin < ITEM_MARGIN_MIN) {
      parkedReason = `below_cutoff: item p=${pp(itemP)} margin=${pp(itemMargin)}`;
    }
    return parkedReason ? { status: 'parked', parkedReason, fields } : { status: 'analysed', fields };
  }

  return { buildCase, interpret };
}

