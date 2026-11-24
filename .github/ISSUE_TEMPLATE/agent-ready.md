---
name: Agent-ready issue
about: The factory's complete input. Groom until the pre-flight is all yes, then label agent-ready.
title: ''
labels: grooming
assignees: ''
---

<!-- This issue is the factory's whole input. The builder builds exactly what is written here.
     The peer reviewer scores the PR against it, 1-10 (10 = no blocker, merge now).
     Anything not written here will not be built or checked. Nothing may rely on chat history.
     Every section is required; one line is fine. State every number, size, name and copy string ONCE. -->

## Goal
<!-- One sentence: what is different when this merges. Add "Part of #n" if it belongs to an epic. -->

**Kind:** <!-- UI | Backend | Both -->

## Current behavior
<!-- What happens today, with real paths and symbols. Bug: steps, input, expected, actual. -->

## Desired behavior

### Behavior contract
<!-- The issue owns behavior: the rule to implement, every state (loading, empty, error, stale, retry), exact copy text, what taps/calls do. -->

### Look (UI only, else "n/a")
<!-- Mock = look. Issue = behavior contract.
     Mock: commit-pinned link to the file (add ?proto if it is a prototype), plus the exact frame: "group > frame".
     Elements in this unit: list them by what they are on screen.
     Do not restate a size unless it equals the frame. If you must give a number, check it against the frame first.
     File and line hints are hints. The builder and reviewer still open the frame. -->

### Spec (Backend only, else "n/a")
<!-- Function or endpoint signature. Inputs and outputs with types or shape. Schema or migration. Errors (code + message).
     Env, export and route names that must not be renamed: list them in one line. -->

## Scope
<!-- Files and areas touched (real paths; mark new files as "new"). Name any refactor the change forces.
     One coherent change. There is no line cap. If it scatters across unrelated areas, split it into two issues. -->

## Not in this unit
<!-- Everything nearby that this issue does NOT do, including every other difference visible in the same mock frame.
     One line each, with its follow-up issue (#n) or "no follow-up: reason". "none" only if nothing is left. -->

## Must preserve
<!-- Contracts that must not change: behavior, names (env, exports, routes, storage keys), other screens. -->

## Dependencies
- Before you start: <!-- #n must be merged, or "none" -->
- Shares files with: <!-- #n (rebase if it merged first), or "none" -->
- Unblocks: <!-- #n, or "none" -->
- needs-bucket: <!-- yes (money, wallet, DB or migration) | no -->

## Acceptance checklist
<!-- The reviewer scores against this list. Each item is a yes/no that can be checked from the diff, the tests or the mock frame.
     Given/when/then is fine, as long as the answer is yes or no. Cover the states named in the behavior contract. -->
- [ ] 

## Tests
<!-- Tests to add or extend (names and paths) and the command that runs them. Or "none: <reason>" (for example, style only).
     CI is the gate. No device test. -->

## Open decisions
<!-- Must be "none" before agent-ready. Anything else keeps the issue in grooming. -->
none

## Pre-flight (groomer, before adding agent-ready)
- [ ] Every number, size, name and copy string appears once, and no two sections (or the issue and the mock) disagree.
- [ ] UI: the mock link opens from a fresh checkout and names the exact frame.
- [ ] UI: every visible difference in that frame is either in Desired behavior or in Not in this unit.
- [ ] UI: every value written in this issue matches the frame.
- [ ] Backend: inputs, outputs, errors and preserved names are written.
- [ ] One coherent change, and Scope lists real paths.
- [ ] Every acceptance item is a yes/no.
- [ ] Open decisions: none.
