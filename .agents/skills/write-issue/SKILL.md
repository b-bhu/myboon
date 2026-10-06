---
name: write-issue
description: Draft, create or update a GitHub implementation issue for a feature, bug or redesign using the project's required handoff format. Include user behavior, scope, preserved contracts, acceptance scenarios, verification and completion evidence.
---

# Write an implementation issue

Write for a developer or agent who has not seen the conversation. Carry the relevant product decisions into the issue instead of relying on chat history.

## Required format

Read and use the [implementation issue template](../../../.github/ISSUE_TEMPLATE/implementation.md), the canonical format for this repository. Copy its body, not its GitHub YAML frontmatter. Unless the user explicitly requests another format, keep these eight headings in order:

1. Goal
2. Current behavior
3. Desired behavior
4. Scope
5. Must preserve
6. Acceptance scenarios
7. Verification
8. Completion evidence

Use subsections where useful. Put dependencies/ownership and implementation details under Scope; preserved APIs and behavior under Must preserve. Include exact types, prompts, schemas or migration details only where they materially clarify the task, inside the appropriate section. Do not restore the older Problem / Changes / Acceptance Criteria format from historical issues. For a section that genuinely does not apply, give a short reason rather than inventing work.

## Ground the handoff

- Inspect the relevant code, PRD/spec and latest accepted design. PRDs may live in `docs/PRDs/` or `docs/modules/<module>/PRDs/`. Reference real repository paths and symbols; label proposed files or APIs as proposed.
- For bugs, capture reproducible steps, inputs, expected result and actual result. For features, explain the existing experience and the intended user-visible change.
- Identify which design/reference is authoritative and which parts apply. Link an accessible artifact when available; clearly flag local/uncommitted files or missing access and specify the handoff needed. Do not call a local path an accessible remote design link.
- Required artifacts must be retrievable from a fresh checkout or remote VPS. Within the authorized task, prefer committing references to a dedicated repository branch and linking an immutable commit, with exact paths and fetch/extraction instructions that preserve the implementer's branch. Verify retrieval before describing the handoff as ready. A local `/tmp` ZIP is optional convenience only. If publication or access is unavailable, record the dependency rather than implying the recipient already has the files.
- Separate working behavior, prototype fixtures, future direction and unresolved decisions. Include boundaries with related issues and parallel work so an assignee knows what they own and what they must preserve.
- Write Given/when/then scenarios with observable outcomes, including applicable loading, unavailable, error and retry cases. Scale detail to the change; do not copy unrelated scenarios from a larger issue.
- Specify the smallest relevant tests, required UI/device checks, environment, fixture/setup instructions and known access or permission requirements. Follow the checkout's `CLAUDE.md`; do not invent approvals or claim tests were run while drafting an issue.
- Require completion evidence appropriate to the change: screenshots/recordings for visual behavior, commands/results and scenario outcomes. At handoff, distinguish evidence already collected from future requirements and name anything unverified.

## GitHub workflow

- Working issues live in GitHub; durable PRDs and reusable templates live in the repository. Do not create a local directory of issue copies by default.
- Resolve the current repository from the target issue or `gh repo view --json nameWithOwner`; do not hardcode a repository name copied from old documentation.
- Before creating an issue, search for an existing issue covering the same work. When updating, read the target and relevant parent/related issues first; preserve useful context and existing relationships. Older issues provide context, not a competing format.
- Use the user's title if supplied; otherwise infer a concrete title from the task. Ask only for missing information that materially changes the scope or outcome and cannot be established from the code or conversation.
- Respect whether the user requested a draft, creation or an update. A request for a draft alone does not authorize publication. For an authorized GitHub change, use available GitHub tools or `gh`; pass multiline bodies through a structured argument or temporary UTF-8 file with `--body-file`.
- Verify the saved title/body and relevant parent relationship after writing, then report the issue link. Do not claim implementation or verification merely because the issue was updated. No tool-specific attribution footer is required.
