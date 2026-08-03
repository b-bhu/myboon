# Buzz Messaging — Hermes Gateway Setup

This is a myboon-specific setup guide for wiring the `hermes` CLI (see
[`DEPLOY.md`](./DEPLOY.md#hermes-cli-prerequisite)) up to a
[Buzz](https://github.com/block/buzz) community — Block's open-source
human+agent collaboration platform built on Nostr. Once wired, the Hermes
gateway relays messages between a Buzz channel (or DM) and the agent, which
gives us a chat-based ops/notifications channel that doesn't require a new
service: it reuses the same `hermes` binary the researcher, entity-managers,
editor-draft, and news-runner processes already shell out to.

Source: [Hermes Agent docs — Buzz](https://hermes-agent.nousresearch.com/docs/user-guide/messaging/buzz).

## Why we'd want this

Today the pipeline's only visibility is `pm2 logs` / Supabase queries on the
VPS. A Buzz channel gives the team (and the agent) a two-way channel: post
questions to the agent about pipeline state, and receive cron/notification
delivery (`deliver=buzz`) without SSHing in.

## Prerequisites

- The `buzz` CLI binary on `PATH` on the VPS (or `BUZZ_CLI_PATH` pointed at
  it) — build from [block/buzz](https://github.com/block/buzz) with
  `cargo build --release -p buzz-cli`. Not currently installed on the myboon
  VPS — this is a new prerequisite alongside the existing `hermes` one.
- A Buzz community relay URL (e.g. `https://mycommunity.communities.buzz.xyz`).
- A Nostr private key (nsec or hex) whose identity is already a **member** of
  that community. Treat this as a secret — see below.
- `hermes` already installed and authenticated (already required per
  `DEPLOY.md`).

## Configure Hermes

Buzz can be configured via the `gateway` block in Hermes's `config.yaml`
(canonical) or environment variables (which override it). The private key is
always a secret and belongs in `~/.hermes/.env` on the VPS, **not** in
`packages/collectors/.env` or anywhere in this repo.

### config.yaml

```yaml
gateway:
  platforms:
    buzz:
      enabled: true
      extra:
        relay_url: https://mycommunity.communities.buzz.xyz
        channels:                  # channel UUIDs to watch (empty = all joined)
          - <channel-uuid>
        home_channel: <channel-uuid>   # cron/notification delivery target
        poll_interval: 4           # seconds between inbound poll sweeps
        cli_path: ""               # buzz binary (default: PATH, then ~/bin/buzz)
        credentials_file: ""       # JSON file with the nsec (BUZZ_PRIVATE_KEY fallback)
        allowed_users: []          # empty = allow all only if allow_all_users: true
        allow_all_users: false     # false = private mode, restrict to allowed_users
        require_mention: true      # channels: only respond when @mentioned; DMs always dispatch
display:
  platforms:
    buzz:
      interim_assistant_messages: false   # suppress intermediate tool output — final answer only
      tool_progress: off                  # suppress "Running terminal command..." progress bubbles
```

`interim_assistant_messages: false` + `tool_progress: off` match the
defaults already used for Telegram and email — keep the channel to final
results, not the agent's internal tool log.

`~/.hermes/.env` on the VPS:

```
BUZZ_PRIVATE_KEY=nsec1...
```

### Environment variable alternative

| Variable | Required | Description |
|----------|:--------:|-------------|
| `BUZZ_RELAY_URL` | required | Base URL of the community relay |
| `BUZZ_PRIVATE_KEY` | required | Nostr private key (nsec or hex) — the only secret |
| `BUZZ_CHANNELS` | optional | Comma-separated channel UUIDs to watch (default: all joined) |
| `BUZZ_HOME_CHANNEL` | optional | Channel UUID for cron/notification delivery |
| `BUZZ_ALLOWED_USERS` | optional | Comma-separated npubs/hex pubkeys allowed to talk to the agent |
| `BUZZ_ALLOW_ALL_USERS` | optional | Allow any community member to talk to the agent |
| `BUZZ_POLL_INTERVAL` | optional | Seconds between inbound poll sweeps (default 4) |
| `BUZZ_CLI_PATH` | optional | Path to the `buzz` binary |
| `BUZZ_CREDENTIALS_FILE` | optional | JSON credentials file holding the nsec, used when `BUZZ_PRIVATE_KEY` is unset |
| `BUZZ_TRANSPORT` | optional | `auto` (default) / `websocket` / `poll` — how inbound messages are received |
| `BUZZ_AUTH_TAG` | optional | Four-string NIP-OA owner-attestation auth tag JSON, only if the relay requires it |

These are Hermes-process env vars (set via `~/.hermes/.env` or the shell that
runs `hermes gateway start`), separate from `packages/collectors/.env`.

## Run the gateway

```bash
hermes gateway setup   # guided walk-through, pick "Buzz"
hermes gateway start
hermes gateway status  # confirms Buzz connection state, incl. env-only setups
```

`hermes gateway start` is a **persistent** process — it is not one of the
existing PM2-managed jobs and must be added to `ecosystem.config.cjs`
separately once the `buzz` binary and credentials are actually in place on
the VPS. Until then, running it ad hoc under `pm2 start "hermes gateway
start" --name myboon-buzz-gateway` (or a `screen`/`tmux` session for testing)
is enough to validate the setup before making it a managed process.

## Access control

Default is private mode: empty `allowed_users` + `allow_all_users: false`
means nobody gets a response until users are explicitly listed. Flip
`allow_all_users: true` for community mode (anyone in the Buzz community can
chat; only the relay-attested owner keeps admin tier). Community membership
itself is enforced by the relay — only members can post at all.

## Mentions, channels, DMs

- In shared channels the agent only responds when addressed (`@name`, npub,
  or hex pubkey) — `require_mention: true`.
- DMs always reach the agent regardless of that setting.
- Self-echo is suppressed by pubkey; every event is de-duplicated by event id
  against a per-channel high-water mark, so reconnects don't replay history.

## Notes and limitations

- Inbound is polled by default (`poll_interval`, default 4s) via the `buzz`
  CLI's request/response interface, with an optional native Nostr WebSocket
  subscription for near-instant delivery when `BUZZ_TRANSPORT` allows it.
  Outbound always goes through the `buzz` CLI.
- New DM conversations are auto-discovered every few poll sweeps.
- The private key is passed to the CLI via the subprocess environment only —
  never argv, never logs.

## Status

Not yet enabled on the myboon VPS. This doc captures the setup steps so
enabling it later (once the `buzz` binary is built and a relay/nsec are
provisioned) doesn't require re-deriving them from the upstream Hermes docs.
