# GitHub labels

How an issue moves through the factory: [Software Factory (wiki)](https://github.com/b-bhu/myboon/wiki/Software-Factory). Issue format: [agent-ready template](ISSUE_TEMPLATE/agent-ready.md) ([wiki](https://github.com/b-bhu/myboon/wiki/Agent-ready-Issue-Template)).

## Factory line

`new` → `grooming` → `agent-ready` → `building` → `pr-ready-to-review` → `pr-ready-to-merge`, plus the `blocked` exit.

| Label | Color | Description |
| --- | --- | --- |
| `new` | `#ededed` | Raw idea or bug; nobody works on it |
| `grooming` | `#0052CC` | Bibhu and the CTO shape it to the agent-ready template |
| `agent-ready` | `#1F883D` | Complete input; any developer agent picks the top issue |
| `building` | `#1D76DB` | Factory (myboon-builder) has claimed this agent-ready issue |
| `pr-ready-to-review` | `#FBCA04` | Factory PR open; waiting for the peer reviewer (or a fix after SEND BACK) |
| `pr-ready-to-merge` | `#0E8A16` | Peer reviewer SIGN-OFF (score 10) on current head + CI green; CTO may merge |
| `blocked` | `#B60205` | Factory stopped; CTO fixes in place (remove blocked), splits, or closes. Never back to grooming |

## Other labels

| Label | Color | Description |
| --- | --- | --- |
| `needs-bucket` | `#B60205` | Bucket review required for money, wallet or DB/migration work |
| `do-not-merge` | `#B60205` | Draft/spike PR, never merge |
| `spec` | `#1D76DB` | Spec PR awaiting Bucket review |
| `spec-approved` | `#0E8A16` | Spec approved by Bucket |

There is no device-test or QA label. `in-progress`, `ready:*` and the colon `agent:*` labels are retired; do not route work with them.
