# Labels and work flow

Use the repository's [canonical label list](../../.github/labels.md):

- `spec`: spec PR awaiting Bucket review; `spec-approved`: Bucket approved it.
- `ready:backend`, `ready:frontend`, `ready:system`: approved task ready for its owner.
- `in-progress`: an agent has claimed the task.
- `blocked`: work is stuck on a dependency or decision.
- `needs-bucket`: work touches money, wallets, the database or migrations and needs Bucket review.

## Claiming an issue

1. Take only an unclaimed issue with your matching `ready:*` label.
2. Before work, replace that `ready:*` label with `in-progress` and comment that you claimed it.
3. Never take an issue already marked `in-progress` or otherwise claimed in its comments.
4. If blocked, mark it `blocked`, explain the dependency in a comment, and remove `in-progress` so another agent can see it is unclaimed.

When the change touches money, wallets or DB/migrations, also add `needs-bucket`. Keep it through review for Bucket's approval. Bucket alone merges.

Older `agent:*` labels are being retired; use the labels above for new work.

Frontend (mobile) tasks must end with an EAS checklist covering whether a new EAS build and version bump are needed, what to test on a real Seeker phone, and whether a dApp Store update is needed.

When a spec gets `spec-approved`, and when a `needs-bucket` PR merges, the acting bot posts a one-line comment starting with `Decision:` on the spec PR, issue or PR so Ledger can log it to Notion.
