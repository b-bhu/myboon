# Specs and task flow

1. Open a spec PR in `docs/specs/` and label it `spec`.
2. Bucket reviews and approves it by adding `spec-approved`.
3. The CTO creates task issues from the approved spec, labelled `ready:backend`, `ready:frontend` or `ready:system`.
4. The owning bot claims a task by swapping its `ready:*` label for `in-progress` and commenting. It works in its own worktree and branch, then opens a PR containing `Closes #n`.
5. CI runs and the CTO reviews the PR.
6. Bucket merges. Bots never merge or push to `main`.

Add `needs-bucket` to work touching money, wallets or DB/migrations. Mark work `blocked` when stuck.

```mermaid
flowchart TD
    A[Spec PR in docs/specs, label spec] --> B[Bucket approves: spec-approved]
    B --> C[CTO creates task issue: ready:backend / ready:frontend / ready:system]
    C --> D[Owning bot claims: in-progress + comment]
    D --> E[Bot works in own worktree and branch]
    E --> F[PR with Closes #n]
    F --> G[CI runs]
    G --> H[CTO reviews]
    H --> I[Bucket merges]
    D -. stuck .-> J[blocked]
    C -. money, wallet, DB/migrations .-> K[needs-bucket]
```
