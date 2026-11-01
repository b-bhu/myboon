# @myboon/contracts

Versioned zod v4 schemas + inferred TypeScript types for the V4 Signal and Decision form (#440). Field names are frozen and match the DB tables `atlas.signals` / `atlas.decisions`.

Exports from `src/index.ts`:

- `SIGNAL_SCHEMA_VERSION` / `DECISION_SCHEMA_VERSION` and the `schema_version: z.literal(1)` schemas `signalSchema` / `decisionSchema`
- `parseSignal` / `parseDecision` (throwing) and `safeParseSignal` / `safeParseDecision`
- id helpers `signalId(source, sourceId)` (sha256 of `source\0source_id`) and `rawHash(bytes)`
- types `Signal`, `SignalType`, `Decision`, `DecisionType`

Runtime dependency: `zod` only; hashing uses `node:crypto`. TypeScript source is exported directly (no build step), like `@myboon/shared`.

```ts
import { parseSignal, signalId } from '@myboon/contracts';

const signal = parseSignal({ schema_version: 1, signal_id: signalId('news', url), /* ... */ });
```

Commands: `pnpm --filter @myboon/contracts test`, `pnpm --filter @myboon/contracts typecheck`.