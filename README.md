# opencode-local-brain

Local layered memory for opencode agents. No cloud, no accounts: a SQLite file on your machine.

## Memory levels (human-like)

| Level | Table | What |
|---|---|---|
| L0 sensory | — | current session context (opencode native, not stored) |
| L1 episodic | `episodes` | auto-written log of every session: summary, decisions, outcome |
| L2 semantic | `facts` | distilled facts (user, projects, prefs) with confidence 0..1 + reinforcement counter |
| L3 deep | `rules` | mistake journal: mistake → cause → rule. Only `confirmed = 1` rules are injected |

## Storage

SQLite (WAL) + FTS5 full-text search. `facts.embedding BLOB` is reserved for Phase 4 (sqlite-vec + local embeddings).

## API

```ts
import { Brain } from "./dist/src/index.js";

const brain = Brain.open("/path/to/brain.db");
brain.logEpisode({ sessionId: "abc", summary: "wired telegram MCP", outcome: "ok" });
brain.rememberFact({ category: "project", content: "repo is opencode-local-brain" });
brain.recall("telegram");            // FTS across L1+L2+L3
brain.addRule({ title: "T", mistake: "M", rule: "R" }); // unconfirmed
brain.confirmRule(1);
brain.snapshot(3750);                // budgeted injection text (~3.5-4k tokens)
brain.forget("fact", 3);
brain.close();
```

## Scripts

- `npm run build` / `npm test` / `npm run typecheck`
- `node dist/scripts/migrate-memory.js [memory.md] [brain.db]` — one-shot import of legacy `memory.md`
- `BRAIN_DB` env is used by the MCP server (Phase 2)

## Security

Memory databases (`*.db`) are git-ignored. Never commit session logs or secrets.
