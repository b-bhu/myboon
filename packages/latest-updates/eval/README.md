# Latest-updates eval set (frozen)

Frozen entities for judging the latest-updates editor before anything goes live, and for rerunning on every prompt or model change. Built for [#629](https://github.com/b-bhu/myboon/issues/629), part of [#623](https://github.com/b-bhu/myboon/issues/623). **Data only.** The eval script ships with [#631](https://github.com/b-bhu/myboon/issues/631).

| File | What it is |
|---|---|
| `snapshot.json` | The frozen data: `meta` plus 32 `entities`, each with `new_items`, `last_update`, `prior_items` and `origin_signals` (source links). |
| `snapshot.sql` | The exact read-only query that produced it. |
| `selection.json` | Why each entity was picked (stratum A to E, below). Not shown on the labelling sheet, so it cannot bias labels. |
| `LABELLING-SHEET.md` | One readable entry per entity, for Bibhu. Generated from `snapshot.json`. |
| `labels.csv` | `slug,label,note`. Bibhu's `write` / `hold` labels go here. Bots do not label. |

## How it was frozen

- Source: Atlas (Supabase project `myboon`), read-only `SELECT` only. No writes, no `public.*` tables, `atlas.stories` and `atlas.story_items` untouched.
- Date: Nov 14, 2026, about 6:30 AM IST. Data cut-off `2026-11-14T01:00:00Z`.
- Window (freeze only): the 72 hours before the cut-off, on `entity_items.created_at` (`2026-11-11T01:00:00Z` to `2026-11-14T01:00:00Z`). The entity manager is about 3 days behind ([#621](https://github.com/b-bhu/myboon/issues/621)), so the production basis (`occurred_at`, 24 h) would leave almost nothing: in this window every new item happened on Nov 9 or 10. The override exists here and in the eval script only, never in the runner.
- Candidates: 93 entities had an active item created in the window. 32 were selected.
- Shape per entity, as the editor sees it:
  - `new_items`: every active item created in the window.
  - `last_update`: stand-in for the last published update, the entity's newest earlier active item (created before the window, ordered by `coalesce(occurred_at, created_at) desc, id desc`), or `null` (3 entities have none).
  - `prior_items`: up to 7 earlier items in that order; `last_update` is the first.
  - `origin_signals`: signals linked with `item_signals.role = 'origin'` plus `entity_items.signal_id`. `excerpt` is kept only when it differs from `text`.
- Compared with the POC snapshot ([PR #613](https://github.com/b-bhu/myboon/pull/613)): same query shape; `image_url`, `status`, `new_item_ids`, `new_item_count` and `latest_item_created_at` are dropped (derivable or unused by the editor), and ordering is stable (ties broken by id).

## Why these 32 (selection)

A deterministic rule, no judgement of what the label should be. Stratum counts are in `selection.json`.

| Stratum | Rule | Entities |
|---|---|---|
| A, high overlap | The newest new item's words overlap most with the last update's words (share of the newest item's title and summary words, longer than 3 characters, that also appear in the last update; top 12 of 93). These are the likeliest repeats, so the set can contain holds. | 12 |
| B, no number | Newest new item's summary has no digit; the lowest-overlap 7 with a last update. Stresses write bars (a) and (c). | 7 |
| C, many items | 4 to 10 new items (most items first). Stresses long bundles. | 5 |
| D, no prior | Entities with no earlier item, so no last update. | 3 |
| E, seeded random | Seeded shuffle (`Random(629)`) of the rest. | 5 |

Strata A and B deliberately over-represent likely holds so that the 80% hold-recall bar means something. The mix is therefore **not** representative of the production write/hold ratio. Do not read the overall agreement as a production rate.

## Labels and the hold count

[#629](https://github.com/b-bhu/myboon/issues/629) asks for at least 8 `hold` labels and a mix that is not mostly `write`. The number of holds is only known after Bibhu labels; `labels.csv` is blank until then. If fewer than 8 come back `hold`, the set has to be topped up from the other 61 candidates in the same window before it counts as frozen.

## Rules

- Do not regenerate `snapshot.json` in place. A new freeze is a new dated set.
- No secrets, tokens or connection strings in these files. Signal links are public article URLs.
