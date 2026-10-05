# Entity Manager documentation

## Current checkpoint — 5 October 2026

The current scope ends at **Scout → Intake → Researcher → Entity Manager → private durable knowledge**. New work is article-based, without formal claims/evidence outputs. News Research/Entity are active; Polymarket is collection-only. All downstream integration is excluded.

- [V4 working PRD](PRDs/v4_prd.md) — current requirements, contracts and acceptance status.
- [Checkpoint handoff](operations/2026_10_05_v4_entity_manager_checkpoint_handoff.md) — start here to continue the work; code seams, runtime settings, completed validation and remaining reliability/quality work.
- [Article activation record](operations/2026_10_05_article_pipeline_activation.md) — applied migration, permission checks, startup fixes and accepted examples.
- [Hermes profile/model routing](operations/2026_10_05_hermes_profile_routing.md) — Ollama GLM-5.3 Flash primary everywhere; Codex Luna backup. Ollama primary remains blocked by subscription billing.

## Historical references

- [Pre-checkpoint PRD snapshot](PRDs/2026_10_05_v4_prd_pre_checkpoint_snapshot.md) preserves the earlier detailed issue mapping and authorisation/contract history.
- [4 October article implementation](operations/2026_10_04_article_researcher_implementation.md) records the implementation-only pass, before activation.
- [3 October implementation handoff](operations/2026_10_03_v4_implementation_handoff.md) and its validation records concern the preceding contract. Their dates and results remain historical.
- Other dated PRDs/ADRs preserve their original design context. Use the current working PRD and checkpoint handoff for today's scope and settings.

An older instruction to defer tests, keep workers stopped or use claims/evidence is not the current article workflow. D1/D2 recovery protections and historical compatibility remain applicable as described in the current PRD. Private managed records are not yet connected to the existing story UI.
