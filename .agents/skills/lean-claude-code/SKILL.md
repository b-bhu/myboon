---
name: lean-claude-code
description: MyBoon Claude Code token defaults — bash output cap, no bundled skill listings, and flags for non-interactive print jobs. Use when starting Claude Code in this repo, writing a --print job, or checking why a session is burning tokens.
---

# Lean Claude Code

These defaults cut prefix tokens. They do not cap turns globally, and they do not disconnect MCP connectors.

## Repo and user defaults

Project file: `.claude/settings.json`. User file: `~/.claude/settings.json`.

- `bashOutputMaxChars`: 16000 (default is 30000). Longer bash output is saved to a file; Claude gets a short preview and the path.
- `includeGitInstructions`: false
- `disableBundledSkills`: true. Built-in skills such as dataviz and code-review are not listed. Skills in `.claude/skills/` and `.agents/skills/` still load.

On your machine, merge the same three keys into `~/.claude/settings.json` and leave `model` and `effortLevel` to your own user settings.

## Print jobs (wire and other --print callers)

Add these flags on the job. Do not put a turn cap in user or project settings — a chart or review session can need more than 8 turns.

```bash
--max-turns 8 \
--strict-mcp-config \
--mcp-config '{"mcpServers":{}}'
```

`--strict-mcp-config` with an empty server list skips account connectors (Docs, Drive, Gmail, Calendar) for that run only. The wire agent also has `maxTurns: 8` in its frontmatter. Do not pass `--tools ""`; that drops the Skill tool.

## Do not re-read big images

The expensive chart session was almost all cache-read of base64 PNGs from the Read tool (~183k tokens), not bash logs. After you write a PNG, refer to it by path. Do not Read it back unless you need to inspect pixels, and then do it once.

