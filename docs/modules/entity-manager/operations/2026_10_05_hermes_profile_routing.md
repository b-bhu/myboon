# Hermes profiles and Ollama primary routing

Date: 5 October 2026. Current routing activated at 06:48 UTC.

The production Hermes profile was renamed from `myboonv4codex20261003` to
`myboon-codex-production` using the installed `hermes profile rename` command.
The 697 sessions, 1,393 messages and 696 model-usage rows present at the rename
were preserved; the session-ID digest and all three table counts matched before
and after the move. Subsequent production calls can add sessions normally.

Myboon's inference calls explicitly select their profile. `HermesService`
resolves a per-call override, then `INFERENCE_GATEWAY_HERMES_PROFILE`, then
`myboon-codex-production`. It applies that selection to one-shot and chat calls,
their observer records, and exact chat-session deletion. Structured inference
and classification configuration use the same default. News and legacy
research clients prefer the shared environment selection over stage-specific
environment settings. Explicit per-call overrides remain available for isolated
validation.

Every Hermes profile now uses `ollama-cloud/glm-5.3-flash` as its primary model
and native `fallback_model: {provider: openai-codex, model: gpt-5.6-luna}` as
its only backup. This applies to the default profile and all eleven named
profiles, including production, stage-specific and historical validation
profiles. Older `fallback_providers` entries were removed. Session, message and
usage-row counts, plus the session-ID digest, matched across the configuration
change for every profile with a database. No session history was deleted.

The collectors environment, public ecosystem defaults, active private release
configuration and saved PM2 configuration select the production profile and
Ollama primary route. The four internal pipelines were drained and resumed;
all five PM2 processes are online. `myboon-api` retained PID 1719088, its uptime
and restart count of 1. The Hermes default gateway was restarted to load the
model changes. The production profile's description now identifies Ollama as
primary; its existing name does not choose the provider.

| Profile | Primary | Backup and live validation |
| --- | --- | --- |
| `myboon-codex-production` | `ollama-cloud/glm-5.3-flash` | `openai-codex/gpt-5.6-luna`; successful typed gateway call, with native receipt confirming backup usage. |
| `default` | `ollama-cloud/glm-5.3-flash` | `openai-codex/gpt-5.6-luna`; successful native call, with receipt confirming backup usage. |
| Other ten named profiles | `ollama-cloud/glm-5.3-flash` | Same Codex backup; configuration verified. |

A fresh direct request to Ollama for `glm-5.3-flash` at 06:52 UTC returned
HTTP 403 with the subscription-past-due diagnostic. The credential is present;
the account cannot currently serve primary inference. Both successful live
probes were served by Codex as the configured backup. Restoring Ollama billing
is necessary before primary inference can succeed.

Both inference adapters now read actual provider/model and measured input and
output tokens from native Hermes usage receipts. The structured gateway reports
native fallback and keeps an admitted repair on the provider that answered.
The production probe validated JSON with one gateway dispatch, zero repairs,
zero tools, 986 input tokens and 9 output tokens. Receipts are private and
temporary unless a validation caller explicitly owns the receipt path. Native
fallback does not enable a second gateway provider chain or replay old work.

Both built-in production memory stores are disabled: `memory.memory_enabled`
and `memory.user_profile_enabled`. Article and entity context remains supplied
by Myboon. Automatic session-retention policy was not changed in this operation.

Validation: 159 relevant Hermes, inference-gateway, News client and legacy
research-engine tests passed; the collectors TypeScript check and whitespace
check passed. The saved `software-design` skill was read and applied; its Codex
and Hermes copies are identical and both pass the skill validator.

Current private operational receipts are in
`/tmp/myboon-all-ollama-primary-result-20261005.json` and
`/tmp/myboon-ollama-fallback-probes-20261005/`. The earlier rename receipt is
`/tmp/myboon-hermes-profile-update-result-20261005.json`. These contain
validation metadata; credentials and article prompts are not included in this
record.

References: [Hermes profiles](https://hermes-agent.nousresearch.com/docs/user-guide/profiles),
[profile commands](https://hermes-agent.nousresearch.com/docs/reference/profile-commands),
[Ollama GLM-5.3 Flash](https://ollama.com/library/glm-5.3-flash).
