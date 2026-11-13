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

### #621 claim only rows with an entity (flags off by default)

Without the flags below nothing changes: `atlas.em_claim` (oldest first, all rows), batch `ENTITY_MANAGER_MAX_PER_RUN` (20).

| flag / knob | default | effect |
|---|---|---|
| `ENTITY_MANAGER_CLAIM_ENTITY_ONLY=true` (on `myboon-entity-manager`) | off | claim with `atlas.em_claim_scoped(..., 'entity')`: only handoffs whose `entity` is an object; batch `ENTITY_MANAGER_ENTITY_ONLY_MAX_PER_RUN` (60) |
| `ENTITY_MANAGER_RETRY_ENABLED=true` (on `myboon-entity-manager-retry`, `src/run-retry.ts`) | off | once a day (20:15 UTC), claim the no-entity handoffs (`'no_entity'`, batch `ENTITY_MANAGER_RETRY_MAX_PER_RUN`, 2000) and put them back as pending for a day, so they no longer take slots in the main run |

Both need migration `20261113190000_atlas_em_claim_scoped.sql` (DB Guy review; not applied). `EM_TEST_ADMIN_URL` (a local Postgres) enables `src/claim-scoped.db.test.ts`.
Writes run in one transaction under `pg_advisory_xact_lock(hashtext('atlas.entity:' || slug))`.

Model: Jev (`JEV_API_TOKEN`, optional) judges story/park/duplicate; the chat model (Ollama, `OLLAMA_API_KEY`,
`ENTITY_MANAGER_LLM_MODEL`, default `glm-5.3-flash`) gets the system prompt in `src/prompt.ts` verbatim and
returns the JSON (title/summary/duplicate_of). Without Jev the chat model's decision is used.

Connects as `entity_worker` (`ENTITY_MANAGER_DATABASE_URL`). Needs migration
`20261106120000_atlas_em_writer_grants.sql` (not applied yet).

- `pnpm --filter @myboon/entity-manager dry-run` — read-only; DB pending rows if reachable, else `fixtures/handoffs.jsonl`; offline stub model when `OLLAMA_API_KEY` is unset.
- `pnpm --filter @myboon/entity-manager once` — one worker pass (writes). Not deployed; pipeline is off.
