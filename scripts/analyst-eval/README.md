# Analyst eval spike (#442)

Checks whether an LLM analyst can correctly file Myboon news signals into atlas shelves/items, scored against hand labels.

- Fixture: fixtures/signals.json (50 #440 Signals); labels: fixtures/labels.csv (`signal_id,expected_main_shelf,...`).
- Analyst prompt: analyst.SKILL.md; driven turn-by-turn through the `hermes` one-shot CLI (glm-5.3-flash on ollama-cloud); atlas search via tools/search_atlas.ts (read-only Supabase GETs, profile atlas, env: SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY).
- Full pass (10 tool calls / 180 s budget per signal): `node_modules/.bin/tsx scripts/analyst-eval/run-eval.ts --pass 1`
- Smoke: `--limit 2 --no-labels` (labels not needed to run).
- Results append to scripts/analyst-eval/results/pass-<n>/runs.jsonl (resumable; rerunning skips recorded signal_ids).
- Spend cap: the run stops once all results/pass-*/runs.jsonl together reach 3M tokens or $5.
- Score: `node_modules/.bin/tsx scripts/analyst-eval/score.ts --pass 1` writes and prints results/pass-<n>/results.md; pass = main shelf >= 31/36 labelled AND keep/skip >= 43/50; UNCERTAIN labels listed separately as soft misses.