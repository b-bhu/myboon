# X Desk

X Desk is an on-demand, review-only social editor beside the main feed
pipeline. It reads recent durable Entity memory changes, keeps only records
from the `news` provider (including its durable `article` source type), and
asks the configured structured-inference provider for up to five concise X
posts when Bibhu requests them in Discord.

It deliberately has no X API integration and does not write to the feed editor
or publisher tables. Its cursor, retry state, skips, and recommendations live in
`.data/x-desk.sqlite`.

There is deliberately no X Desk daemon, cron job, PM2 application, or
unsolicited notification loop. The ordinary feed, research, and Entity
Manager processes continue to build EntityKnowledge. When Bibhu asks in the
dedicated Discord `#x-desk` channel, Hermes runs one bounded review command and
returns the result in that same conversation. It never posts to X.

Discord recommendations show a short publisher label such as
`source- Cointribune`; raw source URLs remain private in the candidate database
for follow-up and provenance checks.

Request up to five recent suggestions directly from the repository:

```bash
pnpm --filter @myboon/collectors x-desk:suggest 5
```

The command exits after one review. It produces a structured response for
Hermes containing the post text, plain publisher label, durable candidate
reference, confidence, rationale, source title, event time, and source-memory
ID. If fewer than five credible recent items exist, it returns fewer rather
than inventing filler.

List recommendations that are ready for a human to review:

```bash
pnpm --filter @myboon/collectors x-desk:list ready 20
```

Important settings:

- `X_DESK_INITIAL_LOOKBACK_HOURS` controls the recent-results window (24 hours
  by default).
- `X_DESK_BATCH_SIZE` controls how many queued changes one model call reviews.
- The command argument controls the requested count and is hard-capped at five.
- `X_DESK_MAX_ATTEMPTS` and `X_DESK_RETRY_DELAY_MS` bound provider retries.
- `X_DESK_DB_PATH` selects the isolated review database.

`myboon-x-desk` must not be registered in PM2. Discord replies are initiated
only by Bibhu's message and handled by the continuously available Hermes
gateway.

The team role, data lineage, and human-publishing boundary are defined in
[`OPERATING_CHARTER.md`](./OPERATING_CHARTER.md).
