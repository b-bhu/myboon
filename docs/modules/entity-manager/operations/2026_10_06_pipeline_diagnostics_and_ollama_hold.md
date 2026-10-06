# Pipeline diagnostics and Ollama hold

Later update: the [article failure fixes](2026_10_06_article_failure_fixes.md) are
implemented and verified locally, and real Ollama structured writing now succeeds.
Research has resumed and the migration and runtime activation are complete. See
the [operational cleanup and overnight baseline](2026_10_06_operational_cleanup_and_overnight_baseline.md)
for the current state. The diagnostics below record the earlier failure snapshot.

Date: 6 October 2026. This runtime update supersedes the automatic Codex backup
and all-four-pipelines-online state in the 5 October activation reports. It does
not change the V4 implementation scope through Entity Manager.

## Operating state

All twelve native Hermes profiles retain `ollama-cloud/glm-5.3-flash` as primary.
Automatic `fallback_model` and legacy `fallback_providers` settings were removed
at the user's request to stop GPT fallback costs. Codex credentials were retained;
they no longer authorize an automatic backup call through these profiles.

A direct Ollama request on 6 October returned HTTP 403 with the subscription
payment past due diagnostic. Research was stopped before the profile update so
incoming News work can remain queued rather than making further GPT calls or
failing new jobs against the unavailable primary. The Hermes default gateway was
reloaded and the stopped Research state saved in PM2. Research must be resumed
after Ollama can successfully answer a primary-model request.

News and Polymarket collectors and Entity Manager remain online. Polymarket
Research remains disabled. `myboon-api` was untouched: PID 1719088, restart count
1, uptime identity 1791000387540. No dead letters, historical backlog, unknown
paid outcomes, or reservations were replayed or reset.

## Diagnostic findings — fixes remain pending

- **URL safety:** Two rejected PANews articles redirected from
  `www.panewslab.com` to `panews.io`, outside their original approved-domain list.
  The same safety-aware fetcher returned HTTP 200 for both when both domains were
  explicitly approved in isolated probes. Public-address checks stayed enabled.
  Production redirect policy has not been broadened.
- **Processing limits:** The 16 processing-limit failures from the overnight
  window comprised twelve retrieval byte-limit failures and four unresolved
  model/proposal wall-time outcomes. Retrieval allows 1,000,000 bytes per source;
  model work carries a 90,000 ms wall-time allowance. A CoinDesk page reproduced
  the byte failure and fetched successfully with a 3,000,000-byte probe allowance
  (1,746,740-byte response). This is separate from the 16,000-character Jev input
  bound. Production limits have not changed.
- **Retrieval timeouts:** The configured retrieval-plan allowance is 30,000 ms.
  The sampled Forkast article failed with both 30,000 and 60,000 ms probe limits.
  DNS returned IPv6 first; the fetcher pins the first public address without
  trying another address. Keeping every address safety-validated but preferring
  IPv4 succeeded with HTTP 200 in 769 ms. A separate curl request also selected
  IPv4 and succeeded. Address selection/failover and connection/deadline handling
  need correction; increasing the plan allowance alone did not fix this sample.
- **Entity resolution:** At the diagnostic snapshot, all 90 redacted Entity
  Manager failures were matched to private durable hold records: 72 creation
  proposals collided with an existing identity, and 18 were held because the
  creation candidate context was truncated. For the Raoul Pal article, an active
  private entity existed, but neither stored 32-candidate placement pass offered
  its ID to Jev. Candidate search currently bounds and orders by ID rather than
  ensuring exact relevant identities reach the shortlist; the collision path
  retains a hold instead of resolving the existing identity.
- **Decision composition:** Eleven Research failures selected a continuation or
  story branch with no prior target; thirteen selected a primary duplicate while
  the separate novelty judgment selected new information. Two more selected
  already-known without an exact duplicate target. These are held by code after
  typed Jev responses; Jev being available does not make the separate decisions
  mutually consistent. Four creation proposals were rejected by Jev.

Counts above use jobs created since the 5 October 06:48:22.997 UTC restart;
the diagnostic snapshot is later than the initial morning status report. All
database investigation was read-only. No feature code, source capture, placement
policy, or downstream integration was changed in this operation.

Host-local diagnostic receipts are in `/tmp/myboon-diagnostics-20261006/`.
They are not required runtime configuration and may not persist indefinitely.
