# Git workflow

Keep the shared clone `/home/box/work/myboon` on `main`. Before starting work, update it with `git pull`. Do not make issue changes in that clone.

Create one worktree per issue from the shared clone. Choose a branch prefix by work type (`feat`, `fix`, or `chore`) and include the issue number and a short slug:

```bash
cd /home/box/work/myboon
git pull
git worktree add -b feat/123-short-slug /home/box/work/myboon-issue-123 main
```

For a bug use `fix/123-short-slug`; for maintenance use `chore/123-short-slug`. Replace `123` and the slug with the real issue number and subject. Do not reuse another issue's worktree.

Use Conventional Commit messages, for example `feat(api): add market endpoint` or `fix(wallet): handle reconnect`. Keep each commit focused.

Push the issue branch and open a PR with `Closes #123` in its description. Never push to `main` and never merge. Bucket is the only merger. Follow [labels and flow](labels-and-flow.md); money, wallet, database or migration changes need `needs-bucket`.

After the PR is merged, remove the worktree, delete its local branch from the shared clone, and delete the remote branch:

```bash
git -C /home/box/work/myboon worktree remove /home/box/work/myboon-issue-123
git -C /home/box/work/myboon branch -d feat/123-short-slug
git push origin --delete feat/123-short-slug
```

Use the actual branch name in the cleanup command. Do not remove a worktree with uncommitted changes.
