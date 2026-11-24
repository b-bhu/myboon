---
name: write-issue
description: Draft, create or update an agent-ready GitHub issue for a feature, bug or redesign using the project's required handoff format. Include the behavior contract, the mock frame or backend spec, scope, leftovers, preserved contracts, a yes/no acceptance checklist and tests.
---

# Write an agent-ready issue

Write for a developer or agent who has not seen the conversation. Carry the relevant product decisions into the issue instead of relying on chat history.

## Required format

Read and use the [agent-ready issue template](../../../.github/ISSUE_TEMPLATE/agent-ready.md), the canonical format for this repository. Copy its body, not its GitHub YAML frontmatter. Why each section exists: [wiki page](https://github.com/b-bhu/myboon/wiki/Agent-ready-Issue-Template). Unless the user explicitly requests another format, keep these headings in order:

1. Goal (plus Kind: UI, Backend or Both)
2. Current behavior
3. Desired behavior: Behavior contract; Look (UI: commit-pinned mock link plus exact frame); Spec (backend: inputs, outputs, schema, errors, names not to rename)
4. Scope
5. Not in this unit
6. Must preserve
7. Dependencies
8. Acceptance checklist
9. Tests
10. Open decisions
11. Pre-flight

The issue is the factory's complete input: the builder builds exactly it, and the peer reviewer scores the PR against the acceptance checklist (1-10, 10 = merge now). For UI, the mock is the look and the issue is the behavior contract. State every number, size, name and copy string once. List every other difference in the cited frame under Not in this unit with a follow-up issue. One coherent change, no line cap; split scattered work. Open decisions must be "none" and every Pre-flight box ticked before `agent-ready`. For a section that genuinely does not apply, write "n/a" or a short reason rather than inventing work. Do not restore older formats (Problem / Changes / Acceptance Criteria, or the earlier eight-section implementation template).

## Ground the handoff

- Inspect the relevant code, PRD/spec and latest accepted design. PRDs may live in `docs/PRDs/` or `docs/modules/<module>/PRDs/`. Reference real repository paths and symbols; label proposed files or APIs as proposed.
- For bugs, capture reproducible steps, inputs, expected result and actual result. For features, explain the existing experience and the intended user-visible change.
- Identify which design/reference is authoritative and which parts apply. Link an accessible artifact when available; clearly flag local/uncommitted files or missing access and specify the handoff needed. Do not call a local path an accessible remote design link.
- Required artifacts must be retrievable from a fresh checkout or remote VPS. Within the authorized task, prefer committing references to a dedicated repository branch and linking an immutable commit, with exact paths and fetch/extraction instructions that preserve the implementer's branch. Verify retrieval before describing the handoff as ready. A local `/tmp` ZIP is optional convenience only. If publication or access is unavailable, record the dependency rather than implying the recipient already has the files.
- Separate working behavior, prototype fixtures, future direction and unresolved decisions. Include boundaries with related issues and parallel work so an assignee knows what they own and what they must preserve.
- Write acceptance items as yes/no checks with observable outcomes (Given/when/then is fine), including applicable loading, unavailable, error and retry cases. Scale detail to the change; do not copy unrelated scenarios from a larger issue.
- Specify the smallest relevant tests, the command that runs them, environment, fixture/setup instructions and known access or permission requirements. Follow the checkout's `CLAUDE.md`; do not invent approvals or claim tests were run while drafting an issue. CI is the gate; there is no device test.
- Before adding `agent-ready`, run the Pre-flight: no contradictions, the mock frame opens from a fresh checkout, every frame difference is in scope or in Not in this unit, open decisions none. At handoff, name anything unverified.

## GitHub workflow

- Working issues live in GitHub; durable PRDs and reusable templates live in the repository. Do not create a local directory of issue copies by default.
- Resolve the current repository from the target issue or `gh repo view --json nameWithOwner`; do not hardcode a repository name copied from old documentation.
- Before creating an issue, search for an existing issue covering the same work. When updating, read the target and relevant parent/related issues first; preserve useful context and existing relationships. Older issues provide context, not a competing format.
- Use the user's title if supplied; otherwise infer a concrete title from the task. Ask only for missing information that materially changes the scope or outcome and cannot be established from the code or conversation.
- Respect whether the user requested a draft, creation or an update. A request for a draft alone does not authorize publication. For an authorized GitHub change, use available GitHub tools or `gh`; pass multiline bodies through a structured argument or temporary UTF-8 file with `--body-file`.
- Verify the saved title/body and relevant parent relationship after writing, then report the issue link. Do not claim implementation or verification merely because the issue was updated. No tool-specific attribution footer is required.
