# @myboon/entity-manager (#571)

Takes over where the analyst stops. For each analyst handoff (`atlas.decisions.handoff`, `em_status = 'pending'`)
that has an entity pick, it reads the entity and its latest 7 items, asks the model, and applies one of:

| decision    | write                                                                  | em_status   |
|-------------|------------------------------------------------------------------------|-------------|
| `story`     | `atlas.entity_items` (title, summary, https image or null) + `item_signals` role `origin` | `story` |
| `park`      | `atlas.entity_context` (reason, sentiment NULL)                         | `parked`    |
| `duplicate` | nothing; `em_duplicate_of` = the repeated recent item                   | `duplicate` |
| error       | `atlas.em_fail` (backoff, failed after 3)                               | `failed`    |

Keep-without-entity handoffs (entity growth) are out of scope: they are put back as pending for a day, untouched.
Writes run in one transaction under `pg_advisory_xact_lock(hashtext('atlas.entity:' || slug))`.

Model: Jev (`JEV_API_TOKEN`, optional) judges story/park/duplicate; the chat model (Ollama, `OLLAMA_API_KEY`,
`ENTITY_MANAGER_LLM_MODEL`, default `glm-5.3-flash`) gets the system prompt in `src/prompt.ts` verbatim and
returns the JSON (title/summary/duplicate_of). Without Jev the chat model's decision is used.

Connects as `entity_worker` (`ENTITY_MANAGER_DATABASE_URL`). Needs migration
`20261106120000_atlas_em_writer_grants.sql` (not applied yet).

- `pnpm --filter @myboon/entity-manager dry-run` — read-only; DB pending rows if reachable, else `fixtures/handoffs.jsonl`; offline stub model when `OLLAMA_API_KEY` is unset.
- `pnpm --filter @myboon/entity-manager once` — one worker pass (writes). Not deployed; pipeline is off.
